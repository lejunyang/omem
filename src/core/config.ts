import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { acpCatalog, catalogProfile, referencedPluginProfiles, upgradeProfileArgs } from "../agents/catalog.ts";
import { omemHome } from "./home.ts";
import { systemZone, validZone } from "./util.ts";
import { DECISION_SCENES, decisionThresholdDefaults } from "./decision-scenes.ts";
import { isIP } from "node:net";

/**
 * What a cloud backend may be allowed to call over HTTP: a few read tools, and the tools a study stage
 * hands its result in with (they only reach a run whose own tool list already has them: a study stage).
 */
export const cloudToolNames = ["search", "read_source", "read_page", "read_item", "read_ledger", "propose_directions", "trial_report", "record_finding", "close_direction", "stage_report"] as const;
export const cloudToolsSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * The address may be on the internal network over plain http (`webUrl` such as http://10.0.0.5:4317):
   * for a cloud that runs inside the same network. The probe still has to succeed and be confirmed.
   */
  privateAddress: z.boolean().default(false),
  tools: z.array(z.enum(cloudToolNames)).max(cloudToolNames.length).default(["search", "read_source"]),
  ttlMinutes: z.number().int().min(1).max(30).default(15),
  maxCalls: z.number().int().min(1).max(100).default(32),
  backends: z.array(z.string().min(1)).max(100).default([]),
  credentialIn: z.enum(["channel", "message"]).default("channel"),
});
const networkUrl = z.string().url().refine((s) => {
  try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
}, "地址须为 HTTP(S)，不能带账号和密码");
export const networkPolicySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().trim().min(1).max(80),
  backends: z.array(z.string().min(1)).min(1).max(100),
  connection: z.discriminatedUnion("type", [z.object({ type: z.literal("system") }), z.object({ type: z.literal("proxy"), url: networkUrl })]).default({ type: "system" }),
  watch: z.object({ interface: z.string().trim().min(1).max(100).optional() }).default({}),
  probe: z.object({
    url: networkUrl,
    format: z.enum(["cloudflare-trace", "json"]).default("cloudflare-trace"),
    ipField: z.string().min(1).max(100).default("ip"),
    countryField: z.string().min(1).max(100).default("country_code"),
    timeoutMs: z.number().int().min(200).max(30000).default(3000),
    maxAgeSeconds: z.number().int().min(60).max(86400).default(3600),
  }),
  require: z.object({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(250).default([]), ips: z.array(z.string().refine((s) => !!isIP(s), "请输入有效的 IP 地址")).max(100).default([]) }).default({ countries: [], ips: [] }),
  ipv6: z.object({
    enabled: z.boolean().default(false),
    doh: z.array(networkUrl.refine((s) => new URL(s).protocol === "https:", "DoH 须使用 HTTPS")).max(5).default(["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"]),
  }).default({ enabled: false, doh: ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"] }),
  dns: z.object({
    enabled: z.boolean().default(false),
    expectedServers: z.array(z.string().refine((s) => !!isIP(s), "请输入 DNS 服务器的 IP 地址")).max(20).default([]),
    mihomoConfig: z.string().trim().min(1).max(4096).optional(),
  }).default({ enabled: false, expectedServers: [] }),
  onFailure: z.enum(["stop-and-fallback", "restrict-new"]).default("stop-and-fallback"),
});
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
const networkPoliciesSchema = z.array(networkPolicySchema).max(50).default([]).superRefine((list, ctx) => {
  const ids = new Set<string>(), backends = new Set<string>();
  for (const [i, p] of list.entries()) {
    if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "网络条件的编号重复" });
    ids.add(p.id);
    for (const id of p.backends) {
      if (backends.has(id)) ctx.addIssue({ code: "custom", path: [i, "backends"], message: `后端 ${id} 只能绑定一份网络条件` });
      backends.add(id);
    }
  }
});

/** Agents that can run with an API key of their vendor instead of the login on this machine. */
export const AI_KEY_BACKENDS = ["claude", "claude-cli", "codex", "codex-cli"] as const;
/** Which provider kind can drive which of them. */
export const KEY_BACKENDS_OF: Record<string, readonly (typeof AI_KEY_BACKENDS)[number][]> = { anthropic: ["claude", "claude-cli"], openai: ["codex", "codex-cli"] };

/** A folder under the account folder: relative, no `..`, no placeholder. */
const accountRel = z.string().min(1).max(200).refine((s) => !/^([\\/]|~|[A-Za-z]:)/.test(s) && !s.split(/[\\/]/).includes("..") && !s.includes("{home}") && !s.includes("$"), "写账号目录下的相对路径（不能以 / 或 ~ 开头，不能有 .. 和 {home}）");
const accountPattern = z.string().min(1).max(500).refine((s) => {
  try { new RegExp(s); return true; } catch { return false; }
}, "不是有效的正则表达式");
/** No `{home}` outside the values of `env`. */
const noHome = z.string().refine((s) => !s.includes("{home}"), "{home} 只能写在 env 的值里");
/**
 * An env value of a user's account: under `{home}` (the account folder), or a plain value. An absolute
 * path, `~` or a variable would point outside the account folder, into the service's own HOME.
 */
const accountEnvValue = z.string().max(500).refine((v) => {
  if (v.startsWith("{home}")) return !v.slice(6).split(/[\\/]/).includes("..") && !v.slice(6).includes("{home}") && (v.length === 6 || /^[\\/]/.test(v.slice(6)));
  return !v.includes("{home}") && !/^([\\/]|~|[A-Za-z]:[\\/])/.test(v) && !v.includes("$");
}, "env 的值要么在 {home} 下（{home}/…），要么是普通值：不能写绝对路径、~ 或 ${…}（本机的安装放 mounts）");
/**
 * Each omem user's own account of a backend (docs/v2/agent-accounts.md §2), the same fields as the
 * catalog's `account` (agents/catalog.ts AccountSpec). Unknown keys are refused.
 */
export const accountSpecSchema = z
  .object({
    cli: noHome.pipe(z.string().min(1).max(500)).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "变量名只能用字母、数字和下划线"), accountEnvValue).default({}),
    dirs: z.array(accountRel).max(20).optional(),
    mounts: z.array(noHome.pipe(z.string().min(1).max(500))).max(20).optional(),
    owns: z.array(accountRel).min(1, "owns 至少写一个：退出时删掉这个后端在账号目录里的哪些东西").max(20),
    login: z.object({ args: z.array(noHome).max(20), url: accountPattern, code: accountPattern.optional(), input: accountPattern.optional(), qrArgs: z.array(noHome).min(1).max(20).optional(), timeoutMs: z.number().int().min(30_000).max(3_600_000).optional() }).strict().optional(),
    status: z.object({ args: z.array(noHome).max(20), user: accountPattern.optional() }).strict().optional(),
    logout: z.object({ args: z.array(noHome).max(20) }).strict().optional(),
    tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  })
  .strict();

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
  /** Catalog entry describing local state, independent of billing. */
  stateLayout: z.string().optional(),
  plugin: z.string().optional(),
  /** An ACP agent of another device (core/peer-acp.ts): runs there, tools stay here. command/args are filled in. */
  peer: z.object({ id: z.string().min(1), agent: z.string().min(1) }).optional(),
  /** Runs with the API key of this AI provider (`ai.providers`, key in secrets/ai-keys.json; core/ai-keys.ts). */
  keyRef: z.string().optional(),
  /** Another login of the owner's (agents/login-slots.ts): the folder its `env` points the backend's login at. */
  loginDir: z.string().optional(),
  /**
   * Each omem user can run it with an account of their own (docs/v2/agent-accounts.md §2), like the
   * catalog's backends: keyed by its source (`source`, else its id). Not for a device's agent or an API key.
   */
  account: accountSpecSchema.optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

