import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile, type RoleName } from "../core/config.ts";
import { findSpace, kindLabel, relatedSpaces, spaceDir } from "../core/spaces.ts";
import { all } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { spaceGuide } from "../wiki/store.ts";
import { resolveRoleProfile } from "./models.ts";
import { runBackend } from "./dispatch.ts";
import { doubaoTokenExists } from "./doubao.ts";
import { commandExists } from "./spawn.ts";
import { catalogEntry, installHint } from "./catalog.ts";
import { issueToolToken, revokeToolToken } from "./tools.ts";
import { isAgentRunError, type AgentEvent, type AgentResult, type McpAccess } from "./types.ts";
import { OWNER, personalSpaceId, scopeFor, userName } from "../core/users.ts";
import { agentIndex, DEFAULT_SPEC_TOOLS, skillIndex, type AgentSpec, type McpServerSpec } from "./specs.ts";
import { isBuiltinRole, roleOverrideText, rolesDir } from "./builtin-roles.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** What a run is told about the spaces related to its own. */
function relatedGuide(related: { space: string; name: string; kind: string; note: string }[], readOnly: boolean) {
  return [
    ...related.map((r) => `- ${r.space}（${r.name}，${kindLabel(r.kind)}）${r.note ? `：${r.note}` : ""}`),
    "",
    `search、scan、find_symbol 不指定 space 时会同时查当前空间和这些空间，结果里标出所在空间；只查当前空间就传 space。问题或材料涉及它们（调用、依赖、共用的约定）时去读它们的原件和页面，不要只凭当前空间下结论。${readOnly ? "这次对这些空间只能读：记忆、事项、页面只写进当前空间，用到它们的材料时照常引用原件。" : ""}`,
  ].join("\n");
}
export type Role = { name: string; description: string; tools: string[]; writes: boolean; modes: string[]; skills: string[]; body: string; customized: boolean };

function parseRole(name: string, raw: string, customized: boolean): Role {
  // Windows checkouts may have CRLF line endings.
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = (m ? YAML.parse(m[1]) : {}) as Partial<Role>;
  return {
    name,
    description: meta.description ?? "",
    tools: meta.tools ?? [],
    writes: !!meta.writes,
    modes: meta.modes ?? [],
    skills: meta.skills ?? [],
    body: m ? text.slice(m[0].length) : text,
    customized,
  };
}

const roleCache = new Map<string, Role>();
/** A built-in role: the owner's customized copy in the library when there is one, else the package's. */
export function loadRole(name: string, app?: App): Role {
  const own = app && isBuiltinRole(name) ? roleOverrideText(app, name) : null;
  if (own !== null) {
    try {
      return parseRole(name, own, true);
    } catch (e) {
      console.warn(`[omem] 自定义角色 ${name} 无法解析，改用源码版本：${(e as Error).message}`);
    }
  }
  const cached = roleCache.get(name);
  if (cached && process.env.NODE_ENV === "production") return cached;
  const file = join(rolesDir(), `${name}.md`);
  if (!existsSync(file)) throw new HttpError(400, `未知角色：${name}`);
  const role = parseRole(name, readFileSync(file, "utf8"), false);
  roleCache.set(name, role);
  return role;
}

const commonGuide = () => readFileSync(join(rolesDir(), "_common.md"), "utf8");

const available = new Map<string, boolean>();
let doubaoHome = "";
function installed(p: AgentProfile) {
  // Doubao has no command: it is available once the owner has authorized it (checked each time, it is a file read).
  if (p.transport === "doubao") return !!doubaoHome && doubaoTokenExists(doubaoHome);
  if (!available.has(p.command)) available.set(p.command, commandExists(p.command));
  return available.get(p.command)!;
}

export function listAgentProfiles(app: App) {
  doubaoHome = app.home;
  return allProfiles(app.config).map((p) => {
    if (p.transport === "doubao") return { ...p, installed: installed(p), install: installed(p) ? undefined : "omem doubao login（设备码授权，omem doubao status 查权限）" };
    const e = catalogEntry(p.id);
    return { ...p, installed: installed(p), install: e && e.command === p.command ? installHint(e) : undefined };
  });
}

