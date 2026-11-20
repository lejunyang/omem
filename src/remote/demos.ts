import { ask } from "../agents/jobs.ts";
import { addMessage, createThread, findThread, getThread, updateThread, type Thread, type ThreadSettings } from "../agents/threads.ts";
import { demoLessonsDir } from "../channels/listen-cases.ts";
import { getContext, requireContext } from "../channels/listen.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, localStamp, now, truncate } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { fromExtension, getRecording, kindLabel, updateRecording, type Recording } from "./recordings.ts";

/**
 * A demonstration (演示, docs/v2/remote.md「演示」): the owner shows how they handle a piece of work
 * instead of explaining it. It is one conversation (channel `demo`) with a goal and maybe a 关注 or an
 * item, active from start to stop. Meanwhile what the owner does lands in it in time order, as
 * messages without a turn: recordings from their Chrome (import with `demoId`), picks (clips with
 * `turn: false`), and on stop their own Feishu messages in the 关注's groups and the 远程 recordings
 * that finished in the window. Stopping can hand the timeline to the assistant, which follows the
 * built-in skill skill-from-demo: a skill (a fixed procedure) or lessons for the 关注 or the item.
 *
 * One demonstration at a time, the owner's only. The demonstration's id is its conversation's id.
 */

export const DEMO_CHANNEL = "demo";
export type DemoOrganize = "skill" | "lessons" | "none";
export type DemoSettings = NonNullable<ThreadSettings["demo"]>;
/** What an entry of the timeline is (messages.meta.demo.kind). */
export type DemoEntryKind = "start" | "recording" | "pick" | "lark" | "remote" | "stop" | "organize";
const TIMELINE: DemoEntryKind[] = ["recording", "pick", "lark", "remote"];

export type DemoView = {
  id: string;
  conversationId: string;
  goal: string;
  spaceId: string;
  context: { id: string; name: string } | null;
  item: { id: string; title: string } | null;
  status: "active" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  organize: DemoOrganize | null;
  /** Where lessons for the 关注 go (skill-from-demo), when it has one. */
  lessonsPath: string | null;
  entries: Record<"recording" | "pick" | "lark" | "remote", number>;
};

const ownerOnly = (userId: string) => {
  if (userId !== OWNER) throw new HttpError(403, "只有本人可以演示");
};

