import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCKING_RULES, DEFAULT_ENVIRONMENT_POLICIES, PolicyEngine } from "@orchestra/agents";
import type { Finding } from "@orchestra/shared";

function finding(partial: Partial<Finding>): Finding {
  return {
    id: "f1",
    severity: "medium",
    source: "test",
    title: "test finding",
    description: "test",
    ...partial
  };
}

describe("policy engine", () => {
  it("blocks on a single critical security finding", () => {
    const engine = new PolicyEngine(DEFAULT_BLOCKING_RULES);
    const decision = engine.evaluate([
      finding({ severity: "critical", domain: "security", title: "SQL injection" }),
      finding({ severity: "low", domain: "code", title: "nit" })
    ]);
    expect(decision.action).toBe("block");
    expect(decision.blockingFindings).toHaveLength(1);
    expect(decision.blockingFindings[0]?.title).toBe("SQL injection");
  });

  it("blocks on high-severity security findings", () => {
    const engine = new PolicyEngine(DEFAULT_BLOCKING_RULES);
    const decision = engine.evaluate([finding({ severity: "high", domain: "security" })]);
    expect(decision.action).toBe("block");
  });

  it("ignores severities without configured rules", () => {
    const engine = new PolicyEngine(DEFAULT_BLOCKING_RULES);
    const decision = engine.evaluate([finding({ severity: "low", domain: "code" })]);
    expect(decision.action).toBe("ignore");
    expect(decision.blockingFindings).toHaveLength(0);
  });

  it("defaults findings without a domain to the code domain", () => {
    const engine = new PolicyEngine(DEFAULT_BLOCKING_RULES);
    const decision = engine.evaluate([finding({ severity: "critical" })]);
    expect(decision.action).toBe("block");
  });

  it("supports custom per-repository rules", () => {
    const engine = new PolicyEngine({
      code: { high: "block", medium: "warn" }
    });
    const decision = engine.evaluate([
      finding({ severity: "high", domain: "code" }),
      finding({ severity: "medium", domain: "code" })
    ]);
    expect(decision.action).toBe("block");
    expect(decision.blockingFindings).toHaveLength(1);

    const warnOnly = engine.evaluate([finding({ severity: "medium", domain: "code" })]);
    expect(warnOnly.action).toBe("warn");
    expect(warnOnly.blockingFindings).toHaveLength(0);
  });
});

describe("environment policies", () => {
  it("requires approval for production", () => {
    expect(DEFAULT_ENVIRONMENT_POLICIES.production?.requiresApproval).toBe(true);
  });

  it("does not require approval for staging", () => {
    expect(DEFAULT_ENVIRONMENT_POLICIES.staging?.requiresApproval).toBe(false);
  });

  it("defines blocking rules for each environment", () => {
    expect(DEFAULT_ENVIRONMENT_POLICIES.production?.blockingRules).toEqual(DEFAULT_BLOCKING_RULES);
    expect(DEFAULT_ENVIRONMENT_POLICIES.staging?.blockingRules).toEqual({
      security: { critical: "block" }
    });
  });
});