export function profileFor(app: App, role: RoleName | string): AgentProfile {
  doubaoHome = app.home;
  const profiles = allProfiles(app.config);
  const wanted = app.config.agents.roles[role] ?? app.config.agents.default;
  if (wanted) {
    const p = profiles.find((x) => x.id === wanted);
    if (!p) throw new HttpError(400, `配置的 Agent ${wanted} 不存在`);
    return p;
  }
  const p = profiles.find(installed);
  if (!p) throw new HttpError(503, "没有可用的 Agent。请安装任一支持 ACP 的 Agent（codex-acp、claude-agent-acp、gemini、copilot、qwen、opencode、cursor-agent…），运行 omem agents --all 查看安装方式。");
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
function learnedContext(app: App, spaceId: string, userId: string, spec: string | null) {
  // With review on, only memories the reviewer (or the owner) accepted are handed to every run:
  // a bad lesson repeated in every prompt costs more than a missing one.
  const vetted = app.config.memory.review.enabled ? "and (created_by = 'user' or review_verdict = 'keep')" : "";
  const rows = all<{ kind: string; subject: string; content: string; agent: string | null }>(
    app.db,
    `select kind, subject, content, agent from memories where status = 'active' ${vetted} and (agent is null or agent = ?) and (
       (kind = 'preference' and space_id in (?, ?) and coalesce(user_id, 'owner') = ?) or (kind = 'experience' and space_id = ?)
     ) order by kind = 'preference' desc, agent is not null desc, updated_at desc limit 24`,
    spec ?? "",
    personalSpaceId(userId),
    spaceId,
    userId,
    spaceId,
  );
  return rows.map((r) => `- ${r.kind === "preference" ? "偏好" : "经验"}${r.agent ? "（本档案）" : ""}${r.subject ? `（${r.subject}）` : ""}：${r.content}`).join("\n");
}

export type RoleRunInput = {
  role: RoleName;
  spaceId: string;
  /** Spaces this run may touch; defaults to all for the assistant, the space otherwise. */
  spaces?: string[] | null;
  /** Extra spaces the run may read but never write (a delegation's indexed worktree changes). */
  alsoRead?: string[];
  task: string;
  runId: string | null;
  cwd?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  profileId?: string;
  model?: string;
  effort?: string;
  /** Continue this coding Agent's previous session (code delegation rounds reuse one session). */
  resumeSessionId?: string;
  /** Keep the agent session resumable afterwards (multi-agent work rounds continue it). */
  persistSession?: boolean;
  /** Comparison run: writes are recorded, not applied; no fallback. */
  shadow?: { parentRunId: string | null };
  /** omem tools this run must not have (a consulted agent cannot hand work on). */
  denyTools?: string[];
  /** Feishu chats it may post into (a rule's agent: only the chat that triggered it). */
  lark?: { chats: string[] | null; draft?: boolean };
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
  /** What passive recall may draw on: readable spaces (null = all) and whose own memories count. */
  recall: { spaces: string[] | null; agent: string | null; userId: string } | null;
};

/**
 * Resolve backend, working directory, tool token and the standing context for
 * a role or agent spec. The caller owns the token (revoke it when done).
 */
export function prepareRun(
  app: App,
  input: { actor: Actor; spaceId: string; spaces?: string[] | null; alsoRead?: string[]; runId: string | null; cwd?: string; profileId?: string; userId?: string; model?: string; effort?: string; lark?: { chats: string[] | null; draft?: boolean }; shadow?: { parentRunId: string | null }; denyTools?: string[] },
): PreparedRun {
  const userId = input.userId ?? OWNER;
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const role = spec ? null : loadRole((input.actor as { role: RoleName }).role, app);
  const roleName = role ? (input.actor as { role: RoleName }).role : "assistant";
  const baseProfile = input.profileId
    ? allProfiles(app.config).find((p) => p.id === input.profileId)
    : spec?.agent
      ? allProfiles(app.config).find((p) => p.id === spec.agent)
      : profileFor(app, roleName);
  if (!baseProfile) throw new HttpError(400, `Agent ${input.profileId ?? spec?.agent} 不存在`);
  // Role -> per-profile model/effort overrides apply first; a per-thread override (the
  // /model command or the Feishu model card) wins. Agent specs still set their own model.
  const roleProfile = role ? resolveRoleProfile(app, baseProfile, roleName) : baseProfile;
  const thread = input.model !== undefined || input.effort !== undefined ? { model: input.model, effort: input.effort } : null;
  const profile: AgentProfile = spec
    ? { ...roleProfile, model: spec.model ?? roleProfile.model, effort: spec.effort ?? roleProfile.effort }
    : thread
      ? { ...roleProfile, model: thread.model ?? roleProfile.model, effort: thread.effort ?? roleProfile.effort }
      : roleProfile;
  const spaceId = spec?.space && !input.spaceId ? spec.space : input.spaceId;
  const space = findSpace(app, spaceId);
  if (!space) throw new HttpError(404, `空间不存在：${spaceId}`);
  if (!app.baseUrl) throw new Error("omem 服务尚未启动，无法为 Agent 提供工具");
  const cwd = input.cwd ?? spec?.cwd ?? space.rootPath ?? spaceDir(app, space.id);
  const tools = new Set(spec ? (spec.tools.length ? spec.tools : DEFAULT_SPEC_TOOLS) : role!.tools);
  /**
   * Answering someone who is not a user (guest role): only the role's own tools and the spaces it
   * was given — no skills (they may describe internal systems), no related spaces, none of the
   * owner's preferences or experience.
   */
  const guest = !spec && roleName === "guest";
  // Skills are offered to everyone who can read them.
  if (!guest) {
    tools.add("list_skills");
    tools.add("read_skill");
  }
  // Agents (and the main assistant) can ask one another a question; background roles cannot.
  if (spec || roleName === "assistant") tools.add("ask_agent");
  // …and the owner: a question, or next steps as buttons under the reply. Waiting is for anyone
  // whose tool call is held for approval.
  if (spec || roleName === "assistant") for (const t of ["ask_owner", "suggest_next"]) tools.add(t);
  if (!guest) tools.add("wait_answer");
  for (const t of input.denyTools ?? []) tools.delete(t);
  // A thread that may post into specific Feishu chats (watched groups) gets the bot's voice and notify.
  if (input.lark?.chats?.length) for (const t of ["lark_send", "lark_react", "lark_card", "lark_update_card", "lark_send_file", "notify"]) tools.add(t);
  const spaces =
    input.spaces !== undefined ? input.spaces : spec ? (spec.spaces.includes("*") ? null : [...new Set([space.id, ...spec.spaces])]) : roleName === "assistant" ? null : [space.id];
  const scoped = scopeFor(app, userId, spaces);
  if (scoped && !scoped.includes(space.id)) throw new HttpError(403, `${userName(app, userId)} 不能访问空间 ${space.id}`);
  // Related spaces: a run limited to its space also reads them (never writes), so work in one
  // repo or project sees what the others it depends on already say.
  const allowed = scopeFor(app, userId, null);
  const related = guest ? [] : relatedSpaces(app, space.id).filter((r) => !allowed || allowed.includes(r.space));
  const readable = scoped ? [...new Set([...scoped, ...related.map((r) => r.space), ...(input.alsoRead ?? []).filter((id) => !allowed || allowed.includes(id))])] : null;
  // Feishu posting: the owner's own runs may post anywhere they are asked to; others only where their thread lives.
  const lark = input.lark ?? { chats: userId === OWNER ? null : [] };
  const token = issueToolToken({ runId: input.runId, spaceId: space.id, spaces: readable, writable: scoped ?? undefined, itemDiscoverySpaces: !spec && roleName === "ingest" ? (input.spaces === undefined ? allowed : scoped) : undefined, tools, actor: "agent", userId, larkChats: lark.chats, larkDraft: !!lark.draft, agentProfile: profile.id, model: profile.model, effort: profile.effort, role: spec ? undefined : roleName, spec: spec?.name, shadow: input.shadow });
  const guide = spaceGuide(app, space.id).trim();
  // A built-in role learns like a spec: its own experience and preferences, its regular skills first.
  const lessons = guest ? "" : learnedContext(app, space.id, userId, spec?.name ?? (roleName === "assistant" ? null : roleName));
  const skills = guest ? "" : spec ? skillIndex(app, spec.skills) : skillIndex(app, undefined, role!.skills);
  const agents = roleName === "assistant" && !spec ? agentIndex(app) : "";
  const body = spec
    ? `# 角色：${spec.description}\n\n${spec.prompt}${spec.instructions ? `\n\n## 工作约定（AGENTS.md）\n\n${spec.instructions}` : ""}`
    : `# 角色：${role!.description}\n\n${role!.body}`;
  const system = [
    commonGuide(),
    body,
    `# 环境\n\n- 现在：${localTime(app)}${userId !== OWNER ? `\n- 这次是在为 ${userName(app, userId)} 工作（不是 omem 的主人），只能使用其有权访问的空间；对话里的“本人”指 ${userName(app, userId)}` : ""}\n- 当前空间：${space.id}（${space.name}，${kindLabel(space.kind)}）${space.rootPath ? `\n- 工作目录是该空间关联的目录：${space.rootPath}` : `\n- 工作目录是该空间的知识库目录（wiki/ 下是页面 Markdown）`}${guide ? `\n\n## 空间说明（SPACE.md）\n\n${guide}` : ""}${related.length ? `\n\n## 相关空间\n\n${relatedGuide(related, !!scoped)}` : ""}${lessons ? `\n\n## 本人的偏好与以往经验（记忆中保存，按需遵循；与本次要求冲突时以本次为准）\n\n${lessons}` : ""}${skills ? `\n\n## 可用技能（做对应的事之前先读全文并照做）\n\n${skills}` : ""}${agents ? `\n\n## 已有的 Agent 档案（可用 run_agent 交给它们）\n\n${agents}` : ""}`,
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
    // Guests never see the owner's memories unasked.
    recall: guest ? null : { spaces: readable, agent: spec?.name ?? (roleName === "assistant" ? null : roleName), userId },
  };
}

/** Whether a failure is worth retrying on a fallback backend/model. */
export function isRetryableAgentError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (isAgentRunError(e)) return e.kind === "queue" || e.kind === "rate-limit" || e.queued === true;
  return /rate.?limit|too many requests|429|capacity|overloaded|busy|try again later|resource.*(exhaust|unavailable)|排队/i.test(e.message);
}

