import type {
  RunStatus,
  StageStatus,
  StageKind,
  WorkflowEvent
} from "./types";

export interface Run {
  id: string;
  definition: string;
  status: RunStatus;
  context: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StageRun {
  id: string;
  runId: string;
  stageId: string;
  agent: string;
  agentVersion: string;
  kind: StageKind;
  status: StageStatus;
  attempts: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stageId: string;
  decision: "pending" | "approved" | "rejected";
  approvedBy: string | null;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/**
 * Durable workflow state. Implemented by packages/database (PostgreSQL);
 * the workflow engine depends on this interface only.
 */
export interface WorkflowStore {
  createRun(input: {
    definition: string;
    context: Record<string, unknown>;
  }): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  listRuns(): Promise<Run[]>;
  updateRunStatus(id: string, status: RunStatus): Promise<void>;

  createStageRun(input: {
    runId: string;
    stageId: string;
    agent: string;
    agentVersion: string;
    kind: StageKind;
    status: StageStatus;
    input?: Record<string, unknown>;
  }): Promise<StageRun>;
  getStageRun(runId: string, stageId: string): Promise<StageRun | null>;
  listStageRuns(runId: string): Promise<StageRun[]>;
  updateStageRun(
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
  ): Promise<void>;
  /** Reset stage_runs stuck in `running` (crashed worker) back to `pending`. */
  resetStaleRunningStages(olderThanMs: number): Promise<number>;

  appendEvent(event: Omit<WorkflowEvent, "createdAt"> & { createdAt?: string }): Promise<void>;
  listEvents(runId: string): Promise<WorkflowEvent[]>;

  requestApproval(input: {
    runId: string;
    stageId: string;
    requestedBy?: string;
  }): Promise<ApprovalRecord>;
  recordApprovalDecision(
    runId: string,
    stageId: string,
    decision: "approved" | "rejected",
    approvedBy: string,
    note?: string
  ): Promise<ApprovalRecord>;
  getApproval(runId: string, stageId: string): Promise<ApprovalRecord | null>;

  appendAudit(
    actor: string,
    action: string,
    resource: string,
    data?: Record<string, unknown>
  ): Promise<void>;

  listNonTerminalRuns(): Promise<Run[]>;
}
