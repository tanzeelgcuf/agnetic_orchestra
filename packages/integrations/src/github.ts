import { createHmac, timingSafeEqual } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import type { ToolRegistry } from "@orchestra/agents";

/**
 * GitHub adapter. The orchestration engine and agents depend on this
 * interface, never on a concrete GitHub client. OctokitGitHubAdapter is the
 * real implementation (token-based); InMemoryGitHubAdapter backs tests.
 */
export interface GitHubRepositoryRef {
  owner: string;
  name: string;
}

export interface GitHubPullRequestRef extends GitHubRepositoryRef {
  number: number;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  headBranch: string;
  baseBranch: string;
  url: string;
  body?: string;
}

export interface GitHubCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "skipped";
}

export interface GitHubAdapter {
  listRepositories(): Promise<GitHubRepositoryRef[]>;
  createBranch(repo: GitHubRepositoryRef, branch: string, fromRef: string): Promise<void>;
  createPullRequest(input: {
    repo: GitHubRepositoryRef;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<GitHubPullRequest>;
  getPullRequest(pr: GitHubPullRequestRef): Promise<GitHubPullRequest | null>;
  listChecks(pr: GitHubPullRequestRef): Promise<GitHubCheckRun[]>;
  commentOnPullRequest(pr: GitHubPullRequestRef, body: string): Promise<void>;
  mergePullRequest(pr: GitHubPullRequestRef): Promise<void>;
}

/** Real Octokit-backed adapter. Create only when a GITHUB_TOKEN is present. */
export class OctokitGitHubAdapter implements GitHubAdapter {
  constructor(private readonly octokit: Octokit) {}

  async listRepositories(): Promise<GitHubRepositoryRef[]> {
    const res = await this.octokit.rest.repos.listForAuthenticatedUser({ per_page: 100 });
    return res.data.map((repo) => ({ owner: repo.owner.login, name: repo.name }));
  }

  async createBranch(repo: GitHubRepositoryRef, branch: string, fromRef: string): Promise<void> {
    const base = await this.octokit.rest.repos.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch: fromRef
    });
    await this.octokit.rest.git.createRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `refs/heads/${branch}`,
      sha: base.data.commit.sha
    });
  }

  async createPullRequest(input: {
    repo: GitHubRepositoryRef;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<GitHubPullRequest> {
    const res = await this.octokit.rest.pulls.create({
      owner: input.repo.owner,
      repo: input.repo.name,
      title: input.title,
      head: input.head,
      base: input.base,
      ...(input.body !== undefined ? { body: input.body } : {})
    });
    return {
      number: res.data.number,
      title: res.data.title,
      state: res.data.state === "closed" ? "closed" : "open",
      headBranch: res.data.head.ref,
      baseBranch: res.data.base.ref,
      url: res.data.html_url,
      body: res.data.body ?? undefined
    };
  }

  async getPullRequest(pr: GitHubPullRequestRef): Promise<GitHubPullRequest | null> {
    try {
      const res = await this.octokit.rest.pulls.get({
        owner: pr.owner,
        repo: pr.name,
        pull_number: pr.number
      });
      return {
        number: res.data.number,
        title: res.data.title,
        state: res.data.merged ? "merged" : res.data.state === "closed" ? "closed" : "open",
        headBranch: res.data.head.ref,
        baseBranch: res.data.base.ref,
        url: res.data.html_url,
        body: res.data.body ?? undefined
      };
    } catch (e) {
      if (typeof e === "object" && e !== null && "status" in e && (e as { status: number }).status === 404) {
        return null;
      }
      throw e;
    }
  }

  async listChecks(pr: GitHubPullRequestRef): Promise<GitHubCheckRun[]> {
    const head = await this.octokit.rest.pulls.get({
      owner: pr.owner,
      repo: pr.name,
      pull_number: pr.number
    });
    const res = await this.octokit.rest.checks.listForRef({
      owner: pr.owner,
      repo: pr.name,
      ref: head.data.head.sha
    });
    return res.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status as unknown as GitHubCheckRun["status"],
      conclusion: (run.conclusion ?? undefined) as unknown as GitHubCheckRun["conclusion"]
    }));
  }

  async commentOnPullRequest(pr: GitHubPullRequestRef, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: pr.owner,
      repo: pr.name,
      issue_number: pr.number,
      body
    });
  }

  async mergePullRequest(pr: GitHubPullRequestRef): Promise<void> {
    await this.octokit.rest.pulls.merge({
      owner: pr.owner,
      repo: pr.name,
      pull_number: pr.number
    });
  }
}