/** Feishu emoji_type names by what they say about an answer (checked against real events; `feedback.emoji`). */
export const DEFAULT_FEEDBACK_EMOJI = {
  positive: ["THUMBSUP", "APPLAUSE", "PRAISE", "AWESOMEN", "FINGERHEART", "HEART", "MUSCLE", "Fire", "HUNDRED", "100", "LGTM"],
  negative: ["ThumbsDown", "CrossMark", "FACEPALM", "SPEECHLESS", "WHAT", "DIZZY", "ERROR"],
  ack: ["OK", "DONE", "Get", "CheckMark", "JIAYI", "OnIt", "Yes"],
};

export const roleNames = [
  "commit-claim",
  "item-follow",
  "flow-reconcile",
  "assistant",
  "ingest",
  "archivist",
  "archive-rule-writer",
  "wiki-planner",
  "wiki-writer",
  "wiki-linter",
  "wiki-organizer",
  "wiki-checker",
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
  "note-reviewer",
  "memory-organizer",
  "skill-organizer",
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
  "business-analyst",
  "designer",
  "mention-triage",
  "work-state",
  "listen-coach",
  "outcome-reviewer",
  "first-look",
] as const;
export type RoleName = (typeof roleNames)[number];

/**
 * Roles whose job is keeping the knowledge in order (taking material in, writing and checking pages,
 * reviewing and filing memories). When they look memories up it is to avoid writing one twice, not to
 * answer with it, so recall accounting keeps them apart (memory/recall-stats.ts) and their runs are
 * not handed memories unasked (runner.ts).
 */
export const upkeepRoles: ReadonlySet<string> = new Set<RoleName>([
  "ingest", "archivist", "archive-rule-writer", "wiki-planner", "wiki-writer", "wiki-linter", "wiki-organizer", "wiki-checker",
  "dreamer", "curator", "triager", "distiller", "summarizer", "memory-reviewer", "note-reviewer", "memory-organizer", "skill-organizer", "item-keeper", "coach",
  "replay-judge", "kb-scout", "req-splitter", "tutor", "work-state",
]);

/**
 * Nightly replay (src/agents/replay.ts, docs/v2/replay.md). Signals a past run shows, and the axes a
 * variant arm may change: retrieval (R1 deep search, R2 related spaces, R3 a research profile), source
 * levels (S1 focus+reference only, S2 ignore too), memories (M1 without the ones the run touched, M2
 * none, M3 without digest-written experience), the Wiki (W1 no pages, W2 pages first), the model
 * (A1 one step down, A2 one step up). `random` picks any axis that applies (a control).
 */
export const REPLAY_SIGNALS = ["negative", "correction", "notFound", "timeout", "slow", "normal", "positive"] as const;
export const REPLAY_AXES = ["R1", "R2", "R3", "S1", "S2", "M1", "M2", "M3", "W1", "W2", "A1", "A2", "K1"] as const;
export type ReplaySignal = (typeof REPLAY_SIGNALS)[number];
export type ReplayAxis = (typeof REPLAY_AXES)[number];
export const DEFAULT_REPLAY_TASK_TYPES = ["事实查询", "汇总计数", "代码路径", "时间线与变化", "排查", "写作"];
export const DEFAULT_REPLAY_PLAN: Record<ReplaySignal, (ReplayAxis | "random")[]> = {
  negative: ["M1", "K1", "S1", "W1", "A2"],
  correction: ["M1", "K1", "S1", "W1", "A2"],
  notFound: ["S2", "R2", "R1", "R3", "A2"],
  timeout: ["A1"],
  slow: ["K1", "A1", "M3"],
  normal: ["K1", "A1"],
  positive: ["random"],
};
const replayAxes = z.array(z.enum([...REPLAY_AXES, "random"])).max(14);
const replayPlanSchema = z.object(Object.fromEntries(REPLAY_SIGNALS.map((s) => [s, replayAxes.default(DEFAULT_REPLAY_PLAN[s])])) as Record<ReplaySignal, z.ZodDefault<typeof replayAxes>>);

/** Light = today's single reviewer; heavier tiers add independent checks for larger changes. */
export function defaultReviewTiers() {
  return [
    { id: "full", name: "完整", guide: "", checks: ["reviewer", "review-simplify", "review-arch", "review-business", "review-history", "review-style"], maxRounds: 3, lead: true, confirmPlan: true, rotateModels: false,
      when: { any: [{ field: "change.repos", op: "gte", value: 2 }, { field: "change.lines", op: "gte", value: 600 }, { field: "change.paths", op: "contains", value: "migration" }] } },
    { id: "standard", name: "标准", guide: "", checks: ["reviewer", "review-simplify", "review-business"], maxRounds: 3, lead: true, confirmPlan: false, rotateModels: false,
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

const pattern = z.string().max(2000).refine(s => { try { new RegExp(s); return true; } catch { return false; } }, "无效的正则表达式");
const names = z.array(z.string().min(1).max(200)).max(200);
const jsonPattern = z.object({ jsonPath: z.string().max(500).regex(/^\$(?:\.[\w-]+|\[\d+\])*$/), regex: pattern }).strict();
export const operationScopeSchema = z.object({ members: names.optional(), roles: names.optional(), spaces: names.optional(), backends: names.optional() }).strict();
export const operationRuleSchema = z.object({
  id: z.string().min(1).max(200), revision: z.number().int().positive(), enabled: z.boolean(), title: z.string().max(1000).optional(),
  scope: operationScopeSchema.optional(),
  match: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("command"), executable: z.string().max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/), subcommand: names.optional(),
      argv: z.array(z.object({ index: z.number().int().nonnegative(), regex: pattern })).max(100).optional(), argsRegex: pattern.optional() }).strict(),
    z.object({ kind: z.literal("http"), methods: names.optional(), host: z.string().max(255).regex(/^(?:\*\.)?[a-zA-Z0-9.-]+$/), pathRegex: pattern.optional(), body: jsonPattern.optional() }).strict(),
    z.object({ kind: z.literal("file"), operations: z.array(z.enum(["read","write","delete","rename"])).min(1), pathRegex: pattern }).strict(),
    z.object({ kind: z.literal("tool"), server: z.string().optional(), name: z.string().min(1), args: z.array(jsonPattern).max(100).optional() }).strict(),
  ]),
  action: z.enum(["allow","deny","approve","log"]),
  approval: z.object({ approver: z.string().regex(/^(owner|run|user:.+|lark:.+)$/).optional(), waitSeconds: z.number().int().min(1).max(300).optional(),
    expiresSeconds: z.number().int().min(1).max(604800).optional(), approvers: names.optional(), reuse: z.enum(["once","window"]).optional() }).optional(),
  pack: z.object({ name: z.string(), version: z.string(), ruleId: z.string() }).optional(),
});
export type OperationRule = z.infer<typeof operationRuleSchema>;
export const operationRulesSchema = z.array(operationRuleSchema).max(200).refine(rs => new Set(rs.map(r => r.id)).size === rs.length, "规则 id 重复");
export function migrateCommands(rules: CommandRule[]): OperationRule[] {
  return rules.map((r, i) => ({ id: `command-${i+1}`, revision: 1, enabled: true, title: r.note,
    match: { kind: "command", executable: r.command, argsRegex: r.args }, action: r.action,
    approval: { approver: r.approver, approvers: r.approvers, waitSeconds: r.waitSeconds, expiresSeconds: Math.round(r.expireHours*3600), reuse: r.reuse } }));
}
export function legacyCommand(r: OperationRule): CommandRule | undefined {
  const m = r.match;
  if (m.kind !== "command" || !r.enabled || r.scope || r.pack || m.argv || m.subcommand || r.action === "log" || (r.approval?.waitSeconds ?? 90)<5 || (r.approval?.expiresSeconds ?? 86400)<360) return;
  return { command: m.executable, args: m.argsRegex ?? "", action: r.action, note: r.title ?? "", approver: r.approval?.approver ?? "owner",
    approvers: r.approval?.approvers ?? [], waitSeconds: r.approval?.waitSeconds ?? 90, expireHours: (r.approval?.expiresSeconds ?? 86400)/3600, reuse: r.approval?.reuse ?? "once" };
}

