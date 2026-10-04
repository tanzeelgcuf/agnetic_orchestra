import { beforeAll, afterEach, afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createLogger } from "@orchestra/observability";
import { createDb, PgWorkflowStore } from "@orchestra/database";
import { PostgresQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  ArchitectureReviewAgent,
  CodeReviewAgent,
  DEFAULT_BLOCKING_RULES,
  DEFAULT_ENVIRONMENT_POLICIES,
  DeploymentAgent,
  DevelopmentAgent,
  MergeAgent,
  NoopAgent,
  PolicyEngine,
  QualityGateAgent,
  RequirementsAgent,
  SecurityReviewAgent,
  TestReviewAgent,
  ToolRegistry,
  VerificationAgent
} from "@orchestra/agents";
import {
  InMemoryGitHubAdapter,
  InMemoryJiraAdapter,
  registerGitHubTools,
  registerJiraTools
} from "@orchestra/integrations";
import { createDiffTool } from "@orchestra/integrations";
import { loadWorkflows, WorkflowExecutor } from "@orchestra/workflow-engine";
import { NoopExecutor } from "@orchestra/claude-code";
import { join } from "node:path";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://orchestra:orchestra@localhost:5433/orchestra";

let pgUp = false;
try {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  await probe.query("SELECT 1");
  await probe.end();
  pgUp = true;
} catch {
  pgUp = false;
}

const logger = createLogger({ service: "e2e", level: "silent" });

