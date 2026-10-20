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
  tools: z.array(z.string()).default([]),
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

export type RoleState = {
  name: string;
  description: string;
  customized: boolean;
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
  return { name, description: describe(own ?? source), customized: own !== null, sourceChanged: own !== null && base !== null && hash(base) !== hash(source) };
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

/** Change only the frontmatter of the customized copy (e.g. attach a skill), copying first. */
export function updateRoleMeta(app: App, name: string, patch: (meta: z.infer<typeof roleMetaSchema>) => z.infer<typeof roleMetaSchema>, actor: "user" | "agent" = "agent") {
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

/** Back to the source version: the customized copy is removed (its history stays in Git). */
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

export function roleHistory(app: App, name: string) {
  return fileHistory(app.libraryDir, `_roles/${check(name)}.md`, 30);
}
