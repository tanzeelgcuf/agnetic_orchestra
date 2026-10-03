import { and, asc, eq, lt, notInArray } from "drizzle-orm";
import type { OrchestraDb } from "./client";
import {
  approvals,
  auditEvents,
  stageRuns,
  workflowEvents,
  workflowRuns
} from "./schema";
import type {
  ApprovalRecord,
  Run,
  RunStatus,
  StageKind,
  StageRun,
  StageStatus,
  WorkflowEvent,
  WorkflowStore
} from "@orchestra/shared";

const TERMINAL_RUN_STATUSES: RunStatus[] = ["succeeded", "failed", "blocked", "cancelled"];

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function toRun(row: typeof workflowRuns.$inferSelect): Run {
  return {
    id: row.id,
    definition: row.definition,
    status: row.status as RunStatus,
    context: (row.context ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toStageRun(row: typeof stageRuns.$inferSelect): StageRun {
  return {
    id: row.id,
    runId: row.runId,
    stageId: row.stageId,
    agent: row.agent,
    agentVersion: row.agentVersion,
    kind: row.kind as StageKind,
    status: row.status as StageStatus,
    attempts: row.attempts,
    input: (row.input ?? null) as Record<string, unknown> | null,
    output: (row.output ?? null) as Record<string, unknown> | null,
    error: row.error,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    createdAt: row.createdAt.toISOString()
  };
}

function toApproval(row: typeof approvals.$inferSelect): ApprovalRecord {
  return {
    id: row.id,
    runId: row.runId,
    stageId: row.stageId,
    decision: row.decision as ApprovalRecord["decision"],
    approvedBy: row.approvedBy,
    note: row.note,
    requestedAt: row.requestedAt.toISOString(),
    decidedAt: iso(row.decidedAt)
  };
}

export class PgWorkflowStore implements WorkflowStore {
  constructor(private readonly db: OrchestraDb) {}

  async createRun(input: {
    definition: string;
    context: Record<string, unknown>;
  }): Promise<Run> {
    const [row] = await this.db
      .insert(workflowRuns)
      .values({ definition: input.definition, context: input.context })
      .returning();
    if (!row) throw new Error("insert workflow_runs returned no row");
    return toRun(row);
  }

  async getRun(id: string): Promise<Run | null> {
    const [row] = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
    return row ? toRun(row) : null;
  }

  async listRuns(): Promise<Run[]> {
    const rows = await this.db.select().from(workflowRuns).orderBy(asc(workflowRuns.createdAt));
    return rows.map(toRun);
  }

  async updateRunStatus(id: string, status: RunStatus): Promise<void> {
    await this.db
      .update(workflowRuns)
      .set({ status, updatedAt: new Date() })
      .where(eq(workflowRuns.id, id));
  }

  async createStageRun(input: {
    runId: string;
    stageId: string;
    agent: string;
    agentVersion: string;
    kind: StageKind;
    status: StageStatus;
    input?: Record<string, unknown>;
  }): Promise<StageRun> {
    // Idempotent under concurrent engine advances for the same run: on a
    // (run_id, stage_id) conflict, return the existing row.
    const [row] = await this.db
      .insert(stageRuns)
      .values({
        runId: input.runId,
        stageId: input.stageId,
        agent: input.agent,
        agentVersion: input.agentVersion,
        kind: input.kind,
        status: input.status,
        input: input.input ?? null
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toStageRun(row);
    const existing = await this.getStageRun(input.runId, input.stageId);
    if (!existing) throw new Error("insert stage_runs conflicted but no row exists");
    return existing;
  }

  async getStageRun(runId: string, stageId: string): Promise<StageRun | null> {
    const [row] = await this.db
      .select()
      .from(stageRuns)
      .where(and(eq(stageRuns.runId, runId), eq(stageRuns.stageId, stageId)))
      .limit(1);
    return row ? toStageRun(row) : null;
  }

  async listStageRuns(runId: string): Promise<StageRun[]> {
    const rows = await this.db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.runId, runId))
      .orderBy(asc(stageRuns.createdAt));
    return rows.map(toStageRun);
  }

  async updateStageRun(
    id: string,
    patch: {
      status?: StageStatus;
      attempts?: number;
      input?: Record<string, unknown> | null;
      output?: Record<string, unknown>;
      error?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      agentVersion?: string;
    }
  ): Promise<void> {
    await this.db
      .update(stageRuns)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
        ...(patch.input !== undefined ? { input: patch.input } : {}),
        ...(patch.output !== undefined ? { output: patch.output } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt ? new Date(patch.startedAt) : null } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : null } : {}),
        ...(patch.agentVersion !== undefined ? { agentVersion: patch.agentVersion } : {})
      })
      .where(eq(stageRuns.id, id));
  }

  async resetStaleRunningStages(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.db
      .update(stageRuns)
      .set({ status: "pending", error: "reset: stale running stage (crashed worker?)" })
      .where(and(eq(stageRuns.status, "running"), lt(stageRuns.createdAt, cutoff)))
      .returning({ id: stageRuns.id });
    return rows.length;
  }

  async appendEvent(
    event: Omit<WorkflowEvent, "createdAt"> & { createdAt?: string }
  ): Promise<void> {
    await this.db.insert(workflowEvents).values({
      runId: event.runId,
      stageId: event.stageId ?? null,
      type: event.type,
      data: event.data ?? null
    });
  }

  async listEvents(runId: string): Promise<WorkflowEvent[]> {
    const rows = await this.db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, runId))
      .orderBy(asc(workflowEvents.id));
    return rows.map((row) => ({
      type: row.type as WorkflowEvent["type"],
      runId: row.runId,
      stageId: row.stageId ?? undefined,
      data: (row.data ?? undefined) as Record<string, unknown> | undefined,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async requestApproval(input: {
    runId: string;
    stageId: string;
    requestedBy?: string;
  }): Promise<ApprovalRecord> {
    const existing = await this.getApproval(input.runId, input.stageId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(approvals)
      .values({ runId: input.runId, stageId: input.stageId })
      .returning();
    if (!row) throw new Error("insert approvals returned no row");
    return toApproval(row);
  }

  async recordApprovalDecision(
    runId: string,
    stageId: string,
    decision: "approved" | "rejected",
    approvedBy: string,
    note?: string
  ): Promise<ApprovalRecord> {
    const [row] = await this.db
      .update(approvals)
      .set({ decision, approvedBy, note: note ?? null, decidedAt: new Date() })
      .where(and(eq(approvals.runId, runId), eq(approvals.stageId, stageId)))
      .returning();
    if (!row) throw new Error(`no approval pending for run ${runId} stage ${stageId}`);
    return toApproval(row);
  }

  async getApproval(runId: string, stageId: string): Promise<ApprovalRecord | null> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.stageId, stageId)))
      .limit(1);
    return row ? toApproval(row) : null;
  }

  async appendAudit(
    actor: string,
    action: string,
    resource: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    await this.db
      .insert(auditEvents)
      .values({ actor, action, resource, data: data ?? null });
  }

  async listNonTerminalRuns(): Promise<Run[]> {
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(notInArray(workflowRuns.status, TERMINAL_RUN_STATUSES));
    return rows.map(toRun);
  }
}
