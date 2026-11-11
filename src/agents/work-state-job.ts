import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { now, truncate } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { listItems } from "../items/store.ts";
import { messageText } from "../channels/lark-messages.ts";
import { pageExists, readPage } from "../wiki/store.ts";
import { listCodeWorks } from "./code-works.ts";
import { chatName } from "./owner-now.ts";
import { registerHandler } from "./runs.ts";
import { runRole } from "./runner.ts";
import { OWNER_SECTION, personSlug, sectionOf, WORK_STATE_PAGE, WORK_STATE_SPACE } from "./work-state.ts";

/**
 * The nightly write-up of the owner's work state (docs/v2/work-state.md): the facts the host
 * gathers for it (workFacts, peopleDue) and the run of the role work-state. What reads it back
 * (the summary, person cards) is in work-state.ts.
 */

const DAY = 86400_000;
/** A person counts as someone the owner deals with from this score up (see peopleScores). */
const PERSON_MIN_SCORE = 4;
/** Lines of a person's messages handed to the role, newest kept. */
const PERSON_LINES = 12;

const localDay = (app: App, at: string | number) => new Date(at).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The page, or null when there is none yet. */
function pageOrNull(app: App, slug: string) {
  return pageExists(app, WORK_STATE_SPACE, slug) ? readPage(app, WORK_STATE_SPACE, slug) : null;
}

// ------------------------------------------------------------------ facts

/** The owner's id in captured messages (lark-cli's open_id): the one their own messages carry most. */
function ownerSenderId(app: App): string | null {
  return one<{ sender_id: string }>(app.db, "select sender_id from lark_messages where sender_kind = 'owner' and sender_id is not null group by sender_id order by count(*) desc limit 1")?.sender_id ?? null;
}

const chatKind = (app: App, chatId: string) => one<{ kind: string }>(app.db, "select kind from lark_cursors where chat_id = ?", chatId)?.kind || "";
const chatSource = (app: App, chatId: string) => one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null limit 1", `lark:${chatId}`)?.id ?? null;
const ref = (r: { source_id: string | null; line: number | null }) => (r.source_id && r.line ? `src:${r.source_id}#L${r.line}` : "");

export type WorkFacts = {
  since: string;
  chats: { chatId: string; name: string; kind: string; owner: number; last: number; source: string | null }[];
  docs: { id: string; title: string; space: string; how: string; at: string }[];
  code: { id: string; title: string; stage: string; now: string; repos: string; updatedAt: string }[];
  items: { id: string; kind: string; status: string; title: string; due: string | null; waitingOn: string | null; updatedAt: string }[];
  meetings: { topic: string; startedAt: string; source: string | null }[];
  asks: { id: string; title: string; at: string }[];
};

