/** The same standalone program runs locally for HTTP snapshots and on the SSH host.
 * Only data and Git objects travel: repository hooks, credentials and ignored files stay put. */
export const snapshotScript = String.raw`
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const [home, dest, optJson] = process.argv.slice(1);
// What the puller asked for (pull-transfer.ts PullSelection); an older puller passes nothing: everything.
const opt = optJson ? JSON.parse(optJson) : {};
const parts = Array.isArray(opt.parts) ? opt.parts : ['library', 'files', 'repos', 'runs'];
// What this device keeps to itself, and what a merge rebuilds from the sources it takes (search
// chunks, code outline): neither travels in a stripped snapshot.
const DEVICE = ['api_tokens', 'cli_logins', 'kv', 'lark_cursors', 'pull_aliases', 'lark_meetings', 'lark_meeting_lines', 'shares', 'session_cleanup', 'remote_recordings', 'lark_doc_subscriptions', 'platform_watches'];
const DERIVED = ['chunks', 'symbols', 'code_refs'];
const VECTOR_TRIGGERS = ['vector_log_insert', 'vector_log_update', 'vector_log_delete'];
// The other side's clock when the snapshot was taken: what the next pull asks changes since.
const takenAt = new Date().toISOString();
// Only rows changed after this moment, for the tables that say when a row changed and are most of the
// data (the puller has the rest from its last complete pull). Everything else is always whole.
const since = opt.strip && typeof opt.since === 'string' && !Number.isNaN(Date.parse(opt.since)) ? new Date(opt.since).toISOString() : null;
const CHANGED = { sources: 'updated_at', run_events: 'at' };
let snap;
if (opt.strip) {
  // Table by table into a new file, inside one read of the live database: the derived tables are most
  // of it (vectors alone are gigabytes), and copying everything first only to delete them wrote all of
  // that to disk on every pull.
  snap = new DatabaseSync(path.join(dest, 'omem.db'));
  snap.exec('pragma foreign_keys = off; pragma journal_mode = off; pragma synchronous = off');
  snap.prepare('attach database ? as src').run(path.join(home, 'omem.db'));
  const master = snap.prepare("select type, name, sql from src.sqlite_master where sql is not null and name not like 'sqlite_%' order by rowid").all();
  const virtual = master.filter((r) => r.type === 'table' && /^\s*create\s+virtual\s+table/i.test(r.sql)).map((r) => r.name);
  const shadowOf = (name) => virtual.find((v) => name.startsWith(v + '_'));
  const q = (name) => '"' + name.replace(/"/g, '""') + '"';
  snap.exec('begin');
  for (const r of master) {
    if (r.type !== 'table' || shadowOf(r.name)) continue;
    snap.exec(r.sql);
    if (virtual.includes(r.name) || DEVICE.includes(r.name) || DERIVED.includes(r.name) || r.name === 'vector_log') continue;
    const col = since && CHANGED[r.name];
    if (col) snap.prepare('insert into main.' + q(r.name) + ' select * from src.' + q(r.name) + ' where ' + col + ' > ?').run(since);
    else snap.exec('insert into main.' + q(r.name) + ' select * from src.' + q(r.name));
  }
  // Full-text tables are created empty (their shadow tables cannot be written directly): a merge
  // indexes the memories, pages and requirements it takes itself.
  // The sources left out still say who they are: the puller maps the other side's ids to its own by
  // space and address, and what it takes (pages, items, messages) refers to sources by those ids.
  if (since) {
    snap.exec('create table pull_source_keys(id text primary key, space_id text not null, uri text not null)');
    snap.prepare('insert into pull_source_keys select id, space_id, uri from src.sources where not (updated_at > ?)').run(since);
  }
  for (const r of master) if (r.type === 'index') snap.exec(r.sql);
  for (const r of master) if (r.type === 'view' || (r.type === 'trigger' && !VECTOR_TRIGGERS.includes(r.name))) snap.exec(r.sql);
  if (snap.prepare("select 1 from sqlite_master where name = 'sqlite_sequence'").get() && snap.prepare("select 1 from src.sqlite_master where name = 'sqlite_sequence'").get()) {
    snap.exec('delete from main.sqlite_sequence');
    snap.exec('insert into main.sqlite_sequence select * from src.sqlite_sequence');
  }
  snap.exec('pragma main.user_version = ' + Number(snap.prepare('pragma src.user_version').get().user_version));
  snap.exec('commit');
  snap.exec('detach database src');
} else {
  const db = new DatabaseSync(path.join(home, 'omem.db'), { readOnly: true });
  db.prepare('vacuum into ?').run(path.join(dest, 'omem.db'));
  db.close();
  snap = new DatabaseSync(path.join(dest, 'omem.db'));
  const has = (table) => !!snap.prepare("select 1 from sqlite_master where name=?").get(table);
  // The vector change log belongs to this device's search process: drop it and its triggers.
  for (const t of VECTOR_TRIGGERS) snap.exec('drop trigger if exists ' + t);
  if (has('vector_log')) snap.exec('delete from vector_log');
  for (const table of DEVICE) if (has(table)) snap.exec('delete from ' + table);
}
const manifest = { version: 1, home, parts, repositories: [], takenAt, since };
const seen = new Map();
function git(root, args, binary = false) {
  const r = spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: binary ? undefined : 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' }
  });
  return r;
}
function save(root, target, space, parent = null, subpath = null) {
  if (!root || !fs.existsSync(root)) return;
  const real = fs.realpathSync(root);
  if (seen.has(real)) {
    manifest.repositories.push({ ...seen.get(real), target, space, parent, subpath });
    return;
  }
  if (git(root, ['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') return;
  const key = String(seen.size);
  const dir = path.join(dest, 'repositories', key);
  fs.mkdirSync(path.join(dir, 'tree'), { recursive: true });
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout?.trim() || null;
  const refs = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout?.trim();
  if (refs || head.status === 0) {
    const bundle = git(root, ['bundle', 'create', path.join(dir, 'repo.bundle'), '--all', ...(head.status === 0 ? ['HEAD'] : [])]);
    if (bundle.status !== 0) throw new Error('无法保存仓库历史：' + bundle.stderr);
  }
  const staged = git(root, ['diff', '--cached', '--binary'], true);
  if (staged.status !== 0) throw new Error('无法读取暂存改动');
  fs.writeFileSync(path.join(dir, 'staged.patch'), staged.stdout);
  // Git disallows --others with --recurse-submodules; query the two sets separately.
  const tracked = git(root, ['ls-files', '-z', '--cached', '--recurse-submodules']);
  const untracked = git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('无法枚举仓库文件');
  const hash = process.getBuiltinModule('node:crypto').createHash('sha256').update(head.stdout || '').update(refs || '').update(branch || '').update(staged.stdout);
  for (const name of [...new Set((tracked.stdout + untracked.stdout).split('\0').filter(Boolean))].sort()) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(p => p === '..' || p === '.git')) throw new Error('仓库文件路径不合法');
    const from = path.join(root, name);
    if (!fs.existsSync(from) && !fs.lstatSync(from, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
    if (fs.lstatSync(from).isDirectory()) continue;
    const to = path.join(dir, 'tree', name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // A file or a symbolic link, the link as written. "recursive" only so that cpSync takes a link
    // to a directory: without it, it refuses one as a directory.
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    hash.update(name).update(String(fs.lstatSync(from).mode));
    hash.update(fs.lstatSync(from).isSymbolicLink() ? fs.readlinkSync(from) : fs.readFileSync(from));
  }
  let origin = git(root, ['remote', 'get-url', 'origin']).stdout?.trim() || null;
  if (origin && /^https?:\/\//.test(origin)) {
    const url = new URL(origin); url.username = ''; url.password = ''; origin = url.href;
  }
  if (origin && !/^(https?:\/\/|ssh:\/\/|git:\/\/|[^@\s]+@[^:\s]+:)/.test(origin)) origin = null;
  const entry = { key, root, target, space, parent, subpath, origin, branch, head: head.status === 0 ? head.stdout.trim() : null, revision: hash.digest('hex').slice(0, 20) };
  seen.set(real, entry);
  manifest.repositories.push(entry);
  if (fs.existsSync(path.join(root, '.gitmodules'))) {
    const modules = git(root, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\..*\.path$']).stdout || '';
    for (const line of modules.trim().split('\n').filter(Boolean)) {
      const name = line.slice(line.indexOf(' ') + 1);
      const sub = path.join(root, name);
      if (fs.existsSync(path.join(sub, '.git'))) save(sub, null, null, key, name);
    }
  }
}
if (parts.includes('repos')) for (const s of snap.prepare("select id, root_path from spaces where kind = 'repo' and root_path is not null").all()) save(s.root_path, null, s.id);
// Delegation worktrees must be portable repos, not .git files pointing at the other host.
const runs = path.join(home, 'runs');
if (parts.includes('runs') && fs.existsSync(runs)) for (const run of fs.readdirSync(runs)) {
  const runDir = path.join(runs, run);
  if (!fs.statSync(runDir).isDirectory()) continue;
  const work = path.join(runDir, 'work');
  if (fs.existsSync(work) && fs.statSync(work).isDirectory())
    for (const space of fs.readdirSync(work)) save(path.join(work, space), path.join('runs', run, 'work', space), null);
  for (const name of fs.readdirSync(runDir)) {
    if (name === 'work') continue;
    const from = path.join(runDir, name);
    if (fs.existsSync(path.join(from, '.git'))) { save(from, path.join('runs', run, name), null); continue; }
    const to = path.join(dest, 'runs', run, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
}
snap.close();
fs.writeFileSync(path.join(dest, 'pull-manifest.json'), JSON.stringify(manifest));
`;
