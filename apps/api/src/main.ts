import { fileURLToPath } from "node:url";
import { loadConfig } from "@orchestra/shared";
import { createLogger } from "@orchestra/observability";
import { createDb, PgWebhookStore, PgWorkflowStore } from "@orchestra/database";
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
import { WorkflowTriggerHandler } from "./webhooks";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    service: "api",
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

  const app = await buildServer({
    config,
    logger,
    store,
    queue,
    registry,
    executor,
    webhooks: new PgWebhookStore(db),
    webhookHandlers: [
      new WorkflowTriggerHandler(
        (definition, context) => executor.startRun(definition, context),
        config.webhookTriggers
      )
    ]
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "shutting down");
      app
        .close()
        .then(() => pool.end())
        .then(() => queue.close?.())
        .then(() => process.exit(0))
        .catch((err) => {
          logger.error({ err }, "shutdown error");
          process.exit(1);
        });
    });
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info({ port: config.port }, "api listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
