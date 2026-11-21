import { chatName } from "../agents/owner-now.ts";
import { currentRules } from "../agents/operation-policy.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { OWNER, userName } from "../core/users.ts";
import { json, truncate } from "../core/util.ts";

/**
 * The audit trail as a page shows it (设置 → 安全 → 记录): what was done in plain words, to whom or
 * what by name, how it ended, newest first. `audit_events` holds whatever each caller wrote (an action
 * name, a target id, free-form detail); this is the one place that reads it back for a person.
 *
 * Groups: `ops` what the operation rules stopped, asked about or let through and who approved;
 * `identity` what went out in the owner's name or changed how that is decided; `access` people,
 * roles, logins, tokens and shares; `other` the rest (connections, plugins, saved settings).
 */
export const AUDIT_GROUPS = ["ops", "identity", "access", "other"] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];
export type AuditTone = "ok" | "warn" | "danger";
export type AuditRow = {
  id: number; at: string; action: string; group: AuditGroup;
  /** Who did it: a member's name, “你” for the owner seen by the owner, “omem” for the host itself. */
  actor: string;
  /** What happened, a short phrase. */
  text: string;
  /** What it was done to, by name when the id is known: a person, a group, a space, a command line. */
  target: string;
  /** How it ended or the one fact worth a glance: a result, a reason, a role. */
  result: string | null;
  tone: AuditTone | null;
  runId: string | null;
  /** The operation rule that decided it, by its title. */
  rule: string | null;
  /** Everything the caller recorded, for the owner only. */
  detail: Record<string, unknown>;
};

const OPS = "(action like 'command.%' or action like 'http.%' or action like 'file.%' or action like 'tool.%' or action like 'operation.%')";
const IDENTITY = "((action like 'lark.%' and action not like 'lark.identity.%') or action like 'mention-reply.%')";
const ACCESS = "(action like 'user.%' or action like 'role.%' or action like 'space.%' or action like 'token.%' or action like 'invite.%' or action like 'identity.%' or action like 'lark.identity.%' or action like 'share.%' or action like 'agent-accounts.%')";
const WHERE: Record<AuditGroup, string> = { ops: OPS, identity: IDENTITY, access: ACCESS, other: `not (${OPS} or ${IDENTITY} or ${ACCESS})` };
const groupOf = (action: string): AuditGroup =>
  /^(command|http|file|tool|operation)\./.test(action) ? "ops"
    : /^lark\.identity\./.test(action) ? "access"
      : /^(lark|mention-reply)\./.test(action) ? "identity"
        : /^(user|role|space|token|invite|identity|share|agent-accounts)\./.test(action) ? "access" : "other";

/** What each recorded action is, in the owner's words. Anything not listed shows its action name. */
const LABELS: Record<string, string> = {
  "lark.mention-reply": "回复了找你的人",
  "lark.mention-reply.drop": "给找你的人的回复没有发出",
  "lark.command-reply": "私聊指令：以你的身份回复",
  "lark.invite": "拉人或机器人进群",
  "lark.meeting-answer": "在会议里回答了提问",
  "lark.watch.reply": "关注的回复方式",
  "lark.watch.stop": "停止关注",
  "lark.doubao-send.test": "经豆包给自己试发",
  "lark.identity.claim": "认出了成员的飞书身份",
  "mention-reply.promote": "“有人找你”改成自动回复",
  "mention-reply.demote": "“有人找你”退回草稿",
  "user.create": "添加成员", "user.email": "改成员的邮箱", "user.role": "改成员的角色", "user.approve": "批准成员加入",
  "user.disable": "停用成员", "user.enable": "恢复成员", "user.login-any": "成员的登录方式", "user.sign-out": "让成员退出登录",
  "space.member": "空间成员", "space.remove": "移出空间",
  "role.save": "保存角色", "role.delete": "删除角色",
  "token.cli": "命令行登录", "token.revoke": "撤销令牌",
  "invite.create": "创建邀请", "invite.revoke": "撤销邀请",
  "identity.unlink": "解绑登录身份", "share.review": "分享评审",
  "agent-accounts.remove-all": "清掉成员的 AI 账号",
  "connection.add": "连接应用", "connection.remove": "断开应用", "connection.capture": "应用的采集设置",
  "connection.feature.on": "打开应用的功能", "connection.feature.off": "关掉应用的功能", "connector.app": "配置连接器",
  "plugin.hook": "插件回调", "object.action": "对平台上的对象操作",
  "operation.rules": "保存操作规则", "command.rules": "保存命令规则",
  "operation.pack.enable": "启用规则包", "operation.pack.disable": "停用规则包", "operation.approve": "批准了一次操作",
  "agents.network-policies": "保存 AI 后端的网络条件",
};
const OP_KIND: Record<string, string> = { command: "命令", http: "HTTP 请求", file: "文件", tool: "工具" };
/** An operation's last word: what the rules or the approver did with it. */
const OP_VERB: Record<string, { text: string; tone: AuditTone | null }> = {
  allow: { text: "放行", tone: "ok" }, deny: { text: "拒绝", tone: "danger" }, approve: { text: "批准", tone: "ok" },
  ask: { text: "等批准", tone: "warn" }, pending: { text: "还没批准，先返回", tone: "warn" },
  expire: { text: "审批过期，没有放行", tone: "danger" }, reject: { text: "没有批准", tone: "danger" }, log: { text: "只记录", tone: null },
};
/** Results some callers wrote as codes. */
const RESULT: Record<string, string> = {
  denied: "拒绝", refused: "没有批准", pending: "等批准", approved: "已批准，放行", allowed: "放行",
  stale: "之前的批准已经不适用", "approver unavailable": "找不到能批准的人",
};