export const capturePolicy = z.enum(["ingest", "involved", "store", "skip"]);
export type CapturePolicy = z.infer<typeof capturePolicy>;

const outletSetting = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/),
  minUrgency: z.enum(["later", "normal", "urgent"]).default("later"),
  askKinds: z.array(z.string().min(1).max(100)).max(64).default(["question"]),
}).strict();
export const outletSettings = z.array(outletSetting).max(64).refine(xs => new Set(xs.map(x => x.id)).size === xs.length, "出口重复");
export const egressSchema = z.object({
  mode: z.enum(["strict-only", "all-sandboxed", "off"]).default("strict-only"),
  default: z.enum(["allow","approve","deny"]).default("allow"),
  tunnelWhenUnsure: z.enum(["allow","approve","deny"]).default("allow"),
  inspect: z.array(z.string().max(253).regex(/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i)).max(32).default([]),
  waitSeconds: z.number().int().min(1).max(300).default(90),
});

// Search API providers receive query text and the passages being indexed or ranked.
export const searchApiFields = {
  // Any http(s) address: a model server on localhost or the LAN is as usual as a hosted one.
  url: z.url({ protocol: /^https?$/ }).optional(),
  keyRef: z.string().min(1).optional(),
  apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  timeoutMs: z.number().int().min(1).max(120_000).default(5000),
};

