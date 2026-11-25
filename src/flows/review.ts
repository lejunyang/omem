import { inlineId } from "./inline.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, localStamp, now, truncate } from "../core/util.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { createRun, registerHandler, runsInLane, runUser } from "../agents/runs.ts";
import { quietReason } from "../agents/quiet.ts";
import { getItem } from "../items/store.ts";
import { listFlows } from "./definitions.ts";
import { gateGrants, gateStreak } from "./gates.ts";
import type { StageState } from "./store.ts";

/**
 * What kind of step a row of item_stage_log is, where its states alone do not say. Written by the engine
 * (store.ts changeStage); rows from before the column existed are read through `inferEvent`.
 */
export type StageEvent =
  /** The stage itself was reopened: by the owner, an agent's stage_reopen, or a change the owner merged in. */
  | "reopen"
  /** An upstream stage was reopened after this one was done: it waits to be checked again. */
  | "stale"
  /** The owner said its result was not right yet: done again (or blocked after the third time). */
  | "refuse"
  /** The owner started a new round with words for it (engine.ts startRound): read as the owner's words, not a state change. */
  | "round-note"
  /** Done again by a stronger model (it ended without a result, or was unsure). */
  | "escalate"
  /** It went to gated: a confirm gate, the auto-advance limit, or the question whether it is needed at all. */
  | "gate-ask" | "limit-ask" | "when-ask"
  /** The owner let it start without remarks (what the gate ladder counts), with remarks, or after the limit asked. */
  | "gate-agree" | "gate-agree-note" | "limit-agree"
  /** 先别做. */
  | "gate-hold"
  /** Started without asking, under the owner's standing consent for this gate. */
  | "granted-start"
  /** An upstream stage was reopened while this one was being done: the owner was asked whether to stop it. */
  | "upstream-ask"
  /** The owner said stop (stale until the upstream is done), go on, or it finished before the owner answered (stale). */
  | "upstream-stop" | "upstream-continue" | "upstream-done"
  | "external-retry-wait" | "external-retry-exhausted"
  | "premature-start" | "owner-check-scheduled" | "owner-progress-question";

/** One row of item_stage_log, oldest first; `waitingOn` and `event` are null on rows written before they were kept. */
export type ReviewLogRow = { stageId: string; at: string; fromState: StageState | null; toState: StageState; actor: string; note: string; round: number; waitingOn?: string | null; event?: string | null };
/** A stage of the flow's definition: only these fields are read. */
export type ReviewStageDef = { id: string; name: string; gate?: string; fixed?: boolean; by?: unknown };

export type StageReview = {
  id: string;
  name: string;
  /** Where the stage stood at the end (its last row; pending when it has none). */
  state: StageState;
  /** First time it left pending (to gated or doing), and when it was last done or skipped if it ended that way. */
  enteredAt: string | null;
  doneAt: string | null;
  /** Minutes in each state, summed over every attempt and round (clipped to the window asked for). */
  doingMinutes: number;
  gatedMinutes: number;
  blockedMinutes: number;
  /**
   * Of those, the minutes it waited on the owner: all of gated, plus doing or blocked while `waiting_on`
   * was the owner. That includes a stage the owner carries (by: owner, it is the owner's turn) and a
   * result waiting for the owner's confirmation; a run or a 交办 at work is not waiting on the owner.
   */
  ownerMinutes: number;
  /** Each stretch it was blocked: when, how long, what it waited on and the reason given. */
  blocks: { at: string; minutes: number; waitingOn: string | null; note: string }[];
  /** Times it entered doing from another state: the first start, and each redo after a reopen, a refusal, an escalation or a stale re-check. */
  starts: number;
  /** Reopened itself; the owner refused its result; an upstream reopen made it stale (incl. the owner stopping it, or finishing against the old upstream); a stronger model redid it. */
  reopened: number;
  refused: number;
  staled: number;
  escalated: number;
  /** Rework the owner asked for on this stage: reopened + refused. */
  reworks: number;
  /** Ended skipped, and the reason the skip was given with. */
  skipped: boolean;
  skipNote: string | null;
  /** Ended done by the owner's after-the-fact record (补录). */
  recorded: boolean;
  /** Its start gate this time: how often each question was asked and answered. `direct`: asked at least once and every time let through with no remarks and no hold. */
  gate: { asked: number; limitAsked: number; whenAsked: number; agreed: number; agreedWithNote: number; limitAgreed: number; held: number; granted: number; direct: boolean };
  /** Rounds it took part in (repeating flows; 1 otherwise). */
  rounds: number;
};

