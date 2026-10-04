import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding, Severity } from "@orchestra/shared";

/**
 * External deterministic security scanners (master prompt §7, Phase 6):
 * they feed the Security Review Agent — combined with builtin scans and LLM
 * reasoning, never replaced by either. Tools are availability-detected at
 * bootstrap; a missing binary simply means the scanner is skipped.
 */
export interface ExternalScanner {
  name: string;
  available(): boolean;
  scan(input: { diff?: string; repoPath?: string }): Promise<Finding[]>;
}

const SEVERITY_BY_GITLEAKS: Severity = "high";

export class GitleaksScanner implements ExternalScanner {
  readonly name = "gitleaks";

  available(): boolean {
    return which("gitleaks");
  }

  async scan(input: { diff?: string; repoPath?: string }): Promise<Finding[]> {
    if (input.repoPath) {
      const res = spawnSync(
        "gitleaks",
        ["detect", "--source", input.repoPath, "--report-format", "json", "--report-path", "-", "--exit-code", "0", "--redact"],
        { encoding: "utf8", timeout: 120_000 }
      );
      return parseGitleaks(res.stdout ?? "");
    }
    if (input.diff) {
      // Scan the diff text as a synthetic file.
      const dir = mkdtempSync(join(tmpdir(), "orchestra-scan-"));
      try {
        const file = join(dir, "diff.patch");
        writeFileSync(file, input.diff);
        const res = spawnSync(
          "gitleaks",
          ["detect", "--no-git", "--source", dir, "--report-format", "json", "--report-path", "-", "--exit-code", "0", "--redact"],
          { encoding: "utf8", timeout: 120_000 }
        );
        return parseGitleaks(res.stdout ?? "");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    return [];
  }
}

export class SemgrepScanner implements ExternalScanner {
  readonly name = "semgrep";

  available(): boolean {
    return which("semgrep");
  }

  async scan(input: { diff?: string; repoPath?: string }): Promise<Finding[]> {
    if (!input.repoPath) return [];
    const res = spawnSync("semgrep", ["--json", "--quiet", input.repoPath], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024
    });
    return parseSemgrep(res.stdout ?? "", this.name);
  }
}

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  Secret?: string;
}

function parseGitleaks(stdout: string): Finding[] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as GitleaksFinding[];
    return parsed.slice(0, 100).map((f, i) => ({
      id: `gitleaks-${i + 1}`,
      source: "gitleaks",
      domain: "security",
      severity: SEVERITY_BY_GITLEAKS,
      file: f.File,
      line: f.StartLine,
      title: `Secret detected: ${f.RuleID ?? "unknown rule"}`,
      description: f.Description ?? "A secret was detected by gitleaks.",
      recommendation: "Remove the secret, rotate it, and use a secret provider."
    }));
  } catch {
    return [];
  }
}

interface SemgrepResult {
  results?: {
    check_id?: string;
    extra?: { severity?: string; message?: string; lines?: string };
    path?: string;
    start?: { line?: number };
  }[];
}

function parseSemgrep(stdout: string, source: string): Finding[] {
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as SemgrepResult;
    return (parsed.results ?? []).slice(0, 200).map((r, i) => ({
      id: `${source}-${i + 1}`,
      source,
      domain: "security",
      severity: semgrepSeverity(r.extra?.severity),
      file: r.path,
      line: r.start?.line,
      title: `Semgrep: ${r.check_id ?? "unknown rule"}`,
      description: r.extra?.message ?? "Semgrep reported a match.",
      recommendation: "Address the finding per the rule's documentation."
    }));
  } catch {
    return [];
  }
}

function semgrepSeverity(value: string | undefined): Severity {
  switch (value) {
    case "ERROR":
      return "critical";
    case "WARNING":
      return "high";
    default:
      return "medium";
  }
}

function which(binary: string): boolean {
  const res = spawnSync("which", [binary], { encoding: "utf8" });
  return res.status === 0;
}
