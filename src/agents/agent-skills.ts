import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { commitLibrary } from "../core/git.ts";
import { HttpError } from "../core/util.ts";
import { acpCatalog } from "./catalog.ts";
import { GROUP_ID, groupTitle, loadSkillGroups, saveSkillGroups, skillEnabled, type SkillGroups } from "./skill-groups.ts";
import { readSkill } from "./specs.ts";
import { omemSkillDir } from "./tool-help.ts";

/**
 * Taking over the agents' own skill folders (docs/v2/agent-skills.md).
 *
 * Tools install their skills straight into ~/.claude/skills, ~/.agents/skills, ~/.trae/skills…, a
 * few hundred at a time, and every agent then carries every description: the CLI shortens or drops
 * them and the model no longer sees what any one is for. With `agentSkills.takeOver` on, omem moves
 * them into its library (originals kept in a backup, restorable), puts each in a group (by a name
 * prefix several share, else `other`; the owner or the assistant regroups them) and writes back
 * only the omem guide and one hub per group that is on: a skill whose description names the group,
 * whose body lists the group's skills by purpose with the path of each one's full text. Skills
 * installed again later (an upgrade of the tool) are taken over at the next sweep, a newer version
 * replacing the library copy while its group, purpose and switch stay.
 *
 * What omem writes carries a marker file and is never taken over; folders starting with "."
 * (the agents' own built-in skills, `.system`) are left alone.
 */

const MARKER = ".omem-managed";
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEEP_BACKUPS = 5;

export type SkillDir = { path: string; agents: string[]; write: boolean; exists: boolean };

/** `~` and `${VAR:-default}` / `${VAR}`. */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env) {
  let s = p.replace(/\$\{(\w+):-([^}]*)\}/g, (_, v: string, d: string) => env[v] || d).replace(/\$\{(\w+)\}/g, (_, v: string) => env[v] ?? "");
  if (s === "~" || s.startsWith("~/")) s = join(env.HOME || homedir(), s.slice(1));
  return resolve(s);
}

/** The folders agents load skills from; `write` marks the one per agent omem writes its entries to. */
export function agentSkillDirs(app: App, env: NodeJS.ProcessEnv = process.env): SkillDir[] {
  const map = new Map<string, SkillDir>();
  const add = (path: string, agent: string, write: boolean) => {
    const d = map.get(path) ?? { path, agents: [], write: false, exists: existsSync(path) };
    if (agent && !d.agents.includes(agent)) d.agents.push(agent);
    d.write ||= write;
    map.set(path, d);
  };
  for (const e of acpCatalog) {
    if (!e.skills) continue;
    const reads = e.skills.read.map((r) => expandPath(r, env));
    for (const r of reads) add(r, e.name, false);
    // Written only for an agent that is there: one of its folders or the folder's parent exists.
    const w = expandPath(e.skills.write, env);
    if (existsSync(w) || existsSync(dirname(w)) || reads.some((r) => existsSync(r) || existsSync(dirname(r)))) add(w, e.name, true);
  }
  for (const x of app.config.agentSkills.extraDirs) add(expandPath(x, env), "", false);
  return [...map.values()];
}

type Found = { name: string; entry: string; real: string; link: boolean; dir: string; mtime: number };

const ours = (p: string) => existsSync(join(p, MARKER));

/** Skill folders (or links to them) in the agent folders, other than omem's own entries. */
function scan(dirs: SkillDir[]) {
  const found: Found[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const d of dirs) {
    if (!d.exists) continue;
    let entries: string[];
    try {
      entries = readdirSync(d.path);
    } catch (e) {
      skipped.push({ path: d.path, reason: (e as Error).message });
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith(".")) continue;
      const entry = join(d.path, name);
      let link = false;
      let real: string;
      try {
        link = lstatSync(entry).isSymbolicLink();
        real = realpathSync(entry);
        if (!statSync(real).isDirectory()) continue;
      } catch {
        skipped.push({ path: entry, reason: "链接指向的目录不存在" });
        continue;
      }
      if (ours(real) || !existsSync(join(real, "SKILL.md"))) continue;
      if (!NAME.test(name)) {
        skipped.push({ path: entry, reason: "名称不是小写字母、数字和连字符" });
        continue;
      }
      found.push({ name, entry, real, link, dir: d.path, mtime: statSync(join(real, "SKILL.md")).mtimeMs });
    }
  }
  return { found, skipped };
}

