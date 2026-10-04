import { describe, expect, it } from "vitest";
import { CiCorrelationHandler } from "../../apps/api/src/webhooks";
import { InMemoryWorkflowStore } from "../helpers/in-memory-store";

function handler(store: InMemoryWorkflowStore): CiCorrelationHandler {
  return new CiCorrelationHandler(store);
}

function webhookContext(event: Record<string, unknown>) {
  return { event, deliveryId: "d1", raw: {} };
}

async function seedRun(store: InMemoryWorkflowStore, context: Record<string, unknown>): Promise<string> {
  await store.createRun({ definitionName: "software-delivery", context });
  const runs = await store.listNonTerminalRuns();
  return runs[0]?.id ?? "";
}

describe("ci correlation handler", () => {
  it("records ci_status from a workflow_run conclusion into the matching run", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { branch: "feature" });

    await handler(store).handle(
      webhookContext({ kind: "workflow_run", branch: "feature", conclusion: "success" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBe("success");
  });

  it("records ci_status for a failure conclusion", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { branch: "feature" });

    await handler(store).handle(
      webhookContext({ kind: "workflow_run", branch: "feature", conclusion: "failure" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBe("failure");
  });

  it("matches by head sha when the branch is absent", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { head_sha: "abc123" });

    await handler(store).handle(
      webhookContext({ kind: "workflow_run", headSha: "abc123", conclusion: "success" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBe("success");
  });

  it("ignores runs for a different branch", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { branch: "other" });

    await handler(store).handle(
      webhookContext({ kind: "workflow_run", branch: "feature", conclusion: "failure" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBeUndefined();
  });

  it("uses the deployment action when no conclusion is present", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { branch: "feature" });

    await handler(store).handle(
      webhookContext({ kind: "deployment_status", branch: "feature", action: "success" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBe("success");
  });

  it("ignores pull_request and push events", async () => {
    const store = new InMemoryWorkflowStore();
    const runId = await seedRun(store, { branch: "feature" });

    await handler(store).handle(
      webhookContext({ kind: "pull_request", branch: "feature", conclusion: "failure" })
    );

    const run = await store.getRun(runId);
    expect((run?.context as Record<string, unknown>).ci_status).toBeUndefined();
  });
});
