import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { NotFoundError, OrchestraError, ValidationError } from "@orchestra/shared";
import type { AppConfig, WorkflowStore } from "@orchestra/shared";
import type { Logger } from "@orchestra/observability";
import type { TaskQueue } from "@orchestra/event-bus";
import type { AgentRegistry } from "@orchestra/agents";
import type { WorkflowExecutor } from "@orchestra/workflow-engine";

export interface ServerDeps {
  config: AppConfig;
  logger: Logger;
  store: WorkflowStore;
  queue: TaskQueue;
  registry: AgentRegistry;
  executor: WorkflowExecutor;
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

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 1_048_576
  });
  await app.register(cors, { origin: true });

  // Auth: bearer token on everything except /health. Phase 1 mechanism
  // (ADR-006); JWT/OIDC lands in Phase 8.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.method === "OPTIONS") return;
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
