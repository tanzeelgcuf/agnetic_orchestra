import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "@orchestra/observability";
import type {
  ClaudeCodeExecutor,
  ExecutorSession,
  ExecutorTask,
  TaskResult
} from "./executor";

/**
 * Runs headless Claude Code (`claude -p`) against a local workspace.
 * Experimental Phase-4 preview: single-prompt execution with timeout and
 * output capture. The full development loop (branch/implement/test/PR) builds
 * on this in Phase 4.
 */
export class ClaudeCodeCliExecutor implements ClaudeCodeExecutor {
  constructor(private readonly logger: Logger) {}

  async createSession(opts: { workspaceDir?: string; repoUrl?: string }): Promise<ExecutorSession> {
    return { id: randomUUID(), workspaceDir: opts.workspaceDir, repoUrl: opts.repoUrl };
  }

  async executeTask(session: ExecutorSession, task: ExecutorTask): Promise<TaskResult> {
    const timeoutMs = task.timeoutMs ?? 600_000;
    const args = [
      "-p",
      task.prompt,
      "--output-format",
      "text",
      ...(task.allowedTools && task.allowedTools.length > 0
        ? ["--allowedTools", task.allowedTools.join(",")]
        : [])
    ];

    return await new Promise<TaskResult>((resolve) => {
      const child = spawn("claude", args, {
        cwd: session.workspaceDir,
        env: filteredEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({
          status: "timeout",
          summary: `claude -p timed out after ${timeoutMs}ms`,
          output: stdout
        });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.logger.warn({ err, sessionId: session.id }, "claude spawn failed");
        resolve({ status: "failed", summary: `claude spawn failed: ${err.message}` });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: code === 0 ? "success" : "failed",
          summary: code === 0 ? "claude -p completed" : `claude -p exited with code ${code}`,
          output: stdout || stderr,
          exitCode: code ?? undefined
        });
      });
    });
  }

  async closeSession(_session: ExecutorSession): Promise<void> {}
}

/**
 * Command execution security (master prompt §35): strip environment variables
 * that could leak credentials into the coding agent's subprocess.
 */
function filteredEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(AWS_|AZURE_|GOOGLE_|VAULT_|.*_TOKEN$|.*_SECRET$|.*_PASSWORD$|.*_KEY$)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}
