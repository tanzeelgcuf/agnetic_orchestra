import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Workspace {
  dir: string;
  branch: string;
  baseRef: string;
}

/**
 * Deterministic git-worktree isolation for development agents (master prompt
 * §35): each development stage works in its own worktree of the target
 * repository, outside the repo's main checkout, with no shared uncommitted
 * state. The branch persists in the repository after cleanup.
 */
export class WorktreeWorkspaceManager {
  create(repoPath: string, branch: string, baseRef = "HEAD"): Workspace {
    const dir = mkdtempSync(join(tmpdir(), "orchestra-ws-"));
    const res = spawnSync("git", ["worktree", "add", dir, "-b", branch, baseRef], {
      cwd: repoPath,
      encoding: "utf8"
    });
    if (res.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`git worktree add failed for branch "${branch}": ${res.stderr.trim()}`);
    }
    return { dir, branch, baseRef };
  }

  cleanup(repoPath: string, workspace: Workspace): void {
    spawnSync("git", ["worktree", "remove", "--force", workspace.dir], {
      cwd: repoPath,
      encoding: "utf8"
    });
  }
}