const ROUND = /^开始第 \d+ 轮/;
/** The event of a row; for rows from before the column existed, read from its states and the engine's fixed notes. */
export function inferEvent(r: ReviewLogRow): StageEvent | null {
  if (r.event) return r.event as StageEvent;
  if (r.toState === "stale") return "stale";
  if (/^本人要求重做：|^三次仍未确认：/.test(r.note)) return "refuse";
  if (/^换上一档的模型重做/.test(r.note)) return "escalate";
  if (r.toState === "pending" && r.fromState && !["pending", "gated"].includes(r.fromState) && r.actor !== "host" && !ROUND.test(r.note)) return "reopen";
  if (r.toState === "gated" && r.fromState !== "gated") return r.note === "等本人判断这一段是否需要" ? "when-ask" : r.note === "等本人确认开始" ? "gate-ask" : null;
  if (r.fromState === "gated" && r.toState === "pending" && r.note === "本人同意开始") return "gate-agree";
  return null;
}
/** Whether a row's stretch waited on the owner; rows without `waitingOn` (written before it was kept) are inferred. */
function onOwner(r: ReviewLogRow, d: ReviewStageDef | undefined) {
  if (r.toState === "gated") return true;
  if (r.waitingOn) return r.waitingOn === "owner";
  return r.toState === "doing" && d?.by === "owner" || r.toState === "blocked" && r.actor === "host";
}

/**
 * Per-stage figures of one flow on one item, from its stage log alone (no database, no clock): how long
 * each stage was done, waited for the owner or was blocked, how often it was redone and how its gate
 * went. `log`: the rows of this flow (item_stage_log where at >= item_flows.started_at) in log order
 * (by id; rows of one stage written in the same millisecond keep that order); a row's state lasts until
 * the stage's next row, the last one until `until`. `from` / `until` clip the
 * minutes to a window (the rows themselves still count for starts, reworks and gates).
 */