/** Build the ordered profile list for one role run: primary then configured fallbacks. */
export function fallbackProfiles(
  app: App,
  actor: Actor,
  baseId: string,
  thread?: { model?: string | null; effort?: string | null },
): AgentProfile[] {
  const specs = allProfiles(app.config);
  const roleName = "spec" in actor ? null : (actor as { role: RoleName }).role;
  const make = (id: string, modelOverride?: string, effortOverride?: string): AgentProfile | null => {
    const p = specs.find((x) => x.id === id);
    if (!p) return null;
    // Role defaults first; explicit step overrides win over them.
    let out = roleName ? resolveRoleProfile(app, p, roleName) : p;
    out = { ...out, model: modelOverride ?? out.model, effort: effortOverride ?? out.effort };
    if (thread?.model !== undefined || thread?.effort !== undefined)
      out = { ...out, model: thread.model ?? out.model, effort: thread.effort ?? out.effort };
    return out;
  };
  const chain: AgentProfile[] = [];
  const primary = make(baseId);
  if (primary) chain.push(primary);
  for (const f of app.config.agents.fallback ?? []) {
    if (f.profile === baseId && f.model === undefined && f.effort === undefined) continue;
    const p = make(f.profile, f.model, f.effort);
    if (p && !chain.some((x) => x.id === p.id && x.model === p.model && x.effort === p.effort)) chain.push(p);
  }
  return chain;
}

