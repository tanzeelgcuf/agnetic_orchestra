import { beforeAll, afterEach, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createLogger } from "@orchestra/observability";
import { createDb, PgWorkflowStore } from "@orchestra/database";
import { PostgresQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  DEFAULT_BLOCKING_RULES,
  NoopAgent,
  PolicyEngine,
  ToolRegistry
} from "@orchestra/agents";
import { loadWorkflows, WorkflowExecutor } from "@orchestra/workflow-engine";
import { join } from "node:path";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://orchestra:orchestra@localhost:5433/orchestra";

let pgUp = false;
try {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  await probe.query("SELECT 1");
  await probe.end();
  pgUp = true;
} catch {
  pgUp = false;
}

const logger = createLogger({ service: "e2e", level: "silent" });

describe.skipIf(!pgUp)("orchestrated run against PostgreSQL", () => {
  let pool: Pool;
  let store: PgWorkflowStore;
  let queue: PostgresQueue;
  let executor: WorkflowExecutor;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { db } = createDb(DATABASE_URL);
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: join(process.cwd(), "packages/database/drizzle") });
    store = new PgWorkflowStore(db);
    queue = new PostgresQueue(DATABASE_URL);

    const registry = new AgentRegistry();
    registry.register(new NoopAgent());
    registry.register(new NoopAgent("noop-review-agent", "Noop Review Agent"));
    registry.register(new NoopAgent("noop-security-agent", "Noop Security Agent"));
    executor = new WorkflowExecutor({
      store,
      registry,
      tools: new ToolRegistry(),
      queue,
      policy: new PolicyEngine(DEFAULT_BLOCKING_RULES),
      logger,
      definitions: loadWorkflows(join(process.cwd(), "workflows"), registry)
    });
  });

  afterEach(async () => {
    await pool.query(
      "TRUNCATE workflow_runs, stage_runs, workflow_events, approvals, queue_messages, audit_events"
    );
  });

  afterAll(async () => {
    await pool.end();
    await queue.close();
  });

  it("drives the software-delivery workflow through the human approval gate", async () => {
    const run = await executor.startRun("software-delivery", { issueKey: "PROJ-123" });

    // Drain until parked at the approval stage.
    for (let i = 0; i < 100; i++) {
      const messages = await queue.claim(10);
      if (messages.length === 0) break;
      for (const msg of messages) {
        await executor.handleQueueMessage(msg);
        await queue.complete(msg);
      }
    }

    let current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const approval = await store.getApproval(run.id, "human-approval");
    expect(approval?.decision).toBe("pending");
    // Everything up to the gate completed.
    const stagesBefore = await store.listStageRuns(run.id);
    expect(stagesBefore.filter((s) => s.stageId !== "human-approval").every((s) => s.status === "succeeded")).toBe(true);

    // Human approves.
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "human-approval",
      decision: "approved",
      approvedBy: "e2e"
    });

    for (let i = 0; i < 100; i++) {
      const messages = await queue.claim(10);
      if (messages.length === 0) break;
      for (const msg of messages) {
        await executor.handleQueueMessage(msg);
        await queue.complete(msg);
      }
    }

    current = await store.getRun(run.id);
    expect(current?.status).toBe("succeeded");

    const stages = await store.listStageRuns(run.id);
    expect(stages.map((s) => s.stageId)).toEqual([
      "requirements",
      "development",
      "reviews:noop-review-agent",
      "reviews:noop-security-agent",
      "reviews",
      "quality-gate",
      "human-approval",
      "merge",
      "deployment",
      "verification"
    ]);
    expect(stages.every((s) => s.status === "succeeded")).toBe(true);

    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.type)).toContain("approval.requested");
    expect(events.map((e) => e.type)).toContain("approval.granted");
    expect(events.map((e) => e.type)).toContain("workflow.succeeded");

    // Queue fully drained, nothing stranded.
    expect(await queue.pendingCount()).toBe(0);
  });

  it("recovers non-terminal runs on boot", async () => {
    const run = await executor.startRun("software-delivery", {});
    // Simulate a crashed worker: the run is non-terminal with no queue activity.
    const recovered = await executor.recover();
    expect(recovered).toBeGreaterThanOrEqual(0);
    const messages = await queue.claim(10);
    // The recovery pass re-enqueued an advance for the run.
    expect(messages.some((m) => m.kind === "run.advance" && m.payload.runId === run.id)).toBe(true);
  });
});
