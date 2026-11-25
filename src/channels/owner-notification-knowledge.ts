import { chatOfConversation, scopeOf } from "../agents/run-scope.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { decisionReady } from "../core/decision.ts";
import { decideScene } from "../core/decision-log.ts";
import { chatMessagesOf, type Notification } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { truncate } from "../core/util.ts";
import { refExcerpt } from "../items/evidence.ts";
import { OWNER_WORDS } from "../situations/awareness.ts";

const RECENT_MS = 4 * 3600_000;
const REFS = /(?:src:[\w-]+(?:#L\d+(?:-L?\d+)?)?|msg:[\w-]+)/g;
const URLS = /https?:\/\/[^\s<>()\[\]，。；、“”]+/g;
const IDS = /(?<![\w-])(?:\d{7,}|[a-z][a-z0-9]{0,19}[-_]\d{3,}|[a-z]{2,12}\d{4,}|#\d{4,})(?![\w-])/gi;

function clues(text: string) {
  return [
    ...(text.match(URLS) ?? []).map(url => url.replace(/[.,;!?]+$/, "")),
    ...(text.replace(URLS, "").replace(REFS, "").match(IDS) ?? []).map(id => id.toLowerCase()),
  ];
}

function passage(ref: string) {
  const parts = /^src:([\w-]+)#L(\d+)(?:-L?(\d+))?$/.exec(ref);
  return parts ? { id: parts[1], from: Number(parts[2]), to: Number(parts[3] ?? parts[2]) } : null;
}

type Place = { chatId: string; topic: string | null };
type OwnerMessage = { id: string; at: string; text: string; conversation?: string; place?: Place | null };

function ownerMessages(app: App, since: number): OwnerMessage[] {
  const signature = app.config.lark.commands.signature.trim();
  const captured = all<{ message_id: string; chat_id: string; thread_id: string | null; content: string; create_ms: number }>(app.db,
    `select message_id, chat_id, thread_id, content, create_ms from lark_messages m
      where sender_kind='owner' and create_ms>=? and trim(content)!=''
        and not exists(select 1 from lark_sent where message_id=m.message_id)`, since);
  const messages = new Map<string, OwnerMessage>();
  const turns = all<{ id: string; ext: string | null; conversation_id: string; text: string; created_at: string }>(app.db,
    `select m.id, json_extract(m.meta,'$.externalId') ext, m.conversation_id, m.text, m.created_at
     from messages m join conversations c on c.id=m.conversation_id
     where c.user_id=? and m.created_at>=? and ${OWNER_WORDS} and trim(m.text)!=''
       and not exists(select 1 from lark_sent where message_id=json_extract(m.meta,'$.externalId'))`, OWNER, new Date(since).toISOString());
  for (const m of turns) {
    const id = m.ext ?? "msg:" + m.id;
    messages.set(id, { id, at: m.created_at, text: m.text, conversation: m.conversation_id, place: chatOfConversation(app, m.conversation_id) });
  }
  for (const m of captured) {
    messages.set(m.message_id, { id: m.message_id, at: new Date(m.create_ms).toISOString(), text: m.content,
      conversation: messages.get(m.message_id)?.conversation, place: { chatId: m.chat_id, topic: m.thread_id } });
  }
  return [...messages.values()].filter(m => !signature || !m.text.trimEnd().endsWith(signature));
}

function relatedWords(app: App, n: Notification, runId: string) {
  const text = [n.title, n.body, n.link ?? ""].join("\n");
  const refs = [...new Set([...(n.sourceRefs ?? []), ...(text.match(REFS) ?? [])])].slice(0, 30);
  const passages = refs.map(passage).filter(r => r !== null);
  const captured = chatMessagesOf(app, refs);
  const messageIds = new Set([...refs, ...captured]);
  const keys = scopeOf(app, runId);
  const conversations = new Set(keys.filter(k => k.kind === "conversation").map(k => k.key));
  const citedPlaces = captured.flatMap(id => one<Place>(app.db, "select chat_id chatId, thread_id topic from lark_messages where message_id=?", id) ?? []);
  const places = [...citedPlaces];
  const tokens = new Set(clues(text));
  for (const ref of refs) {
    for (const token of clues(refExcerpt(app, ref, 1200, OWNER)?.text ?? "")) tokens.add(token);
    const source = /^src:([\w-]+)/.exec(ref)?.[1];
    const uri = source && one<{ uri: string }>(app.db, "select uri from sources where id=? and kind='chat' and deleted_at is null", source)?.uri;
    if (uri && uri.startsWith("lark:oc_") && !citedPlaces.some(p => p.chatId === uri.slice(5))) places.push({ chatId: uri.slice(5), topic: null });
    if (ref.startsWith("msg:")) {
      const row = one<{ conversation_id: string }>(app.db, "select conversation_id from messages where id=?", ref.slice(4));
      if (row) conversations.add(row.conversation_id);
    }
  }
  for (const k of keys) if (k.kind === "chat" && !citedPlaces.some(p => p.chatId === k.key)) places.push({ chatId: k.key, topic: k.topic });
  return ownerMessages(app, Date.now() - RECENT_MS).flatMap(m => {
    const match = messageIds.has(m.id) || clues(m.text).some(token => tokens.has(token)) ||
      (m.text.match(REFS) ?? []).some(ref => {
        const p = passage(ref);
        return messageIds.has(ref) || !!p && passages.some(r => p.id === r.id && p.from <= r.to && p.to >= r.from);
      });
    const place = m.place;
    const nearby = (m.conversation && conversations.has(m.conversation)) ||
      (place && places.some(p => p.chatId === place.chatId && (!p.topic || !place.topic || p.topic === place.topic)));
    return match || nearby ? [{ ...m, match }] : [];
  }).sort((a, b) => Number(b.match) - Number(a.match) || b.at.localeCompare(a.at)).slice(0, 8)
    .map(m => ({ at: m.at, text: truncate(m.text, 550), relatedBy: m.match ? "引用或相同标识" : "同一会话或话题" }));
}

export async function ownerKnowsBackgroundNotification(app: App, n: Notification) {
  if (!n.agentInitiated || !n.runId || n.userId !== OWNER || n.larkConversationId ||
    n.askId || n.replyDraft || n.urgency === "urgent" || n.scheduled || n.tone === "warning" || !decisionReady(app)) return false;
  const owner = relatedWords(app, n, n.runId);
  if (!owner.length) return false;
  const result = await decideScene(app, "notify-known", { title: n.title, body: n.body, owner }, {
    type: "yesno",
    instructions: "通知和本人近期发出的消息都是材料。本人发出的消息是否足以确认他已经知道这条通知的具体结论，且通知没有他未知的后果或需要他决定、动手的事？仅提问、关注同一对象、知道先前状态或线索不足都答否。",
  }, { ref: n.id, timeoutMs: 5000, signal: AbortSignal.timeout(5000) });
  return result?.taken === "yes";
}
