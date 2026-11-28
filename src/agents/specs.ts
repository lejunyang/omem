import { validatePolicy } from "./ai-policy.ts";
import { classPolicySchema, classSchema, specAiSchema } from "../core/ai-policy-schema.ts";
import { toolSections } from "./instruction-sections.ts";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { commitLibrary, fileAt, fileHistory } from "../core/git.ts";
import { roleNames } from "../core/config.ts";
import { HttpError, json } from "../core/util.ts";
import { all } from "../core/db.ts";
import { categoryStatus } from "../core/ai-keys.ts";
import { TOOL_GROUPS, unknownGroups } from "./tool-help.ts";
import { groupOf, groupTitle, loadSkillGroups, saveSkillGroups, skillEnabled } from "./skill-groups.ts";

/**
 * What the assistant learns to delegate to, kept as files in the library
 * (a Git repository, so every change has history):
 *
 * - Agent specs  `library/_agents/<name>.md` — frontmatter (backend agent,
 *   model, omem tools, extra MCP servers, skills, space, working directory,
 *   when to use) plus the system prompt as the body.
 * - Skills       `library/_skills/<name>/SKILL.md` — reusable procedures in the
 *   common SKILL.md format (name + description frontmatter, Markdown body,
 *   optional extra files beside it). Agents see the index and read on demand.
 *
 * Drafts (status: draft) are proposals, e.g. from the dreamer; they are not
 * offered to agents until the owner approves them.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** `readOnly: true`: the server only reads (a search API, docs): replay arms may use it (agents/replay.ts). */
const mcpServerSchema = z.union([
  z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), readOnly: z.boolean().optional() }),
  z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).default({}), readOnly: z.boolean().optional() }),
]);
export type McpServerSpec = z.infer<typeof mcpServerSchema>;

export const agentSpecSchema = z.object({
  name: z.string().regex(NAME, "名称只能用小写字母、数字和连字符"),
  description: z.string().min(1).describe("做什么、什么时候该用它"),
  status: z.enum(["active", "draft"]).default("active"),
  /** Where the Agent page lists it: the owner's own grouping of profiles, a few words. Nothing else goes by it. */
  group: z.string().trim().max(24).optional(),
  /** Backend agent profile id (codex, claude, …); empty = the assistant's. */
  class: classSchema.optional(),
  ai: specAiSchema.optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** omem tools it may use; empty = the assistant's read tools. */
  tools: z.array(z.string()).default([]),
  /** May edit files in its working directory. */
  writes: z.boolean().default(false),
  /**
   * The owner's 完全访问: its commands run outside the backend's sandbox without approvals (codex
   * agent-full-access, Claude bypassPermissions). Only the owner sets it, on the Agent page.
   */
  fullAccess: z.boolean().default(false),
  space: z.string().optional(),
  /** Other spaces it may read; ["*"] = all. */
  spaces: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  skills: z.array(z.string()).default([]),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
  /** MCP servers from the owner's list (settings `mcp.servers`, Agent 页 → MCP) its runs are given, by name. */
  mcpServers: z.array(z.string()).default([]),
  /** Extra project instructions in the style of AGENTS.md / CLAUDE.md. */
  instructions: z.string().optional(),
  /** Comes from this plugin (docs/v2/plugins.md); its runs read and write the plugin's records. */
  plugin: z.string().optional(),
  /**
   * What kind of profile it is, for the host's own uses; the host never goes by a profile's name.
   * `research`: looks beyond this library (the web, other systems) — nightly replay's R3 axis.
   */
  traits: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).default([]),
});
export type AgentSpec = z.infer<typeof agentSpecSchema> & { prompt: string; updatedBy?: string };

export const DEFAULT_SPEC_TOOLS = ["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "list_conversations", "read_conversation", "list_skills", "read_skill"];

const agentsDir = (app: App) => join(app.libraryDir, "_agents");
const skillsDir = (app: App) => join(app.libraryDir, "_skills");

export function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  return m ? { meta: (YAML.parse(m[1]) ?? {}) as Record<string, unknown>, body: raw.slice(m[0].length).trim() } : { meta: {}, body: raw.trim() };
}