/** Run a role-defined agent turn with omem tools attached. */
export async function runRole(app: App, input: RoleRunInput & { spec?: AgentSpec; userId?: string }): Promise<AgentResult & { profileId: string }> {
  const actor: Actor = input.spec ? { spec: input.spec } : { role: input.role };
  const base = prepareRun(app, { actor, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, runId: input.runId, cwd: input.cwd, profileId: input.profileId, userId: input.userId, model: input.model, effort: input.effort, shadow: input.shadow, denyTools: input.denyTools, lark: input.lark });
  const chain = input.spec || input.shadow
    ? [base.profile] // explicit agent specs choose their own backend; no silent rerouting
    : fallbackProfiles(app, actor, base.profile.id);
  const emit = input.onEvent ?? (() => {});
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const profile = chain[i];
    const prep = i === 0 ? base : prepareRun(app, { actor, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, runId: input.runId, cwd: input.cwd ?? base.cwd, profileId: profile.id, userId: input.userId, model: profile.model ?? undefined, effort: profile.effort ?? undefined, denyTools: input.denyTools, lark: input.lark });
    try {
      const req = {
        cwd: prep.cwd,
        prompt: `${prep.system}\n\n---\n\n# 任务\n\n${input.task}`,
        allowWrites: prep.allowWrites,
        modes: prep.modes,
        signal: input.signal,
        mcp: prep.mcp,
        extraMcp: prep.extraMcp,
        resumeSessionId: input.resumeSessionId,
        persistSession: input.persistSession ?? !!input.resumeSessionId,
        queueTimeoutMs: app.config.agents.queueTimeoutMinutes * 60_000,
      };
      if (i > 0) emit({ type: "status", text: `默认后端不可用（排队/限流），改用 ${profile.name ?? profile.id}${profile.model ? ` · ${profile.model}` : ""} 重试` });
      const result = await runBackend(app, profile, req, emit);
      revokeToolToken(prep.token);
      return { ...result, profileId: profile.id };
    } catch (e) {
      revokeToolToken(prep.token);
      if ((e as Error).message === "CANCELLED" || input.signal?.aborted || !isRetryableAgentError(e) || i === chain.length - 1) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error("没有可用的 Agent");
}