function dirHash(dir: string) {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === ".DS_Store") continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      const st = statSync(join(dir, p));
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(p).update("\0").update(readFileSync(join(dir, p))).update("\0");
    }
  };
  walk("");
  return h.digest("hex").slice(0, 16);
}

/**
 * The group a newly taken-over skill goes into: the group most skills with its name prefix are
 * already in, else the prefix when at least three skills share it, else `other`. A group never
 * takes a skill's name (its hub is a folder of that name in the agents' folders).
 */
function inferGroup(name: string, state: SkillGroups, names: Set<string>) {
  const prefix = name.split("-")[0];
  const peers = Object.entries(state.skills).filter(([n, s]) => s.group && n !== name && n.split("-")[0] === prefix);
  if (peers.length) {
    const count = new Map<string, number>();
    for (const [, s] of peers) count.set(s.group!, (count.get(s.group!) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1])[0][0];
  }
  if ([...names].filter((n) => n.split("-")[0] === prefix).length >= 3 && name.includes("-")) return names.has(prefix) ? `${prefix}-skills` : prefix;
  return "other";
}

function moveDir(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const backupRoot = (app: App) => join(app.home, "agent-skills", "backup");
const hubRoot = (app: App) => join(app.home, "agent-skills", "hubs");
const libSkills = (app: App) => join(app.libraryDir, "_skills");

export type SweepResult = {
  at: string;
  dryRun: boolean;
  dirs: SkillDir[];
  adopted: string[];
  updated: string[];
  unchanged: string[];
  /** A skill of the library's own (not taken over) has the name: the library's is kept. */
  conflicts: string[];
  removed: number;
  skipped: { path: string; reason: string }[];
  backup?: string;
  entries?: { dir: string; written: string[]; removed: string[] }[];
};

/**
 * One sweep: what is in the agent folders moves into the library and the folders get omem's
 * entries back. `dryRun` reports what would happen and touches nothing.
 */
export function sweepAgentSkills(app: App, opts: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}): SweepResult {
  const dirs = agentSkillDirs(app, opts.env);
  const { found, skipped } = scan(dirs);
  const at = new Date().toISOString();
  const result: SweepResult = { at, dryRun: !!opts.dryRun, dirs, adopted: [], updated: [], unchanged: [], conflicts: [], removed: found.length, skipped };
  const state = loadSkillGroups(app);
  const byName = new Map<string, Found[]>();
  for (const f of found) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const names = new Set([...Object.keys(state.skills), ...byName.keys()]);
  for (const [name, list] of byName) {
    // The same skill in several folders: the most recently written one.
    const pick = [...list].sort((a, b) => b.mtime - a.mtime)[0];
    const hash = dirHash(pick.real);
    const lib = join(libSkills(app), name);
    const st = state.skills[name];
    if (existsSync(join(lib, "SKILL.md")) && !st?.origin) {
      result.conflicts.push(name);
      continue;
    }
    if (st?.origin && st.hash === hash && existsSync(join(lib, "SKILL.md"))) {
      result.unchanged.push(name);
      continue;
    }
    (st?.origin ? result.updated : result.adopted).push(name);
    if (!opts.dryRun) {
      rmSync(lib, { recursive: true, force: true });
      cpSync(pick.real, lib, { recursive: true, dereference: true, filter: (src) => !/(^|[\\/])(\.git|\.DS_Store)$/.test(src) });
    }
    state.skills[name] = { ...st, group: st?.group ?? inferGroup(name, state, names), enabled: st?.enabled ?? true, origin: pick.entry, adoptedAt: st?.adoptedAt ?? at, hash };
  }
  if (opts.dryRun) {
    // The groups as they would be (the state is not saved): each with how many skills it would hold.
    const count = new Map<string, number>();
    for (const [n, st] of Object.entries(state.skills)) if (st.group && skillEnabled(state, n)) count.set(st.group, (count.get(st.group) ?? 0) + 1);
    const planned = ["omem", ...[...count].sort(([a], [b]) => a.localeCompare(b)).map(([g, c]) => `${g}（${c}）`)];
    result.entries = dirs.filter((d) => d.write).map((d) => ({ dir: d.path, written: planned, removed: [] }));
    return result;
  }
  for (const g of new Set(Object.values(state.skills).map((s) => s.group).filter(Boolean) as string[])) state.groups[g] ??= { enabled: true };
  if (result.adopted.length || result.updated.length) {
    saveSkillGroups(app, state);
    commitLibrary(app.libraryDir, `omem: take over agent skills (${[...result.adopted.map((n) => `+${n}`), ...result.updated.map((n) => `~${n}`)].slice(0, 20).join(", ")}${result.adopted.length + result.updated.length > 20 ? ", …" : ""})`);
  }
  // Originals: links go, folders move into a backup with a manifest to put them back.
  if (found.length) {
    const stamp = at.replace(/[:.]/g, "-");
    const root = join(backupRoot(app), stamp);
    const manifest: { entry: string; backup?: string; link?: string }[] = [];
    for (const f of found.filter((x) => x.link)) {
      manifest.push({ entry: f.entry, link: readlinkSync(f.entry) });
      unlinkSync(f.entry);
    }
    for (const f of found.filter((x) => !x.link)) {
      const base = join(root, relative(resolve(f.dir, "..", ".."), f.dir).replace(/[\\/]/g, "_") || "skills", f.name);
      const to = existsSync(base) ? `${base}-${manifest.length}` : base;
      moveDir(f.entry, to);
      manifest.push({ entry: f.entry, backup: to });
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ at, items: manifest }, null, 2));
    result.backup = root;
    pruneBackups(app);
  }
  result.entries = writeAgentEntries(app, dirs);
  return result;
}