/** In-memory double for tests and local development. */
export class InMemoryGitHubAdapter implements GitHubAdapter {
  readonly pullRequests: GitHubPullRequest[] = [];
  readonly comments: { pr: GitHubPullRequestRef; body: string }[] = [];
  readonly mergedBranches: { repo: GitHubRepositoryRef; branch: string }[] = [];
  private nextPrNumber = 1;

  async listRepositories(): Promise<GitHubRepositoryRef[]> {
    return [];
  }

  async createBranch(
    _repo: GitHubRepositoryRef,
    _branch: string,
    _fromRef: string
  ): Promise<void> {}

  async createPullRequest(input: {
    repo: GitHubRepositoryRef;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<GitHubPullRequest> {
    const number = this.nextPrNumber++;
    const pr: GitHubPullRequest = {
      number,
      title: input.title,
      state: "open",
      headBranch: input.head,
      baseBranch: input.base,
      url: `https://github.invalid/${input.repo.owner}/${input.repo.name}/pull/${number}`,
      body: input.body
    };
    this.pullRequests.push(pr);
    return pr;
  }

  async getPullRequest(pr: GitHubPullRequestRef): Promise<GitHubPullRequest | null> {
    return this.pullRequests.find((p) => p.number === pr.number) ?? null;
  }

  async listChecks(_pr: GitHubPullRequestRef): Promise<GitHubCheckRun[]> {
    return [];
  }

  async commentOnPullRequest(pr: GitHubPullRequestRef, body: string): Promise<void> {
    this.comments.push({ pr, body });
  }

  async mergePullRequest(pr: GitHubPullRequestRef): Promise<void> {
    const existing = this.pullRequests.find((p) => p.number === pr.number);
    if (existing) {
      existing.state = "merged";
      this.mergedBranches.push({ repo: { owner: pr.owner, name: pr.name }, branch: existing.headBranch });
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound webhooks (Phase 3)
// ---------------------------------------------------------------------------

export interface GitHubWebhookEvent {
  kind: "pull_request" | "push" | "workflow_run" | "deployment_status" | "unknown";
  action?: string;
  repository?: GitHubRepositoryRef;
  pullRequest?: {
    number: number;
    title: string;
    state?: string;
    headBranch?: string;
    baseBranch?: string;
    url?: string;
  };
  branch?: string;
  headSha?: string;
  conclusion?: string;
  /** Extracted traceability key (e.g. PROJ-123) from branch name or PR title. */
  issueKey?: string;
}

export interface GitHubWebhookContext {
  event: GitHubWebhookEvent;
  deliveryId: string;
  raw: Record<string, unknown>;
}

export interface GitHubWebhookHandler {
  name: string;
  handle(ctx: GitHubWebhookContext): Promise<void>;
}

/**
 * Map a GitHub webhook (X-GitHub-Event header + payload) to a structured
 * event. Untrusted content: payload fields are data only — never instructions.
 */
export function parseGitHubWebhook(event: string, payload: Record<string, unknown>): GitHubWebhookEvent {
  const repository = asRepo(payload.repository);
  const pr = payload.pull_request as Record<string, unknown> | undefined;

  if (event === "pull_request") {
    const title = asString(pr?.title) ?? "";
    const headBranch = asString(pr?.head && (pr.head as Record<string, unknown>).ref);
    return {
      kind: "pull_request",
      action: asString(payload.action),
      repository,
      pullRequest: {
        number: asNumber(pr?.number) ?? 0,
        title,
        state: asString(pr?.state),
        headBranch,
        baseBranch: asString(pr?.base && (pr.base as Record<string, unknown>).ref),
        url: asString(pr?.html_url)
      },
      branch: headBranch,
      headSha: asString(pr?.head && (pr.head as Record<string, unknown>).sha),
      issueKey: extractIssueKey(title, headBranch)
    };
  }

  if (event === "push") {
    const ref = asString(payload.ref) ?? "";
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    return {
      kind: "push",
      repository,
      branch,
      headSha: asString(payload.after) ?? undefined,
      issueKey: extractIssueKey(branch)
    };
  }

  if (event === "workflow_run" || event === "deployment_status") {
    const run = payload.workflow_run as Record<string, unknown> | undefined;
    const deployment = payload.deployment as Record<string, unknown> | undefined;
    return {
      kind: event,
      action:
        asString(payload.action) ?? asString(deployment?.state) ?? asString(payload.state),
      repository,
      headSha: asString(run?.head_sha) ?? asString(payload.sha) ?? undefined,
      conclusion: asString(run?.conclusion) ?? asString(payload.conclusion),
      issueKey: extractIssueKey(asString(run?.head_branch))
    };
  }

  return { kind: "unknown", repository, issueKey: extractIssueKey(asString(payload.ref)) };
}

/**
 * Verify a GitHub webhook signature (X-Hub-Signature-256: sha256=<hex>) with
 * HMAC-SHA256 in constant time. Trust nothing that fails verification.
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Traceability (master prompt §27): extract an issue key like PROJ-123 from
 * branch names, commit messages, or PR titles. Returns the first match.
 */
export function extractIssueKey(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    if (match) return match[1];
  }
  return undefined;
}

function asRepo(value: unknown): GitHubRepositoryRef | undefined {
  if (!value || typeof value !== "object") return undefined;
  const repo = value as { owner?: unknown; name?: unknown };
  const owner = repo.owner as { login?: unknown } | undefined;
  const ownerName = typeof owner?.login === "string" ? owner.login : undefined;
  if (!ownerName || typeof repo.name !== "string") return undefined;
  return { owner: ownerName, name: repo.name };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Register a GitHub adapter's PR-surface operations as tools. Deliberately
 * EXCLUDES merge_pull_request: the Development Agent must never merge its own
 * PR — merge is a workflow stage behind human approval.
 */
export function registerGitHubTools(registry: ToolRegistry, github: GitHubAdapter): void {
  registry.register({
    name: "github.create_pull_request",
    description: "Create a pull request",
    execute: async (input) => {
      const { repo, title, head, base, body } = input as {
        repo?: unknown;
        title?: unknown;
        head?: unknown;
        base?: unknown;
        body?: unknown;
      };
      if (
        !isRepoRef(repo) ||
        typeof title !== "string" ||
        typeof head !== "string" ||
        typeof base !== "string"
      ) {
        throw new Error("github.create_pull_request requires repo {owner,name}, title, head, base");
      }
      return github.createPullRequest({
        repo,
        title,
        head,
        base,
        ...(typeof body === "string" ? { body } : {})
      });
    }
  });
  registry.register({
    name: "github.get_pull_request",
    description: "Fetch a pull request by number",
    execute: async (input) => {
      const pr = toPrRef(input);
      if (!pr) throw new Error("github.get_pull_request requires repo {owner,name} and number");
      return github.getPullRequest(pr);
    }
  });
  registry.register({
    name: "github.list_checks",
    description: "List check runs for a pull request's head",
    execute: async (input) => {
      const pr = toPrRef(input);
      if (!pr) throw new Error("github.list_checks requires repo {owner,name} and number");
      return github.listChecks(pr);
    }
  });
  registry.register({
    name: "github.comment_on_pull_request",
    description: "Add a comment to a pull request",
    execute: async (input) => {
      const pr = toPrRef(input);
      const body = (input as { body?: unknown }).body;
      if (!pr || typeof body !== "string") {
        throw new Error("github.comment_on_pull_request requires repo {owner,name}, number, body");
      }
      await github.commentOnPullRequest(pr, body);
      return { ok: true };
    }
  });
}

function isRepoRef(value: unknown): value is GitHubRepositoryRef {
  if (!value || typeof value !== "object") return false;
  const repo = value as { owner?: unknown; name?: unknown };
  return typeof repo.owner === "string" && typeof repo.name === "string";
}

function toPrRef(input: unknown): GitHubPullRequestRef | undefined {
  if (!input || typeof input !== "object") return undefined;
  const { repo, number } = input as { repo?: unknown; number?: unknown };
  if (!isRepoRef(repo) || typeof number !== "number") return undefined;
  return { ...repo, number };
}
