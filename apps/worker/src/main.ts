import { fileURLToPath } from "node:url";
import { loadConfig } from "@orchestra/shared";
import { createLogger } from "@orchestra/observability";
import { createDb, PgWorkflowStore } from "@orchestra/database";
import { PostgresQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  AnthropicLlmClient,
  DEFAULT_BLOCKING_RULES,
  DevelopmentAgent,
  NoopAgent,
  PolicyEngine,
  RequirementsAgent,
  ToolRegistry
} from "@orchestra/agents";
import { JiraRestAdapter, OctokitGitHubAdapter, registerGitHubTools, registerJiraTools } from "@orchestra/integrations";
import { loadWorkflows, WorkflowExecutor } from "@orchestra/workflow-engine";
import { ClaudeCodeCliExecutor, NoopExecutor } from "@orchestra/claude-code";
import { Octokit } from "@octokit/rest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: "worker",
    level: config.logLevel,
    redactPaths: config.logRedactPaths
  });

  const { db, pool } = createDb(config.databaseUrl);
  const store = new PgWorkflowStore(db);
  const queue = new PostgresQueue(config.databaseUrl);

  const registry = new AgentRegistry();
  const tools = new ToolRegistry();
  const policy = new PolicyEngine(DEFAULT_BLOCKING_RULES);

  if (config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken) {
    const jira = new JiraRestAdapter(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken);
    registerJiraTools(tools, jira);
    logger.info("jira tools registered (REST adapter)");
  } else {
    logger.info(
      "jira not configured (JIRA_URL/JIRA_EMAIL/JIRA_TOKEN unset) — jira tools unavailable"
    );
  }

  const llm = process.env.ANTHROPIC_API_KEY ? new AnthropicLlmClient() : undefined;
  registry.register(new RequirementsAgent(llm));

  const devExecutor =
    process.env.ORCHESTRA_DEV_EXECUTOR === "cli"
      ? new ClaudeCodeCliExecutor(logger)
      : new NoopExecutor();
  registry.register(new DevelopmentAgent({ executor: devExecutor }));

  if (config.githubToken) {
    const github = new OctokitGitHubAdapter(new Octokit({ auth: config.githubToken }));
    registerGitHubTools(tools, github);
    logger.info("github tools registered (Octokit adapter)");
  } else {
    logger.info("github not configured (GITHUB_TOKEN unset) — github tools unavailable");
  }

  registry.register(new NoopAgent());
  registry.register(new NoopAgent("noop-review-agent", "Noop Review Agent"));
  registry.register(new NoopAgent("noop-security-agent", "Noop Security Agent"));

  const definitions = loadWorkflows(
    fileURLToPath(new URL("../../../workflows", import.meta.url)),
    registry
  );
  const executor = new WorkflowExecutor({
    store,
    registry,
    tools,
    queue,
    policy,
    logger,
    definitions
  });

  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "worker shutting down");
      running = false;
    });
  }

  logger.info("worker starting; running crash-recovery pass");
  await executor.recover();

  while (running) {
    const messages = await queue.claim(config.workerBatchSize);
    if (messages.length === 0) {
      await sleep(config.workerPollIntervalMs);
      continue;
    }

    // Group by run before dispatching (see the per-run serialization below).
    const byRun = new Map<string, typeof messages>();
    for (const msg of messages) {
      const key = String(msg.payload.runId ?? msg.id);
      const group = byRun.get(key) ?? [];
      group.push(msg);
      byRun.set(key, group);
    }

    await Promise.all(
      [...byRun.values()].map(async (group) => {
        // Serialize messages for the SAME run: concurrent engine advances for
        // one run would race on stage creation. Different runs stay parallel.
        for (const msg of group) {
          try {
            await executor.handleQueueMessage(msg);
            await queue.complete(msg);
          } catch (err) {
            logger.error({ err, messageId: msg.id, kind: msg.kind, attempts: msg.attempts }, "message failed");
            const backoffMs = 1_000 * 2 ** (msg.attempts - 1);
            const outcome = await queue.fail(msg, err, backoffMs);
            if (outcome === "dead") {
              logger.error({ messageId: msg.id, kind: msg.kind }, "message moved to dead-letter");
            }
          }
        }
      })
    );
  }

  logger.info("worker stopped");
  await pool.end();
  await queue.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
