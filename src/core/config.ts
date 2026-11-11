import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { acpCatalog, catalogProfile, upgradeProfileArgs } from "../agents/catalog.ts";

/** Agents that can run with an API key of their vendor instead of the login on this machine. */
export const AI_KEY_BACKENDS = ["claude", "claude-cli", "codex", "codex-cli"] as const;
/** Which provider kind can drive which of them. */
export const KEY_BACKENDS_OF: Record<string, readonly (typeof AI_KEY_BACKENDS)[number][]> = { anthropic: ["claude", "claude-cli"], openai: ["codex", "codex-cli"] };

export const agentProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  /**
   * acp: Agent Client Protocol over stdio. claude-cli / codex-cli: one-shot fallbacks. doubao: Doubao OpenAPI (cloud, no omem tools).
   * doubao-cli: the Doubao CLI on this machine (omem tools through `omem tool` in its shell; agents/doubao-cli.ts).
   */
  transport: z.enum(["acp", "claude-cli", "codex-cli", "doubao", "doubao-cli"]),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Same executable, followed by these arguments and the session id; fallback when ACP has no session/delete. */
  archiveArgs: z.array(z.string()).optional(),
  /** Local history format used to discover disposable helper sessions absent from ACP updates. */
  sessionHistory: z.object({ format: z.literal("codex-rollout"), root: z.string().min(1), env: z.string().optional() }).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Abort when the agent produces no event for this long. */
  idleTimeoutMs: z.number().int().positive().default(600_000),
  /**
   * The account behind it: profiles with the same source (an ACP agent and its CLI fallback) share
   * one quota, so they share capacity and are never offered as two separate choices.
   */
  source: z.string().optional(),
  /** An ACP agent of another device (core/peer-acp.ts): runs there, tools stay here. command/args are filled in. */
  peer: z.object({ id: z.string().min(1), agent: z.string().min(1) }).optional(),
  /** Runs with the API key of this AI provider (`ai.providers`, key in secrets/ai-keys.json; core/ai-keys.ts). */
  keyRef: z.string().optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** Feishu emoji_type names by what they say about an answer (checked against real events; `feedback.emoji`). */
export const DEFAULT_FEEDBACK_EMOJI = {
  positive: ["THUMBSUP", "APPLAUSE", "PRAISE", "AWESOMEN", "FINGERHEART", "HEART", "MUSCLE", "Fire", "HUNDRED", "100", "LGTM"],
  negative: ["ThumbsDown", "CrossMark", "FACEPALM", "SPEECHLESS", "WHAT", "DIZZY", "ERROR"],
  ack: ["OK", "DONE", "Get", "CheckMark", "JIAYI", "OnIt", "Yes"],
};

export const roleNames = [
  "assistant",
  "ingest",
  "archivist",
  "archive-rule-writer",
  "wiki-planner",
  "wiki-writer",
  "wiki-linter",
  "wiki-organizer",
  "heartbeat",
  "dreamer",
  "coder",
  "reviewer",
  "tutor",
  "brief",
  "curator",
  "triager",
  "distiller",
  "summarizer",
  "memory-reviewer",
  "memory-organizer",
  "item-keeper",
  "coach",
  "gatekeeper",
  "guest",
  "review-business",
  "review-arch",
  "review-style",
  "review-history",
  "review-simplify",
  "review-lead",
  "replay-judge",
  "kb-scout",
  "req-splitter",
  "speaking-coach",
  "business-analyst",
  "designer",
  "mention-triage",
] as const;
export type RoleName = (typeof roleNames)[number];

/**
 * Nightly replay (src/agents/replay.ts, docs/v2/replay.md). Signals a past run shows, and the axes a
 * variant arm may change: retrieval (R1 deep search, R2 related spaces, R3 a research profile), source
 * levels (S1 focus+reference only, S2 ignore too), memories (M1 without the ones the run touched, M2
 * none, M3 without digest-written experience), the Wiki (W1 no pages, W2 pages first), the model
 * (A1 one step down, A2 one step up). `random` picks any axis that applies (a control).
 */
export const REPLAY_SIGNALS = ["negative", "correction", "notFound", "timeout", "slow", "normal", "positive"] as const;
export const REPLAY_AXES = ["R1", "R2", "R3", "S1", "S2", "M1", "M2", "M3", "W1", "W2", "A1", "A2"] as const;
export type ReplaySignal = (typeof REPLAY_SIGNALS)[number];
export type ReplayAxis = (typeof REPLAY_AXES)[number];
export const DEFAULT_REPLAY_TASK_TYPES = ["事实查询", "汇总计数", "代码路径", "时间线与变化", "排查", "写作"];
export const DEFAULT_REPLAY_PLAN: Record<ReplaySignal, (ReplayAxis | "random")[]> = {
  negative: ["M1", "S1", "W1", "A2"],
  correction: ["M1", "S1", "W1", "A2"],
  notFound: ["S2", "R2", "R1", "R3", "A2"],
  timeout: ["A1"],
  slow: ["A1", "M3"],
  normal: ["A1"],
  positive: ["random"],
};
const replayAxes = z.array(z.enum([...REPLAY_AXES, "random"])).max(12);
const replayPlanSchema = z.object(Object.fromEntries(REPLAY_SIGNALS.map((s) => [s, replayAxes.default(DEFAULT_REPLAY_PLAN[s])])) as Record<ReplaySignal, z.ZodDefault<typeof replayAxes>>);

/** Light = today's single reviewer; heavier tiers add independent checks for larger changes. */
export function defaultReviewTiers() {
  return [
    { id: "full", name: "完整", guide: "", checks: ["reviewer", "review-business", "review-arch", "review-history", "review-style", "review-simplify"], maxRounds: 3, lead: true, confirmPlan: true, rotateModels: false,
      when: { any: [{ field: "change.repos", op: "gte", value: 2 }, { field: "change.lines", op: "gte", value: 600 }, { field: "change.paths", op: "contains", value: "migration" }] } },
    { id: "standard", name: "标准", guide: "", checks: ["reviewer", "review-business", "review-style"], maxRounds: 3, lead: true, confirmPlan: false, rotateModels: false,
      when: { any: [{ field: "change.lines", op: "gte", value: 80 }, { field: "change.files", op: "gte", value: 3 }] } },
    { id: "light", name: "轻", guide: "", checks: ["reviewer"], maxRounds: 3, lead: false, confirmPlan: false, rotateModels: false, when: null },
  ];
}

