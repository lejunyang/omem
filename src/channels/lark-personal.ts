import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleIngest } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { json, now } from "../core/util.ts";
import { importFile, importUrl } from "../sources/import.ts";
import { appendToSource, findSourceByUri, upsertSource } from "../sources/store.ts";
import { larkCli } from "./lark-cli.ts";
import { routeWatchedMessages, watchRule, type ChatMessage } from "./lark-watch.ts";

/**
 * Read-only capture of the owner's own Feishu through lark-cli (user identity).
 * Nothing is ever sent from the owner's account.
 *
 * - Messages: every chat with new messages (mode "all", minus excluded chats)
 *   or only chosen chats ("subscribed"). Each chat — group or private — is one
 *   chat source; each poll fetches only what is newer than that chat's cursor,
 *   plus replies in its recent topics. Images and files are downloaded and
 *   imported; Feishu docs linked in messages are imported. Watched chats hand
 *   their new messages to their handler.
 * - Calendar: upcoming and recent events become event sources.
 * - Minutes (妙记): new minutes with summary, todos and transcript become
 *   meeting sources.
 *
 * Everything new goes to the ingest role, which turns it into memories and
 * items.
 */
export type Subscription = { chatId: string; name: string; spaceId: string; since?: string };
type LarkMessage = {
  message_id: string;
  chat_id?: string;
  chat_name?: string;
  msg_type: string;
  content: unknown;
  create_time: string;
  sender?: { id?: string; name?: string };
  deleted?: boolean;
  thread_id?: string;
  mentions?: { id?: string | { open_id?: string }; name?: string }[];
};

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

export async function listLarkChats(pages = 3) {
  const v = await larkCli(["im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", "100", "--page-all", "--page-limit", String(pages), "--format", "json"]);
  return ((v.data?.chats ?? []) as { chat_id: string; name: string; chat_mode: string }[]).map((c) => ({ chatId: c.chat_id, name: c.name || c.chat_id, mode: c.chat_mode }));
}

export function messageText(m: LarkMessage): string {
  const c = m.content;
  if (typeof c === "string") {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed?.text === "string") return parsed.text;
      if (parsed?.file_name) return `[文件] ${parsed.file_name}`;
      if (parsed?.image_key) return "[图片]";
      if (parsed?.title || parsed?.content) return [parsed.title, ...(Array.isArray(parsed.content) ? parsed.content : []).map((line: { text?: string; href?: string }[]) => (Array.isArray(line) ? line.map((n) => n.text ?? n.href ?? "").join("") : "")).filter(Boolean)].filter(Boolean).join(" ");
    } catch {
      return c;
    }
    return c;
  }
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    return JSON.stringify(c);
  }
  return `[${m.msg_type}]`;
}