/** The file name a goal becomes (the same characters playbookPath leaves out). */
export const goalFile = (goal: string) => goal.replace(/[\\/:*?"<>|#\s]+/g, " ").trim().slice(0, 40) || "演示";

function lessonsPathOf(app: App, s: DemoSettings) {
  const c = s.contextId ? getContext(app, s.contextId) : null;
  return c ? `${demoLessonsDir(c)}/${goalFile(s.goal)}.md` : null;
}

function counts(app: App, conversationId: string) {
  const out = { recording: 0, pick: 0, lark: 0, remote: 0 };
  for (const r of all<{ k: string | null; n: number }>(app.db, "select json_extract(meta, '$.demo.kind') k, count(*) n from messages where conversation_id = ? group by k", conversationId)) {
    if (r.k && r.k in out) out[r.k as keyof typeof out] = r.n;
  }
  return out;
}

function view(app: App, t: Thread): DemoView {
  const s = t.settings.demo!;
  const c = s.contextId ? getContext(app, s.contextId) : null;
  let item: DemoView["item"] = null;
  if (s.itemId) {
    try {
      const i = getItem(app, s.itemId);
      item = { id: i.id, title: i.title };
    } catch {
      item = { id: s.itemId, title: s.itemId };
    }
  }
  return {
    id: t.id,
    conversationId: t.id,
    goal: s.goal,
    spaceId: t.spaceId,
    context: c ? { id: c.id, name: c.name } : s.contextId ? { id: s.contextId, name: s.contextId } : null,
    item,
    status: s.stoppedAt ? "stopped" : "active",
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt ?? null,
    organize: s.organize ?? null,
    lessonsPath: lessonsPathOf(app, s),
    entries: counts(app, t.id),
  };
}

function demoThread(app: App, id: string, userId: string): Thread {
  ownerOnly(userId);
  const t = findThread(app, id);
  if (!t || t.channel !== DEMO_CHANNEL || !t.settings.demo || t.userId !== userId) throw new HttpError(404, `没有这次演示：${id}`);
  return t;
}

const activeRow = (app: App, userId: string) =>
  one<{ id: string }>(app.db, "select id from conversations where channel = ? and user_id = ? and json_extract(settings, '$.demo.stoppedAt') is null and json_extract(settings, '$.demo.startedAt') is not null order by created_at desc limit 1", DEMO_CHANNEL, userId);

/** The demonstration going on now, or null. */
export function currentDemo(app: App, userId = OWNER): DemoView | null {
  if (userId !== OWNER) return null;
  const r = activeRow(app, userId);
  return r ? view(app, getThread(app, r.id)) : null;
}

export function getDemo(app: App, id: string, userId = OWNER): DemoView {
  return view(app, demoThread(app, id, userId));
}

/** The current one and the last few. */
export function listDemos(app: App, userId: string, limit = 10) {
  ownerOnly(userId);
  const rows = all<{ id: string }>(app.db, "select id from conversations where channel = ? and user_id = ? order by created_at desc limit ?", DEMO_CHANNEL, userId, limit);
  const demos = rows.map((r) => getThread(app, r.id)).filter((t) => t.settings.demo?.startedAt).map((t) => view(app, t));
  return { current: demos.find((d) => d.status === "active") ?? currentDemo(app, userId), recent: demos };
}

/**
 * One entry of the timeline: a message of the owner's, no turn, dated when it happened (the timeline
 * reads in that order, also for what is gathered only at the stop).
 */
function addEntry(app: App, t: Thread, kind: DemoEntryKind, text: string, extra: Record<string, unknown> = {}, at?: number | string | null) {
  const id = addMessage(app, t.id, "user", text, null, { demo: { kind, ...extra } });
  const start = Date.parse(t.settings.demo?.startedAt ?? "");
  // Not before the start (a recording begun just before it), not in the future.
  const when = at == null ? NaN : Math.max(new Date(at).getTime(), Number.isNaN(start) ? -Infinity : start);
  if (!Number.isNaN(when) && when <= Date.now()) run(app.db, "update messages set created_at = ? where id = ?", new Date(when).toISOString(), id);
  return id;
}

export function startDemo(app: App, userId: string, input: { goal: string; contextId?: string | null; itemId?: string | null }): DemoView {
  ownerOnly(userId);
  const goal = input.goal.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!goal) throw new HttpError(400, "说一句要演示什么（例如：值班群里有人报退款失败时怎么查）");
  const going = currentDemo(app, userId);
  if (going) throw new HttpError(409, `已经在演示「${going.goal}」，先结束它（/演示结束，或在扩展、关注页上点结束）`);
  const c = input.contextId ? requireContext(app, input.contextId) : null;
  const item = input.itemId ? getItem(app, input.itemId) : null;
  const spaceId = c?.spaceId ?? item?.spaceId ?? "personal";
  const demo: DemoSettings = { goal, contextId: c?.id ?? null, itemId: item?.id ?? null, startedAt: now(), stoppedAt: null, organize: null };
  const t = createThread(app, { spaceId, channel: DEMO_CHANNEL, title: truncate(`演示：${goal}`, 60), settings: { demo }, userId });
  const about = [c ? `关注「${c.name}」` : "", item ? `事项「${item.title}」` : ""].filter(Boolean).join("、");
  addEntry(app, t, "start", [
    `开始演示：${goal}。${about ? `（这次是${about}里的事。）` : ""}`,
    "接下来我在浏览器里做一遍、指给你看（录制、拾取），飞书里我发的消息也算。演示期间先不用回，结束后我再让你整理。",
  ].join("\n"), {}, demo.startedAt);
  return view(app, getThread(app, t.id));
}

// ------------------------------------------------------------------------------------- the timeline

/** A recording made during the demonstration (the extension's import with `demoId`, or one found at the stop). */
export function attachRecording(app: App, demoId: string, r: Recording, at?: number | string | null, userId = OWNER) {
  const t = demoThread(app, demoId, userId);
  const s = r.summary;
  const ext = fromExtension(r);
  const where = ext ? `我自己的 Chrome 里${r.target ? `，从 ${r.target} 开始` : ""}` : `远程页面的${kindLabel(r)}${r.target ? `（${r.target}）` : ""}`;
  const text = r.status === "failed"
    ? `录制 ${r.id}（${where}）没有完成：${String(s.error ?? "原因不明")}。`
    : `录制 ${r.id}（${where}）：${r.goal || "（没写要做的事）"}。${s.actions ?? 0} 个动作${s.marks ? `、${s.marks} 处我加的标记` : ""}${s.requests ? `，记下 ${s.requests} 个请求` : ""}。用 read_recording 看。`;
  updateRecording(app, r.id, { conversationId: t.id });
  return addEntry(app, t, ext ? "recording" : "remote", text, { recordingId: r.id, line: `录制 ${r.id}（${ext ? "Chrome 扩展" : `远程 · ${kindLabel(r)}`}）：${truncate(r.goal || "没写要做的事", 40)}` }, at ?? r.createdAt);
}

/** Where a clip without a turn may go: one of the sender's own conversations. */
export function noteTarget(app: App, userId: string, conversationId: string | undefined) {
  if (!conversationId) throw new HttpError(400, "只记进对话（turn: false）时要给 conversationId");
  const t = findThread(app, conversationId);
  if (!t || t.userId !== userId) throw new HttpError(404, `没有这个对话：${conversationId}`);
  return t;
}

/**
 * A clip kept in a conversation without a turn (POST /api/clips with `turn: false`): in a
 * demonstration it is a pick on the timeline; elsewhere a note the owner adds for later.
 */
export function notePick(app: App, userId: string, conversationId: string, clip: { title: string; text: string; pageUrl: string }) {
  const t = noteTarget(app, userId, conversationId);
  const title = clip.title.trim() || clip.text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "网页拾取";
  const text = `我指给你看（拾取${clip.pageUrl ? `，${clip.pageUrl}` : ""}）：\n\n${clip.text}`;
  if (t.channel === DEMO_CHANNEL && t.settings.demo) return addEntry(app, t, "pick", text, { title, ...(clip.pageUrl ? { pageUrl: clip.pageUrl } : {}), line: `拾取：${truncate(title, 50)}` });
  return addMessage(app, t.id, "user", text, null, { clip: { title, pageUrl: clip.pageUrl } });
}

type LarkRow = { message_id: string; chat_id: string; thread_id: string | null; content: string; create_ms: number };

/** Every chat with captured messages, by jumping along the (chat_id, create_ms) index. */
function capturedChats(app: App): string[] {
  return all<{ id: string }>(
    app.db,
    `with recursive c(id) as (select min(chat_id) from lark_messages union all select (select min(chat_id) from lark_messages where chat_id > c.id) from c where c.id is not null)
     select id from c where id is not null`,
  ).map((r) => r.id);
}

/** The owner's own Feishu messages in the window: in the 关注's groups, or in every captured chat. */
function ownerLarkMessages(app: App, chats: string[] | null, fromMs: number, toMs: number, limit = 300): LarkRow[] {
  const ids = chats?.length ? chats : capturedChats(app);
  const out: LarkRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    out.push(...all<LarkRow>(
      app.db,
      `select message_id, chat_id, thread_id, content, create_ms from lark_messages
        where chat_id in (${part.map(() => "?").join(",")}) and create_ms >= ? and create_ms <= ? and sender_kind = 'owner'
        order by create_ms limit ?`,
      ...part, fromMs, toMs, limit,
    ));
  }
  // The commands that started and stopped it are not part of what was shown.
  return out.filter((m) => !/^\s*\/演示/.test(m.content)).sort((a, b) => a.create_ms - b.create_ms).slice(0, limit);
}

