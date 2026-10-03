import type {
  ClaimedMessage,
  Finding,
  Run,
  StageRun,
  WorkflowStore
} from "@orchestra/shared";
import { NotFoundError } from "@orchestra/shared";
import type { Logger } from "@orchestra/observability";
import type {
  Agent,
  AgentContext,
  AgentRegistry,
  PolicyEngine,
  ToolRegistry
} from "@orchestra/agents";
import type { TaskQueue } from "@orchestra/event-bus";
import type { StageDefinition, WorkflowDefinition } from "./definition";

const BACKOFF_BASE_MS = 1_000;
/** Stage runs stuck in `running` longer than this are assumed crashed. */
const STALE_STAGE_MS = 10 * 60_000;

export interface EngineDeps {
  store: WorkflowStore;
  registry: AgentRegistry;
  tools: ToolRegistry;
  queue: TaskQueue;
  policy: PolicyEngine;
  logger: Logger;
  /** Workflow definitions by name, loaded from YAML. */
  definitions: Record<string, WorkflowDefinition>;
}

export class WorkflowExecutor {
  constructor(private readonly deps: EngineDeps) {}

  async startRun(
    definitionName: string,
    context: Record<string, unknown>
  ): Promise<Run> {
    const def = this.deps.definitions[definitionName];
    if (!def) throw new NotFoundError("workflow definition", definitionName);
    const run = await this.deps.store.createRun({ definition: definitionName, context });
    await this.deps.store.appendEvent({ type: "workflow.created", runId: run.id });
    await this.deps.queue.enqueue("run.advance", { runId: run.id });
    this.deps.logger.info({ runId: run.id, definition: definitionName }, "workflow created");
    return run;
  }

  /** Requeue non-terminal runs and reset stages stuck in `running` (crash recovery). */
  async recover(): Promise<number> {
    const staleStages = await this.deps.store.resetStaleRunningStages(STALE_STAGE_MS);
    const recoveredMessages = await this.deps.queue.recover();
    const runs = await this.deps.store.listNonTerminalRuns();
    for (const run of runs) {
      await this.deps.queue.enqueue("run.advance", { runId: run.id });
      // Also re-arm scheduled retries whose delayed message may have been lost.
      const stages = await this.deps.store.listStageRuns(run.id);
      for (const stage of stages) {
        if (stage.status === "pending" && stage.attempts > 0) {
          await this.deps.queue.enqueue("run.advance", { runId: run.id, retryStage: stage.stageId });
        }
      }
    }
    if (staleStages > 0 || recoveredMessages > 0 || runs.length > 0) {
      this.deps.logger.info(
        { staleStages, recoveredMessages, resumedRuns: runs.length },
        "engine recovery pass"
      );
    }
    return staleStages + recoveredMessages;
  }

  async handleQueueMessage(msg: ClaimedMessage): Promise<void> {
    switch (msg.kind) {
      case "run.advance":
        await this.advance(
          String(msg.payload.runId),
          typeof msg.payload.retryStage === "string" ? msg.payload.retryStage : undefined
        );
        return;
      case "approval.decision":
        await this.applyApprovalDecision(msg.payload);
        return;
    }
  }

