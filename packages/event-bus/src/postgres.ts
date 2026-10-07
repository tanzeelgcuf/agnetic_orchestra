import { Pool } from "pg";
import type { ClaimedMessage, QueueMessageKind } from "@orchestra/shared";
import type { TaskQueue } from "./queue";

interface Row {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/**
 * PostgreSQL-backed queue. Claims use SELECT ... FOR UPDATE SKIP LOCKED so
 * concurrent workers never grab the same message; failed messages requeue with
 * backoff up to maxAttempts, then move to the dead-letter state.
 *
 * Requires the `queue_messages` table (packages/database migrations).
 */
export class PostgresQueue implements TaskQueue {
  private readonly pool: Pool;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly jitterMs: number;

  constructor(
    databaseUrl: string,
    config?: { maxAttempts?: number; baseBackoffMs?: number; jitterMs?: number },
    pool?: Pool
  ) {
    const effectiveConfig = {
      maxAttempts: config?.maxAttempts ?? 5,
      baseBackoffMs: config?.baseBackoffMs ?? 1_000,
      jitterMs: config?.jitterMs ?? 200
    };
    this.maxAttempts = effectiveConfig.maxAttempts;
    this.baseBackoffMs = effectiveConfig.baseBackoffMs;
    this.jitterMs = effectiveConfig.jitterMs;
    this.pool = pool ?? new Pool({ connectionString: databaseUrl });
  }

  async enqueue(
    kind: QueueMessageKind,
    payload: Record<string, unknown>,
    delayMs = 0
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO queue_messages (kind, payload, available_at)
       VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)`,
      [kind, JSON.stringify(payload), String(delayMs)]
    );
  }

  async claim(batchSize: number, visibilityTimeoutMs = 300_000): Promise<ClaimedMessage[]> {
    const result = await this.pool.query<Row>(
      `UPDATE queue_messages
       SET status = 'processing',
           attempts = attempts + 1,
           available_at = now() + ($2 || ' milliseconds')::interval
       WHERE id IN (
         SELECT id FROM queue_messages
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, kind, payload, attempts, max_attempts`,
      [batchSize, String(visibilityTimeoutMs)]
    );
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind as QueueMessageKind,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts)
    }));
  }

  async complete(msg: ClaimedMessage): Promise<void> {
    await this.pool.query(
      "UPDATE queue_messages SET status = 'completed' WHERE id = $1 AND status = 'processing'",
      [msg.id]
    );
  }

  async fail(msg: ClaimedMessage, error: unknown, _rawBackoffMs?: number): Promise<"retry" | "dead"> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = msg.attempts + 1;

    // Calculate backoff: BASE * 2^(attempts-1) + jitter
    const baseBackoff = this.baseBackoffMs * 2 ** (attempts - 1);
    const jitter = Math.floor(Math.random() * (2 * this.jitterMs + 1)) - this.jitterMs;
    const backoffMs = baseBackoff + jitter;

    if (attempts >= this.maxAttempts) {
      await this.pool.query(
        "UPDATE queue_messages SET status = 'dead', last_error = $2 WHERE id = $1",
        [msg.id, message]
      );
      return "dead";
    }
    await this.pool.query(
      `UPDATE queue_messages
       SET status = 'pending',
           available_at = now() + ($2 || ' milliseconds')::interval,
           last_error = $3
       WHERE id = $1`,
      [msg.id, String(backoffMs), message]
    );
    return "retry";
  }

  async recover(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE queue_messages
       SET status = 'pending'
       WHERE status = 'processing' AND available_at <= now()`,
      []
    );
    return result.rowCount ?? 0;
  }

  async pendingCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM queue_messages WHERE status = 'pending'",
      []
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  /** DLQ replay (Phase 8): requeue dead messages back to pending. */
  async replayDead(limit = 100): Promise<number> {
    const result = await this.pool.query(
      `UPDATE queue_messages
       SET status = 'pending',
           attempts = 0,
           available_at = now(),
           last_error = NULL
       WHERE id IN (
         SELECT id FROM queue_messages
         WHERE status = 'dead'
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )`,
      [limit]
    );
    return result.rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
