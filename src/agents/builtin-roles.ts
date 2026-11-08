import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { roleNames } from "../core/config.ts";
import { commitLibrary, fileHistory, git } from "../core/git.ts";
import { expandTools, TOOL_GROUPS, unknownGroups } from "./tool-help.ts";
import { HttpError } from "../core/util.ts";

/**
 * Built-in roles (roles/*.md in the package) as profiles the owner can tune.
 *
 * The package copy is the source version. Customizing copies it to
 * `library/_roles/<name>.md` (Git history like every profile) and keeps the
 * source text it was copied from in `library/_roles/.base/<name>.md`; runs
 * then use the library copy. When omem is updated and the source changes, the
 * customized copy says so and can be:
 * - reset: the library copy is removed, the source version is used again;
 * - merged: `git merge-file` combines the owner's edits with the new source
 *   (base = the copied source); conflicts go to an agent run that reads all three.
 */

export const roleMetaSchema = z.object({
  description: z.string().min(1),
  /** Tool names, `group:<id>` for a whole group, `-<name>` to leave one out (tool-help.ts expandTools). */
  tools: z.array(z.string()).default([]).superRefine((l, ctx) => {
    const bad = unknownGroups(l);
    if (bad.length) ctx.addIssue({ code: "custom", message: `没有这些工具分组：${bad.join("、")}；可用 ${TOOL_GROUPS.map((g) => `group:${g.id}`).join("、")}` });
  }),
  writes: z.boolean().default(false),
  modes: z.array(z.string()).default([]),
  /** Skills this role uses regularly (listed first in its skill index). */
  skills: z.array(z.string()).default([]),
});

/** roles/ sits at the package root both in source (src/agents) and build (dist/src/agents). */
export function rolesDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "../../roles"), resolve(here, "../../../roles")]) if (existsSync(join(candidate, "_common.md"))) return candidate;
  throw new Error("找不到 roles 目录");
}

const dir = (app: App) => join(app.libraryDir, "_roles");
const baseDir = (app: App) => join(dir(app), ".base");
const hash = (s: string) => createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);

export function isBuiltinRole(name: string) {
  return (roleNames as readonly string[]).includes(name);
}
function check(name: string) {
  if (!isBuiltinRole(name)) throw new HttpError(404, `没有内置角色 ${name}`);
  return name;
}

export function roleSourceText(name: string) {
  return readFileSync(join(rolesDir(), `${check(name)}.md`), "utf8").replace(/\r\n/g, "\n");
}
export function roleOverrideText(app: App, name: string): string | null {
  const f = join(dir(app), `${check(name)}.md`);
  return existsSync(f) ? readFileSync(f, "utf8").replace(/\r\n/g, "\n") : null;
}
function roleBaseText(app: App, name: string): string | null {
  const f = join(baseDir(app), `${name}.md`);
  return existsSync(f) ? readFileSync(f, "utf8").replace(/\r\n/g, "\n") : null;
}

/**
 * Skills and tools the owner added to or took from a built-in role, kept apart from its text
 * (_roles/<name>.overlay.yaml): they apply to whichever version is in use, so a source update reaches
 * the role without a merge. Only editing the role's text makes a full copy.
 */
export type RoleOverlay = { skills: { add: string[]; remove: string[] }; tools: { add: string[]; remove: string[] } };
const overlayFile = (app: App, name: string) => join(dir(app), `${name}.overlay.yaml`);
export function roleOverlay(app: App, name: string): RoleOverlay {
  const f = overlayFile(app, check(name));
  const o = (existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) : null) as Partial<RoleOverlay> | null;
  const list = (x?: { add?: unknown; remove?: unknown }) => ({ add: Array.isArray(x?.add) ? x.add.map(String) : [], remove: Array.isArray(x?.remove) ? x.remove.map(String) : [] });
  return { skills: list(o?.skills), tools: list(o?.tools) };
}
export const applyOverlay = (list: string[], d: { add: string[]; remove: string[] }) => [...new Set([...list.filter((x) => !d.remove.includes(x)), ...d.add])];
const diffList = (from: string[], to: string[]) => ({ add: to.filter((x) => !from.includes(x)), remove: from.filter((x) => !to.includes(x)) });
export const overlayEmpty = (o: RoleOverlay) => !o.skills.add.length && !o.skills.remove.length && !o.tools.add.length && !o.tools.remove.length;
function writeOverlay(app: App, name: string, o: RoleOverlay) {
  const f = overlayFile(app, name);
  if (overlayEmpty(o)) rmSync(f, { force: true });
  else {
    mkdirSync(dir(app), { recursive: true });
    writeFileSync(f, YAML.stringify(o));
  }
}

