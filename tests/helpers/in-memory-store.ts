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

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

type RunRow = Run;
type StageRow = StageRun;
type ApprovalRow = ApprovalRecord;

/**
 * In-memory WorkflowStore for unit tests. Mirrors PgWorkflowStore semantics
 * (including non-terminal run listing and stale-stage reset) without Postgres.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  readonly runRows = new Map<string, RunRow>();
  readonly stageRows = new Map<string, StageRow>();
  readonly eventRows: (WorkflowEvent & { id: number })[] = [];
  readonly approvalRows = new Map<string, ApprovalRow>();
  readonly auditRows: { actor: string; action: string; resource: string; data?: unknown }[] = [];
  private eventCounter = 0;

  async createRun(input: { definition: string; context: Record<string, unknown> }): Promise<Run> {
    const now = new Date().toISOString();
    const run: RunRow = {
      id: id("run"),
      definition: input.definition,
      status: "pending",
      context: { ...input.context },
      createdAt: now,
      updatedAt: now
    };
    this.runRows.set(run.id, run);
    return { ...run };
  }

  async getRun(id_: string): Promise<Run | null> {
    const run = this.runRows.get(id_);
    return run ? { ...run } : null;
  }

  async listRuns(): Promise<Run[]> {
    return [...this.runRows.values()].map((r) => ({ ...r }));
  }

  async updateRunStatus(id_: string, status: RunStatus): Promise<void> {
    const run = this.runRows.get(id_);
    if (run) {
      run.status = status;
      run.updatedAt = new Date().toISOString();
    }
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
    const row: StageRow = {
      id: id("stage"),
      runId: input.runId,
      stageId: input.stageId,
      agent: input.agent,
      agentVersion: input.agentVersion,
      kind: input.kind,
      status: input.status,
      attempts: 0,
      input: input.input ? { ...input.input } : null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date().toISOString()
    };
    this.stageRows.set(row.id, row);
    return { ...row };
  }

  async getStageRun(runId: string, stageId: string): Promise<StageRun | null> {
    for (const row of this.stageRows.values()) {
      if (row.runId === runId && row.stageId === stageId) return { ...row };
    }
    return null;
  }

  async listStageRuns(runId: string): Promise<StageRun[]> {
    return [...this.stageRows.values()].filter((r) => r.runId === runId).map((r) => ({ ...r }));
  }

  async updateStageRun(
    id_: string,
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
    const row = this.stageRows.get(id_);
    if (!row) return;
    Object.assign(row, patch);
  }

  async resetStaleRunningStages(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let count = 0;
    for (const row of this.stageRows.values()) {
      if (row.status === "running" && new Date(row.createdAt).getTime() < cutoff) {
        row.status = "pending";
        row.error = "reset: stale running stage";
        count += 1;
      }
    }
    return count;
  }

  async appendEvent(
    event: Omit<WorkflowEvent, "createdAt"> & { createdAt?: string }
  ): Promise<void> {
    this.eventCounter += 1;
    this.eventRows.push({
      ...event,
      id: this.eventCounter,
      createdAt: event.createdAt ?? new Date().toISOString()
    });
  }

  async listEvents(runId: string): Promise<WorkflowEvent[]> {
    return this.eventRows
      .filter((e) => e.runId === runId)
      .map(({ id: _id, ...rest }) => ({ ...rest }));
  }

  async requestApproval(input: {
    runId: string;
    stageId: string;
    requestedBy?: string;
  }): Promise<ApprovalRecord> {
    const key = `${input.runId}:${input.stageId}`;
    const existing = this.approvalRows.get(key);
    if (existing) return { ...existing };
    const row: ApprovalRow = {
      id: id("approval"),
      runId: input.runId,
      stageId: input.stageId,
      decision: "pending",
      approvedBy: null,
      note: null,
      requestedAt: new Date().toISOString(),
      decidedAt: null
    };
    this.approvalRows.set(key, row);
    return { ...row };
  }

  async recordApprovalDecision(
    runId: string,
    stageId: string,
    decision: "approved" | "rejected",
    approvedBy: string,
    note?: string
  ): Promise<ApprovalRecord> {
    const key = `${runId}:${stageId}`;
    const row = this.approvalRows.get(key);
    if (!row) throw new Error(`no approval pending for run ${runId} stage ${stageId}`);
    row.decision = decision;
    row.approvedBy = approvedBy;
    row.note = note ?? null;
    row.decidedAt = new Date().toISOString();
    return { ...row };
  }

  async getApproval(runId: string, stageId: string): Promise<ApprovalRecord | null> {
    const row = this.approvalRows.get(`${runId}:${stageId}`);
    return row ? { ...row } : null;
  }

  async appendAudit(
    actor: string,
    action: string,
    resource: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    this.auditRows.push({ actor, action, resource, data });
  }

  async listNonTerminalRuns(): Promise<Run[]> {
    return [...this.runRows.values()]
      .filter((r) => !["succeeded", "failed", "blocked", "cancelled"].includes(r.status))
      .map((r) => ({ ...r }));
  }
}

/** In-memory double for the webhook delivery store (dedup by delivery id). */
export class InMemoryWebhookStore {
  readonly deliveries = new Map<string, { source: string; event: string; action?: string }>();

  async recordDelivery(input: {
    source: string;
    deliveryId: string;
    event: string;
    action?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ isNew: boolean }> {
    const key = `${input.source}:${input.deliveryId}`;
    if (this.deliveries.has(key)) return { isNew: false };
    this.deliveries.set(key, { source: input.source, event: input.event, action: input.action });
    return { isNew: true };
  }

  async hasDelivery(source: string, deliveryId: string): Promise<boolean> {
    return this.deliveries.has(`${source}:${deliveryId}`);
  }
}
