import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { App } from "./app.ts";
import { all, openDb } from "./db.ts";
import { snapshotScript } from "./pull-snapshot.ts";

/** `parts`: what was asked for (none: everything); `reused`: attachments the other side has that were not transferred because this machine has them. */
export type Fetched = { dbDir: string; libraryDir: string; filesDir: string; fetchedFiles: string[]; parts?: PullPart[]; reused?: string[] };

/**
 * What a pull takes besides the database (always: sources, memories, items, runs and the rest).
 * `library`: Wiki pages, agent profiles and skills (Git); `files`: attachments and images, only the
 * ones this machine lacks; `repos`: the repository spaces' checkouts; `runs`: coding workspaces and
 * run artifacts.
 */
export const PULL_PARTS = ["library", "files", "repos", "runs"] as const;
export type PullPart = (typeof PULL_PARTS)[number];
export const PULL_PART_LABELS: Record<PullPart, string> = {
  library: "知识库（Wiki、Agent 档案、技能）",
  files: "附件与图片（只拉本机没有的）",
  repos: "代码仓库",
  runs: "编码工作区与运行产物",
};
/** `strip`: leave out what a merge rebuilds itself (search chunks, code outline). */
/** `since` (with `strip`): only the sources and run events changed after this moment (the other side's clock); the puller has the rest from its last complete pull. */
export type PullSelection = { parts: PullPart[]; strip?: boolean; since?: string };
/**
 * `stallMs`: how long a pull from a device keeps asking again when nothing gets through (default a
 * quarter of an hour); `chunkBytes`: the size of a piece of the snapshot; `retryMs` / `pollMs`: the
 * first wait before asking again, and between looks at a snapshot being made (tests shorten them).
 */
export type FetchOptions = { selection?: PullSelection; log?: (s: string) => void; dryRun?: boolean; haveFile?: (name: string) => boolean; stallMs?: number; chunkBytes?: number; retryMs?: number; pollMs?: number };

export function parseParts(value: string | undefined | null): PullPart[] {
  if (value == null) return [...PULL_PARTS];
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const bad = parts.filter((p) => !(PULL_PARTS as readonly string[]).includes(p));
  if (bad.length) throw new Error(`不认识的拉取内容：${bad.join("、")}（可选 ${PULL_PARTS.join(", ")}）`);
  return [...new Set(parts)] as PullPart[];
}

/** Stored attachment names (content-addressed); anything else in a request is refused. */
export const FILE_NAME = /^[a-f0-9]{16}\.[a-z0-9]+$/;
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let tarProgram = "tar";
const bsdtar = new Map<string, boolean>();
/** Tests: another tar (Windows has two: bsdtar in System32, GNU tar with Git). */
export function setTarForTests(program: string | null) {
  tarProgram = program ?? "tar";
}
/**
 * File names in a snapshot are UTF-8: it is made on Linux or macOS, or carries them in pax headers.
 * bsdtar (the tar Windows ships) reads a header that has no pax name in the system's code page: a
 * Chinese page name came out as other characters, or, when its bytes are not valid there, the file
 * was refused with "Invalid empty pathname" and the whole pull failed. It is told the charset.
 */
function tarReading(): string[] {
  let is = bsdtar.get(tarProgram);
  if (is === undefined) {
    is = /bsdtar/i.test(spawnSync(tarProgram, ["--version"], { encoding: "utf8" }).stdout ?? "");
    bsdtar.set(tarProgram, is);
  }
  return is ? ["--options", "hdrcharset=UTF-8"] : [];
}

/** Unpack an archive fetched into `dir`, refusing paths that leave it. */
export function untar(dir: string, archive: string) {
  // Relative to the snapshot dir: GNU tar (Git for Windows) reads "C:\…" as a remote host.
  const listing = spawnSync(tarProgram, [...tarReading(), "-tf", archive], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 ** 2 });
  if (listing.status !== 0 || listing.stdout.split("\n").some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes(".."))) throw new Error("快照目录不合法或传输不完整");
  const r = spawnSync(tarProgram, [...tarReading(), "-xf", archive], { cwd: dir, maxBuffer: 64 * 1024 ** 2 });
  if (r.status !== 0) {
    // A repository's working tree can hold links whose target is gone (rotated logs), and Windows
    // cannot make those: everything else is unpacked, so the pull goes on without them.
    const errors = (r.stderr?.toString() ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/Exiting with failure status|Error exit delayed/i.test(l));
    const links = errors.filter((l) => /sym(bolic )?link/i.test(l));
    if (!errors.length || links.length !== errors.length) throw new Error(`解包失败：${r.stderr?.toString().slice(-300)}`);
    console.warn(`[omem] 解包时有 ${links.length} 个符号链接没能建出来（目标不存在的链接在 Windows 上建不了），已跳过，其余照常`);
  }
  rmSync(join(dir, archive));
}

