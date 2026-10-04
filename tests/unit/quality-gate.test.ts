import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { DEFAULT_BLOCKING_RULES, PolicyEngine, QualityGateAgent } from "@orchestra/agents";
import type { AgentContext, Finding } from "@orchestra/agents";

const logger = createLogger({ service: "test", level: "silent" });

function finding(partial: Partial<Finding>): Finding {
  return {
    id: "f",
    severity: "medium",
    source: "code-review-agent",
    domain: "code",
    title: "Finding",
    description: "d",
    ...partial
  };
}

function reviewDep(findings: Finding[], review: string) {
  return { findings, metadata: { review, findingsCount: findings.length } };
}

function makeContext(
  dependencies: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): AgentContext {
  return {
    runId: "run-gate",
    stageId: "quality-gate",
    agentId: "quality-gate-agent",
    input: { dependencies, ...extra },
    workflowContext: {},
    tools: [],
    logger
  };
}

const PASS_DEPS = {
  "reviews:code-review-agent": reviewDep([], "PASS"),
  "reviews:security-review-agent": reviewDep([], "PASS"),
  "reviews:architecture-review-agent": reviewDep([], "PASS"),
  "reviews:test-review-agent": reviewDep([], "PASS")
};

describe("quality gate agent", () => {
  it("passes when all checks are green and no findings exist", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const result = await agent.execute(makeContext(PASS_DEPS));

    expect(result.status).toBe("success");
    const gate = result.metadata as { gate: { status: string; checks: Record<string, string>; human_approval_required: boolean } };
    expect(gate.gate.status).toBe("PASS");
    expect(gate.gate.checks.code).toBe("PASS");
    expect(gate.gate.checks.security).toBe("PASS");
    expect(gate.gate.checks.ci).toBe("not_run");
    expect(gate.gate.human_approval_required).toBe(true);
  });

  it("blocks on a single critical security finding regardless of other passes", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const deps = {
      ...PASS_DEPS,
      "reviews:security-review-agent": reviewDep(
        [finding({ id: "s1", severity: "critical", domain: "security", title: "SQL injection" })],
        "FAIL"
      )
    };
    const result = await agent.execute(makeContext(deps));

    expect(result.status).toBe("blocked");
    const gate = result.metadata as { gate: { status: string; blocking_findings: Finding[] } };
    expect(gate.gate.status).toBe("BLOCKED");
    expect(gate.gate.blocking_findings).toHaveLength(1);
  });

  it("fails with rework on non-blocking findings", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const deps = {
      ...PASS_DEPS,
      "reviews:code-review-agent": reviewDep(
        [finding({ id: "c1", severity: "medium", title: "Empty catch block" })],
        "NEEDS_CHANGES"
      )
    };
    const result = await agent.execute(makeContext(deps));

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("rework");
    const gate = result.metadata as { gate: { status: string; blocking_findings: unknown[] }; rework: boolean };
    expect(gate.gate.status).toBe("FAIL");
    expect(gate.gate.blocking_findings).toHaveLength(0);
    expect(gate.rework).toBe(true);
  });

  it("blocks when CI failed", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const result = await agent.execute(makeContext(PASS_DEPS, { ci_status: "failure" }));

    expect(result.status).toBe("blocked");
    expect(result.findings?.some((f) => f.title === "CI failed")).toBe(true);
  });

  it("ignores non-review dependencies", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const deps = {
      ...PASS_DEPS,
      requirements: { summary: "not a review", findings: [finding({ id: "x", severity: "critical" })] }
    };
    const result = await agent.execute(makeContext(deps));
    expect(result.status).toBe("success");
  });

  it("tolerates missing or malformed review outputs", async () => {
    const agent = new QualityGateAgent(new PolicyEngine(DEFAULT_BLOCKING_RULES));
    const deps = {
      "reviews:code-review-agent": null,
      "reviews:security-review-agent": { metadata: {} }
    };
    const result = await agent.execute(makeContext(deps));
    expect(result.status).toBe("success");
  });
});
