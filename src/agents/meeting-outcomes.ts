import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { canWrite, scopeFor } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskHandler } from "./asks.ts";
import { getRun, runUser } from "./runs.ts";
import { recordChange } from "../items/changes.ts";
import { itemsAt, materialCandidates, type Place } from "../items/places.ts";
import { getItem, isClosed, upsertItem, type Item } from "../items/store.ts";

/**
 * After a meeting: its decisions, to-dos and open questions as changes of the item it is about
 * (docs/v2/architecture.md “变化台账”). The meeting's summary run (lark-meetings.ts startAgent, final)
 * reads the meeting and hands them in with `meeting_outcomes`; the host checks the run, the item and
 * that each entry cites the meeting's own record, then writes them through the change ledger
 * (items/changes.ts recordChange), keyed by the meeting and the lines cited, so handling the same
 * meeting again writes nothing twice. No decision is picked out of the minutes by the host.
 *
 * Which items a meeting is about, confirmed only from what is already recorded (meetingLinks): the 关注
 * the meeting was handed to follows that item; the group it was started in is linked to the item; its
 * record is already a material of the item. An item that only reads alike is a candidate: the outcomes
 * wait on a question to the owner (on the work page's 等你处理 like every ask) and are written when they
 * say so. A to-do's date is its own; a new deadline for the item moves it only when settled (`decided`),
 * otherwise it is asked about (改成这个时间 / 不改), as item-follow does with a proposed date.
 */

