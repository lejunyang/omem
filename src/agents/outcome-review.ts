import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, localStamp, now, truncate } from "../core/util.ts";
import { ASKER_KINDS, askerOf, exchange, messageKey, reactions, registerPastReplies, replyOutcome, sweepReply, turnSpeaker, unsweepReplies, type OutcomeRow } from "./reply-outcomes.ts";
import { chatName } from "./run-scope.ts";
import { createRun, registerHandler, type RunContext } from "./runs.ts";
import { defineTaskType, resolveTaskType, taskTypesText } from "./task-types.ts";

/**
 * The sweep of answers (docs/v2/reply-sweep.md): every answer a day old is read once more, by the role
 * outcome-reviewer with a stronger model, together with the rest of its conversation. One run reads a
 * stretch of one or a few conversations — the answers in order with what people said between and after
 * them — and hands in, for that stretch: the tasks (one person's requests for one goal), each answer's
 * label and what was missing, each task's outcome, kind and topics, and the data looked up
 * (`review_reply_outcomes`). A conversation's next stretch waits until this one is in, so a task that
 * goes on can be continued. The first pass (reply-outcomes.ts) stays as the provisional label.
 *
 * Besides the answers of the last days, a job (`POST /api/replies/sweep`) sweeps further back, oldest
 * first; answers from before replies were noted are noted first.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** In a busy group, what comes this soon after an answer may be about it even outside its thread. */
const NEARBY_MS = 2 * HOUR;
/** A conversation stretch shows at most this many lines, and lines this long. */
const MAX_LINES = 160;
const JOB_KEY = "reply_sweep_job";
/** Answers the sweep was given twice without a conclusion are closed as they are. */
const MAX_TRIES = 2;
/** At most this many conversations in one run (several short ones share a run). */
const MAX_PLACES = 4;

export type SweepJob = { since: string; until: string | null; limit: number; perDay: number; startedAt: string };
export type BatchPick = { runId: string };
type Pending = { run_id: string; at: string; chat_id: string | null; conversation_id: string | null };
const placeOf = (o: { conversation_id: string | null; chat_id: string | null }) => o.conversation_id ?? o.chat_id ?? "";

export function sweepJob(app: App): SweepJob | null {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", JOB_KEY)?.value;
  return v ? json<SweepJob | null>(v, null) : null;
}
const dayOf = (app: App, at: string | number) => localStamp(at, app.config.timezone).slice(0, 10);
const dayStart = (app: App, at: number) => {
  // Local midnight: step back from `at` by the local clock time.
  const s = localStamp(at, app.config.timezone, { seconds: true });
  const [h, m, sec] = s.slice(11).split(":").map(Number);
  return new Date(at - ((h * 60 + m) * 60 + (sec || 0)) * 1000).toISOString();
};

/** The window the sweep works on now: the regular days, and the job's further back while it lasts. */
function windowOf(app: App, at: number) {
  const cfg = app.config.replies.outcome.review;
  const until = new Date(at - DAY).toISOString();
  const recent = new Date(at - cfg.days * DAY).toISOString();
  const job = sweepJob(app);
  return { until, recent, job, from: job && job.since < recent ? job.since : recent };
}

/** How many answers in the job's range the sweep has done since the job started. */
function jobDone(app: App, job: SweepJob, until: string) {
  return one<{ n: number }>(app.db, "select count(*) n from reply_outcomes where swept_at >= ? and at >= ? and at <= ?", job.startedAt, job.since, job.until && job.until < until ? job.until : until)?.n ?? 0;
}

/** Answers waiting for the sweep, oldest first: a day old at least, not swept, not given up on. */
export function pendingAnswers(app: App, at = Date.now()): Pending[] {
  const w = windowOf(app, at);
  let from = w.from;
  if (w.job && jobDone(app, w.job, w.until) >= w.job.limit) from = w.recent;
  const rows = all<Pending & { sweep_tries: number }>(app.db,
    "select run_id, at, chat_id, conversation_id, sweep_tries from reply_outcomes indexed by reply_outcomes_unswept where swept_at is null and at >= ? and at <= ? order by at",
    from, w.until);
  return rows.filter((r) => r.sweep_tries < MAX_TRIES && (r.at >= w.recent || !w.job?.until || r.at <= w.job.until));
}

