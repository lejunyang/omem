/**
 * Writing a Wiki page with a second pair of eyes, and accounting for a whole generation.
 *
 *  - A writing run's page is a draft until it is checked: write_page keeps it in the run (draftTarget),
 *    the wiki-checker role reads it with the lines it cites and the code, and hands in what does not
 *    hold (submit_page_check). The writer gets that back and revises; a few rounds at most. Then the
 *    page is saved, with what was found and what is left recorded on it (pageChecks).
 *  - A generation (a plan's pages, or pages named to revise) is settled when its last writing run ends:
 *    a page that was not written is tried once more, and then the owner gets one message — what was
 *    written, how much was fixed on the way, and only what is still open.
 *
 * The host's own checks on every write are in checks.ts. docs/v2/wiki-verify.md.
 */
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, relatedIds } from "../core/spaces.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { createRun, getRun, setRunOutput, type Run, type RunContext } from "../agents/runs.ts";
import type { RoleName } from "../core/config.ts";
import { extractCites, folderOverview, listPages, pageExists, writePage, appendLog } from "./store.ts";
import { codeSpaces, refreshCodeIndexes, sameTopicElsewhere, SOFT_LENGTH, textLength } from "./checks.ts";

/** Checks of one page in one run: the first look and up to two after revisions. */
export const CHECK_ROUNDS = 3;
/** A page the plan named that was not written is tried this many times in all. */
export const WRITE_ATTEMPTS = 2;

export type PageBrief = { slug: string; title: string; kind: string; question: string; outline: string; entry_points: string[]; section?: string; overlap?: { pages: string[]; decision: string; reason: string } };
export type Finding = { quote: string; kind: string; problem: string; basis: string; fix?: string };
export type Draft = { slug: string; title: string; summary: string; kind: string; body: string; reason?: string };
export type CheckRecord = {
  runId: string;
  at: string;
  /** passed: nothing left; open: findings the writer did not resolve; unchecked: the checker did not finish. */
  status: "passed" | "open" | "unchecked" | "off";
  rounds: number;
  /** Findings the checker raised before the last round that the last round no longer had. */
  fixed: number;
  /** write_page refusals the writer then fixed, and entries the host put back. */
  rejected: number;
  restored: number;
  open: Finding[];
  notes: string[];
  history: { round: number; findings: Finding[]; summary?: string }[];
};

// ---------------------------------------------------------------- drafts

type WriteRunInput = { brief: PageBrief; instructions?: string; readSpaces?: string[]; verify?: boolean; generation?: string; attempt?: number; ai?: unknown };

const verifyOn = (app: App, spaceId: string, input: { verify?: boolean }) => input.verify !== false && (findSpace(app, spaceId)?.settings as { wikiVerify?: boolean } | undefined)?.wikiVerify !== false;

/** The page a running writing run keeps as a draft instead of saving (its brief's page, when it is checked before saving). */
export function draftTarget(app: App, runId: string | null | undefined, spaceId: string, slug: string) {
  if (!runId) return false;
  const r = one<{ kind: string; status: string; space_id: string; input: string }>(app.db, "select kind, status, space_id, input from runs where id = ?", runId);
  if (!r || r.kind !== "wiki-write" || r.status !== "running" || r.space_id !== spaceId) return false;
  const input = json<WriteRunInput>(r.input, {} as WriteRunInput);
  return input.brief?.slug === slug && verifyOn(app, spaceId, input);
}
export const draftOf = (app: App, runId: string) => (getRun(app, runId).output.draft as Draft | undefined) ?? null;
export function saveDraft(app: App, runId: string, draft: Draft) {
  setRunOutput(app, runId, { draft, drafts: ((getRun(app, runId).output.drafts as number | undefined) ?? 0) + 1 });
}

/** What write_page's checks did in a run: refusals by kind, and entries put back. */
export function noteWriteCheck(app: App, runId: string | null | undefined, r: { rejected?: string[]; restored?: number }) {
  if (!runId || !one(app.db, "select 1 from runs where id = ?", runId)) return;
  const prev = (getRun(app, runId).output.writeChecks as { rejected?: Record<string, number>; restored?: number } | undefined) ?? {};
  const rejected = { ...(prev.rejected ?? {}) };
  for (const k of r.rejected ?? []) rejected[k] = (rejected[k] ?? 0) + 1;
  setRunOutput(app, runId, { writeChecks: { rejected, restored: (prev.restored ?? 0) + (r.restored ?? 0) } });
}
/** How many times write_page refused this run's page for `kind` (a second lost-entries refusal puts the entries back instead). */
export const refusals = (app: App, runId: string | null | undefined, kind: string) =>
  runId ? (((getRun(app, runId).output.writeChecks as { rejected?: Record<string, number> } | undefined)?.rejected ?? {})[kind] ?? 0) : 0;