export function reviewStages(input: { stages: ReviewStageDef[]; log: ReviewLogRow[]; until: string; from?: string }): StageReview[] {
  const end = Date.parse(input.until), start = input.from ? Date.parse(input.from) : -Infinity;
  const minutes = (a: number, b: number) => Math.max(0, Math.min(b, end) - Math.max(a, start)) / 60000;
  const ordered = input.log.map((r, i) => ({ r, i })).sort((a, b) => a.r.at.localeCompare(b.r.at) || a.i - b.i).map((x) => x.r);
  return input.stages.map((d) => {
    const rows = ordered.filter((r) => r.stageId === d.id);
    const out: StageReview = { id: d.id, name: d.name, state: rows.at(-1)?.toState ?? "pending", enteredAt: null, doneAt: null, doingMinutes: 0, gatedMinutes: 0, blockedMinutes: 0, ownerMinutes: 0, blocks: [], starts: 0, reopened: 0, refused: 0, staled: 0, escalated: 0, reworks: 0, skipped: false, skipNote: null, recorded: false,
      gate: { asked: 0, limitAsked: 0, whenAsked: 0, agreed: 0, agreedWithNote: 0, limitAgreed: 0, held: 0, granted: 0, direct: false }, rounds: new Set(rows.map((r) => r.round)).size || 1 };
    rows.forEach((r, i) => {
      const from = Date.parse(r.at), to = i + 1 < rows.length ? Date.parse(rows[i + 1].at) : end;
      const span = minutes(from, to), owner = onOwner(r, d);
      if (r.toState === "doing") out.doingMinutes += span;
      if (r.toState === "gated") out.gatedMinutes += span;
      if (r.toState === "blocked") {
        out.blockedMinutes += span;
        // Same-state rows (a reminder, a new note) continue the stretch the first one opened.
        if (r.fromState === "blocked" && out.blocks.length) out.blocks.at(-1)!.minutes += span;
        else out.blocks.push({ at: r.at, minutes: span, waitingOn: r.waitingOn ?? (owner ? "owner" : null), note: r.note });
      }
      if (owner && ["doing", "gated", "blocked"].includes(r.toState)) out.ownerMinutes += span;
      if (!out.enteredAt && ["gated", "doing", "blocked", "done", "skipped"].includes(r.toState) && r.fromState !== null) out.enteredAt = r.at;
      if (r.toState === "doing" && r.fromState !== "doing") out.starts++;
      switch (inferEvent(r)) {
        case "reopen": out.reopened++; break;
        case "refuse": out.refused++; break;
        case "stale": case "upstream-stop": case "upstream-done": out.staled++; break;
        case "escalate": out.escalated++; break;
        case "gate-ask": out.gate.asked++; break;
        case "limit-ask": out.gate.limitAsked++; break;
        case "when-ask": out.gate.whenAsked++; break;
        case "gate-agree": out.gate.agreed++; break;
        case "gate-agree-note": out.gate.agreedWithNote++; break;
        case "limit-agree": out.gate.limitAgreed++; break;
        case "gate-hold": out.gate.held++; break;
        case "granted-start": out.gate.granted++; break;
      }
    });
    const last = rows.at(-1);
    if (last && ["done", "skipped"].includes(last.toState)) {
      // The last change into done / skipped, not a later same-state note (the flow's end line).
      const settled = [...rows].reverse().find((r) => r.toState === last.toState && r.fromState !== last.toState) ?? last;
      out.doneAt = settled.at;
      out.skipped = last.toState === "skipped";
      out.skipNote = out.skipped ? settled.note : null;
      out.recorded = last.toState === "done" && settled.note.startsWith("补录：");
    }
    out.reworks = out.reopened + out.refused;
    out.gate.direct = out.gate.asked > 0 && out.gate.agreed === out.gate.asked && !out.gate.agreedWithNote && !out.gate.held;
    return out;
  });
}

export type FlowEnd = "completed" | "stopped" | "closed";
export type FlowReview = {
  itemId: string; title: string; flowId: string; flowName: string;
  how: FlowEnd; startedAt: string; endedAt: string; minutes: number; rounds: number;
  /** stageReviews, with what the gate ladder says now: consecutive direct agreements, and whether the owner lets it start by itself. */
  stages: (StageReview & { streak: number; grantedNow: boolean })[];
  /** The stage that waited on the owner longest, and the total rework the owner asked for. */
  longestOwnerWait: { stage: string; name: string; minutes: number } | null;
  reworks: number;
  /** What the follow-up found in the item's chats and documents during the flow, by type and by how it was settled. */
  changes: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
  /** Signals recorded for the item during the flow (device-local, kept thirty days), by type. */
  signals: Record<string, number>;
  templateSuggestion?: string;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
type LogDb = { stage_id: string; at: string; from_state: StageState | null; to_state: StageState; actor: string; note: string; round: number; waiting_on: string | null; event: string | null };
/** The stage log of the flow that started at `startedAt` on this item (later flows on the same item excluded). */
export function flowLog(app: App, itemId: string, startedAt: string, until?: string): ReviewLogRow[] {
  return all<LogDb>(app.db, `select stage_id,at,from_state,to_state,actor,note,round,waiting_on,event from item_stage_log where item_id=? and at>=?${until ? " and at<=?" : ""} order by at,id`, itemId, startedAt, ...(until ? [until] : []))
    .map((r) => ({ stageId: r.stage_id, at: r.at, fromState: r.from_state, toState: r.to_state, actor: r.actor, note: r.note, round: r.round, waitingOn: r.waiting_on, event: r.event }));
}
const countBy = (rows: { key: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.key, r.n]));

