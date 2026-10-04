import type { AgentResult, Finding, PermissionSet } from "@orchestra/shared";
import type { Agent, AgentContext, ValidationResult } from "./contract";
import type { EnvironmentPolicy } from "./policy";
import { pollUntil } from "./poll";

/**
 * Structural subset of the GitHub adapter the delivery agents need — the
 * Octokit and InMemory adapters in @orchestra/integrations satisfy it.
 * Declared locally because @orchestra/integrations already depends on
 * @orchestra/agents; a direct import would create a workspace cycle.
 */
export interface DeployRepoRef {
  owner: string;
  name: string;
}

export interface DeployPullRequest {
  number: number;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  url: string;
}

export interface DeployWorkflowRun {
  id: number;
  name?: string;
  headBranch?: string;
  headSha?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: string;
  url?: string;
}

export interface DeployDeployment {
  id: number;
  ref: string;
  environment: string;
}

export interface DeployDeploymentStatus {
  state: string;
  description?: string;
}

export interface DeployGitHubSurface {
  getPullRequest(pr: DeployRepoRef & { number: number }): Promise<DeployPullRequest | null>;
  getPullRequestByBranch(repo: DeployRepoRef, headBranch: string): Promise<DeployPullRequest | null>;
  listChecks(
    pr: DeployRepoRef & { number: number }
  ): Promise<{ name: string; status: "queued" | "in_progress" | "completed"; conclusion?: string }[]>;
  getBranchHead(repo: DeployRepoRef, branch: string): Promise<string | null>;
  dispatchWorkflow(input: {
    repo: DeployRepoRef;
    workflowFile: string;
    ref: string;
    inputs?: Record<string, string | number>;
  }): Promise<void>;
  listWorkflowRuns(
    repo: DeployRepoRef,
    filter?: { workflowFile?: string; headBranch?: string; headSha?: string }
  ): Promise<DeployWorkflowRun[]>;
  createDeployment(input: {
    repo: DeployRepoRef;
    ref: string;
    environment: string;
    description?: string;
  }): Promise<DeployDeployment>;
  createDeploymentStatus(input: {
    repo: DeployRepoRef;
    deploymentId: number;
    state: "success" | "failure" | "error" | "in_progress";
    description?: string;
  }): Promise<void>;
  getLatestDeploymentStatus(
    repo: DeployRepoRef,
    deploymentId: number
  ): Promise<DeployDeploymentStatus | null>;
  mergePullRequest(pr: DeployRepoRef & { number: number }): Promise<void>;
}

/**
 * Merge Agent (master prompt §24): finds the run's pull request, waits for
 * green CI checks, and merges — always as a workflow stage behind human
 * approval, never inside the Development Agent. Deterministic; an LLM never
 * runs here. No rework edge: a red CI is not fixable by re-merging, and
 * rework-to-development would fork a fresh branch/PR — the run fails after
 * max_attempts for human investigation.
 */
export class MergeAgent implements Agent {
  readonly id = "merge-agent";
  readonly name = "Merge";
  readonly version = "1.0.0";
  readonly description =
    "Finds the run's pull request, waits for green checks, and merges behind human approval.";

  constructor(
    private readonly deps: {
      github?: DeployGitHubSurface;
      pollIntervalMs?: number;
      checksTimeoutMs?: number;
    } = {}
  ) {}

  capabilities(): readonly string[] {
    return ["git.merge"];
  }

  permissions(): PermissionSet {
    return {};
  }

