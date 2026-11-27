import { providerDeviceTables } from "../items/provider-schema.ts";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reindexMemory } from "../memory/store.ts";
import { reindexReq } from "../items/requirements.ts";
import { reindexSource } from "../sources/store.ts";
import { refTables } from "../sources/duplicates.ts";
import { syncWiki } from "../wiki/store.ts";
import type { App } from "./app.ts";
import { all, openDb, run, tx } from "./db.ts";
import { commitLibrary, git } from "./git.ts";
import { listSpaces } from "./spaces.ts";
import { columns, prepareData, pullTables, rewriteLibrary, type Row } from "./pull-data.ts";
import { installRepositories, readManifest, relocate } from "./pull-repos.ts";
import { sha256 } from "./util.ts";
import { PULL_PARTS, type Fetched, type PullPart } from "./pull-transfer.ts";
export { fetchRemote, fetchPeer, snapshotStream, filesStream, parseParts, PULL_PARTS, PULL_PART_LABELS, type Fetched, type PullPart, type PullSelection } from "./pull-transfer.ts";

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
  if (from === "main") {
    run(db, "update conversations set agent_session = null, agent_cwd = null where agent_session is not null");
    // An overwrite may restore a live window; keep its last known state but never resume it here.
    run(db, `update items set status='cancelled', closed_at=updated_at where status not in ('done','cancelled','expired')
      and id in (select item_id from situation_instances where status='active')`);
    run(db, `update situation_instances set status='ended', summary=current, ended_at=window_until, closing_run=null, closing_deadline=null where status='active'`);
    run(db, "delete from situation_feedback");
    run(db, "delete from situation_seen");
    run(db, "update listen_contexts set status='paused' where kind='situation'");
  }
  const asks = from === "r" ? "id in (select id from r.asks)" : "1";
  for (const a of all<{ id: string; sync_updated_at: string }>(db, `select id,sync_updated_at from main.asks where status = 'pending' and kind != 'suggestion' and ${asks} and (run_id is null or not exists(select 1 from main.runs where id = main.asks.run_id and status in ('queued','running')))`)) {
    run(db, "update asks set status = 'cancelled', sync_updated_at = '' where id = ?", a.id);
    run(db, "update asks set sync_updated_at = ? where id = ?", a.sync_updated_at, a.id);
  }
}

/** For one file or symbolic link: the link is copied as written. `recursive` only so that cpSync takes a link to a directory, which it otherwise refuses as a directory. */
const LINK_AS_WRITTEN = { recursive: true, verbatimSymlinks: true };