/** A rule without a title, by what it matches. */
function ruleName(m: { kind: string; executable?: string; subcommand?: string[]; host?: string; methods?: string[]; pathRegex?: string; name?: string }) {
  if (m.kind === "command") return [m.executable, ...(m.subcommand ?? [])].join(" ");
  if (m.kind === "http") return [m.methods?.join("/"), m.host].filter(Boolean).join(" ");
  return (m.kind === "file" ? m.pathRegex : m.name) ?? m.kind;
}

type Raw = { id: number; at: string; actor: string; action: string; target: string; detail: string };
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function names(app: App, viewer: string) {
  const users = new Map<string, string>(), spaces = new Map<string, string | null>(), chats = new Map<string, string>();
  const user = (id: string) => {
    if (id === "omem" || id === "system" || id === "hook" || id === "agent") return id === "agent" ? "助手" : "omem";
    if (id === viewer) return "你";
    if (!users.has(id)) users.set(id, one(app.db, "select 1 from users where id = ?", id) ? userName(app, id) : id);
    return users.get(id)!;
  };
  const space = (id: string) => {
    if (!spaces.has(id)) spaces.set(id, one<{ name: string }>(app.db, "select name from spaces where id = ?", id)?.name ?? null);
    return spaces.get(id) ?? null;
  };
  const chat = (id: string) => {
    if (!chats.has(id)) chats.set(id, chatName(app, id));
    return chats.get(id)!;
  };
  /** A target id as a person reads it: a member, a group, a space; otherwise as recorded. */
  const target = (raw: string) => {
    if (!raw) return "";
    if (/^o[cu]_\w+$/.test(raw)) return chat(raw);
    if (one(app.db, "select 1 from users where id = ?", raw)) return user(raw);
    return space(raw) ?? raw;
  };
  return { user, target };
}

