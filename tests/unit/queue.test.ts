import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "@orchestra/event-bus";

describe("in-memory queue", () => {
  it("claims messages in FIFO order", async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue("run.advance", { runId: "1" });
    await queue.enqueue("run.advance", { runId: "2" });

    const claimed = await queue.claim(10);
    expect(claimed.map((m) => m.payload.runId)).toEqual(["1", "2"]);
    expect(claimed.every((m) => m.attempts === 1)).toBe(true);
  });

  it("does not re-claim in-flight messages", async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue("run.advance", { runId: "1" });

    const first = await queue.claim(10);
    expect(first).toHaveLength(1);
    const second = await queue.claim(10);
    expect(second).toHaveLength(0);
  });

  it("completes claimed messages", async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue("run.advance", { runId: "1" });
    const [msg] = await queue.claim(1);
    if (!msg) throw new Error("expected a message");
    await queue.complete(msg);
    expect(await queue.pendingCount()).toBe(0);
  });

  it("retries failed messages with backoff, then dead-letters", async () => {
    const queue = new InMemoryQueue(2);
    await queue.enqueue("run.advance", { runId: "1" });

    const first = (await queue.claim(1))[0];
    if (!first) throw new Error("expected a message");
    const outcome1 = await queue.fail(first, new Error("transient"), 50);
    expect(outcome1).toBe("retry");

    // Not claimable until the backoff elapses.
    expect((await queue.claim(1))[0]).toBeUndefined();
    const entry = queue.all().find((e) => e.id === first.id);
    if (entry) entry.availableAt = Date.now() - 1;

    const second = (await queue.claim(1))[0];
    expect(second?.attempts).toBe(2);
    const outcome2 = await queue.fail(second!, new Error("still failing"), 50);
    expect(outcome2).toBe("dead");
    expect(queue.deadLetterCount()).toBe(1);
  });

  it("recovers in-flight messages with expired leases", async () => {
    const queue = new InMemoryQueue();
    await queue.enqueue("run.advance", { runId: "1" });
    const [msg] = await queue.claim(1, 1);
    if (!msg) throw new Error("expected a message");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await queue.recover()).toBe(1);
    expect(await queue.claim(1)).toHaveLength(1);
  });
});