// ---------------------------------------------------------------- check records

const recordKey = (spaceId: string, slug: string) => `wiki-checks:${spaceId}/${slug}`;
export function recordCheck(app: App, spaceId: string, slug: string, rec: CheckRecord) {
  const key = recordKey(spaceId, slug);
  const prev = json<CheckRecord[]>(one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value, []);
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key, JSON.stringify([rec, ...prev].slice(0, 10)));
}
/** A page's check records, newest first (also those kept under paths it had before it moved). */
export function pageChecks(app: App, spaceId: string, slug: string): CheckRecord[] {
  const keys = [slug, ...all<{ alias: string }>(app.db, "select alias from page_aliases where space_id = ? and slug = ?", spaceId, slug).map((r) => r.alias)];
  return keys
    .flatMap((k) => json<CheckRecord[]>(one<{ value: string }>(app.db, "select value from kv where key = ?", recordKey(spaceId, k))?.value, []))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);
}

// ---------------------------------------------------------------- one page

async function role(ctx: RunContext, name: RoleName, spaceId: string, task: string, opts: { spaces?: string[]; readSpaces?: string[]; reuse?: boolean; ownAI?: boolean }) {
  const { runRole } = await import("../agents/runner.ts");
  const r = await runRole(ctx.app, {
    role: name,
    spaceId,
    spaces: opts.spaces,
    alsoRead: opts.readSpaces,
    readScope: opts.readSpaces,
    task,
    runId: ctx.run.id,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, e),
    userId: one<{ user_id: string | null }>(ctx.app.db, "select user_id from runs where id = ?", ctx.run.id)?.user_id ?? undefined,
    reuseSession: opts.reuse,
    ownAI: opts.ownAI,
  });
  run(ctx.app.db, "update runs set profile_id = coalesce(profile_id, ?) where id = ?", r.profileId, ctx.run.id);
  return r;
}

/** The lines a page cites, quoted for the checker (as much as fits). */
export function citedExcerpts(app: App, body: string, budget = 14000) {
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  for (const c of extractCites(body)) {
    const key = `${c.ref}#${c.lineStart}-${c.lineEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = one<{ id: string; title: string; text: string }>(app.db, "select id, title, text from sources where id = ? and deleted_at is null", c.ref);
    if (!s) continue;
    const lines = s.text.split("\n");
    const a = Math.max(1, c.lineStart ?? 1);
    const b = Math.min(lines.length, c.lineEnd ?? (c.lineStart ? c.lineStart : Math.min(lines.length, 40)));
    const quote = lines.slice(a - 1, b).map((l, i) => `${a + i}: ${truncate(l, 300)}`).join("\n");
    const part = `### src:${s.id}#L${a}-L${b}（${s.title}）\n${quote}`;
    if (used + part.length > budget) {
      parts.push(`（还有引用没有列出，用 read_source 读）`);
      break;
    }
    used += part.length;
    parts.push(part);
  }
  return parts.join("\n\n");
}

