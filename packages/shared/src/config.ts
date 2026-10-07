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
  /** HS256 secret for JWT auth (Phase 8). When set, the API accepts JWTs
   * signed with this secret in addition to the static bearer token. */
  jwtSecret: z.string().optional(),
  port: z.coerce.number().int().positive().default(4100),
  workerPollIntervalMs: z.coerce.number().int().positive().default(500),
  workerBatchSize: z.coerce.number().int().positive().default(5),
  /** Retry tuning (Phase 8): base backoff and jitter for stage retries. */
  retryBackoffBaseMs: z.coerce.number().int().positive().default(1_000),
  retryJitterMs: z.coerce.number().int().nonnegative().default(200),
  /** Queue max attempts before a message moves to the dead-letter state. */
  queueMaxAttempts: z.coerce.number().int().positive().default(5),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  logRedactPaths: z.array(z.string()).default(DEFAULT_REDACT_PATHS),
  jiraBaseUrl: z.string().url().optional(),
  jiraEmail: z.string().email().optional(),
  jiraApiToken: z.string().optional(),
  githubToken: z.string().optional(),
  /** HMAC-SHA256 secret for inbound GitHub webhooks. Unsigned requests are
   * accepted only when this is unset (local dev); always set in production. */
  githubWebhookSecret: z.string().optional(),
  /** Secret backend (Phase 8): "env" (default) or "vault". */
  secretBackend: z.enum(["env", "vault"]).default("env"),
  vaultAddr: z.string().url().optional(),
  vaultToken: z.string().optional(),
  /** GitHub webhook action → workflow definition name, as JSON, e.g.
   * {"pull_request.opened":"software-delivery"}. Empty by default. */
  webhookTriggers: z
    .preprocess((v) => {
      if (typeof v !== "string" || v.length === 0) return {};
      try {
        return JSON.parse(v);
      } catch {
        return {};
      }
    }, z.record(z.string()))
    .default({})
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
    logRedactPaths: env.LOG_REDACT_PATHS?.split(",").map((s) => s.trim()).filter(Boolean),
    jiraBaseUrl: env.JIRA_URL,
    jiraEmail: env.JIRA_EMAIL,
    jiraApiToken: env.JIRA_TOKEN,
    githubToken: env.GITHUB_TOKEN,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    webhookTriggers: env.WEBHOOK_TRIGGERS,
    retryBackoffBaseMs: env.RETRY_BACKOFF_BASE_MS,
    retryJitterMs: env.RETRY_JITTER_MS,
    queueMaxAttempts: env.QUEUE_MAX_ATTEMPTS,
    jwtSecret: env.ORCHESTRA_JWT_SECRET,
    secretBackend: env.ORCHESTRA_SECRET_BACKEND,
    vaultAddr: env.ORCHESTRA_VAULT_ADDR,
    vaultToken: env.ORCHESTRA_VAULT_TOKEN
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

