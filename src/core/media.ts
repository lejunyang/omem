import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { cpus, setPriority } from "node:os";
import { extname, join } from "node:path";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { mediaType, type MediaType } from "./storage-scan.ts";
import { markStoredFileAdded, takeStoredFileAdded } from "./stored-files.ts";
import { forgetTool, installArgs, installSpec, toolCommand, toolStatus } from "./tools.ts";

/**
 * Compressing stored media (files/): images to WebP, video to AV1 (H.264 when ffmpeg has no
 * SVT-AV1), audio to Opus or FLAC. References keep the original name; `file_variants` records
 * which file answers for it and stored-files.ts opens that one. A copy replaces the original only
 * when it saves at least 10%; otherwise the original is recorded as kept and not tried again
 * with the same settings.
 *
 * One job at a time in the server process, running `media.concurrency` ffmpeg at once at low
 * priority (read as it goes: a change applies to the running job). Progress is saved as it goes;
 * a job cut off by a restart or crash carries on when the service starts again (resumeMediaJob),
 * and one stopped by hand continues from the page. Finished files are never redone: candidates()
 * skips what file_variants already has. A copy is renamed into files/ under a 'pending' row, so a
 * crash in between leaves nothing unaccounted for (cleanPending).
 *
 * `media.auto`: while ffmpeg is there, media stored after it was turned on is compressed by itself
 * (tickAutoCompress, after keepOriginal stores something new). Settings → 占用 drives all of it:
 * GET/POST /api/media….
 */
export type MediaKind = Extract<MediaType, "image" | "video" | "audio">;
export type CompressOptions = {
  types: MediaKind[];
  mode: "lossless" | "lossy";
  quality: "high" | "medium" | "low";
  /** Longest side for lossy images and video; 0 keeps the size. */
  maxSide: number;
  minBytes: number;
  deleteOriginals: boolean;
  /** Stop after this many files (a trial run); 0 for all. */
  limit: number;
  /** Try again files that failed with the same settings (normally skipped). */
  retryFailed?: boolean;
};
type Result = { name: string; type: MediaKind; status: "done" | "kept" | "failed"; from: number; to?: number; file?: string; error?: string };
export type MediaJob = {
  options: CompressOptions;
  startedAt: string;
  finishedAt: string | null;
  stopped: boolean;
  error: string | null;
  total: number;
  totalBytes: number;
  done: number;
  kept: number;
  failed: number;
  processedBytes: number;
  savedBytes: number;
  running: { name: string; type: MediaKind; bytes: number; progress: number }[];
  recent: Result[];
  /** Started by media.auto for newly stored files. */
  auto?: boolean;
  /** Times it carried on after a restart or a stop. */
  resumed?: number;
};

const LAST = "media_compress_last";
const AUTO_SINCE = "media_auto_since";
const SAVE_RATIO = 0.9;
/** What lossless mode can do anything for: re-encoding already-compressed formats losslessly only grows them. */
const LOSSLESS: Record<MediaKind, RegExp> = { image: /^\.(png|bmp|tiff?|gif)$/, video: /^$/, audio: /^\.(wav|aiff?)$/ };
/** Lossy skips what is already in the target format. */
const LOSSY_SKIP: Record<MediaKind, RegExp> = { image: /^\.(webp|avif|svg|ico)$/, video: /^$/, audio: /^\.(opus|ogg)$/ };
const IMAGE_Q = { high: 88, medium: 80, low: 68 };
const AV1_CRF = { high: 30, medium: 36, low: 42 };
const X264_CRF = { high: 22, medium: 27, low: 31 };
const AUDIO_KBPS = { high: 96, medium: 64, low: 32 };
const VIDEO_AUDIO_KBPS = { high: 128, medium: 96, low: 64 };

// ---- ffmpeg ---------------------------------------------------------------------------

const WANTED = ["libwebp", "libwebp_anim", "libsvtav1", "libx264", "libopus", "aac", "flac"];
let encoders: { at: number; list: string[] } | null = null;
let install: { startedAt: string; log: string; done: Promise<void> } | null = null;
let installError: string | null = null;