function checkerTask(app: App, spaceId: string, brief: PageBrief, draft: Draft, readSpaces: string[], round: number, history: CheckRecord["history"], writerReply: string, notes: string[]) {
  const related = relatedIds(app, spaceId).filter((id) => readSpaces.includes(id));
  const relatedPages = related
    .map((id) => {
      const pages = listPages(app, id);
      if (!pages.length) return "";
      return `空间 ${id}（${findSpace(app, id)?.name ?? id}）：\n${pages.length > 60 ? `${folderOverview(pages)}\n页面多，用 list_pages(space="${id}", folder=…) 或 search 找同主题的` : pages.map((p) => `- [[${id}:${p.slug}]] ${p.title}`).join("\n")}`;
    })
    .filter(Boolean);
  const same = sameTopicElsewhere(app, spaceId, draft.title, readSpaces);
  const len = textLength(draft.body);
  return [
    `核对空间 ${spaceId} 的页面草稿 ${draft.slug}「${draft.title}」（类型 ${draft.kind}，第 ${round} 轮核对）。它还没有发布。`,
    `这页要回答：${brief.question}`,
    `## 草稿全文\n\n${draft.body}`,
    `## 草稿引用的原件行（宿主按引用摘出）\n\n${citedExcerpts(app, draft.body) || "（草稿没有引用原件）"}`,
    `## 可以查的代码空间\n\n${codeSpaces(app, spaceId, readSpaces).join("、")}`,
    relatedPages.length ? `## 相关空间已有的页面\n\n${relatedPages.join("\n\n")}` : "相关空间还没有页面。",
    same.length ? `标题相近的页面（先读它们，看是不是同一主题）：${same.map((p) => `${p.space}:${p.slug}「${p.title}」`).join("、")}` : "",
    len > SOFT_LENGTH ? `正文约 ${len} 字，偏长：看能不能按读者的问题拆开，能拆就提一条 length。` : "",
    notes.length ? `宿主写入时的提示：\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    history.length
      ? `## 之前几轮提的问题\n\n${history.map((h) => `第 ${h.round} 轮：\n${h.findings.map((f, i) => `${i + 1}. [${f.kind}] “${f.quote}” —— ${f.problem}`).join("\n") || "（无）"}`).join("\n\n")}\n\n写作者的回复：\n${writerReply || "（没有说明）"}\n\n只提这一版里仍然存在的问题；写作者给了依据反驳的，看依据成不成立。`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function reviseTask(draft: Draft, findings: Finding[], round: number) {
  return [
    `核对角色看了你提交的页面 ${draft.slug}「${draft.title}」（第 ${round} 轮），提出下面这些问题。逐条处理：`,
    findings.map((f, i) => `${i + 1}. [${f.kind}] “${f.quote}”\n   问题：${f.problem}\n   依据：${f.basis}${f.fix ? `\n   建议：${f.fix}` : ""}`).join("\n"),
    "- 问题成立：改正文，事实以原件和代码为准；相关空间已有同主题页面的，链接过去，只留本空间特有的内容。",
    "- 认为核对错了：不改，在回复里逐条写明你的依据（原件行或代码位置）。",
    "改完用 write_page 重新提交整页（路径不变）；回复里按编号说明每条怎么处理的。",
    `你上次提交的全文：\n\n${draft.body}`,
  ].join("\n\n");
}

/**
 * The wiki-write handler: the writer writes (a draft, when the page is checked), the checker looks,
 * the writer revises, the page is saved with its check record.
 */
export async function writeAndVerify(ctx: RunContext) {
  const app = ctx.app;
  const spaceId = ctx.run.spaceId!;
  const input = ctx.run.input as WriteRunInput;
  const { brief, instructions } = input;
  const readSpaces = input.readSpaces ?? [spaceId];
  const userId = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", ctx.run.id)?.user_id ?? OWNER;
  const verify = verifyOn(app, spaceId, input);
  // The code the page will cite, as it is now (an index left behind gives plain-text code and stale lines).
  const indexes = await refreshCodeIndexes(app, codeSpaces(app, spaceId, scopeFor(app, userId, readSpaces)), (text) => ctx.event("status", { text }));
  if (indexes.synced.length) ctx.event("status", { text: `已同步代码索引：${indexes.synced.join("、")}` });
  const exists = pageExists(app, spaceId, brief.slug);
  const pagesNow = listPages(app, spaceId);
  const same = sameTopicElsewhere(app, spaceId, brief.title, scopeFor(app, userId, readSpaces));
  const task = [
    `页面：${brief.slug}「${brief.title}」（类型：${brief.kind}）`,
    `用户问题：${brief.question}`,
    `讲解路线：${brief.outline}`,
    `调查入口：${(brief.entry_points ?? []).join("、") || "自行调查"}`,
    exists ? "这个页面已经存在：先 read_page，保留仍然正确且有用的内容，在此基础上改进。" : "",
    brief.overlap ? `相关空间已有同主题的页面 ${brief.overlap.pages.join("、")}，规划决定本空间仍写这一页：${brief.overlap.reason}。先读那几页，它们讲过的部分链接过去，这页只写本空间特有的。` : "",
    same.length && !brief.overlap ? `相关空间已有标题相近的页面：${same.map((p) => `[[${p.space}:${p.slug}|${p.title}]]`).join("、")}：先读，同一件事就链接过去，只写本空间特有的。` : "",
    instructions ? `本人的补充要求：${instructions}` : "",
    verify ? "提交后页面先作为草稿，由核对角色逐条对照原件和代码核对；核对提出的问题会交回给你改，改完才发布。" : "",
    "其他已有/计划中的页面（需要时链接它们，不要重复讲）：\n" +
      (pagesNow.length > 80 ? `${folderOverview(pagesNow)}\n页面太多没有逐个列出：用 list_pages(folder=…) 看相关目录。` : pagesNow.map((p) => `- [[${p.slug}]] ${p.title}`).join("\n")),
  ]
    .filter(Boolean)
    .join("\n\n");
  const writer = (t: string) => role(ctx, "wiki-writer", spaceId, t, { spaces: [spaceId], readSpaces, reuse: true });
  let reply = (await writer(task)).text;
  if (!verify) {
    if (!pageExists(app, spaceId, brief.slug)) throw new Error(`写作结束但没有提交页面 ${brief.slug}`);
    recordCheck(app, spaceId, brief.slug, { runId: ctx.run.id, at: now(), status: "off", rounds: 0, fixed: 0, ...writeCounts(app, ctx.run.id), open: [], notes: indexes.notes, history: [] });
    return { summary: reply.trim(), page: `${spaceId}/${brief.slug}`, published: true, check: "off", notes: indexes.notes };
  }
  if (!draftOf(app, ctx.run.id)) reply = (await writer(`你还没有用 write_page 提交页面 ${brief.slug}。按上面的计划写完并提交；被拒绝的话按返回的原因改了再提交。`)).text;
  const first = draftOf(app, ctx.run.id);
  if (!first) throw new Error(`写作结束但没有提交页面 ${brief.slug}`);
  const history: CheckRecord["history"] = [];
  const notes = [...indexes.notes];
  let status: CheckRecord["status"] = "passed";
  let open: Finding[] = [];
  let raised = 0;
  for (let round = 1; round <= CHECK_ROUNDS; round++) {
    const draft = draftOf(app, ctx.run.id)!;
    setRunOutput(app, ctx.run.id, { pageCheck: null });
    const checkScope = scopeFor(app, userId, [...new Set([...readSpaces, ...relatedIds(app, spaceId)])]) ?? [...new Set([...readSpaces, ...relatedIds(app, spaceId)])];
    try {
      await role(ctx, "wiki-checker", spaceId, checkerTask(app, spaceId, brief, draft, checkScope, round, history, round > 1 ? reply : "", (getRun(app, ctx.run.id).output.writeNotes as string[] | undefined) ?? []), { spaces: [spaceId], readSpaces: checkScope, ownAI: true });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      notes.push(`核对没有完成（${truncate((e as Error).message, 120)}）`);
      status = "unchecked";
      break;
    }
    const got = getRun(app, ctx.run.id).output.pageCheck as { findings: Finding[]; summary?: string } | null | undefined;
    if (!got) {
      notes.push("核对角色没有提交结论（submit_page_check）");
      status = "unchecked";
      break;
    }
    history.push({ round, findings: got.findings, summary: got.summary });
    ctx.event("status", { text: got.findings.length ? `核对第 ${round} 轮：${got.findings.length} 个问题` : `核对第 ${round} 轮：没有问题` });
    if (!got.findings.length) {
      open = [];
      break;
    }
    if (round === CHECK_ROUNDS) {
      open = got.findings;
      status = "open";
      break;
    }
    raised += got.findings.length;
    reply = (await writer(reviseTask(draft, got.findings, round))).text;
  }
  // Raised before a revision and no longer there afterwards (roughly: an open one may be an old one still standing).
  const fixed = status === "open" ? Math.max(0, raised - open.length) : raised;
  const draft = draftOf(app, ctx.run.id)!;
  const existed = pageExists(app, spaceId, draft.slug);
  const p = writePage(app, spaceId, draft.slug, { meta: { title: draft.title, summary: draft.summary, kind: draft.kind }, body: draft.body }, { actor: "agent", message: `agent: ${existed ? "update" : "create"} ${spaceId}/${draft.slug}${draft.reason ? " — " + draft.reason : ""} (run ${ctx.run.id}; 核对 ${history.length} 轮${open.length ? `，${open.length} 条未解决` : ""})` });
  appendLog(app, spaceId, `${existed ? "更新" : "新建"} [[${p.slug}]]${draft.reason ? "：" + draft.reason : ""}（核对 ${history.length} 轮${open.length ? `，${open.length} 条未解决` : ""}）`);
  app.emit({ type: "run-event", runId: ctx.run.id, seq: -1, event: { type: "change", data: { entity: "page", id: p.id }, at: now() } });
  const rec: CheckRecord = { runId: ctx.run.id, at: now(), status, rounds: history.length, fixed, ...writeCounts(app, ctx.run.id), open, notes, history };
  recordCheck(app, spaceId, p.slug, rec);
  return { summary: reply.trim(), page: p.id, published: true, check: status, rounds: history.length, open: open.length, notes };
}

function writeCounts(app: App, runId: string) {
  const w = (getRun(app, runId).output.writeChecks as { rejected?: Record<string, number>; restored?: number } | undefined) ?? {};
  return { rejected: Object.values(w.rejected ?? {}).reduce((a, b) => a + b, 0), restored: w.restored ?? 0 };
}

// ---------------------------------------------------------------- a generation

type GenPage = { slug: string; title: string; runs: string[] };
export type Generation = { id: string; spaceId: string; userId: string; planRunId?: string; startedAt: string; pages: GenPage[]; notes: string[]; reportedAt?: string; report?: GenerationReport };
export type GenerationReport = {
  written: { slug: string; title: string }[];
  fixed: number;
  rejected: number;
  restored: number;
  open: { slug: string; title: string; text: string }[];
  missing: { slug: string; title: string; reason: string }[];
  notes: string[];
};

const genKey = (id: string) => `wiki-gen:${id}`;
export const getGeneration = (app: App, id: string) => json<Generation | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", genKey(id))?.value, null);
function saveGeneration(app: App, g: Generation) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", genKey(g.id), JSON.stringify(g));
}

