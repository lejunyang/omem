import type { z } from "zod";
import type { App } from "../core/app.ts";
import { lineStateSchema, NEXT_KINDS, proposeSchema } from "./line-schemas.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, localStamp, newId, now, truncate, zonedParts } from "../core/util.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { createAsk, cancelAsk, registerAskHandler } from "../agents/asks.ts";
import { createRun, getRun, setRunOutput } from "../agents/runs.ts";
import { CODE_STARTERS } from "../agents/tool-help.ts";
import type { RefTarget } from "./changes.ts";
import { validateItemRefs } from "./evidence.ts";
import { addMaterials } from "./materials.ts";
import { setParent } from "./parent.ts";
import { judgePhase, saveWrapUp } from "./lifecycle.ts";
import { addItemEvent, getItem, isClosed, upsertItem, type LineNow } from "./store.ts";
import { checkParent, descendantIds, rootOf } from "./tree.ts";

/**
 * Work lines (docs/v2/status.md “工作线”): what the owner is pushing on these weeks, as an item of kind `line`
 * with its work items under it. What a line says about itself comes from the run that looks at it about
 * once a day (channels/listen-assist.ts), handed in with `submit_line_state`:
 *
 * - `now`: one sentence as of today, the people and what each does, a sentence for each of the last weeks;
 * - `item_next`: at most three next steps, each with why and its evidence. A new look replaces the open
 *   ones (they become `expired`). The owner gets them once a day on one card for all lines (`line-next`):
 *   就这么做 starts a run on it, 不用 is remembered so the next look does not suggest it again.
 *
 * The nightly work-state proposes lines from what the owner did (`propose_lines`): a proposal matching
 * a line already there adds its materials and hangs its loose items under it; new ones go on one card a
 * night (`line-propose`), 建 / 不用 / 并进 an existing line.
 */
export { lineStateSchema, NEXT_KINDS, proposeSchema };
export type NextKind = (typeof NEXT_KINDS)[number];
export type NextStatus = "open" | "doing" | "done" | "declined" | "expired";
export type NextLite = {
  id: string; itemId: string; text: string; why: string; refs: string[]; kind: NextKind; status: NextStatus; runId: string | null; createdAt: string; updatedAt: string; decidedAt: string | null;
  /** On the work pages: the references naming an item or a run (items/changes.ts refTargets). */
  refTargets?: Record<string, RefTarget>;
};
type NextRow = { id: string; item_id: string; text: string; why: string; refs: string; kind: NextKind; status: NextStatus; run_id: string | null; created_at: string; updated_at: string; decided_at: string | null };
const toNext = (r: NextRow): NextLite => ({ id: r.id, itemId: r.item_id, text: r.text, why: r.why, refs: json<string[]>(r.refs, []), kind: r.kind, status: r.status, runId: r.run_id, createdAt: r.created_at, updatedAt: r.updated_at, decidedAt: r.decided_at });

export function nextOf(app: App, itemId: string, statuses: NextStatus[] = ["open", "doing"]): NextLite[] {
  return all<NextRow>(app.db, `select * from item_next where item_id = ? and status in (${statuses.map(() => "?").join(",")}) order by created_at, id`, itemId, ...statuses).map(toNext);
}
export function getNext(app: App, id: string): NextLite {
  const r = one<NextRow>(app.db, "select * from item_next where id = ?", id);
  if (!r) throw new HttpError(404, `没有这条下一步：${id}`);
  return toNext(r);
}

// ------------------------------------------------------------------ the line's state

const runUser = (app: App, runId: string) => one<{ u: string }>(app.db, "select coalesce(user_id, 'owner') u from runs where id = ?", runId)?.u ?? OWNER;

/** The line a run looks at (`lineState` in its input), checked: running, top-level, its person's. */
function lineOfRun(app: App, runId: string) {
  const r = getRun(app, runId);
  const id = (r.input as { lineState?: string }).lineState;
  if (!id || r.status !== "running") throw new HttpError(403, "只有看一条工作线现状的运行能交 submit_line_state");
  const item = getItem(app, id);
  if (item.parentId) throw new HttpError(400, "只有顶层的事项有工作线的现状");
  if (runUser(app, runId) !== item.userId) throw new HttpError(403, "不是这条线本人的运行");
  return item;
}

