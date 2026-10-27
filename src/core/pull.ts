import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reindexMemory } from "../memory/store.ts";
import { reindexSource } from "../sources/store.ts";
import { syncWiki } from "../wiki/store.ts";
import type { App } from "./app.ts";
import { all, openDb, run, tx } from "./db.ts";
import { commitLibrary, git } from "./git.ts";
import { listSpaces } from "./spaces.ts";
import { columns, prepareData, pullTables, rewriteLibrary, type Row } from "./pull-data.ts";
import { installRepositories, readManifest, relocate } from "./pull-repos.ts";
import { sha256 } from "./util.ts";
import type { Fetched } from "./pull-transfer.ts";
export { fetchRemote, fetchPeer, snapshotStream, type Fetched } from "./pull-transfer.ts";

/** Pull is a one-way merge of business data, library files, originals, repositories and run artifacts.
 * Device credentials, capture cursors, process sessions and search projections remain local.
 * Portable row identities distinguish integer primary keys allocated independently on two machines. */
export type PullOptions = { overwrite?: boolean; remoteHome?: string; dryRun?: boolean; log?: (s: string) => void };
export type MergeReport = Record<string, { added: number; updated: number; kept: number }> & { wiki?: { merged: boolean; conflicts: string[] } };

/** Incoming Git data supplies objects and history, never commands from its config or hooks. */
function sanitizeLibrary(dir: string) {
  if (!existsSync(join(dir, ".git"))) return;
  const format = git(dir, ["rev-parse", "--show-object-format"]).stdout.trim();
  if (!["sha1", "sha256"].includes(format) || !lstatSync(join(dir, ".git")).isDirectory()) throw new Error("知识库 Git 格式不支持");
  mkdirSync(join(dir, ".git/omem-empty-hooks"), { recursive: true });
  writeFileSync(join(dir, ".git/config"), `[core]\nrepositoryformatversion = ${format === "sha256" ? 1 : 0}\nbare = false\nhooksPath = .git/omem-empty-hooks\n[user]\nname = omem\nemail = omem@localhost\n${format === "sha256" ? "[extensions]\nobjectFormat = sha256\n" : ""}`);
}

/** Rows copied from another device must not restart its running jobs or agent processes. */
function localize(db: DatabaseSync, from: "r" | "main", protectedRuns: string[] = []) {
  const ids = (from === "r" ? "id in (select id from r.runs)" : "1") + (protectedRuns.length ? ` and id not in (${protectedRuns.map(() => "?").join(",")})` : "");
  // Retain the origin's revision time: a completion just after the snapshot must win the next pull.
  run(db, `update main.runs set status = 'cancelled', error = '在另一台机器上排队或运行中，拉取时取消', finished_at = coalesce(finished_at, started_at, created_at), profile_id = null, lane = null, not_before = null where status in ('queued','running') and ${ids}`, ...protectedRuns);
  if (from === "main") run(db, "update conversations set agent_session = null, agent_cwd = null where agent_session is not null");
  const asks = from === "r" ? "id in (select id from r.asks)" : "1";
  for (const a of all<{ id: string; sync_updated_at: string }>(db, `select id,sync_updated_at from main.asks where status = 'pending' and kind != 'suggestion' and ${asks} and (run_id is null or not exists(select 1 from main.runs where id = main.asks.run_id and status in ('queued','running')))`)) {
    run(db, "update asks set status = 'cancelled', sync_updated_at = '' where id = ?", a.id);
    run(db, "update asks set sync_updated_at = ? where id = ?", a.sync_updated_at, a.id);
  }
}

function copyDirContents(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (lstatSync(src).isDirectory()) copyDirContents(src, dest);
    else if (!existsSync(dest)) cpSync(src, dest, { verbatimSymlinks: true });
  }
}