  validate(_input: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const github = this.deps.github;
    const repo = resolveRepo(ctx);
    const branch = firstString(ctx.input.branch, ctx.workflowContext.branch) ?? "main";

    if (!github || !repo) {
      return {
        status: "success",
        summary: "Merge skipped — no repository or GitHub access",
        metadata: { merged: false, reason: "not_configured", branch }
      };
    }

    const pr = await this.findPullRequest(ctx, github, repo, branch);
    if (!pr) {
      return {
        status: "success",
        summary: `Merge skipped — no open PR for branch ${branch}`,
        metadata: { merged: false, reason: "no_pull_request", branch }
      };
    }
    if (pr.state !== "open") {
      return {
        status: "success",
        summary: `Merge skipped — PR #${pr.number} is already ${pr.state}`,
        metadata: { merged: false, reason: `pr_${pr.state}`, prNumber: pr.number, prUrl: pr.url }
      };
    }

    const checks = await github.listChecks({ ...repo, number: pr.number });
    if (checks.length > 0) {
      let settled: { name: string; status: string; conclusion?: string }[];
      try {
        settled = await pollUntil(
          async () => {
            const current = await github.listChecks({ ...repo, number: pr.number });
            return current.every((c) => c.status === "completed") ? current : null;
          },
          {
            label: `checks for PR #${pr.number}`,
            intervalMs: this.deps.pollIntervalMs,
            timeoutMs: this.deps.checksTimeoutMs
          }
        );
      } catch (e) {
        ctx.logger.warn({ err: e, prNumber: pr.number }, "check polling timed out");
        return this.failedResult(
          `Checks for PR #${pr.number} did not complete in time`,
          "Check runs did not complete before the merge timeout",
          "Investigate the CI run, then re-run the workflow.",
          { merged: false, prNumber: pr.number, prUrl: pr.url }
        );
      }

      const bad = settled.find((c) => c.conclusion === "failure" || c.conclusion === "cancelled");
      if (bad) {
        return this.failedResult(
          `Check "${bad.name}" reported ${bad.conclusion} for PR #${pr.number}`,
          `CI check "${bad.name}" reported ${bad.conclusion}; the PR cannot merge until it passes.`,
          "Fix the failing check, then re-run the workflow.",
          { merged: false, prNumber: pr.number, prUrl: pr.url, check: bad.name }
        );
      }
    }

    const previousRef = (await github.getBranchHead(repo, pr.baseBranch)) ?? pr.baseBranch;
    await github.mergePullRequest({ ...repo, number: pr.number });
    return {
      status: "success",
      summary: `Merged PR #${pr.number} into ${pr.baseBranch}`,
      metadata: {
        merged: true,
        branch,
        prNumber: pr.number,
        prUrl: pr.url,
        mergedRef: pr.baseBranch,
        previousRef
      }
    };
  }

  private failedResult(
    summary: string,
    title: string,
    recommendation: string,
    metadata: Record<string, unknown>
  ): AgentResult {
    return {
      status: "failed",
      summary,
      findings: [
        {
          id: "merge-check-failure",
          source: this.id,
          domain: "code",
          severity: "high",
          title,
          description: summary,
          recommendation
        }
      ],
      metadata
    };
  }

  private async findPullRequest(
    ctx: AgentContext,
    github: DeployGitHubSurface,
    repo: DeployRepoRef,
    branch: string
  ): Promise<DeployPullRequest | null> {
    const dependencies = (ctx.input.dependencies ?? {}) as Record<string, unknown>;
    const devOutput = dependencies["development"] as
      | { metadata?: { prUrl?: unknown } }
      | undefined;
    const prUrl = typeof devOutput?.metadata?.prUrl === "string" ? devOutput.metadata.prUrl : undefined;
    if (prUrl) {
      const match = prUrl.match(/\/pull\/(\d+)$/);
      if (match) {
        return github.getPullRequest({ ...repo, number: Number(match[1]) });
      }
    }
    return github.getPullRequestByBranch(repo, branch);
  }
}

/**
 * Deployment Agent (master prompt §24): dispatches the project's deploy
 * workflow over GitHub Actions, polls it to completion, and records GitHub
 * Deployment + status. Deterministic; an LLM never runs here.
 *
 * Rollback (§49): when the rework loop re-runs this stage (verification
 * failed its smoke test), the previous known-good ref — captured by the
 * MergeAgent before merging — is deployed instead of the feature branch.
 */
export class DeploymentAgent implements Agent {
  readonly id = "deployment-agent";
  readonly name = "Deployment";
  readonly version = "1.0.0";
  readonly description =
    "Dispatches the deploy workflow over GitHub Actions, polls to completion, and records the deployment.";

  constructor(
    private readonly deps: {
      github?: DeployGitHubSurface;
      envPolicies?: Record<string, EnvironmentPolicy>;
      pollIntervalMs?: number;
      pollTimeoutMs?: number;
    } = {}
  ) {}

  capabilities(): readonly string[] {
    return ["deploy.actions"];
  }

  permissions(): PermissionSet {
    return {};
  }

