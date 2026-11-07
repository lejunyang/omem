import { randomBytes } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now, sameSecret } from "../core/util.ts";
import { getRun } from "./runs.ts";

/**
 * Run artifacts (docs/v2/artifacts.md): screenshots, recordings, test reports and logs a run hands
 * in, kept under <home>/artifacts/<id>/ so they outlive the workspace, and shown on the run (on a
 * delegation: by task). They come in two ways:
 *
 * - a folder: the run's agent and the commands the host runs for it (checks) get `OMEM_ARTIFACTS`,
 *   an inbox the host empties when the agent finishes a task (`finish_task`), when its turn ends and
 *   after each command. A top folder `T<n>` puts what is in it on that task; other folders group;
 *   a folder with an index.html is one page (a test report) with its files.
 * - `attach_artifact`: a file or folder in the workspace (or the inbox), with a caption, a task
 *   and a requirement point.
 *
 * Served at /api/artifacts/<id>.<key>/<path>: the key is the capability (a report's own files are
 * fetched by relative URL, from a sandboxed page that carries no cookie), the list of a run is
 * behind the run's permission. Pages and SVG are sandboxed (no access to omem's origin).
 */

export type ArtifactKind = "image" | "video" | "html" | "site" | "text" | "file";
export type ArtifactSource = "agent" | "check" | "command";
export type Artifact = {
  id: string;
  runId: string;
  workId: string | null;
  spaceId: string | null;
  task: number | null;
  req: string | null;
  /** As handed in, below the inbox (its group folders included) or the file's own name. */
  name: string;
  caption: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  /** The file to open: the file itself, or a page's index.html. */
  entry: string;
  source: ArtifactSource;
  createdBy: string;
  createdAt: string;
  url: string;
};

const MB = 1024 * 1024;
/** One file at most (a screen recording of a few minutes fits). */
export const MAX_FILE = 200 * MB;
/** One delegation (or one run outside one) at most, all its artifacts together. */
export const MAX_WORK = 4096 * MB;
/** Files taken in one go (an inbox, a folder handed in), and files of one page (a test report). */
const MAX_FILES = 300;
const MAX_PAGE_FILES = 5000;

const TYPES: Record<string, [ArtifactKind, string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  svg: ["image", "image/svg+xml"],
  mp4: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  html: ["html", "text/html; charset=utf-8"],
  htm: ["html", "text/html; charset=utf-8"],
  txt: ["text", "text/plain; charset=utf-8"],
  log: ["text", "text/plain; charset=utf-8"],
  md: ["text", "text/plain; charset=utf-8"],
  json: ["text", "application/json; charset=utf-8"],
  csv: ["text", "text/plain; charset=utf-8"],
  xml: ["text", "text/plain; charset=utf-8"],
  yaml: ["text", "text/plain; charset=utf-8"],
  yml: ["text", "text/plain; charset=utf-8"],
  pdf: ["file", "application/pdf"],
  zip: ["file", "application/zip"],
};
/** What a page's own files are served as (scripts, styles, fonts besides the kinds above). */
const PAGE_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  map: "application/json; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  ico: "image/x-icon",
  wasm: "application/wasm",
};
const ext = (name: string) => extname(name).slice(1).toLowerCase();
export const mimeOf = (name: string) => TYPES[ext(name)]?.[1] ?? PAGE_TYPES[ext(name)] ?? "application/octet-stream";
const kindOf = (name: string): ArtifactKind => TYPES[ext(name)]?.[0] ?? "file";

type Row = {
  id: string; key: string; run_id: string; work_id: string | null; space_id: string | null; task: number | null; req: string | null;
  name: string; caption: string; kind: ArtifactKind; mime: string; size: number; entry: string; source: ArtifactSource; created_by: string; created_at: string;
};
const urlOf = (r: Pick<Row, "id" | "key" | "entry">) => `/api/artifacts/${r.id}.${r.key}/${r.entry.split("/").map(encodeURIComponent).join("/")}`;
const toArtifact = (r: Row): Artifact => ({
  id: r.id, runId: r.run_id, workId: r.work_id, spaceId: r.space_id, task: r.task, req: r.req, name: r.name, caption: r.caption, kind: r.kind,
  mime: r.mime, size: r.size, entry: r.entry, source: r.source, createdBy: r.created_by, createdAt: r.created_at, url: urlOf(r),
});

