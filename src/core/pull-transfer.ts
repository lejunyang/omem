import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { App } from "./app.ts";
import { all, openDb } from "./db.ts";
import { snapshotScript } from "./pull-snapshot.ts";

export type Fetched = { dbDir: string; libraryDir: string; filesDir: string; fetchedFiles: string[] };
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function unpack(dir: string): Fetched {
  const archive = join(dir, "snapshot.tar");
  // Relative to the snapshot dir: GNU tar (Git for Windows) reads "C:\…" as a remote host.
  const listing = spawnSync("tar", ["-tf", "snapshot.tar"], { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 ** 2 });
  if (listing.status !== 0 || listing.stdout.split("\n").some((p) => p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes(".."))) throw new Error("快照目录不合法或传输不完整");
  const untar = spawnSync("tar", ["-xf", "snapshot.tar"], { cwd: dir });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr.toString().slice(-300)}`);
  rmSync(archive);
  if (!existsSync(join(dir, "omem.db"))) throw new Error("快照里没有 omem.db");
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  return { dbDir: dir, libraryDir: join(dir, "library"), filesDir, fetchedFiles: readdirSync(filesDir) };
}

/** SSH and HTTP use the same snapshot program and transfer complete file stores. */
export function fetchRemote(_app: App, host: string, remoteHome = "~/.omem", log: (s: string) => void = () => {}): Fetched {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(host) || host.startsWith("-")) throw new Error(`主机名不合法：${host}`);
  const dir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  const home = remoteHome === "~/.omem" ? "$HOME/.omem" : sh(remoteHome);
  const script = `set -eu
H=${home}; test -f "$H/omem.db" || { echo "远端没有数据库" >&2; exit 3; }
N=$(sed -n 's/.*"interpreter": *"\\([^"]*\\)".*/\\1/p' "$H/service/ecosystem.json" 2>/dev/null | head -1); [ -x "$N" ] || N=node
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
"$N" --no-warnings -e ${sh(snapshotScript)} "$H" "$T"
set --
for D in library files; do if [ -d "$H/$D" ]; then set -- "$@" "$D"; fi; done
tar -cf - -C "$T" . -C "$H" "$@"`;
  log(`从 ${host}:${remoteHome} 拉取数据、文件和仓库…`);
  const fd = openSync(join(dir, "snapshot.tar"), "w");
  try {
    const ssh = spawnSync("ssh", ["-o", "BatchMode=yes", host, script], { stdio: ["ignore", fd, "pipe"], encoding: "utf8", maxBuffer: 1024 ** 2 });
    if (ssh.status !== 0) throw new Error(`ssh 失败：${ssh.stderr?.trim().slice(-400) || ssh.error || ssh.status}`);
    return unpack(dir);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally { closeSync(fd); }
}

export async function snapshotStream(app: App): Promise<Readable> {
  const dir = mkdtempSync(join(tmpdir(), "omem-snap-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "-e", snapshotScript, app.home, dir], { stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-1000); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`生成快照失败：${error}`)));
    });
    const names = ["library", "files"].filter((name) => existsSync(join(app.home, name)));
    const tar = spawn("tar", ["-cf", "-", "-C", dir, ".", "-C", app.home, ...names], { stdio: ["ignore", "pipe", "pipe"] });
    const output = new PassThrough();
    tar.stdout.pipe(output, { end: false });
    let error = "";
    tar.stderr.on("data", (b: Buffer) => { error = (error + b.toString()).slice(-500); });
    tar.on("error", (e) => output.destroy(e));
    tar.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (code !== 0) output.destroy(new Error(`快照归档失败：${error}`));
      else output.end();
    });
    output.on("close", () => { if (tar.exitCode === null) tar.kill(); });
    return output;
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

export async function fetchPeer(app: App, peerId: string, log: (s: string) => void = () => {}): Promise<Fetched> {
  const { peerFetch } = await import("./peers.ts");
  const dir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  log(`从设备 ${peerId} 拉取数据、文件和仓库…`);
  try {
    const res = await peerFetch(app, peerId, "/api/peer/snapshot", { timeoutMs: 30 * 60_000 });
    if (!res.ok || !res.body) throw new Error(`拉取失败：${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(join(dir, "snapshot.tar")));
    const fetched = unpack(dir);
    // Compatibility with old peers: include originals already present locally too,
    // because overwrite moves the existing store into the backup.
    if (!existsSync(join(dir, "pull-manifest.json"))) {
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
        else {
          const file = await peerFetch(app, peerId, `/api/files/${encodeURIComponent(name)}`);
          if (!file.ok || !file.body) throw new Error(`旧设备的原文件 ${name} 无法读取：${file.status}`);
          await pipeline(Readable.fromWeb(file.body as import("node:stream/web").ReadableStream), createWriteStream(join(fetched.filesDir, name)));
        }
      }
      log("对方版本较旧：已补拉附件，代码仓库需要先升级对方再拉取。");
    }
    fetched.fetchedFiles = readdirSync(fetched.filesDir);
    return fetched;
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}