/** A generation's writing runs, queued together: settled (and reported) when the last one ends. */
export function startGeneration(app: App, input: { id?: string; spaceId: string; userId?: string | null; planRunId?: string; notes?: string[]; writes: { slug: string; title: string; runId: string }[] }) {
  const g: Generation = { id: input.id ?? newId("wg"), spaceId: input.spaceId, userId: input.userId ?? OWNER, planRunId: input.planRunId, startedAt: now(), pages: input.writes.map((w) => ({ slug: w.slug, title: w.title, runs: [w.runId] })), notes: input.notes ?? [] };
  saveGeneration(app, g);
  for (const w of input.writes) {
    const r = one<{ input: string }>(app.db, "select input from runs where id = ?", w.runId);
    if (r) run(app.db, "update runs set input = ? where id = ?", JSON.stringify({ ...json<Record<string, unknown>>(r.input, {}), generation: g.id }), w.runId);
  }
  return g;
}

/** Called when any writing run ends (runs.ts): once all of its generation's are done, retry what is missing or report. */
export function settleWikiRun(app: App, r: Run) {
  if (r.kind !== "wiki-write" || !r.spaceId) return null;
  const input = r.input as WriteRunInput;
  const g: Generation = (input.generation && getGeneration(app, input.generation)) || {
    id: `solo-${r.id}`, spaceId: r.spaceId, userId: one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", r.id)?.user_id ?? OWNER, startedAt: r.createdAt, notes: [],
    pages: [{ slug: input.brief.slug, title: input.brief.title, runs: [r.id] }],
  };
  if (g.reportedAt) return g.report ?? null;
  const runs = g.pages.flatMap((p) => p.runs).map((id) => one<{ id: string; status: string }>(app.db, "select id, status from runs where id = ?", id)).filter(Boolean) as { id: string; status: string }[];
  if (runs.some((x) => x.status === "queued" || x.status === "running")) return null;
  // Pages the plan named that were not written: once more, unless someone cancelled them.
  let retried = false;
  for (const p of g.pages) {
    const last = getRun(app, p.runs.at(-1)!);
    const written = last.status === "done" && pageExists(app, g.spaceId, p.slug);
    if (written || last.status === "cancelled" || p.runs.length >= WRITE_ATTEMPTS) continue;
    const again = createRun(app, { kind: "wiki-write", spaceId: g.spaceId, title: `重写：${p.title}（上次没有写成）`, input: { ...last.input, attempt: p.runs.length + 1, generation: g.id.startsWith("solo-") ? undefined : g.id }, parentId: last.parentId, userId: g.userId });
    p.runs.push(again.id);
    retried = true;
  }
  if (retried) {
    if (!g.id.startsWith("solo-")) saveGeneration(app, g);
    else {
      // A single page's retry gets a generation of its own, so it is reported when it ends.
      const solo = { ...g, id: newId("wg") };
      saveGeneration(app, solo);
      const again = g.pages[0].runs.at(-1)!;
      const row = one<{ input: string }>(app.db, "select input from runs where id = ?", again)!;
      run(app.db, "update runs set input = ? where id = ?", JSON.stringify({ ...json<Record<string, unknown>>(row.input, {}), generation: solo.id }), again);
    }
    return null;
  }
  const report = generationReport(app, g);
  g.report = report;
  g.reportedAt = now();
  saveGeneration(app, g);
  if (g.planRunId && one(app.db, "select 1 from runs where id = ?", g.planRunId)) setRunOutput(app, g.planRunId, { report });
  deliverReport(app, g, report);
  return report;
}

