import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  service: string;
  level?: string;
  /** JSON paths to redact from every log line, e.g. "req.headers.authorization". */
  redactPaths?: string[];
}

export function createLogger(opts: LoggerOptions): Logger {
  return pino({
    level: opts.level ?? "info",
    base: { service: opts.service },
    redact:
      opts.redactPaths && opts.redactPaths.length > 0
        ? { paths: opts.redactPaths, censor: "[REDACTED]" }
        : undefined
  });
}