/**
 * One command rule (docs/v2/command-gate.md). `approver`: `owner`, `user:<omem user id>`,
 * `lark:<Feishu name or email>`, or `run` (the run names one of `approvers` in OMEM_APPROVER).
 */
export const commandRuleSchema = z
  .object({
    command: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "命令名只能是可执行文件名（字母、数字、. _ + -），不带路径"),
    args: z.string().max(2000).default(""),
    action: z.enum(["approve", "deny", "allow"]).default("approve"),
    approver: z.string().trim().max(200).default("owner"),
    approvers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    waitSeconds: z.number().int().min(5).max(300).default(90),
    expireHours: z.number().min(0.1).max(168).default(24),
    reuse: z.enum(["once", "window"]).default("once"),
    note: z.string().max(1000).default(""),
  })
  .superRefine((r, ctx) => {
    try {
      new RegExp(r.args);
    } catch (e) {
      ctx.addIssue({ code: "custom", path: ["args"], message: `参数模式不是有效的正则：${(e as Error).message}` });
    }
    if (!/^(owner|run|user:.+|lark:.+)$/.test(r.approver)) ctx.addIssue({ code: "custom", path: ["approver"], message: "审批人要写 owner、run、user:<用户 id> 或 lark:<名字或邮箱>" });
    for (const a of r.approvers) if (!/^(owner|user:.+|lark:.+)$/.test(a)) ctx.addIssue({ code: "custom", path: ["approvers"], message: `名单里的「${a}」要写 owner、user:<用户 id> 或 lark:<名字或邮箱>` });
  });
export type CommandRule = z.infer<typeof commandRuleSchema>;

export const capturePolicy = z.enum(["ingest", "involved", "store", "skip"]);
export type CapturePolicy = z.infer<typeof capturePolicy>;