function ffmpegEncoders(): string[] {
  if (encoders && Date.now() - encoders.at < 600_000) return encoders.list;
  const cmd = toolCommand("ffmpeg");
  let list: string[] = [];
  if (cmd) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "-hide_banner", "-encoders"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    const names = new Set(String(r.stdout ?? "").split("\n").map((l) => /^\s*[VAS][\w.]{5}\s+(\S+)/.exec(l)?.[1]).filter(Boolean) as string[]);
    list = WANTED.filter((e) => names.has(e));
  }
  encoders = { at: Date.now(), list };
  return list;
}

let tools: { at: number; ffmpeg: ReturnType<typeof toolStatus>; ffprobe: ReturnType<typeof toolStatus> } | null = null;
/** Is ffmpeg there, how it is reached, and what it can encode to. Cached: the page polls it while a job runs. */
export function ffmpegStatus() {
  if (!tools || Date.now() - tools.at > 600_000) tools = { at: Date.now(), ffmpeg: toolStatus("ffmpeg"), ffprobe: toolStatus("ffprobe") };
  const { ffmpeg, ffprobe } = tools;
  return {
    spec: installSpec("ffmpeg")!,
    command: `osdk ${installArgs("ffmpeg").join(" ")}`,
    ffmpeg,
    ffprobe,
    encoders: ffmpeg.installed ? ffmpegEncoders() : [],
    installing: install ? { startedAt: install.startedAt, log: install.log.slice(-2000) } : null,
    installError,
  };
}

/** `osdk use -g conda:ffmpeg` in the background (the download takes a minute or two). */
export function startFfmpegInstall() {
  if (install) return install.done;
  installError = null;
  const state = { startedAt: new Date().toISOString(), log: "", done: Promise.resolve() };
  state.done = new Promise<void>((ok) => {
    const p = spawn("osdk", installArgs("ffmpeg"), { windowsHide: true, shell: process.platform === "win32" });
    const take = (d: Buffer) => { state.log = (state.log + d.toString()).slice(-8000); };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("error", (e) => { installError = e.message; });
    p.on("close", (code) => {
      forgetTool("ffmpeg");
      forgetTool("ffprobe");
      encoders = null;
      tools = null;
      if (code !== 0 && !installError) installError = state.log.trim().split("\n").pop() || `osdk 退出码 ${code}`;
      else if (code === 0 && !toolCommand("ffmpeg")) installError = "安装完成，但找不到能运行的 ffmpeg";
      install = null;
      ok();
    });
  });
  install = state;
  return state.done;
}

// ---- candidates -----------------------------------------------------------------------

type Candidate = { name: string; type: MediaKind; bytes: number };
type Variant = { original: string; status: string; file: string | null; mode: string; quality: string; original_bytes: number; bytes: number | null };

function eligible(name: string, type: MediaKind, mode: CompressOptions["mode"]) {
  const ext = extname(name).toLowerCase();
  return mode === "lossless" ? LOSSLESS[type].test(ext) : !LOSSY_SKIP[type].test(ext);
}

