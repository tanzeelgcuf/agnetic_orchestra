import type { GitHubWebhookContext, GitHubWebhookHandler } from "@orchestra/integrations";

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
