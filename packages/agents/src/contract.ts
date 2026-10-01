import type { AgentResult, PermissionSet } from "@orchestra/shared";
import type { Logger } from "@orchestra/observability";

export interface Tool {
  /** Namespaced `resource.action`, e.g. `jira.read_issue`, `github.create_pull_request`. */
  name: string;
  description: string;
  execute(input: unknown): Promise<unknown>;
}

/**
 * Everything an agent may touch is passed in explicitly. Agents never receive
 * raw infrastructure access — `tools` is already filtered by the agent's
 * permission set, and `workflowContext` is persisted shared state, never
 * conversational memory.
 */
export interface AgentContext {
  runId: string;
  stageId: string;
  agentId: string;
  input: Record<string, unknown>;
  workflowContext: Record<string, unknown>;
  tools: readonly Tool[];
  logger: Logger;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface Agent {
  id: string;
  name: string;
  version: string;
  description?: string;
  capabilities(): readonly string[];
  permissions(): PermissionSet;
  validate(input: Record<string, unknown>): ValidationResult;
  execute(ctx: AgentContext): Promise<AgentResult>;
}
