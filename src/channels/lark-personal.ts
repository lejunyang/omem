import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleIngest } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { json, now } from "../core/util.ts";
import type { CapturePolicy } from "../core/config.ts";
import { chatSettings, setChatSettings } from "../agents/threads.ts";
import { importFile, importUrl } from "../sources/import.ts";
import { appendToSource, findSourceByUri, upsertSource } from "../sources/store.ts";
import { larkCli } from "./lark-cli.ts";
import { flattenReplies, formatLine, isApp, keepResources, learnPeople, mentionIds, messageText, monthOf, parentOf, quotedMessages, rebuildArchive, storeMessages, timeMs, type LarkMessage, type ResourceRef } from "./lark-messages.ts";
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

export type ChatKind = "p2p" | "bot" | "own-bot" | "group" | "topic";
export const CHAT_KIND_LABELS: Record<ChatKind, string> = { p2p: "单聊", bot: "机器人单聊", "own-bot": "omem 机器人", group: "群聊", topic: "话题群" };
export const POLICY_LABELS: Record<CapturePolicy, string> = { ingest: "保存并整理", involved: "保存，与本人有关时整理", store: "只保存", skip: "不读取" };
export type LarkChat = { chatId: string; name: string; mode: string; kind: ChatKind; muted: boolean };
type RawChat = { chat_id: string; name: string; chat_mode: string; p2p_target_type?: string };

async function rawChats(pages: number, excludeMuted: boolean) {
  const args = ["im", "+chat-list", "--as", "user", "--types", "p2p,group", "--sort", "active_time", "--page-size", "100", "--page-all", "--page-limit", String(pages), "--format", "json"];
  if (excludeMuted) args.push("--exclude-muted");
  const v = await larkCli(args);
  return (v.data?.chats ?? []) as RawChat[];
}

/** omem's own bot chat with the owner: its messages are conversations with omem, never material. */
function ownBotChat(app: App) {
  return one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value ?? null;
}

export function chatKind(app: App, c: { chat_id: string; chat_mode: string; p2p_target_type?: string }): ChatKind {
  if (c.chat_id === ownBotChat(app)) return "own-bot";
  if (c.chat_mode === "p2p") {
    // Learned from messages: a p2p whose other side only ever speaks as an app.
    const seen = one<{ kind: string }>(app.db, "select kind from lark_cursors where chat_id = ?", c.chat_id)?.kind;
    if (seen === "bot" || seen === "own-bot") return seen;
    return !c.p2p_target_type || c.p2p_target_type === "user" ? "p2p" : "bot";
  }
  return c.chat_mode === "topic" ? "topic" : "group";
}

/**
 * The owner's chats, most recently active first, with kind and do-not-disturb state.
 * Mute state costs a second listing, so it is refreshed at most every half hour.
 */
export async function listLarkChats(app: App, pages = 3): Promise<LarkChat[]> {
  const all = await rawChats(pages, false);
  const key = "lark_unmuted";
  let cache = json<{ at?: number; pages?: number; ids?: string[] }>(one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value, {});
  if (!cache.at || Date.now() - cache.at > 30 * 60_000 || (cache.pages ?? 0) < pages) {
    try {
      cache = { at: Date.now(), pages, ids: (await rawChats(pages, true)).map((c) => c.chat_id) };
      run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, JSON.stringify(cache));
    } catch (e) {
      console.warn("[omem] 读取飞书免打扰状态失败，暂按未免打扰处理：", (e as Error).message);
      cache = { ids: all.map((c) => c.chat_id) };
    }
  }
  const unmuted = new Set(cache.ids ?? []);
  return all.map((c) => ({ chatId: c.chat_id, name: c.name || c.chat_id, mode: c.chat_mode, kind: chatKind(app, c), muted: !unmuted.has(c.chat_id) }));
}

/** The capture policy for one chat: its own setting, then explicit opt-ins, then do-not-disturb, then its kind. */
export function capturePolicyFor(app: App, chat: { chatId: string; kind: ChatKind; muted: boolean }): CapturePolicy {
  if (chat.kind === "own-bot") return "skip";
  const own = chatSettings(app, "lark-capture", chat.chatId).policy;
  if (own) return own;
  if (getSubscriptions(app).some((s) => s.chatId === chat.chatId)) return "ingest";
  const policies = app.config.lark.capture.policies;
  if (chat.muted) return policies.muted;
  return policies[chat.kind];
}

