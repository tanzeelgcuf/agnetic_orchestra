import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeWorkspaceManager } from "@orchestra/claude-code";

describe("worktree workspace manager", () => {
  const cleanups: { repo: string; ws: string }[] = [];

  function makeRepo(): string {
    const repo = mkdtempSync(join(tmpdir(), "orchestra-repo-"));
    execSync(
      "git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init",
      { cwd: repo }
    );
    return repo;
  }

  afterEach(() => {
    for (const { repo, ws } of cleanups) {
      try {
        execSync(`git worktree remove --force "${ws}"`, { cwd: repo, stdio: "ignore" });
      } catch {
        // already removed by the manager
      }
    }
    cleanups.length = 0;
  });

  it("creates an isolated worktree on a new branch", () => {
    const repo = makeRepo();
    const manager = new WorktreeWorkspaceManager();
    const ws = manager.create(repo, "orchestra/test-1");
    cleanups.push({ repo, ws: ws.dir });

    expect(ws.branch).toBe("orchestra/test-1");
    const branch = execSync("git branch --show-current", { cwd: ws.dir, encoding: "utf8" }).trim();
    expect(branch).toBe("orchestra/test-1");
    // The main checkout is untouched.
    const mainBranch = execSync("git branch --show-current", { cwd: repo, encoding: "utf8" }).trim();
    expect(mainBranch).not.toBe("orchestra/test-1");
  });

  it("cleanup removes the worktree but keeps the branch", () => {
    const repo = makeRepo();
    const manager = new WorktreeWorkspaceManager();
    const ws = manager.create(repo, "orchestra/test-2");
    manager.cleanup(repo, ws);

    const branches = execSync("git branch --list orchestra/test-2", { cwd: repo, encoding: "utf8" });
    expect(branches).toContain("orchestra/test-2");
    const worktrees = execSync("git worktree list", { cwd: repo, encoding: "utf8" });
    expect(worktrees).not.toContain("orchestra-ws-");
  });

  it("fails when the branch already exists", () => {
    const repo = makeRepo();
    const manager = new WorktreeWorkspaceManager();
    manager.create(repo, "orchestra/test-3");
    expect(() => manager.create(repo, "orchestra/test-3")).toThrow(/worktree add failed/);
  });
});
