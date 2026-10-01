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

    await Promise.all(
      messages.map(async (msg) => {
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