  validate(_input: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const github = this.deps.github;
    const repo = resolveRepo(ctx);
    const environment = firstString(ctx.input.environment, ctx.workflowContext.environment) ?? "production";
    const workflowFile = firstString(ctx.input.workflow_file, ctx.workflowContext.workflow_file) ?? "deploy.yml";
    const baseBranch = firstString(ctx.input.base_branch, ctx.workflowContext.base_branch) ?? "main";
    const branch = firstString(ctx.input.branch, ctx.workflowContext.branch) ?? baseBranch;

    if (!github || !repo) {
      return {
        status: "success",
        summary: "Deployment skipped — no repository or GitHub access",
        metadata: { skipped: true, reason: "not_configured", environment }
      };
    }

    const envPolicy = this.deps.envPolicies?.[environment];
    const approvalRequired = envPolicy?.requiresApproval ?? false;

    const rollback = extractReworkFindings(ctx).length > 0;
    const ref = rollback
      ? firstString(ctx.input.rollback_ref, ctx.workflowContext.rollback_ref)
        ?? previousRefFromMerge(ctx)
        ?? baseBranch
      : branch;

    try {
      await github.dispatchWorkflow({
        repo,
        workflowFile,
        ref,
        inputs: { environment, run_id: ctx.runId }
      });
    } catch (e) {
      ctx.logger.warn({ err: e, environment, ref, workflowFile }, "workflow dispatch failed");
      return {
        status: "failed",
        summary: `Failed to dispatch ${workflowFile} on ${ref}`,
        findings: [
          {
            id: "deployment-dispatch-failure",
            source: this.id,
            domain: "deployment",
            severity: "high",
            title: `Deploy workflow dispatch failed (${workflowFile} on ${ref})`,
            description: String(e),
            recommendation: "Check the workflow file exists on the target ref and that Actions is enabled."
          }
        ],
        metadata: { environment, ref, rollback, workflowFile }
      };
    }

    let completed: DeployWorkflowRun;
    try {
      completed = await pollUntil(
        async () => {
          const runs = await github.listWorkflowRuns(repo, { workflowFile });
          return (
            runs.find(
              (r) => r.status === "completed" && (r.headBranch === ref || r.headSha === ref)
            ) ?? null
          );
        },
        {
          label: `${workflowFile} run on ${ref}`,
          intervalMs: this.deps.pollIntervalMs,
          timeoutMs: this.deps.pollTimeoutMs
        }
      );
    } catch (e) {
      ctx.logger.warn({ err: e, environment, ref, workflowFile }, "deployment polling timed out");
      return {
        status: "failed",
        summary: `${workflowFile} run on ${ref} did not complete in time`,
        findings: [
          {
            id: "deployment-poll-timeout",
            source: this.id,
            domain: "deployment",
            severity: "high",
            title: `Deploy run did not complete before the deployment timeout`,
            description: String(e),
            recommendation: "Check the Actions run for stuck jobs, then re-run the workflow."
          }
        ],
        metadata: { environment, ref, rollback, workflowFile }
      };
    }

    if (
      completed.conclusion === "failure" ||
      completed.conclusion === "cancelled" ||
      completed.conclusion === "timed_out"
    ) {
      const deployment = await github
        .createDeployment({ repo, ref, environment, description: "orchestrated deploy (failed)" })
        .catch(() => null);
      if (deployment) {
        await github.createDeploymentStatus({
          repo,
          deploymentId: deployment.id,
          state: "failure",
          description: `workflow ${workflowFile} ${completed.conclusion}`
        });
      }
      return {
        status: "failed",
        summary: `Deployment workflow ${workflowFile} on ${ref} ${completed.conclusion}`,
        findings: [
          {
            id: "deployment-run-failure",
            source: this.id,
            domain: "deployment",
            severity: "high",
            title: `Deploy workflow ${workflowFile} ${completed.conclusion} on ${ref}`,
            description: `The GitHub Actions run ${completed.id} concluded ${completed.conclusion}.`,
            recommendation: "Inspect the Actions run logs, fix, and re-run the workflow."
          }
        ],
        metadata: {
          environment,
          ref,
          rollback,
          workflowRunId: completed.id,
          conclusion: completed.conclusion,
          deploymentId: deployment?.id
        }
      };
    }

    const deployment = await github.createDeployment({ repo, ref, environment });
    await github.createDeploymentStatus({
      repo,
      deploymentId: deployment.id,
      state: "success",
      description: `workflow ${workflowFile} ${completed.conclusion}`
    });
    return {
      status: "success",
      summary: `Deployed ${ref} to ${environment}${rollback ? " — ROLLBACK" : ""}`,
      metadata: {
        environment,
        ref,
        rollback,
        workflowRunId: completed.id,
        conclusion: completed.conclusion,
        deploymentId: deployment.id,
        deploymentStatus: "success",
        approvalRequired
      }
    };
  }
}

/**
 * Post-deploy verification (master prompt §24): smoke tests. When a
 * smoke_url is configured, it must return 2xx; otherwise the recorded GitHub
 * deployment status must be success. A failure here fails the stage, which
 * triggers the rework edge back to deployment — the rollback deploy.
 */