export function setCapturePolicy(app: App, chatId: string, policy: CapturePolicy | null) {
  setChatSettings(app, "lark-capture", chatId, { policy: policy ?? undefined });
}

/** Chats seen by capture, with what is done with them (for the settings page). */
export function capturedChats(app: App) {
  return all<{ chat_id: string; name: string; chat_mode: string; kind: string; muted: number; involved: number; last_time: number; updated_at: string | null; oldest_ms: number | null; backfill_to_ms: number | null }>(
    app.db,
    "select chat_id, name, chat_mode, kind, muted, involved, last_time, updated_at, oldest_ms, backfill_to_ms from lark_cursors where chat_id not like 'thread:%' order by last_time desc limit 500",
  ).map((r) => {
    const kind = (r.kind || (r.chat_mode === "p2p" ? "p2p" : r.chat_mode === "topic" ? "topic" : "group")) as ChatKind;
    const own = chatSettings(app, "lark-capture", r.chat_id).policy ?? null;
    return {
      chatId: r.chat_id,
      name: r.name,
      kind,
      muted: !!r.muted,
      involved: !!r.involved,
      lastMessageAt: r.last_time ? new Date(r.last_time).toISOString() : null,
      policy: capturePolicyFor(app, { chatId: r.chat_id, kind, muted: !!r.muted }),
      own,
      /** Capture covers messages from here on (live first read or backfilled history). */
      from: r.oldest_ms ? new Date(r.oldest_ms).toISOString() : null,
      backfilling: !!r.backfill_to_ms && !!r.oldest_ms && r.oldest_ms > r.backfill_to_ms,
    };
  });
}

export { messageText, timeMs };
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/**
 * Messages in a time window, oldest pages first or newest first. lark-cli expands thread
 * replies under their host (`thread_replies`); they are flattened into messages of their own.
 * With `download`, resources are saved under `cwd` and listed on each message.
 */
async function fetchMessages(args: string[], startMs: number, endMs: number, opts: { pages?: number; timed?: boolean; cwd?: string; download?: boolean } = {}) {
  const { pages = 20, timed = true } = opts;
  const out: LarkMessage[] = [];
  let token: string | undefined;
  for (let page = 0; page < pages; page++) {
    const range = timed ? ["--start", iso(startMs), "--end", iso(endMs)] : [];
    const v = await larkCli(
      ["im", ...args, ...range, "--page-size", "50", "--no-reactions", ...(opts.download ? ["--download-resources"] : []), ...(token ? ["--page-token", token] : []), "--as", "user", "--format", "json"],
      opts.download ? 300_000 : 90_000,
      opts.cwd,
    );
    out.push(...((v.data?.messages ?? []) as LarkMessage[]));
    if (!v.data?.has_more || !v.data.page_token) break;
    token = v.data.page_token;
  }
  // Thread listing has no time filter: apply the window here.
  return flattenReplies(out).filter((m) => !m.deleted && (timed || (timeMs(m.create_time) >= startMs && timeMs(m.create_time) <= endMs)));
}

// ---- cursors -------------------------------------------------------------------

type Cursor = { key: string; lastTime: number; lastIds: string[] };
function cursor(app: App, key: string): Cursor | null {
  const r = one<{ last_time: number; last_ids: string }>(app.db, "select last_time, last_ids from lark_cursors where chat_id = ?", key);
  return r ? { key, lastTime: r.last_time, lastIds: json(r.last_ids, []) } : null;
}
function saveCursor(app: App, key: string, name: string, mode: string, messages: LarkMessage[], prev: Cursor | null, extra: { kind?: string; muted?: boolean; involved?: boolean; oldestMs?: number } = {}) {
  const last = messages.length ? Math.max(...messages.map((m) => timeMs(m.create_time))) : (prev?.lastTime ?? Date.now());
  const ids = messages.filter((m) => timeMs(m.create_time) === last).map((m) => m.message_id);
  run(
    app.db,
    `insert into lark_cursors(chat_id,name,chat_mode,last_time,last_ids,updated_at,kind,muted,involved,oldest_ms) values(?,?,?,?,?,?,?,?,?,?)
     on conflict(chat_id) do update set name = excluded.name, chat_mode = case when excluded.chat_mode != '' then excluded.chat_mode else lark_cursors.chat_mode end,
       last_time = excluded.last_time, last_ids = excluded.last_ids, updated_at = excluded.updated_at,
       kind = case when excluded.kind != '' then excluded.kind else lark_cursors.kind end, muted = excluded.muted, involved = max(lark_cursors.involved, excluded.involved),
       oldest_ms = coalesce(lark_cursors.oldest_ms, excluded.oldest_ms)`,
    key,
    name,
    mode,
    last,
    JSON.stringify(ids.length ? ids : (prev?.lastIds ?? [])),
    now(),
    extra.kind ?? "",
    extra.muted ? 1 : 0,
    extra.involved ? 1 : 0,
    extra.oldestMs ?? null,
  );
}

