import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /** acp: Agent Client Protocol over stdio. claude-cli / codex-cli: one-shot fallbacks. */
  transport: z.enum(["acp", "claude-cli", "codex-cli"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  effort: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Abort when the agent produces no event for this long. */
  idleTimeoutMs: z.number().int().positive().default(600_000),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const roleNames = [
  "assistant",
  "ingest",
  "wiki-planner",
  "wiki-writer",
  "wiki-linter",
  "heartbeat",
  "dreamer",
  "coder",
  "reviewer",
  "tutor",
] as const;
export type RoleName = (typeof roleNames)[number];

export const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().default(4317),
  /** Optional bearer token for the HTTP API (required when host is not loopback). */
  token: z.string().optional(),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  language: z.string().default("zh-CN"),
  concurrency: z.number().int().min(1).max(8).default(2),
  agents: z
    .object({
      default: z.string().optional(),
      roles: z.record(z.string(), z.string()).default({}),
      profiles: z.array(agentProfileSchema).default([]),
    })
    .default({ roles: {}, profiles: [] }),
  embeddings: z
    .object({
      provider: z.enum(["none", "local", "openai"]).default("none"),
      /** local: model id or directory for transformers.js. openai: model name. */
      model: z.string().default("Xenova/bge-small-zh-v1.5"),
      url: z.string().optional(),
      apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    })
    .default({ provider: "none", model: "Xenova/bge-small-zh-v1.5", apiKeyEnv: "OPENAI_API_KEY" }),
  documents: z
    .object({
      /** Command that prints Markdown for PDF/DOCX on stdout. {file} is replaced. */
      converter: z.string().optional(),
    })
    .default({}),
  lark: z
    .object({
      enabled: z.boolean().default(false),
      appId: z.string().optional(),
      appSecretEnv: z.string().default("OMEM_LARK_APP_SECRET"),
      /** open_id of the owner; only the owner may command the bot. */
      ownerOpenId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
    })
    .default({ enabled: false, appSecretEnv: "OMEM_LARK_APP_SECRET", defaultSpace: "personal" }),
});
export type Config = z.infer<typeof configSchema>;

/** Built-in profiles; users override or extend them in config.json. */
export const builtinProfiles: AgentProfile[] = [
  {
    id: "codex",
    name: "Codex (ACP)",
    transport: "acp",
    command: "codex-acp",
    args: [],
    model: "gpt-6.1-sol",
    effort: "low",
    env: {},
    idleTimeoutMs: 600_000,
  },
  {
    id: "traex",
    name: "TraeX (ACP)",
    transport: "acp",
    command: "traex",
    args: ["acp", "serve"],
    model: "gpt-6.1-sol",
    effort: "low",
    env: {},
    idleTimeoutMs: 600_000,
  },
  {
    id: "claude",
    name: "Claude Code (ACP)",
    transport: "acp",
    command: "claude-agent-acp",
    args: [],
    env: {},
    idleTimeoutMs: 600_000,
  },
  {
    id: "claude-cli",
    name: "Claude Code (CLI)",
    transport: "claude-cli",
    command: "claude",
    args: [],
    env: {},
    idleTimeoutMs: 600_000,
  },
  {
    id: "codex-cli",
    name: "Codex (CLI)",
    transport: "codex-cli",
    command: "codex",
    args: [],
    model: "gpt-6.1-sol",
    effort: "low",
    env: {},
    idleTimeoutMs: 600_000,
  },
];

export function omemHome(): string {
  if (process.env.OMEM_HOME) return resolve(process.env.OMEM_HOME);
  return join(homedir(), ".omem");
}

export function configPath(home = omemHome()) {
  return join(home, "config.json");
}

export function loadConfig(home = omemHome()): Config {
  mkdirSync(home, { recursive: true });
  const path = configPath(home);
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const config = configSchema.parse(raw);
  if (process.env.OMEM_PORT) config.port = Number(process.env.OMEM_PORT);
  return config;
}

export function saveConfig(config: Config, home = omemHome()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n");
}

export function allProfiles(config: Config): AgentProfile[] {
  const byId = new Map(builtinProfiles.map((p) => [p.id, p]));
  for (const p of config.agents.profiles) byId.set(p.id, p);
  return [...byId.values()];
}