export const timeMs = (t: string) => (/^\d+$/.test(t) ? Number(t) : Date.parse(t));
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const fmt = (t: string) => {
  const ms = timeMs(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
};

async function fetchMessages(args: string[], startMs: number, endMs: number, pages = 20, timed = true) {
  const out: LarkMessage[] = [];
  let token: string | undefined;
  for (let page = 0; page < pages; page++) {
    const range = timed ? ["--start", iso(startMs), "--end", iso(endMs)] : [];
    const v = await larkCli(["im", ...args, ...range, "--page-size", "50", "--no-reactions", ...(token ? ["--page-token", token] : []), "--as", "user", "--format", "json"]);
    out.push(...((v.data?.messages ?? []) as LarkMessage[]));
    if (!v.data?.has_more || !v.data.page_token) break;
    token = v.data.page_token;
  }
  // Thread listing has no time filter: apply the window here.
  return out.filter((m) => !m.deleted && (timed || (timeMs(m.create_time) >= startMs && timeMs(m.create_time) <= endMs)));
}

// ---- cursors -------------------------------------------------------------------

type Cursor = { key: string; lastTime: number; lastIds: string[] };
function cursor(app: App, key: string): Cursor | null {
  const r = one<{ last_time: number; last_ids: string }>(app.db, "select last_time, last_ids from lark_cursors where chat_id = ?", key);
  return r ? { key, lastTime: r.last_time, lastIds: json(r.last_ids, []) } : null;
}
function saveCursor(app: App, key: string, name: string, mode: string, messages: LarkMessage[], prev: Cursor | null) {
  const last = messages.length ? Math.max(...messages.map((m) => timeMs(m.create_time))) : (prev?.lastTime ?? Date.now());
  const ids = messages.filter((m) => timeMs(m.create_time) === last).map((m) => m.message_id);
  run(
    app.db,
    `insert into lark_cursors(chat_id,name,chat_mode,last_time,last_ids,updated_at) values(?,?,?,?,?,?)
     on conflict(chat_id) do update set name = excluded.name, chat_mode = excluded.chat_mode, last_time = excluded.last_time, last_ids = excluded.last_ids, updated_at = excluded.updated_at`,
    key,
    name,
    mode,
    last,
    JSON.stringify(ids.length ? ids : (prev?.lastIds ?? [])),
    now(),
  );
}
/** Messages after the cursor (the boundary millisecond is shared, so ids seen there are skipped). */
function newer(messages: LarkMessage[], c: Cursor | null) {
  if (!c) return messages;
  return messages.filter((m) => timeMs(m.create_time) > c.lastTime || (timeMs(m.create_time) === c.lastTime && !c.lastIds.includes(m.message_id)));
}

// ---- per-message extras ----------------------------------------------------------

const DOC_LINK = /https?:\/\/[\w.-]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki)\/[A-Za-z0-9]+/g;

