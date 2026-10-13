import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { appendToSource } from "../sources/store.ts";

/**
 * A thread is one line of conversation the assistant keeps context for: a
 * private chat, a group, a topic inside a group, a forum topic, or a web
 * conversation. It is stored in `conversations` (one row per thread) and
 * remembers which agent session it runs in, a rolling summary for cold starts,
 * and its own settings (space, agent spec, linked threads).
 *
 * Keys: `<chatId>` for a whole chat, `<chatId>#<topicId>` for a topic. Whether
 * a group's topics are separate threads is a per-chat setting (`mode`).
 */
export type ThreadSettings = {
  /** Agent spec that answers in this thread instead of the assistant. */
  spec?: string;
  /** Backend agent profile override (codex, claude…). */
  profile?: string;
  /** Other threads whose summaries are included as background. */
  links?: string[];
  /** Last channel message id seen in this thread (replies go under it, e.g. inside a topic). */
  lastMessageId?: string;
};
export type Thread = {
  id: string;
  spaceId: string;
  channel: string;
  key: string | null;
  title: string;
  status: "active" | "archived";
  parentId: string | null;
  summary: string;
  summaryAt: string | null;
  settings: ThreadSettings;
  agentProfile: string | null;
  agentSession: string | null;
  agentCwd: string | null;
  agentTurns: number;
  createdAt: string;
  updatedAt: string;
};
type Row = {
  id: string;
  space_id: string;
  channel: string;
  external_id: string | null;
  title: string;
  status: string;
  parent_id: string | null;
  summary: string;
  summary_at: string | null;
  settings: string;
  agent_profile: string | null;
  agent_session: string | null;
  agent_cwd: string | null;
  agent_turns: number;
  created_at: string;
  updated_at: string;
};
const toThread = (r: Row): Thread => ({
  id: r.id,
  spaceId: r.space_id,
  channel: r.channel,
  key: r.external_id,
  title: r.title,
  status: r.status === "archived" ? "archived" : "active",
  parentId: r.parent_id,
  summary: r.summary ?? "",
  summaryAt: r.summary_at,
  settings: json(r.settings, {}),
  agentProfile: r.agent_profile,
  agentSession: r.agent_session,
  agentCwd: r.agent_cwd,
  agentTurns: r.agent_turns ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function getThread(app: App, id: string): Thread {
  const r = one<Row>(app.db, "select * from conversations where id = ?", id);
  if (!r) throw new HttpError(404, `会话不存在：${id}`);
  return toThread(r);
}
export function findThread(app: App, id: string): Thread | null {
  const r = one<Row>(app.db, "select * from conversations where id = ? or id = ?", id, `c${id}`);
  return r ? toThread(r) : null;
}

export type ChatSettings = {
  /** chat: the whole chat is one thread. topic: each topic/thread is its own. */
  mode?: "chat" | "topic";
  spaceId?: string;
  /** Hours of silence after which a chat-mode thread starts afresh (remembering the old one). */
  idleHours?: number;
  /** Agent spec that answers in this chat by default. */
  spec?: string;
};

export function chatSettings(app: App, channel: string, chatId: string): ChatSettings {
  return json(one<{ settings: string }>(app.db, "select settings from chat_settings where channel = ? and chat_id = ?", channel, chatId)?.settings ?? "{}", {});
}
export function setChatSettings(app: App, channel: string, chatId: string, patch: ChatSettings) {
  const next = { ...chatSettings(app, channel, chatId), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined || v === null || v === "") delete (next as Record<string, unknown>)[k];
  run(app.db, "insert into chat_settings(channel,chat_id,settings) values(?,?,?) on conflict(channel,chat_id) do update set settings = excluded.settings", channel, chatId, JSON.stringify(next));
  return next;
}

export function createThread(app: App, input: { spaceId: string; channel: string; key?: string | null; title?: string; parentId?: string | null; settings?: ThreadSettings; id?: string }) {
  const id = input.id ?? newId("c");
  const at = now();
  run(
    app.db,
    "insert into conversations(id,space_id,channel,title,external_id,created_at,updated_at,status,parent_id,settings) values(?,?,?,?,?,?,?,?,?,?)",
    id,
    input.spaceId,
    input.channel,
    input.title ?? "",
    input.key ?? null,
    at,
    at,
    "active",
    input.parentId ?? null,
    JSON.stringify(input.settings ?? {}),
  );
  return getThread(app, id);
}

export type ThreadAddress = {
  channel: string;
  chatId: string;
  /** Topic / thread inside the chat (Feishu thread_id, Telegram message_thread_id). */
  topicId?: string | null;
  isGroup?: boolean;
  spaceId?: string;
  title?: string;
};

/**
 * Find the thread a channel message belongs to, starting a new one when the
 * chat has none, or when a chat-mode thread has been idle past its limit (the
 * new thread keeps a link to the old one so its summary carries over).
 */
export function resolveThread(app: App, addr: ThreadAddress): { thread: Thread; started: "new" | "renewed" | null } {
  const cs = chatSettings(app, addr.channel, addr.chatId);
  const mode = cs.mode ?? (addr.topicId ? "topic" : "chat");
  const key = mode === "topic" && addr.topicId ? `${addr.chatId}#${addr.topicId}` : addr.chatId;
  const spaceId = cs.spaceId ?? addr.spaceId ?? "personal";
  const row = one<Row>(app.db, "select * from conversations where channel = ? and external_id = ? and status = 'active' order by updated_at desc limit 1", addr.channel, key);
  const settings: ThreadSettings = cs.spec ? { spec: cs.spec } : {};
  if (!row) {
    // A pinned "/resume" may have re-attached an archived thread to this key; otherwise start fresh.
    const prev = one<Row>(app.db, "select * from conversations where channel = ? and external_id = ? order by updated_at desc limit 1", addr.channel, key);
    return { thread: createThread(app, { spaceId, channel: addr.channel, key, title: addr.title, parentId: prev?.id ?? null, settings }), started: "new" };
  }
  const t = toThread(row);
  const idleHours = cs.idleHours ?? app.config.sessions.idleHours;
  const idle = (Date.now() - Date.parse(t.updatedAt)) / 3_600_000;
  if (key === addr.chatId && idleHours > 0 && idle > idleHours) {
    archiveThread(app, t.id);
    return { thread: createThread(app, { spaceId: t.spaceId, channel: addr.channel, key, title: addr.title, parentId: t.id, settings: { ...t.settings, links: [] } }), started: "renewed" };
  }
  return { thread: t, started: null };
}

export function archiveThread(app: App, id: string) {
  run(app.db, "update conversations set status = 'archived' where id = ?", id);
}

/** Make an earlier thread the active one for a chat key (/resume). */
export function reattachThread(app: App, id: string, channel: string, key: string) {
  const t = getThread(app, id);
  run(app.db, "update conversations set status = 'archived' where channel = ? and external_id = ? and status = 'active' and id != ?", channel, key, id);
  run(app.db, "update conversations set status = 'active', channel = ?, external_id = ?, updated_at = ? where id = ?", channel, key, now(), id);
  return { ...t, status: "active" as const, channel, key };
}

export function updateThread(
  app: App,
  id: string,
  patch: Partial<{ title: string; spaceId: string; settings: ThreadSettings; summary: string; summaryAt: string; agentProfile: string | null; agentSession: string | null; agentCwd: string | null; agentTurns: number }>,
) {
  const t = getThread(app, id);
  const next = {
    title: patch.title ?? t.title,
    space_id: patch.spaceId ?? t.spaceId,
    settings: JSON.stringify(patch.settings ? { ...t.settings, ...patch.settings } : t.settings),
    summary: patch.summary ?? t.summary,
    summary_at: patch.summaryAt ?? t.summaryAt,
    agent_profile: patch.agentProfile === undefined ? t.agentProfile : patch.agentProfile,
    agent_session: patch.agentSession === undefined ? t.agentSession : patch.agentSession,
    agent_cwd: patch.agentCwd === undefined ? t.agentCwd : patch.agentCwd,
    agent_turns: patch.agentTurns ?? t.agentTurns,
  };
  run(
    app.db,
    "update conversations set title=?, space_id=?, settings=?, summary=?, summary_at=?, agent_profile=?, agent_session=?, agent_cwd=?, agent_turns=? where id=?",
    next.title,
    next.space_id,
    next.settings,
    next.summary,
    next.summary_at,
    next.agent_profile,
    next.agent_session,
    next.agent_cwd,
    next.agent_turns,
    id,
  );
  return getThread(app, id);
}

/** Forget the agent session so the next turn starts a fresh one from the summary. */
export function resetAgentSession(app: App, id: string) {
  run(app.db, "update conversations set agent_session = null, agent_cwd = null, agent_turns = 0 where id = ?", id);
}

export type ThreadMessage = { id: string; role: string; text: string; createdAt: string; meta: Record<string, unknown> };
export function threadMessages(app: App, id: string, opts: { limit?: number; after?: string | null; before?: string | null } = {}): ThreadMessage[] {
  const where = ["conversation_id = ?"];
  const params: (string | number)[] = [id];
  if (opts.after) where.push("created_at > ?") && params.push(opts.after);
  if (opts.before) where.push("created_at < ?") && params.push(opts.before);
  return all<{ id: string; role: string; text: string; created_at: string; meta: string }>(
    app.db,
    `select * from (select id, role, text, created_at, meta from messages where ${where.join(" and ")} order by created_at desc limit ?) order by created_at`,
    ...params,
    opts.limit ?? 200,
  ).map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.created_at, meta: json(m.meta, {}) }));
}

