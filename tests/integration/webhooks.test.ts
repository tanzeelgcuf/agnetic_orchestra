import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@orchestra/shared";
import { createLogger } from "@orchestra/observability";
import { InMemoryQueue } from "@orchestra/event-bus";
import { AgentRegistry, NoopAgent, PolicyEngine, ToolRegistry } from "@orchestra/agents";
import { parseWorkflowDefinition, WorkflowExecutor } from "@orchestra/workflow-engine";
import type { GitHubWebhookHandler } from "@orchestra/integrations";
import { WorkflowTriggerHandler } from "../../apps/api/src/webhooks";
import { buildServer } from "../../apps/api/src/server";
import { InMemoryWorkflowStore, InMemoryWebhookStore } from "../helpers/in-memory-store";

const logger = createLogger({ service: "test", level: "silent" });
const SECRET = "whsec-test";

function signedHeaders(payload: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`
  };
}

const PR_PAYLOAD = {
  action: "opened",
  repository: { owner: { login: "acme" }, name: "api" },
  pull_request: { number: 7, title: "PROJ-123: change", state: "open", head: { ref: "proj-123" } }
};

describe("github webhook endpoint", () => {
  let store: InMemoryWorkflowStore;
  let queue: InMemoryQueue;
  let webhookStore: InMemoryWebhookStore;
  let handled: string[];
  let handler: GitHubWebhookHandler;
  let app: Awaited<ReturnType<typeof makeApp>>;

  function makeApp(opts: { secret?: string; triggers?: Record<string, string> }) {
    const registry = new AgentRegistry();
    registry.register(new NoopAgent());
    const executor = new WorkflowExecutor({
      store,
      registry,
      tools: new ToolRegistry(),
      queue,
      policy: new PolicyEngine(),
      logger,
      definitions: {
        triggered: parseWorkflowDefinition(`
name: triggered
stages:
  - id: only
    agent: noop-agent
`)
      }
    });
    const config = {
      ...loadConfig({}),
      apiToken: "test-token",
      ...(opts.secret !== undefined ? { githubWebhookSecret: opts.secret } : {}),
      webhookTriggers: opts.triggers ?? {}
    };
    return buildServer({
      config,
      logger,
      store,
      queue,
      registry,
      executor,
      webhooks: webhookStore,
      webhookHandlers: [
        handler,
        new WorkflowTriggerHandler(
          (definition, context) => executor.startRun(definition, context),
          config.webhookTriggers
        )
      ]
    });
  }

  beforeEach(() => {
    store = new InMemoryWorkflowStore();
    queue = new InMemoryQueue();
    webhookStore = new InMemoryWebhookStore();
    handled = [];
    handler = {
      name: "test-handler",
      handle: async ({ event }) => {
        handled.push(`${event.kind}.${event.action ?? ""}`);
      }
    };
  });

  afterEach(async () => {
    await app.close().catch(() => {});
  });

  it("accepts a signed webhook and dispatches to handlers", async () => {
    app = await makeApp({ secret: SECRET });
    const payload = JSON.stringify(PR_PAYLOAD);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kind: "pull_request", action: "opened", issueKey: "PROJ-123" });
    expect(handled).toEqual(["pull_request.opened"]);
    // Delivery + audit recorded.
    expect(await webhookStore.hasDelivery("github", "delivery-1")).toBe(true);
    expect(store.auditRows.some((a) => a.action === "pull_request.opened")).toBe(true);
  });

  it("rejects an invalid signature when a secret is configured", async () => {
    app = await makeApp({ secret: SECRET });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": "sha256=bad"
      },
      payload: PR_PAYLOAD
    });
    expect(res.statusCode).toBe(401);
    expect(handled).toHaveLength(0);
  });

  it("accepts unsigned webhooks when no secret is configured (dev mode)", async () => {
    app = await makeApp({});
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "delivery-3" },
      payload: { ref: "refs/heads/main", after: "abc" }
    });
    expect(res.statusCode).toBe(200);
    expect(handled).toEqual(["push."]);
  });

  it("deduplicates by delivery id and does not re-run handlers", async () => {
    app = await makeApp({ secret: SECRET });
    const payload = JSON.stringify(PR_PAYLOAD);
    const first = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(handled).toEqual(["pull_request.opened"]);
  });

  it("starts a configured workflow from a webhook trigger", async () => {
    app = await makeApp({ secret: SECRET, triggers: { "pull_request.opened": "triggered" } });
    const payload = JSON.stringify(PR_PAYLOAD);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    expect(res.statusCode).toBe(200);
    // The trigger started the workflow: run persisted + advance enqueued.
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.definition).toBe("triggered");
    const messages = await queue.claim(10);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind).toBe("run.advance");
  });

  it("does not start workflows without a matching trigger", async () => {
    app = await makeApp({ secret: SECRET, triggers: { "push": "triggered" } });
    const payload = JSON.stringify(PR_PAYLOAD);
    await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    expect(await store.listRuns()).toHaveLength(0);
  });

  it("swallows handler errors with a 200 (GitHub retries would be deduped)", async () => {
    handler = {
      name: "boom",
      handle: async () => {
        throw new Error("handler exploded");
      }
    };
    app = await makeApp({ secret: SECRET });
    const payload = JSON.stringify(PR_PAYLOAD);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: signedHeaders(payload),
      payload
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