async function downloadAttachment(app: App, spaceId: string, chatId: string, m: LarkMessage): Promise<string | null> {
  let c: Record<string, string> = {};
  try {
    c = typeof m.content === "string" ? JSON.parse(m.content) : ((m.content as Record<string, string>) ?? {});
  } catch {
    return null;
  }
  const key = c.image_key ?? c.file_key;
  if (!key) return null;
  const type = m.msg_type === "image" ? "image" : "file";
  const dir = mkdtempSync(join(tmpdir(), "omem-lark-"));
  try {
    const name = (c.file_name ?? `${m.message_id}.png`).replace(/[\\/:*?"<>|]/g, "_");
    await larkCli(["im", "+messages-resources-download", "--message-id", m.message_id, "--file-key", key, "--type", type, "--output", name, "--as", "user", "--format", "json"], 120_000, dir);
    const file = existsSync(join(dir, name)) ? join(dir, name) : readdirSync(dir).map((f) => join(dir, f)).find((f) => statSync(f).isFile());
    if (!file) return null;
    const r = await importFile(app, spaceId, file, `lark:${chatId}/${name}`);
    return r?.id ?? null;
  } catch (e) {
    console.warn(`[omem] 飞书附件下载失败（${m.message_id}）：${(e as Error).message}`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function importLinkedDocs(app: App, spaceId: string, text: string): Promise<string[]> {
  const ids: string[] = [];
  for (const url of new Set(text.match(DOC_LINK) ?? [])) {
    const existing = findSourceByUri(app, spaceId, url);
    // A doc linked again within a day is not re-read.
    if (existing && Date.now() - Date.parse(existing.updatedAt) < 86400_000) continue;
    try {
      const r = await importUrl(app, spaceId, url);
      ids.push(r.id);
    } catch (e) {
      console.warn(`[omem] 读取飞书文档失败 ${url}：${(e as Error).message}`);
    }
  }
  return ids;
}

// ---- polling ----------------------------------------------------------------------

/** Which space a chat's messages go to: watch rule, subscription, group mapping, then the capture default. */
function chatSpace(app: App, chatId: string): string {
  const rule = watchRule(app, chatId);
  if (rule?.spaceId && findSpace(app, rule.spaceId)) return rule.spaceId;
  const sub = getSubscriptions(app).find((s) => s.chatId === chatId);
  if (sub && findSpace(app, sub.spaceId)) return sub.spaceId;
  const mapped = ((findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>)[chatId];
  if (mapped && findSpace(app, mapped)) return mapped;
  const def = app.config.lark.capture.space;
  return findSpace(app, def) ? def : "personal";
}

async function captureChat(app: App, chat: { chatId: string; name: string; mode: string }, endMs: number, touched: Map<string, Set<string>>) {
  const cfg = app.config.lark.capture;
  const prev = cursor(app, chat.chatId);
  const startMs = prev ? prev.lastTime : endMs - cfg.lookbackHours * 3600_000;
  const fresh = newer(await fetchMessages(["+chat-messages-list", "--chat-id", chat.chatId, "--order", "asc"], startMs, endMs), prev);
  // Replies inside topics live in their threads: follow threads seen recently in this chat.
  const threads = new Set(fresh.filter((m) => m.thread_id).map((m) => m.thread_id!));
  for (const r of all<{ chat_id: string }>(app.db, "select chat_id from lark_cursors where chat_id like ? and updated_at > ?", `thread:${chat.chatId}:%`, new Date(endMs - 7 * 86400_000).toISOString()))
    threads.add(r.chat_id.split(":").pop()!);
  const replies: LarkMessage[] = [];
  for (const t of [...threads].slice(0, 30)) {
    const key = `thread:${chat.chatId}:${t}`;
    const tc = cursor(app, key);
    try {
      const got = newer(await fetchMessages(["+threads-messages-list", "--thread", t, "--order", "desc"], tc ? tc.lastTime : startMs, endMs, 5, false), tc).filter((m) => !fresh.some((f) => f.message_id === m.message_id));
      for (const m of got) m.thread_id = t;
      replies.push(...got);
      saveCursor(app, key, chat.name, "thread", got, tc);
    } catch (e) {
      console.warn(`[omem] 读取话题失败 ${t}：${(e as Error).message}`);
    }
  }
  const messages = [...fresh, ...replies].sort((a, b) => timeMs(a.create_time) - timeMs(b.create_time));
  saveCursor(app, chat.chatId, chat.name, chat.mode, fresh, prev);
  if (!messages.length) return 0;

  const spaceId = chatSpace(app, chat.chatId);
  const ids = touched.get(spaceId) ?? new Set<string>();
  const lines: string[] = [];
  for (const m of messages) {
    let text = messageText(m).replace(/\n/g, " ⏎ ");
    if (cfg.attachments && ["image", "file", "media", "audio", "video"].includes(m.msg_type)) {
      const id = await downloadAttachment(app, spaceId, chat.chatId, m);
      if (id) {
        ids.add(id);
        text += ` → src:${id}`;
      }
    }
    if (cfg.docs) for (const id of await importLinkedDocs(app, spaceId, text)) ids.add(id);
    lines.push(`[${fmt(m.create_time)}${m.thread_id ? ` · 话题 ${m.thread_id}` : ""}] ${m.sender?.name ?? m.sender?.id ?? "?"}: ${text} (${m.message_id})`);
  }
  const r = appendToSource(app, {
    spaceId,
    kind: "chat",
    uri: `lark:${chat.chatId}`,
    title: chat.mode === "p2p" ? `与 ${chat.name} 的私聊` : chat.name,
    lines,
    meta: { chatId: chat.chatId, chatMode: chat.mode, via: "lark-cli" },
  });
  ids.add(r.id);
  touched.set(spaceId, ids);

  const watched: ChatMessage[] = messages.map((m) => ({
    id: m.message_id,
    time: m.create_time,
    sender: m.sender?.name ?? m.sender?.id ?? "?",
    senderId: m.sender?.id,
    text: messageText(m),
    topicId: m.thread_id,
    mentions: (m.mentions ?? []).map((x) => (typeof x.id === "string" ? x.id : (x.id?.open_id ?? ""))).filter(Boolean),
  }));
  await routeWatchedMessages(app, chat.chatId, chat.name, watched);
  return messages.length;
}

let polling = false;
export async function pollLark(app: App) {
  // A long first read must not overlap with the next scheduled one.
  if (polling) return { chats: 0, messages: 0, spaces: [], skipped: "上一次采集还没结束" };
  polling = true;
  try {
    return await pollLarkOnce(app);
  } finally {
    polling = false;
  }
}

async function pollLarkOnce(app: App) {
  const cfg = app.config.lark.capture;
  const endMs = Date.now();
  const touched = new Map<string, Set<string>>();
  const subs = getSubscriptions(app);
  const exclude = new Set(cfg.exclude);
  let chats: { chatId: string; name: string; mode: string }[] = [];
  if (cfg.mode === "all") chats = (await listLarkChats(Math.ceil(cfg.maxChats / 100))).filter((c) => !exclude.has(c.chatId)).slice(0, cfg.maxChats);
  else if (cfg.mode === "subscribed") chats = subs.map((s) => ({ chatId: s.chatId, name: s.name, mode: "group" }));
  // Watched chats are always read.
  for (const r of all<{ chat_id: string }>(app.db, "select chat_id from chat_settings where channel = 'lark-watch' and settings like '%\"watch\"%'"))
    if (!chats.some((c) => c.chatId === r.chat_id)) chats.push({ chatId: r.chat_id, name: r.chat_id, mode: "group" });

  let quiet = 0;
  let read = 0;
  let messages = 0;
  for (const chat of chats) {
    try {
      const n = await captureChat(app, chat, endMs, touched);
      read++;
      messages += n;
      // Chats come most recently active first: a run of quiet chats that were read before means the rest are quiet too.
      quiet = n || !cursor(app, chat.chatId) ? 0 : quiet + 1;
      if (cfg.mode === "all" && quiet >= cfg.quietStop) break;
    } catch (e) {
      console.warn(`[omem] 读取飞书会话失败 ${chat.name}：${(e as Error).message}`);
    }
  }

  // Mentions of the owner anywhere, when only some chats are read.
  if (cfg.mode === "subscribed") await captureMentions(app, subs, endMs, touched).catch((e) => console.warn("[omem] 飞书 @我 消息读取失败：", (e as Error).message));
  if (cfg.calendar) await captureCalendar(app, touched).catch((e) => console.warn("[omem] 飞书日程读取失败：", (e as Error).message));
  if (cfg.minutes) await captureMinutes(app, touched).catch((e) => console.warn("[omem] 飞书妙记读取失败：", (e as Error).message));

  for (const [spaceId, ids] of touched) scheduleIngest(app, spaceId, [...ids], "飞书新消息、日程或妙记");
  return { chats: read, messages, spaces: [...touched.keys()] };
}

async function captureMentions(app: App, subs: Subscription[], endMs: number, touched: Map<string, Set<string>>) {
  const since = Number(one<{ value: string }>(app.db, "select value from kv where key = 'lark_mentions_since_ms'")?.value ?? endMs - 24 * 3600_000);
  const me = await larkCli(["auth", "status", "--json", "--verify"]);
  const owner = (me.data ?? me).identities?.user?.openId as string | undefined;
  if (owner) {
    const subscribed = new Set(subs.map((s) => s.chatId));
    const mentions = (await fetchMessages(["+messages-search", "--at-chatter-ids", owner, "--chat-type", "group"], since, endMs)).filter((m) => !subscribed.has(m.chat_id ?? ""));
    if (mentions.length) {
      const r = appendToSource(app, {
        spaceId: "personal",
        kind: "chat",
        uri: "lark:mentions",
        title: "飞书中 @我 的消息",
        lines: mentions.map((m) => `[${fmt(m.create_time)}] ${m.chat_name ?? m.chat_id}｜${m.sender?.name ?? "?"}: ${messageText(m).replace(/\n/g, " ⏎ ")} (${m.message_id})`),
      });
      touched.set("personal", new Set([...(touched.get("personal") ?? []), r.id]));
    }
  }
  run(app.db, "insert into kv(key,value) values('lark_mentions_since_ms', ?) on conflict(key) do update set value = excluded.value", String(endMs));
}

function hourlyDue(app: App, key: string, minutes = 60) {
  const last = one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value;
  if (last && Date.now() - Date.parse(last) < minutes * 60_000) return false;
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, now());
  return true;
}

/** Calendar events from yesterday to a week ahead: one event source each, updated when the event changes. */
export async function captureCalendar(app: App, touched: Map<string, Set<string>>) {
  if (!hourlyDue(app, "lark_calendar_at")) return 0;
  const start = new Date(Date.now() - 86400_000).toISOString();
  const end = new Date(Date.now() + 7 * 86400_000).toISOString();
  const v = await larkCli(["calendar", "+agenda", "--start", start, "--end", end, "--as", "user", "--format", "json"]);
  const events = (v.data?.events ?? v.data?.items ?? v.data ?? []) as Record<string, any>[];
  if (!Array.isArray(events)) return 0;
  const spaceId = findSpace(app, app.config.lark.capture.space) ? app.config.lark.capture.space : "personal";
  let n = 0;
  for (const e of events) {
    const id = e.event_id ?? e.id;
    if (!id) continue;
    const when = (t: any) => (t?.date_time ?? t?.datetime ?? (t?.timestamp ? new Date(Number(t.timestamp) * 1000).toISOString() : t?.date) ?? (typeof t === "string" ? t : "")) as string;
    const attendees = (e.attendees ?? []).map((a: any) => a.display_name ?? a.name ?? a.user_id ?? "").filter(Boolean);
    const text = [
      `# ${e.summary ?? e.title ?? "（无标题日程）"}`,
      "",
      `- 时间：${when(e.start_time)} → ${when(e.end_time)}`,
      e.location?.name || e.location ? `- 地点：${e.location?.name ?? e.location}` : "",
      e.organizer?.display_name || e.event_organizer?.display_name ? `- 组织者：${e.organizer?.display_name ?? e.event_organizer?.display_name}` : "",
      attendees.length ? `- 参与者：${attendees.join("、")}` : "",
      e.vchat?.meeting_url ? `- 会议链接：${e.vchat.meeting_url}` : "",
      e.status ? `- 状态：${e.status}` : "",
      "",
      String(e.description ?? "").trim(),
    ]
      .filter((l) => l !== "")
      .join("\n");
    const r = upsertSource(app, { spaceId, kind: "event", uri: `lark:calendar:${id}`, title: `日程：${e.summary ?? e.title ?? id}`, text, meta: { via: "lark-cli", start: when(e.start_time) } });
    if (r.status !== "unchanged") {
      touched.set(spaceId, new Set([...(touched.get(spaceId) ?? []), r.id]));
      n++;
    }
  }
  return n;
}

/** Minutes the owner owns or joined since the last check: summary, todos and transcript. */
export async function captureMinutes(app: App, touched: Map<string, Set<string>>) {
  if (!hourlyDue(app, "lark_minutes_at")) return 0;
  const since = one<{ value: string }>(app.db, "select value from kv where key = 'lark_minutes_since'")?.value ?? new Date(Date.now() - 7 * 86400_000).toISOString();
  const seen = new Set<string>(json(one<{ value: string }>(app.db, "select value from kv where key = 'lark_minutes_seen'")?.value, []));
  const tokens = new Map<string, string>();
  for (const flag of ["--owner-ids", "--participant-ids"]) {
    const v = await larkCli(["minutes", "+search", flag, "me", "--start", since, "--page-size", "30", "--as", "user", "--format", "json"]);
    for (const it of (v.data?.items ?? []) as Record<string, any>[]) {
      const t = it.minute_token ?? it.token;
      if (t && !seen.has(t)) tokens.set(t, it.title ?? t);
    }
  }
  const spaceId = findSpace(app, app.config.lark.capture.space) ? app.config.lark.capture.space : "personal";
  let n = 0;
  for (const [token, title] of tokens) {
    const dir = mkdtempSync(join(tmpdir(), "omem-minutes-"));
    try {
      const v = await larkCli(["minutes", "+detail", "--minute-tokens", token, "--summary", "--todo", "--chapter", "--transcript", "--output-dir", dir, "--overwrite", "--as", "user", "--format", "json"], 180_000, dir);
      const m = ((v.data?.minutes ?? []) as Record<string, any>[])[0] ?? {};
      const a = m.artifacts ?? {};
      let transcript = "";
      const file = a.transcript_file ? (existsSync(a.transcript_file) ? a.transcript_file : join(dir, a.transcript_file)) : null;
      if (file && existsSync(file)) transcript = readFileSync(file, "utf8");
      const todos = (a.todos ?? []).map((t: any) => `- ${t.content ?? t.text ?? JSON.stringify(t)}`).join("\n");
      const chapters = (a.chapters ?? []).map((c: any) => `- ${c.title ?? ""}${c.summary ? `：${c.summary}` : ""}`).join("\n");
      const text = [`# ${m.title ?? title}`, a.summary ? `## 总结\n\n${a.summary}` : "", todos ? `## 待办\n\n${todos}` : "", chapters ? `## 章节\n\n${chapters}` : "", transcript ? `## 逐字稿\n\n${transcript}` : ""].filter(Boolean).join("\n\n");
      const r = upsertSource(app, { spaceId, kind: "meeting", uri: `lark:minutes:${token}`, title: `妙记：${m.title ?? title}`, text, meta: { via: "lark-cli", minuteToken: token } });
      touched.set(spaceId, new Set([...(touched.get(spaceId) ?? []), r.id]));
      seen.add(token);
      n++;
    } catch (e) {
      console.warn(`[omem] 读取妙记 ${token} 失败：${(e as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  run(app.db, "insert into kv(key,value) values('lark_minutes_seen', ?) on conflict(key) do update set value = excluded.value", JSON.stringify([...seen].slice(-500)));
  run(app.db, "insert into kv(key,value) values('lark_minutes_since', ?) on conflict(key) do update set value = excluded.value", new Date(Date.now() - 86400_000).toISOString());
  return n;
}

/** Recent messages of chats that are not subscribed yet, for the curator role to judge. */
export async function previewUnsubscribed(app: App, maxChats = 30) {
  const subscribed = new Set(getSubscriptions(app).map((s) => s.chatId));
  const excluded = new Set<string>(json(one<{ value: string }>(app.db, "select value from kv where key = 'lark_curate_excluded'")?.value, []));
  const chats = (await listLarkChats()).filter((c) => c.mode !== "p2p" && !subscribed.has(c.chatId) && !excluded.has(c.chatId)).slice(0, maxChats);
  const end = Date.now();
  const out: { chatId: string; name: string; preview: string[] }[] = [];
  for (const c of chats) {
    try {
      const msgs = await fetchMessages(["+chat-messages-list", "--chat-id", c.chatId, "--order", "desc"], end - 3 * 86400_000, end, 1);
      out.push({ chatId: c.chatId, name: c.name, preview: msgs.slice(0, 12).reverse().map((m) => `${m.sender?.name ?? "?"}: ${messageText(m).replace(/\n/g, " ").slice(0, 120)}`) });
    } catch {
      out.push({ chatId: c.chatId, name: c.name, preview: [] });
    }
  }
  return out;
}
