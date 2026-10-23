import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { commitLibrary, fileHistory } from "../core/git.ts";
import { roleNames } from "../core/config.ts";
import { HttpError } from "../core/util.ts";

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

const mcpServerSchema = z.union([
  z.object({ command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) }),
  z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).default({}) }),
]);
export type McpServerSpec = z.infer<typeof mcpServerSchema>;

export const agentSpecSchema = z.object({
  name: z.string().regex(NAME, "名称只能用小写字母、数字和连字符"),
  description: z.string().min(1).describe("做什么、什么时候该用它"),
  status: z.enum(["active", "draft"]).default("active"),
  /** Backend agent profile id (codex, claude, …); empty = the assistant's. */
  agent: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** omem tools it may use; empty = the assistant's read tools. */
  tools: z.array(z.string()).default([]),
  /** May edit files in its working directory. */
  writes: z.boolean().default(false),
  space: z.string().optional(),
  /** Other spaces it may read; ["*"] = all. */
  spaces: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  skills: z.array(z.string()).default([]),
  mcp: z.record(z.string(), mcpServerSchema).default({}),
  /** Extra project instructions in the style of AGENTS.md / CLAUDE.md. */
  instructions: z.string().optional(),
});
export type AgentSpec = z.infer<typeof agentSpecSchema> & { prompt: string; updatedBy?: string };

export const DEFAULT_SPEC_TOOLS = ["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_pages", "read_page", "recall", "list_items", "list_conversations", "read_conversation", "list_skills", "read_skill"];

const agentsDir = (app: App) => join(app.libraryDir, "_agents");
const skillsDir = (app: App) => join(app.libraryDir, "_skills");

function splitFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
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

export function listAgentSpecs(app: App, opts: { includeDrafts?: boolean } = {}): AgentSpec[] {
  const dir = agentsDir(app);
  if (!existsSync(dir)) return [];
  const out: AgentSpec[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
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
  return existsSync(join(agentsDir(app), `${name}.md`)) ? readAgentSpec(app, name) : null;
}

export function readAgentSpec(app: App, name: string): AgentSpec {
  const file = join(agentsDir(app), `${checkName(name)}.md`);
  if (!existsSync(file)) throw new HttpError(404, `没有名为 ${name} 的 Agent 档案`);
  const { meta, body } = splitFrontmatter(readFileSync(file, "utf8"));
  const parsed = agentSpecSchema.parse({ ...meta, name });
  return { ...parsed, prompt: body };
}

export function saveAgentSpec(app: App, input: Partial<z.input<typeof agentSpecSchema>> & { name: string; prompt?: string }, actor: "user" | "agent" = "agent") {
  checkSpecName(input.name);
  const prev = findAgentSpec(app, input.name);
  const { prompt, ...rest } = input;
  const merged = agentSpecSchema.parse({ ...(prev ?? {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) });
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
  mkdirSync(agentsDir(app), { recursive: true });
  writeFileSync(join(agentsDir(app), `${input.name}.md`), `---\n${YAML.stringify(meta).trim()}\n---\n\n${body}\n`);
  commitLibrary(app.libraryDir, `${actor}: ${prev ? "update" : "create"} agent ${input.name}${merged.status === "draft" ? " (draft)" : ""}`);
  return readAgentSpec(app, input.name);
}

export function deleteAgentSpec(app: App, name: string, actor: "user" | "agent" = "user") {
  const file = join(agentsDir(app), `${checkName(name)}.md`);
  if (!existsSync(file)) throw new HttpError(404, `没有名为 ${name} 的 Agent 档案`);
  rmSync(file);
  commitLibrary(app.libraryDir, `${actor}: delete agent ${name}`);
}

export function agentSpecHistory(app: App, name: string) {
  return fileHistory(app.libraryDir, `_agents/${checkName(name)}.md`, 30);
}

// ---- skills ---------------------------------------------------------------

export type Skill = { name: string; description: string; status: "active" | "draft"; body: string; dir: string; files: string[] };

export function listSkills(app: App, opts: { includeDrafts?: boolean } = {}): Skill[] {
  const dir = skillsDir(app);
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!existsSync(join(dir, name, "SKILL.md"))) continue;
    try {
      const s = readSkill(app, name);
      if (s.status === "active" || opts.includeDrafts) out.push(s);
    } catch {}
  }
  return out;
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

export function setSkillStatus(app: App, name: string, status: "active" | "draft", actor: "user" | "agent" = "user") {
  const s = readSkill(app, name);
  return saveSkill(app, { name, description: s.description, body: s.body, status }, actor);
}

export function deleteSkill(app: App, name: string, actor: "user" | "agent" = "user") {
  const dir = join(skillsDir(app), checkName(name));
  skillPath(app, name, "SKILL.md");
  if (!existsSync(dir)) throw new HttpError(404, `没有名为 ${name} 的技能`);
  rmSync(dir, { recursive: true, force: true });
  commitLibrary(app.libraryDir, `${actor}: delete skill ${name}`);
}

/** The progressive-disclosure index handed to agents: names and when to use, bodies on demand. */
/** `names`: only these (an agent spec's skills); `first`: all, these listed first and marked (a role's regular ones). */
export function skillIndex(app: App, names?: string[], first: string[] = []) {
  const all = listSkills(app);
  const picked = names?.length ? all.filter((s) => names.includes(s.name)) : [...all.filter((s) => first.includes(s.name)), ...all.filter((s) => !first.includes(s.name))];
  if (!picked.length) return "";
  return picked.map((s) => `- ${s.name}${first.includes(s.name) ? "（你常用的）" : ""}：${s.description}（全文：read_skill，或读取 ${join(s.dir, "SKILL.md")}）`).join("\n");
}

export function agentIndex(app: App) {
  return listAgentSpecs(app)
    .map((a) => `- ${a.name}：${a.description}`)
    .join("\n");
}

// ---- raw files (web editor) ---------------------------------------------------

export function readRaw(app: App, kind: "agent" | "skill", name: string) {
  const file = kind === "agent" ? join(agentsDir(app), `${checkName(name)}.md`) : skillPath(app, name, "SKILL.md");
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
 * Skills that ship with omem (skills/library/<name>/SKILL.md in the package)
 * are copied into the library the first time; afterwards the library copy is
 * the owner's to edit.
 */
export function seedBuiltinSkills(app: App, packageRoot: string) {
  const dir = join(packageRoot, "skills", "library");
  if (!existsSync(dir)) return [];
  const added: string[] = [];
  for (const name of readdirSync(dir)) {
    const src = join(dir, name, "SKILL.md");
    if (!existsSync(src) || existsSync(join(skillsDir(app), name, "SKILL.md"))) continue;
    mkdirSync(join(skillsDir(app), name), { recursive: true });
    writeFileSync(join(skillsDir(app), name, "SKILL.md"), readFileSync(src, "utf8"));
    added.push(name);
  }
  if (added.length) commitLibrary(app.libraryDir, `omem: add built-in skills ${added.join(", ")}`);
  return added;
}