function pruneBackups(app: App) {
  const root = backupRoot(app);
  if (!existsSync(root)) return;
  const all = readdirSync(root).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(root, old), { recursive: true, force: true });
}

// ---- hubs ----------------------------------------------------------------------

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The skills of a group that are on and exist, by purpose (in order of first appearance, unsorted last). */
function members(app: App, state: SkillGroups, id: string) {
  const out: { name: string; description: string; purpose: string }[] = [];
  for (const [name, s] of Object.entries(state.skills).sort(([a], [b]) => a.localeCompare(b))) {
    if (s.group !== id || !skillEnabled(state, name)) continue;
    try {
      const sk = readSkill(app, name);
      if (sk.status !== "active") continue;
      out.push({ name, description: sk.description, purpose: s.purpose?.trim() || "" });
    } catch {}
  }
  return out;
}

function byPurpose(list: { name: string; description: string; purpose: string }[]) {
  const map = new Map<string, typeof list>();
  for (const m of list) map.set(m.purpose, [...(map.get(m.purpose) ?? []), m]);
  return [...map].sort(([a], [b]) => (a ? (b ? a.localeCompare(b, "zh") : -1) : 1));
}

export function groupDescription(app: App, state: SkillGroups, id: string, list = members(app, state, id)) {
  const set = state.groups[id]?.description?.trim();
  if (set) return set;
  const purposes = byPurpose(list).map(([p]) => p).filter(Boolean);
  const title = groupTitle(state, id);
  return clip(
    `${title}：${list.length} 个技能的总入口${purposes.length ? `，按用途分为${purposes.join("、")}` : `，包括 ${list.slice(0, 16).map((m) => m.name).join("、")}${list.length > 16 ? " 等" : ""}`}。做这类事之前先读这里，按用途找到具体的技能，再读它的全文照做。`,
    1000,
  );
}

/**
 * A group's hub: SKILL.md (description naming the group, the skills by purpose) and, for a large
 * group, one file per purpose with each skill's description, so the hub itself stays short.
 * `null` when the group is off or has no skill on.
 */