/** Stored media files that compressing with these settings would try, largest first. */
export function candidates(app: App, o: Pick<CompressOptions, "types" | "mode" | "quality" | "minBytes" | "retryFailed">, since = 0): Candidate[] {
  const variants = all<Variant>(app.db, "select original, status, file, mode, quality from file_variants");
  const outputs = new Set(variants.filter((v) => v.file && v.file !== v.original).map((v) => v.file));
  const tried = new Map(variants.map((v) => [v.original, v]));
  const out: Candidate[] = [];
  let names: string[] = [];
  try { names = readdirSync(app.filesDir); } catch { /* no files yet */ }
  for (const name of names) {
    const type = mediaType(name);
    if (!o.types.includes(type as MediaKind) || outputs.has(name) || !eligible(name, type as MediaKind, o.mode)) continue;
    const v = tried.get(name);
    if (v && (v.status === "done" || v.status === "pending" || (v.mode === o.mode && v.quality === (o.mode === "lossy" ? o.quality : "") && !(o.retryFailed && v.status === "failed")))) continue;
    const st = statSync(join(app.filesDir, name), { throwIfNoEntry: false });
    if (!st?.isFile() || st.size < o.minBytes) continue;
    // A copy may keep the source's mtime (CopyFile on Windows): it arrived at the latest of the three.
    if (since && Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs) < since) continue;
    out.push({ name, type: type as MediaKind, bytes: st.size });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

/** What is compressed so far, and how much the originals still on disk take. */
export function compressedSummary(app: App) {
  const rows = all<Variant>(app.db, "select original, status, file, original_bytes, bytes from file_variants where status = 'done'");
  let originalBytes = 0, bytes = 0, kept = 0, keptBytes = 0;
  for (const r of rows) {
    originalBytes += r.original_bytes;
    bytes += r.bytes ?? 0;
    if (existsSync(join(app.filesDir, r.original))) { kept++; keptBytes += r.original_bytes; }
  }
  const n = (status: string) => one<{ n: number }>(app.db, "select count(*) n from file_variants where status = ?", status)?.n ?? 0;
  const failed = n("failed");
  return { files: rows.length, originalBytes, bytes, originalsOnDisk: { files: kept, bytes: keptBytes }, skipped: failed + n("kept"), failed };
}

/** Per type, what the default lossy and lossless settings would try. */
export function mediaOverview(app: App) {
  const types: MediaKind[] = ["image", "video", "audio"];
  const sum = (list: Candidate[]) => Object.fromEntries(types.map((t) => {
    const of = list.filter((c) => c.type === t);
    return [t, { files: of.length, bytes: of.reduce((s, c) => s + c.bytes, 0) }];
  }));
  return {
    lossy: sum(candidates(app, { types, mode: "lossy", quality: "medium", minBytes: 0 })),
    lossless: sum(candidates(app, { types, mode: "lossless", quality: "high", minBytes: 0 })),
  };
}

// ---- encoding -------------------------------------------------------------------------

/** ffmpeg output arguments and extension for one file, or why it cannot be done. */
export function encodePlan(name: string, type: MediaKind, o: CompressOptions, enc: string[]): { ext: string; codec: string; args: string[] } | string {
  const ext = extname(name).toLowerCase();
  const has = (e: string) => enc.includes(e);
  // AV1 and H.264 in 4:2:0 need even sides, so video is always scaled (to the same size when there is no limit).
  const fit = (even: boolean) => (o.mode === "lossy" && o.maxSide > 0
    ? ["-vf", `scale=w='min(iw,${o.maxSide})':h='min(ih,${o.maxSide})':force_original_aspect_ratio=decrease${even ? ":force_divisible_by=2" : ""}`]
    : even ? ["-vf", "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'"] : []);
  if (type === "image") {
    const anim = ext === ".gif";
    const e = anim ? "libwebp_anim" : "libwebp";
    if (!has(e)) return `ffmpeg 没有 ${e} 编码器`;
    const q = o.mode === "lossless" ? ["-lossless", "1", "-compression_level", "6", "-q:v", "100"] : ["-q:v", String(IMAGE_Q[o.quality]), "-compression_level", "6"];
    return { ext: ".webp", codec: o.mode === "lossless" ? "webp-lossless" : "webp", args: [...fit(false), "-c:v", e, ...q, ...(anim ? ["-loop", "0"] : ["-frames:v", "1"]), "-map_metadata", "-1"] };
  }
  if (type === "video") {
    if (o.mode === "lossless") return "视频没有无损压缩：重新编码一定有损";
    const audio = has("aac") ? ["-c:a", "aac", "-b:a", `${VIDEO_AUDIO_KBPS[o.quality]}k`] : ["-an"];
    const common = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", ...fit(true), "-pix_fmt", "yuv420p", ...audio, "-movflags", "+faststart"];
    if (has("libsvtav1")) return { ext: ".mp4", codec: "av1", args: [...common, "-c:v", "libsvtav1", "-preset", "8", "-crf", String(AV1_CRF[o.quality])] };
    if (has("libx264")) return { ext: ".mp4", codec: "h264", args: [...common, "-c:v", "libx264", "-preset", "slow", "-crf", String(X264_CRF[o.quality])] };
    return "ffmpeg 没有 libsvtav1 或 libx264 编码器";
  }
  if (o.mode === "lossless") return has("flac") ? { ext: ".flac", codec: "flac", args: ["-map", "0:a:0", "-c:a", "flac", "-compression_level", "8"] } : "ffmpeg 没有 flac 编码器";
  const kbps = `${AUDIO_KBPS[o.quality]}k`;
  if (has("libopus")) return { ext: ".ogg", codec: "opus", args: ["-map", "0:a:0", "-c:a", "libopus", "-b:a", kbps, "-vbr", "on"] };
  if (has("aac")) return { ext: ".m4a", codec: "aac", args: ["-map", "0:a:0", "-c:a", "aac", "-b:a", kbps, "-movflags", "+faststart"] };
  return "ffmpeg 没有 libopus 或 aac 编码器";
}

let job: MediaJob | null = null;
const children = new Set<ChildProcess>();
let stopping = false;

/** Run a tool and collect its output; `onLine` sees stdout lines as they come (ffmpeg -progress). */
function runTool(cmd: string[], args: string[], onLine?: (line: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(p);
    if (p.pid) try { setPriority(p.pid, 15); } catch { /* not permitted here */ }
    let stdout = "", stderr = "", buf = "";
    p.stdout!.on("data", (d: Buffer) => {
      const s = d.toString();
      if (stdout.length < 1_000_000) stdout += s;
      if (!onLine) return;
      buf += s;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) onLine(l.trim());
    });
    p.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    p.on("error", (e) => { stderr += e.message; });
    p.on("close", (code) => { children.delete(p); ok({ code, stdout, stderr }); });
  });
}

