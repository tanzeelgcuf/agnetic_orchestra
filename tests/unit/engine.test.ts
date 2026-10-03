import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { InMemoryQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  NoopAgent,
  PolicyEngine,
  DEFAULT_BLOCKING_RULES,
  ToolRegistry
} from "@orchestra/agents";
import type { Agent, AgentContext, AgentResult } from "@orchestra/agents";
import { parseWorkflowDefinition, validateGraph, WorkflowExecutor } from "@orchestra/workflow-engine";
import type { WorkflowStore } from "@orchestra/shared";
import { InMemoryWorkflowStore } from "../helpers/in-memory-store";

const logger = createLogger({ service: "test", level: "silent" });

interface Harness {
  store: WorkflowStore;
  queue: InMemoryQueue;
  executor: WorkflowExecutor;
  registry: AgentRegistry;
}

function buildHarness(
  definitions: Record<string, ReturnType<typeof parseWorkflowDefinition>>,
  extraAgents: Agent[] = []
): Harness {
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
  return { store, queue, executor, registry };
}

/** Claim + handle + complete until the queue is fully drained (waits through backoff). */
async function drain(executor: WorkflowExecutor, queue: InMemoryQueue, maxPasses = 1000): Promise<void> {
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

describe("workflow engine", () => {
  it("runs a linear workflow to completion", async () => {
    const def = parseWorkflowDefinition(`
name: linear
stages:
  - id: a
    agent: noop-agent
  - id: b
    agent: noop-agent
    depends_on: [a]
`);
    const { store, queue, executor } = buildHarness({ linear: def });
    const run = await executor.startRun("linear", { issueKey: "PROJ-1" });
    await drain(executor, queue);

    const final = await store.getRun(run.id);
    expect(final?.status).toBe("succeeded");

    const stages = await store.listStageRuns(run.id);
    expect(stages.map((s) => s.stageId)).toEqual(["a", "b"]);
    expect(stages.every((s) => s.status === "succeeded")).toBe(true);
    // Agent versions are recorded per stage run.
    expect(stages.every((s) => s.agentVersion === "1.0.0")).toBe(true);

    const events = await store.listEvents(run.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("workflow.created");
    expect(types).toContain("workflow.started");
    expect(types).toContain("stage.started");
    expect(types).toContain("stage.succeeded");
    expect(types).toContain("workflow.succeeded");
  });

  it("fans out parallel stages and joins them through the barrier", async () => {
    const def = parseWorkflowDefinition(`
name: fanout
stages:
  - id: start
    agent: noop-agent
  - id: reviews
    type: parallel
    parallel: [reviewer-a, reviewer-b]
    depends_on: [start]
  - id: gate
    agent: noop-agent
    depends_on: [reviews]
`);
    const { store, queue, executor } = buildHarness(
      { fanout: def },
      [new NoopAgent("reviewer-a", "Reviewer A"), new NoopAgent("reviewer-b", "Reviewer B")]
    );
    const run = await executor.startRun("fanout", {});
    await drain(executor, queue);

    const final = await store.getRun(run.id);
    expect(final?.status).toBe("succeeded");

    const stages = await store.listStageRuns(run.id);
    const byId = new Map(stages.map((s) => [s.stageId, s]));
    expect(byId.get("reviews:reviewer-a")?.status).toBe("succeeded");
    expect(byId.get("reviews:reviewer-b")?.status).toBe("succeeded");
    expect(byId.get("reviews")?.status).toBe("succeeded"); // barrier
    expect(byId.get("gate")?.status).toBe("succeeded");
    expect(byId.get("gate")?.kind).toBe("agent");
  });

  it("parks at an approval stage until a human decision arrives", async () => {
    const def = parseWorkflowDefinition(`
name: gated
stages:
  - id: work
    agent: noop-agent
  - id: signoff
    type: approval
    depends_on: [work]
  - id: done
    agent: noop-agent
    depends_on: [signoff]
`);
    const { store, queue, executor } = buildHarness({ gated: def });
    const run = await executor.startRun("gated", {});
    await drain(executor, queue);

    // Parked: work succeeded, signoff awaiting approval, done not started.
    expect((await store.getRun(run.id))?.status).toBe("running");
    const stages = await store.listStageRuns(run.id);
    const byId = new Map(stages.map((s) => [s.stageId, s]));
    expect(byId.get("work")?.status).toBe("succeeded");
    expect(byId.get("signoff")?.status).toBe("awaiting_approval");
    expect(byId.has("done")).toBe(false);
    const approval = await store.getApproval(run.id, "signoff");
    expect(approval?.decision).toBe("pending");

    // Human approves through the API, which enqueues the decision.
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "signoff",
      decision: "approved",
      approvedBy: "alice"
    });
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("succeeded");
    expect((await store.getStageRun(run.id, "done"))?.status).toBe("succeeded");
    const audit = (store as InMemoryWorkflowStore).auditRows;
    expect(audit.some((a) => a.actor === "alice" && a.action === "approval.approved")).toBe(true);
  });

  it("fails the run when approval is rejected", async () => {
    const def = parseWorkflowDefinition(`
name: gated-reject
stages:
  - id: signoff
    type: approval
`);
    const { store, queue, executor } = buildHarness({ "gated-reject": def });
    const run = await executor.startRun("gated-reject", {});
    await drain(executor, queue);

    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "signoff",
      decision: "rejected",
      approvedBy: "bob"
    });
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("failed");
    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.type)).toContain("approval.rejected");
  });

  it("retries a failing stage with backoff, then fails the workflow", async () => {
    class FailingAgent implements Agent {
      readonly id = "failing-agent";
      readonly name = "Failing";
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
        throw new Error("boom");
      }
    }
    const def = parseWorkflowDefinition(`
name: retrying
stages:
  - id: unstable
    agent: failing-agent
    max_attempts: 2
`);
    const { store, queue, executor } = buildHarness({ retrying: def }, [new FailingAgent()]);
    const run = await executor.startRun("retrying", {});
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("failed");
    const stage = await store.getStageRun(run.id, "unstable");
    expect(stage?.status).toBe("failed");
    expect(stage?.attempts).toBe(2);
    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.type)).toContain("stage.retried");
    expect(events.map((e) => e.type)).toContain("stage.failed");
  });

  it("fails a stage that exceeds its timeout", async () => {
    class HangingAgent implements Agent {
      readonly id = "hanging-agent";
      readonly name = "Hanging";
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
        return new Promise<AgentResult>(() => undefined);
      }
    }
    const def = parseWorkflowDefinition(`
name: timeouts
stages:
  - id: slow
    agent: hanging-agent
    timeout_ms: 50
`);
    const { store, queue, executor } = buildHarness({ timeouts: def }, [new HangingAgent()]);
    const run = await executor.startRun("timeouts", {});
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("failed");
    const stage = await store.getStageRun(run.id, "slow");
    expect(stage?.error).toContain("timed out");
  });

  it("propagates dependency outputs into stage input", async () => {
    const def = parseWorkflowDefinition(`
name: propagation
stages:
  - id: upstream
    agent: noop-agent
  - id: downstream
    agent: noop-agent
    depends_on: [upstream]
`);
    const { store, queue, executor } = buildHarness({ propagation: def });
    const run = await executor.startRun("propagation", {});
    await drain(executor, queue);

    const downstream = await store.getStageRun(run.id, "downstream");
    expect(downstream?.input).toBeDefined();
    const input = downstream?.input as { dependencies: Record<string, unknown> };
    expect(input.dependencies.upstream).toBeDefined();
  });

  it("rejects stage input that fails the agent's validate() contract", async () => {
    class PickyAgent implements Agent {
      readonly id = "picky-agent";
      readonly name = "Picky";
      readonly version = "1.0.0";
      capabilities() {
        return [];
      }
      permissions() {
        return {};
      }
      validate(input: Record<string, unknown>) {
        if (typeof input.required_field !== "string") {
          return { ok: false, errors: ["required_field must be a string"] };
        }
        return { ok: true, errors: [] };
      }
      async execute(_ctx: AgentContext): Promise<AgentResult> {
        return { status: "success", summary: "should never run" };
      }
    }
    const def = parseWorkflowDefinition(`
name: picky
stages:
  - id: gated-input
    agent: picky-agent
    max_attempts: 2
`);
    const { store, queue, executor } = buildHarness({ picky: def }, [new PickyAgent()]);
    const run = await executor.startRun("picky", {});
    await drain(executor, queue);

    expect((await store.getRun(run.id))?.status).toBe("failed");
    const stage = await store.getStageRun(run.id, "gated-input");
    expect(stage?.error).toContain("required_field must be a string");
  });
});

describe("workflow definition validation", () => {
  it("rejects dependency cycles", () => {
    const registry = new AgentRegistry();
    registry.register(new NoopAgent());
    const def = parseWorkflowDefinition(`
name: cyclic
stages:
  - id: a
    agent: noop-agent
    depends_on: [b]
  - id: b
    agent: noop-agent
    depends_on: [a]
`);
    const validation = validateGraph(def, registry);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("rejects unregistered agents", () => {
    const registry = new AgentRegistry();
    const def = parseWorkflowDefinition(`
name: ghost
stages:
  - id: a
    agent: missing-agent
`);
    const validation = validateGraph(def, registry);
    expect(validation.ok).toBe(false);
    expect(validation.errors.some((e) => e.includes("missing-agent"))).toBe(true);
  });

  it("rejects duplicate agents in a parallel group", () => {
    expect(() =>
      parseWorkflowDefinition(`
name: dupes
stages:
  - id: reviews
    type: parallel
    parallel: [noop-agent, noop-agent]
`)
    ).toThrow(/duplicate agents/);
  });
});