function unpack(dir: string, selection: PullSelection): Fetched {
  untar(dir, "snapshot.tar");
  if (!existsSync(join(dir, "omem.db"))) throw new Error("快照里没有 omem.db");
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  return { dbDir: dir, libraryDir: join(dir, "library"), filesDir, fetchedFiles: readdirSync(filesDir), parts: selection.parts };
}

/** Did the other side honour the selection (a newer omem), or send everything (an older one)? */
function selective(dir: string) {
  try {
    return Array.isArray(JSON.parse(readFileSync(join(dir, "pull-manifest.json"), "utf8")).parts);
  } catch {
    return false;
  }
}

/** Attachments this machine lacks, in batches, untarred into `filesDir`. */
async function pullMissingFiles(fetched: Fetched, names: string[], opts: FetchOptions, batch: (names: string[], archive: string) => Promise<void>) {
  const log = opts.log ?? (() => {});
  const filesDir = fetched.filesDir;
  const valid = names.filter((n) => FILE_NAME.test(n));
  const missing = valid.filter((n) => !opts.haveFile?.(n));
  fetched.reused = valid.filter((n) => opts.haveFile?.(n));
  log(`附件：对方 ${names.length} 个，本机缺 ${missing.length} 个${opts.dryRun ? "（预览，不下载）" : ""}`);
  if (opts.dryRun || !missing.length) return missing.length;
  const size = 500;
  for (let i = 0; i < missing.length; i += size) {
    const archive = `files-${i}.tar`;
    await batch(missing.slice(i, i + size), join(filesDir, archive));
    untar(filesDir, archive);
    if (missing.length > size) log(`  已拉 ${Math.min(i + size, missing.length)}/${missing.length}`);
  }
  return missing.length;
}

/** SSH and HTTP use the same snapshot program; attachments travel separately, only the missing ones. */
export async function fetchRemote(_app: App, host: string, remoteHome = "~/.omem", opts: FetchOptions = {}): Promise<Fetched> {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(host) || host.startsWith("-")) throw new Error(`主机名不合法：${host}`);
  const selection = opts.selection ?? { parts: [...PULL_PARTS] };
  const log = opts.log ?? (() => {});
  const dir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  const home = remoteHome === "~/.omem" ? "$HOME/.omem" : sh(remoteHome);
  const prelude = `set -eu\nH=${home}; test -f "$H/omem.db" || { echo "远端没有数据库" >&2; exit 3; }\n`;
  const script = `${prelude}N=$(sed -n 's/.*"interpreter": *"\\([^"]*\\)".*/\\1/p' "$H/service/ecosystem.json" 2>/dev/null | head -1); [ -x "$N" ] || N=node
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
"$N" --no-warnings -e ${sh(snapshotScript)} "$H" "$T" ${sh(JSON.stringify(selection))}
set --
${selection.parts.includes("library") ? `if [ -d "$H/library" ]; then set -- "$@" library; fi` : ""}
tar -cf - -C "$T" . -C "$H" "$@"`;
  const ssh = (cmd: string, out: string, input?: string) => {
    const fd = openSync(out, "w");
    try {
      const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, cmd], { stdio: [input === undefined ? "ignore" : "pipe", fd, "pipe"], input, encoding: "utf8", maxBuffer: 1024 ** 2 });
      if (r.status !== 0) throw new Error(`ssh 失败：${r.stderr?.trim().slice(-400) || r.error || r.status}`);
    } finally { closeSync(fd); }
  };
  log(`从 ${host}:${remoteHome} 拉取：数据库、${selection.parts.map((p) => PULL_PART_LABELS[p]).join("、") || "（不带其他内容）"}…`);
  try {
    ssh(script, join(dir, "snapshot.tar"));
    const fetched = unpack(dir, selection);
    if (selection.parts.includes("files")) {
      ssh(`${prelude}mkdir -p "$H/files"; ls -1 "$H/files"`, join(dir, "files.txt"));
      const names = readFileSync(join(dir, "files.txt"), "utf8").split("\n").filter(Boolean);
      rmSync(join(dir, "files.txt"));
      await pullMissingFiles(fetched, names, opts, async (batch, archive) => ssh(`${prelude}cd "$H/files" && tar -cf - -T -`, archive, batch.join("\n") + "\n"));
      fetched.fetchedFiles = readdirSync(fetched.filesDir);
    }
    return fetched;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export type SnapshotSelection = PullSelection & { separateFiles?: boolean };

/**
 * The snapshot's own files in a new directory (the database, the manifest, repositories), and what tar
 * archives after `-cf <where>`: that directory, then the library and attachments straight from the
 * data directory. The caller removes `dir`.
 */
export async function buildSnapshot(app: App, selection?: SnapshotSelection, into = tmpdir()): Promise<{ dir: string; members: string[] }> {
  const dir = mkdtempSync(join(into, "omem-snap-"));
  const parts = selection?.parts ?? [...PULL_PARTS];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "-e", snapshotScript, app.home, dir, JSON.stringify({ parts, strip: !!selection?.strip, ...(selection?.since ? { since: selection.since } : {}) })], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-1000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`生成快照失败：${error}`)));
    });
    const names = ["library", "files"].filter((name) => parts.includes(name as PullPart) && !(name === "files" && selection?.separateFiles) && existsSync(join(app.home, name)));
    return { dir, members: ["-C", dir, ".", ...(names.length ? ["-C", app.home, ...names] : [])] };
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

