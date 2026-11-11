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
import { createRun, getRun, registerHandler, setRunOutput, type Run, type RunContext } from "../agents/runs.ts";
import { createAsk, registerAskHandler } from "../agents/asks.ts";
import type { RoleName } from "../core/config.ts";
import { extractCites, folderOverview, listPages, pageExists, writePage, appendLog } from "./store.ts";
import { addQuestions, ASK_LIMIT, getQuestion, listQuestions, questionsText, RESOLVE_LIMIT, refsIn, updateQuestion, type QuestionInput } from "./questions.ts";
import { codeSpaces, mermaidCheckable, refreshCodeIndexes, sameTopicElsewhere, SOFT_LENGTH, textLength } from "./checks.ts";

/** Checks of one page in one run: the first look and up to two after revisions. */
export const CHECK_ROUNDS = 3;
/** A page the plan named that was not written is tried this many times in all. */
export const WRITE_ATTEMPTS = 2;

export type PageBrief = { slug: string; title: string; kind: string; question: string; outline: string; entry_points: string[]; section?: string; overlap?: { pages: string[]; decision: string; reason: string } };
export type Finding = { quote: string; kind: string; problem: string; basis: string; fix?: string; question?: string };
export type Draft = { slug: string; title: string; summary: string; kind: string; body: string; reason?: string; questions?: QuestionInput[] };
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
  /** What was left out of the page because nobody was sure: questions for the owner (the writer's and the checker's). */
  questions?: string[];
};

// ---------------------------------------------------------------- drafts