export type RoleState = {
  name: string;
  description: string;
  customized: boolean;
  /** Skills and tools added or taken out on top of the version in use (no copy needed). */
  overlay: RoleOverlay;
  /** The source changed since the copy was made: reset or merge to pick it up. */
  sourceChanged: boolean;
};

function describe(text: string) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return String(((m ? YAML.parse(m[1]) : {}) as { description?: string }).description ?? "");
}

export function roleState(app: App, name: string): RoleState {
  const source = roleSourceText(name);
  const own = roleOverrideText(app, name);
  const base = own === null ? null : roleBaseText(app, name);
  return { name, description: describe(own ?? source), customized: own !== null, overlay: roleOverlay(app, name), sourceChanged: own !== null && base !== null && hash(base) !== hash(source) };
}

export function listRoleStates(app: App) {
  const files = new Set(readdirSync(rolesDir()).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  return roleNames.filter((n) => files.has(n)).map((n) => roleState(app, n));
}

/** Parse and check a role file; the tools must exist and the body must not be empty. */
export function parseRoleText(text: string) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new HttpError(400, "角色文件需要 --- 包起来的 frontmatter（description、tools、writes、modes）");
  const meta = roleMetaSchema.parse(YAML.parse(m[1]) ?? {});
  const body = text.replace(/\r\n/g, "\n").slice(m[0].length);
  if (!body.trim()) throw new HttpError(400, "角色正文不能为空");
  return { meta, body };
}

/** Copy the source version into the library (no-op when already customized). */
export function customizeRole(app: App, name: string, actor: "user" | "agent" = "user") {
  const existing = roleOverrideText(app, name);
  if (existing !== null) return existing;
  const source = roleSourceText(name);
  mkdirSync(baseDir(app), { recursive: true });
  writeFileSync(join(dir(app), `${name}.md`), source);
  writeFileSync(join(baseDir(app), `${name}.md`), source);
  commitLibrary(app.libraryDir, `${actor}: customize built-in role ${name}`);
  return source;
}

export function saveRoleOverride(app: App, name: string, text: string, actor: "user" | "agent" = "user") {
  check(name);
  parseRoleText(text);
  if (roleOverrideText(app, name) === null) customizeRole(app, name, actor);
  writeFileSync(join(dir(app), `${name}.md`), text.endsWith("\n") ? text : `${text}\n`);
  commitLibrary(app.libraryDir, `${actor}: edit built-in role ${name}`);
  return roleState(app, name);
}

/**
 * Change a role's skills or tools (attaching a skill, an approved proposal): recorded in its overlay,
 * so the role keeps following the source. Anything else in the frontmatter changes the copy (made first).
 */
export function updateRoleMeta(app: App, name: string, patch: (meta: z.infer<typeof roleMetaSchema>) => z.infer<typeof roleMetaSchema>, actor: "user" | "agent" = "agent") {
  const current = parseRoleText(roleOverrideText(app, name) ?? roleSourceText(name)).meta;
  const o = roleOverlay(app, name);
  const wanted = patch({ ...current, skills: applyOverlay(current.skills, o.skills), tools: applyOverlay(current.tools, o.tools) });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(wanted.description, current.description) && same(wanted.writes, current.writes) && same(wanted.modes, current.modes)) {
    writeOverlay(app, name, { skills: diffList(current.skills, wanted.skills), tools: diffList(current.tools, wanted.tools) });
    commitLibrary(app.libraryDir, `${actor}: adjust skills and tools of built-in role ${name}`);
    return roleState(app, name);
  }
  const text = customizeRole(app, name, actor);
  const { meta, body } = parseRoleText(text);
  const next = patch(meta);
  const out: Record<string, unknown> = { ...next };
  if (!next.skills.length) delete out.skills;
  writeFileSync(join(dir(app), `${name}.md`), `---\n${frontmatter(out)}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`);
  commitLibrary(app.libraryDir, `${actor}: update built-in role ${name}`);
  return roleState(app, name);
}