function checkName(name: string) {
  if (!NAME.test(name)) throw new HttpError(400, `名称不合法：${name}（小写字母、数字、连字符）`);
  return name;
}
/** A new spec may not take a built-in role's name: memories and skills of a profile are keyed by name. */
function checkSpecName(name: string) {
  checkName(name);
  if ((roleNames as readonly string[]).includes(name)) throw new HttpError(400, `${name} 是内置角色的名字，换一个；要调整内置角色，在 Agent 页打开它自定义`);
  return name;
}

// ---- agents ---------------------------------------------------------------

/**
 * Specs that ship inside plugins (src/plugins/registry.ts). A copy in library/_agents with the
 * same name is the owner's customized version and wins; deleting it brings the plugin's back.
 */
type SpecSource = { find: (app: App, name: string) => AgentSpec | null; list: (app: App) => AgentSpec[]; raw: (name: string) => string | null };
let pluginSpecs: SpecSource | null = null;
export function setPluginSpecSource(source: SpecSource | null) {
  pluginSpecs = source;
}

export function listAgentSpecs(app: App, opts: { includeDrafts?: boolean } = {}): AgentSpec[] {
  const dir = agentsDir(app);
  const out: AgentSpec[] = [];
  const own = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  for (const spec of pluginSpecs?.list(app) ?? []) if (!own.includes(`${spec.name}.md`)) out.push(spec);
  for (const f of own) {
    try {
      const spec = readAgentSpec(app, f.slice(0, -3));
      if (spec.status === "active" || opts.includeDrafts) out.push(spec);
    } catch (e) {
      console.warn(`[omem] 跳过无法解析的 Agent 档案 ${f}：${(e as Error).message}`);
    }
  }
  return out;
}

export function findAgentSpec(app: App, name: string): AgentSpec | null {
  return existsSync(join(agentsDir(app), `${name}.md`)) ? readAgentSpec(app, name) : (NAME.test(name) ? pluginSpecs?.find(app, name) ?? null : null);
}

export function readAgentSpec(app: App, name: string): AgentSpec {
  const file = join(agentsDir(app), `${checkName(name)}.md`);
  if (!existsSync(file)) {
    const fromPlugin = pluginSpecs?.find(app, name);
    if (fromPlugin) return fromPlugin;
    throw new HttpError(404, `没有名为 ${name} 的 Agent 档案`);
  }
  const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
  const parsed = agentSpecSchema.parse({ ...meta, name });
  for (const text of [body, parsed.instructions]) {
    if (text?.includes("<!-- when:")) toolSections(text, new Set());
  }
  return { ...parsed, prompt: body };
}

