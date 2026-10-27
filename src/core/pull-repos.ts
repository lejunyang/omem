import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { git } from "./git.ts";

type Repository = { key: string; root: string; target: string | null; space: string | null; parent?: string | null; subpath?: string | null; origin?: string | null; branch: string | null; head: string | null; revision: string };
export type PullManifest = { version: number; home: string; repositories: Repository[] };

export function readManifest(dir: string): PullManifest | null {
  const file = join(dir, "pull-manifest.json");
  if (!existsSync(file)) return null; // Older peers send only the database and library.
  const m = JSON.parse(readFileSync(file, "utf8")) as PullManifest;
  if (m.version !== 1 || !Array.isArray(m.repositories)) throw new Error("不支持的拉取快照版本");
  return m;
}

function inside(root: string, name: string) {
  const target = resolve(root, name);
  if (isAbsolute(name) || target === resolve(root) || !target.startsWith(resolve(root) + sep)) throw new Error("快照路径超出数据目录");
  let cursor = resolve(root);
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("快照目录不能经过符号链接");
  }
  return target;
}

function check(dir: string, args: string[]) {
  const r = git(dir, args);
  if (!r.ok) throw new Error(`同步仓库失败：${r.stderr.trim().slice(-400)}`);
  return r.stdout.trim();
}

/** Restore Git objects, index and non-ignored files without the source machine's .git config. */
function restore(asset: string, target: string, repo: Repository) {
  const complete = join(target, ".git/omem-pull-revision");
  if (existsSync(complete) && readFileSync(complete, "utf8") === repo.revision) return;
  if (existsSync(join(target, ".git"))) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  check(target, ["init", "-q"]);
  const bundle = join(asset, "repo.bundle");
  if (existsSync(bundle)) check(target, ["fetch", "-q", bundle, "+refs/*:refs/*"]);
  if (repo.origin && /^(https?:\/\/|ssh:\/\/|git:\/\/|[^@\s]+@[^:\s]+:)/.test(repo.origin)) check(target, ["remote", "add", "origin", repo.origin]);
  if (repo.branch) check(target, ["symbolic-ref", "HEAD", `refs/heads/${repo.branch}`]);
  if (repo.head) {
    if (!repo.branch) check(target, ["update-ref", "--no-deref", "HEAD", repo.head]);
    else check(target, ["update-ref", "HEAD", repo.head]);
    check(target, ["read-tree", repo.head]);
  }
  const patch = join(asset, "staged.patch");
  if (existsSync(patch) && readFileSync(patch).length) check(target, ["apply", "--cached", patch]);
  for (const name of readdirSync(join(asset, "tree"))) cpSync(join(asset, "tree", name), join(target, name), { recursive: true, verbatimSymlinks: true });
  writeFileSync(complete, repo.revision);
}

/** Existing checkouts keep their working files. Remote tips and dirty trees remain accessible. */
export function installRepositories(home: string, db: DatabaseSync, fetchedDir: string, log: (s: string) => void) {
  const manifest = readManifest(fetchedDir);
  const paths = new Map<string, string>();
  const targets = new Map<string, string>();
  if (!manifest) return paths;
  for (const repo of manifest.repositories) {
    if (!/^\d+$/.test(repo.key) || !/^[a-f0-9]{20}$/.test(repo.revision)) throw new Error("仓库快照标识不合法");
    const asset = inside(join(fetchedDir, "repositories"), repo.key);
    const saved = repo.space ? db.prepare("select root_path from spaces where id = ?").get(repo.space) as { root_path: string | null } | undefined : undefined;
    const local = saved?.root_path;
    let target: string;
    if (repo.parent != null) {
      const parent = targets.get(repo.parent);
      if (!parent || !repo.subpath || repo.subpath.split(/[\\/]/).some((p) => p.toLowerCase() === ".git")) throw new Error("子模块快照缺少父仓库或路径不合法");
      target = inside(parent, repo.subpath.replaceAll("\\", "/"));
    } else if (repo.target) {
      if (!repo.target.replaceAll("\\", "/").startsWith("runs/")) throw new Error("工作区快照路径不合法");
      target = inside(home, repo.target.replaceAll("\\", "/"));
      // A matching run may have local work in progress: keep its worktree and save the copy elsewhere.
      if (existsSync(target)) target = inside(home, `repos/pulled/work-${repo.key}-${repo.revision}`);
    } else target = inside(home, `repos/pulled/${encodeURIComponent(repo.space ?? repo.key)}-${repo.revision}`);
    restore(asset, target, repo);
    targets.set(repo.key, target);
    paths.set(repo.root, target);
    if (!repo.space) continue;
    if (local && existsSync(join(local, ".git"))) {
      const bundle = join(asset, "repo.bundle");
      if (existsSync(bundle)) {
        const key = encodeURIComponent(repo.space).replaceAll("%", "_");
        check(local, ["fetch", "-q", bundle, `+refs/*:refs/omem/pulled/${key}/*`]);
        check(local, ["fetch", "-q", bundle, `+refs/heads/*:refs/remotes/omem-pull/${key}/*`]);
      }
      // Fast-forward only a clean checkout on the same branch, with a clean remote tree.
      const branch = git(local, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
      const clean = !check(local, ["status", "--porcelain"]);
      const remoteClean = !check(target, ["status", "--porcelain"]);
      const busy = db.prepare("select 1 from runs where kind = 'code' and status in ('queued','running') and (space_id = ? or exists(select 1 from json_each(runs.input, '$.repos') where value = ?)) limit 1").get(repo.space, repo.space);
      if (!busy && repo.head && repo.branch === branch && clean && remoteClean && git(local, ["merge-base", "--is-ancestor", "HEAD", repo.head]).ok)
        check(local, ["merge", "--ff-only", "--no-edit", repo.head]);
      log(`仓库 ${repo.space}：保留本地工作区，远端工作区副本在 ${relative(home, target)}`);
      // Run records must refer to the saved remote checkout, not a different local revision.
    } else {
      db.prepare("update spaces set root_path = ?, settings = json_set(settings, '$.remoteRootPath', ?) where id = ?").run(target, repo.root, repo.space);
      log(`仓库 ${repo.space}：已保存到 ${relative(home, target)}`);
    }
  }
  // Relocate only paths from imported records; callers apply this map to the private snapshot.
  paths.set(manifest.home + (manifest.home.includes("\\") ? "\\runs" : "/runs"), join(home, "runs"));
  return paths;
}

export function relocate(text: string, paths: Map<string, string>) {
  const variants = new Map<string, string>();
  for (const [from, to] of paths) {
    variants.set(from, to);
    variants.set(from.replaceAll("\\", "\\\\"), to.replaceAll("\\", "\\\\"));
  }
  for (const to of paths.values()) {
    if (!variants.has(to)) variants.set(to, to);
    const encoded = to.replaceAll("\\", "\\\\");
    if (!variants.has(encoded)) variants.set(encoded, encoded);
  }
  if (!variants.size) return text;
  const pattern = [...variants.keys()].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(new RegExp(`(?:${pattern})(?=$|[\\\\/"'\\s?#)])`, "g"), (m) => variants.get(m)!);
}
