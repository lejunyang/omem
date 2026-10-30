import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { allProfiles, DEFAULT_REPLAY_PLAN, REPLAY_AXES, type AgentProfile, type ReplayAxis, type ReplaySignal } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { relatedIds } from "../core/spaces.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { CORRECTION, NOT_FOUND } from "../memory/gaps.ts";
import { passiveBlock, passiveRecall } from "../memory/passive.ts";
import { search } from "../search/search.ts";
import { LEVELS, levelSql, setAttention, type Level } from "../sources/attention.ts";
import { upsertItem } from "../items/store.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { backendAvailable } from "./availability.ts";
import { sourceOf } from "./capacity.ts";
import { runBackend } from "./dispatch.ts";
import { normalizeModel } from "./models.ts";
import { jsonIn } from "./oneshot.ts";
import { READ_ONLY_TOOLS } from "./peer-agent.ts";
import { cachedProbe, effortsFor } from "./probe.ts";
import { filterHits, TIME_CUT_KINDS, visibleLines, visibleMemories, type RunView } from "./replay-view.ts";
import { lessonIdsForTask, loadRole, resolveRunProfile, runRole } from "./runner.ts";
import { addRunEvent, createRun, flushRunText, registerHandler, setRunOutput, type RunContext } from "./runs.ts";
import { findAgentSpec, listAgentSpecs, type AgentSpec } from "./specs.ts";
import { replyOf, type AgentEvent } from "./types.ts";

/**
 * Nightly replay (docs/v2/replay.md): a past question is answered again as of the time it was asked,
 * twice — a baseline re-run with the profile and settings unchanged, and a variant that changes one
 * axis (how information gets in: retrieval, source levels, memories, the Wiki; or the model). Both
 * arms are ordinary runs that only read (replay-view.ts decides what they see); deterministic checks
 * come first, then a blind judge (the built-in role replay-judge, on the AI the owner chose for it)
 * in both orders, agreeing or it is a tie. What a result says goes into replay_effects: memory
 * re-review, helped counts and wiki checks happen by themselves; source levels, rules and imports are
 * suggestions the owner adopts or ignores on the morning card. The host never switches models: the
 * A axis only adds evidence to list_ai_backends (`replay28d`).
 */

/** What a replay arm may use: the read-only tools minus those that read runs (the original answer, the owner's correction). */
export const REPLAY_TOOLS = [...[...READ_ONLY_TOOLS].filter((t) => t !== "list_runs" && t !== "read_run"), "list_skills", "read_skill"];
const PAGE_TOOLS = ["list_pages", "read_page"];
/** Turns of the conversation before the question an arm is shown. */
const CONTEXT_TURNS = 8;
/** An arm that takes longer than this is stopped (each arm is otherwise an ordinary run, idle timeout included). */
const ARM_MINUTES = 30;
/** Times a night's replay waits for a running bulk digest before it gives up. */
const DEFER_TRIES = 6;
const DEFER_MINUTES = 20;
/** M2 (no memories at all) at most this often a week: it says little per run and costs a whole run. */
const M2_PER_WEEK = 2;
const TIMEOUT = /无活动|没有开始回答|没有任何进展|空闲超时|idle|timed? ?out|超时|no response|无响应/i;

export const AXIS_LABEL: Record<ReplayAxis, string> = {
  R1: "深检索（先列说法、scan 穷举）",
  R2: "加上相关和可访问的空间",
  R3: "交给研究档案",
  S1: "只看重点和仅检索的原件",
  S2: "连忽略的原件一起看",
  M1: "去掉原运行碰过的记忆",
  M2: "不带任何记忆",
  M3: "去掉存量整理写的经验",
  W1: "不看 Wiki 页面",
  W2: "先读 Wiki 页面",
  A1: "模型降一档",
  A2: "模型升一档",
};
export const SIGNAL_LABEL: Record<ReplaySignal | "manual", string> = {
  negative: "负面表情",
  correction: "本人纠正",
  notFound: "回答说没找到",
  timeout: "超时失败",
  slow: "慢",
  normal: "正常完成",
  positive: "正面表情（对照）",
  manual: "手动",
};
export const VERDICT_LABEL: Record<string, string> = { win: "变体胜", loss: "基线胜", tie: "持平", void: "作废（泄题）", failed: "没跑完" };
/** Which question matters more when there are more than `replay.max`. */
const SIGNAL_RANK: Record<ReplaySignal, number> = { negative: 0, correction: 1, notFound: 2, timeout: 3, positive: 4, slow: 5, normal: 6 };

// ------------------------------------------------------------------ the judge

export const JUDGE_NOT_CHOSEN = "先给 replay-judge 选模型：在 Agent 页打开内置角色 replay-judge 设置默认 AI；没选之前夜间复盘不运行。";

/** The AI the owner chose for replay-judge; nothing is assumed when there is no choice. */
export function judgeChoice(app: App): { chosen: boolean; profile?: AgentProfile; error?: string } {
  const agent = app.config.agents.roles["replay-judge"];
  const byBackend = app.config.agents.roleModels["replay-judge"] ?? {};
  if (!agent && !Object.values(byBackend).some((m) => m.model)) return { chosen: false };
  try {
    const profile = resolveRunProfile(app, { actor: { role: "replay-judge" } });
    if (!backendAvailable(profile, app.home)) return { chosen: true, profile, error: `replay-judge 选的后端 ${profile.id} 现在不可用` };
    return { chosen: true, profile };
  } catch (e) {
    return { chosen: true, error: (e as Error).message };
  }
}

const family = (p: { id: string; model?: string | null }) => normalizeModel(p.model ?? "").split(/[-.\d]/).find(Boolean) ?? "";
/** Judge and arm on the same backend account or model family: allowed, but the owner is told (a model favours its own style). */
export function sameFamily(app: App, a: AgentProfile, b: { id: string; model?: string | null }) {
  const pb = allProfiles(app.config).find((p) => p.id === b.id);
  if (a.id === b.id) return true;
  if (pb && sourceOf(a) === sourceOf(pb)) return true;
  const fa = family(a);
  return !!fa && fa === family(b);
}

// ------------------------------------------------------------------ questions

type RunRow = { id: string; kind: string; space_id: string | null; status: string; input: string; output: string; ai: string | null; error: string | null; created_at: string; started_at: string | null; finished_at: string | null };
export type Question = {
  run: RunRow;
  kind: "ask" | "agent";
  spec: string | null;
  spaceId: string;
  asOf: string;
  question: string;
  answer: string;
  /** The conversation before the question (ask runs). */
  context: string;
  conversationId: string | null;
  /** What the owner did afterwards: the next words, emoji. */
  reaction: { said?: string; emoji: string[] };
};

/** A past run as a question to replay; null when it is not one (a wake-up, a coordination turn, a group batch…). */
export function questionOf(app: App, r: RunRow): Question | null {
  const input = json<Record<string, any>>(r.input, {});
  const output = json<Record<string, any>>(r.output, {});
  if (input.coordinate || input.wake || input.handoff || input.consultOf !== undefined || input.silent || input.meeting) return null;
  const emoji = all<{ emoji: string }>(app.db, "select emoji from feedback where run_id = ? and removed_at is null and on_bot = 1 and actor_kind != 'bot'", r.id).map((x) => x.emoji);
  if (r.kind === "ask") {
    const ids: string[] = input.messageIds ?? (input.messageId ? [input.messageId] : []);
    if (!ids.length || !input.conversationId) return null;
    const msgs = all<{ id: string; text: string; meta: string; created_at: string }>(app.db, "select id, text, meta, created_at from messages where id in (select value from json_each(?)) order by created_at", JSON.stringify(ids));
    if (!msgs.length || msgs.some((m) => { const meta = json<Record<string, unknown>>(m.meta, {}); return typeof meta.speaker === "string" || !!meta.wake || !!meta.command; })) return null;
    const asOf = msgs[0].created_at;
    const before = all<{ role: string; text: string; created_at: string }>(
      app.db,
      "select * from (select role, text, created_at from messages where conversation_id = ? and created_at < ? and json_extract(meta, '$.command') is null order by created_at desc limit ?) order by created_at",
      input.conversationId,
      asOf,
      CONTEXT_TURNS * 2,
    );
    const answer = String(output.answer ?? one<{ text: string }>(app.db, "select text from messages where run_id = ? and role = 'assistant' order by created_at desc limit 1", r.id)?.text ?? "");
    const after = r.finished_at ? one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and role = 'user' and created_at >= ? and created_at < ? and json_extract(meta, '$.command') is null order by created_at limit 1", input.conversationId, r.finished_at, new Date(Date.parse(r.finished_at) + 6 * 3600_000).toISOString())?.text : undefined;
    return {
      run: r, kind: "ask", spec: null, spaceId: r.space_id ?? "personal", asOf,
      question: msgs.map((m) => m.text).join("\n"), answer, conversationId: input.conversationId,
      context: before.map((m) => `${m.role === "user" ? "本人" : "助理"}（${m.created_at.slice(0, 16).replace("T", " ")}）：${truncate(m.text.replace(/\s+/g, " "), 1500)}`).join("\n"),
      reaction: { said: after, emoji },
    };
  }
  if (r.kind === "agent") {
    if (!input.spec || input.spec === "assistant" || typeof input.task !== "string") return null;
    return { run: r, kind: "agent", spec: input.spec, spaceId: r.space_id ?? "personal", asOf: r.created_at, question: input.task, answer: String(output.answer ?? ""), context: "", conversationId: input.threadId ?? null, reaction: { emoji } };
  }
  return null;
}

