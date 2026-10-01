import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@orchestra/shared";
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
import { buildServer } from "../../apps/api/src/server";
import { InMemoryWorkflowStore } from "../helpers/in-memory-store";

const TOKEN = "test-token";
const logger = createLogger({ service: "test", level: "silent" });

describe("api", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let store: InMemoryWorkflowStore;
  let queue: InMemoryQueue;

  beforeEach(async () => {
    store = new InMemoryWorkflowStore();
    queue = new InMemoryQueue();
    const registry = new AgentRegistry();
    registry.register(new NoopAgent());
    const executor = new WorkflowExecutor({
      store,
      registry,
      tools: new ToolRegistry(),
      queue,
      policy: new PolicyEngine(DEFAULT_BLOCKING_RULES),
      logger,
      definitions: {
        software: parseWorkflowDefinition(`
name: software
stages:
  - id: only
    agent: noop-agent
`)
      }
    });
    const config = { ...loadConfig({}), apiToken: TOKEN };
    app = await buildServer({ config, logger, store, queue, registry, executor });
  });

  afterEach(async () => {
    await app.close();
  });

  function inject(method: "GET" | "POST", url: string, body?: unknown, auth = true) {
    return app.inject({
      method,
      url,
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
      ...(body !== undefined ? { payload: body } : {})
    });
  }

  it("rejects unauthenticated requests", async () => {
    const res = await inject("GET", "/workflows", undefined, false);
    expect(res.statusCode).toBe(401);
  });

  it("exposes health without auth", async () => {
    const res = await inject("GET", "/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("creates a workflow run and enqueues an advance", async () => {
    const res = await inject("POST", "/workflows", { definition: "software", context: { key: "PROJ-9" } });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(run.status).toBe("pending");

    const listed = await inject("GET", "/workflows");
    expect(listed.json().runs).toHaveLength(1);

    // The executor enqueued exactly one advance for the new run.
    const messages = await queue.claim(10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("run.advance");
    expect(messages[0]?.payload.runId).toBe(run.id);
  });

  it("rejects unknown workflow definitions with 404", async () => {
    const res = await inject("POST", "/workflows", { definition: "nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a missing run", async () => {
    const res = await inject("GET", "/workflows/00000000-0000-0000-0000-000000000000");
    expect(res.statusCode).toBe(404);
  });

  it("lists registered agents with permissions", async () => {
    const res = await inject("GET", "/agents");
    expect(res.statusCode).toBe(200);
    const { agents } = res.json();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("noop-agent");
    expect(agents[0].version).toBe("1.0.0");
  });

  it("rejects approval when none was requested", async () => {
    const created = await inject("POST", "/workflows", { definition: "software" });
    const runId = created.json().id;
    const res = await inject("POST", `/workflows/${runId}/approve`, {
      stageId: "only",
      decision: "approved",
      approvedBy: "alice"
    });
    expect(res.statusCode).toBe(400);
  });

  it("cancels a pending run", async () => {
    const created = await inject("POST", "/workflows", { definition: "software" });
    const runId = created.json().id;
    const res = await inject("POST", `/workflows/${runId}/cancel`);
    expect(res.statusCode).toBe(200);
    expect((await store.getRun(runId))?.status).toBe("cancelled");
    const events = await store.listEvents(runId);
    expect(events.map((e) => e.type)).toContain("workflow.cancelled");
  });

  it("refuses to cancel an already-terminal run", async () => {
    const created = await inject("POST", "/workflows", { definition: "software" });
    const runId = created.json().id;
    await store.updateRunStatus(runId, "succeeded");
    const res = await inject("POST", `/workflows/${runId}/cancel`);
    expect(res.statusCode).toBe(409);
  });

  it("writes audit events for workflow creation", async () => {
    await inject("POST", "/workflows", { definition: "software" });
    expect(store.auditRows.some((a) => a.action === "workflow.created")).toBe(true);
  });
});
