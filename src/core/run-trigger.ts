import type { App } from "./app.ts";
import { all, one } from "./db.ts";
import { OWNER, userName } from "./users.ts";
import { json } from "./util.ts";

/**
 * How a run came about and whose message or action led to it (`runs.trigger`, with the person's key
 * in `runs.trigger_by` for the run page's filter). Recorded when the run is created: given by the
 * caller (a message to the assistant, a schedule firing), read from the run's input (a guest's
 * question, someone looking for the owner, a rule), or taken over from the run that started it.
 */
export type RunTrigger = {
  /**
   * chat: a message to the assistant; guest: someone who is not a user asking the bot; mention: someone
   * looking for the owner; rule; schedule; peer: an agent on another device; member: a user's own action.
   */
  via: "chat" | "guest" | "mention" | "rule" | "schedule" | "peer" | "member" | "flow";
  /** The person or bot. `key`: `user:<id>` for a user of omem, `lark:<open_id>` for someone on Feishu, `bot:<id>` for another bot, `name:<name>` when only a name is known. */
  by?: { key: string; name: string };
  /** Where it happened: a chat's name, “私聊”, a device. */
  where?: string;
  /** The rule, schedule or device behind it. */
  source?: { kind: "rule" | "schedule" | "peer" | "flow"; id: string; name: string };
  /**
   * Taken over from the run that started this one, not something that person did again: a wake that
   * run set for itself, or a run it started (a delegation, a review). Shown as “接着…”, and not counted
   * as one more run of theirs in the run page's 触发人 list.
   */
  followUp?: "wake" | "child";
};

export const VIA_LABEL: Record<RunTrigger["via"], string> = { chat: "对话", guest: "访客提问", mention: "有人找你", rule: "规则", schedule: "定时", peer: "同伴设备", member: "成员操作", flow: "流程" };

/** A user of omem as the one behind a run. */
export function userBy(app: App, userId: string | null | undefined): RunTrigger["by"] {
  const id = userId ?? OWNER;
  return { key: `user:${id}`, name: id === OWNER ? "你" : userName(app, id) };
}
/** Someone on Feishu who is not a user (a colleague in a group, another bot). */
export function larkBy(id: string | null | undefined, name: string, bot = false): RunTrigger["by"] {
  return { key: id ? `${bot ? "bot" : "lark"}:${id}` : `name:${name}`, name: name || (bot ? "机器人" : "有人") };
}

// A trigger for runs created during a synchronous step (a schedule's runner): the next createRun without one takes it.
let ambient: RunTrigger | null = null;
export function withTrigger<T>(trigger: RunTrigger, fn: () => T): T {
  const prev = ambient;
  ambient = trigger;
  try {
    return fn();
  } finally {
    ambient = prev;
  }
}

type NewRun = { kind: string; input?: Record<string, unknown>; parentId?: string | null; userId?: string | null; trigger?: RunTrigger | null };

/** The trigger of a run about to be created (null: the system's own work, nobody in particular). */
export function triggerFor(app: App, r: NewRun): RunTrigger | null {
  if (r.trigger !== undefined) return r.trigger;
  const input = r.input ?? {};
  if (r.kind === "guest" && typeof input.senderName === "string")
    return { via: "guest", by: larkBy(String(input.senderId ?? ""), input.senderName, !!input.fromApp), where: input.chatType === "p2p" ? "私聊机器人" : String(input.chatName ?? "群聊") };
  const m = input.mention as { senderId?: string | null; senderName?: string; chatKind?: string; chatName?: string } | undefined;
  if (m?.senderName) return { via: "mention", by: larkBy(m.senderId, m.senderName), where: m.chatKind === "p2p" ? "私聊" : m.chatName };
  const rule = (input.rule as { id?: string; name?: string } | undefined) ?? (typeof input.ruleId === "string" ? { id: input.ruleId } : undefined);
  if (rule?.id) {
    const e = input.event as { sender?: { id?: string; name: string; kind?: string }; chat?: { name: string } } | undefined;
    const name = rule.name ?? one<{ name: string }>(app.db, "select name from rules where id = ?", rule.id)?.name ?? rule.id;
    return {
      via: "rule",
      source: { kind: "rule", id: rule.id, name },
      ...(e?.sender?.name && e.sender.kind !== "owner" ? { by: larkBy(e.sender.id, e.sender.name, e.sender.kind === "bot") } : e?.sender?.kind === "owner" ? { by: userBy(app, OWNER) } : {}),
      ...(e?.chat?.name ? { where: e.chat.name } : {}),
    };
  }
  if (ambient) return ambient;
  // Started by another run (a delegation, a follow-up): whoever was behind that one.
  if (r.parentId) {
    const p = one<{ trigger: string | null }>(app.db, "select trigger from runs where id = ?", r.parentId)?.trigger;
    const t = p ? json<RunTrigger | null>(p, null) : null;
    if (t) return { ...t, followUp: input.wake ? "wake" : "child" };
  }
  if (r.userId && r.userId !== OWNER) return { via: "member", by: userBy(app, r.userId) };
  return null;
}

/** Runs the person brought about themselves, not follow-ups carrying their name (older wakes were stored before `followUp`). */
const FIRST_HAND = "json_extract(trigger, '$.followUp') is null and not (parent_id is not null and coalesce(json_extract(input, '$.wake'), 0))";

/** A follow-up stored before `followUp` was recorded: a wake inheriting the trigger of the run that set it. */
export function withFollowUp(t: RunTrigger | null, run: { parentId: string | null; input: Record<string, unknown> }): RunTrigger | null {
  if (!t || t.followUp || !run.parentId || !run.input.wake) return t;
  return { ...t, followUp: "wake" };
}

/** People behind recent runs, most runs first (the run page's “触发人” filter). */
/**
 * The people behind runs in the last days, one entry each: the same person reaches omem through
 * different apps (the bot's open_id when they ask it, lark-cli's when they look for the owner, only a
 * name sometimes), so people go by name (`name:<name>`); the owner stays `user:owner`. `ways`: how
 * many of their runs came each way (chat = asking the assistant, mention = looking for the owner…).
 */
export function triggerers(app: App, opts: { days?: number; visibleTo?: string } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  const rows = all<{ key: string; name: string | null; via: string | null; n: number; last: string }>(app.db,
    `select case when trigger_by = 'user:owner' then trigger_by else 'name:' || coalesce(json_extract(trigger, '$.by.name'), trigger_by) end key,
       max(json_extract(trigger, '$.by.name')) name, json_extract(trigger, '$.via') via, count(*) n, max(created_at) last from runs
      where trigger_by is not null and created_at > ? and ${FIRST_HAND} ${opts.visibleTo ? "and coalesce(user_id, 'owner') = ?" : ""} group by key, via`,
    since, ...(opts.visibleTo ? [opts.visibleTo] : []));
  const people = new Map<string, { key: string; name: string; runs: number; last: string; ways: Record<string, number> }>();
  for (const r of rows) {
    const p = people.get(r.key) ?? { key: r.key, name: r.name ?? r.key, runs: 0, last: r.last, ways: {} };
    p.runs += r.n;
    if (r.last > p.last) p.last = r.last;
    if (r.via) p.ways[r.via] = (p.ways[r.via] ?? 0) + r.n;
    people.set(r.key, p);
  }
  return [...people.values()].sort((a, b) => b.runs - a.runs).slice(0, 200);
}