/** How long a kind of run usually takes (p75 of the last 14 days, at least 8 runs). */
function p75(app: App, kind: string): number | null {
  const ms = all<{ ms: number }>(app.db, "select (julianday(finished_at) - julianday(started_at)) * 86400000 ms from runs where kind = ? and status = 'done' and started_at is not null and finished_at > ?", kind, new Date(Date.now() - 14 * 86400_000).toISOString()).map((r) => r.ms).sort((a, b) => a - b);
  return ms.length >= 8 ? ms[Math.floor(ms.length * 0.75)] : null;
}

/** The strongest signal a run shows, or null when there is nothing to replay (a failure that is a bug). */
export function signalOf(app: App, q: Question, slowAfter: number | null): ReplaySignal | null {
  const pol = all<{ polarity: string }>(app.db, "select polarity from feedback where run_id = ? and removed_at is null and on_bot = 1 and actor_kind != 'bot'", q.run.id).map((x) => x.polarity);
  if (pol.includes("negative")) return "negative";
  if (q.reaction.said && CORRECTION.test(q.reaction.said)) return "correction";
  if (q.run.status === "failed") return TIMEOUT.test(q.run.error ?? "") ? "timeout" : null;
  if (!q.answer.trim()) return null;
  if (NOT_FOUND.test(q.answer.slice(0, 600))) return "notFound";
  if (pol.includes("positive")) return "positive";
  const ms = q.run.started_at && q.run.finished_at ? Date.parse(q.run.finished_at) - Date.parse(q.run.started_at) : 0;
  if (slowAfter && ms > slowAfter) return "slow";
  return "normal";
}

// ------------------------------------------------------------------ what the original run touched