function describe(app: App, r: Raw, d: Record<string, unknown>, n: ReturnType<typeof names>, rules: Map<string, string>): Pick<AuditRow, "text" | "target" | "result" | "tone" | "rule" | "runId"> {
  const runId = str(d.runId) ?? str(d.run);
  const op = /^(command|http|file|tool)\.([a-z]+)$/.exec(r.action);
  if (op) {
    const verb = OP_VERB[op[2]] ?? { text: op[2], tone: null };
    // The rules deciding “要批准” is a question, not yet an answer.
    const asked = op[2] === "approve" && d.result === "策略判定";
    const said = str(d.result);
    return {
      text: `${OP_KIND[op[1]]} · ${asked ? "要批准" : verb.text}`,
      target: str(d.commandLine) ?? r.target,
      result: !said || said === "策略判定" ? null : RESULT[said] ?? said,
      tone: asked ? "warn" : said && /^(denied|refused|stale|approver unavailable)$/.test(said) ? "danger" : verb.tone,
      rule: str(d.ruleId) ? rules.get(String(d.ruleId)) ?? null : null,
      runId,
    };
  }
  const base = { text: LABELS[r.action] ?? r.action, target: n.target(r.target), tone: null as AuditTone | null, rule: null as string | null, runId };
  switch (r.action) {
    case "operation.approve":
      return { ...base, target: r.target, tone: "ok", rule: str(d.ruleId) ? rules.get(String(d.ruleId)) ?? null : null, result: str(d.member) ? `给 ${n.user(String(d.member))}` : null };
    case "lark.mention-reply":
      return { ...base, text: d.by === "owner" ? "你点了发送：回复找你的人" : "自动回复了找你的人", result: str(d.text) ? truncate(String(d.text), 120) : null };
    case "lark.mention-reply.drop":
      return { ...base, tone: "warn", result: str(d.reason) };
    case "lark.command-reply":
      return { ...base, tone: d.ok === false ? "danger" : null, result: str(d.problem) ?? (str(d.text) ? truncate(String(d.text), 120) : null) };
    case "lark.watch.reply":
      return { ...base, target: one<{ name: string }>(app.db, "select name from listen_contexts where id = ?", r.target)?.name ?? r.target, result: d.reply === "auto" ? "以后直接发" : "先给你看" };
    case "lark.watch.stop":
      return { ...base, target: one<{ name: string }>(app.db, "select name from listen_contexts where id = ?", r.target)?.name ?? r.target, result: null };
    case "lark.meeting-answer":
      return { ...base, result: str(d.question) ? truncate(String(d.question), 120) : null };
    case "space.member":
    case "space.remove":
      return { ...base, result: [str(d.user) ? n.user(String(d.user)) : null, str(d.role)].filter(Boolean).join(" · ") || null };
    case "user.login-any":
      return { ...base, result: d.on ? "可以用任何绑定的方式登录" : "只能用指定的方式登录" };
    case "connection.add": case "connection.remove": case "connection.feature.on": case "connection.feature.off":
      return { ...base, result: [str(d.provider), str(d.feature)].filter(Boolean).join(" · ") || null };
    case "operation.rules": case "command.rules": case "agents.network-policies":
      return { ...base, target: "", result: typeof d.count === "number" ? `共 ${d.count} 条` : null };
    default: {
      const said = str(d.result) ?? str(d.reason) ?? str(d.outcome) ?? str(d.role) ?? str(d.email);
      return { ...base, result: said ? truncate(said, 120) : null };
    }
  }
}

export function auditRows(app: App, viewer: string, o: { group?: AuditGroup; before?: number; limit?: number } = {}): { rows: AuditRow[]; more: boolean } {
  const limit = Math.max(1, Math.min(200, o.limit ?? 50));
  const where = [o.group ? WHERE[o.group] : "1", o.before ? "id < ?" : "1"].join(" and ");
  const raw = all<Raw>(app.db, `select id, at, actor, action, target, detail from audit_events where ${where} order by id desc limit ?`, ...(o.before ? [o.before] : []), limit + 1);
  const n = names(app, viewer);
  // Rule titles as they are now: a rule that was since removed shows nothing.
  const rules = new Map<string, string>();
  try { for (const r of currentRules(app)) rules.set(r.id, r.title || ruleName(r.match)); } catch { /* no rules configured */ }
  const rows = raw.slice(0, limit).map((r) => {
    const d = json<Record<string, unknown>>(r.detail, {});
    // What a rule decided happened in someone's run, not by their hand; an approval or a refusal is the person's own.
    const byRule = /^(command|http|file|tool)\./.test(r.action) && !(/\.(approve|reject)$/.test(r.action) && d.result !== "策略判定");
    const who = n.user(r.actor), told = describe(app, r, d, n, rules);
    // Something done to oneself (a login, one's own connection) needs no “to whom”.
    if (told.target === who) told.target = "";
    return { id: r.id, at: r.at, action: r.action, group: groupOf(r.action), actor: byRule && who !== "omem" ? `${who}的运行` : who, ...told, detail: viewer === OWNER ? d : {} };
  });
  return { rows, more: raw.length > limit };
}
