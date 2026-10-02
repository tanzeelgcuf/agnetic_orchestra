import Fastify from "fastify";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NotFoundError, OrchestraError, ValidationError } from "@orchestra/shared";
import type { AppConfig, WorkflowStore } from "@orchestra/shared";
import type { Logger } from "@orchestra/observability";
import type { TaskQueue } from "@orchestra/event-bus";
import type { AgentRegistry } from "@orchestra/agents";
import type { WorkflowExecutor } from "@orchestra/workflow-engine";
import type { WebhookDeliveryStore } from "@orchestra/database";
import type { GitHubWebhookHandler } from "@orchestra/integrations";
import { verifyWebhookSignature, parseGitHubWebhook } from "@orchestra/integrations";

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  store: WorkflowStore;
  queue: TaskQueue;
  registry: AgentRegistry;
  executor: WorkflowExecutor;
  /** Deduplicating store for inbound webhook deliveries. */
  webhooks?: WebhookDeliveryStore;
  /** Handlers invoked for verified, deduplicated webhook events. */
  webhookHandlers?: GitHubWebhookHandler[];
}

const CreateWorkflowSchema = z.object({
  definition: z.string().min(1),
  context: z.record(z.unknown()).default({})
});

const ApproveSchema = z.object({
  stageId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]),
  approvedBy: z.string().min(1),
  note: z.string().optional()
});