const ref = z.string().regex(/^src:[\w-]+#L\d+(?:-L?\d+)?$/, "引用写成 src:<会议记录的原件id>#L起-L止");
const entry = z.object({ what: z.string().trim().min(1).max(300), who: z.string().trim().max(60).optional(), refs: z.array(ref).min(1).max(6) });
export const outcomesSchema = z.object({
  item_id: z.string().describe("这场会关于的事项：任务里列的已确认关联的事项；只是像的也可以填，会先问本人"),
  decisions: z.array(entry).max(20).optional().describe("会上定下来的：谁定的、定了什么"),
  todos: z.array(entry.extend({ due: z.string().date().optional().describe("这件待办自己的截止日期（YYYY-MM-DD）") })).max(20).optional().describe("待办：谁、做什么、什么时候之前"),
  open_questions: z.array(entry).max(20).optional().describe("提了但没定下来的问题"),
  deadline: z.object({ due: z.string().date(), summary: z.string().trim().min(1).max(300), decided: z.boolean().optional().describe("会上已经定了（本人说的或明确拍板）才填 true；只是有人提议不填"), refs: z.array(ref).min(1).max(6) }).optional()
    .describe("这件事项本身的截止时间变了才填（不是某个待办的日期）"),
});
export type Outcomes = z.infer<typeof outcomesSchema>;

type MeetingRow = { meeting_id: string; topic: string; chat_id: string | null; source_id: string | null; plan: string | null; space_id: string | null };
const meetingOf = (app: App, id: string) => one<MeetingRow>(app.db, "select meeting_id, topic, chat_id, source_id, plan, space_id from lark_meetings where meeting_id = ?", id);

export type MeetingLink = { item: Item; why: string };
/** The items a meeting is about: confirmed (from what is recorded) and candidates (only alike). */
export function meetingLinks(app: App, meetingId: string, userId: string): { confirmed: MeetingLink[]; candidates: { item: Item; reasons: string[] }[] } {
  const m = meetingOf(app, meetingId);
  if (!m) return { confirmed: [], candidates: [] };
  const confirmed: MeetingLink[] = [];
  const add = (item: Item | null | undefined, why: string) => {
    if (!item || item.userId !== userId || isClosed(item.status) || item.status === "candidate" || confirmed.some((c) => c.item.id === item.id)) return;
    confirmed.push({ item, why });
  };
  // The 关注 the meeting was handed to (a meeting rule or a 关注 on its group) follows an item.
  const contextId = m.plan ? json<{ contextId?: string }>(m.plan, {}).contextId : undefined;
  const ctx = contextId ? one<{ item_id: string | null; name: string }>(app.db, "select item_id, name from listen_contexts where id = ? and kind = 'item'", contextId) : undefined;
  if (ctx?.item_id) add(getItemOrNull(app, ctx.item_id), `关注「${ctx.name}」把这场会交给了这件事`);
  // The group it was started in, or its record, is already linked to an item.
  const places: Place[] = [];
  if (m.chat_id) {
    for (const s of all<{ id: string }>(app.db, "select id from sources where uri = ? and kind = 'chat' and deleted_at is null limit 5", `lark:${m.chat_id}`)) places.push({ kind: "source", ref: s.id });
    for (const c of all<{ id: string }>(app.db, "select id from conversations where channel like 'lark%' and external_id = ? limit 5", m.chat_id)) places.push({ kind: "conversation", ref: c.id });
  }
  for (const item of itemsAt(app, places, userId, 5)) add(item, "会议所在的群挂在这件事上");
  if (m.source_id) for (const item of itemsAt(app, [{ kind: "source", ref: m.source_id }], userId, 5)) add(item, "会议记录已经是这件事的材料");
  const text = [m.topic, m.source_id ? one<{ t: string }>(app.db, "select substr(text,1,6000) t from sources where id = ?", m.source_id)?.t ?? "" : ""].join("\n");
  const candidates = materialCandidates(app, text, userId, 3, { sources: m.source_id ? [m.source_id] : [] })
    .filter((c) => !confirmed.some((x) => x.item.id === c.item.id)).map((c) => ({ item: c.item, reasons: c.reasons }));
  return { confirmed, candidates };
}
function getItemOrNull(app: App, id: string) {
  try { return getItem(app, id); } catch { return null; }
}

/** What the summary run is told about the items (lark-meetings.ts startAgent): "" when there is no record to cite. */
export function outcomesTask(app: App, meetingId: string, userId: string): string {
  const m = meetingOf(app, meetingId);
  if (!m?.source_id) return "";
  const { confirmed, candidates } = meetingLinks(app, meetingId, userId);
  const line = (i: Item, why: string) => `- ${i.id}「${truncate(i.title, 60)}」：${why}`;
  return [
    "# 会议的结果记到事项上",
    "",
    confirmed.length ? `这场会已确认关联的事项：\n${confirmed.map((c) => line(c.item, c.why)).join("\n")}` : "这场会还没有确认关联的事项。",
    candidates.length ? `只是看起来相关（还没确认，交上去会先问本人）：\n${candidates.map((c) => line(c.item, c.reasons.join("，"))).join("\n")}` : "",
    "",
    `会上对某件事项有决定、待办或没定下来的问题时，用 meeting_outcomes 交给宿主，一件事项调一次：decisions（谁定的、定了什么）、todos（谁、做什么、有日期就写 due）、open_questions（提了没定的）；每条都引用会议记录原件 src:${m.source_id} 的行。事项本身的截止时间变了才填 deadline，会上定了才写 decided。和这些事项都无关的不用交；交过的同一场会再交不会重复记。`,
  ].filter((x) => x !== "").join("\n");
}

/** The cited lines, checked against the meeting's own record; the first line of the first one, for the key. */
function checkRefs(app: App, m: MeetingRow, refs: string[]) {
  const lines = one<{ n: number }>(app.db, "select length(text) - length(replace(text, char(10), '')) + 1 n from sources where id = ? and deleted_at is null", m.source_id!)?.n ?? 0;
  for (const r of refs) {
    const x = /^src:([\w-]+)#L(\d+)(?:-L?(\d+))?$/.exec(r)!;
    const from = Number(x[2]), to = Number(x[3] ?? x[2]);
    if (x[1] !== m.source_id) throw new HttpError(400, `引用要是这场会议的记录 src:${m.source_id}`);
    if (from < 1 || to < from || to > lines) throw new HttpError(400, `引用的行不在会议记录里（共 ${lines} 行）：${r}`);
  }
  const first = /#L(\d+)(?:-L?(\d+))?$/.exec(refs[0])!;
  return `L${first[1]}${first[2] && first[2] !== first[1] ? `-L${first[2]}` : ""}`;
}

/** The outcomes written as changes of the item. Returns how many were new and how many added to. */
function writeOutcomes(app: App, m: MeetingRow, item: Item, o: Outcomes, runId: string | null) {
  let created = 0, updated = 0;
  const note = (type: "decision" | "todo" | "question", e: { what: string; who?: string; refs: string[]; due?: string }) => {
    const r = recordChange(app, {
      itemId: item.id, type, origin: "meeting", runId, refs: e.refs, due: e.due ?? null,
      summary: e.who ? `${e.who}：${e.what}` : e.what, source: `meeting:${m.meeting_id}#${checkRefs(app, m, e.refs)}`,
      detail: `会议「${truncate(m.topic || "无标题", 60)}」`,
    });
    if (r?.created) created++; else if (r?.updated) updated++;
  };
  tx(app.db, () => {
    for (const e of o.decisions ?? []) note("decision", e);
    for (const e of o.todos ?? []) note("todo", e);
    for (const e of o.open_questions ?? []) note("question", e);
  });
  let deadline = "";
  if (o.deadline && o.deadline.due !== item.dueAt?.slice(0, 10)) {
    const d = o.deadline;
    const r = recordChange(app, { itemId: item.id, type: "deadline", origin: "meeting", runId, refs: d.refs, due: d.due, summary: d.summary, source: `meeting:${m.meeting_id}#deadline` });
    const row = r && one<{ status: string; ask_id: string | null }>(app.db, "select status, ask_id from item_changes where id = ?", r.id);
    if (r && row && ["noted", "asked"].includes(row.status)) {
      if (d.decided) {
        upsertItem(app, item.id, { dueAt: d.due, sourceRefs: d.refs, note: `${d.summary}（会议「${m.topic}」上定的）` }, "agent", runId ?? undefined);
        run(app.db, "update item_changes set status = 'merged', updated_at = ? where id = ?", now(), r.id);
        if (row.ask_id) cancelAsk(app, row.ask_id, "截止时间已经定了");
        deadline = `截止时间改成了 ${d.due}`;
      } else if (!row.ask_id) {
        const ask = createAsk(app, {
          runId, conversationId: null, userId: item.userId, allowText: false,
          question: `会议「${m.topic || "无标题"}」上有人提出改「${item.title}」的截止时间：\n\n**${d.summary}**\n- 提出改成：${d.due}\n- 现在的截止时间：${item.dueAt ?? "未定"}\n- 原话：${d.refs.map((x, i) => `[${i + 1}](${x})`).join(" ")}`,
          options: [{ label: "改成这个时间" }, { label: "不改" }],
          context: { handler: "meeting-deadline", itemId: item.id, changeId: r.id, due: d.due },
        });
        run(app.db, "update item_changes set status = 'asked', ask_id = ?, updated_at = ? where id = ?", ask.id, now(), r.id);
        deadline = "改期的提议问了本人";
      }
    }
  }
  return { created, updated, deadline };
}

/**
 * The tool `meeting_outcomes`. Only a meeting's summary run (its input names the meeting and it is not
 * an in-meeting window); the item is its person's, writable, in the run's spaces. Confirmed items are
 * written now; any other becomes one question to the owner per meeting and item.
 */
export function submitOutcomes(app: App, runId: string | null | undefined, spaces: string[] | null, input: z.input<typeof outcomesSchema>) {
  if (!runId) throw new HttpError(403, "只有会后整理的运行能交会议结果");
  const o = outcomesSchema.parse(input);
  const r = getRun(app, runId);
  const meetingId = typeof r.input.meetingId === "string" ? r.input.meetingId : null;
  if (!meetingId || r.input.meetingWindow) throw new HttpError(403, "只有会议结束后的整理能交会议结果（会中旁听不交）");
  const m = meetingOf(app, meetingId);
  if (!m) throw new HttpError(404, "没有这场会议");
  if (!m.source_id) throw new HttpError(409, "这场会议的记录还没存成原件，没有可以引用的行");
  const userId = runUser(app, runId);
  const item = getItemOrNull(app, o.item_id);
  if (!item || item.userId !== userId) throw new HttpError(404, `没有这件事项：${o.item_id}`);
  const allowed = scopeFor(app, userId, spaces);
  if ((allowed && !allowed.includes(item.spaceId)) || !canWrite(app, userId, item.spaceId)) throw new HttpError(403, "这件事项不在这次运行能写的空间里");
  const source = one<{ space_id: string }>(app.db, "select space_id from sources where id = ?", m.source_id);
  if (allowed && source && !allowed.includes(source.space_id)) throw new HttpError(403, "会议记录不在这次运行能读的空间里");
  const all_ = [...(o.decisions ?? []), ...(o.todos ?? []), ...(o.open_questions ?? []), ...(o.deadline ? [o.deadline] : [])];
  if (!all_.length) throw new HttpError(400, "decisions、todos、open_questions、deadline 至少交一项");
  for (const e of all_) checkRefs(app, m, e.refs);
  const link = meetingLinks(app, meetingId, userId).confirmed.find((c) => c.item.id === item.id);
  if (link) {
    const w = writeOutcomes(app, m, item, o, runId);
    return `已记到「${item.title}」（${link.why}）：新记 ${w.created} 条，补进已有的 ${w.updated} 条${w.deadline ? `；${w.deadline}` : ""}。`;
  }
  // Not a confirmed link: one question per meeting and item; a newer hand-in replaces the waiting one.
  const waiting = one<{ id: string }>(app.db, "select id from asks where status = 'pending' and json_extract(context, '$.handler') = 'meeting-outcomes' and json_extract(context, '$.meetingId') = ? and json_extract(context, '$.itemId') = ?", meetingId, item.id);
  if (waiting) cancelAsk(app, waiting.id, "换成了新交的结果");
  const count = all_.length;
  const ask = createAsk(app, {
    runId, conversationId: null, userId, allowText: false,
    question: `会议「${m.topic || "无标题"}」的结果要记到「${item.title}」上吗？还没有确认这场会和它有关。\n\n${[
      ...(o.decisions ?? []).map((e) => `- 决定：${e.who ? `${e.who}：` : ""}${e.what}`),
      ...(o.todos ?? []).map((e) => `- 待办：${e.who ? `${e.who}：` : ""}${e.what}${e.due ? `（${e.due} 前）` : ""}`),
      ...(o.open_questions ?? []).map((e) => `- 没定的：${e.what}`),
      ...(o.deadline ? [`- 截止时间：${o.deadline.summary}（${o.deadline.due}）`] : []),
    ].slice(0, 12).join("\n")}`,
    options: [{ label: "记到这件事" }, { label: "不用" }],
    context: { handler: "meeting-outcomes", meetingId, itemId: item.id, outcomes: o, choice: { kind: "meeting-item", target: `${meetingId}>${item.id}` } },
  });
  return `「${item.title}」和这场会的关联还没确认：${count} 条结果先问本人（${ask.id}），本人同意后才记。`;
}

registerAskHandler("meeting-outcomes", async (app, ask, ctx) => {
  if (ask.choice !== 0) return;
  const m = meetingOf(app, String(ctx.meetingId));
  const item = getItemOrNull(app, String(ctx.itemId));
  if (!m?.source_id || !item || isClosed(item.status)) return;
  // The owner said it is about this item: its record becomes a material, so the next meeting's outcomes go in directly.
  const { addMaterials } = await import("../items/materials.ts");
  await addMaterials(app, item.id, [{ kind: "source", ref: m.source_id, note: `会议「${m.topic}」：本人确认和这件事有关` }], item.userId, "user").catch(() => []);
  const w = writeOutcomes(app, m, item, ctx.outcomes as Outcomes, ask.runId);
  run(app.db, "update asks set result = ? where id = ?", `已记到「${item.title}」：新记 ${w.created} 条，补进 ${w.updated} 条${w.deadline ? `；${w.deadline}` : ""}`, ask.id);
}, (app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有本人能定会议结果记到哪件事");
});

registerAskHandler("meeting-deadline", async (app, ask, ctx) => {
  const id = String(ctx.changeId);
  const c = one<{ status: string; due: string | null; refs: string; summary: string }>(app.db, "select status, due, refs, summary from item_changes where id = ? and ask_id = ?", id, ask.id);
  if (!c || c.status !== "asked") return;
  if (ask.choice === 0 && c.due) {
    upsertItem(app, String(ctx.itemId), { dueAt: c.due, sourceRefs: json<string[]>(c.refs, []), note: `${c.summary}（本人在卡片上选了改）` }, "user");
    run(app.db, "update item_changes set status = 'merged', updated_at = ? where id = ?", now(), id);
  } else run(app.db, "update item_changes set status = 'dismissed', updated_at = ? where id = ?", now(), id);
}, (app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有事项本人能定截止时间");
});