export const configSchema = z.object({
  /**
   * Listen address. All interfaces by default, so other devices can pair with this one;
   * requests from other machines need a token (see http.ts), requests from this machine
   * do not. "localhost" keeps it to this machine only.
   */
  host: z.string().default("0.0.0.0"),
  port: z.number().int().default(4317),
  /** Optional bearer token for the HTTP API; when set, even this machine needs it. */
  token: z.string().optional(),
  /**
   * Where the owner opens the web pages from elsewhere (another device, a Feishu card), e.g.
   * http://192.0.2.10:4317 or a reverse proxy. Links to pages (#/...) become absolute with it.
   */
  webUrl: z.string().optional(),
  /**
   * An HTTPS listener beside `port`, for browsers (src/server/secure.ts): they speak HTTP/2 over it,
   * one connection for all tabs instead of six per address. `cert` / `key`: paths (relative to the
   * data directory, or `~/…`); or `selfSigned` makes one with openssl in `<data>/tls/` for this
   * machine's names and addresses, `webUrl`'s host and `hosts` (browsers warn until it is trusted).
   * The plain port keeps serving everything else (agents, the CLI, paired devices).
   */
  https: z
    .object({
      port: z.number().int().min(0).max(65535).default(4443),
      cert: z.string().optional(),
      key: z.string().optional(),
      selfSigned: z.boolean().default(false),
      hosts: z.array(z.string()).default([]),
    })
    .optional(),
  /**
   * Read-only share links that messages sent outside omem (Feishu) use for what they cite
   * (core/shares.ts); they need `webUrl`. expiryDays 0: links do not expire (revoke them in settings).
   */
  /** Per-plugin choices of the owner that are not the plugin's own settings: the nav icon. */
  /** Plugins: the nav icon the owner chose, and the ones turned off (their code does not load). */
  plugins: z.object({ icons: z.record(z.string(), z.string()).default({}), disabled: z.array(z.string()).default([]) }).default({ icons: {}, disabled: [] }),
  shares: z.object({ expiryDays: z.number().int().min(0).max(3650).default(0) }).default({ expiryDays: 0 }),
  /**
   * Other people logging in (src/auth, docs/v2/multi-user.md). Off: the page asks for a token as
   * before. On: a browser on another machine gets the login page; this machine and paired devices
   * stay the owner without logging in, but a request that came through a reverse proxy is not this
   * machine. Every provider in `providers` can log in and create accounts (pending until approved,
   * per `signup`); once `primary` is set only it logs in, the others are for binding.
   */
  auth: z
    .object({
      enabled: z.boolean().default(false),
      providers: z.array(z.string()).default(["lark"]),
      primary: z.string().nullable().default(null),
      signup: z.record(z.string(), z.enum(["approve", "closed", "open"])).default({}),
      sessionDays: z.number().int().min(1).max(365).default(30),
      /** Platforms offered on the account page for connecting (plugin connectors); Feishu and the login providers always are. */
      connectors: z.array(z.string()).default([]),
    })
    .default({ enabled: false, providers: ["lark"], primary: null, signup: {}, sessionDays: 30, connectors: [] }),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  language: z.string().default("zh-CN"),
  /** Background runs (ingest, wiki, dream…) at the same time; each model's own limit is agents.capacity. */
  concurrency: z.number().int().min(1).max(32).default(2),
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
      /** Background role sessions are separate from interactive conversations. */
      background: z.object({
        enabled: z.boolean().default(true),
        liveMinutes: z.number().min(0).default(60),
        maxLive: z.number().int().min(0).max(8).default(3),
        maxContextRatio: z.number().positive().max(1).default(0.6),
        /**
         * Also start a new session once the context holds more than this many tokens, whatever the
         * window size (a 1M window at 0.6 would otherwise carry 600k into every call). 0: ratio only.
         */
        maxContextTokens: z.number().int().min(0).default(120_000),
      }).default({ enabled: true, liveMinutes: 60, maxLive: 3, maxContextRatio: 0.6, maxContextTokens: 120_000 }),
      /**
       * A coding round continues the previous round's agent session only while that session held at
       * most this many tokens of context; past it (every call of the round would carry the whole
       * history) the round starts a new session that picks the work up from the branch. 0: always new.
       */
      codeResumeMaxTokens: z.number().int().min(0).default(100_000),
      /** Chats (not web, not topics) idle this long start a new thread that remembers the previous one. */
      idleHours: z.number().min(0).default(12),
      /** Wait this long for more messages before starting a turn, so bursts become one turn. */
      mergeMs: z.number().int().min(0).default(1500),
      /** A message that is only material (shared group, forward, image, file) waits this long for the words that usually follow. */
      contentWaitMs: z.number().int().min(0).default(15_000),
    })
    .default(() => ({ liveMinutes: 20, maxLive: 3, maxTurns: 40, background: { enabled: true, liveMinutes: 60, maxLive: 3, maxContextRatio: 0.6, maxContextTokens: 120_000 }, codeResumeMaxTokens: 100_000, idleHours: 12, mergeMs: 1500, contentWaitMs: 15_000 })),
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
      /**
       * How far work goes on without the owner: `turns` is how many times the main assistant may hand
       * a multi-agent work on after the owner last spoke; `codeRounds` how many rounds a coding
       * delegation runs before the reviewer's requests wait for the owner. A delegation driven by
       * tasks (docs/v2/coding-loop.md) gets its own budget (given when delegating, else the coder's
       * estimate), never more than `codeRoundsMax`, so a loop that does not converge still stops.
       * `taskLoop: false` starts new delegations the older way (rounds, tiers, plan confirmation).
       * `parallelCoders`: how many helpers the coder of a round may hand groups of tasks to (0: none).
       * `preCheck`: a new delegation's first round is checked before coding (agents/pre-check.ts).
       */
      autoAdvance: z.object({ turns: z.number().int().min(0).max(50).default(6), codeRounds: z.number().int().min(1).max(20).default(3), codeRoundsMax: z.number().int().min(1).max(50).default(12), taskLoop: z.boolean().default(true), parallelCoders: z.number().int().min(0).max(8).default(3), preCheck: z.boolean().default(true) }).default({ turns: 6, codeRounds: 3, codeRoundsMax: 12, taskLoop: true, parallelCoders: 3, preCheck: true }),
      /**
       * How many runs one model of one source takes at a time (`perModel`, or a `limits` entry for a
       * source / model; 0 = do not use it). A role run whose model is full takes the first free one of
       * its other configured backends (roleModels) and the fallbacks, else waits.
       * Plan usage limits (agents/quota.ts): an account with a window used past `quotaAvoidAbove`
       * percent (100: never), or a window of a day or longer whose remaining percent per day until
       * its reset is under `quotaPerDayBelow` (0: not looked at), goes after the others in a role
       * run's choices and is marked `avoid` for the assistant's own choice.
       */
      capacity: z.object({
        perModel: z.number().int().min(1).max(32).default(3),
        /** `perDay`: runs a day on this model at most (omem's own count, the owner's time zone), for providers that cap some models per day without reporting what is left. */
        limits: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), max: z.number().int().min(0).max(32), perDay: z.number().int().min(0).max(100000).optional() })).max(100).default([]),
        quotaAvoidAbove: z.number().min(50).max(100).default(90),
        quotaPerDayBelow: z.number().min(0).max(100).default(0),
      }).default(() => ({ perModel: 3, limits: [], quotaAvoidAbove: 90, quotaPerDayBelow: 0 })),
      routing: z.object({
        automatic: z.boolean().default(true),
        guidance: z.string().max(8000).default(""),
        candidates: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional(), when: z.string().min(1).max(2000) })).max(50).default([]),
        /**
         * Choosing among the candidates before a run starts (agents/choose-ai.ts), per kind of run:
         * `off` uses the profile's AI; `decision` asks the decision model when one is configured
         * (otherwise the profile's AI); `always` asks the general model when there is no decision
         * model. A conversation chooses when it starts a new agent session, and never asks the
         * general model (a turn would wait for it). A rule that names its AI, a run the assistant gave
         * an execution, and an owner's /model pick are never re-chosen.
         */
        choose: z.object({
          conversation: z.enum(["off", "decision"]).default("decision"),
          rules: z.enum(["off", "decision", "always"]).default("decision"),
          tasks: z.enum(["off", "decision", "always"]).default("off"),
        }).default(() => ({ conversation: "decision" as const, rules: "decision" as const, tasks: "off" as const })),
        /**
         * A run whose AI was named (by the owner, a rule, or the assistant's execution) when that AI
         * cannot take it: `unavailable` moves it to the fallbacks and candidates when the named backend
         * is busy (queue, rate limit, quota) or breaks down, saying so in the run; `never` lets it fail.
         */
        pinnedFallback: z.enum(["unavailable", "never"]).default("unavailable"),
      }).default(() => ({ automatic: true, guidance: "", candidates: [], choose: { conversation: "decision" as const, rules: "decision" as const, tasks: "off" as const }, pinnedFallback: "unavailable" as const })),
      /**
       * Designs (docs/v2/coding-plan.md §3): `mode` whether a delegation first writes a design (`auto`:
       * when the check before coding says so; `always`; `never`); `confirm` who confirms an own design
       * — the owner, or the assistant that delegated when no question in it waits on the owner.
       */
      design: z.object({ mode: z.enum(["auto", "always", "never"]).default("auto"), confirm: z.enum(["owner", "assistant"]).default("owner") }).default({ mode: "auto", confirm: "owner" }),
      profiles: z.array(agentProfileSchema).default([]),
    })
    .default(() => ({ roles: {}, roleModels: {}, fallback: [], queueTimeoutMinutes: 30, autoAdvance: { turns: 6, codeRounds: 3, codeRoundsMax: 12, taskLoop: true, parallelCoders: 3, preCheck: true }, design: { mode: "auto" as const, confirm: "owner" as const }, capacity: { perModel: 3, limits: [], quotaAvoidAbove: 90, quotaPerDayBelow: 0 }, routing: { automatic: true, guidance: "", candidates: [], choose: { conversation: "decision" as const, rules: "decision" as const, tasks: "off" as const }, pinnedFallback: "unavailable" as const }, profiles: [] })),
  /**
   * omem tools an agent may only use with the owner's OK (e.g. lark_send, apply_code_run, forget):
   * the call waits for approval on a card or in the web, a refusal's reason goes back to the agent.
   */
  /**
   * Code review after a delegation (docs/v2/review.md): ordered tiers, the first whose condition
   * matches the change decides which review checks run; checks are built-in review roles or agent
   * specs. Conditions use the rule condition shape and are validated in src/agents/review.ts.
   */
  review: z
    .object({
      tiers: z.array(z.object({
        id: z.string().regex(/^[a-z0-9-]{1,32}$/),
        name: z.string().trim().min(1).max(20),
        when: z.any().nullable().default(null),
        /** The owner's words on when this tier fits; a model weighs them against the change. */
        guide: z.string().max(2000).default(""),
        checks: z.array(z.string()).min(1).max(12),
        maxRounds: z.number().int().min(1).max(10).default(3),
        /** review-lead rules on the findings each round (merge, accept / reject, what to re-review, when to stop). */
        lead: z.boolean().default(false),
        /** The plan (tier, checks, reasons) waits for the owner's OK before reviews start. */
        confirmPlan: z.boolean().default(false),
        /** From the second round each check runs on the next model of `rotation`. */
        rotateModels: z.boolean().optional(),
      })).min(1).max(12).default(() => defaultReviewTiers()),
      checks: z.record(z.string(), z.object({
        label: z.string().trim().min(1).max(12),
        blocks: z.enum(["blocker", "major", "minor"]).default("major"),
        when: z.any().nullable().default(null),
        guide: z.string().max(2000).default(""),
      })).default({}),
      /** With a lead, rounds re-review only the checks the fixes touch; every this many rounds all run again. */
      rereviewAllEvery: z.number().int().min(1).max(10).default(2),
      /** The models review rounds rotate through (tiers with `rotateModels`, or the owner's choice for a delegation). */
      rotation: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })).max(12).optional(),
    })
    .default(() => ({ tiers: defaultReviewTiers(), checks: {}, rereviewAllEvery: 2, rotation: [] })),
  approvals: z.object({ tools: z.array(z.string()).default([]), waitSeconds: z.number().int().min(0).max(50).default(40) }).default({ tools: [], waitSeconds: 40 }),
  /** Questions, suggestions and approvals nobody answered for this many days lapse (agents/ask-expiry.ts); 0 keeps them. */
  asks: z.object({ staleDays: z.number().int().min(0).max(365).default(7) }).default({ staleDays: 7 }),
  /**
   * Commands an agent's processes may not run unchecked (docs/v2/command-gate.md): a wrapper of the
   * same name in front of PATH asks omem first. Only the owner changes this (PUT /api/security/command-rules).
   */
  security: z.object({ commandRules: z.array(commandRuleSchema).max(200).default([]) }).default({ commandRules: [] }),
  /** Web VS Code under /ide: the official `code serve-web` behind omem's own auth (src/server/ide-web.ts). */
  ide: z
    .object({
      web: z
        .object({
          command: z.string().optional(),
          /** Install the repo's own VS Code extension (vscode/) into it, kept at the repo's version (on unless false). */
          omemExtension: z.boolean().optional(),
          /** Seed its machine settings from Remote-SSH's (or the desktop VS Code's) on this machine when it has none (on unless false). */
          reuseSettings: z.boolean().optional(),
          /** Copy the extensions Remote-SSH (or the desktop VS Code) installed here that fit this platform and server, each once (off unless true). */
          reuseExtensions: z.boolean().optional(),
          /** Open a coding delegation's own folder (worktree or applied target) trusted, without VS Code's trust prompt (on unless false). */
          trustCodeFolders: z.boolean().optional(),
          /** Where omem fetches VS Code server builds itself (with progress, newer ones in the background); "off" leaves it to serve-web. */
          updateUrl: z.string().optional(),
        })
        .default({}),
    })
    .default({ web: {} }),
  /** Previews of a delegation's workspace (docs/v2/preview.md): stopped after this long with no connection. */
  preview: z.object({ idleMinutes: z.number().int().min(1).max(24 * 60).default(30) }).default({ idleMinutes: 30 }),
  /** This instance among its peers (`omem peer`): defaults to the host name. */
  node: z.object({ id: z.string().optional() }).default({}),
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
      /**
       * Passive recall: memories whose cosine to the owner's new chat message reaches the
       * threshold are added to that turn (needs embeddings). Calibrated in docs/v2/evaluation.md.
       */
      passive: z
        .object({
          enabled: z.boolean().default(true),
          threshold: z.number().min(0).max(1).default(0.6),
          limit: z.number().int().min(1).max(20).default(5),
        })
        .default({ enabled: true, threshold: 0.6, limit: 5 }),
    })
    .default({ maxChars: 400, longChars: 180, duplicateThreshold: 0.72, review: { enabled: true, batch: 30 }, compare: [], passive: { enabled: true, threshold: 0.6, limit: 5 } }),
  embeddings: z
    .object({
      provider: z.enum(["none", "local", "openai"]).default("none"),
      /** local: model id or directory for transformers.js. openai: model name. */
      model: z.string().default("Xenova/bge-small-zh-v1.5"),
      /** bge-zh (query prefix + CLS), bge-m3 / bge (CLS), other (mean pooling). Inferred from the model name when absent. */
      family: z.enum(["bge-zh", "bge-m3", "bge", "other"]).optional(),
      url: z.string().optional(),
      apiKeyEnv: z.string().default("OPENAI_API_KEY"),
      /** local: keep onnxruntime's CPU memory arena (faster; holds the peak of the largest batch). false gives it back after each batch. */
      memArena: z.boolean().optional(),
    })
    .default({ provider: "none", model: "Xenova/bge-small-zh-v1.5", apiKeyEnv: "OPENAI_API_KEY" }),
  /**
   * Reranking (search/rerank.ts): a cross-encoder reads the question with each of the first `top`
   * fused hits and reorders them; passive recall keeps only memories it scores at least
   * `passiveThreshold`. Local only (transformers.js, ONNX). Calibrated in docs/v2/evaluation.md.
   */
  rerank: z
    .object({
      enabled: z.boolean().default(false),
      /** Model id or local directory (osdk `rerank-m3`). */
      model: z.string().default("onnx-community/bge-reranker-v2-m3-ONNX"),
      top: z.number().int().min(5).max(100).default(20),
      /** Tokens of question + passage the model reads; longer passages are cut. */
      maxTokens: z.number().int().min(128).max(1024).default(512),
      /** onnxruntime threads; 0 = its default (all cores). */
      threads: z.number().int().min(0).max(256).default(0),
      /** Past this the hits keep the fused order (the work stops at the next batch). */
      timeoutMs: z.number().int().min(500).max(120_000).default(10_000),
      passiveThreshold: z.number().min(0).max(1).default(0.5),
    })
    .default({ enabled: false, model: "onnx-community/bge-reranker-v2-m3-ONNX", top: 20, maxTokens: 512, threads: 0, timeoutMs: 10_000, passiveThreshold: 0.5 }),
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
  /**
   * Models omem calls itself over HTTP, besides the agents (docs/v2/ai-models.md): API-key providers
   * (keys in secrets/ai-keys.json, never here) and what each category uses. A provider of kind openai
   * or anthropic can also run Codex / Claude Code with its key as separate backends (`backends`).
   */
  ai: z
    .object({
      providers: z.array(z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
        name: z.string().trim().max(40).default(""),
        /**
         * typesafe: Jev (TypeSafe's own API); openrouter: OpenRouter (Jev and others); cloudflare: Workers AI
         * (the Clef decision models, Jev-shaped); openai-compatible: any OpenAI-shaped API.
         */
        kind: z.enum(["openai", "anthropic", "typesafe", "openrouter", "cloudflare", "openai-compatible"]),
        baseUrl: z.string().url().optional(),
        /** cloudflare: the account whose Workers AI is called (not secret; the API token is the key). */
        accountId: z.string().trim().regex(/^[0-9a-f]{32}$/i, "Cloudflare 账号 ID 是 32 位十六进制").optional(),
        backends: z.array(z.enum(AI_KEY_BACKENDS)).default([]),
      })).max(20).default([]),
      /** Voice: question-page voice input, live conversation, speaking practice. live = GPT-Live, realtime = Realtime API. */
      voice: z.object({
        provider: z.string().default(""),
        api: z.enum(["live", "realtime"]).default("live"),
        model: z.string().default(""),
        voice: z.string().default(""),
        /** Speech to text for the voice input box (`/audio/transcriptions`). */
        transcribeModel: z.string().default(""),
        /** GPT-Live hands reasoning and tools to this Responses model (its `delegation`); Realtime calls tools itself. */
        delegateModel: z.string().default(""),
      }).default(() => ({ provider: "", api: "live" as const, model: "", voice: "", transcribeModel: "", delegateModel: "" })),
      /**
       * Decision model: bounded judgments (one of a few options, yes/no, a score) with probabilities.
       * provider "startlux" is the local judge (`guard`). Where a decision is wanted and this is not
       * configured or fails, `fallback` "general" asks a general model (the role's agent) instead.
       */
      decision: z.object({
        provider: z.string().default(""),
        model: z.string().default(""),
        fallback: z.enum(["general", "none"]).default("general"),
        /** The guest gatekeeper (lark-guest.ts) asks the decision model first. */
        gatekeeper: z.boolean().default(true),
      }).default(() => ({ provider: "", model: "", fallback: "general" as const, gatekeeper: true })),
      image: z.object({
        provider: z.string().default(""),
        model: z.string().default(""),
        size: z.string().default(""),
        quality: z.string().default(""),
      }).default(() => ({ provider: "", model: "", size: "", quality: "" })),
    })
    .default(() => ({ providers: [], voice: { provider: "", api: "live" as const, model: "", voice: "", transcribeModel: "", delegateModel: "" }, decision: { provider: "", model: "", fallback: "general" as const, gatekeeper: true }, image: { provider: "", model: "", size: "", quality: "" } })),
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
      /**
       * The main bot's app has the web app ability (网页应用) with `<webUrl>/lark/` as its home page:
       * links to forms and pages in Feishu then open in its sidebar, signed in without a login page
       * (docs/v2/interactive-ui.md, “飞书网页应用入口”).
       */
      webApp: z.boolean().default(false),
      /** open_id of the owner; only the owner may command the bot. */
      ownerOpenId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
      /**
       * More bots beside the main one (src/channels/lark-bots.ts), each answering as its own Agent
       * profile (`agent`; "assistant" = the main assistant role) in conversations of its own. They
       * answer the owner and users who @ them or talk to them one-to-one; captures, notifications,
       * cards and rules stay with the main bot. `ownerOpenId` is the owner in this app's id space
       * (open_ids differ per app). The secret lives in secrets/lark.json under its App ID.
       */
      bots: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "id 用小写字母、数字和连字符"),
            appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
            agent: z.string().min(1).default("assistant"),
            enabled: z.boolean().default(true),
            ownerOpenId: z.string().optional(),
          }),
        )
        .default([])
        .refine((bots) => new Set(bots.map((b) => b.id)).size === bots.length, "机器人 id 不能重复"),
      /** Bots @-ing one another in a chat: at most this many hand-offs in a row before a person speaks again. */
      botRelay: z.number().int().min(0).max(20).default(4),
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
          /** Docs (docx, old docs, wiki) the owner opened in the last `recentDocsDays`, read before the chats; each once, updates by the docs check. */
          recentDocs: z.boolean().default(true),
          recentDocsDays: z.number().int().min(1).max(90).default(7),
          /** Feishu docs: videos/attachments up to this size are downloaded (images and whiteboards always). */
          docMediaMaxMB: z.number().min(0).default(100),
          /** Feishu docs: levels of linked docs imported along with a doc (0 = none), at most docMaxLinked per doc. */
          docLinkDepth: z.number().int().min(0).max(5).default(2),
          docMaxLinked: z.number().int().min(0).default(30),
          /**
           * Wiki pages: their child nodes in the knowledge base count as links of the same level (at most
           * docWikiChildren per page). One import reads at most docMaxPerImport docs in all (links, children,
           * their links); bigger trees go through a wiki crawl (lark-wiki-crawl.ts), batch by batch.
           */
          docWikiChildren: z.number().int().min(0).default(50),
          docMaxPerImport: z.number().int().min(1).default(100),
          /** A wiki crawl reads at most this many docs unless told otherwise. */
          wikiCrawlMaxDocs: z.number().int().min(1).default(2000),
          /** Linked docs that could not be read: retried every docRetryHours, at most docRetryMax times, then given up quietly. */
          docRetryHours: z.number().min(1).default(6),
          docRetryMax: z.number().int().min(0).default(3),
          /** Update checks: a doc is checked once at each of these many days after its last edit; never after the last one. */
          docRecheckDays: z.array(z.number().positive()).default([7, 30, 90, 180, 365]),
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
            .object({
              days: z.number().int().min(0).default(30),
              policies: z.array(capturePolicy).default(["ingest"]),
              /** History pages fetched per minute, all chats together (one page is 50 messages). */
              pagesPerMinute: z.number().int().min(1).max(300).default(20),
              /** Chats read at the same time. */
              concurrency: z.number().int().min(1).max(8).default(2),
            })
            .default({ days: 30, policies: ["ingest"], pagesPerMinute: 20, concurrency: 2 }),
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
          recentDocs: true,
          recentDocsDays: 7,
          docMediaMaxMB: 100,
          docLinkDepth: 2,
          docMaxLinked: 30,
          docWikiChildren: 50,
          docMaxPerImport: 100,
          wikiCrawlMaxDocs: 2000,
          docRetryHours: 6,
          docRetryMax: 3,
          docRecheckDays: [7, 30, 90, 180, 365],
          calendar: true,
          minutes: true,
          policies: { p2p: "ingest", bot: "store", group: "involved", topic: "involved", muted: "skip" },
          backfill: { days: 30, policies: ["ingest"], pagesPerMinute: 20, concurrency: 2 },
        }),
      /**
       * People who are not users @-ing the bot in a group (or writing to it one-to-one when `p2p`),
       * and other bots @-ing it: the gatekeeper role decides whether to answer, refuse or ignore,
       * and the guest role answers with read tools only, in the group's space (never a personal
       * one) and `spaces`. Off: they get nothing, as before.
       */
      guests: z
        .object({
          enabled: z.boolean().default(false),
          p2p: z.boolean().default(false),
          spaces: z.array(z.string()).default([]),
          perHour: z.number().int().min(1).max(200).default(20),
          /**
           * In a group the owner is in: guest = as anywhere else (gatekeeper, then the guest role);
           * gated = the gatekeeper checks, then the assistant answers as in the owner's own chats;
           * free = the assistant answers right away.
           */
          ownerPresent: z.enum(["guest", "gated", "free"]).default("guest"),
          /**
           * 完全访问 for runs answering guests (the guest role, and the assistant's turns that answer
           * a guest when ownerPresent is gated / free): commands outside the backend's sandbox, no approvals.
           */
          fullAccess: z.boolean().default(false),
        })
        .default({ enabled: false, p2p: false, spaces: [], perHour: 20, ownerPresent: "guest", fullAccess: false }),
      /**
       * Commands the owner types in a one-to-one chat with someone (read with lark-cli once a
       * minute): `ai` has the assistant handle it and answer there as the owner, signed; `group`
       * makes a group of the owner, that person and the bot, where the bot carries on.
       */
      commands: z
        .object({
          enabled: z.boolean().default(false),
          ai: z.string().min(1).default("/ai"),
          group: z.string().min(1).default("/ai拉群"),
          signature: z.string().default("（此消息由 AI 代发）"),
          context: z.number().int().min(1).max(100).default(30),
        })
        .default({ enabled: false, ai: "/ai", group: "/ai拉群", signature: "（此消息由 AI 代发）", context: 30 }),
      /**
       * Adding members to the owner's groups as the owner (`lark_invite`, src/channels/lark-invite.ts):
       * people always wait for the owner's OK; bots omem knows by name join directly unless `botApproval`.
       */
      invite: z
        .object({
          botApproval: z.boolean().default(false),
        })
        .default({ botApproval: false }),
      /**
       * Knowledge bases the owner can see (src/channels/lark-knowledge.ts, read-only): discovered weekly,
       * sorted into spaces by the kb-scout role along `direction` (the owner's words), and read a little
       * every night: `dailyDocs` docs in all, shared by the mapped ones by priority. `autoApply`: the
       * scout's proposals take effect without the owner's OK (one notification says what was done).
       * `origin`: host of the doc links (e.g. https://tenant.larkoffice.com); by default the one most
       * captured docs use.
       */
      knowledge: z
        .object({
          direction: z.string().max(4000).default(""),
          autoApply: z.boolean().default(false),
          dailyDocs: z.number().int().min(0).max(2000).default(30),
          origin: z.string().url().optional(),
        })
        .default({ direction: "", autoApply: false, dailyDocs: 30 }),
    })
    .default({
      enabled: false,
      appSecretEnv: "OMEM_LARK_APP_SECRET",
      webApp: false,
      defaultSpace: "personal",
      bots: [],
      botRelay: 4,
      capture: {
        mode: "subscribed",
        exclude: [],
        space: "personal",
        lookbackHours: 72,
        quietStop: 8,
        maxChats: 300,
        attachments: true,
        docs: true,
        recentDocs: true,
        recentDocsDays: 7,
        docMediaMaxMB: 100,
        docLinkDepth: 2,
        docMaxLinked: 30,
        docWikiChildren: 50,
        docMaxPerImport: 100,
        wikiCrawlMaxDocs: 2000,
        docRetryHours: 6,
        docRetryMax: 3,
        docRecheckDays: [7, 30, 90, 180, 365],
        calendar: true,
        minutes: true,
        policies: { p2p: "ingest", bot: "store", group: "involved", topic: "involved", muted: "skip" },
        backfill: { days: 30, policies: ["ingest"], pagesPerMinute: 20, concurrency: 2 },
      },
      guests: { enabled: false, p2p: false, spaces: [], perHour: 20, ownerPresent: "guest", fullAccess: false },
      commands: { enabled: false, ai: "/ai", group: "/ai拉群", signature: "（此消息由 AI 代发）", context: 30 },
      invite: { botApproval: false },
      knowledge: { direction: "", autoApply: false, dailyDocs: 30 },
    }),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      tokenEnv: z.string().default("OMEM_TELEGRAM_TOKEN"),
      ownerChatId: z.string().optional(),
      defaultSpace: z.string().default("personal"),
    })
    .default({ enabled: false, tokenEnv: "OMEM_TELEGRAM_TOKEN", defaultSpace: "personal" }),
  /**
   * 有人找你 (src/mentions/mentions.ts, docs/v2/mentions.md): someone @-ing the owner in a group, or
   * writing to them one-to-one (`p2p`), on any chat channel — for what no rule took. Free checks first
   * (after `delayMinutes`: read, reacted, answered, or a watch already on it); then one small judgement
   * (the mention-triage role, on the decision model; `noDecision` without one): ignore, a short
   * reminder, or handle — the main assistant (or an Agent 档案) reads up and tells the owner, the short
   * reminder going out when it fails or runs past `timeoutMinutes`. `guidance`: the owner's words for
   * the triage. `perDay`: triages and handlings a day, past which the short reminder goes out.
   * `reply.<channel>`: whether the handler may answer the asker there — off, a draft the owner sends
   * with one click, or auto (only when the triage also found it can move on alone). On Feishu a private
   * chat is answered in a group of the owner, them and the bot (`p2pVia: group`) or as the owner, signed.
   */
  mentions: z
    .object({
      enabled: z.boolean().default(true),
      p2p: z.boolean().default(true),
      delayMinutes: z.number().int().min(0).max(240).default(3),
      timeoutMinutes: z.number().int().min(1).max(60).default(10),
      guidance: z.string().max(4000).default(""),
      noDecision: z.enum(["general", "notify", "handle"]).default("general"),
      perDay: z.object({ triage: z.number().int().min(0).max(1000).default(80), handle: z.number().int().min(0).max(500).default(20) }).default({ triage: 80, handle: 20 }),
      reply: z
        .object({
          lark: z
            .object({
              group: z.enum(["off", "draft", "auto"]).default("off"),
              p2p: z.enum(["off", "draft", "auto"]).default("off"),
              p2pVia: z.enum(["group", "signed"]).default("group"),
            })
            .default({ group: "off", p2p: "off", p2pVia: "group" }),
        })
        .default({ lark: { group: "off", p2p: "off", p2pVia: "group" } }),
    })
    .default({ enabled: true, p2p: true, delayMinutes: 3, timeoutMinutes: 10, guidance: "", noDecision: "general", perDay: { triage: 80, handle: 20 }, reply: { lark: { group: "off", p2p: "off", p2pVia: "group" } } }),
  /**
   * When omem may push to chat channels. Defaults:
   * - quiet hours: nothing outside urgent/overdue 22:00–09:00 local;
   * - onlyUnread: when the triggering Feishu message is known to be read by the owner, skip it;
   * - firstNudgeDelayMinutes: grace period for a normal, non-overdue item's first
   *   nudge — give the owner time to handle it in their own rhythm; urgent/overdue/scheduled bypass.
   */
  notify: z
    .object({
      onlyUnread: z.boolean().default(true),
      firstNudgeDelayMinutes: z.number().int().min(0).default(30),
      quietStart: z.number().int().min(0).max(23).default(22),
      quietEnd: z.number().int().min(0).max(23).default(9),
    })
    .default({ onlyUnread: true, firstNudgeDelayMinutes: 30, quietStart: 22, quietEnd: 9 }),
  /**
   * Reactions on what the bots sent (src/channels/lark-feedback.ts). Feishu emoji_type names, matched
   * without case; anything not listed is neutral. Acknowledgements (OK, DONE, +1…) say "received", not
   * "good": they are kept apart and do not count as quality.
   */
  feedback: z
    .object({
      emoji: z
        .object({
          positive: z.array(z.string()).default(DEFAULT_FEEDBACK_EMOJI.positive),
          negative: z.array(z.string()).default(DEFAULT_FEEDBACK_EMOJI.negative),
          ack: z.array(z.string()).default(DEFAULT_FEEDBACK_EMOJI.ack),
        })
        .default(DEFAULT_FEEDBACK_EMOJI),
    })
    .default({ emoji: DEFAULT_FEEDBACK_EMOJI }),
  /**
   * Nightly replay (docs/v2/replay.md): the scheduled job `replay` (off by default) picks `max` past
   * questions a night and answers each again as of its time, a baseline re-run against one variant.
   * No token limits: the owner sets how many questions; each arm is an ordinary run with its usual
   * time limit. The judge is the built-in role replay-judge, whose AI the owner must choose first.
   */
  replay: z
    .object({
      max: z.number().int().min(1).max(20).default(1),
      /** Questions are picked from runs of the last this many days. */
      days: z.number().int().min(1).max(14).default(3),
      /** Task types the judge labels questions with (routing evidence is kept per type). */
      taskTypes: z.array(z.string().trim().min(1).max(20)).min(1).max(20).default(DEFAULT_REPLAY_TASK_TYPES),
      /** Signal → axes to try in order; the first that applies and was not tried on that question is used. */
      plan: replayPlanSchema.default(DEFAULT_REPLAY_PLAN),
      /** The A axis: models from cheaper to stronger. Without it, one effort level down / up on the same model. */
      models: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })).max(12).default([]),
    })
    .default({ max: 1, days: 3, taskTypes: DEFAULT_REPLAY_TASK_TYPES, plan: DEFAULT_REPLAY_PLAN, models: [] }),
  /**
   * Items close themselves: one with no new progress for `days[kind]` (counted from its
   * last activity: the owner touching it or new evidence) becomes "expired"; a reminder
   * expires `days.reminder` after its time. A due or reminder time still ahead holds it open.
   * `infer`: an item whose source chat shows the owner acting on it afterwards is checked by
   * the item-keeper role and closed as done with its reason. Both are undone from the item.
   */
  items: z
    .object({
      expiry: z.boolean().default(true),
      days: z
        .object({
          todo: z.number().int().min(1).max(365).default(14),
          decision: z.number().int().min(1).max(365).default(7),
          watch: z.number().int().min(1).max(365).default(7),
          waiting: z.number().int().min(1).max(365).default(14),
          reminder: z.number().int().min(1).max(365).default(1),
        })
        .default({ todo: 14, decision: 7, watch: 7, waiting: 14, reminder: 1 }),
      infer: z.boolean().default(true),
    })
    .default({ expiry: true, days: { todo: 14, decision: 7, watch: 7, waiting: 14, reminder: 1 }, infer: true }),
  /**
   * Compressing stored media (src/core/media.ts): how many ffmpeg run at once, and whether media
   * downloaded from now on is compressed by itself (with these settings) while ffmpeg is there.
   */
  media: z
    .object({
      concurrency: z.number().int().min(1).max(64).default(2),
      auto: z
        .object({
          enabled: z.boolean().default(false),
          types: z.array(z.enum(["image", "video", "audio"])).min(1).default(["image", "video", "audio"]),
          mode: z.enum(["lossless", "lossy"]).default("lossy"),
          quality: z.enum(["high", "medium", "low"]).default("medium"),
          maxSide: z.number().int().min(0).max(16384).default(0),
          minBytes: z.number().int().min(0).default(100 * 1024),
          deleteOriginals: z.boolean().default(true),
        })
        .default({ enabled: false, types: ["image", "video", "audio"], mode: "lossy", quality: "medium", maxSide: 0, minBytes: 100 * 1024, deleteOriginals: true }),
    })
    .default({ concurrency: 2, auto: { enabled: false, types: ["image", "video", "audio"], mode: "lossy", quality: "medium", maxSide: 0, minBytes: 100 * 1024, deleteOriginals: true } }),
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
  { id: "traex-cli", name: "TraeX (CLI)", transport: "codex-cli", command: "traex", args: [], model: "gpt-6.1-sol", effort: "low", env: {}, idleTimeoutMs: 600_000, source: "traex" },
  { id: "claude-cli", name: "Claude Code (CLI)", transport: "claude-cli", command: "claude", args: [], env: {}, idleTimeoutMs: 600_000, source: "claude" },
  { id: "codex-cli", name: "Codex (CLI)", transport: "codex-cli", command: "codex", args: [], model: "gpt-6.1-sol", effort: "low", env: {}, idleTimeoutMs: 600_000, source: "codex" },
];
/** Doubao through its OpenAPI: no local command (`command` is only a label); available once authorized. */
const doubaoProfile: AgentProfile = { id: "doubao", name: "豆包 (OpenAPI)", transport: "doubao", command: "doubao-openapi", args: [], env: {}, idleTimeoutMs: 600_000 };
/** The Doubao CLI prints nothing until a turn ends, so the idle limit is the whole turn's. */
const doubaoCliProfile: AgentProfile = { id: "doubao-cli", name: "豆包 (CLI)", transport: "doubao-cli", command: "doubao", args: [], env: {}, idleTimeoutMs: 1_800_000 };