export function listThreads(app: App, opts: { channel?: string; spaceId?: string; query?: string; limit?: number; includeArchived?: boolean } = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (!opts.includeArchived) where.push("c.status = 'active'");
  if (opts.channel) where.push("c.channel = ?") && params.push(opts.channel);
  if (opts.spaceId) where.push("c.space_id = ?") && params.push(opts.spaceId);
  if (opts.query) where.push("(c.title like ? or c.summary like ?)") && params.push(`%${opts.query}%`, `%${opts.query}%`);
  return all<Row & { messages: number }>(
    app.db,
    `select c.*, (select count(*) from messages m where m.conversation_id = c.id) messages from conversations c ${where.length ? "where " + where.join(" and ") : ""} order by c.updated_at desc limit ?`,
    ...params,
    opts.limit ?? 30,
  ).map((r) => ({ ...toThread(r), messages: r.messages }));
}

/** One line per thread for prompts and commands. */
export function describeThread(t: Thread & { messages?: number }) {
  const where = t.key ? `${t.channel}:${t.key}` : t.channel;
  return `${t.id}「${t.title || "(无标题)"}」${where} · ${t.updatedAt.slice(0, 16).replace("T", " ")}${t.messages !== undefined ? ` · ${t.messages} 条` : ""}${t.status === "archived" ? " · 已归档" : ""}${t.summary ? `\n  ${truncate(t.summary.replace(/\s+/g, " "), 160)}` : ""}`;
}


