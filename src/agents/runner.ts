import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile, type RoleName } from "../core/config.ts";
import { findSpace, spaceDir } from "../core/spaces.ts";
import { all } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { spaceGuide } from "../wiki/store.ts";
import { runAcp } from "./acp.ts";
import { runCli } from "./cli.ts";
import { commandExists } from "./spawn.ts";
import { issueToolToken, revokeToolToken } from "./tools.ts";
import type { AgentEvent, AgentResult, McpAccess } from "./types.ts";
import { OWNER, personalSpaceId, scopeFor, userName } from "../core/users.ts";
import { agentIndex, DEFAULT_SPEC_TOOLS, skillIndex, type AgentSpec, type McpServerSpec } from "./specs.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** roles/ sits at the package root both in source (src/agents) and build (dist/src/agents). */
function rolesDir() {
  for (const candidate of [resolve(here, "../../roles"), resolve(here, "../../../roles")]) if (existsSync(join(candidate, "_common.md"))) return candidate;
  throw new Error("找不到 roles 目录");
}

export type Role = { name: string; description: string; tools: string[]; writes: boolean; modes: string[]; body: string };

const roleCache = new Map<string, Role>();
export function loadRole(name: string): Role {
  const cached = roleCache.get(name);
  if (cached && process.env.NODE_ENV === "production") return cached;
  const file = join(rolesDir(), `${name}.md`);
  if (!existsSync(file)) throw new HttpError(400, `未知角色：${name}`);
  const raw = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const meta = (m ? YAML.parse(m[1]) : {}) as Partial<Role>;
  const role: Role = {
    name,
    description: meta.description ?? "",
    tools: meta.tools ?? [],
    writes: !!meta.writes,
    modes: meta.modes ?? [],
    body: m ? raw.slice(m[0].length) : raw,
  };
  roleCache.set(name, role);
  return role;
}

const commonGuide = () => readFileSync(join(rolesDir(), "_common.md"), "utf8");

const available = new Map<string, boolean>();
function installed(p: AgentProfile) {
  if (!available.has(p.command)) available.set(p.command, commandExists(p.command));
  return available.get(p.command)!;
}

export function listAgentProfiles(app: App) {
  return allProfiles(app.config).map((p) => ({ ...p, installed: installed(p) }));
}

export function profileFor(app: App, role: RoleName | string): AgentProfile {
  const profiles = allProfiles(app.config);
  const wanted = app.config.agents.roles[role] ?? app.config.agents.default;
  if (wanted) {
    const p = profiles.find((x) => x.id === wanted);
    if (!p) throw new HttpError(400, `配置的 Agent ${wanted} 不存在`);
    return p;
  }
  const p = profiles.find(installed);
  if (!p) throw new HttpError(503, "没有可用的 Agent。请安装 codex-acp、claude-agent-acp 或 claude/codex CLI，并在设置中选择。");
  return p;
}

function mcpBridge(): { command: string; args: string[] } {
  const ts = resolve(here, "../mcp-bridge.ts");
  const js = resolve(here, "../mcp-bridge.js");
  return { command: process.execPath, args: [existsSync(js) ? js : ts] };
}

function localTime(app: App) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", { timeZone: app.config.timezone, dateStyle: "full", timeStyle: "short" });
  return `${fmt.format(now)}（时区 ${app.config.timezone}，ISO ${now.toISOString()}）`;
}

/**
 * Self-improvement loop: preferences the owner stated and lessons distilled by
 * the dreamer (experience memories) are handed to every future run.
 */
function learnedContext(app: App, spaceId: string, userId: string) {
  const rows = all<{ kind: string; subject: string; content: string }>(
    app.db,
    `select kind, subject, content from memories where status = 'active' and (
       (kind = 'preference' and space_id in (?, ?) and coalesce(user_id, 'owner') = ?) or (kind = 'experience' and space_id = ?)
     ) order by kind = 'preference' desc, updated_at desc limit 24`,
    personalSpaceId(userId),
    spaceId,
    userId,
    spaceId,
  );
  return rows.map((r) => `- ${r.kind === "preference" ? "偏好" : "经验"}${r.subject ? `（${r.subject}）` : ""}：${r.content}`).join("\n");
}

export type RoleRunInput = {
  role: RoleName;
  spaceId: string;
  /** Spaces this run may touch; defaults to all for the assistant, the space otherwise. */
  spaces?: string[] | null;
  task: string;
  runId: string | null;
  cwd?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  profileId?: string;
};

/** Who is acting: a built-in role, or an agent spec the assistant (or the owner) created. */
export type Actor = { role: RoleName } | { spec: AgentSpec };

export type PreparedRun = {
  profile: AgentProfile;
  cwd: string;
  /** Everything before the task: shared rules, role or spec, environment, learned context. */
  system: string;
  token: string;
  mcp: McpAccess;
  extraMcp: Record<string, McpServerSpec>;
  allowWrites: boolean;
  modes: string[];
  label: string;
};

/**
 * Resolve backend, working directory, tool token and the standing context for
 * a role or agent spec. The caller owns the token (revoke it when done).
 */