export function groupHub(app: App, id: string, state = loadSkillGroups(app)): { files: Record<string, string>; count: number } | null {
  if (state.groups[id]?.enabled === false) return null;
  const list = members(app, state, id);
  if (!list.length) return null;
  const title = groupTitle(state, id);
  const groups = byPurpose(list);
  const where = join(libSkills(app), "<技能名>", "SKILL.md");
  const head = `---\nname: ${id}\ndescription: ${JSON.stringify(groupDescription(app, state, id, list))}\n---\n\n# ${title}\n\n这一组技能由 omem 管理：启用、停用和分组在 omem 的 Agent 页 → 技能里改（这个文件会被重新生成，不要手改）。先按用途找到要用的技能，再读它的全文照做。\n\n- 全文：\`${where}\`（也可以 \`omem tool read_skill name=<技能名>\`）；技能里的相对路径（references/…、scripts/…）相对于它自己的目录\n`;
  const files: Record<string, string> = {};
  const split = list.length > 40 && groups.length > 1;
  const line = (m: { name: string; description: string }, n: number) => `- ${m.name}：${clip(m.description, n)}`;
  let body = "";
  groups.forEach(([purpose, ms], i) => {
    const heading = purpose || "未分用途";
    if (split) {
      const f = `purposes/${String(i + 1).padStart(2, "0")}.md`;
      files[f] = `# ${title} · ${heading}\n\n${ms.map((m) => line(m, 220)).join("\n")}\n`;
      body += `\n## ${heading}（${ms.length}，各自的说明在 ${f}）\n\n${ms.map((m) => m.name).join("、")}\n`;
    } else body += `\n## ${heading}\n\n${ms.map((m) => line(m, list.length > 40 ? 110 : 200)).join("\n")}\n`;
  });
  files["SKILL.md"] = head + body;
  return { files, count: list.length };
}

/** The ids of the groups that get a hub. */
function hubGroups(app: App, state: SkillGroups) {
  const ids = new Set(Object.values(state.skills).map((s) => s.group).filter(Boolean) as string[]);
  return [...ids].filter((id) => GROUP_ID.test(id) && state.groups[id]?.enabled !== false && members(app, state, id).length).sort();
}

function writeTree(dir: string, files: Record<string, string>) {
  const want = JSON.stringify(files);
  const sum = createHash("sha256").update(want).digest("hex").slice(0, 16);
  if (existsSync(join(dir, MARKER)) && readFileSync(join(dir, MARKER), "utf8").trim() === sum) return false;
  rmSync(dir, { recursive: true, force: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  writeFileSync(join(dir, MARKER), sum + "\n");
  return true;
}

function readTree(dir: string) {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[p] = readFileSync(join(dir, p), "utf8");
    }
  };
  walk("");
  return files;
}

/**
 * The omem guide and the hubs in each folder omem writes to; entries of groups that are off or
 * gone are removed. A folder of the same name that is not omem's is left alone (the next sweep
 * takes it over first).
 */
export function writeAgentEntries(app: App, dirs = agentSkillDirs(app)) {
  const state = loadSkillGroups(app);
  const wanted = new Map<string, Record<string, string>>();
  const guide = omemSkillDir();
  if (guide) wanted.set("omem", readTree(guide));
  for (const id of hubGroups(app, state)) {
    if (id === "omem") continue;
    const hub = groupHub(app, id, state);
    if (hub) wanted.set(id, hub.files);
  }
  // Kept beside the data for omem's own runs (read_skill of a group) and to see what was written.
  rmSync(hubRoot(app), { recursive: true, force: true });
  for (const [id, files] of wanted) if (id !== "omem") writeTree(join(hubRoot(app), id), files);
  const out: { dir: string; written: string[]; removed: string[] }[] = [];
  for (const d of dirs.filter((x) => x.write)) {
    mkdirSync(d.path, { recursive: true });
    const r = { dir: d.path, written: [] as string[], removed: [] as string[] };
    for (const [id, files] of wanted) {
      const target = join(d.path, id);
      if (existsSync(target) && !ours(target) && !lstatSync(target).isSymbolicLink()) continue;
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) unlinkSync(target);
      if (writeTree(target, files)) r.written.push(id);
    }
    for (const name of readdirSync(d.path)) {
      const p = join(d.path, name);
      if (!wanted.has(name) && !name.startsWith(".") && !lstatSync(p).isSymbolicLink() && ours(p)) {
        rmSync(p, { recursive: true, force: true });
        r.removed.push(name);
      }
    }
    out.push(r);
  }
  return out;
}

