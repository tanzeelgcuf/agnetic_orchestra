export interface Run {
  id: string;
  definition: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface StageRun {
  id: string;
  stageId: string;
  agent: string;
  kind: string;
  status: string;
  attempts: number;
  error: string | null;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stageId: string;
  decision: "pending" | "approved" | "rejected";
  approvedBy: string | null;
}

export interface WorkflowEvent {
  type: string;
  stageId?: string;
  createdAt: string;
  data?: unknown;
}

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  capabilities: string[];
  permissions: Record<string, string[]>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const listWorkflows = () => api<{ runs: Run[] }>("/workflows");

export const getWorkflow = (id: string) =>
  api<{ run: Run; stages: StageRun[]; approvals: ApprovalRecord[] }>(`/workflows/${id}`);

export const getEvents = (id: string) => api<{ events: WorkflowEvent[] }>(`/workflows/${id}/events`);

export const getAgents = () => api<{ agents: AgentInfo[] }>("/agents");

export const decideApproval = (
  id: string,
  body: { stageId: string; decision: "approved" | "rejected"; approvedBy: string }
) =>
  api<{ ok: boolean }>(`/workflows/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(body)
  });

export const cancelWorkflow = (id: string) =>
  api<{ ok: boolean }>(`/workflows/${id}/cancel`, { method: "POST" });