/** Which chats a demonstration reads the owner's Feishu messages from (null: all of them). */
async function demoChats(app: App, s: DemoSettings): Promise<string[] | null> {
  const c = s.contextId ? getContext(app, s.contextId) : null;
  if (c?.chats.length) return c.chats;
  if (s.itemId) {
    const { itemContext } = await import("../channels/listen.ts");
    const ic = itemContext(app, s.itemId);
    if (ic?.chats.length) return ic.chats;
  }
  return null;
}

/** The owner's Feishu messages, a run of them in one chat (gaps under ten minutes) as one entry. */
async function collectLark(app: App, t: Thread, s: DemoSettings, toMs: number) {
  const rows = ownerLarkMessages(app, await demoChats(app, s), Date.parse(s.startedAt), toMs);
  if (!rows.length) return 0;
  const { groupName } = await import("../channels/lark-watch.ts");
  const names = new Map<string, string>();
  const nameOf = (id: string) => names.get(id) ?? (names.set(id, groupName(app, id)), names.get(id)!);
  const tz = app.config.timezone;
  const runs: LarkRow[][] = [];
  for (const m of rows) {
    const last = runs.at(-1);
    if (last && last[0].chat_id === m.chat_id && m.create_ms - last.at(-1)!.create_ms < 10 * 60_000) last.push(m);
    else runs.push([m]);
  }
  for (const group of runs) {
    const name = nameOf(group[0].chat_id);
    const lines = group.map((m) => `- ${localStamp(m.create_ms, tz, { seconds: true }).slice(11)} ${truncate(m.content.trim(), 1000)}`);
    addEntry(app, t, "lark", `我在飞书「${name}」里发了：\n${lines.join("\n")}`, { chatId: group[0].chat_id, messageIds: group.map((m) => m.message_id), line: `飞书「${truncate(name, 30)}」我发了 ${group.length} 条` }, group[0].create_ms);
  }
  return rows.length;
}

/** 远程 recordings that finished in the window and are not on the timeline yet. */
function collectRemote(app: App, t: Thread, s: DemoSettings, stoppedAt: string) {
  const known = new Set(all<{ r: string }>(app.db, "select json_extract(meta, '$.demo.recordingId') r from messages where conversation_id = ? and json_extract(meta, '$.demo.recordingId') is not null", t.id).map((x) => x.r));
  const rows = all<{ id: string }>(app.db, "select id from remote_recordings where user_id = ? and finished_at >= ? and finished_at <= ? order by created_at", t.userId, s.startedAt, stoppedAt).filter((r) => !known.has(r.id));
  for (const r of rows) attachRecording(app, t.id, getRecording(app, r.id), null, t.userId);
  return rows.length;
}

