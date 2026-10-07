import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type DestinationStream, type Logger } from "pino";
import { loggingSettings, type LoggingConfig } from "./config.js";

export type LogContext = {
  component?: string;
  jobId?: string;
  jobKind?: string;
  runId?: string;
  acpCallId?: string;
  roleId?: string;
  sourceId?: string;
  revisionId?: string;
  messageId?: string;
  turnId?: string;
  conversationId?: string;
  requestId?: string;
};
const context = new AsyncLocalStorage<{
  logger: Logger;
  bindings: LogContext;
}>();
let defaultLogger: Logger | undefined;
const sensitive =
  /^(?:authorization|password|secret|token|cookies?|credentials?|api[-_]?key|accessToken|refreshToken|sharedToken)$|(?:Password|Secret)$/i;
const contents =
  /^(?:text|body|prompt|messages|content|parts|materials|input|output|stdout|stderr|arguments|args|raw|rawInput|rawOutput|query|question|answer|selection|headers|env|toolInput|toolOutput)$/i;

export function redactLogString(value: string) {
  return value
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|password|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;"']+/gi,
      "$1=[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .slice(0, 1500);
}

/** Error messages can contain entire model responses or private material. Keep
 * diagnostic categories and code locations, never copy the exception body. */
export function errorSummary(error: unknown) {
  const e = error instanceof Error ? error : undefined;
  const message = e?.message ?? "";
  const declared = (e as (Error & { code?: unknown }) | undefined)?.code;
  const prefix = message.match(/^([A-Z][A-Z0-9_]{2,80})(?:[:\s]|$)/)?.[1];
  const category = /timed?\s*out|timeout|超时/i.test(message)
    ? "TIMEOUT"
    : /auth(?:entication|orization)?|login|登录|凭据/i.test(message)
      ? "AUTHENTICATION_FAILED"
      : /未安装|未准备|not installed|not found/i.test(message)
        ? "RESOURCE_UNAVAILABLE"
        : "OPERATION_FAILED";
  const code =
    typeof declared === "string" && /^[A-Z0-9_]{2,80}$/.test(declared)
      ? declared
      : (prefix ??
        (e?.name === "ZodError"
          ? "VALIDATION_FAILED"
          : e?.name === "AbortError"
            ? "CANCELLED"
            : category));
  return {
    type: e?.name ?? "Error",
    code,
    frames: e?.stack
      ?.split("\n")
      .filter((line) => /^\s+at\s/.test(line))
      .slice(0, 6)
      .map(redactLogString),
  };
}

export function sanitizeLogValue(
  value: unknown,
  key = "",
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (sensitive.test(key) || contents.test(key)) return "[REDACTED]";
  if (value instanceof Error) return errorSummary(value);
  if (typeof value === "string") return redactLogString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 5 || seen.has(value)) return "[OMITTED]";
  seen.add(value);
  if (Array.isArray(value))
    return value
      .slice(0, 100)
      .map((v) => sanitizeLogValue(v, "", depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 60)
      .map(([k, v]) => [k, sanitizeLogValue(v, k, depth + 1, seen)]),
  );
}

const requestSummary = (request: {
  method?: string;
  route?: string;
  routeOptions?: { url?: string };
}) => ({
  method: request.method,
  route: request.routeOptions?.url ?? request.route,
});
const responseSummary = (reply: { statusCode?: number }) => ({
  statusCode: reply.statusCode,
});

export function createLogger(
  config?: LoggingConfig,
  destination: DestinationStream = process.stderr,
): Logger {
  const logger = pino(
    {
      level: loggingSettings(config).level,
      base: { name: "omem", pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (fields) =>
          sanitizeLogValue(fields) as Record<string, unknown>,
      },
      serializers: {
        err: (error) =>
          error instanceof Error
            ? errorSummary(error)
            : sanitizeLogValue(error),
        req: requestSummary,
        res: responseSummary,
      },
      hooks: {
        logMethod(args, method) {
          const clean = args.map((value) => {
            if (
              value &&
              typeof value === "object" &&
              !(value instanceof Error)
            ) {
              const fields = value as Record<string, unknown>;
              return Object.fromEntries(
                Object.entries(fields).map(([key, item]) => [
                  key,
                  key === "req"
                    ? requestSummary(
                        item as Parameters<typeof requestSummary>[0],
                      )
                    : key === "res"
                      ? responseSummary(
                          item as Parameters<typeof responseSummary>[0],
                        )
                      : sanitizeLogValue(item, key),
                ]),
              );
            }
            return sanitizeLogValue(value);
          });
          method.apply(this, clean as Parameters<typeof method>);
        },
      },
    },
    destination,
  );
  // Pino resets the bindings formatter for child loggers. Sanitize before
  // handing bindings to its child factory; descendants inherit this method.
  const child = logger.child;
  logger.child = function (this: Logger, bindings, options) {
    return child.call(
      this,
      sanitizeLogValue(bindings) as Record<string, unknown>,
      options,
    );
  } as typeof logger.child;
  return logger;
}

export function installDefaultLogger(logger: Logger) {
  const previous = defaultLogger;
  defaultLogger = logger;
  return () => {
    if (defaultLogger === logger) defaultLogger = previous;
  };
}
export function getLogger(bindings: LogContext = {}) {
  const active = context.getStore();
  defaultLogger ??= createLogger();
  return (active?.logger ?? defaultLogger).child(
    sanitizeLogValue({ ...active?.bindings, ...bindings }) as LogContext,
  );
}
export function withLogContext<T>(bindings: LogContext, work: () => T) {
  const active = context.getStore();
  return context.run(
    {
      logger: active?.logger ?? getLogger(),
      bindings: { ...active?.bindings, ...bindings },
    },
    work,
  );
}
export function logFailure(
  logger: Logger,
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
) {
  logger.error({ ...fields, event, error: errorSummary(error) }, event);
}
