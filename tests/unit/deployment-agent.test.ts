import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { DEFAULT_ENVIRONMENT_POLICIES, DeploymentAgent } from "@orchestra/agents";
import { InMemoryGitHubAdapter } from "@orchestra/integrations";
import type { AgentContext } from "@orchestra/agents";

const logger = createLogger({ service: "test", level: "silent" });
const REPO = { owner: "acme", name: "app" };

function makeContext(extra: Record<string, unknown> = {}): AgentContext {
  return {
    runId: "run-deploy",
    stageId: "deployment",
    agentId: "deployment-agent",
    input: { ...extra },
    workflowContext: {},
    tools: [],
    logger
  };
}

describe("deployment agent", () => {
  it("dispatches the deploy workflow, polls it, and records the deployment", async () => {
    const github = new InMemoryGitHubAdapter();
    const agent = new DeploymentAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(
      makeContext({
        repo: REPO,
        branch: "feature",
        base_branch: "main",
        environment: "production",
        workflow_file: "deploy.yml"
      })
    );

    expect(result.status).toBe("success");
    expect(github.dispatchedWorkflows).toHaveLength(1);
    expect(github.dispatchedWorkflows[0]?.ref).toBe("feature");
    expect(github.dispatchedWorkflows[0]?.workflowFile).toBe("deploy.yml");
    expect(github.deployments).toHaveLength(1);
    expect(github.deployments[0]?.deployment.ref).toBe("feature");
    expect(github.deploymentStatuses.map((s) => s.state)).toEqual(["success"]);
    const meta = result.metadata as {
      environment: string;
      ref: string;
      rollback: boolean;
      deploymentId: number;
      deploymentStatus: string;
      approvalRequired: boolean;
    };
    expect(meta.environment).toBe("production");
    expect(meta.ref).toBe("feature");
    expect(meta.rollback).toBe(false);
    expect(meta.deploymentId).toBe(1);
    expect(meta.deploymentStatus).toBe("success");
    expect(meta.approvalRequired).toBe(false);
  });

  it("records approval_required from the environment policy", async () => {
    const github = new InMemoryGitHubAdapter();
    const agent = new DeploymentAgent({
      github,
      envPolicies: DEFAULT_ENVIRONMENT_POLICIES,
      pollIntervalMs: 1
    });
    const result = await agent.execute(makeContext({ repo: REPO, environment: "production" }));

    expect(result.status).toBe("success");
    expect((result.metadata as { approvalRequired: boolean }).approvalRequired).toBe(true);

    const staging = new DeploymentAgent({
      github,
      envPolicies: DEFAULT_ENVIRONMENT_POLICIES,
      pollIntervalMs: 1
    });
    const stagingResult = await staging.execute(makeContext({ repo: REPO, environment: "staging" }));
    expect((stagingResult.metadata as { approvalRequired: boolean }).approvalRequired).toBe(false);
  });

  it("rolls back to the previous known-good ref on rework", async () => {
    const github = new InMemoryGitHubAdapter();
    const agent = new DeploymentAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(
      makeContext({
        repo: REPO,
        branch: "feature",
        base_branch: "main",
        dependencies: { merge: { metadata: { previousRef: "abc123" } } },
        rework_findings: [
          { id: "v1", severity: "high", source: "verification-agent", title: "Smoke failed", description: "d" }
        ]
      })
    );

    expect(result.status).toBe("success");
    expect(github.dispatchedWorkflows).toHaveLength(1);
    expect(github.dispatchedWorkflows[0]?.ref).toBe("abc123");
    expect(github.deployments[0]?.deployment.ref).toBe("abc123");
    const meta = result.metadata as { rollback: boolean; ref: string };
    expect(meta.rollback).toBe(true);
    expect(meta.ref).toBe("abc123");
  });

  it("fails with a finding when the deploy run fails", async () => {
    const github = new InMemoryGitHubAdapter();
    github.workflowConclusions.push("failure");
    const agent = new DeploymentAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(makeContext({ repo: REPO, branch: "feature" }));

    expect(result.status).toBe("failed");
    expect(result.findings?.[0]?.domain).toBe("deployment");
    expect(result.findings?.[0]?.severity).toBe("high");
    expect(github.deploymentStatuses.map((s) => s.state)).toEqual(["failure"]);
  });

  it("skips with success when unconfigured", async () => {
    const agent = new DeploymentAgent({});
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    const meta = result.metadata as { skipped: boolean; reason: string };
    expect(meta.skipped).toBe(true);
    expect(meta.reason).toBe("not_configured");
  });
});