/** The review of an item's current flow, as of its end: computed from the records, no model. */
export function computeReview(app: App, itemId: string, how: FlowEnd): FlowReview | null {
  const f = one<{ flow_id: string; definition: string; started_at: string; ended_at: string | null; round: number }>(app.db, "select flow_id,definition,started_at,ended_at,round from item_flows where item_id=?", itemId);
  if (!f) return null;
  const item = getItem(app, itemId), definition = json<{ name: string; stages: ReviewStageDef[] }>(f.definition, { name: f.flow_id, stages: [] });
  const endedAt = f.ended_at ?? now();
  const stages = reviewStages({ stages: definition.stages, log: flowLog(app, itemId, f.started_at), until: endedAt });
  const granted = new Set(gateGrants(app, f.flow_id, item.userId).map((g) => g.stage));
  const longest = stages.filter((s) => s.ownerMinutes > 0).sort((a, b) => b.ownerMinutes - a.ownerMinutes)[0];
  const changes = all<{ type: string; status: string }>(app.db, "select type,status from item_changes where item_id=? and at>=? and at<=?", itemId, f.started_at, endedAt);
  const tally = (key: "type" | "status") => countBy([...new Set(changes.map((c) => c[key]))].map((k) => ({ key: k, n: changes.filter((c) => c[key] === k).length })));
  return {
    ...(how === "completed" && inlineId(f.flow_id) ? { templateSuggestion: "这次的阶段如果还会再用，可以存成模板。" } : {}),
    itemId, title: item.title, flowId: f.flow_id, flowName: definition.name, how, startedAt: f.started_at, endedAt,
    minutes: round1((Date.parse(endedAt) - Date.parse(f.started_at)) / 60000), rounds: f.round,
    stages: stages.map((s) => ({ ...s, doingMinutes: round1(s.doingMinutes), gatedMinutes: round1(s.gatedMinutes), blockedMinutes: round1(s.blockedMinutes), ownerMinutes: round1(s.ownerMinutes), blocks: s.blocks.map((b) => ({ ...b, minutes: round1(b.minutes), note: truncate(b.note, 300) })), skipNote: s.skipNote && truncate(s.skipNote, 300),
      streak: gateStreak(app, f.flow_id, s.id, item.userId), grantedNow: granted.has(s.id) })),
    longestOwnerWait: longest ? { stage: longest.id, name: longest.name, minutes: round1(longest.ownerMinutes) } : null,
    reworks: stages.reduce((n, s) => n + s.reworks, 0),
    changes: { total: changes.length, byType: tally("type"), byStatus: tally("status") },
    signals: countBy(all<{ key: string; n: number }>(app.db, "select type key,count(*) n from flow_signals where item_id=? and at>=? and at<=? group by type", itemId, f.started_at, endedAt)),
  };
}

/**
 * Keep the review of a flow that just ended (engine.ts end), then see whether its definition is due a
 * coach review. A flow reopened and ended again is reviewed again under the same key; one the coach
 * already read is not counted again.
 */
export function saveReview(app: App, itemId: string, how: FlowEnd) {
  const r = computeReview(app, itemId, how);
  if (!r) return null;
  const item = getItem(app, itemId);
  run(app.db, `insert into item_flow_reviews(item_id,started_at,flow_id,user_id,ended_at,how,review,updated_at) values(?,?,?,?,?,?,?,?)
    on conflict(item_id,started_at) do update set flow_id=excluded.flow_id,user_id=excluded.user_id,ended_at=excluded.ended_at,how=excluded.how,review=excluded.review,updated_at=excluded.updated_at`,
    itemId, r.startedAt, r.flowId, item.userId, r.endedAt, how, JSON.stringify(r), now());
  try { if (!inlineId(r.flowId)) coachIfDue(app, r.flowId, item.userId); } catch (e) { console.warn(`[omem] 流程复盘没有排上：${(e as Error).message}`); }
  return r;
}

type ReviewDb = { item_id: string; started_at: string; flow_id: string; user_id: string; ended_at: string; how: FlowEnd; review: string; coach_run: string | null };
/** The stored review of the flow that started at `startedAt` on this item, if it ended. */
export function storedReview(app: App, itemId: string, startedAt: string): FlowReview | null {
  const r = one<ReviewDb>(app.db, "select * from item_flow_reviews where item_id=? and started_at=?", itemId, startedAt);
  return r ? json<FlowReview | null>(r.review, null) : null;
}
/** Reviews this person may read, newest first: their own items in the spaces the run may read. */
export function listReviews(app: App, q: { userId: string; spaces?: string[] | null; flowId?: string; itemId?: string; limit?: number }) {
  const readable = scopeFor(app, q.userId, q.spaces ?? null);
  const rows = all<ReviewDb & { space_id: string }>(app.db, `select r.*,i.space_id from item_flow_reviews r join items i on i.id=r.item_id
    where r.user_id=?${q.flowId ? " and r.flow_id=?" : ""}${q.itemId ? " and r.item_id=?" : ""} order by r.ended_at desc limit 200`, q.userId, ...(q.flowId ? [q.flowId] : []), ...(q.itemId ? [q.itemId] : []));
  return rows.filter((r) => !readable || readable.includes(r.space_id)).slice(0, q.limit ?? 10).map((r) => ({ ...json<FlowReview>(r.review, {} as FlowReview), coachRun: r.coach_run }));
}