export function ensureConversation(app: App, input: { id?: string; spaceId: string; channel?: string; externalId?: string; title?: string }) {
  if (input.id) {
    const c = one<{ id: string }>(app.db, "select id from conversations where id = ?", input.id);
    if (c) return c.id;
  }
  if (input.externalId) {
    const c = one<{ id: string }>(app.db, "select id from conversations where channel = ? and external_id = ?", input.channel ?? "web", input.externalId);
    if (c) return c.id;
  }
  const id = input.id ?? newId("c");
  run(app.db, "insert into conversations(id,space_id,channel,title,external_id,created_at,updated_at) values(?,?,?,?,?,?,?)", id, input.spaceId, input.channel ?? "web", input.title ?? "", input.externalId ?? null, now(), now());
  return id;
}

export function addMessage(app: App, conversationId: string, role: "user" | "assistant", text: string, runId?: string | null, meta: Record<string, unknown> = {}) {
  const id = newId("msg");
  run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)", id, conversationId, role, text, runId ?? null, JSON.stringify(meta), now());
  run(
    app.db,
    "update conversations set updated_at = ?, title = case when title = '' and ? = 'user' and ? = 0 then ? else title end where id = ?",
    now(),
    role,
    meta.command ? 1 : 0,
    truncate(text.replace(/\s+/g, " "), 40),
    conversationId,
  );
  if (meta.command) return id;
  // Conversations are part of the library too: "what did I tell you last week" must be searchable.
  const conv = one<{ space_id: string; title: string; channel: string }>(app.db, "select space_id, title, channel from conversations where id = ?", conversationId);
  if (conv)
    appendToSource(app, {
      spaceId: conv.space_id,
      kind: "conversation",
      uri: `conversation:${conversationId}`,
      title: `对话：${conv.title || truncate(text, 40)}`,
      lines: ["", `**${role === "user" ? "本人" : "助理"}**（${now().slice(0, 16).replace("T", " ")}，msg:${id}）：${text}`],
      meta: { conversationId, channel: conv.channel },
    });
  return id;
}

export function conversationMessages(app: App, conversationId: string, limit = 200) {
  return all<{ id: string; role: string; text: string; run_id: string | null; meta: string; created_at: string }>(
    app.db,
    "select * from (select * from messages where conversation_id = ? order by created_at desc limit ?) order by created_at",
    conversationId,
    limit,
  ).map((m) => ({ id: m.id, role: m.role, text: m.text, runId: m.run_id, meta: json(m.meta, {}), createdAt: m.created_at }));
}