/** What the owner did in the window, facts only (no judging what matters: the role does that). */
export function workFacts(app: App, opts: { since: string }): WorkFacts {
  const since = opts.since;
  const sinceMs = Date.parse(since);
  const chats = all<{ chat_id: string; n: number; last: number }>(
    app.db,
    "select chat_id, count(*) n, max(create_ms) last from lark_messages where sender_kind = 'owner' and create_ms > ? group by chat_id order by n desc limit 15",
    sinceMs,
  ).map((c) => ({ chatId: c.chat_id, name: chatName(app, c.chat_id), kind: chatKind(app, c.chat_id), owner: c.n, last: c.last, source: chatSource(app, c.chat_id) }));

  // Documents: opened (the recent-docs capture), or linked in what the owner wrote.
  const docs = new Map<string, WorkFacts["docs"][number]>();
  const opened = all<{ key: string; value: string }>(app.db, "select key, value from kv where (key like 'lark_doc_opened:%' or key like 'lark_recent_doc:%') and value > ? order by value desc limit 60", since);
  for (const o of opened) {
    const url = o.key.slice(o.key.indexOf(":") + 1);
    const s = one<{ id: string; title: string; space_id: string }>(app.db, "select id, title, space_id from sources where uri = ? and deleted_at is null limit 1", url);
    if (s && !docs.has(s.id)) docs.set(s.id, { id: s.id, title: s.title, space: s.space_id, how: "打开过", at: o.value });
  }
  const written = all<{ content: string; msg_type: string; create_ms: number }>(app.db, "select content, msg_type, create_ms from lark_messages where sender_kind = 'owner' and create_ms > ? and content like '%http%' order by create_ms desc limit 300", sinceMs);
  for (const m of written)
    for (const u of messageText({ content: m.content, msg_type: m.msg_type }).match(/https?:\/\/[^\s)"'<>）]+/g) ?? []) {
      const s = one<{ id: string; title: string; space_id: string }>(app.db, "select id, title, space_id from sources where uri = ? and deleted_at is null limit 1", u.replace(/[，。,.;；]+$/, ""));
      if (s && !docs.has(s.id)) docs.set(s.id, { id: s.id, title: s.title, space: s.space_id, how: "发过链接", at: new Date(m.create_ms).toISOString() });
    }

  const code = listCodeWorks(app, { ended: true, limit: 60 })
    .filter((w) => w.updatedAt > since)
    .slice(0, 10)
    .map((w) => ({ id: w.rootId, title: w.title, stage: w.stage.text, now: w.now, repos: w.repos.map((r) => `${r.space}${r.branch ? `@${r.branch}` : ""}`).join("、"), updatedAt: w.updatedAt }));
  const items = listItems(app, { status: "active", userId: OWNER, limit: 30 }).map((i) => ({ id: i.id, kind: i.kind, status: i.status, title: i.title, due: i.dueAt ?? null, waitingOn: i.waitingOn ?? null, updatedAt: i.updatedAt }));
  const meetings = all<{ topic: string; started_at: string; source_id: string | null }>(app.db, "select topic, started_at, source_id from lark_meetings where started_at > ? order by started_at desc limit 15", since).map((m) => ({ topic: m.topic, startedAt: m.started_at, source: m.source_id }));
  const asks = all<{ id: string; title: string; created_at: string }>(app.db, "select id, title, created_at from runs where kind = 'ask' and coalesce(user_id, 'owner') = 'owner' and created_at > ? order by created_at desc limit 25", since).map((r) => ({ id: r.id, title: r.title, at: r.created_at }));
  return { since, chats, docs: [...docs.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 15), code, items, meetings, asks };
}

export function workFactsText(app: App, f: WorkFacts): string {
  const kindLabel = (k: string) => (k === "p2p" ? "私聊" : k === "bot" || k === "own-bot" ? "和机器人" : "群");
  return [
    `## 本人发言多的会话（${f.chats.length}）\n${f.chats.map((c) => `- 「${truncate(c.name, 40)}」（${kindLabel(c.kind)}，本人 ${c.owner} 条，最近 ${localDay(app, c.last)}）${c.source ? ` src:${c.source}` : ""}`).join("\n") || "（无）"}`,
    `## 最近的文档（${f.docs.length}）\n${f.docs.map((d) => `- 「${truncate(d.title, 50)}」 src:${d.id}（${d.space}，${d.how}，${localDay(app, d.at)}）`).join("\n") || "（无）"}`,
    `## 编码交办（${f.code.length}）\n${f.code.map((c) => `- ${c.id}「${truncate(c.title, 50)}」${c.repos ? ` ${c.repos}` : ""}：${c.stage}${c.now ? `，${truncate(c.now, 60)}` : ""}（${localDay(app, c.updatedAt)}）`).join("\n") || "（无）"}`,
    `## 打开的事项（${f.items.length}）\n${f.items.map((i) => `- ${i.id} [${i.kind}/${i.status}] ${truncate(i.title, 60)}${i.due ? ` 截止 ${i.due.slice(0, 10)}` : ""}${i.waitingOn ? ` 等 ${i.waitingOn}` : ""}`).join("\n") || "（无）"}`,
    `## 会议（${f.meetings.length}）\n${f.meetings.map((m) => `- ${localDay(app, m.startedAt)}「${truncate(m.topic || "无标题", 40)}」${m.source ? ` src:${m.source}` : ""}`).join("\n") || "（无）"}`,
    `## 本人让助手做过的事（${f.asks.length}）\n${f.asks.map((a) => `- ${localDay(app, a.at)} ${truncate(a.title.replace(/\s+/g, " "), 60)}（运行 ${a.id}）`).join("\n") || "（无）"}`,
  ].join("\n\n");
}

/** Anything new since the last write-up: otherwise the night's run is skipped. */
export function workFactsChanged(app: App, last: string): boolean {
  const lastMs = Date.parse(last);
  return !!(
    one(app.db, "select 1 from lark_messages where sender_kind = 'owner' and create_ms > ? limit 1", lastMs) ||
    one(app.db, "select 1 from runs where kind in ('ask','code') and created_at > ? limit 1", last) ||
    one(app.db, "select 1 from items where updated_at > ? limit 1", last) ||
    one(app.db, "select 1 from lark_meetings where started_at > ? limit 1", last) ||
    one(app.db, "select 1 from kv where key like 'lark_doc_opened:%' and value > ? limit 1", last)
  );
}

// ------------------------------------------------------------------ people

export type PersonFacts = { id: string; name: string; email: string | null; slug: string; score: number; p2p: number; mentions: number; near: number; last: number; hasCard: boolean; lines: string[] };

/**
 * How much each person deals with the owner in the window: their messages in private chats with the
 * owner (3 each), times they @-ed the owner in a group (3), and their messages within half an hour of
 * the owner's in the same group (1). People only; bots appear on the cards of who runs them.
 */
export function peopleScores(app: App, sinceMs: number) {
  const me = ownerSenderId(app);
  const p2p = all<{ id: string; n: number; last: number }>(
    app.db,
    `select m.sender_id id, count(*) n, max(m.create_ms) last from lark_messages m join lark_cursors c on c.chat_id = m.chat_id
      where c.kind = 'p2p' and m.sender_kind = 'user' and m.sender_id is not null and m.create_ms > ?
        and exists (select 1 from lark_messages o where o.chat_id = m.chat_id and o.sender_kind = 'owner' and o.create_ms > ?)
      group by m.sender_id`,
    sinceMs, sinceMs,
  );
  const mentions = me
    ? all<{ id: string; n: number; last: number }>(app.db, "select sender_id id, count(*) n, max(create_ms) last from lark_messages where sender_kind = 'user' and sender_id is not null and create_ms > ? and mentions like ? group by sender_id", sinceMs, `%${me}%`)
    : [];
  const near = all<{ id: string; n: number; last: number }>(
    app.db,
    `select m.sender_id id, count(*) n, max(m.create_ms) last from lark_messages m left join lark_cursors c on c.chat_id = m.chat_id
      where coalesce(c.kind, '') != 'p2p' and m.sender_kind = 'user' and m.sender_id is not null and m.create_ms > ?
        and exists (select 1 from lark_messages o where o.chat_id = m.chat_id and o.sender_kind = 'owner' and o.create_ms between m.create_ms - 1800000 and m.create_ms + 1800000)
      group by m.sender_id`,
    sinceMs,
  );
  const out = new Map<string, { p2p: number; mentions: number; near: number; last: number }>();
  const add = (rows: { id: string; n: number; last: number }[], k: "p2p" | "mentions" | "near") => {
    for (const r of rows) {
      const p = out.get(r.id) ?? { p2p: 0, mentions: 0, near: 0, last: 0 };
      p[k] = r.n;
      p.last = Math.max(p.last, r.last);
      out.set(r.id, p);
    }
  };
  add(p2p, "p2p");
  add(mentions, "mentions");
  add(near, "near");
  if (me) out.delete(me);
  return [...out.entries()].map(([id, p]) => ({ id, ...p, score: 3 * p.p2p + 3 * p.mentions + p.near })).filter((p) => p.score >= PERSON_MIN_SCORE).sort((a, b) => b.score - a.score);
}

/** kv key: up to which message time a person's card was last brought up to date. */
const seenKey = (id: string) => `work_state_person:${id}`;

/**
 * The people whose cards are due tonight: those the owner deals with who wrote something new since
 * their card was last updated, most involved first, at most `limit`. Each with the lines to read.
 */
export function peopleDue(app: App, opts: { since: string; limit: number }): PersonFacts[] {
  if (opts.limit <= 0) return [];
  const sinceMs = Date.parse(opts.since);
  const me = ownerSenderId(app);
  const out: PersonFacts[] = [];
  for (const s of peopleScores(app, sinceMs)) {
    if (out.length >= opts.limit) break;
    const seen = Number(one<{ value: string }>(app.db, "select value from kv where key = ?", seenKey(s.id))?.value ?? 0);
    if (s.last <= seen) continue;
    const who = one<{ name: string; email: string | null }>(app.db, "select name, email from lark_people where cli_open_id = ?", s.id);
    const name = who?.name || one<{ sender_name: string }>(app.db, "select sender_name from lark_messages where sender_id = ? and sender_name != '' order by create_ms desc limit 1", s.id)?.sender_name || s.id;
    const slug = personSlug(app, { id: s.id, name, email: who?.email });
    // Their messages to or around the owner since the card was last updated (or the window), and the owner's to them in private.
    const from = Math.max(sinceMs, seen);
    const rows = all<{ chat_id: string; sender_kind: string; sender_name: string; content: string; msg_type: string; create_ms: number; source_id: string | null; line: number | null }>(
      app.db,
      `select m.chat_id, m.sender_kind, m.sender_name, m.content, m.msg_type, m.create_ms, m.source_id, m.line from lark_messages m left join lark_cursors c on c.chat_id = m.chat_id
        where m.create_ms > ? and (
          (m.sender_id = ? and (c.kind = 'p2p' or m.mentions like ? or exists (select 1 from lark_messages o where o.chat_id = m.chat_id and o.sender_kind = 'owner' and o.create_ms between m.create_ms - 1800000 and m.create_ms + 1800000)))
          or (m.sender_kind = 'owner' and c.kind = 'p2p' and exists (select 1 from lark_messages x where x.chat_id = m.chat_id and x.sender_id = ?)))
        order by m.create_ms desc limit ?`,
      from, s.id, me ? `%${me}%` : "\u0000", s.id, PERSON_LINES,
    ).reverse();
    out.push({
      id: s.id, name, email: who?.email ?? null, slug, score: s.score, p2p: s.p2p, mentions: s.mentions, near: s.near, last: s.last,
      hasCard: pageExists(app, WORK_STATE_SPACE, slug),
      lines: rows.map((r) => `  - ${localDay(app, r.create_ms)}「${truncate(chatName(app, r.chat_id), 24)}」${r.sender_kind === "owner" ? "本人" : r.sender_name || name}：${truncate(messageText({ content: r.content, msg_type: r.msg_type }).replace(/\s+/g, " "), 160)}${ref(r) ? ` ${ref(r)}` : ""}`),
    });
  }
  return out;
}

export function markPeopleSeen(app: App, people: Pick<PersonFacts, "id" | "last">[]) {
  for (const p of people) run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", seenKey(p.id), String(p.last));
}

// ------------------------------------------------------------------ the nightly run

const lastKey = "work_state_at";

export function workStateTask(app: App, facts: WorkFacts, people: PersonFacts[]): string {
  const page = pageOrNull(app, WORK_STATE_PAGE);
  const mine = page ? sectionOf(page.body, OWNER_SECTION) : null;
  return [
    `# 整理本人的工作近况（${localDay(app, Date.now())}）`,
    "",
    `页面：personal 空间的 ${WORK_STATE_PAGE}（${page ? `已有，上次整理于 ${String(page.meta.updated ?? "")}；先 read_page 读全文，在它的基础上改` : "还没有，这次新建"}）。下面是宿主列出的事实，时间范围从 ${facts.since.slice(0, 10)} 起（${app.config.workState.days} 天）。`,
    mine ? `\n## 本人补充（本人手写，原样保留；里面提到要追踪的对象，按“要追踪的对象”一节查它们的状态）\n\n${truncate(mine.text.replace(/^##[^\n]*\n/, "").trim(), 4000)}` : "",
    "",
    "# 事实",
    "",
    workFactsText(app, facts),
    "",
    people.length
      ? `# 人物卡（今晚轮到 ${people.length} 人：他们有新消息；每晚最多 ${app.config.workState.people} 人）\n\n${people
          .map((p) => `## ${p.name}${p.email ? `（${p.email}）` : ""} → ${p.slug}${p.hasCard ? "（已有，先 read_page 再改）" : "（新建）"}\n私聊 ${p.p2p} 条，@本人 ${p.mentions} 次，在本人说话的群里前后 ${p.near} 条\n${p.lines.join("\n")}`)
          .join("\n\n")}`
      : "",
  ].filter((x) => x !== "").join("\n");
}

registerHandler("work-state", async (ctx) => {
  const app = ctx.app;
  const at = now();
  const last = one<{ value: string }>(app.db, "select value from kv where key = ?", lastKey)?.value ?? null;
  const since = new Date(Date.now() - app.config.workState.days * DAY).toISOString();
  const people = peopleDue(app, { since, limit: app.config.workState.people });
  const fresh = !last || workFactsChanged(app, last) || !pageExists(app, WORK_STATE_SPACE, WORK_STATE_PAGE);
  if (!fresh && !people.length) return { quiet: true, summary: "上次整理以来没有新的工作材料" };
  const facts = workFacts(app, { since });
  const r = await runRole(app, { role: "work-state", spaceId: WORK_STATE_SPACE, spaces: null, task: workStateTask(app, facts, people), runId: ctx.run.id, signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e), userId: OWNER });
  run(app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", lastKey, at);
  markPeopleSeen(app, people);
  return { summary: r.text.trim(), people: people.length };
});
