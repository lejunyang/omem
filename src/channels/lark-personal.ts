import { scheduleIngest } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { json } from "../core/util.ts";
import { appendToSource } from "../sources/store.ts";
import { larkCli } from "./lark-cli.ts";

/**
 * Read-only capture of the owner's own Feishu chats through lark-cli (user
 * identity). Subscribed chats are appended to chat sources in their space and
 * handed to the ingest role; @-mentions anywhere go to the personal space.
 * Nothing is ever sent from the owner's account.
 */
export type Subscription = { chatId: string; name: string; spaceId: string; since?: string };
type LarkMessage = { message_id: string; chat_id?: string; chat_name?: string; msg_type: string; content: unknown; create_time: string; sender?: { id?: string; name?: string } ; deleted?: boolean };

const KEY = "lark_subscriptions";

export function getSubscriptions(app: App): Subscription[] {
  return json(one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value, []);
}
export function setSubscriptions(app: App, subs: Subscription[]) {
  const prev = new Map(getSubscriptions(app).map((s) => [s.chatId, s]));
  const next = subs.map((s) => ({ ...s, since: prev.get(s.chatId)?.since ?? s.since }));
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(next));
  return next;
}

export async function listLarkChats() {
  const v = await larkCli(["im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", "100", "--page-limit", "3", "--format", "json"]);
  return ((v.data?.chats ?? []) as { chat_id: string; name: string; chat_mode: string }[]).map((c) => ({ chatId: c.chat_id, name: c.name || c.chat_id, mode: c.chat_mode }));
}

function text(m: LarkMessage): string {
  const c = m.content;
  if (typeof c === "string") {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed?.text === "string") return parsed.text;
      if (parsed?.title || parsed?.content) return [parsed.title, ...(parsed.content ?? []).map((line: { text?: string }[]) => line.map((n) => n.text ?? "").join(""))].filter(Boolean).join(" ");
    } catch {
      return c;
    }
    return c;
  }
  if (c && typeof c === "object") return JSON.stringify(c);
  return `[${m.msg_type}]`;
}

const ts = (s: string) => new Date(s).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const fmt = (ms: string) => {
  const d = new Date(Number(ms) || ms);
  return Number.isNaN(d.getTime()) ? ms : d.toISOString().slice(0, 16).replace("T", " ");
};

async function fetchMessages(args: string[], start: string, end: string) {
  const out: LarkMessage[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const v = await larkCli(["im", ...args, "--start", ts(start), "--end", ts(end), "--page-size", "50", "--no-reactions", ...(token ? ["--page-token", token] : []), "--as", "user", "--format", "json"]);
    out.push(...((v.data?.messages ?? []) as LarkMessage[]));
    if (!v.data?.has_more || !v.data.page_token) break;
    token = v.data.page_token;
  }
  return out.filter((m) => !m.deleted);
}

export async function pollLark(app: App) {
  const end = new Date().toISOString();
  const defaultSince = new Date(Date.now() - 24 * 3600_000).toISOString();
  const subs = getSubscriptions(app);
  const touched = new Map<string, string[]>();
  for (const sub of subs) {
    if (!findSpace(app, sub.spaceId)) continue;
    const messages = await fetchMessages(["+chat-messages-list", "--chat-id", sub.chatId, "--order", "asc"], sub.since ?? defaultSince, end);
    if (messages.length) {
      const r = appendToSource(app, {
        spaceId: sub.spaceId,
        kind: "chat",
        uri: `lark:${sub.chatId}`,
        title: sub.name,
        lines: messages.map((m) => `[${fmt(m.create_time)}] ${m.sender?.name ?? m.sender?.id ?? "?"}: ${text(m).replace(/\n/g, " ⏎ ")}`),
        meta: { chatId: sub.chatId, via: "lark-cli" },
      });
      touched.set(sub.spaceId, [...(touched.get(sub.spaceId) ?? []), r.id]);
    }
    sub.since = end;
  }
  // Mentions of the owner in chats that are not subscribed.
  const lastMention = one<{ value: string }>(app.db, "select value from kv where key = 'lark_mentions_since'")?.value ?? defaultSince;
  try {
    const me = await larkCli(["auth", "status", "--json", "--verify"]);
    const owner = (me.data ?? me).identities?.user?.openId as string | undefined;
    if (owner) {
      const subscribed = new Set(subs.map((s) => s.chatId));
      const mentions = (await fetchMessages(["+messages-search", "--at-chatter-ids", owner, "--chat-type", "group"], lastMention, end)).filter((m) => !subscribed.has(m.chat_id ?? ""));
      if (mentions.length) {
        const r = appendToSource(app, {
          spaceId: "personal",
          kind: "chat",
          uri: "lark:mentions",
          title: "飞书中 @我 的消息",
          lines: mentions.map((m) => `[${fmt(m.create_time)}] ${m.chat_name ?? m.chat_id}｜${m.sender?.name ?? "?"}: ${text(m).replace(/\n/g, " ⏎ ")}`),
        });
        touched.set("personal", [...(touched.get("personal") ?? []), r.id]);
      }
    }
    run(app.db, "insert into kv(key,value) values('lark_mentions_since', ?) on conflict(key) do update set value = excluded.value", end);
  } catch (e) {
    console.warn("[omem] 飞书 @我 消息读取失败：", (e as Error).message);
  }
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(subs));
  for (const [spaceId, ids] of touched) scheduleIngest(app, spaceId, [...new Set(ids)], "飞书新消息");
  return { chats: subs.length, spaces: [...touched.keys()] };
}

/** Recent messages of chats that are not subscribed yet, for the curator role to judge. */
export async function previewUnsubscribed(app: App, maxChats = 30) {
  const subscribed = new Set(getSubscriptions(app).map((s) => s.chatId));
  const excluded = new Set<string>(json(one<{ value: string }>(app.db, "select value from kv where key = 'lark_curate_excluded'")?.value, []));
  const chats = (await listLarkChats()).filter((c) => c.mode !== "p2p" && !subscribed.has(c.chatId) && !excluded.has(c.chatId)).slice(0, maxChats);
  const start = new Date(Date.now() - 3 * 86400_000).toISOString();
  const end = new Date().toISOString();
  const out: { chatId: string; name: string; preview: string[] }[] = [];
  for (const c of chats) {
    try {
      const msgs = await fetchMessages(["+chat-messages-list", "--chat-id", c.chatId, "--order", "desc"], start, end);
      out.push({ chatId: c.chatId, name: c.name, preview: msgs.slice(0, 12).reverse().map((m) => `${m.sender?.name ?? "?"}: ${text(m).replace(/\n/g, " ").slice(0, 120)}`) });
    } catch {
      out.push({ chatId: c.chatId, name: c.name, preview: [] });
    }
  }
  return out;
}