  /**
   * Advance a workflow run: create + execute every stage whose dependencies are
   * satisfied. Progress re-enqueues the next advance; when nothing can progress
   * (parked on approval, blocked, or failed) the method returns and the run
   * waits for an external event. Bounded by stage count and per-stage attempts.
   */
  async advance(runId: string, retryStageId?: string): Promise<void> {
    const { store, definitions } = this.deps;
    const run = await store.getRun(runId);
    if (!run) throw new NotFoundError("workflow run", runId);
    if (run.status === "succeeded" || run.status === "failed" || run.status === "blocked" || run.status === "cancelled") {
      return;
    }
    const def = definitions[run.definition];
    if (!def) {
      await this.failRun(run, `unknown workflow definition "${run.definition}"`);
      return;
    }

    const stageRuns = await store.listStageRuns(runId);
    const byStageId = new Map(stageRuns.map((s) => [s.stageId, s]));

    // Ready = stages whose dependencies are satisfied. An existing stage is
    // re-picked only when this advance is its scheduled retry, or when it was
    // created but never started (crash between create and run). Retries
    // otherwise wait for their own delayed message so backoff is honored.
    const ready = def.stages.filter((stage) => {
      const existing = byStageId.get(stage.id);
      if (existing) {
        return (
          stage.id === retryStageId ||
          (existing.status === "pending" && existing.attempts === 0)
        );
      }
      return stage.depends_on.every((dep) => {
        const depRun = byStageId.get(dep);
        return depRun !== undefined && (depRun.status === "succeeded" || depRun.status === "skipped");
      });
    });

    if (ready.length === 0) {
      // Complete only when every stage reached a terminal-success state. A
      // stage in `pending` (retry scheduled) or `failed`/`blocked`/`awaiting`
      // means the run must keep waiting.
      const allTerminal = def.stages.every((stage) => {
        const stageRun = byStageId.get(stage.id);
        return (
          stageRun !== undefined &&
          (stageRun.status === "succeeded" || stageRun.status === "skipped")
        );
      });
      if (allTerminal) {
        await store.updateRunStatus(runId, "succeeded");
        await store.appendEvent({ type: "workflow.succeeded", runId });
        this.deps.logger.info({ runId }, "workflow succeeded");
      }
      return;
    }

    if (run.status !== "running") {
      await store.updateRunStatus(runId, "running");
      await store.appendEvent({ type: "workflow.started", runId });
    }

    const approvalsReady = ready.filter((s) => s.type === "approval");
    const agentsReady = ready.filter((s) => s.type === "agent");
    const barriersReady = ready.filter((s) => s.type === "barrier");

    if (approvalsReady.length > 0) {
      // Park the run on the first approval stage; humans decide through the API.
      for (const stage of approvalsReady) {
        await this.parkForApproval(run, stage);
      }
      return;
    }

    // Barriers complete instantly (their deps are satisfied by definition).
    for (const stage of barriersReady) {
      await store.createStageRun({
        runId: run.id,
        stageId: stage.id,
        agent: "(barrier)",
        agentVersion: "-",
        kind: "agent",
        status: "succeeded"
      });
      await store.appendEvent({
        type: "stage.succeeded",
        runId: run.id,
        stageId: stage.id,
        data: { barrier: true }
      });
    }

    if (agentsReady.length > 0) {
      // Independent agent stages in the same pass run concurrently.
      await Promise.all(agentsReady.map((stage) => this.runAgentStage(run, stage)));
    }

    // Progress was made — continue the pipeline.
    await this.deps.queue.enqueue("run.advance", { runId });
  }

  private async parkForApproval(run: Run, stage: StageDefinition): Promise<void> {
    const { store } = this.deps;
    const existingApproval = await store.getApproval(run.id, stage.id);
    if (existingApproval && existingApproval.decision === "pending") {
      // Already parked; do not duplicate events.
      return;
    }
    const existingStage = await store.getStageRun(run.id, stage.id);
    if (existingStage) {
      await store.updateStageRun(existingStage.id, { status: "awaiting_approval" });
    } else {
      await store.createStageRun({
        runId: run.id,
        stageId: stage.id,
        agent: stage.agent ?? "(human)",
        agentVersion: "-",
        kind: "approval",
        status: "awaiting_approval"
      });
    }
    const approval = await store.requestApproval({ runId: run.id, stageId: stage.id });
    await store.appendEvent({
      type: "approval.requested",
      runId: run.id,
      stageId: stage.id,
      data: { approvalId: approval.id }
    });
    await store.appendAudit("system", "approval.requested", `workflow_run/${run.id}`, {
      stageId: stage.id
    });
    this.deps.logger.info({ runId: run.id, stageId: stage.id }, "approval requested");
  }

