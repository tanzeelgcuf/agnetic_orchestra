import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { InMemoryQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  DEFAULT_BLOCKING_RULES,
  DEFAULT_ENVIRONMENT_POLICIES,
  DeploymentAgent,
  MergeAgent,
  NoopAgent,
  PolicyEngine,
  ToolRegistry,
  VerificationAgent
} from "@orchestra/agents";
import { InMemoryGitHubAdapter } from "@orchestra/integrations";
import { parseWorkflowDefinition, WorkflowExecutor } from "@orchestra/workflow-engine";
import type { WorkflowStore } from "@orchestra/shared";
import { InMemoryWorkflowStore } from "../helpers/in-memory-store";

const logger = createLogger({ service: "test", level: "silent" });
const REPO = { owner: "acme", name: "app" };

const DEF = parseWorkflowDefinition(`
name: deploy-rework
stages:
  - id: merge
    agent: merge-agent
    depends_on: []
    max_attempts: 1
  - id: deployment
    agent: deployment-agent
    depends_on: [merge]
    input:
      environment: production
      workflow_file: deploy.yml
    max_attempts: 1
  - id: verification
    agent: verification-agent
    depends_on: [deployment]
    input:
      smoke_url: http://svc.local/health
    rework_to: deployment
    max_rework: 1
    timeout_ms: 300000
`);

interface Harness {
  store: WorkflowStore;
  queue: InMemoryQueue;
  executor: WorkflowExecutor;
  github: InMemoryGitHubAdapter;
  smokeCalls: () => number;
}

function buildHarness(mode: "recovers" | "always-broken"): Harness {
  const github = new InMemoryGitHubAdapter();
  let smokeCalls = 0;
  // The smoke endpoint is down while only the first (feature-branch)
  // deployment exists — i.e. until the rollback deploy lands. In
  // "always-broken" mode it never recovers.
  const fetchImpl = (async () => {
    smokeCalls += 1;
    if (mode === "always-broken" || github.deployments.length <= 1) {
      throw new Error("service down");
    }
    return { ok: true, status: 200 };
  }) as unknown as typeof fetch;

  const registry = new AgentRegistry();
  registry.register(new NoopAgent());
  registry.register(new MergeAgent({ github, pollIntervalMs: 1 }));
  registry.register(
    new DeploymentAgent({ github, envPolicies: DEFAULT_ENVIRONMENT_POLICIES, pollIntervalMs: 1 })
  );
  registry.register(new VerificationAgent({ github, fetchImpl, smokeTimeoutMs: 100 }));

  const store = new InMemoryWorkflowStore();
  const queue = new InMemoryQueue();
  const executor = new WorkflowExecutor({
    store,
    registry,
    tools: new ToolRegistry(),
    queue,
    policy: new PolicyEngine(DEFAULT_BLOCKING_RULES),
    logger,
    definitions: { "deploy-rework": DEF }
  });
  return { store, queue, executor, github, smokeCalls: () => smokeCalls };
}

async function drain(executor: WorkflowExecutor, queue: InMemoryQueue, maxPasses = 300): Promise<void> {
  for (let i = 0; i < maxPasses; i++) {
    const messages = await queue.claim(10);
    if (messages.length === 0) {
      if ((await queue.pendingCount()) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    for (const msg of messages) {
      await executor.handleQueueMessage(msg);
      await queue.complete(msg);
    }
  }
  throw new Error("drain exceeded max passes");
}

describe("deployment rework loop (rollback on smoke failure)", () => {
  it("rolls back to the previous known-good ref when smoke fails once, then succeeds", async () => {
    const h = buildHarness("recovers");
    // Merge needs an open PR to merge; its base-branch head becomes previousRef.
    await h.github.createPullRequest({ repo: REPO, title: "t", head: "feature", base: "main" });
    h.github.branchHeads.set("main", "abc123");

    const run = await h.executor.startRun("deploy-rework", {
      repo: REPO,
      branch: "feature",
      base_branch: "main"
    });
    await drain(h.executor, h.queue);

    const finalRun = await h.store.getRun(run.id);
    expect(finalRun?.status).toBe("succeeded");
    expect(finalRun?.reworkCount).toBe(1);

    // Two deploys: the feature branch, then the rollback to the previous ref.
    expect(h.github.dispatchedWorkflows).toHaveLength(2);
    expect(h.github.dispatchedWorkflows[0]?.ref).toBe("feature");
    expect(h.github.dispatchedWorkflows[1]?.ref).toBe("abc123");

    const deployOutput = (await h.store.getStageRun(run.id, "deployment"))?.output as {
      metadata?: { rollback?: boolean; ref?: string };
    };
    expect(deployOutput.metadata?.rollback).toBe(true);
    expect(deployOutput.metadata?.ref).toBe("abc123");
    expect(h.smokeCalls()).toBe(2);
  });

  it("fails the run when the service is still broken after the rollback deploy", async () => {
    const h = buildHarness("always-broken");
    await h.github.createPullRequest({ repo: REPO, title: "t", head: "feature", base: "main" });

    const run = await h.executor.startRun("deploy-rework", {
      repo: REPO,
      branch: "feature",
      base_branch: "main"
    });
    await drain(h.executor, h.queue);

    const finalRun = await h.store.getRun(run.id);
    expect(finalRun?.status).toBe("failed");
    expect(finalRun?.reworkCount).toBe(1);

    // Rollback deployed the previous ref, but the smoke test still failed.
    expect(h.github.dispatchedWorkflows).toHaveLength(2);
    expect(h.github.dispatchedWorkflows[1]?.ref).toBe("main");
    const deployOutput = (await h.store.getStageRun(run.id, "deployment"))?.output as {
      metadata?: { rollback?: boolean };
    };
    expect(deployOutput.metadata?.rollback).toBe(true);
  });
});