function copyDirContents(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (lstatSync(src).isDirectory()) copyDirContents(src, dest);
    else if (!existsSync(dest)) cpSync(src, dest, LINK_AS_WRITTEN);
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
    } else if (!existsSync(dest)) cpSync(src, dest, LINK_AS_WRITTEN);
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
  // Meetings this device is following (lark-meetings.ts) stay with it; their records travel as sources.
  // Share links point at this device's web address, so they stay too; so do remote recordings,
  // whose files are in this device's data directory (src/remote), and this device's bot's document subscriptions, and platform watches (they sync with this device's tokens).
  const deviceTables = ["api_tokens", "kv", "lark_cursors", "lark_meetings", "lark_meeting_lines", "shares", "session_cleanup", "remote_recordings", "lark_doc_subscriptions", "platform_watches", "flow_signals", "item_follow_cursors", "git_commit_cursors", "plugin_events", "plugin_deliveries", "plugin_subscriptions", "credential_kinds", "credential_holds", "credential_onboarding", "credential_access", "credential_run_grants", "outlet_deliveries"];
  deviceTables.push("plugin_hook_deliveries");
  const deviceData = new Map<string, Row[]>();
  if (existsSync(join(home, "omem.db"))) {
    const old = openDb(join(home, "omem.db"));
    try { for (const table of [...deviceTables, ...providerDeviceTables]) deviceData.set(table, all<Row>(old, `select * from ${table}`)); }
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
    // Attachments not transferred because this machine had them: from the backup.
    if (typeof fetched !== "string") for (const name of fetched.reused ?? []) if (existsSync(join(backup, "files", name)) && !existsSync(join(home, "files", name))) cpSync(join(backup, "files", name), join(home, "files", name));
    if (existsSync(join(dir, "runs"))) cpSync(join(dir, "runs"), join(home, "runs"), { recursive: true });
    const db = openDb(join(home, "omem.db"));
    try {
      tx(db, () => {
        // Older snapshot producers may include quota counters for runs on the other machine.
        run(db, "delete from cloud_tool_usage");
        for (const table of deviceTables) {
          run(db, `delete from ${table}`);
          const cols = columns(db, table);
          for (const row of deviceData.get(table) ?? []) db.prepare(`insert into ${table}(${cols.join(",")}) values(${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c]));
        }
        // Credentials and pending external actions belong to this device. A full overwrite may
        // remove local users, spaces or items; restore links only where the item's owner still matches.
        for (const table of providerDeviceTables) run(db, `delete from ${table}`);
        for (const table of [...providerDeviceTables].reverse()) {
          for (const row of deviceData.get(table) ?? []) {
            if (table === "item_provider_targets" && !db.prepare("select 1 from users, spaces where users.id=? and spaces.id=?").get(row.user_id, row.space_id)) continue;
            if (table === "external_item_links" && !db.prepare(`select 1 from items i join item_provider_targets t on i.user_id=t.user_id and i.space_id=t.space_id
                where i.id=? and t.id=?`).get(row.item_id, row.target_id)) {
              run(db, "update item_provider_targets set cursor=null where id=?", row.target_id);
              continue;
            }
            if (table === "item_provider_writes" && !db.prepare("select 1 from external_item_links where item_id=?").get(row.item_id)) continue;
            const cols = Object.keys(row);
            run(db, `insert into ${table}(${cols.join(",")}) values(${cols.map(() => "?").join(",")})`, ...cols.map(c => row[c]));
          }
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

/**
 * Drop what the pull did not ask for from an unpacked snapshot (an older device sends everything):
 * the library, attachments, run artifacts, and the repositories in the manifest that are not wanted.
 */
function narrow(fetched: Fetched) {
  const want = new Set<PullPart>(fetched.parts ?? PULL_PARTS);
  if (PULL_PARTS.every((p) => want.has(p))) return;
  if (!want.has("library")) rmSync(fetched.libraryDir, { recursive: true, force: true });
  if (!want.has("files")) {
    rmSync(fetched.filesDir, { recursive: true, force: true });
    mkdirSync(fetched.filesDir, { recursive: true });
    fetched.fetchedFiles = [];
  }
  if (!want.has("runs")) rmSync(join(fetched.dbDir, "runs"), { recursive: true, force: true });
  const manifest = readManifest(fetched.dbDir);
  if (!manifest) return;
  const kept = new Set<string>();
  manifest.repositories = manifest.repositories.filter((r) => {
    const ok = r.parent ? kept.has(r.parent) : r.target ? want.has("runs") : want.has("repos");
    if (ok) kept.add(r.key);
    return ok;
  });
  writeFileSync(join(fetched.dbDir, "pull-manifest.json"), JSON.stringify(manifest));
}

export function mergeLibrary(app: App, fetched: Fetched | string, opts: { dryRun?: boolean; log?: (s: string) => void; preferRemote?: boolean } = {}): MergeReport {
  const log = opts.log ?? (() => {});
  if (typeof fetched !== "string") narrow(fetched);
  const dir = typeof fetched === "string" ? fetched : fetched.dbDir;
  const files = typeof fetched === "string" ? join(dir, "files") : fetched.filesDir;
  const lib = typeof fetched === "string" ? join(dir, "library") : fetched.libraryDir;
  const report = {} as MergeReport;
  const tally = (name: string) => (report[name] ??= { added: 0, updated: 0, kept: 0 });
  const db = app.db;
  const protectedRuns = all<{ id: string }>(db, "select id from runs where status in ('queued','running')").map((r) => r.id);
  // Attachments first: they are named by their content, so they are right whatever happens next, and
  // a later step that fails does not send tens of thousands of them over the network again.
  if (!opts.dryRun && existsSync(files)) {
    tally("files").added = readdirSync(files).filter((name) => !existsSync(join(app.filesDir, name))).length;
    copyDirContents(files, app.filesDir);
  }
  // A dry run never fetches into existing checkouts or restores files.
  const paths = opts.dryRun ? new Map<string, string>() : installRepositories(app.home, db, dir, log);
  const prepared = prepareData(db, dir, paths);
  db.prepare("attach database ? as r").run(prepared.databasePath);
  try {
    tx(db, () => {
      for (const alias of prepared.aliases) db.prepare("insert into pull_aliases(table_name,remote_key,local_key) values(?,?,?) on conflict(table_name,remote_key) do update set local_key = excluded.local_key").run(...alias);
      // A space under another (a repository in its business space) goes in after the one it is under.
      const under = columns(db, "spaces", "r").includes("parent_id") ? "parent_id" : "null";
      const fresh = all<{ id: string; root_path: string | null; parent_id: string | null }>(db, `select id, root_path, ${under} as parent_id from r.spaces where id not in (select id from main.spaces)`);
      const placed = new Set(all<{ id: string }>(db, "select id from main.spaces").map((r) => r.id));
      const ordered: typeof fresh = [];
      for (let left = fresh; left.length; ) {
        const ready = left.filter((s) => !s.parent_id || placed.has(s.parent_id));
        // None ready: what is left points at spaces that exist nowhere, and the insert says so.
        for (const s of ready.length ? ready : left) { ordered.push(s); placed.add(s.id); }
        left = ready.length ? left.filter((s) => !ready.includes(s)) : [];
      }
      for (const s of ordered) {
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
      // Sources the other side has since put in another space. Moving one leaves its text and its time
      // alone, so nothing above took it. This side's own later move stands; before the move history
      // below is merged, `main.source_moves` holds what this side did and what earlier pulls brought.
      let moved = 0;
      for (const m of prepared.moves) {
        const cur = db.prepare("select space_id, uri, deleted_at from sources where id = ?").get(m.id) as { space_id: string; uri: string; deleted_at: string | null } | undefined;
        if (!cur || cur.deleted_at || cur.space_id === m.to || !db.prepare("select 1 from spaces where id = ?").get(m.to)) continue;
        const theirs = (db.prepare("select max(at) at from r.source_moves where source_id = ?").get(m.id) as { at: string | null }).at;
        const mine = (db.prepare("select max(at) at from main.source_moves where source_id = ?").get(m.id) as { at: string | null }).at;
        if (mine && (!theirs || theirs < mine)) continue;
        if (db.prepare("select 1 from sources where space_id = ? and uri = ? and id != ?").get(m.to, cur.uri, m.id)) continue;
        run(db, "insert or ignore into source_locations(origin_space,uri,source_id) values(?,?,?)", cur.space_id, cur.uri, m.id);
        run(db, "update sources set space_id = ? where id = ?", m.to, m.id);
        for (const table of ["chunks", "symbols", "code_refs"]) run(db, `update ${table} set space_id = ? where source_id = ?`, m.to, m.id);
        moved++;
      }
      if (moved) {
        tally("sources").updated += moved;
        tally("sources").kept = Math.max(0, tally("sources").kept - moved);
        log(`${moved} 份原件跟着对方换了空间`);
      }
      // Copies the other side has since merged into another source (sources/duplicates.ts): what hung
      // on the dropped copy hangs on the kept one there, the rows themselves unchanged. The same is
      // done to this side's rows first, or they would come in a second time under the kept copy and
      // stay behind under the dropped one.
      const merged = all<{ alias_id: string; source_id: string }>(db, "select x.alias_id, x.source_id from r.source_aliases x where not exists(select 1 from main.source_aliases l where l.alias_id = x.alias_id and l.source_id = x.source_id) and exists(select 1 from main.sources s where s.id = x.alias_id) and exists(select 1 from main.sources s where s.id = x.source_id)");
      if (merged.length) {
        const tables = refTables({ db });
        for (const a of merged) {
          for (const t of tables) {
            run(db, `update or ignore ${t} set source_id = ? where source_id = ?`, a.source_id, a.alias_id);
            run(db, `delete from ${t} where source_id = ?`, a.alias_id);
          }
          run(db, "update or ignore item_materials set ref = ? where kind = 'source' and ref = ?", a.source_id, a.alias_id);
          run(db, "delete from source_routes where source_id = ?", a.alias_id);
        }
      }
      if (!opts.dryRun) copyArtifacts(db, join(dir, "runs"), app.runsDir);
      for (const t of pullTables) {
        const cols = columns(db, t.name).filter((c) => columns(db, t.name, "r").includes(c) && !t.local?.includes(c));
        const quoted = (c: string) => `"${c.replaceAll('"', '""')}"`;
        const match = t.key.map((k) => `l.${quoted(k)} is x.${quoted(k)}`).join(" and ");
        const sourceCheck = cols.includes("source_id") ? " and (x.source_id is null or x.source_id in (select id from main.sources))" : "";
        const values = cols.map((c) => (t.name === "digest_jobs" || t.name === "listen_contexts") && c === "status" ? (`case when x.status = 'active'${t.name === "listen_contexts" ? " and x.kind = 'situation'" : ""} then 'paused' else x.status end`) : `x.${quoted(c)}`);
        // A row this side already has under another key (the same `sync_key`) is not taken a second time.
        const known = cols.includes("sync_key") ? ` and (x.sync_key = '' or not exists(select 1 from main.${t.name} k where k.sync_key = x.sync_key))` : "";
        const added = run(db, `insert into main.${t.name}(${cols.map(quoted).join(",")}) select ${values.join(",")} from r.${t.name} x where not exists(select 1 from main.${t.name} l where ${match})${sourceCheck}${known}`).changes;
        let updated = 0;
        if (t.newer) {
          const stamp = (a: string) => t.newer!.replace(/\b(finished_at|started_at|ended_at|created_at|updated_at|due_at|handled_at|sync_updated_at|checked_at|removed_at|resolved_at|decided_at|settled_at|labelled_at|revised_at|swept_at|at)\b/g, `${a}.$1`);
          const update = cols.filter((c) => !t.key.includes(c));
          updated = Number(run(db, `update main.${t.name} as l set ${update.map((c) => `${quoted(c)} = ${t.name === "digest_jobs" && c === "status" ? "case when x.status = 'active' then 'paused' else x.status end" : `x.${quoted(c)}`}`).join(",")} from r.${t.name} x where ${match} and ${stamp("x")} > ${stamp("l")}${sourceCheck}${t.name === "runs" ? " and l.status not in ('queued','running')" : ""}`).changes);
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
      if (!opts.dryRun) for (const q of all<{ id: string }>(db, "select q.id from req_nodes q join r.req_nodes x on x.id = q.id where x.updated_at = q.updated_at")) reindexReq(app, q.id);
      if (opts.dryRun) throw new DryRun();
    });
  } catch (e) { if (!(e instanceof DryRun)) throw e; }
  finally { db.exec("detach database r"); }
  if (!opts.dryRun) {
    rewriteLibrary(lib, prepared, paths);
    report.wiki = mergeWikiFiles(app, lib, log, !!opts.preferRemote);
    for (const s of listSpaces(app)) syncWiki(app, s.id);
    if (report.rules?.added || report.schedules?.added) log("新拉来的任务规则和定时任务已停用；在本机启用后才执行。");
  }
  return report;
}
class DryRun extends Error {}

/** Merge the remote library's Git history; on conflicts keep ours and write theirs beside it. */
/**
 * Merge the other side's library (a Git history) into this one. A page changed on both sides keeps
 * this side's text, the other's saved beside it as `.remote.md`; with `preferRemote` (a directory
 * kept as a backup of the other side) it is the other way round, this side's saved as `.local.md`.
 */
function mergeWikiFiles(app: App, remoteLibrary: string, log: (s: string) => void, preferRemote = false) {
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
      // Keep one side; save the other next to it so nothing is lost.
      const ours = spawnSync("git", ["show", `:2:${path}`], { cwd: lib, maxBuffer: 256 * 1024 ** 2 });
      const theirs = spawnSync("git", ["show", `refs/omem/pulled:${path}`], { cwd: lib, maxBuffer: 256 * 1024 ** 2 });
      const [kept, aside, suffix] = preferRemote ? [theirs, ours, ".local"] : [ours, theirs, ".remote"];
      if (kept.status === 0) {
        mkdirSync(dirname(join(lib, path)), { recursive: true });
        writeFileSync(join(lib, path), kept.stdout);
      } else rmSync(join(lib, path), { force: true });
      if (aside.status === 0) {
        const alt = path.replace(/(\.md)?$/, `${suffix}$1`);
        mkdirSync(dirname(join(lib, alt)), { recursive: true });
        writeFileSync(join(lib, alt), aside.stdout);
      }
      conflicts.push(path);
    }
    git(lib, ["add", "-A"]);
    const saved = git(lib, ["-c", "user.name=omem", "-c", "user.email=omem@localhost", "commit", "-q", "--no-edit", "-m", `pull: merge remote library (kept ${preferRemote ? "remote" : "local"} on conflicts)`]);
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
