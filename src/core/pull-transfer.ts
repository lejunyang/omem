import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
export type PullSelection = { parts: PullPart[]; strip?: boolean };
export type FetchOptions = { selection?: PullSelection; log?: (s: string) => void; dryRun?: boolean; haveFile?: (name: string) => boolean };

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

function untar(dir: string, archive: string) {
  // Relative to the snapshot dir: GNU tar (Git for Windows) reads "C:\…" as a remote host.
  const listing = spawnSync("tar", ["-tf", archive], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 ** 2 });
  if (listing.status !== 0 || listing.stdout.split("\n").some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes(".."))) throw new Error("快照目录不合法或传输不完整");
  const r = spawnSync("tar", ["-xf", archive], { cwd: dir });
  if (r.status !== 0) throw new Error(`解包失败：${r.stderr.toString().slice(-300)}`);
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

/** The snapshot as a tar stream. No selection: everything, attachments included (older pullers). */
export async function snapshotStream(app: App, selection?: PullSelection & { separateFiles?: boolean }): Promise<Readable> {
  const dir = mkdtempSync(join(tmpdir(), "omem-snap-"));
  const parts = selection?.parts ?? [...PULL_PARTS];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "-e", snapshotScript, app.home, dir, JSON.stringify({ parts, strip: !!selection?.strip })], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-1000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`生成快照失败：${error}`)));
    });
    const names = ["library", "files"].filter((name) => parts.includes(name as PullPart) && !(name === "files" && selection?.separateFiles) && existsSync(join(app.home, name)));
    return tarStream(["-cf", "-", "-C", dir, ".", ...(names.length ? ["-C", app.home, ...names] : [])], () => rmSync(dir, { recursive: true, force: true }));
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
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
    const query = new URLSearchParams({ parts: selection.parts.join(","), strip: selection.strip ? "1" : "0", files: "separate" });
    await download(`/api/peer/snapshot?${query}`, join(dir, "snapshot.tar"));
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
      const res = await peerFetch(app, peerId, "/api/peer/files");
      if (!res.ok) throw new Error(`读取对方附件列表失败：${res.status}`);
      const { names } = (await res.json()) as { names: string[] };
      await pullMissingFiles(fetched, names, opts, (batch, archive) =>
        download("/api/peer/files", archive, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: batch }) }));
    } else if (!selective(dir)) log("对方版本较旧，发来了全部内容；只合并选中的部分。");
    fetched.fetchedFiles = readdirSync(fetched.filesDir);
    return fetched;
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}
