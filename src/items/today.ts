import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, truncate, webLink, zonedParts } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { answerAsk, cancelAsk, createAsk, getAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import type { UiField } from "../agents/ui-blocks.ts";
import { decideCandidate, pendingCandidates } from "./auto.ts";
import { autoInfo } from "./auto-cases.ts";
import { digestFor, isLineEnded, keepItem, markDigestSent } from "./expiry.ts";
import { LINE_END_CHOICES } from "./lifecycle.ts";
import { decideNext, decideProposal, heldProposals, lineNextDue, linesCard, markNextShown, markProposalsOffered, mergeTargets, newNextSteps, NEXT_CHOICES, openLines, type Proposal } from "./lines.ts";
import { pendingActions, type PendingAction } from "./pending.ts";
import { getItem, isClosed } from "./store.ts";
import { todayMinute, todayOn } from "./today-time.ts";
import { descendantIds } from "./tree.ts";

/**
 * 今天 (docs/v2/next.md “节奏”): one card in the morning instead of the several each part of the work
 * sent on its own. The host puts it together from what those cards read, no model:
 *
 * 1. 等你处理: what `pendingActions` lists, counted by kind, the three most pressing named; a pointer to
 *    the work page, no buttons (each has its own card or place).
 * 2. 各条线: each open line's “截至今天”, what under it is due within three days, and the next steps made
 *    since the last card (lines.ts newNextSteps), each 就这么做 / 不用. Watched lines only with new steps.
 * 3. 夜里整理出来的: the lines work-state proposed (left on its run, lines.ts heldProposals), the candidates
 *    the assistant made (auto.ts), what closed by itself or closes tomorrow and the lines that ended
 *    (expiry.ts digestFor), the line-end questions asked at night (lifecycle.ts, held by today-time.ts),
 *    last night's replay suggestions.
 * 4. 不急的通知: how many wait for their time of day (notify.ts releaseLater still sends them then).
 *
 * Each answered field goes to what the card it replaces did with it (decideNext, decideProposal,
 * decideCandidate, keepItem, the line-end question's own answer, resolveEffect); one decided elsewhere
 * meanwhile is skipped. With it on, the heartbeat sends no next-step card, item-digest no card for the
 * owner, work-state no proposal card (agents/jobs.ts, main.ts, agents/work-state-job.ts).
 */

const DAY = 86_400_000;
const WEEKDAYS = "日一二三四五六";
/** At most this many of each on the card (a Feishu form holds a few dozen elements); the rest are on the work page. */
export const TODAY_MAX = { pending: 3, lines: 6, next: 8, proposals: 4, candidates: 5, closed: 5, soon: 5, ended: 3, ends: 2, effects: 3 } as const;
const FIELDS_MAX = 30;

const kv = (app: App, key: string) => one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? null;
const setKv = (app: App, key: string, value: string) => run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, value);

/** “今天 · 11 月 21 日（周五）”. */
export function todayTitle(app: App, at = new Date()) {
  const p = zonedParts(at, app.config.timezone);
  return `今天 · ${p.month} 月 ${p.day} 日（周${WEEKDAYS[p.weekday] ?? ""}）`;
}
const md = (app: App, iso: string) => { const p = zonedParts(iso, app.config.timezone); return `${p.month} 月 ${p.day} 日`; };
const link = (app: App, text: string, path: string) => `[${text}](${webLink(app, path)})`;
const oneLine = (s: string, n: number) => truncate(s.replace(/\s+/g, " ").trim(), n);
const more = (n: number, where = "在工作页") => (n > 0 ? `还有 ${n} 条${where}。` : "");

type Built = { question: string; fields: UiField[]; context: Record<string, unknown> };

/** What waits on the owner, but not what this card asks itself. */
function waitingPart(app: App, pending: PendingAction[], skipAsks: Set<string>) {
  const list = pending.filter((p) => p.label !== "今天" && p.via !== "candidate" && !(p.askId && skipAsks.has(p.askId)));
  if (!list.length) return "";
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.label, (counts.get(p.label) ?? 0) + (p.count ?? 1));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const top = [...list].sort((a, b) => (a.deadline ?? "￿").localeCompare(b.deadline ?? "￿") || b.createdAt.localeCompare(a.createdAt)).slice(0, TODAY_MAX.pending);
  return [
    `**等你处理（${total}）**：${[...counts].map(([k, n]) => `${k} ${n}`).join("、")}`,
    ...top.map((p) => `- ${p.lineTitle ? `「${oneLine(p.lineTitle, 20)}」` : ""}${oneLine(p.title, 60)}${p.deadline ? `（${md(app, p.deadline)}前）` : ""}`),
    `${list.length > top.length ? `其余 ${list.length - top.length} 条` : "都"}${link(app, "在工作页处理", "#/work")}。`,
  ].join("\n");
}

