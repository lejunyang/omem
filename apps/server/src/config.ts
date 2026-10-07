import { retrievalConfigSchema } from "./retrieval/factory.js";
import { decisionConfigSchema } from "./decision/service.js";
import { loggingConfigSchema, loggingSettings } from "./logging/config.js";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import {
  assetPath,
  configPath,
  defaultDataDir,
  developmentCheckout,
} from "./paths.js";
const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }, "invalid IANA timezone");
const schema = z
  .object({
    profiles: z.array(profileSchema).min(1),
    agentsConfiguredAt: z.iso.datetime().optional(),
    knowledge: z
      .object({ profileId: z.string().min(1) })
      .strict()
      .optional(),
    development: z
      .object({
        codingProfileId: z.string().min(1),
        reviewProfileId: z.string().min(1),
      })
      .strict()
      .optional(),
    assistant: z
      .object({
        profileId: z.string().min(1),
        readingProfileId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    notifications: z
      .object({
        mode: z.enum(["instant", "digest"]).default("instant"),
        external: z
          .object({
            mode: z.enum(["instant", "window", "scheduled"]).default("instant"),
            windowMs: z
              .number()
              .int()
              .min(1000)
              .max(86_400_000)
              .default(300_000),
            scheduleLocalTime: z
              .string()
              .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
              .default("09:00"),
            timezone: timezoneSchema.default("Asia/Shanghai"),
          })
          .strict()
          .default({
            mode: "instant",
            windowMs: 300_000,
            scheduleLocalTime: "09:00",
            timezone: "Asia/Shanghai",
          }),
      })
      .default({
        mode: "instant",
        external: {
          mode: "instant",
          windowMs: 300_000,
          scheduleLocalTime: "09:00",
          timezone: "Asia/Shanghai",
        },
      }),
    retrieval: retrievalConfigSchema.optional(),
    decisions: decisionConfigSchema.optional(),
    logging: loggingConfigSchema.optional(),
    captureRoots: z.array(z.string()).default([]),
    learning: z
      .object({
        enabled: z.boolean().default(false),
        profileId: z.string().min(1).default("traex"),
        pollMs: z.number().int().min(50).max(60_000).default(1000),
      })
      .strict()
      .default({ enabled: false, profileId: "traex", pollMs: 1000 }),
    lark: z
      .object({
        enabled: z.boolean().default(false),
        pollMs: z.number().int().min(100).max(60_000).default(1000),
        botmuxConfig: z.string().min(1).optional(),
      })
      .strict()
      .default({ enabled: false, pollMs: 1000 }),
  })
  .strict();
type ParsedConfig = z.infer<typeof schema>;
type LearningConfig = ParsedConfig["learning"];
type LarkConfig = ParsedConfig["lark"];
type NotificationConfig = ParsedConfig["notifications"];
export type Config = Omit<
  ParsedConfig,
  "learning" | "lark" | "notifications"
> & {
  learning?: LearningConfig;
  lark?: LarkConfig;
  notifications: Omit<NotificationConfig, "external"> & {
    external?: NotificationConfig["external"];
  };
  dataDir: string;
  agentCwd: string;
  token?: string;
  host: string;
  port: number;
  configFile?: string;
};

export function knowledgeProfile(
  config: Pick<Config, "profiles" | "knowledge">,
) {
  if (!config.knowledge)
    return config.profiles.find((p) => p.transport === "acp");
  const profile = config.profiles.find(
    (p) => p.id === config.knowledge!.profileId,
  );
  if (!profile || profile.transport !== "acp")
    throw Error("Knowledge profile requires an existing ACP profile");
  return profile;
}

/** Answering can use a faster agent without changing learning or Wiki writing. */
export function assistantProfile(
  config: Pick<Config, "profiles" | "assistant">,
) {
  if (!config.assistant)
    return config.profiles.find((p) => p.transport === "acp") ?? null;
  const profile = config.profiles.find(
    (p) => p.id === config.assistant!.profileId,
  );
  if (!profile)
    throw Error(`Assistant profile not found: ${config.assistant.profileId}`);
  if (profile.transport !== "acp")
    throw Error(`Assistant profile requires ACP: ${profile.id}`);
  return profile;
}

/** Optional material-first writer. The regular profile remains the investigator. */
export function assistantReadingProfile(
  config: Pick<Config, "profiles" | "assistant">,
) {
  const id = config.assistant?.readingProfileId;
  if (!id) return null;
  const profile = config.profiles.find((p) => p.id === id);
  if (!profile || profile.transport !== "acp")
    throw Error(
      `Assistant reading profile requires an existing ACP profile: ${id}`,
    );
  return profile;
}
/** Roles select independently; omission preserves the existing assistant default. */
export function developmentProfiles(
  config: Pick<Config, "profiles" | "assistant" | "development">,
) {
  if (!config.development) {
    const profile = assistantProfile(config);
    return profile ? { coding: profile, review: profile } : null;
  }
  const get = (id: string) => {
    const profile = config.profiles.find((p) => p.id === id);
    if (!profile || profile.transport !== "acp")
      throw Error(
        `Development profile requires an existing ACP profile: ${id}`,
      );
    return profile;
  };
  return {
    coding: get(config.development.codingProfileId),
    review: get(config.development.reviewProfileId),
  };
}
export function parseConfig(input: unknown) {
  const config = schema.parse(input);
  if (new Set(config.profiles.map((p) => p.id)).size !== config.profiles.length)
    throw Error("Duplicate agent profile ID");
  assistantProfile(config);
  developmentProfiles(config);
  knowledgeProfile(config);
  if (
    config.learning.enabled &&
    !config.profiles.some(
      (p) => p.id === config.learning.profileId && p.transport === "acp",
    )
  )
    throw Error("Learning profile requires an existing ACP profile");
  return config;
}

export function loadConfig() {
  const file = configPath();
  if (process.env.OMEM_CONFIG && !existsSync(file))
    throw Error(`配置文件不存在：${file}；运行 omem init 创建`);
  const config = parseConfig(
    JSON.parse(
      readFileSync(
        existsSync(file)
          ? file
          : assetPath(
              "config",
              developmentCheckout ? "omem.example.json" : "omem.default.json",
            ),
        "utf8",
      ),
    ),
  );
  const dataDir = defaultDataDir();
  loggingSettings(config.logging);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    ...config,
    configFile: file,
    dataDir,
    agentCwd: join(dataDir, "agent-workspace"),
    token: process.env.OMEM_TOKEN,
    host: process.env.OMEM_HOST || "127.0.0.1",
    port: Number(process.env.OMEM_PORT || 4317),
  } satisfies Config;
}
