import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { json, newId, now } from "../core/util.ts";
import { matchQuery } from "../search/tokenize.ts";
import { getMemory, type Memory, type MemoryKind } from "./store.ts";

/**
 * Keeping memories useful without a human reviewing each one.
 *
 * Three layers, cheapest first:
 *
 * 1. Write-time checks (this file, `checkMemory`): deterministic rules the
 *    `remember` / `supersede` tools apply before anything is stored. A failed
 *    check is returned to the model as the tool error, with what to do instead
 *    (turn uncertainty into an item, cite the source, supersede the duplicate),
 *    so the model corrects itself in the same run. Every rejection is logged
 *    with the model that produced it.
 * 2. Review (`memory-review` runs, roles/memory-reviewer.md): a batch of new
 *    agent memories is read by a reviewer — configurable to a different backend
 *    or model than the writer, so one model's habits are not graded by itself —
 *    which keeps, rewrites (supersede) or retracts each one against its source.
 * 3. Numbers per model (`memoryQualityStats`): how many proposals each
 *    backend/model made, how many the checks rejected, how many the reviewer
 *    retracted or rewrote. With shadow runs (agents.compare) several models
 *    process the same material and are compared on the same scale.
 */

export type MemoryProblem = { code: "hedge" | "too-long" | "process-log" | "restates-source" | "self-report" | "event-log" | "no-source" | "bad-source" | "duplicate" | "empty"; message: string; memoryId?: string };

const HEDGE =
  /不能(证明|当作|视为|推广|据此|把|确认|说明|代表|认定)|无法(确认|证实|核实|判断|证明)|未见(最终|合并|发版|人工|实际|完成|授权|恢复|修复|明确)?(回执|结论|记录|说明)|材料(中)?未(见|提及|说明)|尚(待|未|无)(确认|证实|核实|定论|证据)|未提供.*回执|不(应|宜|可)(视为|当作|理解为|推断|据此)|并不(意味|代表|说明|等于)|不足以(证明|说明|确认)|有待(确认|核实|验证|进一步)|须进一步(核对|确认)|只能说明|仅能说明|不排除|可能(并)?不/g;

/** Clauses whose job is to disclaim rather than inform. */
export function hedgeClauses(text: string) {
  return (text.match(HEDGE) ?? []).length;
}

/** A memory is "hedging junk" when disclaimer clauses dominate and it carries no usable conclusion. */
export function isHedging(content: string): boolean {
  const clauses = hedgeClauses(content);
  if (clauses === 0) return false;
  const chars = content.length;
  if (clauses >= 3) return true;
  if (clauses >= 2 && chars > 120) return true;
  // The leading statement itself is the disclaimer ("X 不能证明 Y").
  const lead = content.split(/[。；;\n]/).filter(Boolean)[0] ?? "";
  if (new RegExp(HEDGE.source).test(lead) && chars > 60) return true;
  return false;
}

/** Narrations of what the agent did ("本次排查…", "经核对…") are run logs, not memories. */
const PROCESS = /^(本次|这次|此次|今天|刚才)?(经(过)?|我(们)?|助理)?(核对|排查|检查|查看|查阅|读取|调查|确认)(了|过|后|发现)|^(本次|这次|此次)(材料|消息|会话|运行|排查|整理)/;

/** "截至 X 收录的《文档》说明…": copying a document into memory; the document is already searchable. */
const RESTATES = /^(截至|截止)[^，。]{0,24}?(收录|入库|更新|发布)|^[^，。]{0,24}?(收录|入库)的|^[^，。]{0,30}?(收录|入库|发布|更新)的[《「“]/;
/** "2026-10-16 某某在某群反馈/询问…": a retelling of what happened, dated at the front. */
const EVENT_LOG = /^(\d{4}[-年./]\d{1,2}[-月./]\d{1,2}日?|\d{1,2}月\d{1,2}日)[^，。]{0,4}[，, ]?[^，。]{0,30}?(反馈|询问|问|说明|报告|表示|分享|指出|回应|回复|发布|通知|确认|提出|讨论|要求|答复)/;

/** The assistant's own report is not a source of facts. */
const SELF_REPORT = /(^|[，,]\s*)(助理|omem)(根据[^，。]{0,10})?(报告|答复|回复|汇报|说明|确认|表示)/;