/** Copy artifacts from the winning version of each run; keep conflicting local files beside them. */
function copyArtifacts(db: DatabaseSync, from: string, to: string) {
  if (!existsSync(from)) return;
  const copy = (src: string, dest: string) => {
    mkdirSync(dirname(dest), { recursive: true });
    if (lstatSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(src)) copy(join(src, name), join(dest, name));
    } else if (!existsSync(dest)) cpSync(src, dest, { verbatimSymlinks: true });
    else if (lstatSync(src).isFile() && lstatSync(dest).isFile() && !readFileSync(src).equals(readFileSync(dest))) {
      const backup = `${dest}.local-${sha256(readFileSync(dest)).slice(0, 12)}`;
      if (!existsSync(backup)) cpSync(dest, backup);
      cpSync(src, dest);
    }
  };
  for (const name of readdirSync(from)) {
    const remote = db.prepare("select coalesce(finished_at, started_at, created_at) at from r.runs where id = ?").get(name) as { at: string } | undefined;
    const local = db.prepare("select status, coalesce(finished_at, started_at, created_at) at from main.runs where id = ?").get(name) as { at: string; status: string } | undefined;
    if (local && ["queued", "running"].includes(local.status)) continue;
    if (!local || (remote && remote.at >= local.at)) copy(join(from, name), join(to, name));
  }
}

/** Replace the database and portable data, keeping a complete local backup and device configuration. */
export function overwriteLocal(home: string, fetched: Fetched | string) {
  const dir = typeof fetched === "string" ? fetched : fetched.dbDir;
  const lib = typeof fetched === "string" ? join(dir, "library") : fetched.libraryDir;
  const files = typeof fetched === "string" ? join(dir, "files") : fetched.filesDir;
  // Validate the snapshot and schema before moving any local data.
  openDb(join(dir, "omem.db")).close();
  readManifest(dir);
  const deviceTables = ["api_tokens", "kv", "lark_cursors"];
  const deviceData = new Map<string, Row[]>();
  if (existsSync(join(home, "omem.db"))) {
    const old = openDb(join(home, "omem.db"));
    try { for (const table of deviceTables) deviceData.set(table, all<Row>(old, `select * from ${table}`)); }
    finally { old.close(); }
  }
  const backup = `${home}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(backup, { recursive: true });
  const moved: string[] = [];
  let replacing = false;
  try {
    for (const name of ["omem.db", "omem.db-wal", "omem.db-shm", "library", "files", "runs", "repos"])
      if (existsSync(join(home, name))) { renameSync(join(home, name), join(backup, name)); moved.push(name); }
    replacing = true;
    cpSync(join(dir, "omem.db"), join(home, "omem.db"));
    if (existsSync(lib)) cpSync(lib, join(home, "library"), { recursive: true });
    sanitizeLibrary(join(home, "library"));
    mkdirSync(join(home, "files"), { recursive: true });
    if (existsSync(files)) copyDirContents(files, join(home, "files"));
    if (existsSync(join(dir, "runs"))) cpSync(join(dir, "runs"), join(home, "runs"), { recursive: true });
    const db = openDb(join(home, "omem.db"));
    try {
      tx(db, () => {
        for (const table of deviceTables) {
          run(db, `delete from ${table}`);
          const cols = columns(db, table);
          for (const row of deviceData.get(table) ?? []) db.prepare(`insert into ${table}(${cols.join(",")}) values(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
        }
        run(db, "update chunks set embedding = null where embedding is not null");
        run(db, "update memories set embedding = null where embedding is not null");
        for (const s of all<{ id: string; root_path: string }>(db, "select id, root_path from spaces where root_path is not null"))
          run(db, "update spaces set settings = json_set(settings, '$.remoteRootPath', root_path), root_path = null where id = ?", s.id);
        const paths = installRepositories(home, db, dir, () => {});
        rewriteLibrary(join(home, "library"), { ids: new Map(), lines: new Map() }, paths);
        commitLibrary(join(home, "library"), "pull: relocate imported paths");
        for (const s of all<{ id: string; settings: string }>(db, "select id,settings from spaces where kind = 'worktree'"))
          run(db, "update spaces set settings = ? where id = ?", relocate(s.settings, paths), s.id);
        for (const t of ["runs", "reviews", "item_materials", "sources"])
          for (const row of all<Row>(db, `select rowid as _rowid, * from ${t}`)) {
            const changes = Object.entries(row).filter(([c, v]) => c !== "_rowid" && (t !== "sources" || c === "meta") && typeof v === "string" && relocate(v, paths) !== v);
            if (changes.length) db.prepare(`update ${t} set ${changes.map(([c]) => `${c} = ?`).join(",")} where rowid = ?`).run(...changes.map(([, v]) => relocate(v as string, paths)), row._rowid);
          }
        localize(db, "main");
        run(db, "update rules set enabled = 0");
        run(db, "update schedules set enabled = 0");
        run(db, "update digest_jobs set status = 'paused' where status = 'active'");
      });
    } finally { db.close(); }
  } catch (e) {
    if (replacing) for (const name of ["omem.db", "omem.db-wal", "omem.db-shm", "library", "files", "runs", "repos"]) rmSync(join(home, name), { recursive: true, force: true });
    for (const name of moved) renameSync(join(backup, name), join(home, name));
    rmSync(backup, { recursive: true, force: true });
    throw e;
  }
  return backup;
}

