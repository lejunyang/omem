/** The same standalone program runs locally for HTTP snapshots and on the SSH host.
 * Only data and Git objects travel: repository hooks, credentials and ignored files stay put. */
export const snapshotScript = String.raw`
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const { spawnSync } = process.getBuiltinModule('node:child_process');
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
const [home, dest] = process.argv.slice(1);
const db = new DatabaseSync(path.join(home, 'omem.db'), { readOnly: true });
db.prepare('vacuum into ?').run(path.join(dest, 'omem.db'));
db.close();
const snap = new DatabaseSync(path.join(dest, 'omem.db'));
for (const table of ['api_tokens', 'kv', 'lark_cursors', 'pull_aliases'])
  if (snap.prepare("select 1 from sqlite_master where type='table' and name=?").get(table)) snap.exec('delete from ' + table);
const manifest = { version: 1, home, repositories: [] };
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
    fs.cpSync(from, to, { verbatimSymlinks: true });
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
for (const s of snap.prepare("select id, root_path from spaces where kind = 'repo' and root_path is not null").all()) save(s.root_path, null, s.id);
// Delegation worktrees must be portable repos, not .git files pointing at the other host.
const runs = path.join(home, 'runs');
if (fs.existsSync(runs)) for (const run of fs.readdirSync(runs)) {
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
