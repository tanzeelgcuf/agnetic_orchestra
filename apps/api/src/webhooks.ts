import type { GitHubWebhookContext, GitHubWebhookHandler } from "@orchestra/integrations";
import type { WorkflowStore } from "@orchestra/shared";

/**
 * Starts configured workflows in reaction to GitHub webhook events. Triggers
 * map an event kind/action (e.g. "pull_request.opened") or bare kind
 * (e.g. "push") to a workflow definition name; empty by default.
 */
export class WorkflowTriggerHandler implements GitHubWebhookHandler {
  readonly name = "workflow-trigger";

  constructor(
    private readonly startRun: (
      definition: string,
      context: Record<string, unknown>
    ) => Promise<unknown>,
    private readonly triggers: Record<string, string>
  ) {}

  async handle({ event }: GitHubWebhookContext): Promise<void> {
    if (event.kind === "unknown") return;
    const definition =
      (event.action ? this.triggers[`${event.kind}.${event.action}`] : undefined) ??
      this.triggers[event.kind];
    if (!definition) return;
    await this.startRun(definition, { github: event });
  }
}

/**
 * CI correlation (Phase 7): records the CI status carried by
 * workflow_run/deployment_status events into the run context of open runs
 * for the same branch or head sha. The quality gate reads `ci_status` from
 * the run context; delivery data only — never instructions.
 */
export class CiCorrelationHandler implements GitHubWebhookHandler {
  readonly name = "ci-correlation";

  constructor(private readonly store: WorkflowStore) {}

  async handle({ event }: GitHubWebhookContext): Promise<void> {
    if (event.kind !== "workflow_run" && event.kind !== "deployment_status") return;
    const status = event.conclusion ?? event.action;
    if (!status) return;
    if (!event.branch && !event.headSha) return;

    const runs = await this.store.listNonTerminalRuns();
    for (const run of runs) {
      const context = run.context as Record<string, unknown>;
      const branchMatch = typeof context.branch === "string" && context.branch === event.branch;
      const shaMatch = typeof context.head_sha === "string" && context.head_sha === event.headSha;
      if (branchMatch || shaMatch) {
        await this.store.updateRunContext(run.id, { ci_status: status });
      }
    }
  }
}
