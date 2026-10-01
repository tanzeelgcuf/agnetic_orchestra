import type {
  ClaudeCodeExecutor,
  ExecutorSession,
  ExecutorTask,
  TaskResult
} from "./executor";

/** Deterministic executor for tests and pipeline validation. */
export class NoopExecutor implements ClaudeCodeExecutor {
  async createSession(opts: { workspaceDir?: string; repoUrl?: string }): Promise<ExecutorSession> {
    return { id: "noop-session", workspaceDir: opts.workspaceDir, repoUrl: opts.repoUrl };
  }

  async executeTask(session: ExecutorSession, task: ExecutorTask): Promise<TaskResult> {
    return {
      status: "success",
      summary: "Noop executor completed task",
      output: `ack: ${task.prompt.slice(0, 80)} (session ${session.id})`
    };
  }

  async closeSession(_session: ExecutorSession): Promise<void> {}
}

export * from "./executor";
export * from "./cli-executor";