/** The snapshot as a tar stream. No selection: everything, attachments included (older pullers). */
export async function snapshotStream(app: App, selection?: SnapshotSelection): Promise<Readable> {
  const { dir, members } = await buildSnapshot(app, selection);
  return tarStream(["-cf", "-", ...members], () => rmSync(dir, { recursive: true, force: true }));
}

/** Stored attachments by name, as a tar stream (pullers fetch the ones they lack in batches). */
export function filesStream(app: App, names: string[]): Readable {
  const list = names.filter((n) => FILE_NAME.test(n) && existsSync(join(app.filesDir, n)));
  const dir = mkdtempSync(join(tmpdir(), "omem-files-"));
  writeFileSync(join(dir, "names.txt"), list.join("\n") + (list.length ? "\n" : ""));
  return tarStream(["-cf", "-", "-C", app.filesDir, "-T", join(dir, "names.txt")], () => rmSync(dir, { recursive: true, force: true }));
}

function tarStream(args: string[], done: () => void): Readable {
  const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
  const output = new PassThrough();
  tar.stdout.pipe(output, { end: false });
  let error = "";
  tar.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-500); });
  tar.on("error", (e) => output.destroy(e));
  tar.on("close", (code) => {
    done();
    if (code !== 0) output.destroy(new Error(`归档失败：${error}`));
    else output.end();
  });
  output.on("close", () => { if (tar.exitCode === null) tar.kill(); });
  return output;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mb = (n: number) => `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
const reason = (e: unknown) => {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  return [(e as Error).message, cause?.code ?? cause?.message].filter(Boolean).join("：").slice(0, 160);
};
/** The other side no longer has the snapshot it was keeping (it restarted, or dropped it). */
class SnapshotGone extends Error {}

/**
 * Asks again while the link is only interrupted (a device reached through another one that sleeps
 * for a few minutes, a service whose main thread is held up): gives up when nothing got through for
 * `stallMs`.
 */
async function patiently<T>(opts: FetchOptions, what: string, fn: () => Promise<T>): Promise<T> {
  const stallMs = opts.stallMs ?? STALL_MS;
  const started = Date.now();
  for (let wait = opts.retryMs ?? 5000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SnapshotGone || Date.now() - started > stallMs) throw e;
      opts.log?.(`  ${what}没有成功（${reason(e)}），${Math.round(wait / 1000)} 秒后再试`);
      await sleep(wait);
    }
  }
}

const STALL_MS = 15 * 60_000;
const CHUNK_BYTES = 32 * 1024 ** 2;

/**
 * The snapshot from a device that keeps it for the puller (core/pull-held.ts), piece by piece: a piece
 * that breaks is asked again from the byte it stopped at, so a connection lost halfway costs what was
 * in flight and not the gigabytes already here. `false`: an older device that only streams.
 */
async function fetchHeldSnapshot(app: App, peerId: string, selection: PullSelection, to: string, opts: FetchOptions): Promise<boolean> {
  const { peerFetch } = await import("./peers.ts");
  const log = opts.log ?? (() => {});
  const stallMs = opts.stallMs ?? STALL_MS;
  const chunk = opts.chunkBytes ?? CHUNK_BYTES;
  const at = (id: string) => `/api/peer/snapshot/${id}`;
  for (let round = 1; ; round++) {
    const made = await patiently(opts, "向对方要快照", async () => {
      const res = await peerFetch(app, peerId, "/api/peer/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: selection.parts.join(","), strip: !!selection.strip, files: "separate", ...(selection.since ? { since: selection.since } : {}) }), timeoutMs: 60_000 });
      if (res.status === 404 || res.status === 405) return void (await res.body?.cancel());
      if (!res.ok) throw new Error(`拉取失败：${res.status} ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as { id: string };
    });
    if (!made) return false;
    const fd = openSync(to, "w");
    try {
      let size = 0;
      for (const since = Date.now(); ; await sleep(opts.pollMs ?? 2000)) {
        const info = await patiently(opts, "问快照好了没有", async () => {
          const res = await peerFetch(app, peerId, at(made.id), { timeoutMs: 60_000 });
          if (res.status === 404) throw new SnapshotGone("对方已经没有这份快照");
          if (!res.ok) throw new Error(`拉取失败：${res.status}`);
          return (await res.json()) as { state: string; size?: number; error?: string };
        });
        if (info.state === "failed") throw new Error(`对方没能生成快照：${info.error ?? ""}`);
        if (info.state === "ready" && typeof info.size === "number") { size = info.size; break; }
        if (Date.now() - since > 60 * 60_000) throw new Error("对方一小时还没生成好快照");
      }
      log(`  快照 ${mb(size)}，分块取（断了接着传）`);
      let offset = 0;
      let moved = Date.now();
      let said = Date.now();
      for (let wait = opts.retryMs ?? 5000; offset < size; ) {
        const before = offset;
        let problem: unknown;
        try {
          const res = await peerFetch(app, peerId, `${at(made.id)}/data`, { headers: { range: `bytes=${offset}-${Math.min(size, offset + chunk) - 1}` }, timeoutMs: 5 * 60_000 });
          if (res.status === 404) throw new SnapshotGone("对方已经没有这份快照");
          if ((res.status !== 206 && res.status !== 200) || !res.body) throw new Error(`拉取失败：${res.status}`);
          // 200: something on the way dropped the `Range`, and this is the whole of it from the start.
          let pos = res.status === 200 ? 0 : Number(/^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1] ?? NaN);
          if (pos !== 0 && pos !== offset) throw new Error(`对方发来的不是要的那一段（${res.headers.get("content-range")}）`);
          for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
            writeSync(fd, part, 0, part.length, pos);
            pos += part.length;
            if (pos > offset) { offset = Math.min(pos, size); moved = Date.now(); }
          }
        } catch (e) {
          if (e instanceof SnapshotGone) throw e;
          problem = e;
        }
        if (offset >= size) break;
        if (offset > before) wait = opts.retryMs ?? 5000;
        if (problem || offset === before) {
          if (Date.now() - moved > stallMs) throw new Error(`快照传到 ${mb(offset)} / ${mb(size)} 后 ${Math.round(stallMs / 60_000)} 分钟没再收到数据：${problem ? reason(problem) : "对方没有发数据"}`);
          log(`  传到 ${mb(offset)} / ${mb(size)} 时断了（${problem ? reason(problem) : "对方没有发数据"}），${Math.round(wait / 1000)} 秒后接着传`);
          await sleep(wait);
          wait = Math.min(wait * 2, 60_000);
        } else if (Date.now() - said > 30_000) {
          log(`  已收 ${mb(offset)} / ${mb(size)}`);
          said = Date.now();
        }
      }
      return true;
    } catch (e) {
      if (!(e instanceof SnapshotGone) || round >= 3) throw e;
      log("  对方已经没有这份快照（服务重启过，或放得太久）：重新要一份，从头取");
    } finally {
      closeSync(fd);
      // Not waited for long, and not fatal: the other side drops it by itself after half an hour.
      await peerFetch(app, peerId, at(made.id), { method: "DELETE", timeoutMs: 10_000 }).then((r) => r.body?.cancel(), () => {});
    }
  }
}

