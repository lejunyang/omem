import { execFile } from "node:child_process";
import { posix } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { getRun } from "./runs.ts";
import type { Check } from "./code.ts";

export const lessonInput = z.object({
  text: z.string().trim().min(10).max(200),
  pattern: z.string().max(200).nullable().optional(),
  paths: z.string().max(500).nullable().optional(),
});
export type Evidence = { run: string; finding?: number; note?: string };
export type Lesson = { id: string; space_id: string; text: string; pattern: string | null; paths: string | null; state: "proposed" | "on" | "off"; evidence: Evidence[]; hits: number; last_hit_at: string | null; created_by: string; created_at: string; updated_at: string; announced: number };
type Stored = Omit<Lesson, "evidence"> & { evidence: string };
const decode = (r: Stored): Lesson => ({ ...r, evidence: JSON.parse(r.evidence) });
const normalized = (s: string) => s.replace(/[\s\p{P}]/gu, "");
export function repository(app: App, space: string) {
  if (findSpace(app, space)?.kind !== "repo") throw new HttpError(400, "约定只能写入仓库空间");
}
function validate(app: App, space: string, input: z.input<typeof lessonInput>) {
  repository(app, space);
  const v = lessonInput.parse(input);
  if (v.pattern) try { new RegExp(v.pattern, "u"); } catch { throw new HttpError(400, "pattern 必须是有效的 JavaScript 正则表达式源码（不带标志）"); }
  if (v.paths && v.paths.split(",").some(p => !p.trim() || p.trim().startsWith("/") || p.includes("..") || /[^\p{L}\p{N}_./*? -]/u.test(p)))
    throw new HttpError(400, "paths 只接受逗号分隔的相对路径 glob（*、**、?）");
  return { text: v.text, pattern: v.pattern || null, paths: v.paths?.trim() || null };
}
export function listLessons(app: App, space: string, opts: { states?: Lesson["state"][] } = {}) {
  repository(app, space);
  const states = opts.states ?? ["proposed", "on", "off"];
  if (!states.length) return [];
  // Each state is a bounded walk of the covering order, even after several devices merge their lists.
  return [...new Set(states)].flatMap(state => all<Stored>(app.db,
    "select * from repo_lessons where space_id=? and state=? order by hits desc, created_at desc limit 300", space, state))
    .sort((a,b) => Number(b.state === "proposed") - Number(a.state === "proposed") || b.hits - a.hits || b.created_at.localeCompare(a.created_at))
    .slice(0,300).map(decode);
}
function lessonOf(app: App, space: string, id: string) {
  const r = one<Stored>(app.db, "select * from repo_lessons where space_id = ? and id = ?", space, id);
  if (!r) throw new HttpError(404, "没有这条仓库约定");
  return decode(r);
}
export function saveLesson(app: App, space: string, input: z.input<typeof lessonInput> & { id?: string; state?: Lesson["state"] }) {
  const v = validate(app, space, input);
  const existing = input.id ? lessonOf(app, space, input.id) : null;
  const state = z.enum(["proposed", "on", "off"]).parse(input.state ?? existing?.state ?? "on");
  const at = now();
  const id = input.id ?? newId("lesson");
  if (input.id) {
    run(app.db, "update repo_lessons set text=?, pattern=?, paths=?, state=?, updated_at=? where id=? and space_id=?", v.text, v.pattern, v.paths, state, at, id, space);
  } else {
    if (listLessons(app, space).length >= 300) throw new HttpError(400, "每个仓库最多保留 300 条约定，请先整理");
    run(app.db, "insert into repo_lessons(id,space_id,text,pattern,paths,state,created_by,created_at,updated_at) values(?,?,?,?,?,?,?,?,?)", id, space, v.text, v.pattern, v.paths, state, "owner", at, at);
  }
  app.emit({ type: "changed", entity: "space", id: space });
  return lessonOf(app, space, id);
}
export function removeLesson(app: App, space: string, id: string) {
  repository(app, space); lessonOf(app, space, id);
  run(app.db, "delete from repo_lessons where space_id=? and id=?", space, id);
  app.emit({ type: "changed", entity: "space", id: space });
}
/** Follow only a bounded parent chain, never search runs by JSON on the request path. */
export function codeRoot(app: App, id?: string | null): string | null {
  for (let n = 0; id && n < 12; n++) {
    const r = getRun(app, id);
    if (r.kind === "code" && typeof r.input.helperOf === "string") { id = r.input.helperOf; continue; }
    if (r.kind === "code") return String(r.input.continueFrom ?? r.id);
    id = typeof r.input.codeRunId === "string" ? r.input.codeRunId : r.parentId;
  }
  return null;
}
/** A finding counts as accepted once review-lead took it or the owner decided it is to be fixed (now or later). */
const ACCEPTED = "(f.decision in ('fix','later') or (f.decision is not 'wontfix' and f.state in ('accepted','fixed')))";
type FindingHome = { file_path: string | null; root_run: string; repos: string | null; space_id: string | null };
const HOME = "f.file_path, coalesce(json_extract(x.input, '$.continueFrom'), x.id) root_run, json_extract(x.input, '$.repos') repos, x.space_id";
/** The repository spaces a finding is about: the one its path names (several repositories in one delegation), else all of the delegation's. */
function reposOf(r: FindingHome): string[] {
  const repos = r.repos ? (JSON.parse(r.repos) as string[]) : r.space_id ? [r.space_id] : [];
  const named = repos.find((s) => r.file_path?.startsWith(`${s}/`));
  return named ? [named] : repos;
}
export function proposeLesson(app: App, by: string, input: z.input<typeof lessonInput> & { space: string; findings?: number[]; note?: string; runId?: string | null }) {
  const v = validate(app, input.space, input);
  const evidence: Evidence[] = [];
  for (const finding of z.array(z.number().int().positive()).max(30).parse(input.findings ?? [])) {
    // Three primary-key lookups: the finding, its review, the review's code run.
    const r = one<FindingHome>(app.db, `select ${HOME} from review_findings f join reviews r on r.id = f.review_id join runs x on x.id = r.code_run_id where f.id = ?`, finding);
    if (!r || !reposOf(r).includes(input.space)) throw new HttpError(400, `问题 #${finding} 不属于该仓库空间`);
    evidence.push({ run: r.root_run, finding, ...(input.note ? { note: input.note.slice(0, 500) } : {}) });
  }
  const root = codeRoot(app, input.runId);
  if (root) {
    const r = getRun(app, root);
    const repos = (r.input.repos as string[] | undefined) ?? [r.spaceId];
    if (!repos.includes(input.space)) throw new HttpError(403, "当前交办不属于该仓库空间");
    evidence.push({ run: root, ...(input.note ? { note: input.note.slice(0, 500) } : {}) });
  }
  return tx(app.db, () => {
    const found = listLessons(app, input.space).find(l => normalized(l.text) === normalized(v.text) || !!v.pattern && l.pattern === v.pattern);
    const byRun = new Map<string, Evidence>();
    for (const e of [...(found?.evidence ?? []), ...evidence]) byRun.set(e.run, { ...byRun.get(e.run), ...e });
    const merged = [...byRun.values()].slice(-100);
    const auto = (app.config.review.lessons?.auto ?? true);
    const state = found?.state === "off" ? "off" : found?.state === "on" || auto && merged.length >= 2 ? "on" : "proposed";
    const id = found?.id ?? newId("lesson");
    const at = now();
    if (found) run(app.db, "update repo_lessons set evidence=?, state=?, updated_at=? where id=?", JSON.stringify(merged), state, at, id);
    else {
      if (listLessons(app, input.space).length >= 300) throw new HttpError(400, "每个仓库最多保留 300 条约定，请先整理");
      run(app.db, "insert into repo_lessons(id,space_id,text,pattern,paths,state,evidence,created_by,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)", id, input.space, v.text, v.pattern, v.paths, state, JSON.stringify(merged), by, at, at);
    }
    const lesson = lessonOf(app, input.space, id);
    if (state === "on" && found?.state !== "on" && !lesson.announced) {
      run(app.db, "update repo_lessons set announced=1 where id=?", id);
      notify(app, { title: "仓库学到一条约定", body: `${lesson.text}${lesson.pattern ? `\n模式：${lesson.pattern}` : ""}\n同类问题在两次交办里出现，已自动启用。可在这个空间的设置 → 学到的约定里关闭。`, urgency: "later", link: `#/settings?tab=spaces&space=${encodeURIComponent(input.space)}` });
    }
    app.emit({ type: "changed", entity: "space", id: input.space });
    return { ...lessonOf(app, input.space, id), ...(state === "proposed" ? { reason: !auto ? "自动启用已关闭；可由本人在空间设置里启用" : merged.length === 0 ? "尚无交办证据；可由本人在空间设置里启用" : merged.length < 2 ? "只有一次交办里出现过；再出现一次会自动生效，或本人在空间设置里打开" : "等待本人启用" } : {}) };
  });
}
export const LESSON_HEADING = "这个仓库学到的约定（以前的评审里采纳过、再犯会被检查拦下）";
export function lessonsText(app: App, spaces: string[]) {
  return [...new Set(spaces)].filter(s => findSpace(app, s)?.kind === "repo").map(space => {
    const lessons = listLessons(app, space, { states: ["on"] }).slice(0, (app.config.review.lessons?.max ?? 30));
    return lessons.length ? `## ${LESSON_HEADING}\n\n仓库：${space}\n${lessons.map(l => `- lesson:${l.id}：${l.text}`).join("\n")}\n\n只有带模式的约定由宿主机械检查；其余也要遵守。评审可在 detail 或 evidence 里引用 lesson:<id>。` : "";
  }).filter(Boolean).join("\n\n");
}
export function bumpLessonRefs(app: App, spaces: string[], text: string) {
  const ids = [...new Set([...text.matchAll(/lesson:([\w-]+)/g)].map(m => m[1]))].slice(0, 100);
  for (const space of spaces) for (const id of ids) run(app.db, "update repo_lessons set hits=hits+1, last_hit_at=?, updated_at=? where space_id=? and id=?", now(), now(), space, id);
}
/** Dice overlap of normalized character bigrams; location only boosts a title that already overlaps. */
export function titleCloseness(a: string, b: string, fileA?: string | null, fileB?: string | null) {
  const grams = (s: string) => { const c = [...normalized(s)]; return new Set(c.slice(1).map((v, i) => c[i] + v)); };
  const x = grams(a), y = grams(b);
  const overlap = [...x].filter(v => y.has(v)).length;
  const score = 2 * overlap / (x.size + y.size || 1);
  return score + (score >= 0.2 && fileA && fileB && (fileA === fileB || posix.dirname(fileA) === posix.dirname(fileB)) ? 0.15 : 0);
}
export function previousLessonMaterial(app: App, space: string, root: string, findings: { id: number; title: string; file_path: string | null }[]) {
  repository(app, space);
  const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
  // Reviews are few (hundreds a month): the accepted findings of the last 90 days are read once, newest
  // first and capped, and narrowed to this repository here. No table of their own to keep in step.
  const rows = all<FindingHome & { id: number; title: string; created_at: string }>(app.db,
    `select f.id, f.title, r.created_at, ${HOME} from reviews r join runs x on x.id = r.code_run_id join review_findings f on f.review_id = r.id
      where r.created_at >= ? and ${ACCEPTED} order by r.created_at desc, f.id desc limit 3000`, cutoff)
    .filter((r) => r.root_run !== root && reposOf(r).includes(space)).slice(0, 300);
  const titles = new Map<string, string>();
  const workTitle = (id: string) => titles.get(id) ?? (titles.set(id, one<{ title: string }>(app.db, "select title from runs where id = ?", id)?.title ?? id), titles.get(id)!);
  const lines: string[] = [];
  for (const f of findings.slice(0, 30)) {
    const close = rows.map(r => ({ r, score: titleCloseness(f.title, r.title, f.file_path, r.file_path) })).filter(v => v.score >= 0.45).sort((a,b) => b.score-a.score).slice(0,2);
    for (const { r } of close) if (lines.length < 12) lines.push(`- 本轮 #${f.id} ↔ #${r.id}：${r.title.slice(0,200)}；${r.file_path?.slice(0,160) ?? "未写文件"}；交办「${workTitle(r.root_run).slice(0,100)}」 ${r.created_at.slice(0,10)}`);
  }
  const lessons = listLessons(app, space, { states: ["on", "proposed"] }).slice(0, 20);
  if (!lines.length && !lessons.length) return "";
  return `## 这个仓库以往采纳过的同类问题\n\n仓库：${space}\n${lines.join("\n")}\n${lessons.map(l => `- 已有约定 lesson:${l.id}（${l.state}）：${l.text}`).join("\n")}\n\n标题相近只供对照，由你判断是否同类。确有可复用的约定时用 propose_repo_lesson（space、text、findings；能机械表达才给 pattern 和 paths）；已有的不要重复提。`;
}

export type LessonHit = { lesson: Lesson; file: string; line: number; text: string };
/** Bounded subprocess output, no textconv / external diff; names come from git, never a shell. */
function boundedGit(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => execFile("git", ["--literal-pathspecs", ...args], { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 15_000, windowsHide: true }, (err, out) => err ? reject(err) : resolve(out)));
}
function glob(pattern: string, file: string) {
  // Segment DP keeps repeated wildcards bounded too; model-provided globs never become host regexps.
  const segments = file.split("/");
  let previous = segments.map(() => false); previous.unshift(true);
  const segmentMatch = (p: string, text: string) => {
    let row = new Array<boolean>(text.length + 1).fill(false); row[0] = true;
    for (const c of p) {
      const next = new Array<boolean>(text.length + 1).fill(false);
      if (c === "*") next[0] = row[0];
      for (let j = 1; j <= text.length; j++) next[j] = c === "*" ? row[j] || next[j-1] : row[j-1] && (c === "?" || c === text[j-1]);
      row = next;
    }
    return row[text.length];
  };
  for (const p of pattern.split("/")) {
    const next = new Array<boolean>(segments.length + 1).fill(false);
    if (p === "**") next[0] = previous[0];
    for (let j = 1; j <= segments.length; j++) next[j] = p === "**" ? previous[j] || next[j-1] : previous[j-1] && segmentMatch(p, segments[j-1]);
    previous = next;
  }
  return previous[segments.length];
}
export async function lessonHits(app: App, space: string, worktreePath: string, base: string, head: string): Promise<LessonHit[]> {
  const lessons = listLessons(app, space, { states: ["on"] }).filter(l => l.pattern);
  if (!lessons.length) return [];
  const range = head ? [base, head] : [base];
  const names = (await boundedGit(worktreePath, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--numstat", "-z", ...range, "--"])).split("\0").filter(Boolean);
  const lines: { file: string; line: number; text: string; lessons: string[] }[] = [];
  let examined = 0;
  for (const entry of names) {
    if (examined >= 5000) break;
    const match = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(entry);
    if (!match || Number(match[1]) === 0) continue; // Binary files use '-' in numstat.
    const file = match[3];
    const applicable = lessons.filter(l => !l.paths || l.paths.split(",").some(p => glob(p.trim(), file))).map(l => l.id);
    if (!applicable.length) { examined += Math.min(Number(match[1]), 5000 - examined); continue; }
    // Count all added lines, including files to which no lesson applies, toward the round cap.
    const size = head ? Number((await boundedGit(worktreePath, ["cat-file", "-s", `${head}:${file}`])).trim()) : (await import("node:fs/promises")).stat(posix.join(worktreePath.replaceAll("\\", "/"), file)).then(s => s.size);
    if (await size > 400 * 1024) continue;
    const diff = await boundedGit(worktreePath, ["-c", "core.quotePath=false", "diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", ...range, "--", file]);
    let line = 0;
    let inHunk = false;
    for (const row of diff.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
      if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
      if (inHunk && row.startsWith("+")) { lines.push({ file, line: line++, text: row.slice(1, 501), lessons: applicable }); examined++; if (examined >= 5000) break; }
      else if (row.startsWith(" ")) line++;
    }
  }
  // A model-supplied regexp cannot block the server's main thread (catastrophic backtracking).
  const hits = await new Promise<{ id: string; index: number }[]>((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData: d } = require('node:worker_threads');
      const hits=[]; for (const l of d.lessons) { const re=new RegExp(l.pattern,'u'); let n=0;
        for(let i=0;i<d.lines.length;i++) if(d.lines[i].lessons.includes(l.id) && re.test(d.lines[i].text)) { hits.push({id:l.id,index:i}); if(++n===20) break; }
      } parentPort.postMessage(hits);`, { eval: true, workerData: { lessons, lines } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("约定模式检查超时，请在空间设置里修改模式")); }, 2000);
    worker.once("message", v => { clearTimeout(timer); void worker.terminate(); resolve(v); });
    worker.once("error", e => { clearTimeout(timer); reject(e); });
  });
  const result = hits.map(h => { const { file, line, text } = lines[h.index]; return { lesson: lessons.find(l => l.id === h.id)!, file, line, text }; });
  for (const lesson of lessons) {
    const count = hits.filter(h => h.id === lesson.id).length;
    if (count) run(app.db, "update repo_lessons set hits=hits+?, last_hit_at=?, updated_at=? where id=?", count, now(), now(), lesson.id);
  }
  return result;
}
/** The existing Check is the only carrier to task-loop fixes, reviewers, latestCheck and the run page. */
export async function checkLessons(app: App, space: string, dir: string, base: string, head: string, check: Check | null): Promise<Check | null> {
  if (!listLessons(app, space, { states: ["on"] }).some(l => l.pattern)) return check;
  let block = "";
  let failed = "";
  try {
    const hits = await lessonHits(app, space, dir, base, head);
    block = hits.map(h => `学到的约定（宿主按新增的行检查）：${h.lesson.text} — ${h.file}:${h.line} [lesson:${h.lesson.id}]\n  ${h.text}`).join("\n");
  } catch (e) {
    // The host could not run the check (a pattern that takes too long, git failing): not something the coder can fix.
    failed = `学到的约定这一轮没有查成（${(e as Error).message}），不算检查失败。`;
    console.warn(`[omem] 仓库 ${space} 的约定检查没有查成：${(e as Error).message}`);
  }
  if (!block && !failed) return check;
  return { ...(check ?? { command: "学到的约定", code: 0, output: "", ms: 0, base, at: now() }), ...(block ? { code: check?.code || 1 } : {}), output: [check?.output, block, failed].filter(Boolean).join("\n\n").slice(-12000) };
}