export type Touched = { memories: string[]; sources: string[]; pages: string[] };
const toolName = (title: string) => title.replace(/^mcp__\w+?__/, "").replace(/^omem[._ ·:]+/i, "").split(/[\s(:：]/)[0];

/**
 * What a run touched, from what it left: memories recall and passive recall gave it (memory_recalls),
 * the memories, sources and pages its tool calls named (run_events tool events: name and arguments),
 * and the mem:/src: references of its answer. Axes that need one of these are not chosen without it.
 */
export function touchedBy(app: App, runId: string, answer: string): Touched {
  const memories = new Set(all<{ memory_id: string }>(app.db, "select distinct memory_id from memory_recalls where run_id = ?", runId).map((r) => r.memory_id));
  const sources = new Set<string>();
  const pages = new Set<string>();
  for (const e of all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type in ('tool', 'tool-write')", runId)) {
    const d = json<{ title?: string; name?: string; input?: Record<string, unknown>; args?: Record<string, unknown> }>(e.data, {});
    let name = d.name ?? toolName(d.title ?? "");
    let args = (d.input ?? d.args ?? {}) as Record<string, unknown>;
    if (name === "omem_call" && typeof args.tool === "string") [name, args] = [args.tool, (args.args ?? {}) as Record<string, unknown>];
    const src = typeof args.source === "string" ? args.source : null;
    if (name === "read_source" && src) {
      if (src.startsWith("mem:")) memories.add(src.slice(4));
      else if (!src.startsWith("msg:")) sources.add(src.replace(/^src:/, "").replace(/#.*$/, ""));
    }
    if (name === "read_page" && typeof args.page === "string") pages.add(args.space ? `${args.space}/${args.page}` : args.page);
  }
  for (const m of answer.matchAll(/mem:(m[0-9a-z]{8,})/g)) memories.add(m[1]);
  for (const m of answer.matchAll(/src:([\w-]+)/g)) sources.add(m[1]);
  const known = new Set(all<{ id: string }>(app.db, "select id from sources where id in (select value from json_each(?))", JSON.stringify([...sources].map((s) => canonicalSourceId(app, s)))).map((r) => r.id));
  return { memories: [...memories], sources: [...sources].map((s) => canonicalSourceId(app, s)).filter((s) => known.has(s)), pages: [...pages] };
}

// ------------------------------------------------------------------ precheck and axis

/** Where the question's words land, as of its time (no model): the run's spaces, ignored sources, other spaces, pages. */
export type Precheck = { own: number; ignored: number; other: number; pages: number };

export async function precheck(app: App, q: Question): Promise<Precheck> {
  const base = new Set([q.spaceId, ...relatedIds(app, q.spaceId)]);
  const view: RunView = { asOf: q.asOf, sourceLevels: [...LEVELS] };
  const hits = filterHits(app, view, await search(app, q.question.slice(0, 500), { spaces: scopeFor(app, OWNER, null) ?? undefined, includeIgnored: true, limit: 30 }).catch(() => []));
  const out: Precheck = { own: 0, ignored: 0, other: 0, pages: 0 };
  for (const h of hits) {
    if (h.type === "page") {
      if (base.has(h.spaceId)) out.pages++;
      continue;
    }
    if (!base.has(h.spaceId)) out.other++;
    else if (h.attention === "ignore") out.ignored++;
    else out.own++;
  }
  return out;
}

/** The research profiles (frontmatter `traits: [research]`): the host goes by the trait, never by a name. */
export function researchProfiles(app: App): AgentSpec[] {
  return listAgentSpecs(app).filter((s) => s.traits?.includes("research"));
}

/** A source's effective level (its own or its folder's). */
const levelOf = (app: App, id: string) => one<{ level: string | null }>(app.db, `select ${levelSql("s")} level from sources s where s.id = ?`, id)?.level ?? "normal";

type AI = { profile: string; model?: string; effort?: string };
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

/** One step down (-1) or up (+1) from `base`: the owner's ladder (replay.models) when it lists it, else the effort level on the same model. */
export function modelStep(app: App, base: AI, dir: -1 | 1): AI | null {
  const ladder = app.config.replay.models;
  const fit = (l: AI) => l.profile === base.profile && (!l.model || l.model === base.model) && (!l.effort || l.effort === base.effort);
  const i = ladder.reduce((best, l, k) => (fit(l) && (best < 0 || (l.model ? 1 : 0) + (l.effort ? 1 : 0) > (ladder[best].model ? 1 : 0) + (ladder[best].effort ? 1 : 0)) ? k : best), -1);
  if (i >= 0) {
    const next = ladder[i + dir];
    return next ? { profile: next.profile, model: next.model, effort: next.effort } : null;
  }
  if (!base.effort) return null;
  const offered = effortsFor(cachedProbe(app, base.profile), base.model);
  const levels = offered.length ? offered : EFFORTS;
  const k = levels.indexOf(base.effort);
  const next = k >= 0 ? levels[k + dir] : undefined;
  return next ? { ...base, effort: next } : null;
}

/** The AI the original run used (what the baseline re-runs on). */
export function baseAI(app: App, q: Question): AI {
  const ai = json<AI | null>(q.run.ai, null);
  if (ai?.profile && allProfiles(app.config).some((p) => p.id === ai.profile && backendAvailable(p, app.home))) return ai;
  const spec = q.spec ? findAgentSpec(app, q.spec) : null;
  const p = resolveRunProfile(app, { actor: spec ? { spec } : { role: "assistant" } });
  return { profile: p.id, model: p.model, effort: p.effort };
}

export type AxisContext = { q: Question; signal: ReplaySignal; touched: Touched; pre: Precheck; tried: Set<string> };

/** Whether an axis can say anything about this question. */
export function axisApplies(app: App, axis: ReplayAxis, c: AxisContext): boolean {
  const { pre, touched, signal } = c;
  const notFound = signal === "notFound";
  switch (axis) {
    case "R1": return !notFound || pre.own > 0;
    case "R2": return pre.other > 0 && (!notFound || (pre.own === 0 && pre.ignored === 0));
    case "R3": return researchProfiles(app).length > 0 && (!notFound || pre.own + pre.ignored + pre.other === 0);
    case "S1": return touched.sources.some((s) => ["normal", "ignore"].includes(levelOf(app, s)));
    case "S2": return pre.ignored > 0 && (!notFound || pre.own === 0);
    case "M1": return touched.memories.length > 0;
    case "M2": return !!one(app.db, "select 1 from memories where status = 'active' limit 1") && (one<{ n: number }>(app.db, "select count(*) n from replays where axis = 'M2' and at > ?", new Date(Date.now() - 7 * 86400_000).toISOString())?.n ?? 0) < M2_PER_WEEK;
    case "M3": return !!one(app.db, "select 1 from memories m where m.status = 'active' and m.kind = 'experience' and m.run_id in (select id from runs where kind in ('digest', 'triage')) limit 1");
    case "W1": return touched.pages.length > 0;
    case "W2": return pre.pages > 0 && !touched.pages.length;
    case "A1": return !!modelStep(app, baseAI(app, c.q), -1);
    case "A2": return !!modelStep(app, baseAI(app, c.q), 1);
  }
}

/** The plan's first axis for the signal that applies and was not tried on this question; `random` picks any. */
export function chooseAxis(app: App, c: AxisContext): ReplayAxis | null {
  const plan = app.config.replay.plan[c.signal] ?? DEFAULT_REPLAY_PLAN[c.signal];
  for (const a of plan) {
    if (a === "random") {
      const open = REPLAY_AXES.filter((x) => !c.tried.has(x) && axisApplies(app, x, c));
      if (open.length) return open[Math.floor(Math.random() * open.length)];
      continue;
    }
    if (!c.tried.has(a) && axisApplies(app, a, c)) return a;
  }
  return null;
}

const triedOn = (app: App, runId: string) => new Set(all<{ axis: string }>(app.db, "select axis from replays where base_run_id = ? and status != 'failed'", runId).map((r) => r.axis));

export type Pick = { runId: string; signal: ReplaySignal; axis: ReplayAxis; question: string };

/**
 * Tonight's questions (at most replay.max): asks and profile runs of the last `replay.days`, by the
 * strength of their signal (negative emoji, the owner correcting, "not found", timeouts, one positive
 * as a control, slow, normal), each with the plan's first applicable axis. With two or more a night,
 * one is kept for a model step down when any run allows it: that is where routing evidence comes from.
 */
export async function selectQuestions(app: App, opts: { max?: number; now?: Date } = {}): Promise<Pick[]> {
  const max = opts.max ?? app.config.replay.max;
  const since = new Date((opts.now ?? new Date()).getTime() - app.config.replay.days * 86400_000).toISOString();
  const rows = all<RunRow>(
    app.db,
    `select id, kind, space_id, status, input, output, ai, error, created_at, started_at, finished_at from runs
      where kind in ('ask', 'agent') and status in ('done', 'failed') and quiet = 0 and created_at > ? and coalesce(user_id, 'owner') = 'owner'
      order by created_at desc limit 300`,
    since,
  );
  const slow = new Map<string, number | null>();
  const ranked: (AxisContext & { rank: number })[] = [];
  for (const r of rows) {
    const q = questionOf(app, r);
    if (!q || (q.spec && !findAgentSpec(app, q.spec))) continue;
    if (!slow.has(r.kind)) slow.set(r.kind, p75(app, r.kind));
    const signal = signalOf(app, q, slow.get(r.kind) ?? null);
    if (!signal) continue;
    ranked.push({ q, signal, touched: touchedBy(app, r.id, q.answer), pre: { own: 0, ignored: 0, other: 0, pages: 0 }, tried: triedOn(app, r.id), rank: SIGNAL_RANK[signal] });
  }
  ranked.sort((a, b) => a.rank - b.rank || b.q.asOf.localeCompare(a.q.asOf));
  const picks: Pick[] = [];
  let positives = 0;
  const take = async (c: AxisContext) => {
    if (c.signal === "notFound" || c.signal === "positive") c.pre = await precheck(app, c.q);
    else c.pre = { own: 0, ignored: 0, other: 0, pages: await precheck(app, c.q).then((p) => p.pages) };
    const axis = chooseAxis(app, c);
    return axis ? { runId: c.q.run.id, signal: c.signal, axis, question: truncate(c.q.question.replace(/\s+/g, " "), 200) } : null;
  };
  for (const c of ranked) {
    if (picks.length >= max) break;
    if (c.signal === "positive" && positives >= 1) continue;
    const p = await take(c);
    if (!p) continue;
    if (p.signal === "positive") positives++;
    picks.push(p);
  }
  if (max >= 2 && picks.length && !picks.some((p) => p.axis === "A1")) {
    for (const c of ranked.filter((x) => (x.signal === "normal" || x.signal === "slow") && !picks.some((p) => p.runId === x.q.run.id))) {
      if (c.tried.has("A1") || !axisApplies(app, "A1", c)) continue;
      const p = { runId: c.q.run.id, signal: c.signal, axis: "A1" as const, question: truncate(c.q.question.replace(/\s+/g, " "), 200) };
      if (picks.length >= max) picks[picks.length - 1] = p;
      else picks.push(p);
      break;
    }
  }
  return picks;
}

// ------------------------------------------------------------------ deterministic checks

export type Cite = { ref: string; ok: boolean; text?: string; problem?: string };
export type ArmCheck = { ok: boolean; problems: string[]; leaks: string[]; cites: Cite[]; notFound: boolean };

/**
 * Checks that need no model: every src:/mem:/msg: reference resolves, line numbers are in range,
 * nothing cited came after the question (that is a leak: the question is void), an empty or failed
 * answer fails. `other`: when this arm says it found nothing while the other cites lines that exist,
 * this one fails.
 */
export function checkArm(app: App, asOf: string, answer: string, failed: string | null): ArmCheck {
  const problems: string[] = [];
  const leaks: string[] = [];
  const cites: Cite[] = [];
  if (failed) problems.push(`运行失败：${truncate(failed, 160)}`);
  else if (!answer.trim()) problems.push("没有给出回答");
  const view: RunView = { asOf, cache: new Map() };
  for (const m of answer.matchAll(/src:([\w-]+)(?:#L(\d+)(?:-L?(\d+))?)?/g)) {
    const ref = m[0];
    if (cites.some((c) => c.ref === ref)) continue;
    const id = canonicalSourceId(app, m[1]);
    const s = one<{ id: string; kind: string; text: string; captured_at: string; deleted_at: string | null }>(app.db, "select id, kind, text, captured_at, deleted_at from sources where id = ?", id);
    if (!s || s.deleted_at) {
      cites.push({ ref, ok: false, problem: "找不到" });
      problems.push(`引用的原件不存在：${ref}`);
      continue;
    }
    const lines = s.text.split("\n");
    const from = m[2] ? Number(m[2]) : 1;
    const to = m[3] ? Number(m[3]) : m[2] ? from : Math.min(lines.length, 6);
    if (from < 1 || to < from || to > lines.length) {
      cites.push({ ref, ok: false, problem: `行号越界（共 ${lines.length} 行）` });
      problems.push(`行号越界：${ref}（共 ${lines.length} 行）`);
      continue;
    }
    if (s.captured_at > asOf) {
      leaks.push(`${ref} 在提问之后才收进来`);
      cites.push({ ref, ok: false, problem: "提问之后才有" });
      continue;
    }
    if (TIME_CUT_KINDS.has(s.kind)) {
      const vis = visibleLines(app, view, s.id, s.text);
      if (!lines.slice(from - 1, to).some((_, k) => vis[from - 1 + k])) {
        leaks.push(`${ref} 引用的是提问之后的聊天`);
        cites.push({ ref, ok: false, problem: "提问之后的内容" });
        continue;
      }
    }
    cites.push({ ref, ok: true, text: truncate(lines.slice(from - 1, Math.min(to, from + 5)).join("\n"), 400) });
  }
  for (const m of answer.matchAll(/mem:(m[0-9a-z]{8,})/g)) {
    const ref = m[0];
    if (cites.some((c) => c.ref === ref)) continue;
    const mem = one<{ content: string; created_at: string }>(app.db, "select content, created_at from memories where id = ?", m[1]);
    if (!mem) {
      cites.push({ ref, ok: false, problem: "找不到" });
      problems.push(`引用的记忆不存在：${ref}`);
    } else if (mem.created_at > asOf) {
      leaks.push(`${ref} 是提问之后写的记忆`);
      cites.push({ ref, ok: false, problem: "提问之后写的" });
    } else cites.push({ ref, ok: true, text: truncate(mem.content.replace(/\n（撤回原因：[\s\S]*$/, ""), 300) });
  }
  for (const m of answer.matchAll(/msg:(msg[0-9a-z]{6,})/g)) {
    const msg = one<{ created_at: string }>(app.db, "select created_at from messages where id = ?", m[1]);
    if (msg && msg.created_at >= asOf) leaks.push(`${m[0]} 是提问之后的消息`);
  }
  return { ok: !problems.length && !leaks.length, problems, leaks, cites, notFound: NOT_FOUND.test(answer.slice(0, 600)) };
}

/** “Not found” while the other arm cites lines that exist: this arm missed material that was there. */
export function crossCheck(a: ArmCheck, b: ArmCheck) {
  for (const [x, y] of [[a, b], [b, a]] as const)
    if (x.notFound && !x.problems.length && y.cites.some((c) => c.ok && c.ref.startsWith("src:"))) {
      x.problems.push(`说没找到，但另一份回答引用的原文存在（${y.cites.find((c) => c.ok && c.ref.startsWith("src:"))!.ref}）`);
      x.ok = false;
    }
}

// ------------------------------------------------------------------ arms

/** A child run of the replay, run right here (not through the queue, which the replay itself holds a slot of). */
function childRun(app: App, parentId: string, kind: "replay-arm" | "replay-judge", title: string, spaceId: string, input: Record<string, unknown>) {
  const r = createRun(app, { kind, spaceId, title: truncate(title, 80), input, parentId });
  run(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), r.id);
  app.emit({ type: "run", runId: r.id, status: "running" });
  return r.id;
}
function finishChild(app: App, id: string, error: string | null, output: Record<string, unknown>) {
  flushRunText(app, id);
  setRunOutput(app, id, output);
  run(app.db, "update runs set status = ?, error = ?, finished_at = ?, quiet = 0 where id = ?", error ? "failed" : "done", error, now(), id);
  if (error) addRunEvent(app, id, "error", { message: error });
  app.emit({ type: "run", runId: id, status: error ? "failed" : "done" });
}

/** An arm's or judge's temporary working directory; on Windows the agent process may still hold it for a moment. */
function removeLater(dir: string) {
  const rm = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
  if (!rm()) setTimeout(rm, 10_000).unref();
}

const localTime = (app: App, at: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: app.config.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(at));

const VARIANT_NOTE: Partial<Record<ReplayAxis, string>> = {
  R1: "这次回答前先把问题换成至少三种说法（同义词、简称、英文或代码里的名字），用 scan 穷举这些说法，再用 search 补充，读到原文后再作答。",
  R2: "这次不要只查当前空间：search、scan 用 space='*' 查所有可访问的空间，相关的原件在哪个空间就引用哪个。",
  W2: "这次先找相关的 Wiki 页面（search 的 scope=pages 或 list_pages）读一遍，再回原件核对后作答。",
  R3: "这次可以查本库之外的材料（你能用的外部工具），查到的写明出处。",
};

/** The task an arm gets: the question as it was asked, with the conversation before it. */
async function armTask(app: App, q: Question, view: RunView, axis: ReplayAxis | null) {
  const when = localTime(app, q.asOf);
  const note = axis ? VARIANT_NOTE[axis] : undefined;
  const head = `这是一次重答：下面的问题是在 ${when} 提的，把现在当作那个时间照常回答。这次只能读：写入、发消息、交办都用不了，也不需要；直接回答问题，引用照常写 src:/mem:。`;
  if (q.kind === "agent") return `${head}${note ? `\n\n${note}` : ""}\n\n---\n\n${q.question}`;
  let passive = "";
  try {
    const hits = await passiveRecall(app, { text: q.question, spaces: null, userId: OWNER, spec: null });
    const ok = visibleMemories(app, view, hits.map((h) => h.memory.id));
    passive = passiveBlock(hits.filter((h) => ok.has(h.memory.id)));
  } catch {}
  return [
    head,
    q.context ? `# 会话背景（提问前的最近 ${CONTEXT_TURNS} 轮）\n\n${q.context}` : "",
    `# 本人新消息\n\n本人（${q.asOf.slice(0, 16).replace("T", " ")}）：${q.question}`,
    note ?? "",
    passive,
  ].filter(Boolean).join("\n\n");
}

type ArmResult = { runId: string; answer: string; error: string | null; ms: number; peak: number; ai: AI | null };

async function runArm(app: App, parent: RunContext, q: Question, label: string, opts: { view: RunView; axis: ReplayAxis | null; ai: AI; spec: AgentSpec | null; spaces?: string[] | null }): Promise<ArmResult> {
  const id = childRun(app, parent.run.id, "replay-arm", `${label}：${q.question.replace(/\s+/g, " ")}`, q.spaceId, { baseRunId: q.run.id, axis: opts.axis, asOf: q.asOf, model: opts.ai });
  const cwd = mkdtempSync(join(tmpdir(), "omem-replay-"));
  const started = Date.now();
  let peak = 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ARM_MINUTES * 60_000);
  timer.unref();
  parent.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const task = await armTask(app, q, opts.view, opts.axis);
    const tools = opts.view.noPages ? REPLAY_TOOLS.filter((t) => !PAGE_TOOLS.includes(t)) : REPLAY_TOOLS;
    const res = await runRole(app, {
      role: "assistant",
      spec: opts.spec ?? undefined,
      spaceId: q.spaceId,
      spaces: opts.spaces,
      task,
      runId: id,
      cwd,
      signal: ctrl.signal,
      profileId: opts.ai.profile,
      model: opts.ai.model,
      effort: opts.ai.effort,
      userId: OWNER,
      lark: { chats: [] },
      shadow: { parentRunId: id },
      replay: { view: opts.view, tools },
      onEvent: (e: AgentEvent) => {
        if (e.type === "usage") peak = Math.max(peak, e.used);
        addRunEvent(app, id, e.type, e);
      },
    });
    const answer = replyOf(res).trim();
    if (res.contextUsage) peak = Math.max(peak, res.contextUsage.used);
    run(app.db, "update runs set ai = ?, profile_id = ? where id = ?", JSON.stringify(res.ai), res.profileId, id);
    finishChild(app, id, null, { answer, ai: res.ai });
    return { runId: id, answer, error: null, ms: Date.now() - started, peak, ai: res.ai };
  } catch (e) {
    const msg = ctrl.signal.aborted && !parent.signal.aborted ? `超过 ${ARM_MINUTES} 分钟，已停止` : (e as Error).message;
    finishChild(app, id, msg, {});
    if (parent.signal.aborted) throw e;
    return { runId: id, answer: "", error: msg, ms: Date.now() - started, peak, ai: null };
  } finally {
    clearTimeout(timer);
    removeLater(cwd);
  }
}

// ------------------------------------------------------------------ judge

type Verdict = { better: "甲" | "乙" | "平"; reason: string; taskType: string | null };

function judgePrompt(app: App, q: Question, first: { answer: string; check: ArmCheck }, second: { answer: string; check: ArmCheck }) {
  const cites = (c: ArmCheck) => c.cites.length ? c.cites.map((x) => `- ${x.ref}：${x.ok ? (x.text ?? "").replace(/\n/g, " ⏎ ") : `（${x.problem}）`}`).join("\n") : "（没有引用）";
  const reaction = [q.reaction.said ? `本人随后说：${truncate(q.reaction.said, 600)}` : "", q.reaction.emoji.length ? `本人加的表情：${q.reaction.emoji.join("、")}（OK、DONE、+1 这类只表示收到）` : ""].filter(Boolean).join("\n");
  return [
    `# 问题（${localTime(app, q.asOf)}）\n\n${q.question}`,
    q.context ? `# 提问前的会话\n\n${truncate(q.context, 4000)}` : "",
    `# 本人事后的反应（针对当时的原答案）\n\n${reaction || "（没有）"}`,
    `# 甲的回答\n\n${truncate(first.answer, 8000)}\n\n甲引用的原文：\n${cites(first.check)}`,
    `# 乙的回答\n\n${truncate(second.answer, 8000)}\n\n乙引用的原文：\n${cites(second.check)}`,
    `# 题型清单\n\n${app.config.replay.taskTypes.join("、")}`,
  ].filter(Boolean).join("\n\n");
}

async function judgeOnce(app: App, parent: RunContext, q: Question, profile: AgentProfile, order: string, prompt: string): Promise<{ verdict: Verdict | null; runId: string; ms: number }> {
  const id = childRun(app, parent.run.id, "replay-judge", `复盘评判（${order}）：${q.question.replace(/\s+/g, " ")}`, q.spaceId, { baseRunId: q.run.id, order });
  run(app.db, "update runs set ai = ?, profile_id = ? where id = ?", JSON.stringify({ profile: profile.id, model: profile.model, effort: profile.effort }), profile.id, id);
  const cwd = mkdtempSync(join(tmpdir(), "omem-judge-"));
  const started = Date.now();
  try {
    const res = await runBackend(app, profile, { cwd, system: loadRole("replay-judge", app).body, prompt, allowWrites: false, modes: ["read-only"], signal: parent.signal }, (e) => addRunEvent(app, id, e.type, e));
    const text = replyOf(res).trim();
    const v = jsonIn<{ better?: string; reason?: string; taskType?: string }>(text);
    const better = v?.better === "甲" || v?.better === "乙" || v?.better === "平" ? (v.better as Verdict["better"]) : null;
    const verdict: Verdict | null = better ? { better, reason: truncate(String(v?.reason ?? ""), 300), taskType: app.config.replay.taskTypes.includes(String(v?.taskType)) ? String(v!.taskType) : null } : null;
    finishChild(app, id, null, { answer: text, verdict });
    return { verdict, runId: id, ms: Date.now() - started };
  } catch (e) {
    finishChild(app, id, (e as Error).message, {});
    if (parent.signal.aborted) throw e;
    return { verdict: null, runId: id, ms: Date.now() - started };
  } finally {
    removeLater(cwd);
  }
}

/** Both orders agree → that arm wins; otherwise a tie. From the variant's side: win / loss / tie. */
export function combine(ab: Verdict | null, ba: Verdict | null): { verdict: "win" | "loss" | "tie"; agree: boolean } {
  // Order 1: 甲 = baseline, 乙 = variant. Order 2: 甲 = variant, 乙 = baseline.
  const one_ = ab ? (ab.better === "乙" ? "variant" : ab.better === "甲" ? "baseline" : "tie") : null;
  const two = ba ? (ba.better === "甲" ? "variant" : ba.better === "乙" ? "baseline" : "tie") : null;
  if (!one_ || !two || one_ !== two) return { verdict: "tie", agree: !!one_ && one_ === two };
  return { verdict: one_ === "variant" ? "win" : one_ === "baseline" ? "loss" : "tie", agree: true };
}

// ------------------------------------------------------------------ effects

type ReplayRow = { id: string; task_run_id: string | null; signal: string; task_type: string | null; axis: ReplayAxis; variant: string; as_of: string; base_run_id: string; baseline_run_id: string | null; arm_run_id: string | null; touched: string; checks: string; verdict: string | null; judge: string; cost: string; status: string; at: string; finished_at: string | null };

function addEffect(app: App, replayId: string, e: { targetKind: string; targetId: string | null; effect: string; note: string; status: "pending" | "applied" | "info" }) {
  const id = newId("re");
  run(app.db, "insert into replay_effects(id, replay_id, target_kind, target_id, effect, note, status, at, resolved_at) values(?,?,?,?,?,?,?,?,?)", id, replayId, e.targetKind, e.targetId, e.effect, e.note, e.status, now(), e.status === "applied" ? now() : null);
  return id;
}

/**
 * What a decided replay changes (docs/v2/replay.md §五). By themselves: memories that misled go back
 * to review, memories that helped are counted, pages that misled get a wiki check, related spaces
 * become candidates for the dreamer. Source levels, rules and imports wait for the owner.
 */
export function applyEffects(app: App, replayId: string) {
  const r = one<ReplayRow>(app.db, "select * from replays where id = ?", replayId);
  if (!r || !["win", "loss"].includes(r.verdict ?? "")) return [];
  const variant = json<{ exclude?: string[]; spec?: string; question?: string }>(r.variant, {});
  const checks = json<{ baseline?: ArmCheck; variant?: ArmCheck }>(r.checks, {});
  const touched = json<Touched>(r.touched, { memories: [], sources: [], pages: [] });
  const win = r.verdict === "win";
  const out: string[] = [];
  const cited = (c?: ArmCheck) => [...new Set((c?.cites ?? []).filter((x) => x.ok && x.ref.startsWith("src:")).map((x) => canonicalSourceId(app, /src:([\w-]+)/.exec(x.ref)![1])))];
  if (r.axis === "M1") {
    for (const id of variant.exclude ?? []) {
      const m = one<{ created_by: string; status: string }>(app.db, "select created_by, status from memories where id = ?", id);
      if (!m) continue;
      if (win) {
        if (m.created_by === "agent" && m.status === "active") {
          run(app.db, "update memories set reviewed_at = null, review_note = ? where id = ?", `复盘 ${r.id}：去掉后答对（${truncate(variant.question ?? "", 60)}）`, id);
          out.push(addEffect(app, r.id, { targetKind: "memory", targetId: id, effect: "rereview", note: "去掉后答对，重新排进复核", status: "applied" }));
        } else out.push(addEffect(app, r.id, { targetKind: "memory", targetId: id, effect: "rereview", note: m.created_by === "user" ? "本人写的记忆，去掉后答对：请本人看一眼" : "去掉后答对（已不是有效记忆）", status: "info" }));
      } else out.push(addEffect(app, r.id, { targetKind: "memory", targetId: id, effect: "helped", note: "去掉后答得更差", status: "applied" }));
    }
  } else if (r.axis === "M3" && win) out.push(addEffect(app, r.id, { targetKind: "dream", targetId: null, effect: "digest-noise", note: "去掉存量整理写的经验后答得更好", status: "info" }));
  else if (r.axis === "S1" && win) {
    for (const id of cited(checks.baseline).filter((s) => ["normal", "ignore"].includes(levelOf(app, s)) && !cited(checks.variant).includes(s)))
      out.push(addEffect(app, r.id, { targetKind: "source", targetId: id, effect: "level", note: "只看重点和仅检索的原件时答得更好：建议把它降为“仅检索”", status: "pending" }));
  } else if (r.axis === "S2" && win) {
    for (const id of cited(checks.variant).filter((s) => levelOf(app, s) === "ignore")) {
      const by = one<{ attention_by: string | null }>(app.db, "select attention_by from sources where id = ?", id)?.attention_by;
      out.push(addEffect(app, r.id, { targetKind: "source", targetId: id, effect: "rule", note: `答案在被忽略的原件里${by === "rule" ? "（是整理规则定的级，建议同时改那条规则）" : ""}：建议改回“一般关注”`, status: "pending" }));
    }
  } else if (r.axis === "R2" && win) {
    const base = one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", r.base_run_id)?.space_id ?? "personal";
    const home = new Set([base, ...relatedIds(app, base)]);
    const others = new Set(cited(checks.variant).map((s) => one<{ space_id: string }>(app.db, "select space_id from sources where id = ?", s)?.space_id).filter((s): s is string => !!s && !home.has(s)));
    for (const s of others) out.push(addEffect(app, r.id, { targetKind: "space", targetId: [base, s].sort().join("|"), effect: "relate", note: `加上空间 ${s} 后答得更好：列为关联候选，交给做梦`, status: "applied" }));
  } else if (r.axis === "R1" && win) out.push(addEffect(app, r.id, { targetKind: "profile", targetId: variant.spec ?? "assistant", effect: "prompt", note: "先列说法、scan 穷举后答得更好：同题型反复出现时由复盘（coach）提提示词建议", status: "info" }));
  else if (r.axis === "R3" && win) out.push(addEffect(app, r.id, { targetKind: "item", targetId: null, effect: "import", note: `本库缺材料：研究档案查到了答案，建议建事项把材料导入（${truncate(variant.question ?? "", 60)}）`, status: "pending" }));
  else if (r.axis === "W1" && win) {
    const bySpace = new Map<string, string[]>();
    for (const p of touched.pages) {
      const [sp, ...rest] = p.includes("/") ? p.split("/") : ["", p];
      const space = sp && one(app.db, "select 1 from spaces where id = ?", sp) ? sp : (one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", r.base_run_id)?.space_id ?? "personal");
      const slug = sp && space === sp ? rest.join("/") : p;
      bySpace.set(space, [...(bySpace.get(space) ?? []), slug]);
    }
    for (const [space, pages] of bySpace) {
      const lint = createRun(app, { kind: "wiki-lint", spaceId: space, title: `检查页面（复盘发现可能过时）`, input: { recheck: pages.map((page) => ({ page, note: `夜间复盘 ${r.id}：不看这页时答得更好，内容可能过时` })) } });
      for (const p of pages) out.push(addEffect(app, r.id, { targetKind: "page", targetId: `${space}/${p}`, effect: "lint", note: `不看这页时答得更好：已排一次页面检查（${lint.id}）`, status: "applied" }));
    }
  }
  return out;
}

/** The owner adopts or ignores a suggestion (card button or the Agent page). */
export function resolveEffect(app: App, id: string, action: "adopt" | "ignore") {
  const e = one<{ id: string; replay_id: string; target_kind: string; target_id: string | null; effect: string; note: string; status: string }>(app.db, "select * from replay_effects where id = ?", id);
  if (!e) throw new HttpError(404, `没有这条复盘建议：${id}`);
  if (e.status !== "pending") return { status: e.status, message: "已经处理过了" };
  let message = "已忽略";
  if (action === "adopt") {
    if (e.effect === "level" && e.target_id) {
      setAttention(app, [e.target_id], "reference" as Level, "owner");
      message = `已把 ${e.target_id} 设为“仅检索”`;
    } else if (e.effect === "rule" && e.target_id) {
      setAttention(app, [e.target_id], "normal" as Level, "owner");
      message = `已把 ${e.target_id} 改回“一般关注”`;
    } else if (e.effect === "import") {
      const r = one<{ variant: string; arm_run_id: string | null }>(app.db, "select variant, arm_run_id from replays where id = ?", e.replay_id);
      const v = json<{ question?: string }>(r?.variant, {});
      const answer = r?.arm_run_id ? String(json<{ answer?: string }>(one<{ output: string }>(app.db, "select output from runs where id = ?", r.arm_run_id)?.output, {}).answer ?? "") : "";
      const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: truncate(`导入材料：${v.question ?? "复盘发现的缺口"}`, 80), detail: `夜间复盘 ${e.replay_id}：本库没有回答这个问题需要的材料，研究档案在外面查到了。\n\n${truncate(answer, 1500)}`, userId: OWNER }, "user");
      run(app.db, "update replay_effects set target_id = ? where id = ?", item.id, id);
      message = `已建事项 ${item.id}：导入这份材料`;
    } else message = "已采纳";
  }
  run(app.db, "update replay_effects set status = ?, resolved_at = ? where id = ?", action === "adopt" ? "adopted" : "ignored", now(), id);
  return { status: action === "adopt" ? "adopted" : "ignored", message };
}

// ------------------------------------------------------------------ one replay

/** Is the bulk digest busy? Replays wait for it (they share the models and the tool server). */
const digestBusy = (app: App) => !!one(app.db, "select 1 from runs where kind in ('digest', 'triage') and status in ('queued', 'running') limit 1");

registerHandler("replay", async (ctx) => {
  const app = ctx.app;
  const input = ctx.run.input as { baseRunId: string; signal: ReplaySignal | "manual"; axis?: ReplayAxis; tries?: number };
  if (digestBusy(app)) {
    const tries = (input.tries ?? 0) + 1;
    if (tries > DEFER_TRIES) throw new Error(`存量整理一直在跑，等了 ${DEFER_TRIES} 次（每次 ${DEFER_MINUTES} 分钟）后放弃，今晚不复盘`);
    createRun(app, { kind: "replay", spaceId: ctx.run.spaceId, title: ctx.run.title, input: { ...input, tries }, lane: "replay", notBefore: new Date(Date.now() + DEFER_MINUTES * 60_000).toISOString() });
    return { quiet: true, deferred: true, summary: `存量整理在跑，${DEFER_MINUTES} 分钟后再试` };
  }
  const judge = judgeChoice(app);
  if (!judge.chosen || judge.error || !judge.profile) {
    noteLast(app, { skipped: judge.error ?? JUDGE_NOT_CHOSEN });
    return { quiet: true, skipped: judge.error ?? JUDGE_NOT_CHOSEN };
  }
  // A replay cut off by a restart left its row behind.
  run(app.db, "update replays set status = 'failed', verdict = coalesce(verdict, 'failed'), finished_at = ? where task_run_id = ? and status = 'running'", now(), ctx.run.id);
  const base = one<RunRow>(app.db, "select id, kind, space_id, status, input, output, ai, error, created_at, started_at, finished_at from runs where id = ?", input.baseRunId);
  const q = base ? questionOf(app, base) : null;
  if (!q) throw new Error(`运行 ${input.baseRunId} 不是可以复盘的问答或档案运行`);
  const spec = q.spec ? findAgentSpec(app, q.spec) : null;
  if (q.spec && !spec) throw new Error(`档案 ${q.spec} 已不存在`);
  const touched = touchedBy(app, q.run.id, q.answer);
  const signal = input.signal === "manual" ? (signalOf(app, q, null) ?? "normal") : input.signal;
  const tried = triedOn(app, q.run.id);
  const axis = input.axis ?? chooseAxis(app, { q, signal, touched, pre: await precheck(app, q), tried });
  if (!axis) return { quiet: true, summary: "这个问题没有能换的轴（都试过了，或缺少需要的信息）" };
  const ai = baseAI(app, q);
  const cache = new Map<string, unknown>();
  const baseView: RunView = { asOf: q.asOf, cache };
  // The lessons the baseline gets count as touched: they are how memories reach most answers.
  const lessons = await lessonIdsForTask(app, { role: "assistant", spec: spec ?? undefined, spaceId: q.spaceId, userId: OWNER, task: q.question, replay: { view: baseView, tools: REPLAY_TOOLS } }).catch(() => [] as string[]);
  const excluded = [...new Set([...touched.memories, ...lessons])];
  const research = axis === "R3" ? researchProfiles(app)[0] : null;
  const variantAI = axis === "A1" ? modelStep(app, ai, -1) : axis === "A2" ? modelStep(app, ai, 1) : research ? (() => { const p = resolveRunProfile(app, { actor: { spec: research } }); return { profile: p.id, model: p.model, effort: p.effort }; })() : ai;
  if (!variantAI) throw new Error(`${axis} 没有可换的模型`);
  const view: RunView = {
    asOf: q.asOf,
    cache,
    ...(axis === "S1" ? { sourceLevels: ["focus", "reference"] as Level[] } : axis === "S2" ? { sourceLevels: [...LEVELS] } : {}),
    ...(axis === "M1" ? { memoryFilter: { exclude: excluded } } : axis === "M2" ? { memoryFilter: { all: true } } : axis === "M3" ? { memoryFilter: { digest: true } } : {}),
    ...(axis === "W1" ? { noPages: true } : {}),
  };
  const replayId = newId("rp");
  const variant = { label: AXIS_LABEL[axis], question: truncate(q.question.replace(/\s+/g, " "), 200), ...(axis === "M1" ? { exclude: excluded } : {}), ...(variantAI !== ai ? { ai: variantAI } : {}), ...(research ? { spec: research.name } : spec ? { spec: spec.name } : {}) };
  run(
    app.db,
    "insert into replays(id, task_run_id, signal, axis, variant, as_of, base_run_id, touched, status, at) values(?,?,?,?,?,?,?,?,?,?)",
    replayId, ctx.run.id, signal, axis, JSON.stringify(variant), q.asOf, q.run.id, JSON.stringify({ ...touched, lessons }), "running", now(),
  );
  ctx.event("status", { text: `复盘 ${replayId}：${SIGNAL_LABEL[signal]} → ${AXIS_LABEL[axis]}` });
  try {
    const b = await runArm(app, ctx, q, "复盘重答（基线）", { view: baseView, axis: null, ai, spec });
    const v = await runArm(app, ctx, q, `复盘重答（${axis}）`, { view, axis, ai: variantAI, spec: research ?? spec, spaces: axis === "R2" ? null : undefined });
    run(app.db, "update replays set baseline_run_id = ?, arm_run_id = ? where id = ?", b.runId, v.runId, replayId);
    const bc = checkArm(app, q.asOf, b.answer, b.error);
    const vc = checkArm(app, q.asOf, v.answer, v.error);
    crossCheck(bc, vc);
    const cost = { baseline: { ms: b.ms, peak: b.peak }, variant: { ms: v.ms, peak: v.peak }, judge: { ms: 0 } };
    let verdict: string;
    let judged: Record<string, unknown> = { profile: judge.profile.id, model: judge.profile.model, sameFamily: sameFamily(app, judge.profile, { id: ai.profile, model: ai.model }) };
    let taskType: string | null = null;
    if (bc.leaks.length || vc.leaks.length) verdict = "void";
    else if (!bc.ok || !vc.ok) {
      verdict = bc.ok ? "loss" : vc.ok ? "win" : "tie";
      judged = { ...judged, by: "checks" };
    } else {
      const ab = await judgeOnce(app, ctx, q, judge.profile, "甲=基线", judgePrompt(app, q, { answer: b.answer, check: bc }, { answer: v.answer, check: vc }));
      const ba = await judgeOnce(app, ctx, q, judge.profile, "甲=变体", judgePrompt(app, q, { answer: v.answer, check: vc }, { answer: b.answer, check: bc }));
      const c = combine(ab.verdict, ba.verdict);
      verdict = c.verdict;
      taskType = ab.verdict?.taskType ?? ba.verdict?.taskType ?? null;
      cost.judge.ms = ab.ms + ba.ms;
      const reason = c.agree ? (ab.verdict?.reason ?? ba.verdict?.reason ?? "") : `两种顺序的结论不一致，记为持平${ab.verdict?.reason ? `（${ab.verdict.reason}）` : ""}`;
      judged = { ...judged, by: "judge", agree: c.agree, orders: [ab.verdict, ba.verdict], runs: [ab.runId, ba.runId], reason };
    }
    run(app.db, "update replays set checks = ?, verdict = ?, judge = ?, task_type = ?, cost = ?, status = 'done', finished_at = ? where id = ?", JSON.stringify({ baseline: bc, variant: vc }), verdict, JSON.stringify(judged), taskType, JSON.stringify(cost), now(), replayId);
    const effects = applyEffects(app, replayId);
    noteLast(app, { replayId, verdict });
    return { replayId, axis, signal, verdict, effects: effects.length, summary: `${SIGNAL_LABEL[signal]} · ${AXIS_LABEL[axis]} · ${VERDICT_LABEL[verdict]}${judged.reason ? `：${judged.reason}` : ""}` };
  } catch (e) {
    run(app.db, "update replays set status = 'failed', verdict = 'failed', finished_at = ? where id = ?", now(), replayId);
    throw e;
  }
});

// Arms and judge calls run inside their replay; one the worker picks up after a restart lost it.
registerHandler("replay-arm", async () => { throw new Error("复盘在服务重启时中断"); });
registerHandler("replay-judge", async () => { throw new Error("复盘在服务重启时中断"); });

function noteLast(app: App, value: Record<string, unknown>) {
  run(app.db, "insert into kv(key, value) values('replay_last', ?) on conflict(key) do update set value = excluded.value", JSON.stringify({ at: now(), ...value }));
}

// ------------------------------------------------------------------ scheduling

/**
 * The nightly job (and `omem replay run`, the API, the peer command `replay-run`): without a judge
 * chosen nothing runs and the reason is kept; otherwise one replay run per question, one at a time.
 * `runId` replays that run (on `axis`, or the plan's choice).
 */
export async function scheduleReplays(app: App, opts: { runId?: string; axis?: ReplayAxis } = {}) {
  const judge = judgeChoice(app);
  if (!judge.chosen || judge.error) {
    const reason = judge.error ?? JUDGE_NOT_CHOSEN;
    noteLast(app, { skipped: reason });
    return { skipped: reason, runs: [] as string[] };
  }
  if (opts.axis && !(REPLAY_AXES as readonly string[]).includes(opts.axis)) throw new HttpError(400, `没有这个轴：${opts.axis}`);
  if (opts.runId) {
    const r = one<RunRow>(app.db, "select id, kind, space_id, status, input, output, ai, error, created_at, started_at, finished_at from runs where id = ?", opts.runId);
    if (!r || !questionOf(app, r)) throw new HttpError(400, `运行 ${opts.runId} 不是可以复盘的问答或档案运行`);
    const created = createRun(app, { kind: "replay", spaceId: r.space_id ?? "personal", title: truncate(`夜间复盘（手动）：${questionOf(app, r)!.question.replace(/\s+/g, " ")}`, 80), input: { baseRunId: r.id, signal: "manual", axis: opts.axis }, lane: "replay" });
    noteLast(app, { scheduled: 1, manual: true });
    return { skipped: null, runs: [created.id] };
  }
  const picks = await selectQuestions(app);
  const runs = picks.map((p) => createRun(app, { kind: "replay", spaceId: one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", p.runId)?.space_id ?? "personal", title: truncate(`夜间复盘：${p.question}`, 80), input: { baseRunId: p.runId, signal: p.signal, axis: p.axis }, lane: "replay" }).id);
  noteLast(app, { scheduled: runs.length, ...(runs.length ? {} : { note: "最近没有可以复盘的问题" }) });
  return { skipped: null, runs };
}

// ------------------------------------------------------------------ reading the results

export type ReplayView = {
  id: string; at: string; finishedAt: string | null; status: string; signal: string; axis: string; axisLabel: string; verdict: string | null; verdictLabel: string;
  taskType: string | null; question: string; reason: string; by: string | null; agree: boolean | null; sameFamily: boolean; baseRunId: string; runId: string | null;
  checks: { baseline: string[]; variant: string[] }; effects: { id: string; effect: string; targetKind: string; targetId: string | null; note: string; status: string }[];
};

function toView(app: App, r: ReplayRow): ReplayView {
  const v = json<{ question?: string }>(r.variant, {});
  const j = json<{ reason?: string; by?: string; agree?: boolean; sameFamily?: boolean }>(r.judge, {});
  const c = json<{ baseline?: ArmCheck; variant?: ArmCheck }>(r.checks, {});
  const issues = (x?: ArmCheck) => [...(x?.leaks ?? []), ...(x?.problems ?? [])];
  return {
    id: r.id, at: r.at, finishedAt: r.finished_at, status: r.status, signal: r.signal, axis: r.axis, axisLabel: AXIS_LABEL[r.axis] ?? r.axis, verdict: r.verdict, verdictLabel: VERDICT_LABEL[r.verdict ?? ""] ?? "进行中",
    taskType: r.task_type, question: v.question ?? "", reason: j.reason ?? "", by: j.by ?? null, agree: j.agree ?? null, sameFamily: !!j.sameFamily, baseRunId: r.base_run_id, runId: r.task_run_id,
    checks: { baseline: issues(c.baseline), variant: issues(c.variant) },
    effects: all<{ id: string; effect: string; target_kind: string; target_id: string | null; note: string; status: string }>(app.db, "select id, effect, target_kind, target_id, note, status from replay_effects where replay_id = ? order by at", r.id).map((e) => ({ id: e.id, effect: e.effect, targetKind: e.target_kind, targetId: e.target_id, note: e.note, status: e.status })),
  };
}

export function listReplays(app: App, opts: { limit?: number; since?: string } = {}): ReplayView[] {
  return all<ReplayRow>(app.db, `select * from replays ${opts.since ? "where at > ?" : ""} order by at desc limit ?`, ...(opts.since ? [opts.since] : []), Math.min(opts.limit ?? 30, 200)).map((r) => toView(app, r));
}

/** For the settings page, the Agent page and `peer call <id> replays`: is it on, who judges, what happened last. */
export function replayStatus(app: App) {
  const judge = judgeChoice(app);
  const schedule = one<{ enabled: number; cron: string; last_run_at: string | null }>(app.db, "select enabled, cron, last_run_at from schedules where id = 'replay'");
  let assistant: AgentProfile | null = null;
  try { assistant = resolveRunProfile(app, { actor: { role: "assistant" } }); } catch {}
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  const counts = all<{ verdict: string; n: number }>(app.db, "select coalesce(verdict, 'running') verdict, count(*) n from replays where at > ? group by verdict", since);
  const agree = one<{ n: number; a: number }>(app.db, "select count(*) n, coalesce(sum(json_extract(judge, '$.agree') = 1), 0) a from replays where at > ? and json_extract(judge, '$.by') = 'judge'", since)!;
  return {
    enabled: !!schedule?.enabled,
    cron: schedule?.cron ?? null,
    lastRunAt: schedule?.last_run_at ?? null,
    judge: judge.chosen && judge.profile ? { profile: judge.profile.id, model: judge.profile.model ?? null, effort: judge.profile.effort ?? null, error: judge.error ?? null, sameFamilyAsAssistant: !!assistant && sameFamily(app, judge.profile, assistant) } : null,
    notice: !judge.chosen ? JUDGE_NOT_CHOSEN : judge.error ?? null,
    last: json<Record<string, unknown> | null>(one<{ value: string }>(app.db, "select value from kv where key = 'replay_last'")?.value, null),
    max: app.config.replay.max,
    days28: { verdicts: Object.fromEntries(counts.map((c) => [c.verdict, c.n])), judged: agree.n, agreed: agree.a },
    pendingEffects: one<{ n: number }>(app.db, "select count(*) n from replay_effects where status = 'pending'")!.n,
  };
}

/**
 * Routing evidence for list_ai_backends: model-axis replays of the last 28 days per model, by task type
 * and the model it was compared with (wins / ties / losses from that model's side, context peak ratio).
 * Fewer than 3 comparisons are left out.
 */
export function replayModelEvidence(app: App): Map<string, { type: string; vs: string; w: number; t: number; l: number; tokens: number | null }[]> {
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  const rows = all<{ verdict: string; task_type: string | null; variant: string; cost: string; base_ai: string | null }>(
    app.db,
    `select r.verdict, r.task_type, r.variant, r.cost, b.ai base_ai from replays r left join runs b on b.id = r.baseline_run_id
      where r.at > ? and r.axis in ('A1', 'A2') and r.verdict in ('win', 'loss', 'tie')`,
    since,
  );
  const groups = new Map<string, { key: string; type: string; vs: string; w: number; t: number; l: number; ratios: number[] }>();
  const add = (model: string, vs: string, type: string, result: "w" | "t" | "l", ratio: number | null) => {
    const k = `${model}#${type}#${vs}`;
    const g = groups.get(k) ?? { key: model, type, vs, w: 0, t: 0, l: 0, ratios: [] };
    g[result]++;
    if (ratio !== null && Number.isFinite(ratio)) g.ratios.push(ratio);
    groups.set(k, g);
  };
  const label = (a: AI) => `${a.profile}|${a.model ?? ""}`;
  for (const r of rows) {
    const variant = json<{ ai?: AI }>(r.variant, {}).ai;
    const base = json<AI | null>(r.base_ai, null);
    if (!variant || !base) continue;
    const cost = json<{ baseline?: { peak?: number }; variant?: { peak?: number } }>(r.cost, {});
    const ratio = cost.baseline?.peak && cost.variant?.peak ? cost.variant.peak / cost.baseline.peak : null;
    const type = r.task_type ?? "未标";
    const vs = (a: AI) => [a.profile, a.model, a.effort].filter(Boolean).join(" · ");
    add(label(variant), vs(base), type, r.verdict === "win" ? "w" : r.verdict === "loss" ? "l" : "t", ratio);
    add(label(base), vs(variant), type, r.verdict === "win" ? "l" : r.verdict === "loss" ? "w" : "t", ratio ? 1 / ratio : null);
  }
  const out = new Map<string, { type: string; vs: string; w: number; t: number; l: number; tokens: number | null }[]>();
  for (const g of groups.values()) {
    if (g.w + g.t + g.l < 3) continue;
    const tokens = g.ratios.length ? Math.round((g.ratios.reduce((a, b) => a + b, 0) / g.ratios.length) * 100) / 100 : null;
    out.set(g.key, [...(out.get(g.key) ?? []), { type: g.type, vs: g.vs, w: g.w, t: g.t, l: g.l, tokens }]);
  }
  return out;
}

/**
 * The “昨晚复盘” section of the 9:30 item digest: one line per replay since the last digest, then the
 * suggestions waiting for the owner (each with adopt / ignore buttons). Null when no replay ran.
 */
export function replayDigest(app: App, since: string): { text: string; effects: { id: string; label: string }[] } | null {
  const rows = all<ReplayRow>(app.db, "select * from replays where finished_at > ? and status in ('done', 'failed') order by at", since);
  if (!rows.length) return null;
  const views = rows.map((r) => toView(app, r));
  const decided = views.filter((v) => v.verdict && v.verdict !== "failed");
  const lines = decided.length && decided.every((v) => v.verdict === "tie")
    ? [`${decided.length} 题都持平${views.length > decided.length ? `（另有 ${views.length - decided.length} 题没跑完）` : ""}`]
    : views.map((v) => `- 「${truncate(v.question, 40)}」· ${v.axisLabel} · ${v.verdictLabel}${v.reason ? `：${truncate(v.reason, 60)}` : v.checks.baseline.length || v.checks.variant.length ? `：${truncate([...v.checks.baseline.map((x) => `基线 ${x}`), ...v.checks.variant.map((x) => `变体 ${x}`)][0], 60)}` : ""}`);
  const pending = views.flatMap((v) => v.effects.filter((e) => e.status === "pending").map((e) => ({ id: e.id, label: `${e.targetId ? `${e.targetId}：` : ""}${e.note}` })));
  const done = views.flatMap((v) => v.effects.filter((e) => e.status === "applied"));
  return {
    text: [
      `**昨晚复盘（${views.length} 题）**`,
      lines.join("\n"),
      done.length ? `已自动处理：${done.length} 项（记忆重新复核、帮上忙的计数、页面检查、空间关联候选）` : "",
      pending.length ? `**需要你决定（${pending.length}）**\n${pending.map((p) => `- ${truncate(p.label, 120)}`).join("\n")}` : "",
    ].filter(Boolean).join("\n"),
    effects: pending,
  };
}

/** For the dreamer and memory review: how often replays found a memory helpful (it was taken away and the answer got worse). */
export function helpedCounts(app: App, ids: string[]): Map<string, number> {
  if (!ids.length) return new Map();
  return new Map(all<{ target_id: string; n: number }>(app.db, "select target_id, count(*) n from replay_effects where target_kind = 'memory' and effect = 'helped' and target_id in (select value from json_each(?)) group by target_id", JSON.stringify(ids)).map((r) => [r.target_id, r.n]));
}

/** What the dreamer is told about replays: memories that helped, whether digest-written experience keeps misleading. */
export function replayDreamText(app: App, memoryIds: string[]) {
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  const helped = helpedCounts(app, memoryIds);
  const noise = one<{ n: number }>(app.db, "select count(*) n from replay_effects where effect = 'digest-noise' and at > ?", since)!.n;
  const parts = [
    helped.size ? `夜间复盘里帮上过忙的记忆（去掉后答得更差；合并重复时优先保留它们）：${[...helped].map(([id, n]) => `${id}（${n} 次）`).join("、")}` : "",
    noise >= 2 ? `近 28 天的夜间复盘里，去掉存量整理（digest）写的经验记忆后有 ${noise} 次答得更好：这批经验噪声大，优先归并或撤回重复、空泛的。` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

/** What the coach is told about a profile's replays (its runs that were replayed, the last 28 days). */
export function replayCoachText(app: App, profile: string) {
  const since = new Date(Date.now() - 28 * 86400_000).toISOString();
  const rows = all<ReplayRow>(
    app.db,
    `select r.* from replays r join runs b on b.id = r.base_run_id where r.at > ? and r.verdict in ('win', 'loss', 'tie') and (${profile === "assistant" ? "b.kind = 'ask'" : "b.kind = 'agent' and json_extract(b.input, '$.spec') = ?"}) order by r.at desc limit 20`,
    since,
    ...(profile === "assistant" ? [] : [profile]),
  );
  if (!rows.length) return "";
  return rows.map((r) => {
    const v = toView(app, r);
    return `- ${v.id}（${v.taskType ?? "未标题型"}）「${truncate(v.question, 60)}」：${v.axisLabel} → ${v.verdictLabel}${v.reason ? `：${truncate(v.reason, 100)}` : ""}`;
  }).join("\n");
}
