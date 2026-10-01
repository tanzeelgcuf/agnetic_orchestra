import type { ClaimedMessage, QueueMessageKind } from "@orchestra/shared";
import type { TaskQueue } from "./queue";

let nextId = 0;

interface Entry {
  id: string;
  kind: QueueMessageKind;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "dead";
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  lastError?: string;
}

export class InMemoryQueue implements TaskQueue {
  private entries: Entry[] = [];

  constructor(private readonly maxAttempts = 5) {}

  async enqueue(
    kind: QueueMessageKind,
    payload: Record<string, unknown>,
    delayMs = 0
  ): Promise<void> {
    nextId += 1;
    this.entries.push({
      id: `mem-${nextId}`,
      kind,
      payload,
      status: "pending",
      attempts: 0,
      maxAttempts: this.maxAttempts,
      availableAt: Date.now() + delayMs
    });
  }

  async claim(batchSize: number, visibilityTimeoutMs = 60_000): Promise<ClaimedMessage[]> {
    const now = Date.now();
    const claimed: ClaimedMessage[] = [];
    for (const entry of this.entries) {
      if (claimed.length >= batchSize) break;
      if (entry.status === "pending" && entry.availableAt <= now) {
        entry.status = "processing";
        entry.attempts += 1;
        entry.availableAt = now + visibilityTimeoutMs;
        claimed.push({
          id: entry.id,
          kind: entry.kind,
          payload: entry.payload,
          attempts: entry.attempts,
          maxAttempts: entry.maxAttempts
        });
      }
    }
    return claimed;
  }

  async complete(msg: ClaimedMessage): Promise<void> {
    const entry = this.entries.find((e) => e.id === msg.id);
    if (entry && entry.status === "processing") entry.status = "completed";
  }

  async fail(msg: ClaimedMessage, error: unknown, backoffMs: number): Promise<"retry" | "dead"> {
    const entry = this.entries.find((e) => e.id === msg.id);
    if (!entry) return "dead";
    entry.lastError = error instanceof Error ? error.message : String(error);
    if (entry.attempts >= entry.maxAttempts) {
      entry.status = "dead";
      return "dead";
    }
    entry.status = "pending";
    entry.availableAt = Date.now() + backoffMs;
    return "retry";
  }

  async recover(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const entry of this.entries) {
      if (entry.status === "processing" && entry.availableAt <= now) {
        entry.status = "pending";
        count += 1;
      }
    }
    return count;
  }

  async pendingCount(): Promise<number> {
    return this.entries.filter((e) => e.status === "pending").length;
  }

  /** Test helper. */
  deadLetterCount(): number {
    return this.entries.filter((e) => e.status === "dead").length;
  }

  /** Test helper. */
  all(): readonly Entry[] {
    return this.entries;
  }
}
