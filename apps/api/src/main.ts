import { fileURLToPath } from "node:url";
import { loadConfig } from "@orchestra/shared";
import { createLogger } from "@orchestra/observability";
import { createDb, PgWorkflowStore } from "@orchestra/database";
import { PostgresQueue } from "@orchestra/event-bus";
import {
  AgentRegistry,
  DEFAULT_BLOCKING_RULES,
  NoopAgent,
  PolicyEngine,
  ToolRegistry
} from "@orchestra/agents";
import { loadWorkflows, WorkflowExecutor } from "@orchestra/workflow-engine";
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
  registry.register(new NoopAgent());
  registry.register(new NoopAgent("noop-review-agent", "Noop Review Agent"));
  registry.register(new NoopAgent("noop-security-agent", "Noop Security Agent"));
  const tools = new ToolRegistry();
  const policy = new PolicyEngine(DEFAULT_BLOCKING_RULES);

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

  const app = await buildServer({ config, logger, store, queue, registry, executor });

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
