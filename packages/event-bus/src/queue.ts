import type { ClaimedMessage, QueueMessage, QueueMessageKind } from "@orchestra/shared";

/**
 * Durable task queue abstraction. Implementations: InMemoryQueue (tests),
 * PostgresQueue (Phase 1 — SELECT ... FOR UPDATE SKIP LOCKED with backoff + DLQ).
 * A Redis Streams adapter can be added without touching the engine.
 *
 * Delivery semantics: at-least-once. Handlers must be idempotent.
 */
export interface TaskQueue {
  enqueue(
    kind: QueueMessageKind,
    payload: Record<string, unknown>,
    delayMs?: number
  ): Promise<void>;
  /** Claim up to `batchSize` pending messages; marks them in-flight. */
  claim(batchSize: number, visibilityTimeoutMs?: number): Promise<ClaimedMessage[]>;
  complete(msg: ClaimedMessage): Promise<void>;
  /**
   * Report a failed message. Returns "retry" if it was requeued with backoff,
   * "dead" if it exceeded max attempts and was moved to the dead-letter state.
   */
  fail(msg: ClaimedMessage, error: unknown, backoffMs: number): Promise<"retry" | "dead">;
  /** Requeue in-flight messages whose visibility lease expired (crashed worker). */
  recover(): Promise<number>;
  /** Messages pending or scheduled for retry (backoff included). */
  pendingCount(): Promise<number>;
  close?(): Promise<void>;
}

export type { ClaimedMessage, QueueMessage, QueueMessageKind };
