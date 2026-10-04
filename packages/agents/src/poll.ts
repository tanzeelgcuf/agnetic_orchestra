export interface PollOptions {
  label: string;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Poll a probe until it returns a non-null value, or throw on deadline.
 * MergeAgent and DeploymentAgent share this for check/workflow-run polling;
 * tests pass intervalMs: 1.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null | undefined>,
  opts: PollOptions
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await probe();
    if (result !== null && result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`${opts.label} not satisfied after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
