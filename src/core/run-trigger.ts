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
  via: "chat" | "guest" | "mention" | "rule" | "schedule" | "peer" | "member";
  /** The person or bot. `key`: `user:<id>` for a user of omem, `lark:<open_id>` for someone on Feishu, `bot:<id>` for another bot, `name:<name>` when only a name is known. */
  by?: { key: string; name: string };
  /** Where it happened: a chat's name, “私聊”, a device. */
  where?: string;
  /** The rule, schedule or device behind it. */
  source?: { kind: "rule" | "schedule" | "peer"; id: string; name: string };
};

export const VIA_LABEL: Record<RunTrigger["via"], string> = { chat: "对话", guest: "访客提问", mention: "有人找你", rule: "规则", schedule: "定时", peer: "同伴设备", member: "成员操作" };

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
    if (p) return json<RunTrigger | null>(p, null);
  }
  if (r.userId && r.userId !== OWNER) return { via: "member", by: userBy(app, r.userId) };
  return null;
}

/** People behind recent runs, most runs first (the run page's “触发人” filter). */
export function triggerers(app: App, opts: { days?: number; visibleTo?: string } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  return all<{ key: string; name: string | null; n: number; last: string }>(app.db,
    `select trigger_by key, max(json_extract(trigger, '$.by.name')) name, count(*) n, max(created_at) last from runs
      where trigger_by is not null and created_at > ? ${opts.visibleTo ? "and coalesce(user_id, 'owner') = ?" : ""} group by trigger_by order by n desc limit 200`,
    since, ...(opts.visibleTo ? [opts.visibleTo] : []))
    .map((r) => ({ key: r.key, name: r.name ?? r.key, runs: r.n, last: r.last }));
}