const store = (app: App, id = "") => join(app.home, "artifacts", id);
/** Where an artifact's file (or a page's entry) is on this machine: for an agent that reads images. */
export const artifactPath = (app: App, a: Pick<Artifact, "id" | "entry">) => join(store(app, a.id), ...a.entry.split("/"));

/** The delegation a run belongs to (a round, a review of it, a helper of a round), or null. */
export async function workOf(app: App, runId: string): Promise<string | null> {
  const r = getRun(app, runId);
  const { workRootOf } = await import("./code-tasks.ts");
  if (r.kind === "code" || r.kind === "review") return workRootOf(app, runId);
  const helperOf = (r.input as { helperOf?: unknown }).helperOf;
  return typeof helperOf === "string" ? workRootOf(app, helperOf) : null;
}

/** The folder a run's agent and the host's commands for it put artifacts in (`OMEM_ARTIFACTS`). */
export function artifactInbox(app: App, runId: string): string {
  const dir = join(store(app, "inbox"), runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Meta = { task?: number | null; req?: string | null; caption?: string; source: ArtifactSource; by: string };

/** Bytes a delegation (or a run outside one) already keeps. */
const used = (app: App, runId: string, workId: string | null) =>
  one<{ n: number }>(app.db, workId ? "select coalesce(sum(size), 0) n from run_artifacts where work_id = ?" : "select coalesce(sum(size), 0) n from run_artifacts where run_id = ? and work_id is null", workId ?? runId)!.n;

/** Files under a folder (no links, no hidden ones), bounded. */
function filesUnder(dir: string, limit: number): { rel: string; size: number }[] | null {
  const out: { rel: string; size: number }[] = [];
  const walk = (d: string, prefix: string): boolean => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) {
        if (!walk(full, rel)) return false;
      } else if (st.isFile()) {
        out.push({ rel, size: st.size });
        if (out.length > limit) return false;
      }
    }
    return true;
  };
  return walk(dir, "") ? out : null;
}

/**
 * One artifact from a file or a page folder (with index.html). `move`: taken out of the inbox;
 * otherwise copied (a file in the workspace stays where it is). Returns null and a reason when it
 * is too big or the delegation is full.
 */