  private async runAgentStage(run: Run, stage: StageDefinition): Promise<void> {
    const { store, registry, tools, logger } = this.deps;
    let stageRun = await store.getStageRun(run.id, stage.id);
    if (!stageRun) {
      stageRun = await store.createStageRun({
        runId: run.id,
        stageId: stage.id,
        agent: stage.agent ?? "unknown",
        agentVersion: "-",
        kind: "agent",
        status: "pending",
        input: stage.input
      });
    }

    let agent: Agent;
    try {
      agent = registry.get(stage.agent ?? "");
    } catch (e) {
      await this.handleStageFailure(run, stage, stageRun, e);
      return;
    }

    const depRuns = await store.listStageRuns(run.id);
    const depOutputs: Record<string, unknown> = {};
    for (const dep of stage.depends_on) {
      const depRun = depRuns.find((s) => s.stageId === dep);
      if (depRun) depOutputs[dep] = depRun.output ?? { status: depRun.status };
    }

    // Context propagation: workflow context flattened with static stage input
    // (stage input wins), plus dependency outputs. Validation sees exactly
    // what the agent will execute with (§15, §16).
    const stageInput = { ...run.context, ...stage.input, dependencies: depOutputs };
    const validation = agent.validate(stageInput);
    if (!validation.ok) {
      await this.handleStageFailure(
        run,
        stage,
        stageRun,
        new Error(`stage input validation failed: ${validation.errors.join("; ")}`)
      );
      return;
    }

    const attempt = stageRun.attempts + 1;
    await store.updateStageRun(stageRun.id, {
      status: "running",
      attempts: attempt,
      startedAt: new Date().toISOString(),
      error: null,
      agentVersion: agent.version,
      // Persist exactly what the agent will receive (auditability).
      input: stageInput
    });
    await store.appendEvent({
      type: "stage.started",
      runId: run.id,
      stageId: stage.id,
      data: { agent: agent.id, attempt }
    });

    const ctx: AgentContext = {
      runId: run.id,
      stageId: stage.id,
      agentId: agent.id,
      input: stageInput,
      workflowContext: run.context,
      tools: tools.forPermissions(agent.permissions()),
      logger
    };

    const startedAt = Date.now();
    try {
      const result = await this.withTimeout(
        agent.execute(ctx),
        stage.timeout_ms,
        `stage "${stage.id}"`
      );
      const durationMs = Date.now() - startedAt;

      if (result.status === "success") {
        await store.updateStageRun(stageRun.id, {
          status: "succeeded",
          output: {
            summary: result.summary,
            metadata: result.metadata ?? null,
            artifacts: result.artifacts ?? []
          },
          finishedAt: new Date().toISOString()
        });
        await store.appendEvent({
          type: "stage.succeeded",
          runId: run.id,
          stageId: stage.id,
          data: { agent: agent.id, attempt, durationMs }
        });
        logger.info({ runId: run.id, stageId: stage.id, agent: agent.id, durationMs }, "stage succeeded");
        return;
      }

      if (result.status === "needs_human") {
        await store.updateStageRun(stageRun.id, {
          status: "awaiting_approval",
          output: { summary: result.summary, metadata: result.metadata ?? null },
          finishedAt: new Date().toISOString()
        });
        const approval = await store.requestApproval({ runId: run.id, stageId: stage.id });
        await store.appendEvent({
          type: "approval.requested",
          runId: run.id,
          stageId: stage.id,
          data: { approvalId: approval.id, reason: result.summary }
        });
        return;
      }

      if (result.status === "blocked") {
        await store.updateStageRun(stageRun.id, {
          status: "blocked",
          error: result.summary,
          finishedAt: new Date().toISOString()
        });
        await store.appendEvent({
          type: "stage.failed",
          runId: run.id,
          stageId: stage.id,
          data: { agent: agent.id, blocked: true, reason: result.summary }
        });
        await store.updateRunStatus(run.id, "blocked");
        await store.appendEvent({
          type: "workflow.blocked",
          runId: run.id,
          stageId: stage.id,
          data: { reason: result.summary }
        });
        return;
      }

      // status === "failed"
      await this.handleStageFailure(
        run,
        stage,
        stageRun,
        new Error(result.summary || "agent reported failure"),
        { findings: result.findings ?? [] }
      );
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      logger.warn(
        { runId: run.id, stageId: stage.id, agent: agent.id, durationMs, err: e },
        "stage execution threw"
      );
      await this.handleStageFailure(run, stage, stageRun, e);
    }
  }