export function mergeLibrary(app: App, fetched: Fetched | string, opts: { dryRun?: boolean; log?: (s: string) => void } = {}): MergeReport {
  const log = opts.log ?? (() => {});
  const dir = typeof fetched === "string" ? fetched : fetched.dbDir;
  const files = typeof fetched === "string" ? join(dir, "files") : fetched.filesDir;
  const lib = typeof fetched === "string" ? join(dir, "library") : fetched.libraryDir;
  const report = {} as MergeReport;
  const tally = (name: string) => (report[name] ??= { added: 0, updated: 0, kept: 0 });
  const db = app.db;
  const protectedRuns = all<{ id: string }>(db, "select id from runs where status in ('queued','running')").map((r) => r.id);
  // A dry run never fetches into existing checkouts or restores files.
  const paths = opts.dryRun ? new Map<string, string>() : installRepositories(app.home, db, dir, log);
  const prepared = prepareData(db, dir, paths);
  db.prepare("attach database ? as r").run(prepared.databasePath);
  try {
    tx(db, () => {
      for (const alias of prepared.aliases) db.prepare("insert into pull_aliases(table_name,remote_key,local_key) values(?,?,?) on conflict(table_name,remote_key) do update set local_key = excluded.local_key").run(...alias);
      for (const s of all<{ id: string; root_path: string | null }>(db, "select id, root_path from r.spaces where id not in (select id from main.spaces)")) {
        const cols = columns(db, "spaces").filter((c) => columns(db, "spaces", "r").includes(c));
        run(db, `insert into main.spaces(${cols.join(",")}) select ${cols.join(",")} from r.spaces where id = ?`, s.id);
        const settings = db.prepare("select settings from spaces where id = ?").get(s.id) as { settings: string };
        run(db, "update spaces set settings = ? where id = ?", relocate(settings.settings, paths), s.id);
        if (s.root_path) run(db, "update spaces set settings = json_set(settings, '$.remoteRootPath', root_path), root_path = ? where id = ?", paths.get(s.root_path) ?? null, s.id);
        tally("spaces").added++;
      }
      for (const s of prepared.sources) {
        const id = prepared.ids.get(s.id)!;
        const have = db.prepare("select text, updated_at, deleted_at from sources where id = ?").get(id) as { text: string; updated_at: string; deleted_at: string | null } | undefined;
        const growing = (s.kind === "chat" || s.kind === "conversation") && !s.deleted_at && !have?.deleted_at;
        const wins = !have || (growing ? s.text !== have.text || s.updated_at > have.updated_at : s.updated_at > have.updated_at);
        if (!wins) { tally("sources").kept++; continue; }
        const cols = columns(db, "sources").filter((c) => c !== "id");
        const vals = cols.map((c) => s[c]);
        if (have) db.prepare(`update sources set ${cols.map((c) => `${c} = ?`).join(",")} where id = ?`).run(...vals, id);
        else db.prepare(`insert into sources(id,${cols.join(",")}) values(?,${cols.map(() => "?").join(",")})`).run(id, ...vals);
        if (!opts.dryRun) reindexSource(app, id);
        tally("sources")[have ? "updated" : "added"]++;
      }
      if (!opts.dryRun) copyArtifacts(db, join(dir, "runs"), app.runsDir);
      for (const t of pullTables) {
        const cols = columns(db, t.name).filter((c) => columns(db, t.name, "r").includes(c) && !t.local?.includes(c));
        const match = t.key.map((k) => `l.${k} is x.${k}`).join(" and ");
        const sourceCheck = cols.includes("source_id") ? " and (x.source_id is null or x.source_id in (select id from main.sources))" : "";
        const values = cols.map((c) => t.name === "digest_jobs" && c === "status" ? "case when x.status = 'active' then 'paused' else x.status end" : `x.${c}`);
        const added = run(db, `insert into main.${t.name}(${cols.join(",")}) select ${values.join(",")} from r.${t.name} x where not exists(select 1 from main.${t.name} l where ${match})${sourceCheck}`).changes;
        let updated = 0;
        if (t.newer) {
          const stamp = (a: string) => t.newer!.replace(/\b(finished_at|started_at|created_at|updated_at|due_at|handled_at|sync_updated_at|checked_at)\b/g, `${a}.$1`);
          const update = cols.filter((c) => !t.key.includes(c));
          updated = Number(run(db, `update main.${t.name} as l set ${update.map((c) => `${c} = ${t.name === "digest_jobs" && c === "status" ? "case when x.status = 'active' then 'paused' else x.status end" : `x.${c}`}`).join(",")} from r.${t.name} x where ${match} and ${stamp("x")} > ${stamp("l")}${sourceCheck}${t.name === "runs" ? " and l.status not in ('queued','running')" : ""}`).changes);
        }
        const total = Number((db.prepare(`select count(*) n from r.${t.name}`).get() as { n: number }).n);
        Object.assign(tally(t.name), { added: Number(added), updated, kept: total - Number(added) - updated });
      }
      // Directory entries from chat senders are portable; existing identities remain authoritative.
      for (const p of all<Row>(db, "select * from r.lark_people")) {
        const found = db.prepare("select 1 from lark_people where (email is not null and email = ?) or (cli_open_id is not null and cli_open_id = ?) or (bot_open_id is not null and bot_open_id = ?) or (user_id is not null and user_id = ?) or (email is null and cli_open_id is null and bot_open_id is null and user_id is null and name = ?)").get(p.email, p.cli_open_id, p.bot_open_id, p.user_id, p.name);
        if (!found) {
          const cols = columns(db, "lark_people");
          db.prepare(`insert into lark_people(${cols.join(",")}) values(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => p[c]));
          tally("lark_people").added++;
        }
      }
      localize(db, "r", protectedRuns);
      if (!opts.dryRun) for (const m of all<{ id: string }>(db, "select m.id from memories m join r.memories x on x.id = m.id where x.updated_at = m.updated_at")) reindexMemory(app, m.id);
      if (opts.dryRun) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  finally { db.exec("detach database r"); }
  if (!opts.dryRun) {
    if (existsSync(files)) {
      tally("files").added = readdirSync(files).filter((name) => !existsSync(join(app.filesDir, name))).length;
      copyDirContents(files, app.filesDir);
    }
    rewriteLibrary(lib, prepared, paths);
    report.wiki = mergeWikiFiles(app, lib, log);
    for (const s of listSpaces(app)) syncWiki(app, s.id);
    if (report.rules?.added || report.schedules?.added) log("新拉来的任务规则和定时任务已停用；在本机启用后才执行。");
  }
  return report;
}
class DryRun extends Error {}

/** Merge the remote library's Git history; on conflicts keep ours and write theirs beside it. */
function mergeWikiFiles(app: App, remoteLibrary: string, log: (s: string) => void) {
  const conflicts: string[] = [];
  if (!existsSync(join(remoteLibrary, ".git"))) {
    // No history to merge: copy files that do not exist here.
    if (existsSync(remoteLibrary)) copyMissing(remoteLibrary, app.libraryDir, conflicts);
    commitLibrary(app.libraryDir, "pull: add remote pages");
    return { merged: true, conflicts };
  }
  commitLibrary(app.libraryDir, "pull: local changes before merge");
  sanitizeLibrary(remoteLibrary);
  commitLibrary(remoteLibrary, "pull: include snapshot files and relocated citations");
  const lib = app.libraryDir;
  const fetch = git(lib, ["fetch", "-q", remoteLibrary, "HEAD:refs/omem/pulled"]);
  if (!fetch.ok) {
    log(`知识库 Git 拉取失败（${fetch.stderr.trim().slice(0, 200)}），改为复制缺少的文件`);
    copyMissing(remoteLibrary, lib, conflicts);
    commitLibrary(lib, "pull: add remote pages");
    return { merged: false, conflicts };
  }
  const merge = git(lib, ["-c", "user.name=omem", "-c", "user.email=omem@localhost", "merge", "-q", "--no-edit", "--allow-unrelated-histories", "-m", "pull: merge remote library", "refs/omem/pulled"]);
  if (!merge.ok) {
    const unmerged = git(lib, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    if (!unmerged.length) throw new Error(`知识库合并失败：${merge.stderr.trim().slice(-400)}`);
    for (const path of unmerged) {
      // Keep ours; save theirs next to it so nothing is lost.
      const ours = spawnSync("git", ["show", `:2:${path}`], { cwd: lib, maxBuffer: 256 * 1024 ** 2 });
      const theirs = spawnSync("git", ["show", `refs/omem/pulled:${path}`], { cwd: lib, maxBuffer: 256 * 1024 ** 2 });
      if (ours.status === 0) {
        mkdirSync(dirname(join(lib, path)), { recursive: true });
        writeFileSync(join(lib, path), ours.stdout);
      } else rmSync(join(lib, path), { force: true });
      if (theirs.status === 0) {
        const alt = path.replace(/(\.md)?$/, ".remote$1");
        mkdirSync(dirname(join(lib, alt)), { recursive: true });
        writeFileSync(join(lib, alt), theirs.stdout);
      }
      conflicts.push(path);
    }
    git(lib, ["add", "-A"]);
    const saved = git(lib, ["-c", "user.name=omem", "-c", "user.email=omem@localhost", "commit", "-q", "--no-edit", "-m", "pull: merge remote library (kept local on conflicts)"]);
    if (!saved.ok) throw new Error(`知识库冲突已保存，但提交失败：${saved.stderr.trim().slice(-400)}`);
  }
  git(lib, ["update-ref", "-d", "refs/omem/pulled"]);
  return { merged: true, conflicts };
}
function copyMissing(from: string, to: string, conflicts: string[]) {
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      const target = join(to, relative(from, full));
      if (e.isDirectory()) {
        mkdirSync(target, { recursive: true });
        visit(full);
      } else if (!existsSync(target)) cpSync(full, target);
      else if (!e.isSymbolicLink() && !readFileSync(full).equals(readFileSync(target))) {
        const alt = target.replace(/(\.md)?$/, ".remote$1");
        cpSync(full, alt);
        conflicts.push(relative(from, full));
      }
    }
  };
  visit(from);
}

export function cleanupFetched(fetched: Fetched | string) {
  const dir = typeof fetched === "string" ? fetched : fetched.dbDir;
  if (dir.startsWith(tmpdir()) && existsSync(dir) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
  const files = typeof fetched === "string" ? null : fetched.filesDir;
  if (files && files.startsWith(tmpdir()) && existsSync(files) && statSync(files).isDirectory()) rmSync(files, { recursive: true, force: true });
}
