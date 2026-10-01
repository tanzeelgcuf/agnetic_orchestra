import { z } from "zod";

const DEFAULT_REDACT_PATHS = [
  "password",
  "token",
  "secret",
  "authorization",
  "apiKey"
];

const ConfigSchema = z.object({
  databaseUrl: z
    .string()
    .default("postgres://orchestra:orchestra@localhost:5433/orchestra"),
  apiToken: z.string().default("dev-token-change-me"),
  port: z.coerce.number().int().positive().default(4100),
  workerPollIntervalMs: z.coerce.number().int().positive().default(500),
  workerBatchSize: z.coerce.number().int().positive().default(5),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  logRedactPaths: z.array(z.string()).default(DEFAULT_REDACT_PATHS)
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    apiToken: env.ORCHESTRA_API_TOKEN,
    port: env.PORT,
    workerPollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    workerBatchSize: env.WORKER_BATCH_SIZE,
    logLevel: env.LOG_LEVEL,
    logRedactPaths: env.LOG_REDACT_PATHS?.split(",").map((s) => s.trim()).filter(Boolean)
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