/** The open lines: “截至今天”, what is due soon, the new next steps (fields). */
function linesPart(app: App, at: Date, userId: string, fields: UiField[]) {
  const steps = newNextSteps(app, userId);
  const byLine = new Map<string, typeof steps>();
  for (const s of steps) byLine.set(s.item_id, [...byLine.get(s.item_id) ?? [], s]);
  const ids = [...new Set([...openLines(app, userId).map((l) => l.id), ...byLine.keys()])];
  const soonEnd = at.getTime() + 3 * DAY;
  const shown: string[] = [], offered: string[] = [];
  let hidden = 0;
  for (const id of ids) {
    const line = getItem(app, id);
    if (isClosed(line.status) || line.status === "candidate") continue;
    const mine = byLine.get(id) ?? [];
    // A watched line comes up only when something new needs the owner.
    if (line.phase === "watching" && !mine.length) continue;
    const due = [line, ...descendantIds(app, id).map((c) => getItem(app, c))]
      .filter((i) => i.dueAt && !isClosed(i.status) && i.status !== "candidate" && Date.parse(i.dueAt) <= soonEnd)
      .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!));
    if (!line.now?.text && !mine.length && !due.length) continue;
    if (shown.length >= TODAY_MAX.lines) { hidden++; continue; }
    const room = Math.max(0, Math.min(TODAY_MAX.next - offered.length, FIELDS_MAX - fields.length));
    const take = mine.slice(0, room);
    for (const n of take) {
      offered.push(n.id);
      fields.push({ id: `n_${n.id}`, type: "choice", label: truncate(n.text, 200), required: false, options: [...NEXT_CHOICES], group: `「${truncate(line.title, 40)}」的下一步`, ...(n.why ? { help: truncate(n.why, 160) } : {}) });
    }
    shown.push([
      `**${line.title}**${line.phase === "watching" ? "（观察中）" : ""}${line.now?.text ? `：${oneLine(line.now.text, 90)}` : ""}`,
      due.length ? `- 快到期：${due.slice(0, 3).map((i) => `「${oneLine(i.title, 24)}」${Date.parse(i.dueAt!) < at.getTime() ? "已过期" : md(app, i.dueAt!)}`).join("、")}` : "",
      mine.length ? `- 新的下一步 ${mine.length} 条${mine.length > take.length ? `（${take.length} 条在下面，其余在线页上）` : "，在下面选"}` : "",
    ].filter(Boolean).join("\n"));
  }
  if (!shown.length) return { text: "", offered };
  return { text: [`**各条线**`, ...shown, hidden ? more(hidden, "线在工作页") : ""].filter(Boolean).join("\n\n"), offered };
}

