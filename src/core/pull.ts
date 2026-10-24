import { spawn, spawnSync } from "node:child_process";
import type { Readable } from "node:stream";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reindexMemory } from "../memory/store.ts";
import { reindexSource } from "../sources/store.ts";
import { syncWiki } from "../wiki/store.ts";
import type { App } from "./app.ts";
import { all, openDb, run, tx } from "./db.ts";
import { commitLibrary, git } from "./git.ts";
import { listSpaces } from "./spaces.ts";

/**
 * Moving a library between machines: the server keeps capturing, the laptop is
 * where you code. `omem pull <ssh-host>` copies the remote library and then
 * either replaces the local one (`--overwrite`, a backup is kept) or merges it
 * into the local one (default).
 *
 * Copy: on the remote, `VACUUM INTO` writes a consistent snapshot of the live
 * database (WAL and a running service are fine); `library/` and `files/` come
 * along in one tar stream. Nothing on the remote is changed besides a temp file.
 *
 * Merge rules — ids are globally unique (time + random), so the same id on
 * both sides is the same record:
 * - sources: keyed by (space, uri). The newer `updated_at` wins; chat and
 *   conversation sources only grow, so the longer text wins. Indexes are rebuilt.
 * - memories, items, cards, runs, conversations: by id, newer `updated_at`
 *   (or finish time) wins; superseded memories keep their chain because both
 *   sides of a supersede are copied.
 * - append-only history (item events, messages, run events, card reviews,
 *   notifications, handled messages): union, duplicates skipped.
 * - spaces, users and identities: missing ones are added; existing ones keep
 *   the local settings (paths differ per machine). A repo space whose path does
 *   not exist here is added without its path, so it can be re-linked.
 * - wiki pages and skills are files: the remote library is fetched as a Git
 *   remote and merged; conflicting pages keep the local version with the
 *   remote one saved next to it. Originals in files/ are content-addressed and
 *   simply copied.
 * - machine-local state stays: config, secrets, kv cursors, schedules, Feishu
 *   capture cursors, vectors (embeddings are recomputed for new chunks).
 */

export type PullOptions = { overwrite?: boolean; remoteHome?: string; dryRun?: boolean; log?: (s: string) => void };
export type MergeReport = Record<string, { added: number; updated: number; kept: number }> & { wiki?: { merged: boolean; conflicts: string[] } };

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type Fetched = { dbDir: string; libraryDir: string; filesDir: string; fetchedFiles: string[] };