async function probeDuration(path: string): Promise<number | null> {
  const cmd = toolCommand("ffprobe");
  if (!cmd) return null;
  const r = await runTool(cmd, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]);
  const n = Number.parseFloat(r.stdout.trim().split("\n").pop() ?? "");
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

function hashFile(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("error", fail).on("end", () => ok(h.digest("hex")));
  });
}

const lastError = (stderr: string) => stderr.trim().split("\n").filter((l) => !/already installed/.test(l)).pop()?.slice(0, 300) || "ffmpeg 失败";

/** Compress one stored file; records the outcome in file_variants. */
async function compressOne(app: App, c: Candidate, o: CompressOptions, enc: string[], tmpDir: string, slot: MediaJob["running"][number]): Promise<Result> {
  const record = <R extends Omit<Result, "name" | "type" | "from" | "status"> & { status: Result["status"] | "pending" }>(r: R, codec = "") => {
    run(app.db, `insert or replace into file_variants(original, status, file, mode, quality, codec, original_bytes, bytes, error, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.name, r.status, r.file ?? null, o.mode, o.mode === "lossy" ? o.quality : "", codec, c.bytes, r.to ?? null, r.error ?? null, new Date().toISOString());
    return { name: c.name, type: c.type, from: c.bytes, ...r };
  };
  const plan = encodePlan(c.name, c.type, o, enc);
  if (typeof plan === "string") return record({ status: "failed", error: plan });
  const ffmpeg = toolCommand("ffmpeg");
  if (!ffmpeg) throw new Error("找不到 ffmpeg");
  const input = join(app.filesDir, c.name);
  const tmp = join(tmpDir, `${c.name}${plan.ext}`);
  try {
    const duration = c.type === "image" ? null : await probeDuration(input);
    // Several run at once: each gets its share of the cores rather than all of them.
    const threads = String(Math.max(1, Math.floor(cpus().length / concurrency(app))));
    const r = await runTool(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, ...plan.args, "-threads", threads, "-progress", "pipe:1", "-nostats", tmp], (line) => {
      const us = /^out_time_us=(\d+)/.exec(line)?.[1];
      if (us && duration) slot.progress = Math.min(1, Number(us) / 1e6 / duration);
    });
    if (stopping) return { name: c.name, type: c.type, from: c.bytes, status: "failed", error: "已停止" };
    if (r.code !== 0 || !existsSync(tmp)) return record({ status: "failed", error: lastError(r.stderr) }, plan.codec);
    const size = statSync(tmp).size;
    if (!size) return record({ status: "failed", error: "输出为空" }, plan.codec);
    // A copy that is cut short (a broken input stream) is not a replacement.
    if (duration) {
      const got = await probeDuration(tmp);
      if (got == null || Math.abs(got - duration) > Math.max(1, duration * 0.02)) return record({ status: "failed", error: `时长不符：原 ${duration.toFixed(1)} 秒，压缩后 ${got?.toFixed(1) ?? "?"} 秒` }, plan.codec);
    }
    if (size > c.bytes * SAVE_RATIO) return record({ status: "kept", to: size, error: "压缩后没有小 10% 以上，保留原文件" }, plan.codec);
    const file = `${(await hashFile(tmp)).slice(0, 16)}${plan.ext}`;
    const target = join(app.filesDir, file);
    // 'pending' first: a crash between the rename and 'done' leaves a row that cleanPending undoes.
    if (existsSync(target)) rmSync(tmp, { force: true });
    else {
      record({ status: "pending", file, to: size }, plan.codec);
      renameSync(tmp, target);
    }
    const result = record({ status: "done", file, to: size }, plan.codec);
    // A file that cannot be removed right now (open elsewhere) stays; "删除这些原件" gets it later.
    if (o.deleteOriginals) try { unlinkSync(input); } catch { /* kept */ }
    return result;
  } finally {
    rmSync(tmp, { force: true });
  }
}

const concurrency = (app: App) => Math.max(1, Math.min(app.config.media?.concurrency ?? 2, cpus().length * 2));

/** Copies renamed into files/ by a run that did not get to record them as done. */
function cleanPending(app: App) {
  for (const r of all<Variant>(app.db, "select original, file from file_variants where status = 'pending'")) {
    if (r.file) rmSync(join(app.filesDir, r.file), { force: true });
    run(app.db, "delete from file_variants where original = ?", r.original);
  }
}

const save = (app: App, state: MediaJob) => run(app.db, "insert or replace into kv(key, value) values(?, ?)", LAST, JSON.stringify(state));
const autoSince = (app: App) => Number(one<{ value: string }>(app.db, "select value from kv where key = ?", AUTO_SINCE)?.value ?? 0);

/** The running job, or the last one (kept in kv across restarts). */
export function mediaJobState(app: App): MediaJob | null {
  if (job) return job;
  const raw = one<{ value: string }>(app.db, "select value from kv where key = ?", LAST)?.value;
  if (!raw) return null;
  // Saved by a process that is gone (or before jobs ran several at once): nothing is running.
  return { ...(JSON.parse(raw) as MediaJob), running: [] };
}

export function stopMediaJob() {
  if (!job || job.finishedAt) return false;
  stopping = true;
  for (const p of children) p.kill();
  return true;
}

/** Start compressing in the background; refuses while a job runs or ffmpeg is missing. */
export function startMediaJob(app: App, o: CompressOptions) {
  if (job && !job.finishedAt) throw new Error("已有压缩在进行");
  if (!toolCommand("ffmpeg")) throw new Error("还没有安装 ffmpeg");
  cleanPending(app);
  let list = candidates(app, o);
  if (o.limit > 0) list = list.slice(0, o.limit);
  return runJob(app, o, list);
}

/**
 * Carry on with the last job: on startup when it was cut off (saved without finishedAt), from
 * the page after it was stopped (`stopped`). Files it finished are skipped by candidates(); a
 * trial run does only what is left of its limit.
 */
export function resumeMediaJob(app: App, opts: { stopped?: boolean } = {}) {
  if (job && !job.finishedAt) return null;
  const last = mediaJobState(app);
  if (!last || (last.finishedAt && !(opts.stopped && last.stopped))) return null;
  if (!toolCommand("ffmpeg")) {
    if (!last.finishedAt) save(app, { ...last, finishedAt: new Date().toISOString(), error: "服务重启后找不到 ffmpeg，没有继续" });
    return null;
  }
  cleanPending(app);
  const handled = last.done + last.kept + last.failed;
  let list = candidates(app, last.options, last.auto ? autoSince(app) : 0);
  if (last.options.limit > 0) list = list.slice(0, Math.max(0, last.options.limit - handled));
  return runJob(app, last.options, list, last);
}

function runJob(app: App, o: CompressOptions, list: Candidate[], prev?: MediaJob, auto = false): MediaJob {
  const enc = ffmpegEncoders();
  stopping = false;
  const state: MediaJob = prev
    ? {
        ...prev, finishedAt: null, stopped: false, error: null, running: [], resumed: (prev.resumed ?? 0) + 1,
        total: prev.done + prev.kept + prev.failed + list.length, totalBytes: prev.processedBytes + list.reduce((s, c) => s + c.bytes, 0),
      }
    : {
        options: o, startedAt: new Date().toISOString(), finishedAt: null, stopped: false, error: null,
        total: list.length, totalBytes: list.reduce((s, c) => s + c.bytes, 0),
        done: 0, kept: 0, failed: 0, processedBytes: 0, savedBytes: 0, running: [], recent: [], auto,
      };
  job = state;
  save(app, state);
  const tmpDir = join(app.filesDir, ".compressing");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  let next = 0;
  const finish = () => {
    rmSync(tmpDir, { recursive: true, force: true });
    state.stopped = stopping;
    state.finishedAt = new Date().toISOString();
    save(app, state);
    job = null;
    // What was stored meanwhile is looked at on the next auto tick.
    markStoredFileAdded();
  };
  const work = async (c: Candidate) => {
    const slot = { ...c, progress: 0 };
    state.running.push(slot);
    try {
      const r = await compressOne(app, c, o, enc, tmpDir, slot);
      if (stopping) return;
      state[r.status === "done" ? "done" : r.status === "kept" ? "kept" : "failed"]++;
      state.processedBytes += c.bytes;
      if (r.status === "done") state.savedBytes += c.bytes - (r.to ?? 0);
      state.recent = [r, ...state.recent].slice(0, 30);
    } finally {
      state.running = state.running.filter((s) => s !== slot);
    }
  };
  // Up to `media.concurrency` at once, read on every refill so a change applies to this job.
  const fill = () => {
    if (state.finishedAt) return;
    while (!stopping && !state.error && next < list.length && state.running.length < concurrency(app)) {
      const c = list[next++];
      // Something else (a pull, a second device) may have removed or compressed it meanwhile.
      if (!existsSync(join(app.filesDir, c.name))) continue;
      void work(c)
        .catch((e) => { state.error = (e as Error).message; })
        .finally(() => {
          save(app, state);
          fill();
        });
    }
    if (!state.running.length) finish();
  };
  fill();
  return state;
}

/**
 * media.auto, every minute: compress what keepOriginal stored since auto was turned on (files
 * already there are left to a job started by hand). Waits while ffmpeg is missing or a job runs.
 */
export function tickAutoCompress(app: App) {
  const a = app.config.media?.auto;
  if (!a?.enabled) {
    run(app.db, "delete from kv where key = ?", AUTO_SINCE);
    return null;
  }
  let since = autoSince(app);
  if (!since) {
    since = Date.now();
    run(app.db, "insert or replace into kv(key, value) values(?, ?)", AUTO_SINCE, String(since));
  }
  if ((job && !job.finishedAt) || !ffmpegStatus().ffmpeg.installed || !takeStoredFileAdded()) return null;
  const o: CompressOptions = { types: a.types, mode: a.mode, quality: a.quality, maxSide: a.maxSide, minBytes: a.minBytes, deleteOriginals: a.deleteOriginals, limit: 0 };
  cleanPending(app);
  const list = candidates(app, o, since);
  return list.length ? runJob(app, o, list, undefined, true) : null;
}

/** Delete originals that already have a compressed copy (compressed with "keep originals"). */
export function deleteCompressedOriginals(app: App) {
  if (job && !job.finishedAt) throw new Error("压缩进行中，结束后再删");
  let files = 0, bytes = 0;
  for (const r of all<Variant>(app.db, "select original, file from file_variants where status = 'done'")) {
    const path = join(app.filesDir, r.original);
    if (!r.file || !existsSync(join(app.filesDir, r.file)) || !existsSync(path)) continue;
    bytes += statSync(path).size;
    unlinkSync(path);
    files++;
  }
  return { files, bytes };
}