function bigrams(s: string) {
  const t = s.replace(/[\s，。；、,.;:：！？!?“”"'（）()【】\[\]]/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
export function similarity(a: string, b: string) {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export type CheckInput = {
  spaceId: string;
  kind: MemoryKind;
  content: string;
  subject?: string;
  sourceRefs?: string[];
  /** Background roles (ingest, dreamer…) must cite where a memory comes from. */
  requireSource?: boolean;
  /** The memory being corrected (supersede): not a duplicate of itself. */
  replacing?: string;
  /** Shadow runs: memories the live run wrote from the same material do not count as duplicates. */
  ignoreRunId?: string | null;
};

export function memoryLimits(app: App) {
  return { maxChars: app.config.memory?.maxChars ?? 180, duplicate: app.config.memory?.duplicateThreshold ?? 0.72 };
}

/** Write-time checks; an empty list means the memory may be stored. */
export function checkMemory(app: App, m: CheckInput): MemoryProblem[] {
  const problems: MemoryProblem[] = [];
  const text = m.content.trim();
  const { maxChars, duplicate } = memoryLimits(app);
  if (!text) return [{ code: "empty", message: "内容为空" }];
  if (isHedging(text))
    problems.push({
      code: "hedge",
      message:
        "这条的主体是免责/不确定（“不能证明”“无法确认”“未见回执”之类），不是可复用的结论。确定的部分只写结论；仍需要本人判断或等待结果的，用 upsert_item 建 decision/watch/waiting 事项；什么结论都没有就不记。",
    });
  if (text.length > maxChars)
    problems.push({ code: "too-long", message: `太长（${text.length} 字，上限 ${maxChars}）。记忆是一句可复用的结论，细节留在原件里用 source_refs 指过去；一份材料里的多个独立结论分成多条，事件经过不要记。` });
  if (PROCESS.test(text) || (m.kind === "experience" && /(排查|查看|读取|核对)了.*(然后|之后|再)/.test(text)))
    problems.push({ code: "process-log", message: "这是在叙述你这次做了什么（运行流水），不是以后可直接照做的做法或事实。experience 写成“遇到 X 时，做 Y（因为 Z）”；只是记录过程就不记。" });
  if (RESTATES.test(text))
    problems.push({ code: "restates-source", message: "这是在转述一份原件（“截至…收录的《…》说明…”）。原件本身可检索，不用抄进记忆；只记从中得出的、与本人直接相关的结论（例如本人的职责、承诺、决定），并用主语开头。" });
  if (!problems.some((p) => p.code === "restates-source") && EVENT_LOG.test(text))
    problems.push({ code: "event-log", message: "以“日期 + 某人说/问/反馈了什么”开头，是事件复述。写成以主语开头的结论（谁、什么、多少），日期填 valid_from；只是别人的问答或工单就不记。" });
  if (SELF_REPORT.test(text))
    problems.push({ code: "self-report", message: "这是助理自己的汇报，不是事实来源。本人确认过的结论直接写结论本身（例如“omem 仓库在 /home/…”），助理做了什么不需要记。" });
  const refs = m.sourceRefs ?? [];
  if (m.requireSource && !refs.length) problems.push({ code: "no-source", message: "需要 source_refs：写明支撑这条记忆的原件行（src:<原件id>#L起-L止）、消息或记忆。找不到来源说明这条不该记。" });
  const missing = refs
    .map((r) => /^src:([\w-]+)/.exec(r)?.[1])
    .filter((id): id is string => !!id && !one(app.db, "select 1 from sources where id = ?", id));
  if (missing.length) problems.push({ code: "bad-source", message: `这些原件不存在：${missing.join(", ")}。引用要用 read_source 给出的原件 id。` });
  const dup = nearDuplicate(app, m.spaceId, text, m.subject, m.replacing, duplicate, m.ignoreRunId ?? null);
  if (dup)
    problems.push({
      code: "duplicate",
      memoryId: dup.id,
      message: `与已有记忆 ${dup.id} 几乎相同：「${dup.content.slice(0, 80)}」。内容有变化就 supersede 它，没变化就不用再记。`,
    });
  return problems;
}

function nearDuplicate(app: App, spaceId: string, content: string, subject: string | undefined, replacing: string | undefined, threshold: number, ignoreRunId: string | null) {
  const match = matchQuery(`${subject ?? ""} ${content}`);
  if (!match) return null;
  const rows = all<{ id: string; content: string }>(
    app.db,
    `select m.id, m.content from memories_fts f join memory_rowids r on r.rowid = f.rowid join memories m on m.id = r.memory_id
     where memories_fts match ? and m.space_id = ? and m.status = 'active' and coalesce(m.run_id, '') != ? order by bm25(memories_fts, 2.0, 1.0) limit 8`,
    match,
    spaceId,
    ignoreRunId ?? "\u0000",
  );
  let best: { id: string; content: string; score: number } | null = null;
  for (const r of rows) {
    if (r.id === replacing) continue;
    const score = similarity(content, r.content);
    if (score >= threshold && (!best || score > best.score)) best = { ...r, score };
  }
  return best;
}

export type Provenance = { runId?: string | null; agentProfile?: string | null; model?: string | null; effort?: string | null; shadow?: boolean };

export function logRejection(app: App, spaceId: string, input: { kind: string; content: string; tool: string }, problems: MemoryProblem[], p: Provenance) {
  run(
    app.db,
    "insert into memory_rejections(id,space_id,tool,kind,content,codes,run_id,agent_profile,model,effort,shadow,at) values(?,?,?,?,?,?,?,?,?,?,?,?)",
    newId("mr"),
    spaceId,
    input.tool,
    input.kind,
    input.content,
    JSON.stringify(problems.map((x) => x.code)),
    p.runId ?? null,
    p.agentProfile ?? null,
    p.model ?? null,
    p.effort ?? null,
    p.shadow ? 1 : 0,
    now(),
  );
}

export function formatProblems(problems: MemoryProblem[]) {
  return `没有保存，这条记忆没通过检查：\n${problems.map((p) => `- ${p.message}`).join("\n")}`;
}

// ---- review -------------------------------------------------------------------

export type ReviewVerdict = "keep" | "rewrite" | "retract" | "unclear";

/** Agent-written memories nobody has reviewed yet, oldest first. */
export function unreviewedMemories(app: App, spaceId?: string, limit = 30): Memory[] {
  const rows = all<{ id: string }>(
    app.db,
    `select id from memories where status = 'active' and created_by = 'agent' and reviewed_at is null ${spaceId ? "and space_id = ?" : ""} order by created_at limit ?`,
    ...(spaceId ? [spaceId, limit] : [limit]),
  );
  return rows.map((r) => getMemory(app, r.id));
}

/** Spaces that have memories waiting for review. */
export function spacesWithUnreviewed(app: App) {
  return all<{ space_id: string; n: number }>(app.db, "select space_id, count(*) n from memories where status = 'active' and created_by = 'agent' and reviewed_at is null group by space_id order by n desc");
}

export function markReviewed(app: App, id: string, verdict: ReviewVerdict, note: string, reviewer: Provenance) {
  run(
    app.db,
    "update memories set reviewed_at = ?, review_verdict = ?, review_note = ?, reviewed_by = ? where id = ?",
    now(),
    verdict,
    note,
    [reviewer.agentProfile, reviewer.model].filter(Boolean).join(" · ") || "agent",
    id,
  );
}

// ---- numbers ----------------------------------------------------------------------

export type ModelQuality = {
  model: string;
  /** Memories stored (live runs). */
  stored: number;
  /** Proposals from shadow runs (agents.compare), not stored. */
  shadow: number;
  rejected: number;
  rejectedBy: Record<string, number>;
  reviewed: number;
  kept: number;
  rewritten: number;
  retracted: number;
  avgChars: number;
};

const label = (profile: string | null, model: string | null, effort: string | null) => [profile ?? "?", model ?? "默认模型", effort ?? ""].filter(Boolean).join(" · ");

/** Per backend/model numbers since `sinceDays` ago. */
export function memoryQualityStats(app: App, sinceDays = 30): ModelQuality[] {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const by = new Map<string, ModelQuality & { chars: number; count: number }>();
  const get = (k: string) => {
    let v = by.get(k);
    if (!v) by.set(k, (v = { model: k, stored: 0, shadow: 0, rejected: 0, rejectedBy: {}, reviewed: 0, kept: 0, rewritten: 0, retracted: 0, avgChars: 0, chars: 0, count: 0 }));
    return v;
  };
  for (const r of all<{ agent_profile: string | null; model: string | null; effort: string | null; content: string; review_verdict: string | null; reviewed_at: string | null }>(
    app.db,
    "select agent_profile, model, effort, content, review_verdict, reviewed_at from memories where created_by = 'agent' and created_at >= ?",
    since,
  )) {
    const v = get(label(r.agent_profile, r.model, r.effort));
    v.stored++;
    v.chars += r.content.length;
    v.count++;
    if (r.reviewed_at) {
      v.reviewed++;
      if (r.review_verdict === "keep") v.kept++;
      else if (r.review_verdict === "rewrite") v.rewritten++;
      else if (r.review_verdict === "retract") v.retracted++;
    }
  }
  for (const r of all<{ agent_profile: string | null; model: string | null; effort: string | null; content: string; verdict: string | null }>(
    app.db,
    "select agent_profile, model, effort, json_extract(args, '$.content') content, verdict from shadow_writes where tool in ('remember','supersede') and at >= ?",
    since,
  )) {
    const v = get(label(r.agent_profile, r.model, r.effort));
    v.shadow++;
    v.chars += (r.content ?? "").length;
    v.count++;
    if (r.verdict) {
      v.reviewed++;
      if (r.verdict === "keep") v.kept++;
      else if (r.verdict === "rewrite") v.rewritten++;
      else if (r.verdict === "retract") v.retracted++;
    }
  }
  for (const r of all<{ agent_profile: string | null; model: string | null; effort: string | null; codes: string }>(
    app.db,
    "select agent_profile, model, effort, codes from memory_rejections where at >= ?",
    since,
  )) {
    const v = get(label(r.agent_profile, r.model, r.effort));
    v.rejected++;
    for (const c of json<string[]>(r.codes, [])) v.rejectedBy[c] = (v.rejectedBy[c] ?? 0) + 1;
  }
  return [...by.values()]
    .map(({ chars, count, ...v }) => ({ ...v, avgChars: count ? Math.round(chars / count) : 0 }))
    .sort((a, b) => b.stored + b.shadow - (a.stored + a.shadow));
}

export function recentRejections(app: App, limit = 50) {
  return all<{ id: string; space_id: string; tool: string; kind: string; content: string; codes: string; run_id: string | null; agent_profile: string | null; model: string | null; effort: string | null; shadow: number; at: string }>(
    app.db,
    "select * from memory_rejections order by at desc limit ?",
    limit,
  ).map((r) => ({ ...r, codes: json<string[]>(r.codes, []), shadow: !!r.shadow }));
}
