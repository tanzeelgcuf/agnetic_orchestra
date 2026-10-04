import { describe, expect, it } from "vitest";
import { createLogger } from "@orchestra/observability";
import { VerificationAgent } from "@orchestra/agents";
import { InMemoryGitHubAdapter } from "@orchestra/integrations";
import type { AgentContext } from "@orchestra/agents";

const logger = createLogger({ service: "test", level: "silent" });
const REPO = { owner: "acme", name: "app" };

const DEPLOY_META = { deploymentId: 1, deploymentStatus: "success", environment: "production" };

function makeContext(extra: Record<string, unknown> = {}): AgentContext {
  return {
    runId: "run-verify",
    stageId: "verification",
    agentId: "verification-agent",
    input: { repo: REPO, ...extra },
    workflowContext: {},
    tools: [],
    logger
  };
}

function depsWith(
  deps: { deployment?: unknown }
): Record<string, unknown> {
  return { dependencies: deps };
}

function deploymentOutput(metadata: unknown) {
  return { metadata };
}

describe("verification agent", () => {
  it("passes when the recorded deployment status is success", async () => {
    const github = new InMemoryGitHubAdapter();
    github.deploymentStatuses.push({ deploymentId: 1, state: "success" });
    const agent = new VerificationAgent({ github });
    const result = await agent.execute(makeContext(depsWith({ deployment: deploymentOutput(DEPLOY_META) })));

    expect(result.status).toBe("success");
    expect((result.metadata as { verified: boolean }).verified).toBe(true);
  });

  it("fails when the recorded deployment status is not success", async () => {
    const github = new InMemoryGitHubAdapter();
    github.deploymentStatuses.push({ deploymentId: 1, state: "failure" });
    const agent = new VerificationAgent({ github });
    const result = await agent.execute(makeContext(depsWith({ deployment: deploymentOutput(DEPLOY_META) })));

    expect(result.status).toBe("failed");
    expect(result.findings?.[0]?.domain).toBe("deployment");
    expect(result.findings?.[0]?.severity).toBe("high");
  });

  it("passes a green smoke test", async () => {
    const agent = new VerificationAgent({
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    });
    const result = await agent.execute(
      makeContext(
        { ...depsWith({ deployment: deploymentOutput(DEPLOY_META) }), smoke_url: "http://svc/health" }
      )
    );

    expect(result.status).toBe("success");
    expect((result.metadata as { verified: boolean }).verified).toBe(true);
  });

  it("fails a failing smoke test", async () => {
    const agent = new VerificationAgent({
      fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch
    });
    const result = await agent.execute(
      makeContext(
        { ...depsWith({ deployment: deploymentOutput(DEPLOY_META) }), smoke_url: "http://svc/health" }
      )
    );

    expect(result.status).toBe("failed");
    expect(result.findings?.[0]?.severity).toBe("high");
  });

  it("fails a smoke test that throws or times out", async () => {
    const agent = new VerificationAgent({
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
      smokeTimeoutMs: 10
    });
    const result = await agent.execute(
      makeContext(
        { ...depsWith({ deployment: deploymentOutput(DEPLOY_META) }), smoke_url: "http://svc/health" }
      )
    );

    expect(result.status).toBe("failed");
  });

  it("skips when there is no deployment output", async () => {
    const agent = new VerificationAgent({});
    const result = await agent.execute(makeContext(depsWith({})));

    expect(result.status).toBe("success");
    const meta = result.metadata as { skipped: boolean; reason: string };
    expect(meta.skipped).toBe(true);
    expect(meta.reason).toBe("no_deployment");
  });

  it("skips when the deployment was skipped", async () => {
    const agent = new VerificationAgent({});
    const result = await agent.execute(
      makeContext(depsWith({ deployment: deploymentOutput({ skipped: true, reason: "not_configured" }) }))
    );

    expect(result.status).toBe("success");
    expect((result.metadata as { skipped: boolean }).skipped).toBe(true);
  });
});