type WriteRunInput = { brief: PageBrief; instructions?: string; readSpaces?: string[]; verify?: boolean; generation?: string; attempt?: number; ai?: unknown; questionIds?: string[] };

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
  // Questions handed in with an earlier version of the page stay: a revision need not repeat them.
  const merged = new Map<string, QuestionInput>();
  for (const q of [...(draftOf(app, runId)?.questions ?? []), ...(draft.questions ?? [])]) merged.set(q.question, q);
  draft = { ...draft, questions: [...merged.values()] };
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
    len > SOFT_LENGTH ? `正文约 ${len} 字，超过 ${SOFT_LENGTH}：宿主已经记了一条 length，你看清它该怎么拆（按读者的哪几个问题、哪些段落是流水记录该移出），写进你那一条 length 的建议里。` : "",
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
    "- unsure（拿不准的内容）：先自己再查一遍（代码、原件），查清了就照实写；查不清的从页面里拿掉，不留“待确认”之类的小节。核对提的这条已经记成这页的未决问题，不用重复交；你自己另外拿不准的写进 write_page 的 questions（问题、为什么拿不准、相关引用）。",
    "- log（流水记录）：提炼成一句站得住的结论（流程、口径、做法），提炼不出的删掉；那是事项、案例页或工作文件的内容。",
    "- length：按读者的问题拆成几页（同目录下的新页面，用 write_page 直接写），这页留开头的结论和到各页的链接。",
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
  const pageQuestions = listQuestions(app, { spaceId, page: brief.slug, status: ["open", "needs-owner", "answered"], limit: RESOLVE_LIMIT });
  const task = [
    `页面：${brief.slug}「${brief.title}」（类型：${brief.kind}）`,
    `用户问题：${brief.question}`,
    `讲解路线：${brief.outline}`,
    `调查入口：${(brief.entry_points ?? []).join("、") || "自行调查"}`,
    exists ? "这个页面已经存在：先 read_page，保留仍然正确且有用的内容，在此基础上改进。" : "",
    brief.overlap ? `相关空间已有同主题的页面 ${brief.overlap.pages.join("、")}，规划决定本空间仍写这一页：${brief.overlap.reason}。先读那几页，它们讲过的部分链接过去，这页只写本空间特有的。` : "",
    same.length && !brief.overlap ? `相关空间已有标题相近的页面：${same.map((p) => `[[${p.space}:${p.slug}|${p.title}]]`).join("、")}：先读，同一件事就链接过去，只写本空间特有的。` : "",
    instructions ? `本人的补充要求：${instructions}` : "",
    pageQuestions.length ? `这页挂着的未决问题（不在页面里）：先自己查（代码、原件），查清了就写进页面并用 settle_wiki_question 标成 resolved；查不清、只有本人能定的标成 needs-owner 并给出 importance；已有本人回答的照回答写：\n${questionsText(pageQuestions)}` : "",
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
  const fromChecker = new Map<string, QuestionInput>();
  for (let round = 1; round <= CHECK_ROUNDS; round++) {
    const draft = draftOf(app, ctx.run.id)!;
    setRunOutput(app, ctx.run.id, { pageCheck: null });
    const checkScope = scopeFor(app, userId, [...new Set([...readSpaces, ...relatedIds(app, spaceId)])]) ?? [...new Set([...readSpaces, ...relatedIds(app, spaceId)])];
    try {
      await role(ctx, "wiki-checker", spaceId, checkerTask(app, spaceId, brief, draft, checkScope, round, history, round > 1 ? reply : "", [...((getRun(app, ctx.run.id).output.writeNotes as string[] | undefined) ?? []), ...(/```\s*mermaid/i.test(draft.body) && !(await mermaidCheckable()) ? ["宿主这次没能检查 mermaid 图的语法（mermaid 没有加载成功），请按第 8 条看一下图"] : [])]), { spaces: [spaceId], readSpaces: checkScope, ownAI: true });
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
    // Length is not the checker's call: over the limit, the host says so itself every round.
    const len = textLength(draft.body);
    const longPage = !/(^|\/)index$/.test(draft.slug) && draft.kind !== "index" && len > SOFT_LENGTH;
    if (longPage && !got.findings.some((f) => f.kind === "length")) got.findings.push({ quote: "（整页）", kind: "length", problem: `正文约 ${len} 字，超过 ${SOFT_LENGTH}，一页只回答一个问题`, basis: "宿主按正文字数统计（不计链接地址）", fix: "按读者的问题拆成几页，流水记录提炼成结论或移出，这页留结论和链接" });
    for (const f of got.findings) if (f.kind === "unsure") fromChecker.set((f.question ?? f.problem).trim(), { question: (f.question ?? f.problem).trim(), why: f.problem, refs: refsIn(`${f.basis} ${f.quote}`) });
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
  // What was left out of the page goes to its open questions; answers this run was given to write in are done.
  addQuestions(app, spaceId, p.slug, draft.questions ?? [], { source: "writer", runId: ctx.run.id });
  addQuestions(app, spaceId, p.slug, [...fromChecker.values()], { source: "checker", runId: ctx.run.id });
  for (const id of input.questionIds ?? []) if (getQuestion(app, id)?.status === "answered") updateQuestion(app, id, { status: "resolved", note: `本人回答后写进页面（运行 ${ctx.run.id}）` });
  const questions = [...(draft.questions ?? []).map((q) => q.question), ...fromChecker.keys()];
  const rec: CheckRecord = { runId: ctx.run.id, at: now(), status, rounds: history.length, fixed, ...writeCounts(app, ctx.run.id), open, notes, history, questions: [...new Set(questions)].filter(Boolean) };
  recordCheck(app, spaceId, p.slug, rec);
  return { summary: reply.trim(), page: p.id, published: true, check: status, rounds: history.length, open: open.length, notes };
}

function writeCounts(app: App, runId: string) {
  const w = (getRun(app, runId).output.writeChecks as { rejected?: Record<string, number>; restored?: number } | undefined) ?? {};
  return { rejected: Object.values(w.rejected ?? {}).reduce((a, b) => a + b, 0), restored: w.restored ?? 0 };
}

// ---------------------------------------------------------------- a generation

type GenPage = { slug: string; title: string; runs: string[] };
export type Generation = { id: string; spaceId: string; userId: string; planRunId?: string; startedAt: string; pages: GenPage[]; notes: string[]; resolveRunId?: string; reportedAt?: string; report?: GenerationReport };
export type GenerationReport = {
  written: { slug: string; title: string }[];
  fixed: number;
  rejected: number;
  restored: number;
  open: { slug: string; title: string; text: string }[];
  missing: { slug: string; title: string; reason: string }[];
  notes: string[];
  /** Open questions the pages left: settled by an agent, put to the owner (at most ASK_LIMIT, in one form `askId`), or left in the list. */
  questions: { id: string; slug: string; title: string; question: string }[];
  resolvedByAgent: number;
  moreInList: number;
  askId?: string;
};

const genKey = (id: string) => `wiki-gen:${id}`;
export const getGeneration = (app: App, id: string) => json<Generation | null>(one<{ value: string }>(app.db, "select value from kv where key = ?", genKey(id))?.value, null);
function saveGeneration(app: App, g: Generation) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", genKey(g.id), JSON.stringify(g));
}
const patchInput = (app: App, runId: string, patch: Record<string, unknown>) => {
  const r = one<{ input: string }>(app.db, "select input from runs where id = ?", runId);
  if (r) run(app.db, "update runs set input = ? where id = ?", JSON.stringify({ ...json<Record<string, unknown>>(r.input, {}), ...patch }), runId);
};

/** A generation's writing runs, queued together: settled (and reported) when the last one ends. */
export function startGeneration(app: App, input: { id?: string; spaceId: string; userId?: string | null; planRunId?: string; notes?: string[]; writes: { slug: string; title: string; runId: string }[] }) {
  const g: Generation = { id: input.id ?? newId("wg"), spaceId: input.spaceId, userId: input.userId ?? OWNER, planRunId: input.planRunId, startedAt: now(), pages: input.writes.map((w) => ({ slug: w.slug, title: w.title, runs: [w.runId] })), notes: input.notes ?? [] };
  saveGeneration(app, g);
  for (const w of input.writes) patchInput(app, w.runId, { generation: g.id });
  return g;
}

/** Questions the generation's writing runs left (by the run that recorded them). */
function generationQuestions(app: App, g: Generation) {
  const runs = g.pages.flatMap((p) => p.runs);
  if (!runs.length) return [];
  return all<{ id: string }>(app.db, `select id from wiki_questions where space_id = ? and run_id in (${runs.map(() => "?").join(",")})`, g.spaceId, ...runs).map((r) => r.id);
}

/**
 * Called when a writing or investigating run ends (runs.ts). Once all of a generation's writing runs
 * are done: a page that was not written is tried once more; then the questions the pages left are
 * investigated by an agent first (`wiki-resolve`); then one report goes out.
 */
export function settleWikiRun(app: App, r: Run) {
  if (r.kind === "wiki-resolve") {
    const g = (r.input as { generation?: string }).generation ? getGeneration(app, String((r.input as { generation?: string }).generation)) : null;
    return g && !g.reportedAt ? finish(app, g) : null;
  }
  if (r.kind !== "wiki-write" || !r.spaceId) return null;
  const input = r.input as WriteRunInput;
  const g: Generation = (input.generation && getGeneration(app, input.generation)) || {
    id: `solo-${r.id}`, spaceId: r.spaceId, userId: one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", r.id)?.user_id ?? OWNER, startedAt: r.createdAt, notes: [],
    pages: [{ slug: input.brief.slug, title: input.brief.title, runs: [r.id] }],
  };
  if (g.reportedAt || g.resolveRunId) return g.report ?? null;
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
    // A single page's retry gets a generation of its own, so it is reported when it ends.
    if (g.id.startsWith("solo-")) g.id = newId("wg");
    saveGeneration(app, g);
    for (const p of g.pages) patchInput(app, p.runs.at(-1)!, { generation: g.id });
    return null;
  }
  // Questions nobody has looked into yet: an agent first (code and originals often settle them).
  const open = listQuestions(app, { spaceId: g.spaceId, ids: generationQuestions(app, g), status: ["open"], limit: RESOLVE_LIMIT });
  if (open.length) {
    if (g.id.startsWith("solo-")) g.id = newId("wg");
    const resolve = createRun(app, { kind: "wiki-resolve", spaceId: g.spaceId, title: `查清未决问题（${open.length} 个）`, input: { questionIds: open.map((q) => q.id), generation: g.id }, parentId: g.planRunId ?? r.parentId, userId: g.userId });
    g.resolveRunId = resolve.id;
    saveGeneration(app, g);
    return null;
  }
  return finish(app, g);
}

function finish(app: App, g: Generation) {
  const report = generationReport(app, g);
  g.report = report;
  g.reportedAt = now();
  saveGeneration(app, g);
  deliverReport(app, g, report);
  if (g.planRunId && one(app.db, "select 1 from runs where id = ?", g.planRunId)) setRunOutput(app, g.planRunId, { report: g.report });
  saveGeneration(app, g);
  return g.report;
}

export function generationReport(app: App, g: Generation): GenerationReport {
  const report: GenerationReport = { written: [], fixed: 0, rejected: 0, restored: 0, open: [], missing: [], notes: [...g.notes], questions: [], resolvedByAgent: 0, moreInList: 0 };
  const titles = new Map(g.pages.map((p) => [p.slug, p.title]));
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
    for (const f of rec.open) if (f.kind !== "unsure") report.open.push({ slug: p.slug, title: p.title, text: `${f.problem}（“${truncate(f.quote, 40)}”）` });
    if (rec.status === "unchecked") report.open.push({ slug: p.slug, title: p.title, text: rec.notes.find((n) => n.startsWith("核对")) ?? "核对没有完成" });
    for (const n of rec.notes) if (!n.startsWith("核对") && !report.notes.includes(n)) report.notes.push(n);
  }
  const ids = generationQuestions(app, g);
  const qs = listQuestions(app, { spaceId: g.spaceId, ids, status: ["open", "needs-owner", "asked", "answered", "resolved", "dropped"] });
  report.resolvedByAgent = qs.filter((q) => q.status === "resolved").length;
  const owner = qs.filter((q) => q.status === "needs-owner");
  report.questions = owner.slice(0, ASK_LIMIT).map((q) => ({ id: q.id, slug: q.page, title: titles.get(q.page) ?? q.page, question: q.question }));
  report.moreInList = owner.length - report.questions.length + qs.filter((q) => q.status === "open").length;
  return report;
}

const pageLink = (spaceId: string, slug: string) => `#/wiki/${encodeURIComponent(spaceId)}/${slug.split("/").map(encodeURIComponent).join("/")}`;
export const questionsLink = (spaceId: string) => `#/wiki/${encodeURIComponent(spaceId)}?questions=1`;

/** The one message a generation sends: quiet (in-app only) when nothing is left for the owner. */
export function reportText(g: Generation, r: GenerationReport) {
  const lines: string[] = [];
  if (r.written.length) lines.push(`写了 ${r.written.length} 页：${r.written.slice(0, 12).map((p) => p.title).join("、")}${r.written.length > 12 ? ` 等` : ""}。`);
  const auto = r.fixed + r.rejected + r.restored;
  if (auto) lines.push(`自动修了 ${auto} 处：写入时拦下 ${r.rejected} 处、核对后改正 ${r.fixed} 处${r.restored ? `、补回入口 ${r.restored} 处` : ""}。`);
  if (r.resolvedByAgent) lines.push(`写作时拿不准的 ${r.resolvedByAgent} 个问题已经查清，写进了页面。`);
  const left = [...r.missing.map((m) => `- 没写成「${m.title}」：${m.reason}`), ...r.open.map((o) => `- 「${o.title}」${o.text} ${pageLink(g.spaceId, o.slug)}`), ...r.notes.map((n) => `- ${n}`)];
  if (left.length) lines.push(`还有 ${left.length} 条没解决：\n${left.slice(0, 20).join("\n")}${left.length > 20 ? `\n…另有 ${left.length - 20} 条，见运行详情` : ""}`);
  if (r.questions.length)
    lines.push(`要你定的问题（最重要的 ${r.questions.length} 个，回答后补进页面）：\n${r.questions.map((q) => `- 「${q.title}」${q.question}`).join("\n")}`);
  if (r.moreInList) lines.push(`另有 ${r.moreInList} 个未决问题留在 Wiki 的未决问题清单里，不着急：${questionsLink(g.spaceId)}`);
  if (!left.length && !r.questions.length) lines.push("没有需要你看的。");
  return lines.join("\n");
}

function deliverReport(app: App, g: Generation, r: GenerationReport) {
  const left = r.missing.length + r.open.length + r.notes.length;
  const name = findSpace(app, g.spaceId)?.name ?? g.spaceId;
  // The few questions for the owner go in as one form, opened from this message (afterReply: not announced on its own).
  if (r.questions.length) {
    const items = r.questions.map((q, i) => ({ field: `q${i + 1}`, ...q }));
    const ask = createAsk(app, {
      runId: g.planRunId ?? null, conversationId: null, userId: g.userId, kind: "question",
      question: `Wiki「${name}」写作时查不清、只有你能定的 ${items.length} 个问题。能答的写一下，答了的会补进对应页面；不知道的留空，问题留在清单里。`,
      allowText: false,
      ui: { fields: items.map((q) => ({ id: q.field, type: "textarea" as const, label: truncate(`「${q.title}」${q.question}`, 200), required: false })), submitLabel: "补进页面" },
      context: { handler: "wiki-questions", afterReply: true, spaceId: g.spaceId, items },
    });
    r.askId = ask.id;
    for (const q of r.questions) updateQuestion(app, q.id, { status: "asked", askId: ask.id });
  }
  try {
    notify(app, {
      title: left || r.questions.length ? `Wiki「${name}」写完了，${[left ? `${left} 条要你看` : "", r.questions.length ? `${r.questions.length} 个问题要你定` : ""].filter(Boolean).join("，")}` : `Wiki「${name}」写完了 ${r.written.length} 页`,
      body: reportText(g, r),
      link: r.askId ? `#/ui/${r.askId}` : r.open[0] ? pageLink(g.spaceId, r.open[0].slug) : `#/wiki/${encodeURIComponent(g.spaceId)}`,
      userId: g.userId,
      runId: g.planRunId ?? null,
      urgency: left || r.questions.length ? "normal" : "silent",
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

// ---------------------------------------------------------------- answers and investigations

/**
 * The owner's answers go into the pages: one writing run per page, told the questions and answers
 * (a generation of its own, checked like any other); each question is resolved once its page is saved.
 */
export async function writeAnswers(app: App, spaceId: string, answered: { id: string; answer: string }[], userId: string) {
  const qs = answered.map((a) => updateQuestion(app, a.id, { status: "answered", answer: a.answer.trim() })).filter((q): q is NonNullable<typeof q> => !!q);
  const pages = [...new Set(qs.map((q) => q.page))].filter((slug) => pageExists(app, spaceId, slug));
  if (!pages.length) return [];
  const focus = [
    "本人回答了这页挂着的未决问题。把回答确认了的内容写进页面，写成肯定的结论，别的内容保留；回答里没说清的仍然不写。",
    ...qs.filter((q) => pages.includes(q.page)).map((q) => `- [[${q.page}]] 问：${q.question}\n  答：${q.answer}`),
  ].join("\n");
  const { generateWiki } = await import("./generate.ts");
  const r = generateWiki(app, { spaceId, pages, focus, userId });
  const runs = (r as { writeRuns?: string[] }).writeRuns ?? [];
  for (const id of runs) {
    const slug = (getRun(app, id).input as { brief: { slug: string } }).brief.slug;
    patchInput(app, id, { questionIds: qs.filter((q) => q.page === slug).map((q) => q.id) });
  }
  return runs;
}

registerAskHandler("wiki-questions", async (app, ask, context) => {
  const { spaceId, items } = context as { spaceId: string; items: { field: string; id: string }[] };
  const value = (ask.value ?? {}) as Record<string, unknown>;
  const answered = items.map((q) => ({ id: q.id, answer: String(value[q.field] ?? "").trim() })).filter((q) => q.answer);
  // Left blank: back on the list, to be asked another time.
  for (const q of items) if (!answered.some((a) => a.id === q.id) && getQuestion(app, q.id)?.status === "asked") updateQuestion(app, q.id, { status: "needs-owner", askId: null });
  if (answered.length) await writeAnswers(app, spaceId, answered, ask.userId);
});

/** Queue an investigation of a space's questions nobody has looked into yet (at most RESOLVE_LIMIT). */
export function queueResolve(app: App, spaceId: string, opts: { userId?: string; limit?: number } = {}) {
  const busy = one<{ id: string }>(app.db, "select id from runs where kind = 'wiki-resolve' and space_id = ? and status in ('queued','running')", spaceId);
  if (busy) return { runId: busy.id, questions: 0, already: true };
  const open = listQuestions(app, { spaceId, status: ["open"], limit: Math.min(opts.limit ?? RESOLVE_LIMIT, RESOLVE_LIMIT) });
  if (!open.length) return { runId: null, questions: 0 };
  const r = createRun(app, { kind: "wiki-resolve", spaceId, title: `查清未决问题（${open.length} 个）`, input: { questionIds: open.map((q) => q.id) }, userId: opts.userId ?? OWNER });
  return { runId: r.id, questions: open.length };
}

/**
 * An agent looks into the questions before anyone asks the owner: it reads the code and originals,
 * writes what it settles into the page and closes the question, and marks the rest as the owner's.
 */
registerHandler("wiki-resolve", async (ctx) => {
  const app = ctx.app;
  const spaceId = ctx.run.spaceId!;
  const ids = (ctx.run.input as { questionIds?: string[] }).questionIds ?? [];
  const qs = listQuestions(app, { spaceId, ids, status: ["open"] });
  if (!qs.length) return { quiet: true, summary: "没有要查的问题" };
  const byPage = new Map<string, typeof qs>();
  for (const q of qs) byPage.set(q.page, [...(byPage.get(q.page) ?? []), q]);
  const task = [
    `空间 ${spaceId} 的 Wiki 页面挂着 ${qs.length} 个未决问题（写作时拿不准、没有写进页面的）。在问本人之前，你先查：`,
    "- 每条去读代码（find_symbol、read_source）和原件（search、读引用的原件全文），很多看了就能定。",
    "- 查清了：read_page 读那一页，把结论写进合适的段落（带引用，其余内容不动），write_page 整页提交；然后 settle_wiki_question(id, outcome=resolved, note=写进了哪一段、依据)。",
    "- 查不清、只有本人能定的（口径、取舍、没有记录的约定）：settle_wiki_question(id, outcome=needs-owner, importance=1~3, note=查过哪里、为什么定不了)。importance 3 是不定就会误导读者的。",
    "- 每一条都要 settle。页面里不写“待确认”。",
    ...[...byPage].map(([page, list]) => `## [[${page}]]\n${questionsText(list)}`),
  ].join("\n");
  const readSpaces = [...new Set([spaceId, ...relatedIds(app, spaceId)])];
  const userId = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", ctx.run.id)?.user_id ?? OWNER;
  const r = await role(ctx, "wiki-writer", spaceId, task, { spaces: [spaceId], readSpaces: scopeFor(app, userId, readSpaces) ?? readSpaces });
  // Anything it did not settle is the owner's to decide.
  for (const q of listQuestions(app, { spaceId, ids, status: ["open"] })) updateQuestion(app, q.id, { status: "needs-owner", note: "调查运行没有给出结论" });
  const after = listQuestions(app, { spaceId, ids, status: ["resolved", "needs-owner"] });
  return { summary: r.text.trim(), resolved: after.filter((q) => q.status === "resolved").length, needsOwner: after.filter((q) => q.status === "needs-owner").length };
});

// ---------------------------------------------------------------- rechecking existing pages

/** Pages per recheck batch, and the most one batch may take. */
export const RECHECK_BATCH = 10;
export const RECHECK_MAX = 50;
const RECHECK_FOCUS =
  "重新核对这一页，按现在的写法要求修整：去掉整理过程（“本次整理”“经核对”）和结论上的退路（“可能”“以实际为准”“建议进一步确认”），流水记录提炼成结论或移出，拿不准的内容从页面拿掉、交成 questions，超长的拆开。事实、引用和结构不动，没有问题的段落原样保留。";

/** Pages of a space never checked (no check record), oldest first: put through writing and checking, a batch at a time. */
export async function recheckPages(app: App, spaceId: string, opts: { limit?: number; userId?: string } = {}) {
  const limit = Math.max(1, Math.min(opts.limit ?? RECHECK_BATCH, RECHECK_MAX));
  const waiting = listPages(app, spaceId)
    .filter((p) => p.slug !== "index" && !p.slug.endsWith("/index") && p.kind !== "index" && !pageChecks(app, spaceId, p.slug).length)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  const pages = waiting.slice(0, limit).map((p) => p.slug);
  if (!pages.length) return { pages: [], writeRuns: [], remaining: 0 };
  // Not two batches of the same pages at once.
  const busy = new Set(all<{ input: string }>(app.db, "select input from runs where kind = 'wiki-write' and space_id = ? and status in ('queued','running')", spaceId).map((r) => json<{ brief?: { slug?: string } }>(r.input, {}).brief?.slug));
  const take = pages.filter((p) => !busy.has(p));
  if (!take.length) return { pages: [], writeRuns: [], remaining: waiting.length };
  const { generateWiki } = await import("./generate.ts");
  const r = generateWiki(app, { spaceId, pages: take, focus: RECHECK_FOCUS, userId: opts.userId });
  return { pages: take, writeRuns: (r as { writeRuns?: string[] }).writeRuns ?? [], remaining: waiting.length - take.length };
}