export async function fetchPeer(app: App, peerId: string, opts: FetchOptions = {}): Promise<Fetched> {
  const { peerFetch } = await import("./peers.ts");
  const selection = opts.selection ?? { parts: [...PULL_PARTS] };
  const log = opts.log ?? (() => {});
  const dir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  log(`从设备 ${peerId} 拉取：数据库、${selection.parts.map((p) => PULL_PART_LABELS[p]).join("、") || "（不带其他内容）"}…`);
  const download = async (path: string, to: string, init: Parameters<typeof peerFetch>[3] = {}) => {
    const res = await peerFetch(app, peerId, path, { timeoutMs: 30 * 60_000, ...init });
    if (!res.ok || !res.body) throw new Error(`拉取失败：${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(to));
  };
  try {
    if (!(await fetchHeldSnapshot(app, peerId, selection, join(dir, "snapshot.tar"), opts))) {
      // An older device: the snapshot in one stream, made anew for every request.
      const query = new URLSearchParams({ parts: selection.parts.join(","), strip: selection.strip ? "1" : "0", files: "separate", ...(selection.since ? { since: selection.since } : {}) });
      await download(`/api/peer/snapshot?${query}`, join(dir, "snapshot.tar"));
    }
    const fetched = unpack(dir, selection);
    if (!existsSync(join(dir, "pull-manifest.json"))) {
      // Compatibility with old peers: include originals already present locally too,
      // because overwrite moves the existing store into the backup.
      const db = openDb(join(dir, "omem.db"));
      const wanted = new Set<string>();
      try {
        for (const row of all<{ text: string; meta: string }>(db, "select text, meta from sources where deleted_at is null")) {
          const original = JSON.parse(row.meta).original;
          if (typeof original === "string" && /^[\w.-]{1,120}$/.test(original) && original !== "." && original !== "..") wanted.add(original);
          for (const m of (row.text + row.meta).matchAll(/[a-f0-9]{16}\.[a-z0-9]+/g)) wanted.add(m[0]);
        }
        for (const row of all<{ resources: string }>(db, "select resources from lark_messages"))
          for (const m of row.resources.matchAll(/[a-f0-9]{16}\.[a-z0-9]+/g)) wanted.add(m[0]);
      } finally { db.close(); }
      for (const name of wanted) {
        if (existsSync(join(app.filesDir, name))) cpSync(join(app.filesDir, name), join(fetched.filesDir, name));
        else await download(`/api/files/${encodeURIComponent(name)}`, join(fetched.filesDir, name));
      }
      log("对方版本较旧：已补拉附件，代码仓库需要先升级对方再拉取。");
    } else if (selection.parts.includes("files") && selective(dir)) {
      // A newer peer left attachments out of the snapshot: list them and fetch only the missing ones.
      const { names } = await patiently(opts, "读对方的附件列表", async () => {
        const res = await peerFetch(app, peerId, "/api/peer/files");
        if (!res.ok) throw new Error(`读取对方附件列表失败：${res.status}`);
        return (await res.json()) as { names: string[] };
      });
      // Hundreds of batches over a link that may pass through another device: one that breaks is
      // asked again (it only reads), so a hiccup does not throw away the snapshot already fetched.
      await pullMissingFiles(fetched, names, opts, (batch, archive) =>
        patiently(opts, "拉这一批附件", () => download("/api/peer/files", archive, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: batch }), timeoutMs: 10 * 60_000 })));
    } else if (!selective(dir)) log("对方版本较旧，发来了全部内容；只合并选中的部分。");
    fetched.fetchedFiles = readdirSync(fetched.filesDir);
    return fetched;
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}