export const sandboxPaths = z.array(z.string().trim().min(1).max(1024)).max(32);
export const ownSandboxSchema = z.object({
  mode: z.enum(["off", "prefer", "require"]).default("off"),
  writable: sandboxPaths.default([]),
  hidden: sandboxPaths.default([]),
}).strict();
export const fullAccessMode = z.enum(["per-role", "sandboxed", "all"]);

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
  plugins: z.object({ eventSpaces: z.record(z.string(), z.array(z.string())).default({}), icons: z.record(z.string(), z.string()).default({}), disabled: z.array(z.string()).default([]) }).default({ eventSpaces: {}, icons: {}, disabled: [] }),
  remoteGrants: z.object({ defaultHours: z.number().positive().max(8760).default(2), maxHours: z.number().positive().max(8760).default(24) }).default({ defaultHours: 2, maxHours: 24 }),
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
  /**
   * The owner's time zone (IANA name): schedules, quiet hours, daily counts and every time shown in
   * the web pages and messages. Starts as the machine's own zone; a name this runtime does not know
   * falls back to it.
   */
  timezone: z.string().default(systemZone).transform((z) => (validZone(z) ? z : systemZone())),
  language: z.string().default("zh-CN"),
  /** Background runs (ingest, wiki, dream…) at the same time; each model's own limit is agents.capacity. */
  concurrency: z.number().int().min(1).max(32).default(2),
  /** Conversation turns at the same time (one per thread; threads run in parallel). */
  interactiveConcurrency: z.number().int().min(1).max(16).default(4),
  dream: z.object({
    consolidate: z.object({
      min: z.number().int().min(1).default(30),
      perNight: z.number().int().min(0).default(2),
    }).default(() => ({ min: 30, perNight: 2 })),
  }).default(() => ({ consolidate: { min: 30, perNight: 2 } })),
  sessions: z
    .object({
      turnContextChars: z.number().int().min(256).default(1800),
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
    .default(() => ({ turnContextChars: 1800, liveMinutes: 20, maxLive: 3, maxTurns: 40, background: { enabled: true, liveMinutes: 60, maxLive: 3, maxContextRatio: 0.6, maxContextTokens: 120_000 }, codeResumeMaxTokens: 100_000, idleHours: 12, mergeMs: 1500, contentWaitMs: 15_000 })),
  agents: z
    .object({
      default: z.string().optional(),
      cloudTools: cloudToolsSchema.default(() => cloudToolsSchema.parse({})),
      tiers: z.object({
        strong: z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() }).optional(),
        standard: z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() }).optional(),
        cheap: z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() }).optional(),
      }).default({}),
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
      workBoard: z.object({ concurrency: z.number().int().min(1).max(6).default(3), deadlineMinutes: z.number().int().positive().default(30) }).default({ concurrency: 3, deadlineMinutes: 30 }),
      autoAdvance: z.object({ turns: z.number().int().min(0).max(50).default(6), codeRounds: z.number().int().min(1).max(20).default(3), codeRoundsMax: z.number().int().min(1).max(50).default(12), taskLoop: z.boolean().default(true), parallelCoders: z.number().int().min(0).max(8).default(3), preCheck: z.boolean().default(true) }).default({ turns: 6, codeRounds: 3, codeRoundsMax: 12, taskLoop: true, parallelCoders: 3, preCheck: true }),
      /**
       * How many runs one model of one source takes at a time (`perModel`, or a `limits` entry for a
       * source / model; 0 = do not use it). A role run whose model is full takes the first free one of
       * its other configured backends (roleModels) and the fallbacks, else waits.
       * Plan usage limits (agents/quota.ts): an account with a window used past `quotaAvoidAbove`
       * percent (100: never), or a window of a day or longer whose remaining percent per day until
       * its reset is under `quotaPerDayBelow` (0: not looked at), goes after the others in a role
       * run's choices and is marked `avoid` for the assistant's own choice. `quotaBySource` sets
       * either threshold for one account (its source: the ACP agent and its CLI fallback are one).
       */
      capacity: z.object({
        perModel: z.number().int().min(1).max(32).default(3),
        /** `perDay`: runs a day on this model at most (omem's own count, the owner's time zone), for providers that cap some models per day without reporting what is left. */
        limits: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), max: z.number().int().min(0).max(32), perDay: z.number().int().min(0).max(100000).optional() })).max(100).default([]),
        quotaAvoidAbove: z.number().min(50).max(100).default(90),
        quotaPerDayBelow: z.number().min(0).max(100).default(0),
        quotaBySource: z.record(z.string(), z.object({ avoidAbove: z.number().min(50).max(100).optional(), perDayBelow: z.number().min(0).max(100).optional() })).default({}),
      }).default(() => ({ perModel: 3, limits: [], quotaAvoidAbove: 90, quotaPerDayBelow: 0, quotaBySource: {} })),
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
      /**
       * What reaches the chat while agents work (channels/lark-work-progress.ts, lark-agent-cot.ts):
       * `messages` — `milestones`: a multi-agent work keeps one progress card in its topic, updated in
       * place, and posts only when it is done, needs the owner, or answers the owner's words there
       * (a coordination turn that only handed out the next round stays in the work conversation);
       * `all`: every coordination reply is posted. `thinking` — native thinking bubbles: `all` for
       * every run, `own` only for the turn answering the owner's own message, `off` never.
       */
      progress: z.object({ messages: z.enum(["milestones", "all"]).default("milestones"), thinking: z.enum(["all", "own", "off"]).default("own") }).default({ messages: "milestones", thinking: "own" }),
      profiles: z.array(agentProfileSchema).default([]),
      networkPolicies: networkPoliciesSchema,
      ownSandbox: ownSandboxSchema.default({ mode: "off", writable: [], hidden: [] }),
      fullAccess: fullAccessMode.default("per-role"),
      accountIsolation: z.enum(["prefer", "require"]).default("prefer"),
      /**
       * Members' runs on a backend that can use their own account (docs/v2/agent-accounts.md), when
       * they have not logged in to it: `owner` borrows the owner's login (as before), `own` fails the
       * run and tells them to log in, `own-or-other` moves the run to another backend they are logged
       * in to or may borrow (the run's fallback order). Keyed by the account backend (catalog id:
       * codex, claude, traex, doubao-cli). Only on machines that can start the sandbox (agents/sandbox.ts).
       */
      accountsDefault: z.enum(["owner", "own", "own-or-other"]).default("owner"),
      accounts: z.record(z.string(), z.enum(["owner", "own", "own-or-other"])).default({}),
    })
    .default(() => ({ cloudTools: cloudToolsSchema.parse({}), ownSandbox: { mode: "off" as const, writable: [], hidden: [] }, fullAccess: "per-role" as const, accountIsolation: "prefer" as const, accountsDefault: "owner" as const, accounts: {}, tiers: {}, roles: {}, roleModels: {}, fallback: [], networkPolicies: [], queueTimeoutMinutes: 30, workBoard: { concurrency: 3, deadlineMinutes: 30 }, autoAdvance: { turns: 6, codeRounds: 3, codeRoundsMax: 12, taskLoop: true, parallelCoders: 3, preCheck: true }, design: { mode: "auto" as const, confirm: "owner" as const }, progress: { messages: "milestones" as const, thinking: "own" as const }, capacity: { perModel: 3, limits: [], quotaAvoidAbove: 90, quotaPerDayBelow: 0, quotaBySource: {} }, routing: { automatic: true, guidance: "", candidates: [], choose: { conversation: "decision" as const, rules: "decision" as const, tasks: "off" as const }, pinnedFallback: "unavailable" as const }, profiles: [] })),
  /**
   * omem tools an agent may only use with the owner's OK (e.g. lark_send, apply_code_run, forget):
   * the call waits for approval on a card or in the web, a refusal's reason goes back to the agent.
   */
  /**
   * Code review after a delegation (docs/v2/review.md): ordered tiers, the first whose condition
   * matches the change decides which review checks run; checks are built-in review roles or agent
   * specs. Conditions use the rule condition shape and are validated in src/agents/review.ts.
   */
  credentials: z.object({
    lending: z.enum(["auto", "confirm", "off"]).default("auto"),
    /**
     * With lending "auto": a member's declared read-only command uses their own login first; when it
     * gives nothing usable (no login, expired, no permission) they are asked to authorize and the
     * owner's login (if lent to them) answers now — without the precheck that they could read it.
     */
    ownerFallback: z.boolean().default(false),
    confirm: z.object({ inviteAsOwner: z.boolean().default(false) }).default({ inviteAsOwner: false }),
  }).default({ lending: "auto", ownerFallback: false, confirm: { inviteAsOwner: false } }),
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
      /** Accepted review findings may become curated conventions of one repository. */
      lessons: z.object({ auto: z.boolean().default(true), max: z.number().int().min(1).max(100).default(30) }).default({ auto: true, max: 30 }).optional(),
      /** With a lead, rounds re-review only the checks the fixes touch; every this many rounds all run again. */
      rereviewAllEvery: z.number().int().min(1).max(10).default(2),
      /** Prefer a different maker than the coder; require only adds a warning when unavailable. */
      crossFamily: z.enum(["off", "prefer", "require"]).optional(),
      /** The models review rounds rotate through (tiers with `rotateModels`, or the owner's choice for a delegation). */
      rotation: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })).max(12).optional(),
    })
    .default(() => ({ tiers: defaultReviewTiers(), checks: {}, lessons: { auto: true, max: 30 }, rereviewAllEvery: 2, rotation: [], crossFamily: "prefer" as const })),
  /**
   * Tools that need the owner (agents/approval-ladder.ts): `tools` wait for an OK every time; `report`
   * run and the owner is told afterwards. After `promoteAfter` approvals in a row of a tool in `tools`
   * the owner is asked once whether it may move to `report` (0: never asked).
   */
  approvals: z
    .object({ tools: z.array(z.string()).default([]), report: z.array(z.string()).optional(), promoteAfter: z.number().int().min(0).max(100).optional(), waitSeconds: z.number().int().min(0).max(50).default(40) })
    .default({ tools: [], waitSeconds: 40 }),
  /** Questions, suggestions and approvals nobody answered for this many days lapse (agents/ask-expiry.ts); 0 keeps them. */
  asks: z.object({ staleDays: z.number().int().min(0).max(365).default(7) }).default({ staleDays: 7 }),
  /**
   * Material leaving the owner's personal space (src/sources/homing.ts): `autoMove` lets the archivist
   * move what it judged to belong to a business space (off: its judgement waits for the owner);
   * `nightly` caps how many sources the nightly check hands it again.
   */
  archive: z.object({ autoMove: z.boolean().default(true), nightly: z.number().int().min(0).max(500).default(60) }).default({ autoMove: true, nightly: 60 }),
  /**
   * Commands an agent's processes may not run unchecked (docs/v2/command-gate.md): a wrapper of the
   * same name in front of PATH asks omem first. Only the owner changes this (PUT /api/security/command-rules).
   */
  security: z.object({ egress: egressSchema.optional(), operationRules: operationRulesSchema.optional(), commandRules: z.array(commandRuleSchema).max(200).optional() }).default({}).transform(s => {
    const operationRules = s.operationRules ?? migrateCommands(s.commandRules ?? []);
    return { egress: s.egress ?? egressSchema.parse({}), operationRules, commandRules: operationRules.flatMap(r => legacyCommand(r) ?? []) };
  }),
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
  node: z.object({
    id: z.string().optional(),
    acceptWork: z.enum(["off", "read", "write"]).optional(),
    acceptWorkFrom: z.record(z.string().regex(/^[0-9a-f]{16}$/), z.enum(["off", "read", "write"])).optional(),
  }).default({}),
  /**
   * Copies of other devices' data kept here by themselves (src/core/peer-backup.ts): the device, the
   * data directory its data is pulled into (not this instance's own), how many hours apart, and what
   * besides the database. Looked at every twenty minutes; a device that is away is tried again then.
   */
  backups: z.array(z.object({ peer: z.string().min(1), to: z.string().min(1), everyHours: z.number().int().min(1).max(720).default(12), /** Once a day from this time on (HH:mm, the configured timezone) instead of every `everyHours`. */ at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), parts: z.array(z.enum(["library", "files", "repos", "runs"])).default(["library", "files", "repos"]) })).default([]),
  /** Memory quality: write-time checks, cross-model review, side-by-side comparison. */
  wiki: z.object({
    coverage: z.object({ nightly: z.number().int().min(0).default(3), perSpace: z.number().int().min(0).default(2) }).default(() => ({ nightly: 3, perSpace: 2 })),
    corrections: z.object({ sweep: z.number().int().min(0).default(15) }).default(() => ({ sweep: 15 })),
    questions: z.object({ nightly: z.number().int().min(0).default(20), expireDays: z.number().int().min(1).default(45) }).default(() => ({ nightly: 20, expireDays: 45 })),
  }).default(() => ({ questions: { nightly: 20, expireDays: 45 }, coverage: { nightly: 3, perSpace: 2 }, corrections: { sweep: 15 } })),
  /** A reply that says nothing (only an intent, an acknowledgement, a way out) goes back to the agent once before it is posted (agents/reply-check.ts). */
  replies: z.object({
    check: z.boolean().default(true),
    /** Reading what was said after a reply to tell whether it helped (agents/reply-outcomes.ts). */
    outcome: z.object({
      enabled: z.boolean().default(true),
      afterHours: z.number().min(1).max(72).default(6),
      threshold: z.number().min(0).max(1).default(0.6),
      /**
       * The nightly second reading (agents/outcome-review.ts): answers one to `days` days old whose label
       * came from the model are read again by the role outcome-reviewer with a day of what followed.
       * At most `max` a night, `batch` to a run; `sample` of them picked at random among confident labels.
       */
      review: z.object({
        enabled: z.boolean().default(true),
        max: z.number().int().min(1).max(200).default(30),
        batch: z.number().int().min(1).max(30).default(10),
        sample: z.number().int().min(0).max(50).default(5),
        days: z.number().int().min(2).max(7).default(3),
      }).default(() => ({ enabled: true, max: 30, batch: 10, sample: 5, days: 3 })),
    }).default(() => ({ enabled: true, afterHours: 6, threshold: 0.6, review: { enabled: true, max: 30, batch: 10, sample: 5, days: 3 } })),
  }).default(() => ({ check: true, outcome: { enabled: true, afterHours: 6, threshold: 0.6, review: { enabled: true, max: 30, batch: 10, sample: 5, days: 3 } } })),
  notes: z.object({
    review: z.object({ enabled: z.boolean().default(true), batch: z.number().int().min(1).max(100).default(20) }).default(() => ({ enabled: true, batch: 20 })),
  }).default(() => ({ review: { enabled: true, batch: 20 } })),
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
      provider: z.string().regex(/^(none|local|openai|api|plugin:[a-z0-9-]+:[a-z0-9-]+)$/).transform(p => p === "openai" ? "api" : p).default("none"),
      /** local: model id or directory for transformers.js. openai: model name. */
      model: z.string().default("Xenova/bge-small-zh-v1.5"),
      /** bge-zh (query prefix + CLS), bge-m3 / bge (CLS), other (mean pooling). Inferred from the model name when absent. */
      family: z.enum(["bge-zh", "bge-m3", "bge", "other"]).optional(),
      ...searchApiFields,
      dimensions: z.number().int().positive().max(65536).optional(),
      batch: z.number().int().min(1).max(256).default(32),
      /** local: keep onnxruntime's CPU memory arena (faster; holds the peak of the largest batch). false gives it back after each batch. */
      memArena: z.boolean().optional(),
    })
    .default({ provider: "none", model: "Xenova/bge-small-zh-v1.5", batch: 32, timeoutMs: 5000, apiKeyEnv: "OPENAI_API_KEY" }),
  search: z.object({
    retrievers: z.array(z.object({
      provider: z.string().min(1),
      spaces: z.array(z.string().min(1)).optional(),
      kinds: z.array(z.enum(["chunk", "page", "memory"])).optional(),
      timeoutMs: z.number().int().min(1).max(15000).default(400),
      limit: z.number().int().min(1).max(100).default(20),
    })).max(32).refine(rows => new Set(rows.map(row => row.provider)).size === rows.length, "召回提供者重复").default([]),
  }).default({ retrievers: [] }),
  /**
   * Reranking (search/rerank.ts): a cross-encoder reads the question with each of the first `top`
   * fused hits and reorders them; passive recall keeps only memories it scores at least
   * the threshold for the scoring provider. Local scores (transformers.js, ONNX) calibrated in docs/v2/evaluation.md.
   */
  rerank: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.string().regex(/^(local|api|plugin:[a-z0-9-]+:[a-z0-9-]+)$/).default("local"),
      /** The external service receives the query and the top documents. */
      api: z.object({ ...searchApiFields, model: z.string().min(1) }).optional(),
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
      pluginPassiveThreshold: z.number().finite().optional(),
    })
    .default({ enabled: false, provider: "local", model: "onnx-community/bge-reranker-v2-m3-ONNX", top: 20, maxTokens: 512, threads: 0, timeoutMs: 10_000, passiveThreshold: 0.5 }),
  documents: z
    .object({
      parserOrder: z.array(z.string()).optional(),
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
      /** Voice: question-page voice input and live conversation, plugin pages' voice (the English plugin's speaking practice). live = GPT-Live, realtime = Realtime API. */
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
       *
       * Several may be named: `provider` / `model` is the first, `others` the rest. `pick: fixed`
       * (the default) asks the first usable one in that order; `random` asks any usable one, so no
       * single provider's limits or habits decide everything. Either way one that is not usable, or
       * fails, is passed over and the next is asked (core/decision.ts).
       */
      decision: z.object({
        provider: z.string().default(""),
        model: z.string().default(""),
        others: z.array(z.object({ provider: z.string().min(1), model: z.string().default("") })).max(8).optional(),
        pick: z.enum(["fixed", "random"]).optional(),
        fallback: z.enum(["general", "none"]).default("general"),
        thresholds: z.object({
          heartbeat: z.number().min(0.5).max(0.99).default(DECISION_SCENES.heartbeat.default),
          watch: z.number().min(0.5).max(0.99).default(DECISION_SCENES.watch.default),
          follow: z.number().min(0.5).max(0.99).default(DECISION_SCENES.follow.default),
          meeting: z.number().min(0.5).max(0.99).default(DECISION_SCENES.meeting.default),
          triage: z.number().min(0.5).max(0.99).default(DECISION_SCENES.triage.default),
          progress: z.number().min(0.5).max(0.99).default(DECISION_SCENES.progress.default),
          item: z.number().min(0.5).max(0.99).default(DECISION_SCENES.item.default),
          firstlook: z.number().min(0.5).max(0.99).default(DECISION_SCENES.firstlook.default),
          "notify-known": z.number().min(0.5).max(0.99).default(DECISION_SCENES["notify-known"].default),
          "flow-blocker": z.number().min(0.5).max(0.99).default(DECISION_SCENES["flow-blocker"].default),
        }).optional(),
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
            /** Whose assistant this bot is (src/agents/assistants.ts): a member's runs as that member; left out, the owner's. `ownerOpenId` is then that person's id in this app. */
            userId: z.string().max(64).optional(),
            /** What the assistant is called and what it is for (shown to the other bots and on the node's card). */
            name: z.string().max(40).optional(),
            description: z.string().max(200).optional(),
            /** Turns a day in this bot's conversations; past it the sender is told to come back tomorrow. */
            dailyRuns: z.number().int().min(1).max(100000).optional(),
          }),
        )
        .default([])
        .refine((bots) => new Set(bots.map((b) => b.id)).size === bots.length, "机器人 id 不能重复"),
      /** Bots @-ing one another in a chat: at most this many hand-offs in a row before a person speaks again. */
      botRelay: z.number().int().min(0).max(20).default(4),
      /** Watched groups: the decision model screens each batch before the handler runs (channels/lark-watch.ts prefilterBatch); a watch may say otherwise. */
      watchPrefilter: z.boolean().default(true),
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
          /** How `/ai` sends as the owner: lark-cli's user identity, or a one-off Doubao session (channels/doubao-send.ts). */
          signedVia: z.enum(["lark-cli", "doubao"]).default("lark-cli"),
        })
        .default({ enabled: false, ai: "/ai", group: "/ai拉群", signature: "（此消息由 AI 代发）", context: 30, signedVia: "lark-cli" }),
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
       * scout's map/ignore proposals take effect in safe mode, creates too in all; off waits for the owner.
       * `origin`: host of the doc links (e.g. https://tenant.larkoffice.com); by default the one most
       * captured docs use.
       */
      knowledge: z
        .object({
          direction: z.string().max(4000).default(""),
          autoApply: z.preprocess((v) => v === true ? "all" : v === false ? "off" : v, z.enum(["off", "safe", "all"]).default("safe")),
          dailyDocs: z.number().int().min(0).max(2000).default(30),
          origin: z.string().url().optional(),
        })
        .default({ direction: "", autoApply: "safe", dailyDocs: 30 }),
    })
    .default({
      enabled: false,
      appSecretEnv: "OMEM_LARK_APP_SECRET",
      webApp: false,
      defaultSpace: "personal",
      bots: [],
      botRelay: 4,
      watchPrefilter: true,
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
      commands: { enabled: false, ai: "/ai", group: "/ai拉群", signature: "（此消息由 AI 代发）", context: 30, signedVia: "lark-cli" },
      invite: { botApproval: false },
      knowledge: { direction: "", autoApply: "safe", dailyDocs: 30 },
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
   * chat is answered in a group of the owner, them and the bot (`p2pVia: group`) or as the owner, signed
   * (`signedVia`: lark-cli, or Doubao where the tenant keeps lark-cli from sending private messages).
   */
  mentions: z
    .object({
      enabled: z.boolean().default(true),
      p2p: z.boolean().default(true),
      delayMinutes: z.number().int().min(0).max(240).default(3),
      /** Which of the owner's own signals mean they have it already: read, an emoji reaction, a reply after it. */
      skipWhen: z.object({ read: z.boolean().default(true), reacted: z.boolean().default(true), replied: z.boolean().default(true) }).default({ read: true, reacted: true, replied: true }),
      timeoutMinutes: z.number().int().min(1).max(60).default(10),
      guidance: z.string().max(4000).default(""),
      noDecision: z.enum(["general", "notify", "handle"]).default("general"),
      perDay: z.object({ triage: z.number().int().min(0).max(1000).default(80), handle: z.number().int().min(0).max(10000).default(1000) }).default({ triage: 80, handle: 1000 }),
      reply: z
        .object({
          lark: z
            .object({
              group: z.enum(["off", "draft", "auto"]).default("off"),
              p2p: z.enum(["off", "draft", "auto"]).default("off"),
              p2pVia: z.enum(["group", "signed"]).default("group"),
              /** `signed` goes out as the owner through lark-cli, or through a one-off Doubao session where lark-cli may not send (channels/doubao-send.ts). */
              signedVia: z.enum(["lark-cli", "doubao"]).default("lark-cli"),
            })
            .default({ group: "off", p2p: "off", p2pVia: "group", signedVia: "lark-cli" }),
          /**
           * After this many drafts in a row sent exactly as drafted (per kind of chat), the owner is asked
           * once whether such replies may go out by themselves (mentions/reply-ladder.ts); 0: never asked.
           * Absent = 10.
           */
          promoteAfter: z.number().int().min(0).max(100).optional(),
        })
        .default({ lark: { group: "off", p2p: "off", p2pVia: "group", signedVia: "lark-cli" } }),
    })
    .default({ enabled: true, p2p: true, delayMinutes: 3, skipWhen: { read: true, reacted: true, replied: true }, timeoutMinutes: 10, guidance: "", noDecision: "general", perDay: { triage: 80, handle: 1000 }, reply: { lark: { group: "off", p2p: "off", p2pVia: "group", signedVia: "lark-cli" } } }),
  /**
   * When omem may push to chat channels. Defaults:
   * - quiet hours: nothing outside urgent/overdue 22:00–09:00 local;
   * - onlyUnread: when the triggering Feishu message is known to be read by the owner, skip it;
   * - firstNudgeDelayMinutes: grace period for a normal, non-overdue item's first
   *   nudge — give the owner time to handle it in their own rhythm; urgent/overdue/scheduled bypass.
   */
  notify: z
    .object({
      outlets: z.record(z.string(), outletSettings).default({}),
      outletAskGrants: z.record(z.string(), z.record(z.string(), z.array(z.string()))).default({}),
      onlyUnread: z.boolean().default(true),
      learnFromReactions: z.boolean().default(true),
      firstNudgeDelayMinutes: z.number().int().min(0).default(30),
      quietStart: z.number().int().min(0).max(23).default(22),
      quietEnd: z.number().int().min(0).max(23).default(9),
      /** When what was sent as `later` (nothing to do now: finished background work, reports) goes out together, HH:mm on the server's clock; empty = at once, like normal ones. */
      laterTimes: z.array(z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/)).max(12).default(["09:30", "13:30", "18:30"]),
      /**
       * One card in the morning (items/today.ts): the lines' next steps, what waits on the owner, what the
       * night's work proposed. Off: the next-step card, the item digest and the nightly line proposals go out
       * on their own, at their own times. `at` is HH:mm in `timezone`.
       */
      today: z.object({ enabled: z.boolean().default(true), at: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/).default("09:30") }).default({ enabled: true, at: "09:30" }),
    })
    .default({ outlets: {}, outletAskGrants: {}, onlyUnread: true, learnFromReactions: true, firstNudgeDelayMinutes: 30, quietStart: 22, quietEnd: 9, laterTimes: ["09:30", "13:30", "18:30"], today: { enabled: true, at: "09:30" } }),
  /**
   * MCP servers the owner set up for agents (Agent 页 → MCP, agents/mcp-servers.ts): a command to
   * start (stdio) or a URL (HTTP). An Agent 档案 names the ones it uses (`mcpServers`), a built-in
   * role in its overlay; only the owner's own runs are given them. `env` / `headers` list the names
   * only: their values are keys and live in the secrets file, never here or in the library's Git.
   * `readOnly`: it only looks things up — the only kind a nightly replay arm is given.
   */
  mcp: z
    .object({
      servers: z
        .record(
          z.string(),
          z.object({
            description: z.string().default(""),
            command: z.string().optional(),
            args: z.array(z.string()).default([]),
            env: z.array(z.string()).default([]),
            url: z.string().optional(),
            headers: z.array(z.string()).default([]),
            readOnly: z.boolean().default(false),
          }),
        )
        .default({}),
    })
    .default(() => ({ servers: {} })),
  /**
   * The nightly audit (quality/audit.ts): pages the agents wrote on their own (while taking material
   * in, fixing pages after a source changed, distilling…) are sampled and read by the checker role.
   * `max` pages a night, at most `perPipeline` from one kind of run, among those written in the last
   * `lookbackDays`. A kind of run whose share of pages without factual findings over `days` days
   * (with at least `minSamples` judged) falls below `threshold` has every page audited, up to
   * `strictMax` a night, until the share is back. `fix`: which pages go back to a writer — those
   * with factual findings (`wrong`), also those with writing findings only (`all`), or none (`off`).
   */
  quality: z
    .object({
      audit: z
        .object({
          enabled: z.boolean().default(true),
          max: z.number().int().min(1).max(100).default(8),
          levels: z.number().int().min(0).max(100).default(6),
          perPipeline: z.number().int().min(1).max(50).default(3),
          strictMax: z.number().int().min(1).max(100).default(12),
          lookbackDays: z.number().int().min(1).max(30).default(3),
          days: z.number().int().min(1).max(90).default(14),
          minSamples: z.number().int().min(1).max(100).default(6),
          threshold: z.number().min(0).max(1).default(0.8),
          fix: z.enum(["off", "wrong", "all"]).default("wrong"),
        })
        .default(() => ({ enabled: true, max: 8, levels: 6, perPipeline: 3, strictMax: 12, lookbackDays: 3, days: 14, minSamples: 6, threshold: 0.8, fix: "wrong" as const })),
    })
    .default(() => ({ audit: { enabled: true, max: 8, levels: 6, perPipeline: 3, strictMax: 12, lookbackDays: 3, days: 14, minSamples: 6, threshold: 0.8, fix: "wrong" as const } })),
  /**
   * The heartbeat (agents/jobs.ts): due reminders are delivered by the host; the agent is only needed
   * when new material may bear on something watched or waited for. `gate: decision` asks the decision
   * model first (agents/heartbeat-gate.ts) and skips the agent on a "no"; what was skipped is handed
   * to the agent in a full sweep at least every `sweepHours`. `off`: the agent looks every time.
   */
  heartbeat: z
    .object({ gate: z.enum(["off", "decision"]).default("decision"), sweepHours: z.number().min(1).max(72).default(12) })
    .default({ gate: "decision", sweepHours: 12 }),
  /**
   * The fast path (docs/v2/first-look.md): where a first look's message goes when a rule action or a
   * 关注 does not say — the triggering chat, the owning user's private chat with the bot, or a card in
   * the group only that user sees (falls back to the private chat when it cannot be sent).
   */
  firstLook: z
    .object({ to: z.enum(["chat", "dm", "ephemeral"]).default("dm") })
    .default({ to: "dm" }),
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
   * The agents' own skill folders (src/agents/agent-skills.ts, docs/v2/agent-skills.md). `takeOver`
   * (off by default): every `everyMinutes` the skills other tools installed there move into the
   * library, grouped, and the folders keep only the omem guide and one hub per group that is on.
   * `extraDirs`: folders to take over besides the known agents' (taken from, never written to).
   * `autoOrganize` (on by default): skills that arrive, whose description changes, or the owner's
   * ungrouped skills once there are many, are handed to the skill-organizer role to group and file.
   */
  agentSkills: z
    .object({
      takeOver: z.boolean().default(false),
      everyMinutes: z.number().int().min(1).max(1440).default(10),
      extraDirs: z.array(z.string().min(1)).max(20).default([]),
      autoOrganize: z.boolean().default(true),
    })
    .default({ takeOver: false, everyMinutes: 10, extraDirs: [], autoOrganize: true }),
  /**
   * Nightly replay (docs/v2/replay.md): the scheduled job `replay` (off by default) picks `max` past
   * questions a night and answers each again as of its time, a baseline re-run against one variant.
   * No token limits: the owner sets how many questions; each arm is an ordinary run with its usual
   * time limit. The judge is the built-in role replay-judge, whose AI the owner must choose first.
   */
  replay: z
    .object({
      skills: z.object({ adoptAfter: z.number().int().min(0).default(2) }).default(() => ({ adoptAfter: 2 })),
      max: z.number().int().min(1).max(20).default(1),
      /** Questions are picked from runs of the last this many days. */
      days: z.number().int().min(1).max(14).default(3),
      /** Task types the judge labels questions with (routing evidence is kept per type). */
      taskTypes: z.array(z.string().trim().min(1).max(20)).min(1).max(20).default(DEFAULT_REPLAY_TASK_TYPES),
      /** Signal → axes to try in order; the first that applies and was not tried on that question is used. */
      plan: replayPlanSchema.default(() => structuredClone(DEFAULT_REPLAY_PLAN)),
      /** The A axis: models from cheaper to stronger. Without it, one effort level down / up on the same model. */
      models: z.array(z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })).max(12).default([]),
    })
    .prefault({}),
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
   * The owner's work state (docs/v2/work-state.md): the nightly `work-state` job hands the role of
   * that name `days` of facts (chats the owner spoke in, documents, coding, items, meetings, asks)
   * and rewrites the page personal/state/work, then updates up to `people` person cards
   * (personal/people/*) of those with new messages. `inject`: a summary of up to `briefChars` goes
   * into the main assistant's turns, the patrol, the triage of 有人找你 and meeting summaries.
   */
  studies: z.object({
    envs: z.array(z.object({
      id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/).refine((s) => s.toLowerCase() !== "local", "local 是内置环境"),
      name: z.string().trim().min(1).max(100), note: z.string().max(12000),
      ai: z.union([z.enum(["strong", "standard", "cheap"]), z.object({ profile: z.string().min(1), model: z.string().optional(), effort: z.string().optional() })]).optional(),
      thirdParty: z.boolean(),
      /** Trials in this environment go to this paired device of the owner's (studies/remote.ts); it runs them with its own AI. */
      peer: z.string().trim().min(1).max(80).optional(),
    })).default([]).superRefine((envs, ctx) => {
      const names = new Set(["local", "本机"]);
      for (const e of envs) {
        const keys = [...new Set([e.id.toLowerCase(), e.name.toLowerCase()])];
        if (keys.some((k) => names.has(k))) ctx.addIssue({ code: "custom", message: "执行环境的 id 和名字不能重名或占用本机" });
        keys.forEach((k) => names.add(k));
      }
    }),
  }).default(() => ({ envs: [] })),
  flows: z.object({
    commits: z.object({ enabled: z.boolean().default(true), quietMinutes: z.number().min(0).max(1440).default(30) }).default(() => ({ enabled: true, quietMinutes: 30 })),
    gateLadder: z.object({ enabled: z.boolean().default(true), after: z.number().int().min(1).max(1000).default(5) }).default(() => ({ enabled: true, after: 5 })),
    follow: z.object({
      enabled: z.boolean().default(true),
      quietMinutes: z.number().min(0).max(1440).default(20),
      maxMessages: z.number().int().min(1).max(1000).default(30),
      maxRunsPerDay: z.number().int().min(0).max(100000).default(12),
    }).default(() => ({ enabled: true, quietMinutes: 20, maxMessages: 30, maxRunsPerDay: 12 })),
    idleRounds: z.number().int().min(1).max(100).default(3),
    autoAdvance: z.number().int().min(1).max(20).default(3),
    staleDays: z.number().min(1).max(365).default(2),
  }).default(() => ({ commits: { enabled: true, quietMinutes: 30 }, autoAdvance: 3, staleDays: 2, idleRounds: 3, gateLadder: { enabled: true, after: 5 }, follow: { enabled: true, quietMinutes: 20, maxMessages: 30, maxRunsPerDay: 12 } })),
  /**
   * Work lines (items/lifecycle.ts): a line that looks done is watched `watchDays` (its 关注 still reads its
   * groups, its metrics are still taken) and ends by itself once nothing new came up in that time.
   */
  workLines: z.object({
    watchDays: z.number().int().min(1).max(60).default(14),
  }).default(() => ({ watchDays: 14 })),
  workState: z
    .object({
      days: z.number().int().min(3).max(60).default(21),
      people: z.number().int().min(0).max(50).default(8),
      briefChars: z.number().int().min(100).max(2000).default(500),
      inject: z.boolean().default(true),
    })
    .default({ days: 21, people: 8, briefChars: 500, inject: true }),
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
  { id: "traex-cli", name: "TraeX (CLI)", transport: "codex-cli", command: "traex", args: [], model: "gpt-6.1-sol", effort: "low", env: {}, idleTimeoutMs: 600_000, source: "traex", stateLayout: "traex" },
  { id: "claude-cli", name: "Claude Code (CLI)", transport: "claude-cli", command: "claude", args: [], env: {}, idleTimeoutMs: 600_000, source: "claude", stateLayout: "claude" },
  { id: "codex-cli", name: "Codex (CLI)", transport: "codex-cli", command: "codex", args: [], model: "gpt-6.1-sol", effort: "low", env: {}, idleTimeoutMs: 600_000, source: "codex", stateLayout: "codex" },
];
/** Doubao through its OpenAPI: no local command (`command` is only a label); available once authorized. */
const doubaoProfile: AgentProfile = { id: "doubao", name: "豆包 (OpenAPI)", transport: "doubao", command: "doubao-openapi", args: [], env: {}, idleTimeoutMs: 600_000 };
/** The Doubao CLI prints nothing until a turn ends, so the idle limit is the whole turn's. */
const doubaoCliProfile: AgentProfile = { id: "doubao-cli", name: "豆包 (CLI)", transport: "doubao-cli", command: "doubao", args: [], env: {}, idleTimeoutMs: 1_800_000 };