describe.skipIf(!pgUp)("orchestrated run against PostgreSQL", () => {
  let pool: Pool;
  let store: PgWorkflowStore;
  let queue: PostgresQueue;
  let executor: WorkflowExecutor;
  let repoDir: string;
  let github: InMemoryGitHubAdapter;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const { db } = createDb(DATABASE_URL);
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db, { migrationsFolder: join(process.cwd(), "packages/database/drizzle") });
    store = new PgWorkflowStore(db);
    queue = new PostgresQueue(DATABASE_URL);

    const registry = new AgentRegistry();
    registry.register(new RequirementsAgent()); // heuristic analysis (no LLM in tests)
    registry.register(new DevelopmentAgent({ executor: new NoopExecutor() }));
    const policy = new PolicyEngine(DEFAULT_BLOCKING_RULES);
    registry.register(new CodeReviewAgent({ policy }));
    registry.register(new SecurityReviewAgent({ policy }));
    registry.register(new ArchitectureReviewAgent({ policy }));
    registry.register(new TestReviewAgent({ policy }));
    registry.register(new QualityGateAgent(policy));

    // Delivery agents (Phase 7): the in-memory GitHub adapter backs the merge
    // (PR creation via the github tools + merge behind human approval), the
    // GitHub Actions dispatch, and the deployment records.
    github = new InMemoryGitHubAdapter();
    registry.register(new MergeAgent({ github, pollIntervalMs: 1 }));
    registry.register(
      new DeploymentAgent({ github, envPolicies: DEFAULT_ENVIRONMENT_POLICIES, pollIntervalMs: 1 })
    );
    registry.register(new VerificationAgent({ github }));

    registry.register(new NoopAgent());
    registry.register(new NoopAgent("noop-review-agent", "Noop Review Agent"));
    registry.register(new NoopAgent("noop-security-agent", "Noop Security Agent"));

    const tools = new ToolRegistry();
    const jira = new InMemoryJiraAdapter();
    jira.issues.set("PROJ-123", {
      key: "PROJ-123",
      summary: "Add password reset functionality",
      description: `Users must be able to reset their password from the login screen.

The system must email a time-limited reset link and must expire it after one use.
Given a valid reset link, when the user submits a new password, then access is updated.`,
      type: "Story",
      status: "todo"
    });
    registerJiraTools(tools, jira);
    registerGitHubTools(tools, github);

    // A real git repo with prepared branches so review agents have a diff.
    repoDir = mkdtempSync(join(tmpdir(), "orchestra-e2e-repo-"));
    tempDirs.push(repoDir);
    const git = (args: string) => execSync(args, { cwd: repoDir, stdio: "ignore" });
    git("git init -q -b main && git config user.email t@t && git config user.name t");
    writeFileSync(join(repoDir, "README.md"), "# e2e repo\n");
    git("git add . && git commit -q -m init");
    // Clean branch: a README-only change (no code findings).
    git("git checkout -q -b orchestra/e2e-clean");
    writeFileSync(join(repoDir, "README.md"), "# e2e repo\n\nUpdated usage.\n");
    git("git add . && git commit -q -m 'PROJ-123: update readme'");
    // Dirty branch: a hardcoded secret (security scanner must catch it).
    git("git checkout -q main && git checkout -q -b orchestra/e2e-dirty");
    writeFileSync(join(repoDir, "config.ts"), "export const SECRET = 'super-secret-value-123';\n");
    git("git add . && git commit -q -m 'PROJ-123: add config'");
    // Rework branch: an empty catch (code review NEEDS_CHANGES, non-blocking).
    git("git checkout -q main && git checkout -q -b orchestra/e2e-rework");
    writeFileSync(join(repoDir, "handler.ts"), "try { risky(); } catch (e) {}\n");
    git("git add . && git commit -q -m 'PROJ-123: add handler'");

    tools.register(createDiffTool({}));

    executor = new WorkflowExecutor({
      store,
      registry,
      tools,
      queue,
      policy,
      logger,
      definitions: loadWorkflows(join(process.cwd(), "workflows"), registry)
    });
  });

  afterEach(async () => {
    await pool.query(
      "TRUNCATE workflow_runs, stage_runs, workflow_events, approvals, queue_messages, audit_events"
    );
    github.reset();
  });

  afterAll(async () => {
    await pool.end();
    await queue.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  async function drainUntilParked(maxPasses = 200): Promise<void> {
    for (let i = 0; i < maxPasses; i++) {
      const messages = await queue.claim(10);
      if (messages.length === 0) return;
      for (const msg of messages) {
        await executor.handleQueueMessage(msg);
        await queue.complete(msg);
      }
    }
    throw new Error("drain exceeded max passes");
  }

  it("drives the software-delivery workflow through all three approval gates", async () => {
    const run = await executor.startRun("software-delivery", {
      issue_key: "PROJ-123",
      repo_path: repoDir,
      repo: { owner: "e2e", name: "repo" },
      branch: "orchestra/e2e-clean",
      base_branch: "main"
    });

    await drainUntilParked();

    // Parked at the requirements approval gate; the requirements agent ran.
    let current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const reqStage = await store.getStageRun(run.id, "requirements");
    expect(reqStage?.status).toBe("succeeded");
    expect(reqStage?.agent).toBe("requirements-agent");
    const reqApproval = await store.getApproval(run.id, "requirements-approval");
    expect(reqApproval?.decision).toBe("pending");

    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "requirements-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();

    // Parked at the human approval gate; reviews ran for real.
    current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const finalApproval = await store.getApproval(run.id, "human-approval");
    expect(finalApproval?.decision).toBe("pending");
    for (const stageId of [
      "reviews:code-review-agent",
      "reviews:security-review-agent",
      "reviews:architecture-review-agent",
      "reviews:test-review-agent"
    ]) {
      const stage = await store.getStageRun(run.id, stageId);
      expect(stage?.status).toBe("succeeded");
      expect(stage?.agentVersion).toBe("1.0.0");
    }

    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "human-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();

    // Parked at the production approval gate; the merge agent merged the PR
    // the development agent created.
    current = await store.getRun(run.id);
    expect(current?.status).toBe("running");
    const prodApproval = await store.getApproval(run.id, "production-approval");
    expect(prodApproval?.decision).toBe("pending");
    const mergeStage = await store.getStageRun(run.id, "merge");
    expect(mergeStage?.status).toBe("succeeded");
    const mergeMeta = (mergeStage?.output as { metadata?: { merged?: boolean; previousRef?: string } })?.metadata;
    expect(mergeMeta?.merged).toBe(true);
    expect(github.mergedBranches.map((m) => m.branch)).toContain("orchestra/e2e-clean");

    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "production-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();

    current = await store.getRun(run.id);
    expect(current?.status).toBe("succeeded");

    const stages = await store.listStageRuns(run.id);
    // Review stages are created concurrently; compare as a sorted set.
    expect(stages.map((s) => s.stageId).sort()).toEqual(
      [
        "requirements",
        "requirements-approval",
        "development",
        "reviews:code-review-agent",
        "reviews:security-review-agent",
        "reviews:architecture-review-agent",
        "reviews:test-review-agent",
        "reviews",
        "quality-gate",
        "human-approval",
        "merge",
        "production-approval",
        "deployment",
        "verification"
      ].sort()
    );
    expect(stages.every((s) => s.status === "succeeded")).toBe(true);

    const deployStage = await store.getStageRun(run.id, "deployment");
    const deployMeta = (deployStage?.output as { metadata?: Record<string, unknown> })?.metadata;
    expect(deployMeta?.environment).toBe("production");
    expect(deployMeta?.rollback).toBe(false);
    // The in-memory adapter dispatched the deploy workflow and recorded it.
    expect(github.dispatchedWorkflows).toHaveLength(1);
    expect(github.deploymentStatuses.map((s) => s.state)).toEqual(["success"]);

    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.type).filter((t) => t === "approval.requested")).toHaveLength(3);
    expect(events.map((e) => e.type)).toContain("workflow.succeeded");
    expect(await queue.pendingCount()).toBe(0);
  });

  it("blocks the run when a review finds a policy-blocking vulnerability", async () => {
    const run = await executor.startRun("software-delivery", {
      issue_key: "PROJ-123",
      repo_path: repoDir,
      branch: "orchestra/e2e-dirty",
      base_branch: "main"
    });

    await drainUntilParked();

    // Approve requirements-approval to reach the reviews. On the dirty
    // branch the security review BLOCKS during the reviews stage — the run
    // is blocked before any pre-merge approval is ever requested.
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "requirements-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked();
    const current = await store.getRun(run.id);
    expect(current?.status).toBe("blocked");
    const securityStage = await store.getStageRun(run.id, "reviews:security-review-agent");
    expect(securityStage?.status).toBe("blocked");
    const events = await store.listEvents(run.id);
    expect(events.map((e) => e.type)).toContain("workflow.blocked");
    // Merge and deployment never ran.
    expect(await store.getStageRun(run.id, "merge")).toBeNull();
  });

  it("reworks through the quality gate until the rework budget is exhausted", async () => {
    const run = await executor.startRun("software-delivery", {
      issue_key: "PROJ-123",
      repo_path: repoDir,
      branch: "orchestra/e2e-rework",
      base_branch: "main"
    });

    // Approve requirements-approval to reach the gate. The diff's empty catch
    // makes the code review NEEDS_CHANGES; the gate fails with rework; the
    // development subtree re-runs — twice (max_rework: 2) — then the budget
    // exhausts and the run fails (the reworked diff never changes).
    await drainUntilParked(500); // parks at requirements-approval
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "requirements-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked(500);

    const current = await store.getRun(run.id);
    expect(current?.status).toBe("failed");
    expect(current?.reworkCount).toBe(2);
    // The development stage re-ran after each rework (attempts reset by the rework).
    const events = await store.listEvents(run.id);
    const reworkEvents = events.filter(
      (e) => e.type === "stage.retried" && (e.data as { rework?: boolean })?.rework === true
    );
    expect(reworkEvents).toHaveLength(2);
    // Merge and deployment never ran.
    expect(await store.getStageRun(run.id, "merge")).toBeNull();
  });

  it("fails the run when the deploy workflow keeps failing", async () => {
    const run = await executor.startRun("software-delivery", {
      issue_key: "PROJ-123",
      repo_path: repoDir,
      repo: { owner: "e2e", name: "repo" },
      branch: "orchestra/e2e-clean",
      base_branch: "main"
    });

    // The deploy workflow fails on both attempts (max_attempts: 2).
    github.workflowConclusions.push("failure", "failure");

    await drainUntilParked(500); // parks at requirements-approval
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "requirements-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked(500); // parks at human-approval
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "human-approval",
      decision: "approved",
      approvedBy: "e2e"
    });
    await drainUntilParked(500); // parks at production-approval
    await queue.enqueue("approval.decision", {
      runId: run.id,
      stageId: "production-approval",
      decision: "approved",
      approvedBy: "e2e"
    });

    // The deploy retry is enqueued with backoff delay; keep draining until
    // the run fails.
    const deadline = Date.now() + 30_000;
    let current = await store.getRun(run.id);
    while (current?.status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await drainUntilParked(500);
      current = await store.getRun(run.id);
    }

    expect(current?.status).toBe("failed");
    const deployStage = await store.getStageRun(run.id, "deployment");
    expect(deployStage?.status).toBe("failed");
    // Verification never ran — the failed deployment failed the run.
    expect(await store.getStageRun(run.id, "verification")).toBeNull();
    expect(github.dispatchedWorkflows).toHaveLength(2);
  });

  it("recovers non-terminal runs on boot", async () => {
    const run = await executor.startRun("software-delivery", {});
    const recovered = await executor.recover();
    expect(recovered).toBeGreaterThanOrEqual(0);
    const messages = await queue.claim(10);
    expect(messages.some((m) => m.kind === "run.advance" && m.payload.runId === run.id)).toBe(true);
  });
});