/** Fetch a consistent copy of a remote library. Only originals local rows reference but lack are copied. */
export function fetchRemote(app: App, host: string, remoteHome = "~/.omem", log: (s: string) => void = () => {}): Fetched {
  if (!/^[A-Za-z0-9_.@:-]+$/.test(host)) throw new Error(`主机名不合法：${host}`);
  const dbDir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  const filesDir = mkdtempSync(join(tmpdir(), "omem-pull-files-"));
  const home = remoteHome === "~/.omem" ? "$HOME/.omem" : sh(remoteHome);
  // The service's own node has node:sqlite; fall back to whatever node is on PATH.
  const snapshot = `set -e; H=${home}; test -f "$H/omem.db" || { echo "远端没有 $H/omem.db" >&2; exit 3; }
N=$(sed -n 's/.*"interpreter": *"\\([^"]*\\)".*/\\1/p' "$H/service/ecosystem.json" 2>/dev/null | head -1); [ -x "$N" ] || N=node
T=$(mktemp -d); "$N" --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");new DatabaseSync(process.argv[1],{readOnly:true}).prepare("vacuum into ?").run(process.argv[2])' "$H/omem.db" "$T/omem.db"
cd "$H"; tar -cf - -C "$T" omem.db -C "$H" $(ls -d library 2>/dev/null); rm -rf "$T"`;
  log(`从 ${host}:${remoteHome} 拉取快照…`);
  const ssh = spawnSync("ssh", ["-o", "BatchMode=yes", host, snapshot], { maxBuffer: 4 * 1024 ** 3, encoding: "buffer" });
  if (ssh.status !== 0) throw new Error(`ssh 失败：${ssh.stderr.toString().trim().slice(-400) || `退出码 ${ssh.status}`}`);
  const untar = spawnSync("tar", ["-xf", "-", "-C", dbDir], { input: ssh.stdout });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr.toString().slice(-300)}`);
  if (!existsSync(join(dbDir, "omem.db"))) throw new Error("远端快照里没有 omem.db");

  // Originals referenced by local sources but missing here: fetch just those from the remote files dir.
  const wanted = new Set(
    (app.db.prepare("select distinct json_extract(meta, '$.original') f from sources where deleted_at is null and json_extract(meta, '$.original') is not null").all() as { f: string }[])
      .map((r) => r.f)
      .filter((f) => /^[\w.-]{1,120}$/.test(f) && existsSync(join(app.filesDir, f)) === false),
  );
  const fetchedFiles: string[] = [];
  if (wanted.size) {
    const names = [...wanted];
    const onlyFiles = `set -e; H=${home}; cd "$H/files"; tar -cf - ${names.map((f) => sh(f)).join(" ")}`;
    const r = spawnSync("ssh", ["-o", "BatchMode=yes", host, onlyFiles], { maxBuffer: 4 * 1024 ** 3, encoding: "buffer" });
    if (r.status === 0) {
      const u = spawnSync("tar", ["-xf", "-", "-C", filesDir], { input: r.stdout });
      if (u.status === 0) for (const f of names) if (existsSync(join(filesDir, f))) fetchedFiles.push(f);
    } else log(`部分原件没能拉取（${r.stderr.toString().trim().slice(0, 120)}），数据库内容不受影响`);
  }
  log(`已拉取 ${(ssh.stdout.length / 1024 / 1024).toFixed(1)} MB${fetchedFiles.length ? `，另拉 ${fetchedFiles.length} 个本地缺少的原件` : ""}`);
  return { dbDir, libraryDir: join(dbDir, "library"), filesDir, fetchedFiles };
}

/**
 * The same consistent snapshot `fetchRemote` takes over ssh, as a tar stream over HTTP
 * (`GET /api/peer/snapshot`): `VACUUM INTO` a temp file, then omem.db plus library/.
 */
export function snapshotStream(app: App): Readable {
  const dir = mkdtempSync(join(tmpdir(), "omem-snap-"));
  app.db.prepare("vacuum into ?").run(join(dir, "omem.db"));
  const args = ["-cf", "-", "-C", dir, "omem.db", ...(existsSync(app.libraryDir) ? ["-C", app.home, relative(app.home, app.libraryDir)] : [])];
  const tar = spawn("tar", args, { stdio: ["ignore", "pipe", "ignore"] });
  tar.on("close", () => rmSync(dir, { recursive: true, force: true }));
  return tar.stdout;
}

/** Fetch a peer's library over HTTP (directly or via another peer); same result as fetchRemote. */
export async function fetchPeer(app: App, peerId: string, log: (s: string) => void = () => {}): Promise<Fetched> {
  const { peerFetch } = await import("./peers.ts");
  const dbDir = mkdtempSync(join(tmpdir(), "omem-pull-"));
  const filesDir = mkdtempSync(join(tmpdir(), "omem-pull-files-"));
  log(`从同伴 ${peerId} 拉取快照…`);
  const res = await peerFetch(app, peerId, "/api/peer/snapshot", { timeoutMs: 30 * 60_000 });
  if (!res.ok) throw new Error(`拉取失败：${res.status} ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const untar = spawnSync("tar", ["-xf", "-", "-C", dbDir], { input: buf, maxBuffer: 4 * 1024 ** 3 });
  if (untar.status !== 0) throw new Error(`解包失败：${untar.stderr.toString().slice(-300)}`);
  if (!existsSync(join(dbDir, "omem.db"))) throw new Error("快照里没有 omem.db");
  // Originals the snapshot's rows reference but this machine lacks.
  const snap = openDb(join(dbDir, "omem.db"));
  const wanted = (snap.prepare("select distinct json_extract(meta, '$.original') f from sources where deleted_at is null and json_extract(meta, '$.original') is not null").all() as { f: string }[])
    .map((r) => r.f)
    .filter((f) => /^[a-f0-9]{16}\.[a-z0-9]+$/.test(f) && !existsSync(join(app.filesDir, f)));
  snap.close();
  const fetchedFiles: string[] = [];
  for (const f of wanted) {
    try {
      const r = await peerFetch(app, peerId, `/api/files/${f}`);
      if (r.ok) {
        writeFileSync(join(filesDir, f), Buffer.from(await r.arrayBuffer()));
        fetchedFiles.push(f);
      }
    } catch {}
  }
  log(`已拉取 ${(buf.length / 1024 / 1024).toFixed(1)} MB${fetchedFiles.length ? `，另拉 ${fetchedFiles.length} 个本地缺少的原件` : ""}`);
  return { dbDir, libraryDir: join(dbDir, relative(app.home, app.libraryDir) || "library"), filesDir, fetchedFiles };
}