/** The timeline as the organizing message lists it: one line per entry. */
function timelineLines(app: App, t: Thread) {
  const tz = app.config.timezone;
  return all<{ created_at: string; meta: string }>(app.db, "select created_at, meta from messages where conversation_id = ? order by created_at, rowid", t.id)
    .map((m) => ({ at: m.created_at, demo: (JSON.parse(m.meta || "{}") as { demo?: { kind?: string; line?: string } }).demo }))
    .filter((m) => m.demo?.kind && TIMELINE.includes(m.demo.kind as DemoEntryKind))
    .map((m) => `- ${localStamp(m.at, tz, { seconds: true }).slice(11)} ${m.demo!.line ?? m.demo!.kind}`);
}

/** The message that hands the timeline to the assistant (skill-from-demo). */
export function organizeDemoText(app: App, d: DemoView, organize: Exclude<DemoOrganize, "none">) {
  const t = getThread(app, d.id);
  const lines = timelineLines(app, t);
  const minutes = Math.max(1, Math.round((Date.parse(d.stoppedAt ?? now()) - Date.parse(d.startedAt)) / 60_000));
  const tz = app.config.timezone;
  // A 关注 deleted meanwhile has no lessons file: its item, else a skill.
  const what = organize === "lessons" && d.context && d.lessonsPath
    ? `请整理成关注「${d.context.name}」（${d.context.id}）处理这类情况的经验：确认后用 write_file 写到 ${d.lessonsPath}（space ${d.spaceId}，整份替换）。宿主会把它和这个关注的经验一起给处理的助手看，listen-coach 整理经验时也保留它。`
    : organize === "lessons" && d.item
      ? `请整理成事项「${d.item.title}」（${d.item.id}）这类情况的做法：确认后用 write_file 写成挂在事项上的工作文件（item ${d.item.id}，path 演示/${goalFile(d.goal)}）。`
      : "请整理成技能：以后照着做就能做成的固定步骤，确认后用 save_skill 保存（有录制时带上 from_recording）。";
  const head = [
    `我演示完了：${d.goal}（演示 ${d.id}，${localStamp(d.startedAt, tz, { short: true })} 起 ${minutes} 分钟）。`,
    d.context ? `这次是关注「${d.context.name}」里的事。` : "",
    d.item ? `这次是事项「${d.item.title}」（${d.item.id}）里的事。` : "",
  ].filter(Boolean).join("\n");
  return [
    head,
    lines.length
      ? `时间线（${lines.length} 条，按时间；每条的全文在这个会话里，用 read_conversation 读 ${d.id}）：\n${lines.join("\n")}`
      : "这次没有记下录制、拾取或飞书消息：先问我刚才演示的是什么，或者让我补一段。",
    `按技能 skill-from-demo 看这段演示：先复述你看到的做法，只问我每次会变的和怎么算做成，我回答后再保存。${what}看下来更像另一种（固定步骤 / 判断经验）时先跟我说。`,
  ].join("\n\n");
}

/** Stop it: gather what is only read at the end, then maybe hand it to the assistant. */
export async function stopDemo(app: App, userId: string, id: string, organize: DemoOrganize) {
  const t = demoThread(app, id, userId);
  const s = t.settings.demo!;
  if (s.stoppedAt) throw new HttpError(409, "这次演示已经结束了");
  const before = view(app, t);
  if (organize === "lessons" && !before.context && !before.item) throw new HttpError(400, "经验要挂在一个关注或事项上：这次没有，选整理成技能");
  const stoppedAt = now();
  const lark = await collectLark(app, t, s, Date.parse(stoppedAt));
  const remote = collectRemote(app, t, s, stoppedAt);
  updateThread(app, t.id, { settings: { demo: { ...s, stoppedAt, organize } } });
  const d = getDemo(app, t.id, userId);
  if (organize === "none") {
    addEntry(app, getThread(app, t.id), "stop", "演示结束，先不整理。");
    return { demo: d, conversationId: t.id, runId: null as string | null, collected: { lark, remote } };
  }
  const sent = await ask(app, { text: organizeDemoText(app, d, organize), conversationId: t.id, userId, meta: { demo: { kind: "organize", organize } } });
  return { demo: getDemo(app, t.id, userId), conversationId: t.id, runId: sent.runId as string | null, collected: { lark, remote } };
}

/** The demonstration a clip or an import names, which must be the owner's. */
export const requireDemo = (app: App, id: string, userId: string) => getDemo(app, id, userId);