/** ACP agents from the catalog (codex, claude, gemini, copilot, …) plus the one-shot CLI fallbacks. Order = auto-pick priority. */
export const builtinProfiles: AgentProfile[] = [...acpCatalog.slice(0, 3).map(catalogProfile), ...cliProfiles, ...acpCatalog.slice(3).map(catalogProfile), doubaoCliProfile, doubaoProfile];

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
  // Before 2026-10-18 the default was 127.0.0.1, and saveConfig writes every field, so
  // that value in a file is the old default rather than a choice; "localhost" is how to
  // keep it local now.
  if (raw.host === "127.0.0.1") delete raw.host;
  moveOldSettings(raw);
  const config = configSchema.parse(raw);
  if (process.env.OMEM_PORT) config.port = Number(process.env.OMEM_PORT);
  loadedAs.set(resolve(home), structuredClone(config));
  return config;
}

/**
 * Settings that moved, carried over from a file written before (in place). 有人找你 was `lark.mentions`
 * until 2026-11-11 and is `mentions` now (its reply settings under `mentions.reply.lark`). It had not
 * been turned on anywhere yet, so this can go after a release or two.
 */
export function moveOldSettings(raw: Record<string, any>) {
  const old = raw?.lark?.mentions;
  if (!old || typeof old !== "object") return raw;
  delete raw.lark.mentions;
  if (raw.mentions === undefined) {
    const { reply, ...rest } = old;
    raw.mentions = { ...rest, ...(reply ? { reply: { lark: reply } } : {}) };
  }
  return raw;
}