export class VerificationAgent implements Agent {
  readonly id = "verification-agent";
  readonly name = "Verification";
  readonly version = "1.0.0";
  readonly description = "Runs post-deploy smoke tests and checks the recorded deployment status.";

  constructor(
    private readonly deps: {
      github?: DeployGitHubSurface;
      fetchImpl?: typeof fetch;
      smokeTimeoutMs?: number;
    } = {}
  ) {}

  capabilities(): readonly string[] {
    return ["deploy.verify"];
  }

  permissions(): PermissionSet {
    return {};
  }

  validate(_input: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const dependencies = (ctx.input.dependencies ?? {}) as Record<string, unknown>;
    const deployMeta = (dependencies["deployment"] as
      | { metadata?: Record<string, unknown> }
      | undefined)?.metadata;

    if (!deployMeta || deployMeta.skipped === true) {
      return {
        status: "success",
        summary: "Verification skipped — no deployment to verify",
        metadata: { skipped: true, reason: "no_deployment" }
      };
    }

    const deploymentId =
      typeof deployMeta.deploymentId === "number" ? deployMeta.deploymentId : undefined;
    const smokeUrl = firstString(ctx.input.smoke_url, ctx.workflowContext.smoke_url);

    if (smokeUrl) {
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      try {
        const res = await fetchImpl(smokeUrl, {
          signal: AbortSignal.timeout(this.deps.smokeTimeoutMs ?? 10_000)
        });
        if (!res.ok) {
          return this.failedResult(
            `Smoke test ${smokeUrl} returned ${res.status}`,
            `Smoke test failed (HTTP ${res.status})`,
            "Investigate the deployed service, then re-run the workflow.",
            { smokeUrl, status: res.status, deploymentId }
          );
        }
      } catch (e) {
        return this.failedResult(
          `Smoke test ${smokeUrl} failed: ${String(e)}`,
          "Smoke test request failed or timed out",
          "Investigate the deployed service, then re-run the workflow.",
          { smokeUrl, deploymentId }
        );
      }
    } else {
      const github = this.deps.github;
      const repo = resolveRepo(ctx);
      if (github && repo && deploymentId !== undefined) {
        const status = await github.getLatestDeploymentStatus(repo, deploymentId);
        if (!status || status.state !== "success") {
          return this.failedResult(
            `Deployment status is ${status?.state ?? "unknown"}`,
            "Deployment did not report success",
            "Check the deployment status history, then re-run the workflow.",
            { deploymentId, state: status?.state }
          );
        }
      }
    }

    return {
      status: "success",
      summary: "Post-deploy verification passed",
      metadata: { verified: true, smokeUrl, deploymentId }
    };
  }

  private failedResult(
    summary: string,
    title: string,
    recommendation: string,
    metadata: Record<string, unknown>
  ): AgentResult {
    return {
      status: "failed",
      summary,
      findings: [
        {
          id: "verification-failure",
          source: this.id,
          domain: "deployment",
          severity: "high",
          title,
          description: summary,
          recommendation
        }
      ],
      metadata
    };
  }
}

function resolveRepo(ctx: AgentContext): DeployRepoRef | undefined {
  const raw = ctx.input.repo ?? ctx.workflowContext.repo;
  if (isRepoRefShape(raw)) return raw;
  const gh = ctx.workflowContext.github as { repository?: unknown } | undefined;
  if (isRepoRefShape(gh?.repository)) return gh.repository;
  return undefined;
}

function isRepoRefShape(value: unknown): value is DeployRepoRef {
  if (!value || typeof value !== "object") return false;
  const repo = value as { owner?: unknown; name?: unknown };
  return typeof repo.owner === "string" && typeof repo.name === "string";
}

function previousRefFromMerge(ctx: AgentContext): string | undefined {
  const dependencies = (ctx.input.dependencies ?? {}) as Record<string, unknown>;
  const mergeOutput = dependencies["merge"] as
    | { metadata?: { previousRef?: unknown } }
    | undefined;
  return typeof mergeOutput?.metadata?.previousRef === "string"
    ? mergeOutput.metadata.previousRef
    : undefined;
}

function extractReworkFindings(ctx: AgentContext): Finding[] {
  const raw = ctx.input.rework_findings ?? ctx.workflowContext.rework_findings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is Finding => {
    if (!f || typeof f !== "object") return false;
    const finding = f as { severity?: unknown; title?: unknown; description?: unknown; source?: unknown };
    return (
      typeof finding.severity === "string" &&
      typeof finding.title === "string" &&
      typeof finding.description === "string" &&
      typeof finding.source === "string"
    );
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