const MIN_REVIEWS = 3;
/**
 * A definition gets one coach run once three more of the owner's items have ended it since the coach last
 * read its reviews. A failed or cancelled run leaves them unread, so the next end tries again; one queued
 * or running is never doubled. Only the owner's items: only the owner may change a shared definition.
 */
export function coachIfDue(app: App, flowId: string, userId: string) {
  if (userId !== OWNER) return null;
  const lane = `flow-review:${flowId}`;
  if (runsInLane(app, lane).length) return null;
  const unread = all<{ item_id: string; started_at: string; space_id: string }>(app.db, `select r.item_id,r.started_at,i.space_id from item_flow_reviews r join items i on i.id=r.item_id left join runs x on x.id=r.coach_run
    where r.flow_id=? and r.user_id=? and (r.coach_run is null or x.id is null or x.status in ('failed','cancelled')) order by r.ended_at desc limit 10`, flowId, userId).reverse();
  if (unread.length < MIN_REVIEWS) return null;
  const name = listFlows(app).find((f) => f.id === flowId)?.definition?.name ?? flowId;
  const spaces = [...new Set(unread.map((r) => r.space_id))];
  const r = createRun(app, { kind: "flow-review", spaceId: spaces[0], title: `复盘流程「${name}」`, lane, userId, input: { flowId, spaces, reviews: unread.map((x) => ({ itemId: x.item_id, startedAt: x.started_at })) } });
  for (const x of unread) run(app.db, "update item_flow_reviews set coach_run=?,updated_at=? where item_id=? and started_at=?", r.id, now(), x.item_id, x.started_at);
  return r;
}

const HOW: Record<FlowEnd, string> = { completed: "走完了", stopped: "本人停止", closed: "事项关闭时结束" };
const mins = (n: number) => n < 1 ? "不到 1 分钟" : n < 120 ? `${Math.round(n)} 分钟` : n < 48 * 60 ? `${Math.round(n / 6) / 10} 小时` : `${Math.round(n / 144) / 10} 天`;
/** A review as lines a model (or a person) reads: one line per stage, only what is not zero. */
export function reviewText(r: FlowReview, timezone: string) {
  const stage = (s: FlowReview["stages"][number]) => {
    const parts = [
      s.skipped ? `跳过${s.skipNote ? `（${truncate(s.skipNote, 120)}）` : ""}` : s.recorded ? "补录" : s.state === "done" ? "完成" : `停在「${s.state}」`,
      s.doingMinutes ? `做了 ${mins(s.doingMinutes)}` : "", s.ownerMinutes ? `等本人 ${mins(s.ownerMinutes)}` : "",
      s.blocks.length ? `卡住 ${s.blocks.length} 次共 ${mins(s.blockedMinutes)}：${s.blocks.map((b) => `${truncate(b.note, 80)}（等${b.waitingOn === "owner" ? "本人" : b.waitingOn ?? "处理"}）`).join("；")}` : "",
      s.starts > 1 ? `开始了 ${s.starts} 次` : "", s.reopened ? `重开 ${s.reopened} 次` : "", s.refused ? `本人说还不行 ${s.refused} 次` : "", s.staled ? `因上游重开待复核 ${s.staled} 次` : "", s.escalated ? `升档重做 ${s.escalated} 次` : "",
      s.gate.asked ? `开始前问了 ${s.gate.asked} 次，直接同意 ${s.gate.agreed}${s.gate.agreedWithNote ? `、带意见 ${s.gate.agreedWithNote}` : ""}${s.gate.held ? `、先别做 ${s.gate.held}` : ""}` : "",
      s.gate.granted ? `按授权直接开始 ${s.gate.granted} 次` : "", s.streak ? `关卡已连续直接同意 ${s.streak} 次` : "", s.grantedNow ? "本人已授权以后直接开始" : "",
      s.gate.whenAsked ? `问过本人要不要做 ${s.gate.whenAsked} 次` : "", s.rounds > 1 ? `${s.rounds} 轮` : "",
    ].filter(Boolean);
    return `- ${s.name}（${s.id}）：${parts.join("，")}`;
  };
  return [
    `「${r.title}」（${r.itemId}）：${HOW[r.how]}；${localStamp(r.startedAt, timezone).slice(0, 16)} 开始，用了 ${mins(r.minutes)}${r.rounds > 1 ? `，${r.rounds} 轮` : ""}；本人要求返工 ${r.reworks} 次${r.longestOwnerWait ? `；等本人最久的是「${r.longestOwnerWait.name}」${mins(r.longestOwnerWait.minutes)}` : ""}`,
    ...r.stages.map(stage),
    r.templateSuggestion ?? "",
    r.changes.total ? `跟进记下的变化 ${r.changes.total} 条：${Object.entries(r.changes.byType).map(([k, n]) => `${k} ${n}`).join("、")}；处理：${Object.entries(r.changes.byStatus).map(([k, n]) => `${k} ${n}`).join("、")}` : "",
  ].filter(Boolean).join("\n");
}