type FastifyRequestWithRawBody = { rawBody?: string };

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1_048_576
  });
  await app.register(cors, { origin: true });

  // Capture the raw body for webhook signature verification while keeping the
  // parsed object available to every JSON route.
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      (_req as FastifyRequestWithRawBody).rawBody = body;
      done(null, JSON.parse(body));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Auth: bearer token on everything except /health (and the webhook route,
  // which GitHub calls and which authenticates via HMAC signature instead).
  // Phase 1 mechanism (ADR-006); JWT/OIDC lands in Phase 8.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.method === "OPTIONS" || req.url === "/webhooks/github") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token.length === 0 || token !== deps.config.apiToken) {
      return await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      return void reply.code(400).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof NotFoundError) {
      return void reply.code(404).send({ error: err.code, message: err.message });
    }
    if (err instanceof OrchestraError) {
      return void reply.code(409).send({ error: err.code, message: err.message, details: err.details });
    }
    deps.logger.error({ err }, "unhandled error");
    return void reply.code(500).send({ error: "INTERNAL_ERROR", message: "internal server error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Inbound GitHub webhooks. Verified by HMAC-SHA256 when
  // GITHUB_WEBHOOK_SECRET is set; unsigned accepted only when unset (dev).
  // Deduplicated by X-GitHub-Delivery id; audited; dispatched to handlers.
  app.post("/webhooks/github", async (req, reply) => {
    const rawBody = (req as FastifyRequestWithRawBody).rawBody ?? JSON.stringify(req.body ?? {});
    const eventName = asHeader(req.headers["x-github-event"]);
    const deliveryId = asHeader(req.headers["x-github-delivery"]) ?? randomUUID();
    const signature = asHeader(req.headers["x-hub-signature-256"]);

    const secret = deps.config.githubWebhookSecret;
    if (secret) {
      if (!eventName || !verifyWebhookSignature(rawBody, signature, secret)) {
        return await reply.code(401).send({ error: "invalid_signature" });
      }
    } else if (!eventName) {
      return await reply.code(400).send({ error: "missing x-github-event header" });
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const parsed = parseGitHubWebhook(eventName ?? "unknown", payload);

    const delivery = deps.webhooks
      ? await deps.webhooks.recordDelivery({
          source: "github",
          deliveryId,
          event: parsed.kind,
          action: parsed.action,
          payload
        })
      : { isNew: true };
    if (!delivery.isNew) {
      return await reply.code(200).send({ ok: true, duplicate: true });
    }

    await deps.store.appendAudit(
      "github-webhook",
      `${parsed.kind}.${parsed.action ?? "event"}`,
      parsed.repository
        ? `repo/${parsed.repository.owner}/${parsed.repository.name}`
        : "github",
      { deliveryId, issueKey: parsed.issueKey ?? null }
    );

    for (const handler of deps.webhookHandlers ?? []) {
      try {
        await handler.handle({ event: parsed, deliveryId, raw: payload });
      } catch (e) {
        // Handler errors must not 500 the webhook: GitHub would retry and the
        // delivery dedup would swallow the retry without re-running handlers.
        deps.logger.warn({ err: e, handler: handler.name, deliveryId }, "webhook handler failed");
      }
    }

    return await reply.code(200).send({
      ok: true,
      kind: parsed.kind,
      action: parsed.action,
      issueKey: parsed.issueKey
    });
  });

  app.post("/workflows", async (req, reply) => {
    const parsed = CreateWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("invalid workflow request", parsed.error.flatten());
    }
    const run = await deps.executor.startRun(parsed.data.definition, parsed.data.context);
    await deps.store.appendAudit("api", "workflow.created", `workflow_run/${run.id}`, {
      definition: parsed.data.definition
    });
    return void reply.code(201).send(run);
  });

  app.get("/workflows", async () => {
    const runs = await deps.store.listRuns();
    return { runs };
  });

  app.get("/workflows/:id", async (req) => {
    const { id } = req.params as { id: string };
    const run = await deps.store.getRun(id);
    if (!run) throw new NotFoundError("workflow run", id);
    const stages = await deps.store.listStageRuns(id);
    const approvals = await Promise.all(
      stages.map((s) => deps.store.getApproval(id, s.stageId))
    );
    return {
      run,
      stages,
      approvals: approvals.filter((a): a is NonNullable<typeof a> => a !== null)
    };
  });

  app.get("/workflows/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const run = await deps.store.getRun(id);
    if (!run) throw new NotFoundError("workflow run", id);
    const events = await deps.store.listEvents(id);
    return { events };
  });

  app.get("/workflows/:id/findings", async (req) => {
    const { id } = req.params as { id: string };
    const run = await deps.store.getRun(id);
    if (!run) throw new NotFoundError("workflow run", id);
    const events = await deps.store.listEvents(id);
    const findings = events.flatMap((event) => {
      const data = event.data as { findings?: unknown[] } | undefined;
      if (!data?.findings || !Array.isArray(data.findings)) return [];
      return data.findings;
    });
    return { findings };
  });

  app.post("/workflows/:id/approve", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError("invalid approval request", parsed.error.flatten());
    }
    const run = await deps.store.getRun(id);
    if (!run) throw new NotFoundError("workflow run", id);
    const approval = await deps.store.getApproval(id, parsed.data.stageId);
    if (!approval) {
      throw new ValidationError(`no approval requested for stage "${parsed.data.stageId}"`);
    }
    if (approval.decision !== "pending") {
      throw new OrchestraError(
        "APPROVAL_ALREADY_DECIDED",
        `approval for stage "${parsed.data.stageId}" already ${approval.decision}`
      );
    }
    await deps.queue.enqueue("approval.decision", {
      runId: id,
      stageId: parsed.data.stageId,
      decision: parsed.data.decision,
      approvedBy: parsed.data.approvedBy,
      note: parsed.data.note
    });
    return { ok: true, decision: parsed.data.decision, stageId: parsed.data.stageId };
  });

  app.post("/workflows/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const run = await deps.store.getRun(id);
    if (!run) throw new NotFoundError("workflow run", id);
    if (run.status === "succeeded" || run.status === "failed" || run.status === "blocked" || run.status === "cancelled") {
      throw new OrchestraError("WORKFLOW_TERMINAL", `workflow run is already ${run.status}`);
    }
    await deps.store.updateRunStatus(id, "cancelled");
    await deps.store.appendEvent({ type: "workflow.cancelled", runId: id });
    await deps.store.appendAudit("api", "workflow.cancelled", `workflow_run/${id}`);
    return { ok: true, status: "cancelled" };
  });

  app.get("/agents", async () => {
    return {
      agents: deps.registry.list().map((agent) => ({
        id: agent.id,
        name: agent.name,
        version: agent.version,
        description: agent.description,
        capabilities: agent.capabilities(),
        permissions: agent.permissions()
      }))
    };
  });

  return app;
}

function asHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}