/** After the owner or the assistant changes groups: the folders follow while the takeover is on. */
export function refreshAgentEntries(app: App) {
  if (!app.config.agentSkills.takeOver) return;
  try {
    writeAgentEntries(app);
  } catch (e) {
    console.warn(`[omem] 更新 Agent 技能目录里的总入口失败：${(e as Error).message}`);
  }
}

// ---- changing groups -------------------------------------------------------------

export type SkillChange = { name: string; group?: string | null; purpose?: string | null; enabled?: boolean };
export type GroupChange = { id: string; title?: string; description?: string; enabled?: boolean };

/** Regroup skills, set their purposes and switches, describe groups; one commit. */
export function organizeSkills(app: App, input: { skills?: SkillChange[]; groups?: GroupChange[] }, actor: "user" | "agent" = "user") {
  const state = loadSkillGroups(app);
  const changed: string[] = [];
  for (const c of input.skills ?? []) {
    readSkill(app, c.name); // 404 for a skill that does not exist
    const s = { ...state.skills[c.name] };
    if (c.group !== undefined) {
      if (c.group === null || c.group === "") delete s.group;
      else {
        if (!GROUP_ID.test(c.group)) throw new HttpError(400, `分组名不合法：${c.group}（小写字母、数字、连字符）`);
        if (c.group === "omem" || existsSync(join(libSkills(app), c.group, "SKILL.md"))) throw new HttpError(400, `分组不能和技能同名：${c.group}`);
        s.group = c.group;
        state.groups[c.group] ??= { enabled: true };
      }
    }
    if (c.purpose !== undefined) {
      if (c.purpose === null || !c.purpose.trim()) delete s.purpose;
      else s.purpose = clip(c.purpose, 40);
    }
    if (c.enabled !== undefined) s.enabled = c.enabled;
    state.skills[c.name] = s;
    changed.push(c.name);
  }
  for (const g of input.groups ?? []) {
    const cur = state.groups[g.id];
    if (!cur && !Object.values(state.skills).some((s) => s.group === g.id)) throw new HttpError(404, `没有分组 ${g.id}`);
    const next = { ...(cur ?? { enabled: true }) };
    if (g.title !== undefined) next.title = clip(g.title, 40) || undefined;
    if (g.description !== undefined) next.description = clip(g.description, 1000) || undefined;
    if (g.enabled !== undefined) next.enabled = g.enabled;
    state.groups[g.id] = next;
    changed.push(`group:${g.id}`);
  }
  saveSkillGroups(app, state);
  commitLibrary(app.libraryDir, `${actor}: organize skills (${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ", …" : ""})`);
  refreshAgentEntries(app);
  return { changed: changed.length };
}

export function listSkillGroups(app: App) {
  const state = loadSkillGroups(app);
  const ids = [...new Set(Object.values(state.skills).map((s) => s.group).filter(Boolean) as string[])].sort();
  return ids.map((id) => {
    const all = Object.entries(state.skills).filter(([, s]) => s.group === id);
    const on = members(app, state, id);
    return {
      id,
      title: groupTitle(state, id),
      description: state.groups[id]?.description ?? "",
      autoDescription: groupDescription(app, { ...state, groups: { ...state.groups, [id]: { ...state.groups[id], description: "" } } } as SkillGroups, id, on),
      enabled: state.groups[id]?.enabled !== false,
      count: all.length,
      enabledCount: on.length,
      purposes: byPurpose(on).map(([p, ms]) => ({ purpose: p, count: ms.length })),
    };
  });
}