function take(app: App, runId: string, workId: string | null, spaceId: string | null, from: string, name: string, meta: Meta, move: boolean): { artifact: Artifact | null; skipped?: string } {
  const st = lstatSync(from);
  const page = st.isDirectory();
  const files = page ? filesUnder(from, MAX_PAGE_FILES) : null;
  if (page && !files) return { artifact: null, skipped: `${name}：文件超过 ${MAX_PAGE_FILES} 个` };
  const size = page ? files!.reduce((n, f) => n + f.size, 0) : st.size;
  if (size > (page ? MAX_WORK / 4 : MAX_FILE)) return { artifact: null, skipped: `${name}：${Math.round(size / MB)} MB，超过上限` };
  if (used(app, runId, workId) + size > MAX_WORK) return { artifact: null, skipped: `${name}：这次交办的产物已到 ${MAX_WORK / MB} MB 上限` };
  const id = newId("af");
  const entry = page ? "index.html" : basename(from);
  const dest = store(app, id);
  mkdirSync(dest, { recursive: true });
  const target = page ? dest : join(dest, entry);
  try {
    if (move) {
      try {
        if (page) {
          rmSync(dest, { recursive: true, force: true });
          renameSync(from, dest);
        } else renameSync(from, target);
      } catch {
        if (page) cpSync(from, dest, { recursive: true });
        else copyFileSync(from, target);
      }
    } else if (page) cpSync(from, dest, { recursive: true, filter: (src) => !basename(src).startsWith(".") && !lstatSync(src).isSymbolicLink() });
    else copyFileSync(from, target);
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    return { artifact: null, skipped: `${name}：${(e as Error).message}` };
  }
  const kind: ArtifactKind = page ? "site" : kindOf(entry);
  const row: Row = {
    id, key: randomBytes(18).toString("base64url"), run_id: runId, work_id: workId, space_id: spaceId, task: meta.task ?? null, req: meta.req ?? null,
    name, caption: (meta.caption ?? "").slice(0, 500), kind, mime: page ? "text/html; charset=utf-8" : mimeOf(entry), size, entry, source: meta.source, created_by: meta.by, created_at: now(),
  };
  run(app.db, `insert into run_artifacts (id, key, run_id, work_id, space_id, task, req, name, caption, kind, mime, size, entry, source, created_by, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.id, row.key, row.run_id, row.work_id, row.space_id, row.task, row.req, row.name, row.caption, row.kind, row.mime, row.size, row.entry, row.source, row.created_by, row.created_at);
  return { artifact: toArtifact(row) };
}

/** A task's number from an inbox path's first folder (`T3/…`), and the rest. */
function taskFolder(rel: string): { task: number | null; rest: string } {
  const m = /^[Tt](\d+)\/(.+)$/.exec(rel);
  return m ? { task: Number(m[1]), rest: m[2] } : { task: null, rest: rel };
}

/**
 * Everything in a folder as artifacts: each file, each page folder (index.html) as one. Folder
 * names stay in the names (they group); a top folder `T<n>` names the task instead. `meta.task`
 * puts all on one task (handed in for it); `fallback`: the task of what no folder names.
 */
async function takeFolder(app: App, runId: string, dir: string, meta: Meta & { fallback?: number | null }, move: boolean, prefix = ""): Promise<{ made: Artifact[]; skipped: string[] }> {
  const workId = await workOf(app, runId);
  const spaceId = getRun(app, runId).spaceId;
  const made: Artifact[] = [];
  const skipped: string[] = [];
  const isTask = await taskCheck(app, workId);
  let count = 0;
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(d, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (st.isDirectory() && !existsSync(join(full, "index.html"))) {
        walk(full, path);
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) continue;
      if (++count > MAX_FILES) {
        skipped.push(`${path}：一次最多收 ${MAX_FILES} 个`);
        continue;
      }
      const folder = taskFolder(path);
      const named = folder.task !== null && isTask(folder.task);
      const task = meta.task != null ? meta.task : named ? folder.task : meta.fallback != null && isTask(meta.fallback) ? meta.fallback : null;
      const r = take(app, runId, workId, spaceId, full, `${prefix ? `${prefix}/` : ""}${named ? folder.rest : path}`, { ...meta, task }, move);
      if (r.artifact) made.push(r.artifact);
      if (r.skipped) skipped.push(r.skipped);
    }
  };
  walk(dir, "");
  return { made, skipped };
}

/** Whether a task number is one of the delegation's. */
async function taskCheck(app: App, workId: string | null): Promise<(seq: number) => boolean> {
  if (!workId) return () => false;
  const { isTaskWork, listTasks } = await import("./code-tasks.ts");
  if (!isTaskWork(app, workId)) return () => false;
  const seqs = new Set(listTasks(app, workId).map((t) => t.seq));
  return (seq) => seqs.has(seq);
}

/**
 * Takes what a run's inbox holds. `task`: what is not under a `T<n>` folder goes on this task
 * (finish_task: what the agent made while doing it). `keep`: the agent goes on working and may write
 * there again (finish_task), so the folder stays, emptied; otherwise (its turn or the command
 * ended) it goes, and is made again when the run's next turn or command needs it.
 */
export async function collectInbox(app: App, runId: string, meta: Meta & { keep?: boolean }): Promise<{ made: Artifact[]; skipped: string[] }> {
  const dir = join(store(app, "inbox"), runId);
  if (!existsSync(dir)) return { made: [], skipped: [] };
  try {
    return await takeFolder(app, runId, dir, { ...meta, task: null, fallback: meta.task ?? null }, true);
  } finally {
    // What was not taken (too big, too many) is dropped: the inbox starts empty for the next command.
    if (meta.keep) for (const name of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, name), { recursive: true, force: true });
    else rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A file or folder handed in by path (attach_artifact): inside one of `roots` (the delegation's
 * workspaces, the run's inbox) and nowhere else, links resolved first.
 */
export async function attachPath(app: App, runId: string, path: string, roots: string[], meta: Meta & { name?: string }): Promise<{ made: Artifact[]; skipped: string[] }> {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const bases = roots.map(real).filter((r): r is string => !!r);
  const candidates = isAbsolute(path) ? [path] : roots.map((r) => resolve(r, path));
  const found = candidates.map(real).find((p): p is string => !!p && bases.some((b) => p === b || p.startsWith(b + sep)));
  if (!found) throw new HttpError(400, `找不到 ${path}：写工作区里的相对路径（几个仓库时带上仓库目录名），或 $OMEM_ARTIFACTS 下的文件`);
  if (bases.includes(found)) throw new HttpError(400, "不能把整个工作区作为产物：写具体的文件或报告目录");
  const st = statSync(found);
  const name = meta.name?.trim() || basename(found);
  if (st.isFile() || existsSync(join(found, "index.html"))) {
    const workId = await workOf(app, runId);
    const tasks = await taskCheck(app, workId);
    if (meta.task != null && !tasks(meta.task)) throw new HttpError(400, `T${meta.task} 不是这次交办的修改项`);
    const r = take(app, runId, workId, getRun(app, runId).spaceId, found, name, meta, false);
    return { made: r.artifact ? [r.artifact] : [], skipped: r.skipped ? [r.skipped] : [] };
  }
  if (!st.isDirectory()) throw new HttpError(400, `${path} 不是文件或目录`);
  return takeFolder(app, runId, found, meta, false, name);
}

/** A run's artifacts: on a delegation, all of the delegation's (every round, review and helper). */
export async function listArtifacts(app: App, runId: string): Promise<Artifact[]> {
  const workId = await workOf(app, runId);
  const rows = workId
    ? all<Row>(app.db, "select * from run_artifacts where work_id = ? order by created_at, id", workId)
    : all<Row>(app.db, "select * from run_artifacts where run_id = ? order by created_at, id", runId);
  return rows.map(toArtifact);
}

/** Artifacts per task of a delegation (counts for the task list). */
export function artifactCounts(app: App, workId: string): Record<number, number> {
  const rows = all<{ task: number; n: number }>(app.db, "select task, count(*) n from run_artifacts where work_id = ? and task is not null group by task", workId);
  return Object.fromEntries(rows.map((r) => [r.task, r.n]));
}

/**
 * A file of an artifact, by its URL token (`<id>.<key>`) and the path below it: the entry, or a
 * file of a page. Null when the token is wrong or the path leaves the artifact.
 */
export function artifactFile(app: App, token: string, path: string): { file: string; mime: string; size: number; artifact: Artifact } | null {
  const m = /^([a-z0-9]+)\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const row = one<Row>(app.db, "select * from run_artifacts where id = ?", m[1]);
  if (!row || !sameSecret(m[2], row.key)) return null;
  const base = store(app, row.id);
  const rel = path ? path.split("/").map((p) => decodeURIComponent(p)).join("/") : row.entry;
  if (row.kind !== "site" && rel !== row.entry) return null;
  const file = resolve(base, rel);
  if (file !== base && !file.startsWith(base + sep)) return null;
  if (relative(base, file).split(sep).some((p) => p.startsWith("."))) return null;
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    return { file, mime: mimeOf(file), size: st.size, artifact: toArtifact(row) };
  } catch {
    return null;
  }
}

/** Deletes the artifacts of a run (or of a whole delegation). */
export function deleteArtifacts(app: App, opts: { runId?: string; workId?: string; ids?: string[] }) {
  const rows = opts.ids
    ? opts.ids.flatMap((id) => all<{ id: string }>(app.db, "select id from run_artifacts where id = ?", id))
    : all<{ id: string }>(app.db, opts.workId ? "select id from run_artifacts where work_id = ?" : "select id from run_artifacts where run_id = ?", (opts.workId ?? opts.runId)!);
  for (const { id } of rows) {
    rmSync(store(app, id), { recursive: true, force: true });
    run(app.db, "delete from run_artifacts where id = ?", id);
  }
  return rows.length;
}

const sizeText = (n: number) => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const KIND_LABEL: Record<ArtifactKind, string> = { image: "图片", video: "视频", html: "网页", site: "报告", text: "文本", file: "文件" };

/**
 * Artifacts as text for an agent (a review, the verification of a task): each with its file on
 * this machine, so an agent that reads images can look at a screenshot.
 */
export function artifactsText(app: App, list: Artifact[], opts: { max?: number } = {}): string {
  const max = opts.max ?? 40;
  const lines = list.slice(-max).map((a) => `- ${a.task ? `T${a.task} · ` : ""}${KIND_LABEL[a.kind]} ${a.name}${a.caption ? `：${a.caption}` : ""}（${sizeText(a.size)}）${artifactPath(app, a)}`);
  return `${list.length > max ? `（共 ${list.length} 个，列出最近的 ${max} 个）\n` : ""}${lines.join("\n")}`;
}

/** What a collection reports back (to an agent, or as a run event). */
export function takenText(r: { made: Artifact[]; skipped: string[] }) {
  const parts = [];
  if (r.made.length) parts.push(`收下 ${r.made.length} 个产物：${r.made.slice(0, 8).map((a) => `${a.task ? `T${a.task} ` : ""}${a.name}`).join("、")}${r.made.length > 8 ? " 等" : ""}`);
  if (r.skipped.length) parts.push(`没收：${r.skipped.slice(0, 5).join("；")}`);
  return parts.join("。");
}