export function generationReport(app: App, g: Generation): GenerationReport {
  const report: GenerationReport = { written: [], fixed: 0, rejected: 0, restored: 0, open: [], missing: [], notes: [...g.notes] };
  for (const p of g.pages) {
    const last = getRun(app, p.runs.at(-1)!);
    // Refusals and fixes over every attempt.
    for (const id of p.runs) {
      const w = (getRun(app, id).output.writeChecks as { rejected?: Record<string, number>; restored?: number } | undefined) ?? {};
      report.rejected += Object.values(w.rejected ?? {}).reduce((a, b) => a + b, 0);
      report.restored += w.restored ?? 0;
    }
    if (!(last.status === "done" && pageExists(app, g.spaceId, p.slug))) {
      report.missing.push({ slug: p.slug, title: p.title, reason: last.status === "cancelled" ? "写作被取消" : truncate(last.error ?? "写作结束但没有提交页面", 160) });
      continue;
    }
    report.written.push({ slug: p.slug, title: p.title });
    const rec = pageChecks(app, g.spaceId, p.slug).find((c) => c.runId === last.id);
    if (!rec) continue;
    report.fixed += rec.fixed;
    for (const f of rec.open) report.open.push({ slug: p.slug, title: p.title, text: `${f.problem}（“${truncate(f.quote, 40)}”）` });
    if (rec.status === "unchecked") report.open.push({ slug: p.slug, title: p.title, text: rec.notes.find((n) => n.startsWith("核对")) ?? "核对没有完成" });
    for (const n of rec.notes) if (!n.startsWith("核对") && !report.notes.includes(n)) report.notes.push(n);
  }
  return report;
}