export function readSkillGroup(app: App, id: string) {
  const state = loadSkillGroups(app);
  const group = listSkillGroups(app).find((g) => g.id === id);
  if (!group) throw new HttpError(404, `没有分组 ${id}`);
  const skills = Object.entries(state.skills)
    .filter(([, s]) => s.group === id)
    .map(([name, s]) => {
      let description = "";
      try { description = readSkill(app, name).description; } catch {}
      return { name, description, purpose: s.purpose ?? "", enabled: s.enabled !== false, origin: s.origin ?? "", adoptedAt: s.adoptedAt ?? "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...group, skills };
}

// ---- status and undo -------------------------------------------------------------

const LAST = "agent_skills_last_sweep";

export function lastSweep(app: App): SweepResult | null {
  const row = one<{ value: string }>(app.db, "select value from kv where key = ?", LAST);
  try { return row ? (JSON.parse(row.value) as SweepResult) : null; } catch { return null; }
}

function rememberSweep(app: App, r: SweepResult) {
  run(app.db, "insert or replace into kv(key, value) values(?, ?)", LAST, JSON.stringify(r));
}

export function takeOverStatus(app: App) {
  const dirs = agentSkillDirs(app).map((d) => {
    let skills = 0;
    try { skills = d.exists ? readdirSync(d.path).filter((n) => !n.startsWith(".") && existsSync(join(d.path, n, "SKILL.md")) && !ours(join(d.path, n))).length : 0; } catch {}
    return { ...d, skills };
  });
  const backups = existsSync(backupRoot(app)) ? readdirSync(backupRoot(app)).sort().reverse() : [];
  return { takeOver: app.config.agentSkills.takeOver, everyMinutes: app.config.agentSkills.everyMinutes, extraDirs: app.config.agentSkills.extraDirs, dirs, last: lastSweep(app), backups };
}

let running = false;
/** The scheduled sweep (main.ts): nothing while the takeover is off; tells the owner what arrived. */
export async function tickAgentSkills(app: App) {
  if (!app.config.agentSkills.takeOver || running) return null;
  running = true;
  try {
    const r = sweepAgentSkills(app);
    if (r.removed || r.entries?.some((e) => e.written.length || e.removed.length)) rememberSweep(app, r);
    if (r.adopted.length) {
      const { notify } = await import("../core/notify.ts");
      notify(app, { title: `收进了 ${r.adopted.length} 个 Agent 自带的技能`, body: `${r.adopted.slice(0, 30).join("、")}${r.adopted.length > 30 ? " 等" : ""}。已按名称归组，可在 Agent 页 → 技能里调整分组、用途和启用。`, link: "#/agents?tab=skills", urgency: "later" });
    }
    return r;
  } finally {
    running = false;
  }
}

/** A sweep the owner asked for (web page, `omem skills take-over`), whether or not the takeover is on. */
export function sweepNow(app: App, opts: { dryRun?: boolean } = {}) {
  if (running) throw new HttpError(409, "正在收取，稍后再试");
  running = true;
  try {
    const r = sweepAgentSkills(app, opts);
    if (!opts.dryRun) rememberSweep(app, r);
    return r;
  } finally {
    running = false;
  }
}

/**
 * Undo a sweep: the originals go back where they were (folders that exist again are left as they
 * are), omem's entries leave the agent folders. The takeover is turned off, or the next sweep
 * would take them again. The skills stay in the library.
 */
export function restoreAgentSkills(app: App, stamp?: string) {
  const root = backupRoot(app);
  const all = existsSync(root) ? readdirSync(root).sort() : [];
  const pick = stamp ?? all.at(-1);
  if (!pick || !all.includes(pick)) throw new HttpError(404, stamp ? `没有备份 ${stamp}` : "没有可还原的备份");
  const manifest = JSON.parse(readFileSync(join(root, pick, "manifest.json"), "utf8")) as { items: { entry: string; backup?: string; link?: string }[] };
  const restored: string[] = [];
  const kept: string[] = [];
  for (const dir of agentSkillDirs(app).filter((d) => d.write && d.exists))
    for (const name of readdirSync(dir.path)) if (ours(join(dir.path, name))) rmSync(join(dir.path, name), { recursive: true, force: true });
  for (const it of manifest.items.filter((x) => x.backup)) {
    if (existsSync(it.entry) || !existsSync(it.backup!)) { kept.push(it.entry); continue; }
    moveDir(it.backup!, it.entry);
    restored.push(it.entry);
  }
  for (const it of manifest.items.filter((x) => x.link)) {
    if (existsSync(it.entry)) { kept.push(it.entry); continue; }
    try { lstatSync(it.entry); kept.push(it.entry); continue; } catch {}
    mkdirSync(dirname(it.entry), { recursive: true });
    symlinkSync(it.link!, it.entry);
    restored.push(it.entry);
  }
  rmSync(join(root, pick), { recursive: true, force: true });
  return { backup: pick, restored, kept };
}