export function prepareRun(app: App, input: { actor: Actor; spaceId: string; spaces?: string[] | null; runId: string | null; cwd?: string; profileId?: string; userId?: string }): PreparedRun {
  const userId = input.userId ?? OWNER;
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const role = spec ? null : loadRole((input.actor as { role: RoleName }).role);
  const roleName = role ? (input.actor as { role: RoleName }).role : "assistant";
  const baseProfile = input.profileId
    ? allProfiles(app.config).find((p) => p.id === input.profileId)
    : spec?.agent
      ? allProfiles(app.config).find((p) => p.id === spec.agent)
      : profileFor(app, roleName);
  if (!baseProfile) throw new HttpError(400, `Agent ${input.profileId ?? spec?.agent} 不存在`);
  const profile: AgentProfile = spec ? { ...baseProfile, model: spec.model ?? baseProfile.model, effort: spec.effort ?? baseProfile.effort } : baseProfile;
  const spaceId = spec?.space && !input.spaceId ? spec.space : input.spaceId;
  const space = findSpace(app, spaceId);
  if (!space) throw new HttpError(404, `空间不存在：${spaceId}`);
  if (!app.baseUrl) throw new Error("omem 服务尚未启动，无法为 Agent 提供工具");
  const cwd = input.cwd ?? spec?.cwd ?? space.rootPath ?? spaceDir(app, space.id);
  const tools = new Set(spec ? (spec.tools.length ? spec.tools : DEFAULT_SPEC_TOOLS) : role!.tools);
  // Skills are offered to everyone who can read them.
  tools.add("list_skills");
  tools.add("read_skill");
  const spaces =
    input.spaces !== undefined ? input.spaces : spec ? (spec.spaces.includes("*") ? null : [...new Set([space.id, ...spec.spaces])]) : roleName === "assistant" ? null : [space.id];
  const scoped = scopeFor(app, userId, spaces);
  if (scoped && !scoped.includes(space.id)) throw new HttpError(403, `${userName(app, userId)} 不能访问空间 ${space.id}`);
  const token = issueToolToken({ runId: input.runId, spaceId: space.id, spaces: scoped, tools, actor: "agent", userId });
  const guide = spaceGuide(app, space.id).trim();
  const lessons = learnedContext(app, space.id, userId);
  const skills = skillIndex(app, spec?.skills);
  const agents = roleName === "assistant" && !spec ? agentIndex(app) : "";
  const body = spec
    ? `# 角色：${spec.description}\n\n${spec.prompt}${spec.instructions ? `\n\n## 工作约定（AGENTS.md）\n\n${spec.instructions}` : ""}`
    : `# 角色：${role!.description}\n\n${role!.body}`;
  const system = [
    commonGuide(),
    body,
    `# 环境\n\n- 现在：${localTime(app)}${userId !== OWNER ? `\n- 这次是在为 ${userName(app, userId)} 工作（不是 omem 的主人），只能使用其有权访问的空间；对话里的“本人”指 ${userName(app, userId)}` : ""}\n- 当前空间：${space.id}（${space.name}，${space.kind}）${space.rootPath ? `\n- 工作目录是该空间关联的目录：${space.rootPath}` : `\n- 工作目录是该空间的知识库目录（wiki/ 下是页面 Markdown）`}${guide ? `\n\n## 空间说明（SPACE.md）\n\n${guide}` : ""}${lessons ? `\n\n## 本人的偏好与以往经验（记忆中保存，按需遵循；与本次要求冲突时以本次为准）\n\n${lessons}` : ""}${skills ? `\n\n## 可用技能（做对应的事之前先读全文并照做）\n\n${skills}` : ""}${agents ? `\n\n## 已有的 Agent 档案（可用 run_agent 交给它们）\n\n${agents}` : ""}`,
  ].join("\n\n---\n\n");
  return {
    profile,
    cwd,
    system,
    token,
    mcp: { url: `${app.baseUrl}/mcp`, baseUrl: app.baseUrl, token, stdio: mcpBridge() },
    extraMcp: spec?.mcp ?? {},
    allowWrites: spec ? spec.writes : role!.writes,
    modes: spec ? (spec.writes ? ["acceptEdits", "default"] : ["read-only", "default", "plan"]) : role!.modes,
    label: spec ? spec.name : roleName,
  };
}

/** Run a role-defined agent turn with omem tools attached. */
export async function runRole(app: App, input: RoleRunInput & { spec?: AgentSpec; userId?: string }): Promise<AgentResult & { profileId: string }> {
  const prep = prepareRun(app, { actor: input.spec ? { spec: input.spec } : { role: input.role }, spaceId: input.spaceId, spaces: input.spaces, runId: input.runId, cwd: input.cwd, profileId: input.profileId, userId: input.userId });
  const emit = input.onEvent ?? (() => {});
  try {
    const req = {
      cwd: prep.cwd,
      prompt: `${prep.system}\n\n---\n\n# 任务\n\n${input.task}`,
      allowWrites: prep.allowWrites,
      modes: prep.modes,
      signal: input.signal,
      mcp: prep.mcp,
      extraMcp: prep.extraMcp,
    };
    const result = prep.profile.transport === "acp" ? await runAcp(prep.profile, req, emit) : await runCli(prep.profile, req, emit);
    return { ...result, profileId: prep.profile.id };
  } finally {
    revokeToolToken(prep.token);
  }
}
