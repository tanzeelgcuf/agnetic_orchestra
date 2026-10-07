import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { InMemoryQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  DEFAULT_BLOCKING_RULES,
  NoopAgent,
  PolicyEngine,
  ToolRegistry
} from "@orchestra/agents";
import { parseWorkflowDefinition, WorkflowExecutor } from "@orchestra/workflow-engine";
import type { WorkflowStore } from "@orchestra/shared";
import { InMemoryWorkflowStore } from "./in-memory-store";

const logger = createLogger({ service: "eval", level: "silent" });

/**
 * Recorded fixture for agent evaluation: a workflow definition + the expected
 * stage outcomes to replay. The harness drives the real engine against the
 * fixture and asserts the final run status and stage outputs.
 */
export interface RecordedFixture {
  /** Workflow definition YAML. */
  definition: string;
  /** Initial run context. */
  context?: Record<string, unknown>;
  /** Expected final run status. */
  expectRunStatus: "succeeded" | "failed" | "blocked";
  /** Expected stage statuses, keyed by stage id. */
  expectStageStatus?: Record<string, string>;
  /** Expected substring in a stage's output summary, keyed by stage id. */
  expectStageSummaryContains?: Record<string, string>;
}

/**
 * Replay a recorded fixture against the real workflow engine using in-memory
 * doubles, and assert the expected outcomes.
 */
export async function evaluateFixture(
  fixture: RecordedFixture,
  extraAgents: Parameters<AgentRegistry["register"]>[0][] = []
): Promise<{ runStatus: string; stageStatuses: Record<string, string> }> {
  const def = parseWorkflowDefinition(fixture.definition);
  const registry = new AgentRegistry();
  registry.register(new NoopAgent());
  for (const agent of extraAgents) registry.register(agent);

  const store: WorkflowStore = new InMemoryWorkflowStore();
  const queue = new InMemoryQueue();
  const executor = new WorkflowExecutor({
    store,
    registry,
    tools: new ToolRegistry(),
    queue,
    policy: new PolicyEngine(DEFAULT_BLOCKING_RULES),
    logger,
    definitions: { eval: def }
  });

  const run = await executor.startRun("eval", fixture.context ?? {});

  // Run until no more work can be done
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    const messages = await queue.claim(10);
    if (messages.length > 0) {
      madeProgress = true;
      for (const msg of messages) {
        await executor.handleQueueMessage(msg);
        await queue.complete(msg);
      }
    }
  }

  const finalRun = await store.getRun(run.id);
  const stageRuns = await store.listStageRuns(run.id);
  const stageStatuses: Record<string, string> = {};
  for (const stage of stageRuns) stageStatuses[stage.stageId] = stage.status;

  expect(finalRun?.status).toBe(fixture.expectRunStatus);
  for (const [stageId, expected] of Object.entries(fixture.expectStageStatus ?? {})) {
    expect(stageStatuses[stageId]).toBe(expected);
  }
  for (const [stageId, expected] of Object.entries(fixture.expectStageSummaryContains ?? {})) {
    const stage = stageRuns.find((s) => s.stageId === stageId);
    const output = stage?.output as { summary?: string } | null;
    expect(output?.summary ?? "").toContain(expected);
  }

  return { runStatus: finalRun?.status ?? "unknown", stageStatuses };
}

describe("evaluation framework", () => {
  it("replays a passing fixture", async () => {
    await evaluateFixture({
      definition: `
name: eval
stages:
  - id: one
    agent: noop-agent
  - id: two
    agent: noop-agent
    depends_on: [one]
`,
      expectRunStatus: "succeeded",
      expectStageStatus: { one: "succeeded", two: "succeeded" }
    });
  });

  it("replays a failing fixture", async () => {
    await evaluateFixture({
      definition: `
name: eval-fail
stages:
  - id: boom
    agent: noop-agent
`,
      expectRunStatus: "succeeded",
      expectStageStatus: { boom: "succeeded" }
    });
  });
});
