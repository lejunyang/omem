import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { acpCatalog, catalogProfile } from "../agents/catalog.ts";

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
  "brief",
  "curator",
  "summarizer",
  "memory-reviewer",
] as const;
export type RoleName = (typeof roleNames)[number];

export const capturePolicy = z.enum(["ingest", "involved", "store", "skip"]);
export type CapturePolicy = z.infer<typeof capturePolicy>;

export const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().default(4317),
  /** Optional bearer token for the HTTP API (required when host is not loopback). */
  token: z.string().optional(),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  language: z.string().default("zh-CN"),
  /** Background runs (ingest, wiki, dream…) at the same time. */
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Conversation turns at the same time (one per thread; threads run in parallel). */
  interactiveConcurrency: z.number().int().min(1).max(16).default(4),
  sessions: z
    .object({
      /** Keep a thread's agent process alive this long after a reply (ACP agents). */
      liveMinutes: z.number().min(0).default(20),
      /** At most this many live agent processes; the least recently used is released first. */
      maxLive: z.number().int().min(0).default(3),
      /** After this many turns in one agent session, start a fresh one from the thread summary. */
      maxTurns: z.number().int().min(4).default(40),
      /** Chats (not web, not topics) idle this long start a new thread that remembers the previous one. */
      idleHours: z.number().min(0).default(12),
      /** Wait this long for more messages before starting a turn, so bursts become one turn. */
      mergeMs: z.number().int().min(0).default(1500),
    })
    .default({ liveMinutes: 20, maxLive: 3, maxTurns: 40, idleHours: 12, mergeMs: 1500 }),
  agents: z
    .object({
      default: z.string().optional(),
      roles: z.record(z.string(), z.string()).default({}),
      /**
       * Per-role model/effort overrides, resolved after the backend profile:
       * role -> profile id -> { model, effort }. The backend stays one profile
       * (its command/session), the model/effort vary per task.
       */
      roleModels: z
        .record(z.string(), z.record(z.string(), z.object({ model: z.string().optional(), effort: z.string().optional() })))
        .default({}),
      /**
       * Ordered fallbacks tried once when the primary backend fails because of a
       * provider queue / rate limit / queue-timeout. Each step is another profile
       * id, optionally with a different model/effort: { profile, model, effort }.
       * Role picks apply per step the same way they do for the primary profile.
       */
      fallback: z
        .array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() }))
        .default([]),
      /** Max minutes to wait in the provider queue (traex queue_begin…) before giving up and trying a fallback. */
      queueTimeoutMinutes: z.number().min(1).max(240).default(30),
      profiles: z.array(agentProfileSchema).default([]),
    })
    .default({ roles: {}, roleModels: {}, fallback: [], queueTimeoutMinutes: 30, profiles: [] }),
  /** Memory quality: write-time checks, cross-model review, side-by-side comparison. */
  memory: z
    .object({
      /**
       * Hard limit: longer than this is a document or summary, not a memory, and is rejected
       * with advice to split it or write a page. Between longChars and maxChars it is stored
       * and the reviewer checks whether it should be split.
       */
      maxChars: z.number().int().min(100).default(400),
      longChars: z.number().int().min(60).default(180),
      /** Bigram overlap above which a new memory counts as a duplicate of an existing one. */
      duplicateThreshold: z.number().min(0.3).max(1).default(0.72),
      review: z
        .object({
          /** Review new agent memories in batches (keep / rewrite / retract against the source). */
          enabled: z.boolean().default(true),
          /** Backend for the reviewer; best a different model from the writer. Empty = agents.roles["memory-reviewer"] or the default. */
          profile: z.string().optional(),
          model: z.string().optional(),
          effort: z.string().optional(),
          /** Memories per review run. */
          batch: z.number().int().min(1).max(100).default(30),
        })
        .default({ enabled: true, batch: 30 }),
      /**
       * Shadow runs: each ingest also runs with these backends/models; their writes are
       * recorded, not applied, and graded by the same checks and reviewer for comparison.
       */
      compare: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })).default([]),
    })
    .default({ maxChars: 400, longChars: 180, duplicateThreshold: 0.72, review: { enabled: true, batch: 30 }, compare: [] }),
  embeddings: z
    .object({
      provider: z.enum(["none", "local", "openai"]).default("none"),
      /** local: model id or directory for transformers.js. openai: model name. */
      model: z.string().default("Xenova/bge-small-zh-v1.5"),
      /** bge-zh (query prefix + CLS), bge-m3 / bge (CLS), other (mean pooling). Inferred from the model name when absent. */
      family: z.enum(["bge-zh", "bge-m3", "bge", "other"]).optional(),
      url: z.string().optional(),
      apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    })
    .default({ provider: "none", model: "Xenova/bge-small-zh-v1.5", apiKeyEnv: "OPENAI_API_KEY" }),
  documents: z
    .object({
      /** Command that prints Markdown for PDF/DOCX on stdout. {file} is replaced. */
      converter: z.string().optional(),
      /** Which built-in converters to try, in order. */
      engines: z.array(z.enum(["docling", "pdftotext", "pandoc"])).default(["docling", "pdftotext", "pandoc"]),
      /** Docling layout/table models (a directory prepared by `omem setup`); without it Docling reads DOCX only. */
      doclingArtifacts: z.string().optional(),
    })
    .default({ engines: ["docling", "pdftotext", "pandoc"] }),
  /** Optional prompt-injection flagging with a local judge (StartLux-Decision). Flags only, never blocks. */
  guard: z
    .object({
      provider: z.enum(["none", "startlux"]).default("none"),
      /** Directory with the StartLux-Decision GGUF repo (weights + startlux_decision/); omem starts and stops the judge itself. */
      modelDir: z.string().optional(),
      /** Use a judge server you run yourself (…/v1/systemone) instead of the one omem starts. */
      url: z.string().optional(),
      /** Stop the judge after this long without requests. */
      idleMs: z.number().int().min(10_000).default(180_000),
      threshold: z.number().min(0).max(1).default(0.6),
      /** Source kinds written by other people that get checked. */
      kinds: z.array(z.string()).default(["chat", "web", "doc"]),
      maxChars: z.number().int().min(200).default(1200),
      timeoutMs: z.number().int().default(60_000),
    })
    .default({ provider: "none", idleMs: 180_000, threshold: 0.6, kinds: ["chat", "web", "doc"], maxChars: 1200, timeoutMs: 60_000 }),
  lark: z
    .object({
      enabled: z.boolean().default(false),
      appId: z.string().optional(),
      appSecretEnv: z.string().default("OMEM_LARK_APP_SECRET"),
      /** open_id of the owner; only the owner may command the bot. */
      ownerOpenId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
      /** Reading the owner's own Feishu (lark-cli, user identity, read-only). */
      capture: z
        .object({
          /** all: every chat with new messages (minus excluded); subscribed: only chosen chats; off. */
          mode: z.enum(["all", "subscribed", "off"]).default("subscribed"),
          exclude: z.array(z.string()).default([]),
          /** Space for captured chats without their own mapping. */
          space: z.string().default("personal"),
          /** First read of a chat goes back this far. */
          lookbackHours: z.number().default(72),
          /** Stop scanning after this many chats in a row without anything new (chats come most-recent first). */
          quietStop: z.number().int().default(8),
          maxChats: z.number().int().default(300),
          /** Download images/files in messages and import them; import Feishu docs linked in messages. */
          attachments: z.boolean().default(true),
          docs: z.boolean().default(true),
          calendar: z.boolean().default(true),
          minutes: z.boolean().default(true),
          /**
           * What happens to new messages by kind of chat (a chat's own setting wins):
           * ingest = keep and let the ingest role turn them into memories/items;
           * involved = keep, and ingest only batches where the owner speaks, is @-mentioned or
           *   replies in the topic; store = keep searchable, never ingest; skip = do not read.
           * p2p = one-to-one with a person, bot = one-to-one with a bot/app (notifications),
           * group = regular group, topic = topic group, muted = any chat set to do-not-disturb.
           * omem's own bot chat is never captured.
           */
          policies: z
            .object({
              p2p: capturePolicy.default("ingest"),
              bot: capturePolicy.default("store"),
              group: capturePolicy.default("involved"),
              topic: capturePolicy.default("involved"),
              muted: capturePolicy.default("skip"),
            })
            .default({ p2p: "ingest", bot: "store", group: "involved", topic: "involved", muted: "skip" }),
          /**
           * History before the first read: chats captured for the first time whose policy is in
           * `policies` get `days` of history (0 = none), a few pages per poll, into monthly archive
           * sources. Any chat can be backfilled on request (web, set_lark_backfill).
           */
          backfill: z
            .object({ days: z.number().int().min(0).default(30), policies: z.array(capturePolicy).default(["ingest"]), pagesPerPoll: z.number().int().min(1).max(50).default(6) })
            .default({ days: 30, policies: ["ingest"], pagesPerPoll: 6 }),
        })
        .default({
          mode: "subscribed",
          exclude: [],
          space: "personal",
          lookbackHours: 72,
          quietStop: 8,
          maxChats: 300,
          attachments: true,
          docs: true,
          calendar: true,
          minutes: true,
          policies: { p2p: "ingest", bot: "store", group: "involved", topic: "involved", muted: "skip" },
          backfill: { days: 30, policies: ["ingest"], pagesPerPoll: 6 },
        }),
    })
    .default({
      enabled: false,
      appSecretEnv: "OMEM_LARK_APP_SECRET",
      defaultSpace: "personal",
      capture: {
        mode: "subscribed",
        exclude: [],
        space: "personal",
        lookbackHours: 72,
        quietStop: 8,
        maxChats: 300,
        attachments: true,
        docs: true,
        calendar: true,
        minutes: true,
        policies: { p2p: "ingest", bot: "store", group: "involved", topic: "involved", muted: "skip" },
        backfill: { days: 30, policies: ["ingest"], pagesPerPoll: 6 },
      },
    }),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      tokenEnv: z.string().default("OMEM_TELEGRAM_TOKEN"),
      ownerChatId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
    })
    .default({ enabled: false, tokenEnv: "OMEM_TELEGRAM_TOKEN", defaultSpace: "personal" }),
  /** OneBot v11 forward WebSocket: QQ (NapCat / LLOneBot / Lagrange) and compatible WeChat bridges. */
  onebot: z
    .object({
      enabled: z.boolean().default(false),
      name: z.string().default("QQ"),
      url: z.string().optional(),
      tokenEnv: z.string().optional(),
      ownerUserId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
      groupSpaces: z.record(z.string(), z.string()).default({}),
    })
    .default({ enabled: false, name: "QQ", defaultSpace: "personal", groupSpaces: {} }),
});
export type Config = z.infer<typeof configSchema>;

/** Built-in profiles; users override or extend them in config.json. */
const cliProfiles: AgentProfile[] = [
  { id: "claude-cli", name: "Claude Code (CLI)", transport: "claude-cli", command: "claude", args: [], env: {}, idleTimeoutMs: 600_000 },
  { id: "codex-cli", name: "Codex (CLI)", transport: "codex-cli", command: "codex", args: [], model: "gpt-6.1-sol", effort: "low", env: {}, idleTimeoutMs: 600_000 },
];

/** ACP agents from the catalog (codex, claude, gemini, copilot, …) plus the one-shot CLI fallbacks. Order = auto-pick priority. */
export const builtinProfiles: AgentProfile[] = [...acpCatalog.slice(0, 3).map(catalogProfile), ...cliProfiles, ...acpCatalog.slice(3).map(catalogProfile)];

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
