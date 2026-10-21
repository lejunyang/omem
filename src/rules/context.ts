import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, truncate } from "../core/util.ts";
import type { RuleEvent } from "./types.ts";

/**
 * What is being said around an event: the topic it is in, or the chat around it. Rules use it to
 * tell whether the owner is already handling something ("owner-engaged"), whether someone already
 * answered ("answered"), and give the model and the agent the discussion to read.
 *
 * Messages come from what is stored (the bot's real-time messages and the owner's capture), plus a
 * fresh read-only lark-cli listing so a chat captured every ten minutes is still current.
 */
export type Said = { id: string; at: number; who: string; kind: "owner" | "bot" | "user"; text: string; parentId: string | null; topicId: string | null };

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

let cliOverride: ((chatId: string, topicId: string | null, sinceMs: number) => Promise<Said[]>) | null = null;
export function setDiscussionForTests(fn: typeof cliOverride) {
  cliOverride = fn;
}

async function fromCli(app: App, chatId: string, topicId: string | null, sinceMs: number): Promise<Said[]> {
  if (cliOverride) return cliOverride(chatId, topicId, sinceMs);
  const { larkCli } = await import("../channels/lark-cli.ts");
  const { flattenReplies, isApp, messageText, parentOf, timeMs } = await import("../channels/lark-messages.ts");
  const { ownerOpenId } = await import("../channels/lark-personal.ts");
  const args = topicId
    ? ["im", "+threads-messages-list", "--thread", topicId, "--order", "desc"]
    : ["im", "+chat-messages-list", "--chat-id", chatId, "--order", "desc", "--start", iso(sinceMs), "--end", iso(Date.now() + 60_000)];
  const v = await larkCli([...args, "--page-size", "50", "--no-reactions", "--as", "user", "--format", "json"], 60_000);
  const owner = await ownerOpenId();
  const ownApp = app.config.lark.appId;
  return flattenReplies(v.data?.messages ?? [])
    .filter((m) => !m.deleted && m.msg_type !== "system")
    .map((m) => ({
      id: m.message_id,
      at: timeMs(m.create_time),
      who: ownApp && m.sender?.id === ownApp ? "omem 机器人" : (m.sender?.name ?? "?"),
      kind: owner && m.sender?.id === owner ? ("owner" as const) : isApp(m) ? ("bot" as const) : ("user" as const),
      text: messageText(m),
      parentId: parentOf(m) || null,
      topicId: m.thread_id ?? topicId,
    }));
}

function fromStore(app: App, chatId: string, topicId: string | null, sinceMs: number): Said[] {
  const rows = all<{ message_id: string; create_ms: number; sender_name: string; sender_kind: string; content: string; parent_id: string | null; thread_id: string | null }>(
    app.db,
    `select message_id, create_ms, sender_name, sender_kind, content, parent_id, thread_id from lark_messages where chat_id = ? and ${topicId ? "thread_id = ?" : "create_ms >= ?"} and sender_kind != 'system' order by create_ms desc limit 80`,
    chatId,
    topicId ?? sinceMs,
  );
  return rows.map((r) => ({ id: r.message_id, at: r.create_ms, who: r.sender_name || "?", kind: r.sender_kind === "owner" ? "owner" : r.sender_kind === "app" ? "bot" : "user", text: r.content, parentId: r.parent_id, topicId: r.thread_id }));
}

/** The discussion an event is part of, oldest first: its topic, or the chat from `sinceMs` on. */
export async function discussion(app: App, e: RuleEvent, opts: { sinceMs?: number } = {}): Promise<Said[]> {
  if (!e.chat || !e.message) return [];
  const topicId = e.message.topicId ?? null;
  const at = Date.parse(e.at) || Date.now();
  const sinceMs = opts.sinceMs ?? at - 30 * 60_000;
  const byId = new Map<string, Said>();
  for (const m of fromStore(app, e.chat.id, topicId, sinceMs)) byId.set(m.id, m);
  try {
    for (const m of await fromCli(app, e.chat.id, topicId, sinceMs)) byId.set(m.id, m);
  } catch {
    // lark-cli unavailable or the owner left the chat: what is stored has to do.
  }
  return [...byId.values()].filter((m) => topicId || m.at >= sinceMs).sort((a, b) => a.at - b.at);
}

/**
 * Whether the owner is already on it, and whether someone already answered the triggering message.
 * owner-engaged: the owner spoke in the topic, or in the chat within half an hour before the event or
 * any time since. answered: in the topic someone other than the sender and bots spoke after it; outside
 * a topic someone replied to it.
 */
export function engagement(e: RuleEvent, said: Said[]) {
  const at = Date.parse(e.at) || Date.now();
  const inTopic = !!e.message?.topicId;
  const ownerEngaged = said.some((m) => m.kind === "owner" && m.id !== e.message?.id && (inTopic || m.at >= at - 30 * 60_000));
  const answered = said.some(
    (m) => m.id !== e.message?.id && m.kind !== "bot" && m.at >= at && m.who !== e.sender?.name && (inTopic || m.parentId === e.message?.id),
  );
  return { ownerEngaged, answered };
}

/** The discussion as lines for the model to read (newest last), the triggering message marked. */
export function discussionText(e: RuleEvent, said: Said[], max = 30) {
  if (!said.length) return "";
  const fmt = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
  return said
    .slice(-max)
    .map((m) => `${m.id === e.message?.id ? "→ " : ""}[${fmt(m.at)}] ${m.who}${m.kind === "owner" ? "（本人）" : m.kind === "bot" ? "（机器人）" : ""}: ${truncate(m.text.replace(/\s+/g, " "), 400)} (${m.id})`)
    .join("\n");
}

// ---- topics a silent agent spoke in ---------------------------------------------------------

/**
 * A rule's agent working silently that did post in a topic (an answer, or a question to someone)
 * follows that topic for a day: new messages there go back to it, not through the rule's
 * conditions again, until the owner steps in.
 */
export type Followed = { ruleId: string; runId: string; spec: string; chatId: string; topicId: string; until: string };
const followKey = (chatId: string, topicId: string) => `rule_follow:${chatId}#${topicId}`;

export function followTopic(app: App, f: Omit<Followed, "until">) {
  const until = new Date(Date.now() + 24 * 3600_000).toISOString();
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", followKey(f.chatId, f.topicId), JSON.stringify({ ...f, until }));
}

export function followedTopic(app: App, chatId: string, topicId: string | null | undefined): Followed | null {
  if (!topicId) return null;
  const f = json<Followed | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", followKey(chatId, topicId))?.value, null);
  if (!f) return null;
  if (f.until < new Date().toISOString()) {
    unfollowTopic(app, chatId, topicId);
    return null;
  }
  return f;
}

export function unfollowTopic(app: App, chatId: string, topicId: string) {
  run(app.db, "delete from kv where key = ?", followKey(chatId, topicId));
}