/** Replace the local library with a fetched one; the old one is moved aside. Config and secrets stay. */
export function overwriteLocal(home: string, fetched: Fetched | string) {
  const dbDir = typeof fetched === "string" ? fetched : fetched.dbDir;
  const fetchedLibrary = typeof fetched === "string" ? join(fetched, "library") : fetched.libraryDir;
  const fetchedFiles = typeof fetched === "string" ? join(fetched, "files") : fetched.filesDir;
  const backup = `${home}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(backup, { recursive: true });
  for (const name of ["omem.db", "omem.db-wal", "omem.db-shm", "library", "files"])
    if (existsSync(join(home, name))) renameSync(join(home, name), join(backup, name));
  renameSync(join(dbDir, "omem.db"), join(home, "omem.db"));
  if (existsSync(fetchedLibrary)) renameSync(fetchedLibrary, join(home, "library"));
  mkdirSync(join(home, "files"), { recursive: true });
  if (existsSync(fetchedFiles)) copyDirContents(fetchedFiles, join(home, "files"));
  const extraFiles = typeof fetched === "object" ? fetched.fetchedFiles : [];
  void extraFiles;
  const db = openDb(join(home, "omem.db"));
  try {
    tx(db, () => {
      localize(db, "main");
      for (const s of all<{ id: string; root_path: string | null }>(db, "select id, root_path from spaces where root_path is not null")) if (!existsSync(s.root_path!)) unlinkMissingRoot(db, s.id);
    });
  } finally {
    db.close();
  }
  return backup;
}

function copyDirContents(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (lstatSync(src).isDirectory()) cpSync(src, join(to, name), { recursive: true });
    else if (!existsSync(join(to, name))) cpSync(src, join(to, name));
  }
}

/**
 * Rows that came from another machine must not act here: queued or running jobs
 * would run again (and could message people twice), and agent sessions belong
 * to the other machine's agent processes.
 */
function localize(db: DatabaseSync, from: "r" | "main") {
  const ids = from === "r" ? "id in (select id from r.runs)" : "1";
  run(db, `update main.runs set status = 'cancelled', error = '在另一台机器上排队或运行中，拉取时取消', finished_at = coalesce(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) where status in ('queued','running') and ${ids}`);
  const convs = from === "r" ? "id in (select id from r.conversations x where x.agent_session is main.conversations.agent_session)" : "1";
  run(db, `update main.conversations set agent_session = null, agent_cwd = null where agent_session is not null and ${convs}`);
}

/** A repo path from another machine: keep it in settings so the space can be re-linked here. */
function unlinkMissingRoot(db: DatabaseSync, spaceId: string) {
  run(db, "update main.spaces set settings = json_set(settings, '$.remoteRootPath', root_path), root_path = null where id = ?", spaceId);
}

type Table = { name: string; key: string[]; newer?: string; columns?: string[] };
// Order matters for foreign keys: parents first.
const BY_ID: Table[] = [
  { name: "memories", key: ["id"], newer: "updated_at" },
  { name: "items", key: ["id"], newer: "updated_at" },
  { name: "conversations", key: ["id"], newer: "updated_at" },
  { name: "runs", key: ["id"], newer: "coalesce(finished_at, started_at, created_at)" },
  { name: "cards", key: ["id"], newer: "due_at" },
  { name: "learn_goals", key: ["id"], newer: "updated_at" },
  { name: "card_interactions", key: ["id"], newer: "coalesce(handled_at, created_at)" },
];
const APPEND: Table[] = [
  { name: "item_events", key: ["item_id", "at", "kind", "text"] },
  { name: "messages", key: ["id"] },
  { name: "run_events", key: ["run_id", "seq"] },
  { name: "card_reviews", key: ["card_id", "at", "user_id"] },
  { name: "notifications", key: ["id"] },
  { name: "handled_messages", key: ["channel", "message_id"] },
  { name: "chat_settings", key: ["channel", "chat_id"] },
  { name: "users", key: ["id"] },
  { name: "identities", key: ["channel", "external_id"] },
  { name: "space_members", key: ["space_id", "user_id"] },
  { name: "space_relations", key: ["space_a", "space_b"] },
  { name: "memory_folders", key: ["space_id", "path"] },
];

function columns(db: DatabaseSync, table: string, schema = "main") {
  return (db.prepare(`pragma ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Merge a fetched library into the open local one. */
export function mergeLibrary(app: App, fetched: Fetched | string, opts: { dryRun?: boolean; log?: (s: string) => void } = {}): MergeReport {
  const log = opts.log ?? (() => {});
  const db = app.db;
  const report = {} as MergeReport;
  const tally = (t: string) => (report[t] ??= { added: 0, updated: 0, kept: 0 });
  const dbDir = typeof fetched === "string" ? fetched : fetched.dbDir;
  const fetchedFiles = typeof fetched === "string" ? join(fetched, "files") : fetched.filesDir;
  // Bring the snapshot (a private temp copy) up to this version's schema before reading it.
  openDb(join(dbDir, "omem.db")).close();
  db.prepare("attach database ? as r").run(join(dbDir, "omem.db"));
  try {
    tx(db, () => {
      // Spaces: add missing ones; keep local settings and paths.
      for (const s of all<{ id: string; root_path: string | null }>(db, "select id, root_path from r.spaces where id not in (select id from main.spaces) and kind != 'worktree'")) {
        const cols = columns(db, "spaces").filter((c) => columns(db, "spaces", "r").includes(c));
        run(db, `insert into main.spaces(${cols.join(",")}) select ${cols.join(",")} from r.spaces where id = ?`, s.id);
        if (s.root_path && !existsSync(s.root_path)) unlinkMissingRoot(db, s.id);
        tally("spaces").added++;
      }

      // Sources by (space, uri).
      const rows = all<{ id: string; space_id: string; uri: string; kind: string; updated_at: string; len: number; deleted_at: string | null; local_id: string | null; local_updated: string | null; local_len: number | null }>(
        db,
        `select r.id, r.space_id, r.uri, r.kind, r.updated_at, length(r.text) len, r.deleted_at,
                l.id local_id, l.updated_at local_updated, length(l.text) local_len
           from r.sources r left join main.sources l on l.space_id = r.space_id and l.uri = r.uri
          where r.space_id not in (select id from r.spaces where kind = 'worktree')`,
      );
      const srcCols = columns(db, "sources").filter((c) => columns(db, "sources", "r").includes(c) && c !== "id");
      const idMap = new Map<string, string>();
      for (const s of rows) {
        const t = tally("sources");
        const growing = s.kind === "chat" || s.kind === "conversation";
        if (!s.local_id) {
          // A different local source may already use this id (never in practice: ids are random).
          run(db, `insert into main.sources(id,${srcCols.join(",")}) select id,${srcCols.join(",")} from r.sources where id = ?`, s.id);
          if (!opts.dryRun) reindexSource(app, s.id);
          idMap.set(s.id, s.id);
          t.added++;
          continue;
        }
        idMap.set(s.id, s.local_id);
        const remoteWins = growing ? s.len > (s.local_len ?? 0) : s.updated_at > (s.local_updated ?? "");
        if (!remoteWins) {
          t.kept++;
          continue;
        }
        run(db, `update main.sources set ${srcCols.map((c) => `${c} = (select ${c} from r.sources where id = ?)`).join(", ")} where id = ?`, ...srcCols.map(() => s.id), s.local_id);
        if (!opts.dryRun) reindexSource(app, s.local_id);
        t.updated++;
      }
      // References to remote source ids that map to a different local id (same space+uri).
      const remap = [...idMap].filter(([a, b]) => a !== b);

      for (const t of BY_ID) {
        if (!tableExists(db, t.name, "r")) continue;
        const cols = columns(db, t.name).filter((c) => columns(db, t.name, "r").includes(c));
        const cmp = (alias: string) => t.newer!.replace(/\b(finished_at|started_at|created_at|updated_at|due_at|handled_at)\b/g, `${alias}.$1`);
        const added = run(db, `insert into main.${t.name}(${cols.join(",")}) select ${cols.join(",")} from r.${t.name} x where x.id not in (select id from main.${t.name})`).changes;
        // Only columns in this machine's writable state are taken from the remote: run history
        // (title/input/output/error/timestamps/status) is shared, but the runtime columns below
        // describe the other machine's agent processes and must never overwrite the local ones.
        const machineLocal = new Set(["profile_id", "lane", "not_before"]);
        const updatable = cols.filter((c) => c !== "id" && !machineLocal.has(c));
        const updated = run(
          db,
          `update main.${t.name} as l set ${updatable.map((c) => `${c} = x.${c}`).join(", ")}
             from r.${t.name} as x where x.id = l.id and ${cmp("x")} > ${cmp("l")}`,
        ).changes;
        const total = (db.prepare(`select count(*) n from r.${t.name}`).get() as { n: number }).n;
        Object.assign(tally(t.name), { added: Number(added), updated: Number(updated), kept: total - Number(added) - Number(updated) });
      }

      for (const t of APPEND) {
        if (!tableExists(db, t.name, "r")) continue;
        const cols = columns(db, t.name).filter((c) => columns(db, t.name, "r").includes(c) && !(t.name === "item_events" && c === "id"));
        const match = t.key.map((k) => `l.${k} is x.${k}`).join(" and ");
        const added = run(db, `insert into main.${t.name}(${cols.join(",")}) select ${cols.map((c) => `x.${c}`).join(",")} from r.${t.name} x where not exists (select 1 from main.${t.name} l where ${match})`).changes;
        tally(t.name).added = Number(added);
      }

      // Remote-only rows that cite a remote source id now pointing at the merged local one.
      for (const [from, to] of remap) {
        for (const table of ["memories", "items", "item_events", "cards"])
          run(db, `update main.${table} set source_refs = replace(source_refs, ?, ?) where source_refs like ?`, `src:${from}`, `src:${to}`, `%src:${from}%`);
      }
      localize(db, "r");
      // Rebuild full-text rows of memories that came over or changed.
      if (!opts.dryRun)
        for (const m of all<{ id: string }>(db, "select m.id from main.memories m join r.memories x on x.id = m.id where x.updated_at = m.updated_at")) reindexMemory(app, m.id);
      if (opts.dryRun) throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  } finally {
    db.exec("detach database r");
  }

  if (!opts.dryRun) {
    // Originals: copy what local rows reference or what is missing locally.
    let files = 0;
    if (existsSync(fetchedFiles))
      for (const name of readdirSync(fetchedFiles))
        if (!existsSync(join(app.filesDir, name))) {
          cpSync(join(fetchedFiles, name), join(app.filesDir, name), { recursive: true });
          files++;
        }
    tally("files").added = files;
    const libraryDir = typeof fetched === "string" ? join(fetched, "library") : fetched.libraryDir;
    report.wiki = mergeWikiFiles(app, libraryDir, log);
    for (const s of listSpaces(app)) syncWiki(app, s.id);
  }
  return report;
}

class DryRun extends Error {}

function tableExists(db: DatabaseSync, name: string, schema: string) {
  return !!db.prepare(`select 1 from ${schema}.sqlite_master where type = 'table' and name = ?`).get(name);
}

/** Merge the remote library's Git history; on conflicts keep ours and write theirs beside it. */
function mergeWikiFiles(app: App, remoteLibrary: string, log: (s: string) => void) {
  const conflicts: string[] = [];
  if (!existsSync(join(remoteLibrary, ".git"))) {
    // No history to merge: copy files that do not exist here.
    if (existsSync(remoteLibrary)) copyMissing(remoteLibrary, app.libraryDir);
    commitLibrary(app.libraryDir, "pull: add remote pages");
    return { merged: true, conflicts };
  }
  commitLibrary(app.libraryDir, "pull: local changes before merge");
  const lib = app.libraryDir;
  const fetch = git(lib, ["fetch", "-q", remoteLibrary, "HEAD:refs/omem/pulled"]);
  if (!fetch.ok) {
    log(`知识库 Git 拉取失败（${fetch.stderr.trim().slice(0, 200)}），改为复制缺少的文件`);
    copyMissing(remoteLibrary, lib);
    commitLibrary(lib, "pull: add remote pages");
    return { merged: false, conflicts };
  }
  const merge = git(lib, ["-c", "user.name=omem", "-c", "user.email=omem@localhost", "merge", "-q", "--no-edit", "--allow-unrelated-histories", "-m", "pull: merge remote library", "refs/omem/pulled"]);
  if (!merge.ok) {
    const unmerged = git(lib, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    for (const path of unmerged) {
      // Keep ours; save theirs next to it so nothing is lost.
      const theirs = git(lib, ["show", `refs/omem/pulled:${path}`]);
      git(lib, ["checkout", "--ours", "--", path]);
      if (theirs.ok) {
        const alt = path.replace(/(\.md)?$/, ".remote$1");
        writeFileSync(join(lib, alt), theirs.stdout);
        conflicts.push(path);
      }
    }
    git(lib, ["add", "-A"]);
    git(lib, ["-c", "user.name=omem", "-c", "user.email=omem@localhost", "commit", "-q", "--no-edit", "-m", "pull: merge remote library (kept local on conflicts)"]);
  }
  git(lib, ["update-ref", "-d", "refs/omem/pulled"]);
  return { merged: true, conflicts };
}
function copyMissing(from: string, to: string) {
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      const target = join(to, relative(from, full));
      if (e.isDirectory()) {
        mkdirSync(target, { recursive: true });
        visit(full);
      } else if (!existsSync(target)) cpSync(full, target);
    }
  };
  visit(from);
}

export function cleanupFetched(fetched: Fetched | string) {
  const dir = typeof fetched === "string" ? fetched : fetched.dbDir;
  if (dir.startsWith(tmpdir()) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
  const files = typeof fetched === "string" ? null : fetched.filesDir;
  if (files && files.startsWith(tmpdir()) && statSync(files).isDirectory()) rmSync(files, { recursive: true, force: true });
}