/** What the night's work proposed, and what closed or closes by itself. */
function nightPart(app: App, at: Date, userId: string, fields: UiField[]) {
  const ctx: Record<string, unknown> = {};
  const lines: string[] = [];
  const room = (n: number) => Math.max(0, Math.min(n, FIELDS_MAX - fields.length));
  const label = (s: string) => truncate(s, 200);

  // Lines work-state proposed last night.
  const held = heldProposals(app, userId);
  if (held.runId && held.proposals.length) {
    const targets = mergeTargets(app, userId);
    const list = held.proposals.slice(0, room(TODAY_MAX.proposals));
    const title = (id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? "";
    for (const p of list) fields.push({ id: `p_${p.key}`, type: "choice", label: label(p.name), required: false, options: ["建", "不用", ...targets.map((t) => t.label)], group: "要建成工作线吗", help: truncate([p.goal, p.items.length ? `事项：${p.items.slice(0, 4).map((id) => `「${oneLine(title(id), 20)}」`).join("、")}${p.items.length > 4 ? ` 等 ${p.items.length} 件` : ""}` : "", p.sources.length ? `材料 ${p.sources.length} 份` : ""].filter(Boolean).join("；"), 300) });
    if (list.length) {
      ctx.proposals = { runId: held.runId, list, lines: targets };
      lines.push(`- 这几周你在推进的 ${held.proposals.length} 件事，要建成工作线吗：${list.map((p) => `「${oneLine(p.name, 24)}」`).join("、")}${more(held.proposals.length - list.length, "下次再问")}`);
    }
  }

  // Candidates the assistant made on its own.
  const cands = pendingCandidates(app, userId, 20);
  const candList = cands.slice(0, room(TODAY_MAX.candidates));
  for (const c of candList) {
    const why = autoInfo(app, c.id)?.why;
    fields.push({ id: `c_${c.id}`, type: "choice", label: label(c.title), required: false, options: ["留下", "不要"], group: "要不要跟", ...(why ? { help: oneLine(why, 160) } : {}) });
  }
  if (candList.length) { ctx.candidates = candList.map((c) => c.id); lines.push(`- 我建的 ${cands.length} 件候选，要不要跟${cands.length > candList.length ? `（${more(cands.length - candList.length)}）` : ""}`); }

  // What closed by itself, closes tomorrow, and the lines that ended.
  const d = digestFor(app, userId, at);
  if (d) {
    ctx.digest = true;
    const reason = (t: string) => oneLine(t.split("\n")[0].replace(/^(自动过期|推断已处理|推断不再需要|工作线自动结束)：/, "").replace(/。(有新进展会|不对的话).*$/, ""), 120);
    const closed = d.closed.filter((c) => !isLineEnded(c)), ended = d.closed.filter(isLineEnded);
    const c1 = closed.slice(0, room(TODAY_MAX.closed));
    for (const c of c1) fields.push({ id: `r_${c.id}`, type: "choice", label: label(c.title), required: false, options: ["恢复", "就这样"], group: "自动收尾的", help: reason(c.text) });
    const s1 = d.soon.slice(0, room(TODAY_MAX.soon));
    for (const s of s1) fields.push({ id: `k_${s.item.id}`, type: "choice", label: label(s.item.title), required: false, options: ["保留", "让它过期"], group: "明天会自动过期", help: s.expiry.text });
    const e1 = ended.slice(0, room(TODAY_MAX.ended));
    for (const c of e1) fields.push({ id: `r_${c.id}`, type: "choice", label: label(c.title), required: false, options: ["恢复", "就这样"], group: "自己结束了的工作线", help: reason(c.text) });
    ctx.reopen = [...c1, ...e1].map((c) => c.id);
    ctx.keep = s1.map((s) => s.item.id);
    const parts = [closed.length ? `自动收尾 ${closed.length} 件` : "", d.soon.length ? `明天过期 ${d.soon.length} 件` : "", ended.length ? `${ended.length} 条线自己结束了` : ""].filter(Boolean);
    const cut = closed.length - c1.length + d.soon.length - s1.length + ended.length - e1.length;
    if (parts.length) lines.push(`- ${parts.join("，")}：不用管就是这样，要留的选“恢复”或“保留”${cut > 0 ? `（${more(cut, "在事项页")}）` : ""}`);
  }

  // Line-end questions asked at night (today-time.ts holdForToday).
  const ends = all<{ id: string }>(app.db, `select id from asks where status = 'pending' and user_id = ? and json_extract(context, '$.handler') = 'line-end'
    and json_extract(context, '$.forToday') = 1 and json_extract(context, '$.sentAt') is null order by created_at limit ?`, userId, room(TODAY_MAX.ends));
  for (const { id } of ends) {
    const c = one<{ lineId: string | null; why: string | null }>(app.db, "select json_extract(context, '$.lineId') lineId, json_extract(context, '$.why') why from asks where id = ?", id);
    const t = one<{ title: string }>(app.db, "select title from items where id = ?", c?.lineId ?? "")?.title ?? "这条线";
    fields.push({ id: `e_${id}`, type: "choice", label: label(`「${t}」要结束吗`), required: false, options: [...LINE_END_CHOICES], group: "线要不要结束", ...(c?.why ? { help: oneLine(c.why, 200) } : {}) });
  }
  if (ends.length) { ctx.ends = ends.map((e) => e.id); lines.push(`- ${ends.length} 条线看起来差不多结束了，要结束吗`); }

  return { text: lines.length ? [`**夜里整理出来的**`, ...lines].join("\n") : "", ctx };
}

/** Last night's replay suggestions (agents/replay.ts), each 采纳 / 忽略. */
async function replayPart(app: App, fields: UiField[]) {
  const { replayDigest } = await import("../agents/replay.ts");
  const since = kv(app, "replay_digest_at") ?? new Date(Date.now() - DAY).toISOString();
  const r = replayDigest(app, since);
  const list = (r?.effects ?? []).slice(0, Math.max(0, Math.min(TODAY_MAX.effects, FIELDS_MAX - fields.length)));
  for (const e of list) fields.push({ id: `x_${e.id}`, type: "choice", label: truncate(e.label, 200), required: false, options: ["采纳", "忽略"], group: "昨晚复盘" });
  const n = r?.effects.length ?? 0;
  return { text: n ? `- 昨晚复盘有 ${n} 条建议要你定${n > list.length ? `（${more(n - list.length, "在 Agent 页")}）` : ""}` : "", effects: list.map((e) => e.id), ran: !!r };
}

/** The notifications waiting for their time of day (notify.ts releaseLater). */
function laterPart(app: App, userId: string) {
  const n = one<{ n: number }>(app.db, "select count(*) n from notifications where user_id = ? and read_at is null and json_extract(context, '$.held') = 1", userId)?.n ?? 0;
  return n ? `**不急的通知**：攒着 ${n} 条，到设好的时间一起发；现在想看就${link(app, "打开通知", "#/notifications")}。` : "";
}

/**
 * The card's text and fields for a person (the owner), or null when there is nothing to say. Reads only:
 * `markToday` records what it offered.
 */
export async function buildToday(app: App, at = new Date(), userId = OWNER): Promise<Built | null> {
  const fields: UiField[] = [];
  const lines = linesPart(app, at, userId, fields);
  const night = nightPart(app, at, userId, fields);
  const replay = userId === OWNER ? await replayPart(app, fields) : { text: "", effects: [], ran: false };
  const skip = new Set((night.ctx.ends as string[] | undefined) ?? []);
  const waiting = waitingPart(app, await pendingActions(app, userId), skip);
  const nightText = [night.text, replay.text && (night.text ? replay.text : `**夜里整理出来的**\n${replay.text}`)].filter(Boolean).join("\n");
  const later = laterPart(app, userId);
  const sections = [waiting, lines.text, nightText, later].filter(Boolean);
  // Held notifications alone are no reason for a card: they go out at their own times anyway.
  if (!waiting && !lines.text && !nightText) return null;
  return {
    question: [`**${todayTitle(app, at)}**`, ...sections, fields.length ? "下面能选的选了再提交，可以只选一部分；没选的照旧在工作页“需要你处理”和各条线上。" : ""].filter(Boolean).join("\n\n"),
    fields,
    context: { handler: "today", day: zonedParts(at, app.config.timezone).date, next: lines.offered, ...night.ctx, ...(replay.effects.length ? { effects: replay.effects } : {}), replayRan: replay.ran },
  };
}

/** What a sent card offered counts as offered: the next card starts after it. */
function markToday(app: App, built: Built, askId: string, at: Date, userId: string) {
  markNextShown(app, at);
  const p = built.context.proposals as { runId: string } | undefined;
  if (p?.runId) markProposalsOffered(app, p.runId);
  if (built.context.digest) markDigestSent(app, userId, at);
  if (built.context.replayRan) setKv(app, "replay_digest_at", at.toISOString());
  // The night's line-end questions are answered here; unanswered, they stay on the web, not sent later.
  for (const id of (built.context.ends as string[] | undefined) ?? [])
    run(app.db, "update asks set context = json_set(json_remove(context, '$.deferredUntil'), '$.inToday', ?) where id = ?", askId, id);
}

/**
 * Heartbeat: once a day at `notify.today.at`, the owner's card (one ask, `today`). Null when off, not
 * time yet, sent today already (kept by date, so a restart or another heartbeat does not send it again),
 * or nothing to say. In quiet hours the Feishu outlet holds it until they end (lark-asks.ts).
 */
export async function todayDue(app: App, at = new Date()): Promise<Ask | null> {
  if (!todayOn(app)) return null;
  const local = zonedParts(at, app.config.timezone);
  if (local.hour * 60 + local.minute < todayMinute(app) || kv(app, "today_card_day") === local.date) return null;
  setKv(app, "today_card_day", local.date);
  return sendToday(app, at, OWNER);
}

/** Heartbeat: 今天 at its time when on, else the next-step card of its own (lines.ts lineNextDue), as before. */
export async function morningDue(app: App, at = new Date()) {
  return todayOn(app) ? todayDue(app, at) : lineNextDue(app, at);
}

/** After the night's work-state run: its card of proposed lines when 今天 is off; on, they wait on the run for the morning. */
export function proposalsDue(app: App, runId: string) {
  return todayOn(app) ? null : linesCard(app, runId);
}

/** Put the card together and send it now (todayDue at its time; the demo data). */
export async function sendToday(app: App, at = new Date(), userId = OWNER): Promise<Ask | null> {
  const built = await buildToday(app, at, userId);
  if (!built) return null;
  // Yesterday's card nobody answered gives way: what it offered is still on the work page.
  for (const old of all<{ id: string }>(app.db, "select id from asks where status = 'pending' and user_id = ? and json_extract(context, '$.handler') = 'today'", userId))
    cancelAsk(app, old.id, "换成了新的一张“今天”");
  const ask = createAsk(app, {
    runId: null, conversationId: null, userId, allowText: false, question: built.question,
    // Nothing to choose: one button to put it away.
    options: built.fields.length ? [] : [{ label: "知道了" }],
    ui: built.fields.length ? { fields: built.fields, submitLabel: "提交选了的" } : null, context: built.context,
  });
  markToday(app, built, ask.id, at, userId);
  return ask;
}

/** What one card's answers did, in a line (shown on the answered card). */
async function settle(app: App, ask: Ask, ctx: Record<string, unknown>) {
  const v = ask.value ?? {};
  const by = ask.answeredBy ?? ask.userId;
  const done: Record<string, number> = {};
  const count = (k: string) => (done[k] = (done[k] ?? 0) + 1);
  const pick = (id: string) => (typeof v[id] === "string" ? (v[id] as string) : "");
  const tryOne = async (what: string, f: () => unknown) => {
    try { await f(); } catch (e) { console.warn(`[omem] 今天：${what}没办成：${(e as Error).message}`); }
  };
  for (const id of (ctx.next as string[] | undefined) ?? []) {
    const p = pick(`n_${id}`);
    if (!p) continue;
    const n = one<{ status: string }>(app.db, "select status from item_next where id = ?", id);
    if (n?.status !== "open") continue; // Decided on the line's page meanwhile.
    await tryOne("下一步", () => { decideNext(app, id, p === NEXT_CHOICES[0] ? "doing" : "declined", by); count(p === NEXT_CHOICES[0] ? "开始做" : "不用"); });
  }
  const props = ctx.proposals as { list: Proposal[]; lines: { id: string; label: string }[] } | undefined;
  for (const prop of props?.list ?? []) {
    const p = pick(`p_${prop.key}`);
    if (p) await tryOne("工作线提议", async () => { const r = await decideProposal(app, prop, p, props!.lines, ask.userId); if (r === "built") count("建了线"); else if (r === "merged") count("并进线"); });
  }
  for (const id of (ctx.candidates as string[] | undefined) ?? []) {
    const p = pick(`c_${id}`);
    if (!p || getItem(app, id).status !== "candidate") continue;
    await tryOne("候选", () => { decideCandidate(app, id, p === "留下", ask.userId, "card"); count(p === "留下" ? "留下" : "不要"); });
  }
  for (const id of (ctx.reopen as string[] | undefined) ?? []) {
    if (pick(`r_${id}`) !== "恢复" || !isClosed(getItem(app, id).status)) continue;
    await tryOne("恢复", () => { keepItem(app, id, "user"); count("恢复"); });
  }
  for (const id of (ctx.keep as string[] | undefined) ?? []) {
    if (pick(`k_${id}`) !== "保留" || isClosed(getItem(app, id).status)) continue;
    await tryOne("保留", () => { keepItem(app, id, "user"); count("保留"); });
  }
  for (const id of (ctx.ends as string[] | undefined) ?? []) {
    const i = (LINE_END_CHOICES as readonly string[]).indexOf(pick(`e_${id}`));
    if (i < 0 || getAsk(app, id).status !== "pending") continue;
    await tryOne("线要不要结束", async () => { await answerAsk(app, id, { choice: i, by }); count("答了线要不要结束"); });
  }
  if ((ctx.effects as string[] | undefined)?.length) {
    const { resolveEffect } = await import("../agents/replay.ts");
    for (const id of ctx.effects as string[]) {
      const p = pick(`x_${id}`);
      if (p) await tryOne("复盘建议", () => { if (resolveEffect(app, id, p === "采纳" ? "adopt" : "ignore").message !== "已经处理过了") count(p === "采纳" ? "采纳" : "忽略"); });
    }
  }
  const said = Object.entries(done).map(([k, n]) => `${k} ${n}`).join("，");
  run(app.db, "update asks set result = ? where id = ?", said ? `已处理：${said}` : "没有要改的", ask.id);
}

registerAskHandler("today", settle, (_app, ask, _ctx, by) => {
  if (by !== ask.userId) throw new HttpError(403, "只有本人能处理今天这张卡");
});
