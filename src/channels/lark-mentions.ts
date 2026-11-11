import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { captureSpace } from "../core/capture-space.ts";
import { truncate } from "../core/util.ts";
import { addressed } from "../rules/store.ts";
import { handledKey, registerMentionChannel, type MentionChannel, type MentionChat, type MentionMessage } from "../mentions/channel.ts";
import { queueMentions } from "../mentions/mentions.ts";
import { LIMITS, localTime } from "../mentions/triage.ts";
import { isApp, mentionIds, messageText, timeMs, type LarkMessage } from "./lark-messages.ts";
import { ownerAlreadyHandled } from "./notify-gate.ts";
import { watchRule } from "./lark-watch.ts";
import { draftMentionReply, replyHow, sendMentionReply } from "./mention-reply.ts";

/**
 * 有人找你 on Feishu (docs/v2/mentions.md; the flow is src/mentions/mentions.ts): which captured
 * messages look for the owner, what the flow reads about them (stored messages and their chat lines,
 * read state, the talk around them, the sender), what else takes them here (a watched chat, the bot
 * answering an @ of itself), and how an answer to the asker goes out (mention-reply.ts).
 */
export type { MentionChat } from "../mentions/channel.ts";

/** Messages older than this when first seen (a chat read for the first time) are history, not someone waiting. */
const FRESH_MS = 6 * 3600_000;

/** Whether this message is someone (not the owner, not a bot) looking for the owner. */
function looksForOwner(app: App, chat: MentionChat, m: LarkMessage, owner: string) {
  if (m.msg_type === "system" || !m.sender?.id || m.sender.id === owner || isApp(m) || m.sender.id === app.config.lark.appId) return false;
  if (Date.now() - timeMs(m.create_time) > FRESH_MS) return false;
  return chat.kind === "p2p" ? true : mentionIds(m).includes(owner);
}

/**
 * Queue the triage for the messages in a captured batch that look for the owner. Call after the
 * messages are stored (their lines are what the run cites). `owner`: the owner's id as the reading app sees it.
 */
export function queueMention(app: App, chat: MentionChat, messages: LarkMessage[], owner: string | undefined) {
  if (!app.config.mentions.enabled || !owner) return null;
  // A watched chat has its own handler, which sees these messages already.
  if (watchRule(app, chat.id)) return null;
  const picked = messages.filter((m) => looksForOwner(app, chat, m, owner)).map((m) => ({ id: m.message_id, topicId: m.thread_id ?? null, sender: m.sender?.name ?? "", atMs: timeMs(m.create_time) }));
  return picked.length ? queueMentions(app, lark, chat, picked) : null;
}