/** Earliest time live capture covers for a chat (captured before oldest_ms was kept: first capture minus the lookback). */
function liveOldest(app: App, chatId: string): number {
  const c = one<{ oldest_ms: number | null; last_time: number }>(app.db, "select oldest_ms, last_time from lark_cursors where chat_id = ?", chatId);
  if (c?.oldest_ms) return c.oldest_ms;
  const src = one<{ captured_at: string }>(app.db, "select captured_at from sources where uri = ? order by captured_at limit 1", `lark:${chatId}`);
  const lookback = app.config.lark.capture.lookbackHours * 3600_000;
  return src ? Date.parse(src.captured_at) - lookback : (c?.last_time ?? Date.now() - lookback);
}
/** Messages after the cursor (the boundary millisecond is shared, so ids seen there are skipped). */
function newer(messages: LarkMessage[], c: Cursor | null) {
  if (!c) return messages;
  return messages.filter((m) => timeMs(m.create_time) > c.lastTime || (timeMs(m.create_time) === c.lastTime && !c.lastIds.includes(m.message_id)));
}

// ---- per-message extras ----------------------------------------------------------

const DOC_LINK = /https?:\/\/[\w.-]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki)\/[A-Za-z0-9]+/g;

async function importLinkedDocs(app: App, spaceId: string, text: string): Promise<string[]> {
  const ids: string[] = [];
  for (const url of new Set(text.match(DOC_LINK) ?? [])) {
    const existing = findSourceByUri(app, spaceId, url);
    // A doc linked again within a day is not re-read.
    if (existing && Date.now() - Date.parse(existing.updatedAt) < 86400_000) continue;
    try {
      const r = await importUrl(app, spaceId, url);
      ids.push(r.id, ...(r.related ?? []));
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


type CaptureCtx = { endMs: number; touched: Map<string, Set<string>>; owner?: string };

/** Whether the ingest role should see this batch, given the chat's policy and whether the owner is in it. */
const wantsIngest = (policy: CapturePolicy, involved: boolean) => policy === "ingest" || (policy === "involved" && involved);

async function captureChat(app: App, chat: LarkChat, c: CaptureCtx) {
  const { endMs, touched, owner } = c;
  const cfg = app.config.lark.capture;
  const policy = capturePolicyFor(app, chat);
  if (policy === "skip") return 0;
  const prev = cursor(app, chat.chatId);
  const startMs = prev ? prev.lastTime : endMs - cfg.lookbackHours * 3600_000;
  const dir = cfg.attachments ? mkdtempSync(join(tmpdir(), "omem-lark-")) : undefined;
  try {
    const fresh = newer(await fetchMessages(["+chat-messages-list", "--chat-id", chat.chatId, "--order", "asc"], startMs, endMs, { cwd: dir, download: !!dir }), prev);
    // Replies in topics whose root is older than this window: follow threads seen recently.
    const threads = new Set<string>();
    for (const r of all<{ chat_id: string }>(app.db, "select chat_id from lark_cursors where chat_id like ? and updated_at > ?", `thread:${chat.chatId}:%`, new Date(endMs - 7 * 86400_000).toISOString()))
      threads.add(r.chat_id.split(":").pop()!);
    for (const m of fresh) if (m.thread_id) threads.add(m.thread_id);
    const replies: LarkMessage[] = [];
    const involvedThreads = new Set<string>();
    const have = new Set(fresh.map((m) => m.message_id));
    for (const t of [...threads].slice(0, 30)) {
      const key = `thread:${chat.chatId}:${t}`;
      const tc = cursor(app, key);
      try {
        const known = fresh.filter((m) => m.thread_id === t);
        // A host in this batch whose replies all came nested needs no second read.
        const got = known.some((m) => m.expanded)
          ? []
          : newer(await fetchMessages(["+threads-messages-list", "--thread", t, "--order", "desc"], tc ? tc.lastTime : startMs, endMs, { pages: 5, timed: false, cwd: dir, download: !!dir }), tc).filter((m) => !have.has(m.message_id));
        for (const m of got) m.thread_id = t;
        replies.push(...got);
        const inThread = [...got, ...known];
        const ownerHere = !!owner && inThread.some((m) => m.sender?.id === owner || mentionIds(m).includes(owner));
        if (ownerHere || one(app.db, "select 1 from lark_cursors where chat_id = ? and involved = 1", key)) involvedThreads.add(t);
        saveCursor(app, key, chat.name, "thread", inThread, tc, { kind: "thread", involved: ownerHere });
      } catch (e) {
        console.warn(`[omem] 读取话题失败 ${t}：${(e as Error).message}`);
      }
    }
    // omem's own bot speaks in chats too: its replies and cards are omem's output, not material.
    const ownApp = app.config.lark.appId;
    const messages = [...fresh, ...replies].filter((m) => !(ownApp && m.sender?.id === ownApp)).sort((a, b) => timeMs(a.create_time) - timeMs(b.create_time));
    // A p2p chat whose other side only ever speaks as an app is a bot chat (notifications), whatever the listing said.
    let kind = chat.kind;
    const others = messages.filter((m) => m.sender?.id !== owner && m.msg_type !== "system");
    if (kind === "p2p" && others.length && others.every(isApp)) kind = "bot";
    const involved = !!owner && messages.some((m) => m.sender?.id === owner || mentionIds(m).includes(owner) || (m.thread_id && involvedThreads.has(m.thread_id)));
    // The chat cursor follows the listing itself; nested replies can be newer than hosts not fetched yet.
    saveCursor(app, chat.chatId, chat.name, chat.mode, fresh.filter((m) => !m.nested), prev, { kind, muted: chat.muted, involved, oldestMs: startMs });
    if (!messages.length) return 0;

    const finalPolicy = kind === chat.kind ? policy : capturePolicyFor(app, { ...chat, kind });
    const ingest = wantsIngest(finalPolicy, involved);
    const spaceId = chatSpace(app, chat.chatId);
    const ids = touched.get(spaceId) ?? new Set<string>();
    const resources = dir ? await keepResources(app, spaceId, chat.chatId, messages, dir, ingest) : new Map<string, Record<string, ResourceRef>>();
    const quoted = await quotedMessages(app, chat.chatId, messages, owner);
    const linked: string[] = [];
    const lines: string[] = [];
    for (const m of messages) {
      if (cfg.docs && ingest) linked.push(...(await importLinkedDocs(app, spaceId, messageText(m))));
      lines.push(formatLine(m, { owner, quoted: quoted.get(parentOf(m)) ?? null, resources: resources.get(m.message_id) }));
    }
    const r = appendToSource(app, {
      spaceId,
      kind: "chat",
      uri: `lark:${chat.chatId}`,
      title: chat.mode === "p2p" ? `与 ${chat.name} 的私聊` : chat.name,
      lines,
      meta: { chatId: chat.chatId, chatMode: chat.mode, chatKind: kind, muted: chat.muted, via: "lark-cli" },
    });
    storeMessages(app, chat.chatId, messages, { owner, sourceId: r.id, firstLine: r.appendedFrom, resources });
    await learnPeople(app, messages);
    // Only what the policy says is worth understanding goes to the ingest role; the rest stays searchable.
    if (ingest) {
      ids.add(r.id);
      for (const refs of resources.values()) for (const ref of Object.values(refs)) if (ref.sourceId) ids.add(ref.sourceId);
      for (const id of linked) ids.add(id);
      touched.set(spaceId, ids);
    }
    // First time this chat is read: queue its history if its policy asks for that.
    if (!prev) planBackfill(app, chat.chatId, finalPolicy, startMs);

    const watched: ChatMessage[] = messages.map((m) => ({
      id: m.message_id,
      time: m.create_time,
      sender: m.sender?.name ?? m.sender?.id ?? "?",
      senderId: m.sender?.id,
      text: messageText(m),
      topicId: m.thread_id,
      mentions: mentionIds(m),
    }));
    await routeWatchedMessages(app, chat.chatId, chat.name, watched);
    return messages.length;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// ---- history backfill ---------------------------------------------------------------

/** Queue history for a chat captured for the first time, per lark.capture.backfill. */
function planBackfill(app: App, chatId: string, policy: CapturePolicy, oldestMs: number) {
  const b = app.config.lark.capture.backfill;
  if (!b.days || !b.policies.includes(policy)) return;
  run(app.db, "update lark_cursors set backfill_to_ms = ?, oldest_ms = coalesce(oldest_ms, ?) where chat_id = ? and backfill_to_ms is null", oldestMs - b.days * 86400_000, oldestMs, chatId);
}

/** Ask for a chat's history back to `days` ago (or everything, days = 0). Runs a few pages per poll. */
export function requestBackfill(app: App, chatId: string, days: number, ingest = false) {
  const c = one<{ chat_id: string; oldest_ms: number | null; last_time: number }>(app.db, "select chat_id, oldest_ms, last_time from lark_cursors where chat_id = ?", chatId);
  const target = days > 0 ? Date.now() - days * 86400_000 : Date.parse("2010-01-01");
  if (!c)
    run(
      app.db,
      "insert into lark_cursors(chat_id,name,chat_mode,last_time,last_ids,updated_at,oldest_ms,backfill_to_ms,backfill_ingest) values(?,?,?,?,?,?,?,?,?)",
      chatId,
      chatId,
      "",
      Date.now() - app.config.lark.capture.lookbackHours * 3600_000,
      "[]",
      now(),
      Date.now() - app.config.lark.capture.lookbackHours * 3600_000,
      target,
      ingest ? 1 : 0,
    );
  else run(app.db, "update lark_cursors set backfill_to_ms = ?, backfill_ingest = ?, oldest_ms = ? where chat_id = ?", target, ingest ? 1 : 0, liveOldest(app, chatId), chatId);
  return backfillStatus(app, chatId);
}

export function backfillStatus(app: App, chatId: string) {
  const c = one<{ oldest_ms: number | null; backfill_to_ms: number | null }>(app.db, "select oldest_ms, backfill_to_ms from lark_cursors where chat_id = ?", chatId);
  const archived = one<{ n: number; first: number | null }>(app.db, "select count(*) n, min(create_ms) first from lark_messages where chat_id = ? and archive is not null", chatId);
  return {
    pending: !!c?.backfill_to_ms && !!c.oldest_ms && c.oldest_ms > c.backfill_to_ms,
    reachedAt: c?.oldest_ms ? new Date(c.oldest_ms).toISOString() : null,
    target: c?.backfill_to_ms ? new Date(c.backfill_to_ms).toISOString() : null,
    archived: archived?.n ?? 0,
    earliest: archived?.first ? new Date(archived.first).toISOString() : null,
  };
}

/**
 * One step of history for each chat that wants it: newest-first pages below what was already
 * captured, into monthly archive sources. Each poll spends at most `pagesPerPoll` pages in total
 * so a long history comes in over many polls without starving live capture.
 */
async function backfillStep(app: App, owner: string | undefined, touched: Map<string, Set<string>>) {
  const b = app.config.lark.capture.backfill;
  let budget = b.pagesPerPoll;
  const pending = all<{ chat_id: string; name: string; chat_mode: string; kind: string; oldest_ms: number; backfill_to_ms: number; backfill_ingest: number }>(
    app.db,
    "select chat_id, name, chat_mode, kind, oldest_ms, backfill_to_ms, backfill_ingest from lark_cursors where chat_id not like 'thread:%' and backfill_to_ms is not null and oldest_ms > backfill_to_ms order by last_time desc limit 5",
  );
  for (const c of pending) {
    if (budget <= 0) break;
    const dir = app.config.lark.capture.attachments ? mkdtempSync(join(tmpdir(), "omem-lark-")) : undefined;
    try {
      let oldest = c.oldest_ms;
      const months = new Set<string>();
      while (budget > 0 && oldest > c.backfill_to_ms) {
        budget--;
        const page = await fetchMessages(["+chat-messages-list", "--chat-id", c.chat_id, "--order", "desc"], c.backfill_to_ms, oldest, { pages: 1, cwd: dir, download: !!dir });
        const known = new Set(all<{ message_id: string }>(app.db, `select message_id from lark_messages where message_id in (${page.map(() => "?").join(",") || "''"})`, ...page.map((m) => m.message_id)).map((r) => r.message_id));
        const fresh = page.filter((m) => !known.has(m.message_id) && !(app.config.lark.appId && m.sender?.id === app.config.lark.appId));
        const roots = page.filter((m) => !m.thread_id || page.every((x) => x.thread_id !== m.thread_id || timeMs(x.create_time) >= timeMs(m.create_time)));
        const earliest = roots.length ? Math.min(...roots.map((m) => timeMs(m.create_time))) : c.backfill_to_ms;
        if (fresh.length) {
          const spaceId = chatSpace(app, c.chat_id);
          const resources = dir ? await keepResources(app, spaceId, c.chat_id, fresh, dir, !!c.backfill_ingest) : new Map<string, Record<string, ResourceRef>>();
          const byMonth = new Map<string, LarkMessage[]>();
          for (const m of fresh) byMonth.set(monthOf(timeMs(m.create_time)), [...(byMonth.get(monthOf(timeMs(m.create_time))) ?? []), m]);
          for (const [month, group] of byMonth) {
            storeMessages(app, c.chat_id, group, { owner, archive: month, resources });
            await learnPeople(app, group);
            months.add(month);
          }
          await quotedMessages(app, c.chat_id, fresh, owner);
        }
        // Done when a page comes back short of new history.
        oldest = !fresh.length || earliest >= oldest ? c.backfill_to_ms : earliest;
        run(app.db, "update lark_cursors set oldest_ms = ? where chat_id = ?", oldest, c.chat_id);
      }
      const spaceId = chatSpace(app, c.chat_id);
      for (const month of months) {
        const src = rebuildArchive(app, { chatId: c.chat_id, name: c.chat_mode === "p2p" ? `与 ${c.name} 的私聊` : c.name, spaceId, month, chatKind: c.kind || c.chat_mode, owner });
        if (src && c.backfill_ingest && oldest <= c.backfill_to_ms) touched.set(spaceId, new Set([...(touched.get(spaceId) ?? []), src.id]));
      }
      if (c.backfill_ingest && oldest <= c.backfill_to_ms) {
        // History finished: hand every archived month to ingest once.
        const ids = all<{ id: string }>(app.db, "select distinct source_id id from lark_messages where chat_id = ? and archive is not null and source_id is not null", c.chat_id).map((r) => r.id);
        const spaceIdAll = chatSpace(app, c.chat_id);
        touched.set(spaceIdAll, new Set([...(touched.get(spaceIdAll) ?? []), ...ids]));
        run(app.db, "update lark_cursors set backfill_ingest = 0 where chat_id = ?", c.chat_id);
      }
    } catch (e) {
      console.warn(`[omem] 回溯飞书历史失败 ${c.name}：${(e as Error).message}`);
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
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
  const owner = await ownerOpenId();
  let chats: LarkChat[] = [];
  const listed = cfg.mode === "all" ? await listLarkChats(app, Math.max(1, Math.ceil(cfg.maxChats / 100))) : [];
  const byId = new Map(listed.map((c) => [c.chatId, c]));
  // Chats not in this listing: what capture learned about them before.
  const known = (chatId: string, name: string): LarkChat => {
    const seen = one<{ kind: string; chat_mode: string; muted: number }>(app.db, "select kind, chat_mode, muted from lark_cursors where chat_id = ?", chatId);
    return byId.get(chatId) ?? { chatId, name, mode: seen?.chat_mode || "group", kind: (seen?.kind as ChatKind) || "group", muted: !!seen?.muted };
  };
  if (cfg.mode === "all") chats = listed.filter((c) => !exclude.has(c.chatId) && capturePolicyFor(app, c) !== "skip").slice(0, cfg.maxChats);
  else if (cfg.mode === "subscribed") chats = subs.map((s) => known(s.chatId, s.name));
  // Watched and subscribed chats are explicit opt-ins: always read, even when muted.
  for (const r of all<{ chat_id: string }>(app.db, "select chat_id from chat_settings where channel = 'lark-watch' and settings like '%\"watch\"%'"))
    if (!chats.some((c) => c.chatId === r.chat_id)) chats.push(known(r.chat_id, r.chat_id));
  for (const s of subs) if (!chats.some((c) => c.chatId === s.chatId) && !exclude.has(s.chatId)) chats.push(known(s.chatId, s.name));

  let quiet = 0;
  let read = 0;
  let messages = 0;
  const readChats = new Set<string>();
  for (const chat of chats) {
    try {
      const n = await captureChat(app, chat, { endMs, touched, owner });
      read++;
      readChats.add(chat.chatId);
      messages += n;
      // Chats come most recently active first: a run of quiet chats that were read before means the rest are quiet too.
      quiet = n || !cursor(app, chat.chatId) ? 0 : quiet + 1;
      if (cfg.mode === "all" && quiet >= cfg.quietStop) break;
    } catch (e) {
      console.warn(`[omem] 读取飞书会话失败 ${chat.name}：${(e as Error).message}`);
    }
  }

  // History the owner asked for (or new chats whose policy wants it), a few pages per poll.
  await backfillStep(app, owner, touched).catch((e) => console.warn("[omem] 飞书历史回溯失败：", (e as Error).message));
  // Mentions of the owner anywhere — even in muted/do-not-disturb chats not read automatically.
  await captureMentions(app, readChats, endMs, touched, owner).catch((e) => console.warn("[omem] 飞书 @我 消息读取失败：", (e as Error).message));
  if (cfg.calendar) await captureCalendar(app, touched).catch((e) => console.warn("[omem] 飞书日程读取失败：", (e as Error).message));
  if (cfg.minutes) await captureMinutes(app, touched).catch((e) => console.warn("[omem] 飞书妙记读取失败：", (e as Error).message));
  // Linked docs that had no permission before (at most every 6 hours).
  if (cfg.docs)
    await import("./lark-docs.ts")
      .then((m) => m.retryMissingDocs(app))
      .then((r) => {
        for (const d of r.imported) touched.set(d.spaceId, (touched.get(d.spaceId) ?? new Set()).add(d.id));
      })
      .catch((e) => console.warn("[omem] 重试飞书文档失败：", (e as Error).message));

  for (const [spaceId, ids] of touched) scheduleIngest(app, spaceId, [...ids], "飞书新消息、日程或妙记");
  return { chats: read, messages, spaces: [...touched.keys()] };
}

/** The owner's open_id as lark-cli sees it (open_ids are per app, so not the bot's ownerOpenId). */
async function ownerOpenId(): Promise<string | undefined> {
  try {
    const me = await larkCli(["auth", "status", "--json", "--verify"]);
    return (me.data ?? me).identities?.user?.openId as string | undefined;
  } catch {
    return undefined;
  }
}

async function captureMentions(app: App, readChats: Set<string>, endMs: number, touched: Map<string, Set<string>>, owner: string | undefined) {
  const since = Number(one<{ value: string }>(app.db, "select value from kv where key = 'lark_mentions_since_ms'")?.value ?? endMs - 24 * 3600_000);
  if (owner) {
    const own = ownBotChat(app);
    const mentions = (await fetchMessages(["+messages-search", "--at-chatter-ids", owner, "--chat-type", "group"], since, endMs)).filter(
      (m) => m.chat_id && !readChats.has(m.chat_id) && m.chat_id !== own && chatSettings(app, "lark-capture", m.chat_id).policy !== "skip",
    );
    if (mentions.length) {
      const r = appendToSource(app, {
        spaceId: "personal",
        kind: "chat",
        uri: "lark:mentions",
        title: "飞书中 @我 的消息",
        lines: mentions.map((m) => formatLine({ ...m, sender: { ...m.sender, name: `${m.chat_name ?? m.chat_id}｜${m.sender?.name ?? "?"}` } }, { owner })),
      });
      storeMessages(app, "mentions", mentions, { owner, sourceId: r.id, firstLine: r.appendedFrom });
      await learnPeople(app, mentions);
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
  const chats = (await listLarkChats(app)).filter((c) => c.mode !== "p2p" && !c.muted && !subscribed.has(c.chatId) && !excluded.has(c.chatId)).slice(0, maxChats);
  const end = Date.now();
  const out: { chatId: string; name: string; preview: string[] }[] = [];
  for (const c of chats) {
    try {
      const msgs = await fetchMessages(["+chat-messages-list", "--chat-id", c.chatId, "--order", "desc"], end - 3 * 86400_000, end, { pages: 1 });
      out.push({ chatId: c.chatId, name: c.name, preview: msgs.slice(0, 12).reverse().map((m) => `${m.sender?.name ?? "?"}: ${messageText(m).replace(/\n/g, " ").slice(0, 120)}`) });
    } catch {
      out.push({ chatId: c.chatId, name: c.name, preview: [] });
    }
  }
  return out;
}
