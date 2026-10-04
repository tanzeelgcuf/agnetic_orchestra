import type { Finding } from "@orchestra/shared";

export type PolicyAction = "block" | "retry" | "warn" | "ignore";

/** domain → severity → action. Configurable per repository/project. */
export type BlockingRules = Record<string, Partial<Record<string, PolicyAction>>>;

export const DEFAULT_BLOCKING_RULES: BlockingRules = {
  security: { critical: "block", high: "block" },
  code: { critical: "block" },
  architecture: { critical: "block" },
  tests: { critical: "block" }
};

export interface EnvironmentPolicy {
  requiresApproval: boolean;
  blockingRules: BlockingRules;
}

/** Per-environment deployment policies (Phase 7). Enforcement of the
 * production gate stays the static approval stage in the workflow; this is
 * the canonical, unit-testable mapping. Configurable per project. */
export const DEFAULT_ENVIRONMENT_POLICIES: Record<string, EnvironmentPolicy> = {
  production: { requiresApproval: true, blockingRules: DEFAULT_BLOCKING_RULES },
  staging: { requiresApproval: false, blockingRules: { security: { critical: "block" } } }
};

const ACTION_RANK: readonly PolicyAction[] = ["ignore", "warn", "retry", "block"];

export interface PolicyDecision {
  action: PolicyAction;
  blockingFindings: Finding[];
}

/**
 * Deterministic policy evaluation. A single critical security finding blocks,
 * regardless of how many passing checks exist. An LLM never overrides these
 * rules — they are evaluated mechanically over findings.
 */
export class PolicyEngine {
  constructor(private readonly rules: BlockingRules = DEFAULT_BLOCKING_RULES) {}

  evaluate(findings: readonly Finding[]): PolicyDecision {
    const blockingFindings: Finding[] = [];
    let action: PolicyAction = "ignore";

    for (const finding of findings) {
      const domain = finding.domain ?? "code";
      const severityAction = this.rules[domain]?.[finding.severity];
      if (!severityAction) continue;
      if (severityAction === "block") blockingFindings.push(finding);
      if (ACTION_RANK.indexOf(severityAction) > ACTION_RANK.indexOf(action)) {
        action = severityAction;
      }
    }

    return { action, blockingFindings };
  }
}