/** ACP agents from the catalog (codex, claude, gemini, copilot, …) plus the one-shot CLI fallbacks. Order = auto-pick priority. */
export const builtinProfiles: AgentProfile[] = [...acpCatalog.slice(0, 3).map(catalogProfile), ...cliProfiles, ...acpCatalog.slice(3).map(catalogProfile), doubaoCliProfile, doubaoProfile];

export { omemHome };

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
  config.ai.decision.thresholds ??= decisionThresholdDefaults();
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
 * becomes the merged result (callers then copy it into `app.config`). A synchronous validation
 * callback can return a response based on that result. If it throws, the save is not applied.
 */
export function saveConfig(config: Config, home?: string): void;
export function saveConfig<T>(config: Config, home: string, validate: (candidate: Config) => T): T;
export function saveConfig<T>(config: Config, home = omemHome(), validate?: (candidate: Config) => T) {
  const save = prepareConfigSave(config, home);
  const result = validate?.(save.candidate);
  save.write();
  return result;
}

/** Inspect the merged settings and synchronously commit that same candidate after validation. */
export function prepareConfigSave(config: Config, home: string) {
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
  if (parsed && process.env.OMEM_PORT) parsed.port = Number(process.env.OMEM_PORT);
  const candidate = parsed ?? config;
  function write() {
    mkdirSync(home, { recursive: true });
    const security = candidate.security;
    const persisted = { ...(merged as Config), security: { egress: security.egress, operationRules: security.operationRules } };
    writeFileSync(path, JSON.stringify(persisted, null, 2) + "\n");
    if (parsed) {
      // Only the sections the file changed are replaced: others keep their objects (some are held by reference).
      for (const k of Object.keys(parsed) as (keyof Config)[]) if (!same(config[k], parsed[k])) (config as Record<string, unknown>)[k] = parsed[k];
    }
    loadedAs.set(resolve(home), structuredClone(config));
  }
  return { candidate, write };
}