/** The stored messages with the chat line each one is (its citation). */
function storedMessages(app: App, ids: string[]): MentionMessage[] {
  const out: MentionMessage[] = [];
  for (const id of ids) {
    const m = one<{ message_id: string; thread_id: string | null; parent_id: string | null; sender_id: string | null; sender_name: string; msg_type: string; content: string; create_ms: number; source_id: string | null }>(app.db, "select * from lark_messages where message_id = ?", id);
    if (!m) continue;
    const at = one<{ source_id: string; line: number }>(app.db, "select l.source_id, l.line from lark_message_lines l join sources s on s.id = l.source_id where l.message_id = ? and s.deleted_at is null order by (l.source_id = ?) desc, s.captured_at limit 1", id, m.source_id ?? "");
    const parent = m.parent_id ? one<{ sender_name: string; content: string }>(app.db, "select sender_name, content from lark_messages where message_id = ?", m.parent_id) : undefined;
    out.push({
      id,
      sender: m.sender_name || "?",
      senderId: m.sender_id,
      atMs: m.create_ms,
      text: messageText({ content: m.content, msg_type: m.msg_type }),
      topicId: m.thread_id,
      quoted: parent ? `${parent.sender_name}：${truncate(messageText({ content: parent.content, msg_type: "text" }), 200)}` : null,
      sourceId: at?.source_id ?? null,
      ref: at ? `src:${at.source_id}#L${at.line}` : null,
    });
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

/** The talk around the messages: the same topic (or the chat), up to LIMITS before and a few after. */
function talkAround(app: App, chatId: string, topicId: string | null, messages: MentionMessage[]) {
  const ids = new Set(messages.map((m) => m.id));
  const first = Math.min(...messages.map((m) => m.atMs));
  const last = Math.max(...messages.map((m) => m.atMs));
  const topic = topicId ? " and thread_id = ?" : "";
  const args = topicId ? [chatId, topicId] : [chatId];
  type Row = { message_id: string; sender_name: string; sender_kind: string; msg_type: string; content: string; create_ms: number };
  const before = all<Row>(app.db, `select message_id, sender_name, sender_kind, msg_type, content, create_ms from lark_messages where chat_id = ?${topic} and create_ms <= ? order by create_ms desc limit ?`, ...args, first, LIMITS.around + ids.size).reverse();
  const after = all<Row>(app.db, `select message_id, sender_name, sender_kind, msg_type, content, create_ms from lark_messages where chat_id = ?${topic} and create_ms > ? order by create_ms limit 5`, ...args, last);
  const lines: string[] = [];
  let chars = 0;
  // Newest first, so the budget keeps what is closest to the messages.
  for (const r of [...before, ...after].filter((r) => !ids.has(r.message_id)).reverse()) {
    const line = `[${localTime(app, r.create_ms)}] ${r.sender_name || "?"}${r.sender_kind === "owner" ? "（本人）" : r.sender_kind === "app" ? "（机器人）" : ""}：${truncate(messageText({ content: r.content, msg_type: r.msg_type }).replace(/\s+/g, " "), 300)}`;
    if (chars + line.length > LIMITS.aroundChars) break;
    chars += line.length;
    lines.unshift(line);
  }
  return lines.join("\n");
}

/** Who sent it, as far as capture knows: how often they write, whether they write to the owner one-to-one. */
function senderLine(app: App, m: MentionMessage) {
  if (!m.senderId) return m.sender;
  const since = Date.now() - 30 * 86400_000;
  const n = one<{ n: number }>(app.db, "select count(*) n from lark_messages where sender_id = ? and create_ms > ?", m.senderId, since)?.n ?? 0;
  const p2p = !!one(app.db, "select 1 from lark_messages m join lark_cursors c on c.chat_id = m.chat_id where m.sender_id = ? and c.kind = 'p2p' limit 1", m.senderId);
  const asked = one<{ n: number }>(app.db, "select count(*) n from handled_messages h join lark_messages m on m.message_id = h.message_id where h.channel = ? and m.sender_id = ? and m.create_ms > ?", handledKey(lark), m.senderId, since)?.n ?? 0;
  return `${m.sender}（近 30 天在你能看到的会话里发过 ${n} 条消息${p2p ? "，和你有私聊" : ""}${asked > 1 ? `，找过你 ${asked} 次` : ""}）`;
}

const lark: MentionChannel = {
  id: "lark",
  label: "飞书",
  messages: storedMessages,
  spaceOf: (app, chatId, messageId) =>
    one<{ space_id: string }>(app.db, "select s.space_id from lark_messages m join sources s on s.id = m.source_id where m.message_id = ? and s.deleted_at is null", messageId)?.space_id ?? captureSpace(app, chatId),
  ownerSeen: async (app, m) => !!m.ref && (await ownerAlreadyHandled(app, { sourceRefs: [m.ref] })),
  // A watch's handler (channel `lark` in handled_messages, lark-watch.ts; the bots' own rows only record
  // delivery), or the bot answering someone who @-ed it (rules/store.ts markAddressed).
  takenElsewhere: (app, chatId, m) => !!watchRule(app, chatId) || !!one(app.db, "select 1 from handled_messages where message_id = ? and channel = 'lark'", m.id) || addressed(app, `lark:${m.id}`),
  ruleKey: (id) => `lark:${id}`,
  talkAround,
  senderLine,
  handedLines: (app, sourceIds, since) =>
    all<{ source_id: string; line: number }>(app.db,
      `select l.source_id, l.line from handled_messages h join lark_message_lines l on l.message_id = h.message_id
        where h.channel = ? and h.at > ? and l.source_id in (${sourceIds.map(() => "?").join(",")}) order by l.source_id, l.line`,
      handledKey(lark), since, ...sourceIds).map((r) => `src:${r.source_id}#L${r.line}`),
  // The owner's own chat with the bot.
  ownerConversation: (app) => {
    const chat = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
    return chat ? one<{ id: string }>(app.db, "select id from conversations where channel = 'lark' and external_id = ? and status = 'active' order by updated_at desc limit 1", chat)?.id ?? null : null;
  },
  readHint: "消息里的文档已收进来的用 search / read_source 读，没收进来的飞书文档用 lark_doc_fetch（只读）。",
  reply: {
    mode: (app, kind) => app.config.mentions.reply.lark[kind],
    how: replyHow,
    send: (app, runId, text, by) => sendMentionReply(app, runId, text, by),
    draft: draftMentionReply,
  },
};
registerMentionChannel(lark);