/** The config each home was last loaded or saved as by this process: what a save diffs against. */
const loadedAs = new Map<string, Config>();
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge: what this process changed since it loaded (`ours` against `base`) goes over the
 * file as it is now (`theirs`); everything else stays as the file has it. Objects merge key by key,
 * other values (arrays included) are taken whole.
 */
export function mergeConfig(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (same(ours, base)) return theirs;
  if (!isObject(ours) || !isObject(base) || !isObject(theirs)) return ours;
  const out: Record<string, unknown> = { ...theirs };
  for (const k of new Set([...Object.keys(base), ...Object.keys(ours)])) {
    if (same(ours[k], base[k])) continue;
    if (ours[k] === undefined) delete out[k];
    else out[k] = mergeConfig(base[k], ours[k], theirs[k]);
  }
  return out;
}

/**
 * Save a config. The service, `omem setup` and CLI commands each hold the config they loaded; a
 * plain write of the whole object would undo what another of them (or a hand edit) changed since.
 * So only the fields this process changed are written over the file as it is now, and `config`
 * becomes the merged result (callers then copy it into `app.config`).
 */
export function saveConfig(config: Config, home = omemHome()) {
  mkdirSync(home, { recursive: true });
  const path = configPath(home);
  const base = loadedAs.get(resolve(home));
  let theirs: unknown;
  try {
    theirs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    // The file may still have settings in their old place: merged as they are now, or they would come back.
    if (isObject(theirs)) moveOldSettings(theirs);
  } catch {
    theirs = undefined;
  }
  let merged = base && isObject(theirs) ? mergeConfig(base, config, theirs) : config;
  let parsed: Config | undefined;
  if (merged !== config) {
    // A file another hand left unreadable for this version is overwritten as before, not merged.
    const r = configSchema.safeParse((merged as { host?: string }).host === "127.0.0.1" ? { ...(merged as object), host: undefined } : merged);
    if (r.success) parsed = r.data;
    else merged = config;
  }
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
  if (parsed) {
    if (process.env.OMEM_PORT) parsed.port = Number(process.env.OMEM_PORT);
    // Only the sections the file changed are replaced: others keep their objects (some are held by reference).
    for (const k of Object.keys(parsed) as (keyof Config)[]) if (!same(config[k], parsed[k])) (config as Record<string, unknown>)[k] = parsed[k];
  }
  loadedAs.set(resolve(home), structuredClone(config));
}