/**
 * What the look at a line found: its `now` is stored, its open next steps are replaced (the old open
 * ones expire). Nothing is sent to the owner: the daily card takes the new next steps (lineNextDue).
 */
export function submitLineState(app: App, runId: string, input: z.input<typeof lineStateSchema>) {
  const a = lineStateSchema.parse(input);
  const item = lineOfRun(app, runId);
  const evidence = [...a.next.flatMap((n) => n.refs), ...(a.phase?.refs ?? [])].filter((r) => /^(src|mem|msg):/.test(r));
  validateItemRefs(app, evidence, item.userId);
  // The wrap-up after the line ended (items/lifecycle.ts): its closing summary, no next steps.
  if ((getRun(app, runId).input as { lineWrapUp?: boolean }).lineWrapUp) {
    if (!a.summary) throw new HttpError(400, "收尾要写 summary：做成了什么、关键决定、上线后数字怎么样、还剩什么");
    saveWrapUp(app, item, a.now, a.summary, runId);
    setRunOutput(app, runId, { lineState: { itemId: item.id, wrapUp: true } });
    return `已把收尾小结记在「${truncate(item.title, 40)}」上。不用再通知本人，用一句话结束。`;
  }
  const at = now();
  const state: LineNow = { ...(item.now?.summary ? { summary: item.now.summary, summaryAt: item.now.summaryAt } : {}), text: a.now, people: a.people.map((p) => ({ name: p.name, ...(p.open_id ? { openId: p.open_id } : {}), role: p.role })), weeks: a.weeks, at, runId };
  const ids: string[] = [];
  const closed = isClosed(item.status);
  tx(app.db, () => {
    run(app.db, "update items set now = ? where id = ?", JSON.stringify(state), item.id);
    if (closed) return;
    run(app.db, "update item_next set status = 'expired', updated_at = ? where item_id = ? and status = 'open'", at, item.id);
    for (const n of a.next) {
      const id = newId("nx");
      run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,run_id,created_at,updated_at) values(?,?,?,?,?,?,'open',?,?,?)", id, item.id, n.text, n.why, JSON.stringify(n.refs), n.kind, runId, at, at);
      ids.push(id);
    }
  });
  // Where the look thinks the line is: the host acts only with enough confidence (items/lifecycle.ts).
  const phase = a.phase && !closed ? judgePhase(app, item.id, a.phase, runId) : "";
  setRunOutput(app, runId, { lineState: { itemId: item.id, next: ids, ...(a.phase ? { phase: { ...a.phase, applied: phase } } : {}) } });
  app.emit({ type: "changed", entity: "item", id: item.id, spaceId: item.spaceId });
  return `已记下「${truncate(item.title, 40)}」的现状${ids.length ? `和 ${ids.length} 条下一步（本人每天在一张卡片上一起看各条线的下一步）` : "（这次没有下一步）"}。${phase}不用再通知本人，用一句话结束。`;
}

/** The owner's latest 不用 on this line's suggestions: the look reads them so it does not suggest them again. */
export function declinedNext(app: App, itemId: string, limit = 8) {
  return all<NextRow>(app.db, "select * from item_next where item_id = ? and status = 'declined' order by decided_at desc limit ?", itemId, limit).map(toNext);
}

// ------------------------------------------------------------------ the daily card

const CARD_DAY = "line_next_card_day", CARD_AT = "line_next_card_at";
const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? null;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);
const CHOICES = ["就这么做", "不用"];
/** When the day's card goes out: the first set time of `notify.laterTimes`, else 10:00. */
function cardMinute(app: App) {
  const minutes = app.config.notify.laterTimes.flatMap((t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? [Number(m[1]) * 60 + Number(m[2])] : []; });
  return minutes.length ? Math.min(...minutes) : 10 * 60;
}

/**
 * Heartbeat: once a day, at its time, one card with the open next steps of every line made since the
 * last card, grouped by line, each 就这么做 / 不用 (one ask the host handles, `line-next`). Null when
 * it is not time yet, the card already went today, or there is nothing new.
 */