export function allProfiles(config: Config): AgentProfile[] {
  const byId = new Map(builtinProfiles.map((p) => [p.id, p]));
  const referenced = new Set([config.agents.default, ...Object.values(config.agents.roles),
    ...Object.values(config.agents.tiers).map(t => t.profile),
    ...Object.values(config.agents.roleModels).flatMap(models => Object.keys(models)),
    ...config.agents.fallback.map(p => p.profile), ...config.agents.routing.candidates.map(p => p.profile),
    ...(config.review.rotation ?? []).map(p => p.profile),
  ].filter((v): v is string => !!v));
  for (const p of referencedPluginProfiles(referenced)) byId.set(p.id, p);
  for (const e of acpCatalog.filter(e => e.plugin)) byId.set(e.id, catalogProfile(e));
  for (const p of keyedProfiles(config)) byId.set(p.id, p);
  for (const p of config.agents.profiles) {
    const profile = p.peer ? peerProfile(p) : upgradeProfileArgs(p);
    const twin = p.peer ? undefined : sameProgramBuiltin(profile);
    // A saved backend that runs a built-in entry's program the same way is that backend under
    // another name: it takes the entry's place (unless the entry's own id is in use) and shares its
    // quota, login and account folder.
    if (twin && !referenced.has(twin.id) && !config.agents.profiles.some(o => o.id === twin.id)) {
      byId.delete(twin.id);
      byId.set(p.id, { ...profile, source: profile.source ?? twin.source ?? twin.id });
    } else byId.set(p.id, profile);
  }
  return [...byId.values()];
}

/**
 * The built-in entry whose program a saved profile runs: the same command name (a path to it
 * counts), the same arguments, no environment of its own. Programs omem downloaded from the ACP
 * registry (under <home>/agents/<id>/<version>/) are their own packages and never match.
 */
function sameProgramBuiltin(p: AgentProfile): AgentProfile | undefined {
  if (p.source || p.keyRef || Object.keys(p.env ?? {}).length || /[\\/]agents[\\/][^\\/]+[\\/][^\\/]+[\\/]/.test(p.command)) return undefined;
  const name = basename(p.command).replace(/\.(exe|cmd|bat|ps1)$/i, "");
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  return builtinProfiles.find(b => b.id !== p.id && b.transport === p.transport && !Object.keys(b.env ?? {}).length && norm(b.command) === norm(name) &&
    JSON.stringify(b.args) === JSON.stringify(p.args));
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
export function peerProfile(p: AgentProfile): AgentProfile {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = resolve(here, "../cli.js");
  const cli = existsSync(js) ? js : resolve(here, "../cli.ts");
  return { ...p, transport: "acp", command: process.execPath, args: [cli, "peer", "acp", p.peer!.id, p.peer!.agent], source: p.source ?? `peer:${p.peer!.id}:${p.peer!.agent}` };
}
