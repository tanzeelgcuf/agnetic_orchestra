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
  RequirementsAgent,
  ToolRegistry
} from "@orchestra/agents";
import { InMemoryJiraAdapter, registerJiraTools } from "@orchestra/integrations";
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
    registry.register(new RequirementsAgent()); // heuristic analysis (no LLM in tests)
    registry.register(new NoopAgent());
    registry.register(new NoopAgent("noop-review-agent", "Noop Review Agent"));
    registry.register(new NoopAgent("noop-security-agent", "Noop Security Agent"));

    const tools = new ToolRegistry();
    const jira = new InMemoryJiraAdapter();
    jira.issues.set("PROJ-123", {
      key: "PROJ-123",
      summary: "Add password reset functionality",
      description: `Users must be able to reset their password from the login screen.

The system must email a time-limited reset link and must expire it after one use.
Given a valid reset link, when the user submits a new password, then access is updated.`,
      type: "Story",
      status: "todo"
    });
    registerJiraTools(tools, jira);

    executor = new WorkflowExecutor({
      store,
      registry,
      tools,
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

  async function drainUntilParked(maxPasses = 200): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const messages = await queue.claim(10);
      if (messages.length === 0) return;
      for (const msg of messages) {
        await executor.handleQueueMessage(msg);
        await queue.complete(msg);
      }
    }
    throw new Error("drain exceeded max passes");
  }

  it("drives the software-delivery workflow through both human approval gates", async () => {
    const run = await executor.startRun("software-delivery", { issue_key: "PROJ-123" });

    await drainUntilParked();

    // Parked at the requirements approval gate; the requirements agent ran and
    // everything before the gate succeeded.
    let current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const reqStage = await store.getStageRun(run.id, "requirements");
    expect(reqStage?.status).toBe("succeeded");
    expect(reqStage?.agent).toBe("requirements-agent");
    const reqApproval = await store.getApproval(run.id, "requirements-approval");
    expect(reqApproval?.decision).toBe("pending");

    // The requirements agent wrote its analysis back to the stage output.
    expect(reqStage?.output).toBeDefined();

    // First human approval (requirements).
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "requirements-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();

    // Parked at the final human approval gate.
    current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const finalApproval = await store.getApproval(run.id, "human-approval");
    expect(finalApproval?.decision).toBe("pending");

    // Second human approval (pre-merge).
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "human-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();

    current = await store.getRun(run.id);
    expect(current?.status).toBe("succeeded");

    const stages = await store.listStageRuns(run.id);
    expect(stages.map((s) => s.stageId)).toEqual([
      "requirements",
      "requirements-approval",
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
    expect(events.map((e) => e.type).filter((t) => t === "approval.requested")).toHaveLength(2);
    expect(events.map((e) => e.type)).toContain("workflow.succeeded");

    expect(await queue.pendingCount()).toBe(0);
  });

  it("recovers non-terminal runs on boot", async () => {
    const run = await executor.startRun("software-delivery", {});
    const recovered = await executor.recover();
    expect(recovered).toBeGreaterThanOrEqual(0);
    const messages = await queue.claim(10);
    expect(messages.some((m) => m.kind === "run.advance" && m.payload.runId === run.id)).toBe(true);
  });
});