/**
 * The next stretch: the conversation with the oldest waiting answer, from that answer on through the same
 * local day (at most `batch`), then other conversations' first stretches while they fit. Every
 * conversation's stretch starts at its own oldest waiting answer, so stretches are read in order.
 */
export function nextBatch(app: App, rows: Pending[], batch: number): Pending[] {
  const byPlace = new Map<string, Pending[]>();
  for (const r of rows) byPlace.set(placeOf(r), [...(byPlace.get(placeOf(r)) ?? []), r]);
  const stretches = [...byPlace.values()].map((rs) => { const day = dayOf(app, rs[0].at); return rs.filter((r) => dayOf(app, r.at) === day).slice(0, batch); })
    .sort((a, b) => a[0].at.localeCompare(b[0].at));
  const out: Pending[] = [];
  let places = 0;
  for (const s of stretches) {
    if (out.length && (out.length + s.length > batch || places >= MAX_PLACES)) continue;
    out.push(...s);
    places++;
    if (out.length >= batch) break;
  }
  return out;
}

/**
 * Queue the next stretch when nothing of the sweep is waiting or running and the day's share is not used
 * up. Called on the patrol's tick and by the nightly schedule; one run at a time.
 */
export function scheduleOutcomeReview(app: App, at = Date.now()) {
  const cfg = app.config.replies.outcome;
  if (!cfg.enabled || !cfg.review.enabled) return [];
  if (one(app.db, "select 1 from runs where kind = 'outcome-review' and status in ('queued','running') limit 1")) return [];
  const w = windowOf(app, at);
  if (w.job && (jobDone(app, w.job, w.until) >= w.job.limit || !one(app.db, "select 1 from reply_outcomes indexed by reply_outcomes_unswept where swept_at is null and sweep_tries < ? and at >= ? and at <= ? limit 1", MAX_TRIES, w.job.since, w.job.until && w.job.until < w.until ? w.job.until : w.until))) {
    run(app.db, "delete from kv where key = ?", JOB_KEY);
  }
  const job = sweepJob(app);
  const today = one<{ n: number }>(app.db, "select count(*) n from reply_outcomes where swept_at >= ?", dayStart(app, at))?.n ?? 0;
  if (today >= Math.max(cfg.review.max, job?.perDay ?? 0)) return [];
  const picks = nextBatch(app, pendingAnswers(app, at), cfg.review.batch);
  if (!picks.length) return [];
  const places = new Set(picks.map(placeOf)).size;
  return [createRun(app, { kind: "outcome-review", spaceId: "personal", userId: OWNER, title: `回扫回答（${places} 个会话，${picks.length} 次回答）`, input: { picks: picks.map((p): BatchPick => ({ runId: p.run_id })) } })];
}

/** The answers a sweep run was given (its input). */
export function batchOf(input: Record<string, unknown> | string | null | undefined): BatchPick[] {
  const v = typeof input === "string" ? json<Record<string, unknown>>(input, {}) : input ?? {};
  return Array.isArray(v.picks) ? (v.picks as BatchPick[]).filter((p) => p && typeof p.runId === "string") : [];
}

/** Start sweeping further back (the owner's call): note older answers first, optionally read a range again. */
export function startSweepJob(app: App, o: { since: string; until?: string | null; limit?: number; perDay?: number; reset?: boolean }) {
  if (Number.isNaN(Date.parse(o.since))) throw new HttpError(400, "since 要是一个时间");
  const since = new Date(o.since).toISOString();
  const until = o.until ? new Date(o.until).toISOString() : null;
  const registered = registerPastReplies(app, since);
  let reset = 0;
  if (o.reset) {
    const ids = all<{ run_id: string }>(app.db, "select run_id from reply_outcomes where at >= ? and at <= ? and (swept_at is not null or sweep_tries > 0)", since, until ?? now()).map((r) => r.run_id);
    reset = unsweepReplies(app, ids);
  }
  const job: SweepJob = { since, until, limit: o.limit ?? 1_000_000, perDay: o.perDay ?? 600, startedAt: now() };
  run(app.db, "insert or replace into kv(key, value) values(?, ?)", JOB_KEY, JSON.stringify(job));
  const queued = scheduleOutcomeReview(app).map((r) => r.id);
  return { ...sweepStatus(app), registered, reset, queued };
}

export function stopSweepJob(app: App) {
  run(app.db, "delete from kv where key = ?", JOB_KEY);
  return sweepStatus(app);
}