export function lineNextDue(app: App, at = new Date(), userId = OWNER) {
  const local = zonedParts(at, app.config.timezone);
  if (local.hour * 60 + local.minute < cardMinute(app) || kv(app, CARD_DAY) === local.date) return null;
  setKv(app, CARD_DAY, local.date);
  const since = kv(app, CARD_AT) ?? "";
  const rows = all<NextRow & { title: string }>(app.db,
    `select n.*, i.title from item_next n join items i on i.id = n.item_id
      where n.status = 'open' and n.created_at > ? and coalesce(i.user_id,'owner') = ? and i.status not in ('done','cancelled','expired','candidate')
      order by i.title, n.created_at limit 30`, since, userId);
  if (!rows.length) return null;
  setKv(app, CARD_AT, at.toISOString());
  const byLine = new Map<string, (NextRow & { title: string })[]>();
  for (const r of rows) byLine.set(r.item_id, [...byLine.get(r.item_id) ?? [], r]);
  const body = [...byLine.values()].map((list) => [`**${list[0].title}**`, ...list.map((n) => `- ${n.text}${n.why ? `：${truncate(n.why, 160)}` : ""}`)].join("\n")).join("\n\n");
  const single = rows.length === 1;
  return createAsk(app, {
    runId: null, conversationId: null, userId, allowText: false,
    question: `今天各条线的下一步（${byLine.size} 条线，${rows.length} 条建议）。就这么做的，助手接着去做；不用的，以后少提这类。\n\n${body}`,
    options: single ? CHOICES.map((label) => ({ label })) : [],
    ui: single ? null : { fields: rows.map((n) => ({ id: n.id, type: "choice" as const, label: truncate(`${n.title}：${n.text}`, 200), required: false, options: CHOICES })) },
    context: { handler: "line-next", next: rows.map((r) => r.id) },
  });
}

/** Tools a next step's run may not use: it does not post, invite, make rules or watches; it codes only when the step is coding. */
export const nextDenied = (kind: NextKind) => ["lark_send", "lark_card", "lark_write", "lark_invite", "save_rule", "set_chat_watch", "notify", ...(kind === "code" ? [] : CODE_STARTERS)];

function nextTask(app: App, n: NextLite, line: ReturnType<typeof getItem>) {
  const others = nextOf(app, line.id).filter((x) => x.id !== n.id);
  const how: Record<NextKind, string> = {
    read: "读相关的原件和会话，把要弄清的弄清，结论写清楚，带引用。",
    test: "按事项和需求点写出要测的、能跑的就跑（只读环境、测试账号），结果逐条写清。",
    code: "需要改代码的，用 delegate_code 交办（item_id 填对应的工作项），交办之前先读材料把要改的写清。",
    ask: "不要直接发消息：写清要问谁、问什么、为什么，起草好问题给本人看。",
    data: "用 metric_read 看相关指标，或按技能 observation-plan 补观测计划，把看到的变化和判断写清。",
  };
  return [
    `# 工作线「${line.title}」（${line.id}）的一步：${n.text}`,
    "",
    "本人在每天的下一步卡片上点了“就这么做”。",
    n.why ? `为什么：${n.why}` : "",
    n.refs.length ? `依据：${n.refs.join(" ")}` : "",
    line.now ? `\n## 这条线现在\n\n${line.now.text}${line.now.people.length ? `\n相关的人：${line.now.people.map((p) => `${p.name}（${p.role}）`).join("、")}` : ""}` : "",
    others.length ? `\n## 这条线别的下一步（这次不做）\n\n${others.map((x) => `- ${x.text}`).join("\n")}` : "",
    "",
    "# 要你做的",
    "",
    how[n.kind],
    "先 read_item 读这条线和下面的工作项。不在群里发消息、不拉人、不建规则；要改事项的只记进展（upsert_item 的 note），不改它的状态。",
    "最后写一段结论：做了什么、看到了什么、还剩什么要本人定。它会放进这条线的会话，并告诉本人。",
  ].filter((x) => x !== "").join("\n");
}

/**
 * The owner's answer on one next step (card, web): `doing` starts one run on it (the line's space, its
 * own lane), `declined` is remembered for the next look, `done` closes it. An answer the card still
 * waits for is settled there too.
 */
