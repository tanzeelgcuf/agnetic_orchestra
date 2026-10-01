/**
 * GitHub adapter interface (Phase 3 implementation). The orchestration engine
 * and agents depend on this interface, never on a concrete GitHub client.
 * InMemoryGitHubAdapter backs tests and local development.
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
  createBranch(
    repo: GitHubRepositoryRef,
    branch: string,
    fromRef: string
  ): Promise<void>;
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

/** Phase 3 ships a real Octokit-backed adapter; this one backs tests. */
export class InMemoryGitHubAdapter implements GitHubAdapter {
  readonly pullRequests: GitHubPullRequest[] = [];
  readonly comments: { pr: GitHubPullRequestRef; body: string }[] = [];
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
    const pr: GitHubPullRequest = {
      number: this.nextPrNumber++,
      title: input.title,
      state: "open",
      headBranch: input.head,
      baseBranch: input.base,
      url: `https://github.invalid/${input.repo.owner}/${input.repo.name}/pull/${this.nextPrNumber - 1}`,
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
    if (existing) existing.state = "merged";
  }
}
