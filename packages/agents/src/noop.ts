import type { AgentResult, PermissionSet } from "@orchestra/shared";
import type { Agent, AgentContext, ValidationResult } from "./contract";

/**
 * Minimal agent used to validate the orchestration pipeline end-to-end
 * (Phase 1). Real agents (requirements, development, reviews) replace it in
 * later phases. Instantiate with a distinct id to place multiple noop stages
 * in one workflow.
 */
export class NoopAgent implements Agent {
  readonly id: string;
  readonly name: string;
  readonly version = "1.0.0";
  readonly description = "Pipeline-validation agent; succeeds immediately.";

  constructor(id = "noop-agent", name = "Noop Agent") {
    this.id = id;
    this.name = name;
  }

  capabilities(): readonly string[] {
    return ["echo"];
  }

  permissions(): PermissionSet {
    return {};
  }

  validate(_input: Record<string, unknown>): ValidationResult {
    return { ok: true, errors: [] };
  }

  async execute(ctx: AgentContext): Promise<AgentResult> {
    ctx.logger.info(
      { runId: ctx.runId, stageId: ctx.stageId, agent: this.id },
      "noop agent executed"
    );
    return {
      status: "success",
      summary: "Noop agent completed stage",
      metadata: { input: ctx.input }
    };
  }
}
