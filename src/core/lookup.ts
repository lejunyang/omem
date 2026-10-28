import type { App } from "./app.ts";
import { one } from "./db.ts";
import { accessibleSpaces, OWNER } from "./users.ts";

/** What an id names, with enough to show it and open it (the web app picks the view by `type`). */
export type IdHit = {
  type: "run" | "memory" | "source" | "item" | "message" | "conversation" | "rule" | "page" | "notification";
  id: string;
  title: string;
  snippet: string;
  spaceId: string | null;
  /** For a page: its slug; for a message: its conversation. */
  slug?: string;
  conversationId?: string;
  at?: string;
};

const clip = (s: string | null | undefined, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Look an id up wherever it may live: a run id under a Feishu answer, `src:…`, `mem:…`, `msg:…`, an
 * item, a conversation, a rule, a notification or a page (`空间/页面`). Ids are unique across
 * tables by prefix and time, so at most a few rows answer; the caller's spaces limit what is shown.
 */
export function lookupId(app: App, raw: string, userId = OWNER): IdHit[] {
  const id = raw.trim().replace(/^(运行|run)\s*/i, "").replace(/^#?\/?(runs|items|ask)\//, "").replace(/^(src|mem|msg):/, "").replace(/#L\d+(-L?\d+)?$/, "");
  if (!id || /\s/.test(id) || id.length > 200) return [];
  const spaces = accessibleSpaces(app, userId);
  const may = (space: string | null) => spaces === null || (!!space && spaces.includes(space));
  const owner = spaces === null;
  const out: IdHit[] = [];
  const push = (h: IdHit | null | undefined) => {
    if (h && may(h.spaceId)) out.push(h);
  };

  const r = one<{ id: string; kind: string; space_id: string | null; title: string; status: string; created_at: string; user_id: string | null }>(app.db, "select id, kind, space_id, title, status, created_at, user_id from runs where id = ?", id);
  if (r && (owner || r.user_id === userId)) out.push({ type: "run", id: r.id, title: r.title || r.kind, snippet: `${r.kind} · ${r.status}`, spaceId: r.space_id, at: r.created_at });
  const m = one<{ id: string; space_id: string; subject: string | null; content: string; kind: string; status: string }>(app.db, "select id, space_id, subject, content, kind, status from memories where id = ?", id);
  if (m) push({ type: "memory", id: m.id, title: m.subject || "记忆", snippet: clip(m.content), spaceId: m.space_id });
  const s = one<{ id: string; space_id: string; title: string; uri: string; text: string; kind: string }>(app.db, "select id, space_id, title, uri, substr(text, 1, 400) text, kind from sources where id = ?", id);
  if (s) push({ type: "source", id: s.id, title: s.title || s.uri, snippet: clip(s.text), spaceId: s.space_id });
  const i = one<{ id: string; space_id: string; title: string; detail: string; status: string; user_id: string | null }>(app.db, "select * from items where id = ?", id);
  if (i && (owner || i.user_id === userId)) push({ type: "item", id: i.id, title: i.title, snippet: clip(i.detail) || i.status, spaceId: i.space_id });
  const msg = one<{ id: string; conversation_id: string; role: string; text: string; created_at: string; space_id: string; user_id: string }>(app.db, "select m.id, m.conversation_id, m.role, m.text, m.created_at, c.space_id, c.user_id from messages m join conversations c on c.id = m.conversation_id where m.id = ?", id);
  if (msg && (owner || msg.user_id === userId)) out.push({ type: "message", id: msg.id, title: msg.role === "user" ? "本人的消息" : "助理的回答", snippet: clip(msg.text), spaceId: msg.space_id, conversationId: msg.conversation_id, at: msg.created_at });
  const c = one<{ id: string; space_id: string; title: string; channel: string; user_id: string }>(app.db, "select id, space_id, title, channel, user_id from conversations where id = ?", id);
  if (c && (owner || c.user_id === userId)) out.push({ type: "conversation", id: c.id, title: c.title || "对话", snippet: c.channel, spaceId: c.space_id });
  if (owner) {
    const rule = one<{ id: string; name: string; description: string }>(app.db, "select id, name, description from rules where id = ?", id);
    if (rule) out.push({ type: "rule", id: rule.id, title: rule.name, snippet: clip(rule.description), spaceId: null });
    const n = one<{ id: string; title: string; body: string; at: string }>(app.db, "select id, title, body, at from notifications where id = ?", id);
    if (n) out.push({ type: "notification", id: n.id, title: n.title, snippet: clip(n.body), spaceId: null, at: n.at });
  }
  const p = one<{ id: string; space_id: string; slug: string; title: string; summary: string }>(app.db, "select id, space_id, slug, title, summary from pages where id = ?", id.replace(/:/, "/"));
  if (p) push({ type: "page", id: p.id, title: p.title, snippet: clip(p.summary), spaceId: p.space_id, slug: p.slug });
  return out;
}
