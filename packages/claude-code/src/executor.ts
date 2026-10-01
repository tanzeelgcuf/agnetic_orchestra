/**
 * Claude Code as a controlled execution worker. The orchestration engine
 * depends on this abstraction only — Claude Code is an implementation provider
 * (replaceable with another coding agent), not the orchestration system.
 *
 * See docs/architecture/overview.md. Phase 4 ships the full development loop;
 * the CLI executor below already runs headless single-prompt tasks.
 */
export interface ExecutorSession {
  id: string;
  workspaceDir?: string;
  repoUrl?: string;
}

export interface ExecutorTask {
  /** Instruction for the coding agent. Treated as untrusted-adjacent input: */
  prompt: string;
  allowedTools?: string[];
  timeoutMs?: number;
}

export interface TaskResult {
  status: "success" | "failed" | "timeout";
  summary: string;
  output?: string;
  exitCode?: number;
}

export interface ClaudeCodeExecutor {
  createSession(opts: { workspaceDir?: string; repoUrl?: string }): Promise<ExecutorSession>;
  executeTask(session: ExecutorSession, task: ExecutorTask): Promise<TaskResult>;
  closeSession(session: ExecutorSession): Promise<void>;
}