  private async handleStageFailure(
    run: Run,
    stage: StageDefinition,
    stageRun: StageRun,
    error: unknown,
    extra?: { findings?: Finding[] }
  ): Promise<void> {
    const { store, queue, logger } = this.deps;
    const message = error instanceof Error ? error.message : String(error);
    // Persist the attempt increment here so every failure path (agent throw,
    // agent-reported failure, input validation) counts against max_attempts.
    const attempts = stageRun.attempts + 1;
    await store.updateStageRun(stageRun.id, { attempts });

    if (attempts < stage.max_attempts) {
      const backoffMs = BACKOFF_BASE_MS * 2 ** (attempts - 1);
      await store.updateStageRun(stageRun.id, { status: "pending", error: message });
      await store.appendEvent({
        type: "stage.retried",
        runId: run.id,
        stageId: stage.id,
        data: { attempts, backoffMs, error: message }
      });
      // The retry travels on its own delayed message so the backoff is
      // honored; progression advances skip stages in pending-retry state.
      await queue.enqueue("run.advance", { runId: run.id, retryStage: stage.id }, backoffMs);
      logger.warn({ runId: run.id, stageId: stage.id, attempts, backoffMs, error: message }, "stage retry scheduled");
      return;
    }

    await store.updateStageRun(stageRun.id, {
      status: "failed",
      error: message,
      finishedAt: new Date().toISOString()
    });
    await store.appendEvent({
      type: "stage.failed",
      runId: run.id,
      stageId: stage.id,
      data: { attempts, error: message }
    });
    await store.updateRunStatus(run.id, "failed");
    await store.appendEvent({
      type: "workflow.failed",
      runId: run.id,
      stageId: stage.id,
      data: { reason: message, findings: extra?.findings ?? [] }
    });
    logger.error({ runId: run.id, stageId: stage.id, attempts, error: message }, "workflow failed");
  }

  private async failRun(run: Run, reason: string): Promise<void> {
    await this.deps.store.updateRunStatus(run.id, "failed");
    await this.deps.store.appendEvent({
      type: "workflow.failed",
      runId: run.id,
      data: { reason }
    });
    this.deps.logger.error({ runId: run.id, reason }, "workflow failed");
  }

  private async applyApprovalDecision(payload: Record<string, unknown>): Promise<void> {
    const { store, queue } = this.deps;
    const runId = String(payload.runId);
    const stageId = String(payload.stageId);
    const decision = payload.decision === "approved" ? "approved" : "rejected";
    const approvedBy = String(payload.approvedBy ?? "unknown");

    const record = await store.recordApprovalDecision(
      runId,
      stageId,
      decision,
      approvedBy,
      typeof payload.note === "string" ? payload.note : undefined
    );
    await store.appendAudit(approvedBy, `approval.${decision}`, `workflow_run/${runId}`, {
      stageId,
      approvalId: record.id
    });

    const stageRun = await store.getStageRun(runId, stageId);

    if (decision === "approved") {
      await store.appendEvent({
        type: "approval.granted",
        runId,
        stageId,
        data: { approvedBy, approvalId: record.id }
      });
      if (stageRun) {
        await store.updateStageRun(stageRun.id, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          output: { summary: `approved by ${approvedBy}`, metadata: { approvedBy } }
        });
      }
      await queue.enqueue("run.advance", { runId });
      this.deps.logger.info({ runId, stageId, approvedBy }, "approval granted");
    } else {
      await store.appendEvent({
        type: "approval.rejected",
        runId,
        stageId,
        data: { approvedBy, approvalId: record.id, note: record.note ?? undefined }
      });
      if (stageRun) {
        await store.updateStageRun(stageRun.id, {
          status: "failed",
          error: `approval rejected by ${approvedBy}`,
          finishedAt: new Date().toISOString()
        });
      }
      await store.updateRunStatus(runId, "failed");
      await store.appendEvent({
        type: "workflow.failed",
        runId,
        stageId,
        data: { reason: `approval rejected by ${approvedBy}` }
      });
      this.deps.logger.warn({ runId, stageId, approvedBy }, "approval rejected");
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
}