export function decideNext(app: App, id: string, status: "doing" | "declined" | "done", by: string) {
  const n = getNext(app, id), line = getItem(app, n.itemId);
  if (by !== line.userId) throw new HttpError(403, "只有这条线本人能定它的下一步");
  if (status === "doing" && n.status !== "open" && n.status !== "declined") throw new HttpError(409, n.status === "doing" ? "这一步已经在做了" : "这一步已经处理过了");
  if (status === "declined" && n.status !== "open") throw new HttpError(409, "只有还没定的下一步能选不用");
  const at = now();
  let runId: string | null = null;
  if (status === "doing") {
    const r = createRun(app, {
      kind: "agent", spaceId: line.spaceId, lane: `line-next:${line.id}`, userId: line.userId,
      title: `下一步「${truncate(n.text, 40)}」`,
      input: {
        spec: "assistant", task: nextTask(app, n, line), lineNext: n.id,
        assistantScope: { spaces: [...new Set([line.spaceId, "personal"])], userId: line.userId, denyTools: nextDenied(n.kind), lark: { chats: [], draft: true } },
      },
    });
    runId = r.id;
  }
  run(app.db, "update item_next set status = ?, run_id = coalesce(?, run_id), decided_at = ?, updated_at = ? where id = ?", status, runId, at, at, id);
  addItemEvent(app, line.id, "note", status === "doing" ? `下一步开始做：${n.text}` : status === "declined" ? `下一步不用：${n.text}` : `下一步做完：${n.text}`, "user", [], runId ?? undefined);
  app.emit({ type: "changed", entity: "item", id: line.id, spaceId: line.spaceId });
  // The day's card that still offers this one: settled once none of its steps is left open.
  for (const a of all<{ id: string; context: string }>(app.db, "select id, context from asks where status = 'pending' and json_extract(context, '$.handler') = 'line-next'")) {
    const ids = json<{ next?: string[] }>(a.context, {}).next ?? [];
    if (ids.includes(id) && !one(app.db, `select 1 from item_next where status = 'open' and id in (${ids.map(() => "?").join(",")})`, ...ids)) cancelAsk(app, a.id, "已在网页上逐条处理");
  }
  return { ...getNext(app, id), runId: runId ?? n.runId };
}

registerAskHandler("line-next", async (app, ask, ctx) => {
  const ids = (ctx.next as string[] | undefined) ?? [];
  for (const id of ids) {
    const n = one<NextRow>(app.db, "select * from item_next where id = ?", id);
    if (!n || n.status !== "open") continue;
    const picked = ids.length === 1 ? (ask.choice === null ? null : CHOICES[ask.choice]) : String(ask.value?.[id] ?? "");
    if (picked === CHOICES[0]) decideNext(app, id, "doing", ask.answeredBy ?? ask.userId);
    else if (picked === CHOICES[1]) decideNext(app, id, "declined", ask.answeredBy ?? ask.userId);
  }
}, (_app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有本人能定各条线的下一步");
});

/** A next step's run ended: the step is done, its conclusion goes into the line's 关注 conversation and to the owner. */
export async function nextRunDone(app: App, nextId: string, runId: string, answer: string) {
  const n = one<NextRow>(app.db, "select * from item_next where id = ?", nextId);
  if (!n || n.status !== "doing" || n.run_id !== runId) return;
  const at = now();
  run(app.db, "update item_next set status = 'done', updated_at = ? where id = ?", at, nextId);
  const line = getItem(app, n.item_id);
  addItemEvent(app, line.id, "note", `下一步做完：${n.text}\n${truncate(answer, 600)}`, "agent", [], runId);
  const { itemContext } = await import("../channels/listen.ts");
  const c = itemContext(app, line.id);
  if (c?.conversationId) {
    const { addMessage } = await import("../agents/threads.ts");
    addMessage(app, c.conversationId, "user", `（下一步做完：${n.text}）\n\n${truncate(answer, 4000)}`, null, { command: true, lineNext: nextId, runId });
  }
  const { notify } = await import("../core/notify.ts");
  notify(app, { userId: line.userId, title: `「${truncate(line.title, 30)}」的下一步做完了`, body: `**${n.text}**\n\n${truncate(answer, 1500)}`, urgency: "later", link: `#/work/${line.id}`, runId });
}

// ------------------------------------------------------------------ proposed lines