const pageLink = (spaceId: string, slug: string) => `#/wiki/${encodeURIComponent(spaceId)}/${slug.split("/").map(encodeURIComponent).join("/")}`;

/** The one message a generation sends: quiet (in-app only) when nothing is left for the owner. */
export function reportText(g: Generation, r: GenerationReport) {
  const lines: string[] = [];
  if (r.written.length) lines.push(`写了 ${r.written.length} 页：${r.written.slice(0, 12).map((p) => p.title).join("、")}${r.written.length > 12 ? ` 等` : ""}。`);
  const auto = r.fixed + r.rejected + r.restored;
  if (auto) lines.push(`自动修了 ${auto} 处：写入时拦下 ${r.rejected} 处、核对后改正 ${r.fixed} 处${r.restored ? `、补回入口 ${r.restored} 处` : ""}。`);
  const left = [...r.missing.map((m) => `- 没写成「${m.title}」：${m.reason}`), ...r.open.map((o) => `- 「${o.title}」${o.text} ${pageLink(g.spaceId, o.slug)}`), ...r.notes.map((n) => `- ${n}`)];
  if (left.length) lines.push(`还有 ${left.length} 条没解决：\n${left.slice(0, 20).join("\n")}${left.length > 20 ? `\n…另有 ${left.length - 20} 条，见运行详情` : ""}`);
  else lines.push("没有需要你看的。");
  return lines.join("\n");
}

function deliverReport(app: App, g: Generation, r: GenerationReport) {
  const left = r.missing.length + r.open.length + r.notes.length;
  const name = findSpace(app, g.spaceId)?.name ?? g.spaceId;
  try {
    notify(app, {
      title: left ? `Wiki「${name}」写完了，${left} 条要你看` : `Wiki「${name}」写完了 ${r.written.length} 页`,
      body: reportText(g, r),
      link: r.open[0] ? pageLink(g.spaceId, r.open[0].slug) : `#/wiki/${encodeURIComponent(g.spaceId)}`,
      userId: g.userId,
      runId: g.planRunId ?? null,
      urgency: left ? "normal" : "silent",
    });
  } catch (e) {
    console.warn(`[omem] Wiki 生成报告发送失败：${(e as Error).message}`);
  }
}

/** For the plan's writer runs: pages in the generation not yet written, by slug (tests and read_run). */
export const generationOf = (app: App, runId: string) => {
  const id = (getRun(app, runId).input as { generation?: string }).generation;
  return id ? getGeneration(app, id) : null;
};