/** Frontmatter in the style of the role files: lists inline (`tools: [a, b]`). */
function frontmatter(meta: Record<string, unknown>) {
  return Object.entries(meta)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.map((x) => (/^[\w.-]+$/.test(String(x)) ? String(x) : JSON.stringify(x))).join(", ")}]` : YAML.stringify({ [k]: v }).trim()))
    .join("\n");
}

/** Back to the source version: the customized copy is removed (its history stays in Git); added skills and tools stay. */
export function resetRole(app: App, name: string, actor: "user" | "agent" = "user") {
  check(name);
  rmSync(join(dir(app), `${name}.md`), { force: true });
  rmSync(join(baseDir(app), `${name}.md`), { force: true });
  commitLibrary(app.libraryDir, `${actor}: reset built-in role ${name} to the source version`);
  return roleState(app, name);
}

export type MergeResult = { state: RoleState; conflicts: number; text?: string };

/**
 * Three-way merge of the owner's copy with the new source. A clean merge is saved at once;
 * with conflicts nothing is written and the marked text is returned (an agent resolves it).
 */
export function mergeRole(app: App, name: string): MergeResult {
  const own = roleOverrideText(app, name);
  if (own === null) throw new HttpError(400, `${name} 没有自定义，直接使用源码版本`);
  const source = roleSourceText(name);
  const base = roleBaseText(app, name) ?? own;
  const tmp = mkdtempSync(join(tmpdir(), "omem-role-"));
  try {
    const [o, b, s] = ["own.md", "base.md", "source.md"].map((f) => join(tmp, f));
    writeFileSync(o, own);
    writeFileSync(b, base);
    writeFileSync(s, source);
    const r = git(tmp, ["merge-file", "-p", "-L", "自定义", "-L", "原版本", "-L", "新源码", o, b, s]);
    // merge-file exits with the number of conflicts (negative on error).
    const conflicts = (r.stdout.match(/^<{7} /gm) ?? []).length;
    if (!r.stdout.trim()) throw new HttpError(500, `合并失败：${r.stderr.trim()}`);
    if (conflicts) return { state: roleState(app, name), conflicts, text: r.stdout };
    parseRoleText(r.stdout);
    writeFileSync(join(dir(app), `${name}.md`), r.stdout);
    writeFileSync(join(baseDir(app), `${name}.md`), source);
    commitLibrary(app.libraryDir, `omem: merge source changes into built-in role ${name}`);
    return { state: roleState(app, name), conflicts: 0 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Save an agent's resolution of a conflicted merge: the new source becomes the base. */
export function resolveRoleMerge(app: App, name: string, text: string, actor: "user" | "agent" = "agent") {
  if (/^<{7} |^>{7} /m.test(text)) throw new HttpError(400, "合并结果里还有冲突标记");
  parseRoleText(text);
  writeFileSync(join(dir(app), `${check(name)}.md`), text.endsWith("\n") ? text : `${text}\n`);
  writeFileSync(join(baseDir(app), `${name}.md`), roleSourceText(name));
  commitLibrary(app.libraryDir, `${actor}: merge source changes into built-in role ${name}`);
  return roleState(app, name);
}

/**
 * A copy that differs from the version it was made from only in skills and tools (made by attaching a
 * skill before overlays existed) becomes an overlay, and the role follows the source again.
 */
export function simplifyRoleCopy(app: App, name: string) {
  const own = roleOverrideText(app, name);
  const base = own === null ? null : roleBaseText(app, name);
  if (own === null || base === null) return false;
  let a, b;
  try {
    a = parseRoleText(own);
    b = parseRoleText(base);
  } catch {
    return false;
  }
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (a.body.trim() !== b.body.trim() || !same(a.meta.description, b.meta.description) || !same(a.meta.writes, b.meta.writes) || !same(a.meta.modes, b.meta.modes)) return false;
  const o = roleOverlay(app, name);
  const merge = (d: { add: string[]; remove: string[] }, e: { add: string[]; remove: string[] }) => ({ add: [...new Set([...d.add, ...e.add])].filter((x) => !e.remove.includes(x)), remove: [...new Set([...d.remove, ...e.remove])].filter((x) => !e.add.includes(x)) });
  // Tools spelled out next to groups that already hold them (left by older merges) add nothing.
  const covered = new Set(expandTools(b.meta.tools));
  const tools = diffList(b.meta.tools, a.meta.tools);
  writeOverlay(app, name, { skills: merge(o.skills, diffList(b.meta.skills, a.meta.skills)), tools: merge(o.tools, { add: tools.add.filter((t) => !covered.has(t)), remove: tools.remove }) });
  rmSync(join(dir(app), `${name}.md`), { force: true });
  rmSync(join(baseDir(app), `${name}.md`), { force: true });
  commitLibrary(app.libraryDir, `omem: built-in role ${name} only had added skills or tools; keep them as an overlay and follow the source`);
  return true;
}
export const simplifyRoleCopies = (app: App) => roleNames.filter((n) => existsSync(join(dir(app), `${n}.md`)) && simplifyRoleCopy(app, n));

export function roleHistory(app: App, name: string) {
  return fileHistory(app.libraryDir, `_roles/${check(name)}.md`, 30);
}
