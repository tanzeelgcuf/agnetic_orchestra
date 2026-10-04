import type { AgentResult, Finding, PermissionSet } from "@orchestra/shared";
import type { Agent, AgentContext, ValidationResult } from "./contract";
import type { PolicyEngine } from "./policy";
import { dedupeFindings } from "./review-agents";

export interface GateCheck {
  domain: string;
  stageId: string;
  review: string;
  findingsCount: number;
}

export interface QualityGateOutput {
  status: "PASS" | "FAIL" | "BLOCKED";
  checks: Record<string, string>;
  blocking_findings: Finding[];
  human_approval_required: boolean;
}

interface ReviewDependencyShape {
  findings?: unknown;
  metadata?: { review?: unknown; findingsCount?: unknown } & Record<string, unknown>;
}

/**
 * Quality Gate Agent (master prompt §20): deterministic aggregation of the
 * review stages' findings, per-check statuses, CI status, and coverage. An
 * LLM never runs here and never overrides a failed mandatory check — the
 * policy engine decides blocking mechanically.
 *
 * Outcomes:
 * - PASS (no findings, no CI failure) → pipeline continues to human approval
 * - BLOCKED (policy-blocking findings, e.g. a critical security finding) →
 *   the run blocks; humans investigate
 * - FAIL (non-blocking findings need addressing) → agent failure; a stage
 *   with rework_to re-runs the development subtree with the findings (§49)
 */
export class QualityGateAgent implements Agent {
  readonly id = "quality-gate-agent";
  readonly name = "Quality Gate";
  readonly version = "1.0.0";
  readonly description =
    "Deterministically aggregates review findings, CI status, and coverage into a gate decision.";

  constructor(private readonly policy: PolicyEngine) {}

  capabilities(): readonly string[] {
    return ["quality.gate"];
  }

  permissions(): PermissionSet {
    return {};
  }

  validate(_input: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const dependencies = (ctx.input.dependencies ?? {}) as Record<string, unknown>;

    const findings: Finding[] = [];
    const checks: Record<string, string> = {};

    // Live shape: the reviews barrier aggregates its members' outputs.
    const barrier = dependencies["reviews"] as
      | { findings?: unknown; members?: Record<string, ReviewDependencyShape> }
      | undefined;
    if (barrier && typeof barrier === "object") {
      for (const [memberStageId, output] of Object.entries(barrier.members ?? {})) {
        const domain = memberStageId.replace("reviews:", "").replace("-review-agent", "");
        checks[domain] =
          typeof output?.metadata?.review === "string" ? output.metadata.review : "UNKNOWN";
      }
      if (Array.isArray(barrier.findings)) {
        for (const f of barrier.findings) {
          if (isFinding(f)) findings.push(f);
        }
      }
    }

    // Direct-deps shape (each review stage as a direct dependency).
    for (const [stageId, raw] of Object.entries(dependencies)) {
      if (!stageId.startsWith("reviews:")) continue;
      const output = raw as ReviewDependencyShape | null;
      if (!output) continue;
      const review = typeof output.metadata?.review === "string" ? output.metadata.review : "UNKNOWN";
      const domain = stageId.slice("reviews:".length).replace("-review-agent", "");
      checks[domain] = review;
      if (Array.isArray(output.findings)) {
        for (const f of output.findings) {
          if (isFinding(f)) findings.push(f);
        }
      }
    }

    // Dedupe (the barrier repeats its members' findings).
    const uniqueFindings = dedupeFindings(findings);

    // CI status from the shared context (correlation plumbing: Phase 7).
    const ciStatus = firstString(ctx.input.ci_status, ctx.workflowContext.ci_status) ?? "not_run";
    checks.ci = ciStatus;
    if (ciStatus === "failure") {
      uniqueFindings.push({
        id: "quality-gate-ci-failure",
        source: this.id,
        domain: "code",
        severity: "critical",
        title: "CI failed",
        description: "The CI pipeline reported failure for this change; the gate cannot pass.",
        recommendation: "Fix the CI failure before merging."
      });
    }

    const decision = this.policy.evaluate(uniqueFindings);

    if (decision.action === "block") {
      const output: QualityGateOutput = {
        status: "BLOCKED",
        checks,
        blocking_findings: decision.blockingFindings,
        human_approval_required: true
      };
      return {
        status: "blocked",
        summary: `Quality gate BLOCKED — ${decision.blockingFindings.length} blocking finding(s)`,
        findings: decision.blockingFindings,
        metadata: { gate: output }
      };
    }

    if (uniqueFindings.length > 0) {
      const output: QualityGateOutput = {
        status: "FAIL",
        checks,
        blocking_findings: [],
        human_approval_required: true
      };
      return {
        status: "failed",
        summary: `Quality gate FAIL — ${uniqueFindings.length} finding(s) require addressing (rework)`,
        findings: uniqueFindings,
        metadata: { gate: output, rework: true }
      };
    }

    const output: QualityGateOutput = {
      status: "PASS",
      checks,
      blocking_findings: [],
      human_approval_required: true
    };
    return {
      status: "success",
      summary: "Quality gate PASS — all checks green",
      metadata: { gate: output }
    };
  }
}

function isFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const f = value as { severity?: unknown; title?: unknown; description?: unknown; source?: unknown };
  return (
    typeof f.severity === "string" &&
    typeof f.title === "string" &&
    typeof f.description === "string" &&
    typeof f.source === "string"
  );
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
