import { spawnSync } from "node:child_process";
import type { Tool } from "@orchestra/agents";
import type { GitHubAdapter, GitHubRepositoryRef } from "./github";

/**
 * The diff under review, for review agents. Two modes:
 * - PR mode: repo {owner,name} + number → via GitHubAdapter (Octokit diff)
 * - Local branch mode: repo_path + head_branch (+ optional base_branch)
 *   → `git -C <repo> diff <base>...<head>`
 */
export function createDiffTool(opts: { github?: GitHubAdapter }): Tool {
  return {
    name: "repo.get_diff",
    description: "Get the diff of the changes under review (PR mode or local branch mode)",
    execute: async (input) => {
      const { repo, number, repo_path, base_branch, head_branch } = input as {
        repo?: unknown;
        number?: unknown;
        repo_path?: unknown;
        base_branch?: unknown;
        head_branch?: unknown;
      };

      if (isRepoRef(repo) && typeof number === "number" && opts.github) {
        try {
          return { diff: await opts.github.getPullRequestDiff({ ...repo, number }) };
        } catch (e) {
          return { diff: "", error: e instanceof Error ? e.message : String(e) };
        }
      }

      if (typeof repo_path === "string" && typeof head_branch === "string") {
        const base = typeof base_branch === "string" ? base_branch : "main";
        const res = spawnSync("git", ["-C", repo_path, "diff", `${base}...${head_branch}`], {
          encoding: "utf8"
        });
        if (res.status !== 0 || res.error) {
          return {
            diff: "",
            error: res.stderr?.trim() || res.error?.message || `git diff ${base}...${head_branch} failed`
          };
        }
        return { diff: res.stdout };
      }

      return {
        diff: "",
        error: "repo.get_diff requires pr (repo + number) or repo_path + head_branch"
      };
    }
  };
}

function isRepoRef(value: unknown): value is GitHubRepositoryRef {
  if (!value || typeof value !== "object") return false;
  const repo = value as { owner?: unknown; name?: unknown };
  return typeof repo.owner === "string" && typeof repo.name === "string";
}