export function sweepStatus(app: App, at = Date.now()) {
  const w = windowOf(app, at);
  const pending = pendingAnswers(app, at).length;
  const today = one<{ n: number }>(app.db, "select count(*) n from reply_outcomes where swept_at >= ?", dayStart(app, at))?.n ?? 0;
  const runs = all<{ id: string; status: string; title: string; created_at: string }>(app.db, "select id, status, title, created_at from runs where kind = 'outcome-review' order by created_at desc limit 10");
  return { job: w.job, jobDone: w.job ? jobDone(app, w.job, w.until) : 0, pending, sweptToday: today, runs };
}

type Line = { at: string; text: string };

/** The question a run answered and who asked: the asker of its trigger, else the last person who spoke before it. */
function askedBy(app: App, runId: string) {
  const r = one<{ trigger_by: string | null; created_at: string }>(app.db, "select trigger_by, created_at from runs where id = ?", runId);
  return { asker: askerOf(app, r?.trigger_by), created: r?.created_at ?? "" };
}

/** One conversation's stretch for the sweep: earlier tasks there, then the answers and what was said around them, in time order. */
function stretchText(app: App, rows: OutcomeRow[], n: number, at: number): string {
  const tz = app.config.timezone;
  const stamp = (iso: string) => localStamp(iso, tz, { short: true });
  const first = rows[0], last = rows[rows.length - 1];
  const place = placeOf(first);
  const chat = rows.find((r) => r.chat_id)?.chat_id ?? null;
  const conv = first.conversation_id;
  const ids = new Set(rows.map((r) => r.run_id));
  const askers = new Map(rows.map((r) => [r.run_id, askedBy(app, r.run_id)]));
  const start = Math.min(...rows.map((r) => Date.parse(askers.get(r.run_id)!.created || r.at))) - 30 * 60_000;
  const later = one<{ at: string }>(app.db, "select at from reply_outcomes where (conversation_id = ? or (? is null and chat_id = ?)) and at > ? order by at limit 1", conv, conv, chat, last.at)?.at;
  const end = Math.min(Date.parse(last.at) + DAY, at, later ? Date.parse(later) - 1 : Infinity);
  const lines: Line[] = [];
  const seen = new Set<string>();
  const add = (iso: string, text: string, body: string, max: number) => {
    const t = body.replace(/\s+/g, " ").trim();
    const key = messageKey(t);
    if (!t || seen.has(key)) return;
    seen.add(key);
    lines.push({ at: iso, text: `- [${stamp(iso)}] ${text}${truncate(t, max)}` });
  };
  // The answers first, so their copies in the chat are known when the chat is read.
  for (const o of rows) {
    const { answer } = exchange(app, o);
    const who = askers.get(o.run_id)!.asker;
    const emoji = reactions(app, o.run_id).lines.map((l) => `${l.who}${l.text}`);
    add(o.at, `**回答 ${o.run_id}**（答${who.name}${who.kind === "owner" ? "" : `，${ASKER_KINDS[who.kind]}`}${emoji.length ? `；表情：${emoji.join("，")}` : ""}）：`, answer || "（没有记录到回答）", 1500);
  }
  if (conv) {
    for (const m of all<{ role: string; text: string; meta: string; created_at: string; run_id: string | null }>(app.db,
      "select role, text, meta, created_at, run_id from messages where conversation_id = ? and created_at > ? and created_at <= ? and json_extract(meta, '$.command') is null order by created_at limit 400",
      conv, new Date(start).toISOString(), new Date(end).toISOString())) {
      const meta = json<{ speaker?: unknown; userId?: unknown; wake?: unknown }>(m.meta, {});
      if (meta.wake) continue;
      if (m.role === "assistant") { if (!m.run_id || !ids.has(m.run_id)) add(m.created_at, "助手（这一段不判的消息）：", m.text, 240); continue; }
      if (m.role === "user") add(m.created_at, `${turnSpeaker(app, meta).name}：`, m.text, 500);
    }
  }
  if (chat) {
    const answersAt = rows.map((r) => Date.parse(r.at));
    const sent = new Set(rows.map((r) => r.message_id).filter(Boolean));
    const threads = new Set(all<{ thread_id: string | null }>(app.db, "select thread_id from lark_messages where message_id in (select value from json_each(?))", JSON.stringify([...sent])).map((r) => r.thread_id).filter(Boolean));
    const askerIds = new Set<string>();
    for (const r of rows) {
      const q = one<{ sender_id: string | null; thread_id: string | null }>(app.db, "select sender_id, thread_id from lark_messages where chat_id = ? and create_ms <= ? and sender_kind in ('user','owner') order by create_ms desc limit 1", chat, Date.parse(askers.get(r.run_id)!.created || r.at));
      if (q?.sender_id) askerIds.add(q.sender_id);
      if (q?.thread_id) threads.add(q.thread_id);
    }
    for (const m of all<{ thread_id: string | null; parent_id: string | null; sender_id: string | null; sender_name: string; sender_kind: string; content: string; create_ms: number }>(app.db,
      `select thread_id, parent_id, sender_id, sender_name, sender_kind, content, create_ms from lark_messages
       where chat_id = ? and create_ms > ? and create_ms <= ? and sender_kind in ('user','owner','app') and msg_type in ('text','post') and trim(content) != ''
       order by create_ms limit 600`, chat, start, end)) {
      const close = (!!m.parent_id && sent.has(m.parent_id)) || (!!m.thread_id && threads.has(m.thread_id));
      const near = answersAt.some((t) => m.create_ms > t && m.create_ms - t <= NEARBY_MS);
      const owner = m.sender_kind === "owner";
      const asker = !!m.sender_id && askerIds.has(m.sender_id);
      if (m.sender_kind === "app" ? !close && !near : !close && !near && !owner && !asker) continue;
      const who = owner ? "本人" : m.sender_kind === "app" ? `机器人 ${m.sender_name}`.trim() : m.sender_name || "群里的人";
      add(new Date(m.create_ms).toISOString(), `${who}${close ? "（同一话题）" : ""}：`, m.content, m.sender_kind === "app" ? 240 : 500);
    }
    // The owner's own replies to someone who came to them (有人找你) in this chat.
    for (const r of all<{ owner_reply: string; owner_reply_at: string }>(app.db,
      "select owner_reply, owner_reply_at from reply_samples indexed by reply_samples_chat where chat_id = ? and created_at >= ? and created_at <= ? and owner_reply is not null and owner_reply_at > ? and owner_reply_at <= ? limit 5",
      chat, new Date(start).toISOString(), new Date(end).toISOString(), first.at, new Date(end).toISOString()))
      add(r.owner_reply_at, "本人自己回了有人找他的消息：", r.owner_reply, 300);
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  const shown = lines.length > MAX_LINES ? [...lines.filter((l) => l.text.includes("**回答 ")), ...lines.filter((l) => !l.text.includes("**回答 ")).slice(0, MAX_LINES - rows.length)].sort((a, b) => a.at.localeCompare(b.at)) : lines;
  const where = chat ? `飞书群「${truncate(chatName(app, chat), 40)}」` : `会话「${truncate(one<{ title: string }>(app.db, "select title from conversations where id = ?", conv)?.title ?? conv ?? "", 40)}」`;
  const earlier = all<{ id: string; title: string; last_at: string; outcome: string; note: string; type_id: string | null }>(app.db,
    "select id, title, last_at, outcome, note, type_id from reply_tasks indexed by reply_tasks_place where place = ? and last_at < ? and last_at >= ? order by last_at desc limit 3",
    place, first.at, new Date(Date.parse(first.at) - 3 * DAY).toISOString());
  const typeName = (id: string | null) => (id ? one<{ name: string }>(app.db, "select name from task_types where id = ?", id)?.name : null);
  return [
    `## 会话 ${n}：${where}`,
    `这一段要判的回答（${rows.length} 次）：${rows.map((r) => r.run_id).join("、")}。${later ? "这个会话之后还有回答，留给下一段；这一段只看到下一次回答之前。" : ""}`,
    ...(earlier.length ? ["", "这里之前的件（接着做同一件事的，交的时候写它的 id）：", ...earlier.reverse().map((t) => `- 件 ${t.id}「${t.title}」${typeName(t.type_id) ? `（${typeName(t.type_id)}）` : ""}：最后一次回答 ${stamp(t.last_at)}，${TASK_OUTCOMES[t.outcome] ?? t.outcome}${t.note ? `，${t.note}` : ""}`)] : []),
    "",
    ...shown.map((l) => l.text),
  ].join("\n");
}

export const TASK_OUTCOMES: Record<string, string> = { done: "做完了", unfinished: "没做完", handed_over: "转给别人了", unclear: "看不出" };

const range = (o: { from?: string; to?: string }) => [o.from ? new Date(o.from).toISOString() : "", o.to ? new Date(o.to).toISOString() : "9999"];

/** Tasks the sweep made in a period (by when they started), newest first, each with its answers as labelled now. */
export function listReplyTasks(app: App, o: { from?: string; to?: string; limit: number }) {
  const [from, to] = range(o);
  return all<{ id: string; place: string; asker_name: string; asker_kind: string; first_at: string; last_at: string; title: string; type_id: string | null; topics: string; outcome: string; note: string; rounds: number; supplements: number; corrections: number; by: string | null }>(app.db,
    "select * from reply_tasks indexed by reply_tasks_first where first_at >= ? and first_at < ? order by first_at desc limit ?", from, to, o.limit).map((t) => {
    const type = t.type_id ? one<{ name: string; parent_id: string | null }>(app.db, "select name, parent_id from task_types where id = ?", t.type_id) : null;
    const parent = type?.parent_id ? one<{ name: string }>(app.db, "select name from task_types where id = ?", type.parent_id)?.name : null;
    return {
      ...t, topics: json<string[]>(t.topics, []), type: type ? (parent ? `${parent} › ${type.name}` : type.name) : null,
      answers: all<{ run_id: string }>(app.db, "select run_id from reply_outcomes indexed by reply_outcomes_task where task_id = ? order by at", t.id).map((r) => {
        const v = replyOutcome(app, r.run_id)!;
        return { runId: r.run_id, at: v.at, label: v.label, first: v.first?.label ?? null, why: v.checked?.why ?? v.revised?.why ?? "", missing: v.missing };
      }),
    };
  });
}

export function listDataQueries(app: App, o: { from?: string; to?: string; limit: number }) {
  const [from, to] = range(o);
  return all<{ id: string; task_id: string | null; run_id: string; space_id: string | null; asker_name: string; question: string; definition: string; sources: string; result: string; at: string }>(app.db,
    "select * from data_queries indexed by data_queries_at where at >= ? and at < ? order by at desc limit ?", from, to, o.limit).map((d) => ({ ...d, sources: json<string[]>(d.sources, []) }));
}

export function reviewTask(app: App, picks: BatchPick[], at = Date.now()): string {
  const rows = picks.map((p) => one<OutcomeRow>(app.db, "select * from reply_outcomes where run_id = ?", p.runId)).filter((o): o is OutcomeRow => !!o).sort((a, b) => a.at.localeCompare(b.at));
  const byPlace = new Map<string, OutcomeRow[]>();
  for (const o of rows) byPlace.set(placeOf(o), [...(byPlace.get(placeOf(o)) ?? []), o]);
  const spaces = [...new Set(rows.map((o) => one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", o.run_id)?.space_id).filter((s): s is string => !!s))];
  const blocks = [...byPlace.values()].map((rs, i) => stretchText(app, rs, i + 1, at));
  return [
    `下面是 ${byPlace.size} 个会话里的一段对话，标着“回答 r…”的 ${rows.length} 次回答要你判。按你的说明：先把这些回答分成件，再判每次回答的结果、每件的结论、类型和主题，记下查数记录，用 review_reply_outcomes 交；可以分几次交，每次回答都要交到。`,
    "",
    "## 现在的任务类型",
    taskTypesText(app, spaces),
    "",
    ...blocks.flatMap((b) => [b, ""]),
  ].join("\n").trim();
}

export type SubmittedTask = {
  task?: string; title: string; type: string; new_type?: { parent?: string; description: string }; topics?: string[];
  outcome: "done" | "unfinished" | "handed_over" | "unclear"; note?: string;
  answers: { run_id: string; label: string; why: string; missing?: string }[];
  queries?: { run_id: string; question: string; definition?: string; sources?: string[]; result?: string }[];
};
/** New kinds one run may define: a stretch that wants more is splitting hairs. */
const NEW_TYPES_PER_RUN = 3;

/**
 * What a sweep run hands in for its stretch (`review_reply_outcomes`): each task with its answers. A task
 * stays in one conversation; an answer belongs to one task; a kind is one in the list, or a new one the
 * run defines (at most a few). Tasks that do not hold together are sent back with the reason; the rest is
 * kept, and the answers still missing are named.
 */
export function submitTasks(app: App, sweepRunId: string, by: string, tasks: SubmittedTask[]): string {
  const me = one<{ kind: string; input: string }>(app.db, "select kind, input from runs where id = ?", sweepRunId);
  if (me?.kind !== "outcome-review") throw new HttpError(400, "review_reply_outcomes 只在回扫回答的运行里用");
  const picks = new Set(batchOf(me.input).map((p) => p.runId));
  const used = new Set<string>();
  const out: string[] = [];
  for (const t of tasks) {
    const label = `「${truncate(t.title, 40)}」`;
    const rows = t.answers.map((a) => one<OutcomeRow & { swept_at: string | null }>(app.db, "select * from reply_outcomes where run_id = ?", a.run_id));
    if (new Set(t.answers.map((a) => a.run_id)).size !== t.answers.length) { out.push(`${label} 没收：同一次回答在这件里写了两遍`); continue; }
    const badAt = t.answers.findIndex((a, i) => !picks.has(a.run_id) || !rows[i] || used.has(a.run_id));
    if (badAt >= 0) { const a = t.answers[badAt]; out.push(`${label} 没收：${a.run_id} ${used.has(a.run_id) ? "在这次交的别的件里已经出现过" : "不在这一段要判的回答里"}`); continue; }
    const swept = t.answers.find((_, i) => rows[i]!.swept_at);
    if (swept) { out.push(`${label} 没收：${swept.run_id} 已经交过了`); continue; }
    const places = new Set(rows.map((o) => placeOf(o!)));
    if (places.size > 1) { out.push(`${label} 没收：一件事只在一个会话里，这几次回答在不同的会话`); continue; }
    const place = [...places][0];
    let typeId: string | null = null;
    const known = resolveTaskType(app, t.type);
    if (known?.status === "active") typeId = known.id;
    else if (t.new_type) {
      const made = one<{ n: number }>(app.db, "select count(*) n from task_types where defined_run = ?", sweepRunId)?.n ?? 0;
      if (made >= NEW_TYPES_PER_RUN) { out.push(`${label} 没收：这一段已经新建了 ${made} 个类型，用现有的`); continue; }
      try { typeId = defineTaskType(app, { name: t.type, parent: t.new_type.parent, description: t.new_type.description, by: "agent", run: sweepRunId }).id; }
      catch (e) { out.push(`${label} 没收：${(e as Error).message}`); continue; }
    } else { out.push(`${label} 没收：没有类型「${t.type}」：用现有的，或给 new_type 新建`); continue; }
    let id = t.task?.trim() || "";
    if (id) {
      const cur = one<{ place: string }>(app.db, "select place from reply_tasks where id = ?", id);
      if (!cur || cur.place !== place) { out.push(`${label} 没收：没有件 ${id}，或它不在这个会话里`); continue; }
    }
    for (const a of t.answers) used.add(a.run_id);
    const at = now();
    const ordered = [...rows].sort((a, b) => a!.at.localeCompare(b!.at));
    const firstRun = ordered[0]!;
    if (!id) {
      id = `rt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const asker = askedBy(app, firstRun.run_id).asker;
      run(app.db, `insert into reply_tasks(id, place, chat_id, conversation_id, asker, asker_name, asker_kind, first_at, last_at, title, type_id, topics, outcome, note, "by", run_id, created_at, updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, place, firstRun.chat_id, firstRun.conversation_id, asker.key, asker.name, asker.kind,
        firstRun.at, ordered[ordered.length - 1]!.at, truncate(t.title.trim(), 120), typeId, JSON.stringify((t.topics ?? []).slice(0, 5)), t.outcome, truncate(t.note?.trim() ?? "", 200), by, sweepRunId, at, at);
    } else {
      run(app.db, "update reply_tasks set title = ?, type_id = ?, topics = ?, outcome = ?, note = ?, last_at = max(last_at, ?), \"by\" = ?, run_id = ?, updated_at = ? where id = ?",
        truncate(t.title.trim(), 120), typeId, JSON.stringify((t.topics ?? []).slice(0, 5)), t.outcome, truncate(t.note?.trim() ?? "", 200), ordered[ordered.length - 1]!.at, by, sweepRunId, at, id);
    }
    for (const a of t.answers) sweepReply(app, a.run_id, { label: a.label, by, why: a.why, missing: a.missing, taskId: id });
    recountTask(app, id);
    let q = 0;
    for (const d of t.queries ?? []) {
      if (!t.answers.some((a) => a.run_id === d.run_id)) continue;
      const asker = askedBy(app, d.run_id).asker;
      const space = one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", d.run_id)?.space_id ?? null;
      const when = rows.find((o) => o!.run_id === d.run_id)!.at;
      run(app.db, "insert into data_queries(id, task_id, run_id, space_id, asker, asker_name, question, definition, sources, result, at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
        `dq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, id, d.run_id, space, asker.key, asker.name, truncate(d.question.trim(), 200),
        truncate(d.definition?.trim() ?? "", 400), JSON.stringify((d.sources ?? []).slice(0, 8).map((s) => truncate(s, 200))), truncate(d.result?.trim() ?? "", 400), when, at);
      q++;
    }
    out.push(`件 ${id}${label}：${t.answers.length} 次回答${q ? `，${q} 条查数记录` : ""}`);
  }
  const missing = [...picks].filter((id) => !!one(app.db, "select 1 from reply_outcomes where run_id = ? and swept_at is null", id));
  if (missing.length) out.push(`还没交的回答：${missing.join("、")}`);
  else out.push("这一段的回答都交齐了");
  return out.join("\n");
}

/** A task's rounds and how many of its answers were to add to or correct, from the labels in force. */
function recountTask(app: App, id: string) {
  const labels = all<{ run_id: string }>(app.db, "select run_id from reply_outcomes indexed by reply_outcomes_task where task_id = ?", id).map((r) => replyOutcome(app, r.run_id)?.label);
  const span = one<{ first: string; last: string }>(app.db, "select min(at) first, max(at) last from reply_outcomes indexed by reply_outcomes_task where task_id = ?", id);
  run(app.db, "update reply_tasks set rounds = ?, supplements = ?, corrections = ?, first_at = coalesce(?, first_at), last_at = coalesce(?, last_at) where id = ?",
    labels.length, labels.filter((l) => l === "supplement" || l === "followup").length, labels.filter((l) => l === "corrected").length, span?.first ?? null, span?.last ?? null, id);
}

registerHandler("outcome-review", async (ctx: RunContext) => {
  const app = ctx.app;
  const live = batchOf(ctx.run.input).filter((p) => !!one(app.db, "select 1 from reply_outcomes where run_id = ? and swept_at is null", p.runId));
  if (!live.length) return { quiet: true, summary: "这一段的回答都已经回扫过了" };
  const spaces = [...new Set(["personal", ...live.map((p) => one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", p.runId)?.space_id).filter((s): s is string => !!s)])];
  const { runRole } = await import("./runner.ts");
  const r = await runRole(app, { role: "outcome-reviewer", spaceId: "personal", spaces, ownAI: true, task: reviewTask(app, live), runId: ctx.run.id, userId: OWNER, signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e) });
  run(app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  const left = live.filter((p) => !!one(app.db, "select 1 from reply_outcomes where run_id = ? and swept_at is null", p.runId)).map((p) => p.runId);
  // Not handed in: tried again in a later stretch; after that, left with the first pass's label.
  run(app.db, "update reply_outcomes set sweep_tries = sweep_tries + 1 where run_id in (select value from json_each(?))", JSON.stringify(left));
  run(app.db, "update reply_outcomes set swept_at = ? where run_id in (select value from json_each(?)) and sweep_tries >= ?", now(), JSON.stringify(left), MAX_TRIES);
  const tasks = one<{ n: number }>(app.db, "select count(distinct task_id) n from reply_outcomes where run_id in (select value from json_each(?)) and task_id is not null", JSON.stringify(live.map((p) => p.runId)))?.n ?? 0;
  const done = live.length - left.length;
  return {
    quiet: true, swept: done, tasks, left: left.length,
    summary: [`回扫了 ${done} 次回答，分成 ${tasks} 件${left.length ? `；${left.length} 次没交结论${left.some((id) => (one<{ sweep_tries: number }>(app.db, "select sweep_tries from reply_outcomes where run_id = ?", id)?.sweep_tries ?? 0) >= MAX_TRIES) ? "，其中交了两回都没交的按第一遍留着" : "，下一段再看"}` : ""}。`, truncate(r.text.trim(), 1500)].filter(Boolean).join("\n"),
  };
});