type Proposal = { key: string; name: string; goal: string; items: string[]; sources: string[] };
const norm = (s: string) => s.replace(/[\s「」“”"'·・\-—_/]+/g, "").toLowerCase();
const declinedKey = (name: string) => `line_declined:${norm(name).slice(0, 80)}`;
const DECLINE_MS = 14 * 86400_000;

/** The sources a proposal names (a chat by its id or its captured source, documents), as material ids its person may read. */
function proposalSources(app: App, chats: string[], sources: string[], userId: string) {
  const allowed = accessibleSpaces(app, userId);
  const out = new Set<string>();
  for (const c of chats) {
    const id = c.startsWith("src:") ? c.slice(4).split("#")[0] : one<{ id: string }>(app.db, "select id from sources where uri = ? and deleted_at is null order by captured_at limit 1", `lark:${c}`)?.id;
    if (id) out.add(id);
  }
  for (const s of sources) out.add(s.replace(/^src:/, "").split("#")[0]);
  return [...out].filter((id) => {
    const s = one<{ space_id: string }>(app.db, "select space_id from sources where id = ? and deleted_at is null", id);
    return !!s && (!allowed || allowed.includes(s.space_id));
  });
}

/** Open lines of a person: kind `line`, not closed. */
export const openLines = (app: App, userId = OWNER) => all<{ id: string; title: string; space_id: string }>(app.db, "select id, title, space_id from items where kind = 'line' and coalesce(user_id,'owner') = ? and status not in ('done','cancelled','expired','candidate') order by created_at", userId);

/** Materials and loose items of a proposal into a line: only adds (what is there stays), each item that hangs under nothing. */
async function intoLine(app: App, lineId: string, p: { items: string[]; sources: string[] }, by: "agent" | "user", userId: string, runId?: string) {
  const have = new Set(all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'source'", lineId).map((r) => r.ref));
  const fresh = p.sources.filter((s) => !have.has(s));
  let materials = 0, hung = 0;
  for (const ref of fresh) {
    try { materials += (await addMaterials(app, lineId, [{ kind: "source", ref }], userId, by)).length; } catch { /* One it may not read is left out. */ }
  }
  for (const id of p.items) {
    const it = one<{ parent_id: string | null; kind: string; status: string; user_id: string | null }>(app.db, "select parent_id, kind, status, user_id from items where id = ?", id);
    if (!it || it.parent_id || id === lineId || it.kind === "line" || isClosed(it.status) || (it.user_id ?? OWNER) !== userId) continue;
    try { checkParent(app, id, lineId); setParent(app, id, lineId, by, runId); hung++; } catch { /* Too deep, or another person's: left where it is. */ }
  }
  return { materials, hung };
}

/**
 * The tool `propose_lines` (role work-state): proposals that match an open line (one of its items is
 * listed, or the same name) add to it at once; new ones wait for the card sent when the run ends
 * (linesCard). Names the owner said 不用 to are not asked again for 14 days.
 */
export async function proposeLines(app: App, runId: string, input: z.input<typeof proposeSchema>) {
  const a = proposeSchema.parse(input);
  const r = getRun(app, runId);
  if (r.kind !== "work-state" || r.status !== "running") throw new HttpError(403, "只有每晚的近况整理能提议工作线");
  const userId = runUser(app, runId);
  const lines = openLines(app, userId);
  const out: string[] = [];
  const pending = ((r.output.lineProposals as Proposal[] | undefined) ?? []).slice();
  for (const [i, p] of a.lines.entries()) {
    const items = [...new Set(p.items)].filter((id) => !!one(app.db, "select 1 from items where id = ? and coalesce(user_id,'owner') = ?", id, userId));
    const sources = proposalSources(app, p.chats, p.sources, userId);
    const match = lines.find((l) => norm(l.title) === norm(p.name) || items.some((id) => id === l.id || rootOf(app, id) === l.id || descendantIds(app, l.id).includes(id)));
    if (match) {
      const got = await intoLine(app, match.id, { items, sources }, "agent", userId, runId);
      out.push(`「${p.name}」就是已有的工作线 ${match.id}「${match.title}」：${got.materials || got.hung ? `补了 ${got.materials} 份材料，${got.hung} 件事项归到它下面` : "没有要补的"}`);
      continue;
    }
    const declined = one<{ value: string }>(app.db, "select value from kv where key = ?", declinedKey(p.name))?.value;
    if (declined && Date.now() - Date.parse(declined) < DECLINE_MS) { out.push(`「${p.name}」本人 ${declined.slice(0, 10)} 说过不用建，两周内不再问`); continue; }
    const at = pending.findIndex((x) => norm(x.name) === norm(p.name));
    const entry: Proposal = { key: at >= 0 ? pending[at].key : `p${pending.length + i}`, name: p.name, goal: p.goal, items, sources };
    if (at >= 0) pending[at] = entry; else pending.push(entry);
    out.push(`「${p.name}」是新的：整理结束后问本人要不要建（${items.length} 件事项，${sources.length} 份材料）`);
  }
  setRunOutput(app, runId, { lineProposals: pending.slice(0, 8) });
  return out.join("\n");
}

/** After the night's work-state run: one card with the new lines it proposed (at most one a night). */
export function linesCard(app: App, runId: string) {
  const r = getRun(app, runId);
  const proposals = (r.output.lineProposals as Proposal[] | undefined) ?? [];
  if (!proposals.length) return null;
  const userId = runUser(app, runId);
  const day = localStamp(new Date(), app.config.timezone).slice(0, 10);
  if (one<{ value: string }>(app.db, "select value from kv where key = 'line_propose_day'")?.value === day) return null;
  setKv(app, "line_propose_day", day);
  const lines = openLines(app, userId).slice(0, 8);
  const merge = (title: string) => truncate(`并进「${title}」`, 60);
  const title = (id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? id;
  const body = proposals.map((p) => [`**${p.name}**${p.goal ? `：${truncate(p.goal, 200)}` : ""}`, p.items.length ? `- 事项：${p.items.slice(0, 6).map((id) => `「${truncate(title(id), 30)}」`).join("、")}${p.items.length > 6 ? ` 等 ${p.items.length} 件` : ""}` : "", p.sources.length ? `- 材料 ${p.sources.length} 份` : ""].filter(Boolean).join("\n")).join("\n\n");
  return createAsk(app, {
    runId: null, conversationId: null, userId, allowText: false,
    question: `这几周你在推进这几件事，要建成工作线吗？建了以后，相关的事项挂在线下面，每天有一句“截至今天”和下一步。\n\n${body}`,
    ui: { fields: proposals.map((p) => ({ id: p.key, type: "choice" as const, label: truncate(p.name, 200), required: false, options: ["建", "不用", ...lines.map((l) => merge(l.title))] })) },
    context: { handler: "line-propose", runId, proposals, lines: lines.map((l) => ({ id: l.id, label: merge(l.title) })) },
  });
}

/** A new line from a proposal (or by hand): the item, its materials, the loose items under it, and its 关注 (only reading, suggesting). */
export async function createLine(app: App, p: { name: string; goal?: string; items?: string[]; sources?: string[]; spaceId?: string }, userId: string, by: "user" | "agent" = "user") {
  const spaces = (p.items ?? []).map((id) => one<{ space_id: string }>(app.db, "select space_id from items where id = ?", id)?.space_id).filter((x): x is string => !!x);
  const common = [...new Set(spaces)].sort((a, b) => spaces.filter((s) => s === b).length - spaces.filter((s) => s === a).length)[0];
  const line = upsertItem(app, undefined, { kind: "line", title: p.name, detail: p.goal ?? "", spaceId: p.spaceId ?? common ?? "personal", userId }, by);
  await intoLine(app, line.id, { items: p.items ?? [], sources: p.sources ?? [] }, by, userId);
  const { setItemListening } = await import("../channels/listen-items.ts");
  setItemListening(app, line.id, true, { reply: "none", assist: "suggest" });
  return getItem(app, line.id);
}

registerAskHandler("line-propose", async (app, ask, ctx) => {
  const proposals = (ctx.proposals as Proposal[] | undefined) ?? [];
  const lines = (ctx.lines as { id: string; label: string }[] | undefined) ?? [];
  const userId = ask.userId;
  for (const p of proposals) {
    const picked = String(ask.value?.[p.key] ?? "");
    if (picked === "建") await createLine(app, p, userId, "user");
    else if (picked === "不用") setKv(app, declinedKey(p.name), now());
    else {
      const line = lines.find((l) => l.label === picked);
      const open = line && one<{ status: string }>(app.db, "select status from items where id = ?", line.id);
      if (line && open && !isClosed(open.status)) await intoLine(app, line.id, p, "user", userId);
    }
  }
}, (_app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有本人能定要不要建工作线");
});

/** The top-level item of an item, as a line (used by the work page and refresh). */
export const lineOf = (app: App, itemId: string) => getItem(app, rootOf(app, itemId));
