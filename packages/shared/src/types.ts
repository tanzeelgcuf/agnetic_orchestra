export type AgentStatus = "success" | "failed" | "blocked" | "needs_human";

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  id: string;
  severity: Severity;
  /** Agent id or deterministic tool name that produced the finding. */
  source: string;
  /** Policy domain for blocking rules, e.g. "security", "code", "tests". */
  domain?: string;
  file?: string;
  line?: number;
  title: string;
  description: string;
  recommendation?: string;
}

export interface AgentArtifact {
  name: string;
  kind: string;
  content: unknown;
}

export interface AgentResult {
  status: AgentStatus;
  summary: string;
  findings?: Finding[];
  artifacts?: AgentArtifact[];
  metadata?: Record<string, unknown>;
}

/**
 * Tool names are namespaced `${resource}.${action}`, e.g. `jira.read_issue`,
 * `github.create_pull_request`. Permission sets allow resources explicitly.
 */
export type ToolName = string;

export interface PermissionSet {
  [resource: string]: readonly string[];
}

export type RunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type StageStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "awaiting_approval"
  | "skipped";

export type StageKind = "agent" | "approval";

export type QueueMessageKind = "run.advance" | "approval.decision";

export interface QueueMessage {
  id: string;
  kind: QueueMessageKind;
  payload: Record<string, unknown>;
}

export interface ClaimedMessage extends QueueMessage {
  attempts: number;
  maxAttempts: number;
}

export type WorkflowEventType =
  | "workflow.created"
  | "workflow.started"
  | "workflow.succeeded"
  | "workflow.failed"
  | "workflow.cancelled"
  | "workflow.blocked"
  | "stage.started"
  | "stage.succeeded"
  | "stage.failed"
  | "stage.retried"
  | "stage.awaiting_approval"
  | "approval.requested"
  | "approval.granted"
  | "approval.rejected"
  | "stage.skipped";

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  stageId?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}
