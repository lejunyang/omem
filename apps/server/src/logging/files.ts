import { existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { configPath, defaultDataDir } from "../paths.js";
import { parseConfig } from "../config.js";
import {
  loggingSettings,
  logLevels,
  logLevelSchema,
  type LogLevel,
} from "./config.js";
import { sanitizeLogValue } from "./logger.js";

export function serviceLogPaths(data = defaultDataDir()) {
  const directory = join(data, "service", "pm2", "logs");
  return {
    directory,
    files: [join(directory, "omem-out.log"), join(directory, "omem-error.log")],
  };
}
export function readLoggingSettings() {
  const path = configPath();
  const config = existsSync(path)
    ? parseConfig(JSON.parse(readFileSync(path, "utf8"))).logging
    : undefined;
  return loggingSettings(config);
}

async function lastLines(path: string, limit: number) {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 1_048_576);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean).slice(-limit);
  } finally {
    await file.close();
  }
}

/** Bounded, read-only tail; no daemon, database or model is started. Legacy
 * plaintext remains on disk but is never copied into diagnostic exports. */
export async function readServiceLogs(
  options: {
    lines?: number;
    level?: LogLevel;
    jobId?: string;
    sourceId?: string;
    messageId?: string;
  } = {},
) {
  const lines = options.lines ?? 100;
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000)
    throw Error("日志行数必须是 1 至 1000");
  const level = options.level ? logLevelSchema.parse(options.level) : "trace";
  const paths = serviceLogPaths();
  const entries: Record<string, unknown>[] = [];
  let legacyLines = 0;
  for (const file of paths.files) {
    for (const line of await lastLines(file, Math.max(lines, 1000))) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line.slice(line.indexOf("{")));
        if (
          !value ||
          value.name !== "omem" ||
          typeof value.level !== "string"
        ) {
          legacyLines++;
          continue;
        }
      } catch {
        legacyLines++;
        continue;
      }
      if (logLevels.indexOf(value.level as LogLevel) < logLevels.indexOf(level))
        continue;
      if (
        ["jobId", "sourceId", "messageId"].some(
          (key) =>
            options[key as keyof typeof options] &&
            value[key] !== options[key as keyof typeof options],
        )
      )
        continue;
      entries.push(sanitizeLogValue(value) as Record<string, unknown>);
    }
  }
  entries.sort((a, b) =>
    String(a.time ?? "").localeCompare(String(b.time ?? "")),
  );
  return {
    ...paths,
    settings: readLoggingSettings(),
    entries: entries.slice(-lines),
    legacyLines,
  };
}