export function allProfiles(config: Config): AgentProfile[] {
  const byId = new Map(builtinProfiles.map((p) => [p.id, p]));
  for (const p of keyedProfiles(config)) byId.set(p.id, p);
  for (const p of config.agents.profiles) byId.set(p.id, p.peer ? peerProfile(p) : upgradeProfileArgs(p));
  return [...byId.values()];
}

/**
 * Codex / Claude Code with an API key: one backend per chosen agent of each provider, named
 * `<agent>@<provider>`. Its own source, so its quota and capacity are apart from the logged-in one.
 * The key is added to the environment at launch (core/ai-keys.ts), never stored in the profile.
 */
export function keyedProfiles(config: Config): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const pr of config.ai?.providers ?? []) {
    for (const b of pr.backends) {
      if (!KEY_BACKENDS_OF[pr.kind]?.includes(b)) continue;
      const base = builtinProfiles.find((p) => p.id === b);
      if (!base) continue;
      const label = (base.name ?? base.id).replace(/\)$/, ` · ${pr.name || pr.id})`);
      const env = pr.baseUrl ? { [pr.kind === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"]: pr.baseUrl } : {};
      out.push({ ...base, id: `${b}@${pr.id}`, name: label, env: { ...base.env, ...env }, keyRef: pr.id, source: `key:${pr.id}` });
    }
  }
  return out;
}

/** A device's agent: this omem's own `peer acp` bridge is the command (core/peer-acp.ts). */
function peerProfile(p: AgentProfile): AgentProfile {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = resolve(here, "../cli.js");
  const cli = existsSync(js) ? js : resolve(here, "../cli.ts");
  return { ...p, transport: "acp", command: process.execPath, args: [cli, "peer", "acp", p.peer!.id, p.peer!.agent], source: p.source ?? `peer:${p.peer!.id}:${p.peer!.agent}` };
}