registerHandler("flow-review", async (ctx) => {
  const { flowId, reviews, spaces } = ctx.run.input as { flowId: string; reviews: { itemId: string; startedAt: string }[]; spaces: string[] };
  const file = listFlows(ctx.app).find((f) => f.id === flowId);
  if (!file?.definition) return { quiet: true, summary: `流程 ${flowId} 已删除或读不了，不复盘` };
  const found = reviews.flatMap((r) => storedReview(ctx.app, r.itemId, r.startedAt) ?? []);
  const userId = runUser(ctx.app, ctx.run.id);
  const granted = gateGrants(ctx.app, flowId, userId);
  const task = [
    `# 复盘一份流程定义\n\n流程「${file.definition.name}」（id: ${flowId}）最近又有 ${found.length} 件事结束了。下面是宿主按记录算出来的回顾（不是模型写的），和这份定义现在的原文。`,
    `## 现在的定义\n\n\`\`\`yaml\n${file.raw.trim()}\n\`\`\``,
    granted.length ? `## 本人已授权直接开始的关卡\n\n${granted.map((g) => `- ${g.stage}（${g.grantedAt.slice(0, 10)} 起）`).join("\n")}` : "",
    `## 这几件事的回顾\n\n${found.map((r, i) => `### ${i + 1}. ${reviewText(r, ctx.app.config.timezone)}`).join("\n\n")}`,
    `更早的回顾用 read_flow_reviews(flow="${flowId}") 读；某一段具体怎么走的，用 read_item 看那件事的流程经过。`,
    `## 要交的\n\n只有在几件事里反复出现、能指出是哪几件的问题，才用 save_flow 交一份改过的完整 YAML（id 保持 ${flowId}，其余没问题的地方原样保留），它会变成等本人点“启用”的草稿，不直接生效。没有站得住的修改就调用 stay_quiet 写一句原因。结尾两三行写：提了什么、依据是哪几件事的哪几项。`,
  ].filter(Boolean).join("\n\n");
  const { runRole } = await import("../agents/runner.ts");
  const result = await runRole(ctx.app, { role: "coach", spaceId: ctx.run.spaceId ?? spaces[0] ?? "personal", spaces, task, runId: ctx.run.id, userId, signal: ctx.signal,
    denyTools: ["remember", "supersede", "forget", "propose_profile_change", "propose_repo_lesson", "revise_reply_outcome"], onEvent: (e) => ctx.event(e.type, e) });
  run(ctx.app.db, "update runs set profile_id=? where id=?", result.profileId, ctx.run.id);
  const reason = quietReason(ctx.app, ctx.run.id);
  return { quiet: !!reason, summary: result.text.trim() || reason || "" };
});
