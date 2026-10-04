import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { MergeAgent } from "@orchestra/agents";
import { InMemoryGitHubAdapter } from "@orchestra/integrations";
import type { AgentContext } from "@orchestra/agents";

const logger = createLogger({ service: "test", level: "silent" });
const REPO = { owner: "acme", name: "app" };

function makeContext(extra: Record<string, unknown> = {}): AgentContext {
  return {
    runId: "run-merge",
    stageId: "merge",
    agentId: "merge-agent",
    input: { repo: REPO, ...extra },
    workflowContext: {},
    tools: [],
    logger
  };
}

async function seedPr(github: InMemoryGitHubAdapter, head = "feature"): Promise<void> {
  await github.createPullRequest({ repo: REPO, title: "t", head, base: "main" });
  github.checksByBranch.set(head, [{ name: "ci", status: "completed", conclusion: "success" }]);
}

describe("merge agent", () => {
  it("merges the PR from the development stage's prUrl after green checks", async () => {
    const github = new InMemoryGitHubAdapter();
    await seedPr(github);
    const agent = new MergeAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(
      makeContext({
        dependencies: { development: { metadata: { prUrl: `${REPO.owner}/${REPO.name}/pull/1` } } },
        branch: "feature"
      })
    );

    expect(result.status).toBe("success");
    expect(github.mergedBranches.map((m) => m.branch)).toEqual(["feature"]);
    const meta = result.metadata as { merged: boolean; prNumber: number; previousRef: string; mergedRef: string };
    expect(meta.merged).toBe(true);
    expect(meta.prNumber).toBe(1);
    expect(meta.mergedRef).toBe("main");
  });

  it("falls back to finding the open PR by branch", async () => {
    const github = new InMemoryGitHubAdapter();
    await seedPr(github);
    const agent = new MergeAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    expect(github.mergedBranches).toHaveLength(1);
  });

  it("waits for in-progress checks to complete before merging", async () => {
    const github = new InMemoryGitHubAdapter();
    await seedPr(github);
    github.checksByBranch.set("feature", [{ name: "ci", status: "in_progress" }]);
    setTimeout(() => {
      github.checksByBranch.set("feature", [{ name: "ci", status: "completed", conclusion: "success" }]);
    }, 10);

    const agent = new MergeAgent({ github, pollIntervalMs: 1, checksTimeoutMs: 5000 });
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    expect(github.mergedBranches).toHaveLength(1);
  });

  it("fails with a high-severity finding when a check fails", async () => {
    const github = new InMemoryGitHubAdapter();
    await seedPr(github);
    github.checksByBranch.set("feature", [
      { name: "ci", status: "completed", conclusion: "failure" }
    ]);

    const agent = new MergeAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("failed");
    expect(github.mergedBranches).toHaveLength(0);
    expect(result.findings?.[0]?.severity).toBe("high");
    expect(result.findings?.[0]?.domain).toBe("code");
  });

  it("skips with success when no PR exists", async () => {
    const github = new InMemoryGitHubAdapter();
    const agent = new MergeAgent({ github });
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    const meta = result.metadata as { merged: boolean; reason: string };
    expect(meta.merged).toBe(false);
    expect(meta.reason).toBe("no_pull_request");
  });

  it("skips with success when unconfigured", async () => {
    const agent = new MergeAgent({});
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    expect((result.metadata as { merged: boolean; reason: string }).reason).toBe("not_configured");
  });

  it("captures the previous ref before merging", async () => {
    const github = new InMemoryGitHubAdapter();
    await seedPr(github);
    github.branchHeads.set("main", "abc123");
    const agent = new MergeAgent({ github, pollIntervalMs: 1 });
    const result = await agent.execute(makeContext({ branch: "feature" }));

    expect(result.status).toBe("success");
    expect((result.metadata as { previousRef: string }).previousRef).toBe("abc123");
  });
});
