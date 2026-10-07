import { z } from "zod";

export const logLevels = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
] as const;
export const logLevelSchema = z.enum(logLevels);
export type LogLevel = z.infer<typeof logLevelSchema>;
export const loggingConfigSchema = z
  .object({
    level: logLevelSchema.default("info"),
    maxSizeMB: z.number().int().min(1).max(1000).default(10),
    retain: z.number().int().min(1).max(100).default(7),
  })
  .strict();
export type LoggingConfig = z.input<typeof loggingConfigSchema>;

export function loggingSettings(config?: LoggingConfig) {
  const settings = loggingConfigSchema.parse(config ?? {});
  const override = process.env.OMEM_LOG_LEVEL;
  if (override !== undefined) {
    const parsed = logLevelSchema.safeParse(override);
    if (!parsed.success)
      throw Error(`OMEM_LOG_LEVEL must be one of: ${logLevels.join(", ")}`);
    settings.level = parsed.data;
  }
  return settings;
}