export function saveAgentSpec(app: App, input: Partial<z.input<typeof agentSpecSchema>> & { name: string; prompt?: string }, actor: "user" | "agent" = "agent") {
  checkSpecName(input.name);
  const prev = findAgentSpec(app, input.name);
  const { prompt, ...rest } = input;
  const merged = agentSpecSchema.parse({ ...(prev ?? {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
  // `group:<id>` is expanded when the profile runs (tool-help.ts expandTools): a group that does not exist would silently give nothing.
  if (merged.ai) {
    const classId = merged.class ?? "agents";
    validatePolicy(app, { deny: [], classes: { [classId]: classPolicySchema.parse(merged.ai) } });
  }
  const noGroup = unknownGroups(merged.tools);
  if (noGroup.length) throw new HttpError(400, `没有这些工具分组：${noGroup.join("、")}；可用 ${TOOL_GROUPS.map((g) => `group:${g.id}`).join("、")}`);
  // An agent editing a profile (save_agent) keeps whatever the owner chose.
  if (actor !== "user") merged.fullAccess = prev?.fullAccess ?? false;
  const body = (prompt ?? prev?.prompt ?? "").trim();
  if (!body) throw new HttpError(400, "需要写 system prompt（正文）");
  // The spec is identity only. Agents used to dump a whole investigation into the prompt.
  // Skills (reusable procedure) and scope=agent memories (preferences/experience) are the
  // right place; catch the obvious case and redirect rather than silently bloating the spec.
  if (actor === "agent" && body.length > 4000) {
    throw new HttpError(
      422,
      "档案正文只写稳定的职责和工作原则（建议几百字以内）。可复用的步骤请用 save_skill，偏好、风格和这次的结论用 remember（scope=agent）；确需保留长篇身份说明时，请本人在网页里直接编辑。",
    );
  }
  const meta: Record<string, unknown> = { ...merged };
  delete meta.name;
  // An emptied field (the page clears the model, say) is removed rather than kept as "".
  for (const [k, v] of Object.entries(meta)) if (v === undefined || v === "" || (Array.isArray(v) && !v.length) || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) delete meta[k];
  if (meta.status === "active") delete meta.status;
  if (meta.writes === false) delete meta.writes;
  if (meta.fullAccess === false) delete meta.fullAccess;
  mkdirSync(agentsDir(app), { recursive: true });
  writeFileSync(join(agentsDir(app), `${input.name}.md`), `---\n${YAML.stringify(meta).trim()}\n---\n\n${body}\n`);
  commitLibrary(app.libraryDir, `${actor}: ${prev ? "update" : "create"} agent ${input.name}${merged.status === "draft" ? " (draft)" : ""}`);
  return readAgentSpec(app, input.name);
}

export function deleteAgentSpec(app: App, name: string, actor: "user" | "agent" = "user") {
  const file = join(agentsDir(app), `${checkName(name)}.md`);
  if (!existsSync(file) && pluginSpecs?.find(app, name)) throw new HttpError(400, `${name} 是插件自带的档案，不能删除；自定义过的删掉后会回到插件的版本`);
  if (!existsSync(file)) throw new HttpError(404, `没有名为 ${name} 的 Agent 档案`);
  rmSync(file);
  commitLibrary(app.libraryDir, `${actor}: delete agent ${name}`);
}

export function agentSpecHistory(app: App, name: string) {
  return fileHistory(app.libraryDir, `_agents/${checkName(name)}.md`, 30);
}

// ---- skills ---------------------------------------------------------------

/** `requires`: models the skill needs (`ai:image`, `ai:voice`, `ai:decision`); agents are told about it only once they are configured. */
export type Skill = { name: string; description: string; status: "active" | "draft"; body: string; dir: string; files: string[]; requires: string[] };

/** Whether what a skill needs is there (settings → AI). */
export function skillUsable(app: App, s: Pick<Skill, "requires">) {
  return s.requires.every((r) => {
    const m = /^ai:(image|voice|decision)$/.exec(r);
    return !m || categoryStatus(app.config, m[1] as "image" | "voice" | "decision", app.home).ready;
  });
}

export function listSkills(app: App, opts: { includeDrafts?: boolean; exclude?: ReadonlySet<string> } = {}): Skill[] {
  const dir = skillsDir(app);
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (opts.exclude?.has(name) || !existsSync(join(dir, name, "SKILL.md"))) continue;
    try {
      const s = readSkill(app, name);
      if (s.status === "active" || opts.includeDrafts) out.push(s);
    } catch {}
  }
  return out;
}

/** Owner's skill library is file-backed. Read manifests only, without walking attached files. */
export async function draftSkillSummary(app: App) {
  const dir = skillsDir(app);
  if (!existsSync(dir)) return null;
  let count = 0, at = "";
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    try {
      const path = skillPath(app, entry.name, "SKILL.md");
      if (splitFrontmatter(await readFile(path, "utf8")).meta.status !== "draft") continue;
      const updated = (await stat(path)).mtime.toISOString();
      if (updated > at) at = updated;
      if (++count === 100) break;
    } catch { /* listSkills also omits incomplete or invalid manifests */ }
  }
  return count ? { count, at } : null;
}

export function findSkill(app: App, name: string) {
  return existsSync(join(skillsDir(app), name, "SKILL.md")) ? readSkill(app, name) : null;
}

export function readSkill(app: App, name: string): Skill {
  const dir = join(skillsDir(app), checkName(name));
  const file = skillPath(app, name, "SKILL.md");
  if (!existsSync(file)) throw new HttpError(404, `没有名为 ${name} 的技能`);
  const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
  return {
    name,
    description: String(meta.description ?? ""),
    status: meta.status === "draft" ? "draft" : "active",
    requires: Array.isArray(meta.requires) ? meta.requires.map(String) : typeof meta.requires === "string" ? [meta.requires] : [],
    body,
    dir,
    files: listSkillFiles(app, name).filter((f) => f.type === "file" && f.path !== "SKILL.md").map((f) => f.path),
  };
}

/** Paths are relative to one skill; never follow links out of the library. */
function skillPath(app: App, name: string, path: string) {
  checkName(name);
  if (!path || path.length > 1000 || /[\\:\x00-\x1f]/.test(path) || path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git"))
    throw new HttpError(400, "文件路径必须是技能内的相对路径");
  let file = app.libraryDir;
  for (const part of ["_skills", name, ...path.split("/")]) {
    file = join(file, part);
    try { if (lstatSync(file).isSymbolicLink()) throw new HttpError(400, "不支持编辑符号链接"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return file;
}

export function listSkillFiles(app: App, name: string): { path: string; type: "file" | "directory" }[] {
  const root = skillPath(app, name, "SKILL.md");
  if (!existsSync(root)) throw new HttpError(404, "技能不存在");
  const result: { path: string; type: "file" | "directory" }[] = [];
  function walk(rel: string) {
    const dir = join(skillsDir(app), name, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.name === "SKILL.md") - Number(a.name === "SKILL.md") || Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || entry.name === ".git") continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result.push({ path, type: "directory" }); walk(path); }
      else if (entry.isFile()) result.push({ path, type: "file" });
    }
  }
  walk("");
  return result;
}

const MAX_SKILL_FILE = 2 * 1024 * 1024;
export function readSkillFile(app: App, name: string, path: string) {
  const file = skillPath(app, name, path);
  if (!existsSync(file)) throw new HttpError(404, "文件不存在");
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_SKILL_FILE) throw new HttpError(400, "只支持编辑不超过 2 MB 的文本文件");
  const data = readFileSync(file);
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new HttpError(400, "只支持 UTF-8 文本文件"); }
  if (raw.includes("\0")) throw new HttpError(400, "二进制文件不能在文本编辑器中打开");
  return raw;
}

export function saveSkillFile(app: App, name: string, path: string, raw: string, create = false) {
  const file = skillPath(app, name, path);
  if (Buffer.byteLength(raw) > MAX_SKILL_FILE || raw.includes("\0")) throw new HttpError(400, "只支持不超过 2 MB 的文本");
  if (create && existsSync(file)) throw new HttpError(409, "文件已存在");
  if (!create && !existsSync(file)) throw new HttpError(404, "文件不存在");
  if (existsSync(file)) readSkillFile(app, name, path);
  if (path === "SKILL.md") return saveRaw(app, "skill", name, raw);
  readSkill(app, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, raw);
  commitLibrary(app.libraryDir, `user: edit skill ${name}/${path}`);
}

export function deleteSkillFile(app: App, name: string, path: string) {
  const file = skillPath(app, name, path);
  if (path === "SKILL.md") throw new HttpError(400, "SKILL.md 是技能入口，不能单独删除");
  readSkillFile(app, name, path);
  rmSync(file);
  commitLibrary(app.libraryDir, `user: delete skill ${name}/${path}`);
}

export function saveSkill(app: App, input: { name: string; description: string; body: string; status?: "active" | "draft"; files?: Record<string, string> }, actor: "user" | "agent" = "agent") {
  checkName(input.name);
  if (!input.description.trim()) throw new HttpError(400, "技能需要一句描述：做什么、什么时候用");
  if (!input.body.trim()) throw new HttpError(400, "技能正文不能为空");
  const prev = findSkill(app, input.name);
  const dir = join(skillsDir(app), input.name);
  skillPath(app, input.name, "SKILL.md");
  for (const rel of Object.keys(input.files ?? {})) { skillPath(app, input.name, rel); if (rel === "SKILL.md") throw new HttpError(400, "附属文件不能覆盖 SKILL.md"); }
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = { name: input.name, description: input.description.trim() };
  if (input.status === "draft") meta.status = "draft";
  writeFileSync(join(dir, "SKILL.md"), `---\n${YAML.stringify(meta).trim()}\n---\n\n${input.body.trim()}\n`);
  for (const [rel, content] of Object.entries(input.files ?? {})) {
    if (rel.includes("..") || rel.startsWith("/") || rel === "SKILL.md") throw new HttpError(400, `文件名不合法：${rel}`);
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  commitLibrary(app.libraryDir, `${actor}: ${prev ? "update" : "create"} skill ${input.name}${input.status === "draft" ? " (draft)" : ""}`);
  return readSkill(app, input.name);
}

/**
 * Turn a skill on or off: a draft is in no agent's list. The rest of its frontmatter and its files
 * stay as they are. Turned off by the owner it is marked `tryout: false`: the nightly replay does
 * not try it out (and so cannot turn it back on) until the owner enables it again.
 */
export function setSkillStatus(app: App, name: string, status: "active" | "draft", actor: "user" | "agent" = "user") {
  const s = readSkill(app, name);
  const { meta } = splitFrontmatter(readRaw(app, "skill", name));
  delete meta.status;
  delete meta.tryout;
  if (status === "draft") {
    meta.status = "draft";
    if (actor === "user") meta.tryout = false;
  }
  writeFileSync(join(skillsDir(app), name, "SKILL.md"), ["---", YAML.stringify(meta).trim(), "---", "", s.body.trim(), ""].join("\n"));
  commitLibrary(app.libraryDir, `${actor}: turn skill ${name} ${status === "draft" ? "off" : "on"}`);
  return readSkill(app, name);
}
/** A draft the owner turned off themselves (setSkillStatus): not a candidate for trying out. */
export const skillHeld = (app: App, name: string) => splitFrontmatter(readRaw(app, "skill", name)).meta.tryout === false;

export function deleteSkill(app: App, name: string, actor: "user" | "agent" = "user") {
  const dir = join(skillsDir(app), checkName(name));
  skillPath(app, name, "SKILL.md");
  if (!existsSync(dir)) throw new HttpError(404, `没有名为 ${name} 的技能`);
  rmSync(dir, { recursive: true, force: true });
  // A skill taken over from an agent's folder keeps its entry, switched off: installed there again,
  // it comes back off rather than on (agent-skills.ts).
  const groups = loadSkillGroups(app);
  if (groups.skills[name]) {
    if (groups.skills[name].origin) groups.skills[name] = { ...groups.skills[name], enabled: false, hash: undefined };
    else delete groups.skills[name];
    saveSkillGroups(app, groups);
  }
  commitLibrary(app.libraryDir, `${actor}: delete skill ${name}`);
}

/**
 * Skills mounted on a space (its settings' `skills`): how this business or repository does things
 * (its test and requirement conventions, its scripts), kept in the data folder rather than the
 * repository. Runs in the space, and coding runs that touch the repository, get them first; other
 * runs are not offered them.
 */
export function spaceSkillNames(settings: Record<string, unknown> | undefined): string[] {
  const v = settings?.skills;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

/** A mounted skill is visible in any of its spaces and to profiles that explicitly name it. */
export function skillsOutsideScope(app: App, profileSkills: string[] | undefined, readable: string[] | null): Set<string> {
  const outside = new Set<string>();
  if (!readable) return outside;
  const allowed = new Set(profileSkills);
  const spaces = new Set(readable);
  const rows = all<{ id: string; settings: string }>(app.db, "select id, settings from spaces where instr(settings, '\"skills\"') > 0");
  for (const row of rows) {
    const names = spaces.has(row.id) ? allowed : outside;
    for (const name of spaceSkillNames(json(row.settings, {}))) names.add(name);
  }
  for (const name of allowed) outside.delete(name);
  return outside;
}

const skillLine = (s: Skill) => `- ${s.name}：${s.description}（全文：read_skill，或读取 ${join(s.dir, "SKILL.md")}）`;

/**
 * The skills a run is told about. `names`: its own (a profile's or a role's regular skills), each
 * with its description; the rest only by name, so a specialist does not carry every runbook's
 * summary. Without `names` (the main assistant, which hands work out) every skill is described. `mounted`: the skills of the run's spaces, which go in their own
 * section (spaceSkillsText) and so are left out here; skills mounted on other spaces are left out too.
 */
export function skillIndex(app: App, names?: string[], mounted: string[] = [], outside = skillsOutsideScope(app, names, [])) {
  const groups = loadSkillGroups(app, outside);
  const list = listSkills(app, { exclude: outside }).filter((s) => skillUsable(app, s) && skillEnabled(groups, s.name) && !mounted.includes(s.name));
  // A skill in a group is offered through the group (agent-skills.ts), one line for all of them,
  // unless the run's profile names it.
  const grouped = new Map<string, string[]>();
  const loose = list.filter((s) => {
    const g = groupOf(groups, s.name);
    if (!g || names?.includes(s.name)) return true;
    grouped.set(g, [...(grouped.get(g) ?? []), s.name]);
    return false;
  });
  const groupLines = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([g, ms]) => `- ${g}（技能分组「${groupTitle(groups, g)}」，${ms.length} 个技能）：${groups.groups[g]?.description?.trim() || `如 ${ms.slice(0, 8).join("、")}${ms.length > 8 ? " 等" : ""}`}（按用途找技能：read_skill name=${g}）`);
  if (!names) return [...loose.map(skillLine), ...groupLines].join("\n");
  const own = loose.filter((s) => names.includes(s.name));
  const rest = loose.filter((s) => !names.includes(s.name));
  return [...own.map(skillLine), ...(rest.length ? [`- 其他技能（用到时 read_skill 读全文）：${rest.map((s) => s.name).join("、")}`] : []), ...groupLines].join("\n");
}

/** The skills mounted on these spaces, each with the spaces it is for. */
export function spaceSkillsText(app: App, spaces: { id: string; name: string; settings: Record<string, unknown> }[]): { text: string; names: string[] } {
  const by = new Map<string, string[]>();
  for (const sp of spaces) for (const n of spaceSkillNames(sp.settings)) by.set(n, [...(by.get(n) ?? []), sp.name]);
  const groups = loadSkillGroups(app);
  const skills = listSkills(app).filter((s) => by.has(s.name) && skillUsable(app, s) && skillEnabled(groups, s.name));
  return { text: skills.map((s) => `${skillLine(s)}　用于：${by.get(s.name)!.join("、")}`).join("\n"), names: skills.map((s) => s.name) };
}

export function agentIndex(app: App) {
  return listAgentSpecs(app)
    .map((a) => `- ${a.name}：${a.description}`)
    .join("\n");
}

// ---- raw files (web editor) ---------------------------------------------------

export function readRaw(app: App, kind: "agent" | "skill", name: string) {
  const file = kind === "agent" ? join(agentsDir(app), `${checkName(name)}.md`) : skillPath(app, name, "SKILL.md");
  // A plugin's own spec, not customized yet: saving the edited text makes the library copy.
  if (!existsSync(file) && kind === "agent") {
    const raw = pluginSpecs?.raw(name);
    if (raw) return raw;
  }
  if (!existsSync(file)) throw new HttpError(404, `不存在：${name}`);
  return readFileSync(file, "utf8");
}

/** Save an edited file after checking it parses; invalid content is rejected, not written. */
export function saveRaw(app: App, kind: "agent" | "skill", name: string, raw: string) {
  if (kind === "agent") checkSpecName(name);
  else skillPath(app, name, "SKILL.md");
  const { meta, body } = splitFrontmatter(raw);
  if (kind === "agent") {
    agentSpecSchema.parse({ ...meta, name });
    if (!body) throw new HttpError(400, "需要写 system prompt（正文）");
    mkdirSync(agentsDir(app), { recursive: true });
    writeFileSync(join(agentsDir(app), `${name}.md`), raw.endsWith("\n") ? raw : raw + "\n");
    commitLibrary(app.libraryDir, `user: edit agent ${name}`);
    return readAgentSpec(app, name);
  }
  if (!String(meta.description ?? "").trim()) throw new HttpError(400, "技能需要 description");
  mkdirSync(join(skillsDir(app), name), { recursive: true });
  writeFileSync(join(skillsDir(app), name, "SKILL.md"), raw.endsWith("\n") ? raw : raw + "\n");
  commitLibrary(app.libraryDir, `user: edit skill ${name}`);
  return readSkill(app, name);
}

/**
 * Skills that ship with omem (skills/library/<name>/ in the package, SKILL.md plus any
 * references/ files) are copied into the library the first time; afterwards the library copy
 * is the owner's to edit. The check is per skill name, so a skill added by a newer omem
 * reaches an existing install at its next start while edited or deleted-and-recreated
 * copies of older ones are never overwritten.
 */
export function seedBuiltinSkills(app: App, packageRoot: string) {
  const dir = join(packageRoot, "skills", "library");
  if (!existsSync(dir)) return [];
  const added: string[] = [];
  const updated: string[] = [];
  for (const name of readdirSync(dir)) {
    const src = join(dir, name, "SKILL.md");
    if (!existsSync(src)) continue;
    const mine = join(skillsDir(app), name);
    if (!existsSync(join(mine, "SKILL.md"))) {
      cpSync(join(dir, name), mine, { recursive: true, force: false });
      added.push(name);
    } else if (canUpdateSeededSkill(app, name, join(dir, name), c => /^omem: (add|update) built-in skills /.test(c))) {
      cpSync(join(dir, name), mine, { recursive: true, force: true });
      updated.push(name);
    }
  }
  if (added.length) commitLibrary(app.libraryDir, `omem: add built-in skills ${added.join(", ")}`);
  if (updated.length) commitLibrary(app.libraryDir, `omem: update built-in skills ${updated.join(", ")}`);
  return [...added, ...updated];
}

const filesUnder = (dir: string, base = ""): string[] =>
  readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(dir, join(base, e.name)) : [join(base, e.name)]));

/** The packaged version of a built-in skill differs from the library copy. */
function builtinChanged(pkg: string, mine: string) {
  return filesUnder(pkg).some((f) => !existsSync(join(mine, f)) || readFileSync(join(pkg, f), "utf8") !== readFileSync(join(mine, f), "utf8"));
}

/**
 * The library copy of a built-in skill is still what omem put there: every file in it equals its
 * content at the latest commit omem made of it (seeding or an earlier update). A copy the owner or
 * an agent edited (or one from before the library kept history) stays theirs and is never replaced.
 */
export function canUpdateSeededSkill(app: App, name: string, pkg: string, seededBy: (message: string) => boolean) {
  const mine = join(skillsDir(app), name);
  if (!builtinChanged(pkg, mine)) return false;
  return filesUnder(mine).every((f) => {
    const rel = `_skills/${name}/${f.replace(/\\/g, "/")}`;
    const seeded = fileHistory(app.libraryDir, rel).find(c => seededBy(c.message));
    return !!seeded && fileAt(app.libraryDir, seeded.hash, rel) === readFileSync(join(mine, f), "utf8");
  });
}
