import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { InMemoryQueue } from "@orchestra/event-bus";
import { AgentRegistry, DEFAULT_BLOCKING_RULES, NoopAgent, PolicyEngine, ToolRegistry } from "@orchestra/agents";
import type { Agent, AgentContext, AgentResult, Finding } from "@orchestra/agents";
import { parseWorkflowDefinition, transitiveDependents, WorkflowExecutor } from "@orchestra/workflow-engine";
import type { WorkflowStore } from "@orchestra/shared";
import { InMemoryWorkflowStore } from "../helpers/in-memory-store";

const logger = createLogger({ service: "test", level: "silent" });

class FlakyThenFixedAgent implements Agent {
  readonly id = "flaky-agent";
  readonly name = "Flaky";
  readonly version = "1.0.0";
  readonly calls: { reworkFindings: unknown[] }[] = [];
  private runs = 0;

  capabilities() {
    return [];
  }
  permissions() {
    return {};
  }
  validate() {
    return { ok: true, errors: [] };
  }
  async execute(ctx: AgentContext): Promise<AgentResult> {
    this.runs += 1;
    const rework = ctx.input.rework_findings;
    this.calls.push({ reworkFindings: Array.isArray(rework) ? rework : [] });
    if (this.runs === 1) {
      const findings: Finding[] = [
        {
          id: "flaky-1",
          severity: "medium",
          source: this.id,
          domain: "code",
          title: "Empty catch block",
          description: "needs a fix"
        }
      ];
      return {
        status: "failed",
        summary: "review found non-blocking issues",
        findings,
        metadata: { rework: true }
      };
    }
    return { status: "success", summary: "fixed on rework" };
  }
}

function buildHarness(
  definitions: Record<string, ReturnType<typeof parseWorkflowDefinition>>,
  extraAgents: Agent[] = []
): { store: WorkflowStore; queue: InMemoryQueue; executor: WorkflowExecutor } {
  const registry = new AgentRegistry();
  registry.register(new NoopAgent());
  for (const agent of extraAgents) registry.register(agent);
  const store = new InMemoryWorkflowStore();
  const queue = new InMemoryQueue();
  const executor = new WorkflowExecutor({
    store,
    registry,
    tools: new ToolRegistry(),
    queue,
    policy: new PolicyEngine(DEFAULT_BLOCKING_RULES),
    logger,
    definitions
  });
  return { store, queue, executor };
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

describe("rework loop (§49 fix-iterate)", () => {
  it("reworks the subtree on failure and completes when the fix lands", async () => {
    const flaky = new FlakyThenFixedAgent();
    const def = parseWorkflowDefinition(`
name: reworking
stages:
  - id: dev
    agent: flaky-agent
    rework_to: dev
    max_rework: 2
  - id: done
    agent: noop-agent
    depends_on: [dev]
`);
    const { store, queue, executor } = buildHarness({ reworking: def }, [flaky]);
    const run = await executor.startRun("reworking", {});
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("succeeded");
    // The agent ran twice: initial + one rework.
    expect(flaky.calls).toHaveLength(2);
    // The findings reached the re-run's input (§49: findings -> development).
    expect(flaky.calls[1]?.reworkFindings).toHaveLength(1);
    expect((await store.getRun(run.id))?.reworkCount).toBe(1);
    // The downstream stage re-ran after the rework and succeeded.
    expect((await store.getStageRun(run.id, "done"))?.status).toBe("succeeded");
  });

  it("fails the run when the rework budget is exhausted", async () => {
    class AlwaysFailsAgent implements Agent {
      readonly id = "always-fails";
      readonly name = "AlwaysFails";
      readonly version = "1.0.0";
      capabilities() {
        return [];
      }
      permissions() {
        return {};
      }
      validate() {
        return { ok: true, errors: [] };
      }
      async execute(_ctx: AgentContext): Promise<AgentResult> {
        return {
          status: "failed",
          summary: "review still failing",
          findings: [
            { id: "x", severity: "medium", source: "always-fails", domain: "code", title: "Still broken", description: "d" }
          ],
          metadata: { rework: true }
        };
      }
    }
    const def = parseWorkflowDefinition(`
name: exhausts
stages:
  - id: dev
    agent: always-fails
    rework_to: dev
    max_rework: 2
`);
    const { store, queue, executor } = buildHarness({ exhausts: def }, [new AlwaysFailsAgent()]);
    const run = await executor.startRun("exhausts", {});
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("failed");
    expect((await store.getRun(run.id))?.reworkCount).toBe(2);
    const events = await store.listEvents(run.id);
    const reworks = events.filter((e) => e.type === "stage.retried" && (e.data as { rework?: boolean })?.rework);
    expect(reworks).toHaveLength(2);
  });

  it("resets the rework target's whole downstream subtree", () => {
    const stages = parseWorkflowDefinition(`
name: tree
stages:
  - id: a
    agent: noop-agent
  - id: b
    agent: noop-agent
    depends_on: [a]
  - id: c
    agent: noop-agent
    depends_on: [b]
  - id: d
    agent: noop-agent
    depends_on: [c]
  - id: unrelated
    agent: noop-agent
`).stages;
    // Reworking "b" resets b, c, d — not a or unrelated.
    expect(transitiveDependents(stages, "b").sort()).toEqual(["b", "c", "d"]);
    expect(transitiveDependents(stages, "a").sort()).toEqual(["a", "b", "c", "d"]);
  });
});
