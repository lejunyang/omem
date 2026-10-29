import { REVIEW_TOOLS } from "./review.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile, type RoleName } from "../core/config.ts";
import { findSpace, kindLabel, relatedSpaces, spaceDir } from "../core/spaces.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { spaceGuide } from "../wiki/store.ts";
import { executionArgs, validateExecution, type Execution } from "./execution.ts";
import { resolveRoleProfile } from "./models.ts";
import { runBackend } from "./dispatch.ts";
import { backgroundTurn } from "./background-sessions.ts";
import { backendAvailable } from "./availability.ts";
import { acquire, choosableProfiles, excluded, loadLines } from "./capacity.ts";
import { catalogEntry, installHint } from "./catalog.ts";
import { issueToolToken, revokeToolToken } from "./tools.ts";
import { isAgentRunError, type AgentEvent, type AgentResult, type McpAccess } from "./types.ts";
import { OWNER, personalSpaceId, scopeFor, userName } from "../core/users.ts";
import { agentIndex, DEFAULT_SPEC_TOOLS, skillIndex, type AgentSpec, type McpServerSpec } from "./specs.ts";
import { expandTools } from "./tool-help.ts";
import { isBuiltinRole, roleOverrideText, rolesDir } from "./builtin-roles.ts";
import { agentToolEnv } from "./tool-cli.ts";
import { embedQuery } from "../search/embeddings.ts";

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
    tools: expandTools(meta.tools ?? []),
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

/**
 * The shared guide, without the sections about tools this run does not have: a section whose heading
 * is followed by `<!-- tools: a b -->` stays when the run has any of them (a coder reads nothing
 * about items, wake-ups or how to write memories).
 */
export function commonGuide(tools: Set<string>) {
  const text = readFileSync(join(rolesDir(), "_common.md"), "utf8").replace(/\r\n/g, "\n");
  return text
    .split(/(?=^## )/m)
    .flatMap((part) => {
      const m = /^(## [^\n]*\n)<!-- tools: ([^>]*?) -->\n/.exec(part);
      if (!m) return [part];
      return m[2].split(/\s+/).some((t) => tools.has(t)) ? [part.replace(m[0], m[1])] : [];
    })
    .join("")
    .trim();
}

export function listAgentProfiles(app: App) {
  return allProfiles(app.config).map((p) => {
    if (p.transport === "doubao") return { ...p, installed: backendAvailable(p, app.home), install: backendAvailable(p, app.home) ? undefined : "omem doubao login（设备码授权，omem doubao status 查权限）" };
    const e = catalogEntry(p.id);
    return { ...p, installed: backendAvailable(p, app.home), install: e && e.command === p.command ? installHint(e) : undefined };
  });
}

export function profileFor(app: App, role: RoleName | string): AgentProfile {
  const profiles = allProfiles(app.config);
  const wanted = app.config.agents.roles[role] ?? app.config.agents.default;
  if (wanted) {
    const p = profiles.find((x) => x.id === wanted);
    if (!p) throw new HttpError(400, `配置的 Agent ${wanted} 不存在`);
    return p;
  }
  const p = profiles.find((p) => backendAvailable(p, app.home));
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
type Lesson = { kind: string; subject: string; content: string; agent: string | null; embedding: Uint8Array | null };

function lessonRows(app: App, spaceId: string, userId: string, spec: string | null, vectors = false) {
  // With review on, only memories the reviewer (or the owner) accepted are handed to every run:
  // a bad lesson repeated in every prompt costs more than a missing one.
  const vetted = app.config.memory.review.enabled ? "and (created_by = 'user' or review_verdict = 'keep')" : "";
  return all<Lesson>(
    app.db,
    // A profile's own experience goes with it whatever space it runs in (an investigator learns from
    // the on-call groups of one project space and is called from the personal space).
    `select kind, subject, content, agent, ${vectors ? "embedding" : "null as embedding"} from memories where status = 'active' ${vetted} and (agent is null or agent = ?) and (
       (kind = 'preference' and space_id in (?, ?) and coalesce(user_id, 'owner') = ?) or (kind = 'experience' and (space_id = ? or agent = ?))
     ) order by kind = 'preference' desc, agent is not null desc, updated_at desc limit 2000`,
    spec ?? "",
    personalSpaceId(userId),
    spaceId,
    userId,
    spaceId,
    spec ?? "",
  );
}

const lessonLines = (rows: Lesson[]) => rows.map((r) => `- ${r.kind === "preference" ? "偏好" : "经验"}${r.agent ? "（本档案）" : ""}${r.subject ? `（${r.subject}）` : ""}：${r.content}`).join("\n");

/** With no task in view (a conversation's standing context): the newest, preferences first. */
function learnedContext(app: App, spaceId: string, userId: string, spec: string | null) {
  return lessonLines(lessonRows(app, spaceId, userId, spec).slice(0, 24));
}

/** Shared preferences and experience a task run is told: the closest to the task, at most this many. */
const TASK_LESSONS = 8;

/**
 * For a task: the profile's or role's own lessons, and of the shared ones only the closest to the task
 * (cosine on memory vectors; the newest without vectors). A coder is not told how the owner swipes
 * back on a phone or how on-call cases were triaged.
 */
async function taskLessons(app: App, spaceId: string, userId: string, spec: string | null, about: string) {
  const rows = lessonRows(app, spaceId, userId, spec, true);
  const own = rows.filter((r) => r.agent).slice(0, 16);
  const shared = rows.filter((r) => !r.agent);
  const q = shared.length > TASK_LESSONS ? await embedQuery(app, about, "query").catch(() => null) : null;
  let near = shared.slice(0, TASK_LESSONS);
  if (q) {
    const score = (e: Uint8Array) => {
      const v = new Float32Array(e.buffer, e.byteOffset, e.byteLength / 4);
      if (v.length !== q.length) return -1;
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      return s;
    };
    near = shared.filter((r) => r.embedding).map((r) => ({ r, s: score(r.embedding!) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, TASK_LESSONS).map((x) => x.r);
  }
  return lessonLines([...own, ...near]);
}

export type RoleRunInput = {
  execution?: Execution;
  role: RoleName;
  spaceId: string;
  /** Spaces this run may touch; defaults to all for the assistant, the space otherwise. */
  spaces?: string[] | null;
  /** Extra spaces the run may read but never write (a delegation's indexed worktree changes). */
  alsoRead?: string[];
  /** Upper bound inherited from the initiating task, including related spaces. */
  readScope?: string[];
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
  /** Reuse a measured, live ACP session for recurring background work. */
  reuseSession?: boolean;
  /** Comparison run: writes are recorded, not applied; no fallback. */
  shadow?: { parentRunId: string | null };
  /** omem tools this run must not have (a consulted agent cannot hand work on). */
  denyTools?: string[];
  /** Feishu chats it may post into (a rule's agent: only the chat that triggered it), and whether it may buzz people or post to some members only. */
  lark?: LarkAccess;
  /** Running as a review check of a delegation: read-only tools plus submit_review, no writes or extra MCP. */
  reviewCheck?: boolean;
  /** Running as review-lead of a delegation round: read-only tools plus rule_review. */
  reviewLead?: boolean;
};

/**
 * Urgent and members-only Feishu messages: a rule's agent when the rule allows them; the owner's own
 * runs that may post anywhere (the owner asks in words; the tool says to use them only then).
 */
function larkPowers(lark: LarkAccess, userId: string) {
  if (lark.chats === null && userId === OWNER) return { urgent: true, private: true };
  return lark.urgent || lark.private ? { urgent: !!lark.urgent, private: !!lark.private } : undefined;
}

/** `bot`: posts go out as that one of lark.bots (a conversation with it), not the main bot. */
export type LarkAccess = { chats: string[] | null; draft?: boolean; urgent?: boolean; private?: boolean; bot?: string };

/** Who is acting: a built-in role, or an agent spec the assistant (or the owner) created. */
export type Actor = { role: RoleName } | { spec: AgentSpec };

export type PreparedRun = {
  profile: AgentProfile;
  cwd: string;
  /**
   * Standing instructions: shared rules, role or spec, environment, learned context. Without the
   * clock, so a session can keep them (as its system prompt) across turns; see `now`.
   */
  system: string;
  /** The current time, said at the start of each turn. */
  now: string;
  token: string;
  mcp: McpAccess;
  extraMcp: Record<string, McpServerSpec>;
  allowWrites: boolean;
  modes: string[];
  label: string;
  /** What passive recall may draw on: readable spaces (null = all) and whose own memories count. */
  recall: { spaces: string[] | null; agent: string | null; userId: string } | null;
};

/** Resolve defaults and one-run overrides without creating a tool token or session. */
export function resolveRunProfile(app: App, input: { actor: Actor; profileId?: string; model?: string; effort?: string }): AgentProfile {
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const roleName = spec ? "assistant" : (input.actor as { role: RoleName }).role;
  const role = !spec;
  const baseProfile = input.profileId
    ? allProfiles(app.config).find((p) => p.id === input.profileId)
    : spec?.agent
      ? allProfiles(app.config).find((p) => p.id === spec.agent)
      : profileFor(app, roleName);
  if (!baseProfile) throw new HttpError(400, `Agent ${input.profileId ?? spec?.agent} 不存在`);
  // Role -> per-profile model/effort overrides apply first; a per-thread override (the
  // /model command or the Feishu model card) wins. Agent specs still set their own model.
  const roleProfile = role ? resolveRoleProfile(app, baseProfile, roleName) : baseProfile;
  // A different backend must not inherit a model belonging to the spec's backend.
  const specBackend = spec ? (spec.agent || profileFor(app, "assistant").id) : undefined;
  const defaults = spec && (!input.profileId || input.profileId === specBackend)
    ? { ...roleProfile, model: spec.model ?? roleProfile.model, effort: spec.effort ?? (spec.model && spec.model !== roleProfile.model ? undefined : roleProfile.effort) }
    : roleProfile;
  const profile: AgentProfile = { ...defaults, model: input.model ?? defaults.model, effort: input.effort ?? defaults.effort };
  // Changing only the model does not carry a model-specific default effort across models.
  if (input.model && input.model !== defaults.model && input.effort === undefined) profile.effort = undefined;
  return profile;
}

/**
 * Resolve backend, working directory, tool token and the standing context for
 * a role or agent spec. The caller owns the token (revoke it when done).
 */
/**
 * What a run runs on (backend, model, effort), shown with the run. The first preparation is its
 * main actor (a coder before its reviewers); falling back to another backend replaces it.
 */
export function recordRunAI(app: App, runId: string | null, profile: AgentProfile, replace: boolean) {
  if (!runId) return;
  const ai = JSON.stringify({ profile: profile.id, model: profile.model ?? undefined, effort: profile.effort ?? undefined });
  run(app.db, replace ? "update runs set ai = ?, profile_id = ? where id = ?" : "update runs set ai = coalesce(ai, ?), profile_id = coalesce(profile_id, ?) where id = ?", ai, profile.id, runId);
}

export function prepareRun(
  app: App,
  input: { actor: Actor; spaceId: string; spaces?: string[] | null; alsoRead?: string[]; readScope?: string[]; runId: string | null; cwd?: string; profileId?: string; userId?: string; model?: string; effort?: string; lark?: LarkAccess; shadow?: { parentRunId: string | null }; denyTools?: string[]; reviewCheck?: boolean; reviewLead?: boolean; lessons?: string },
): PreparedRun {
  const userId = input.userId ?? OWNER;
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const role = spec ? null : loadRole((input.actor as { role: RoleName }).role, app);
  const roleName = role ? (input.actor as { role: RoleName }).role : "assistant";
  const profile = resolveRunProfile(app, input);
  if (!input.shadow) recordRunAI(app, input.runId, profile, false);
  if (role && input.runId && !input.shadow) run(app.db, "update runs set roles = coalesce(roles, '|') || ? || '|' where id = ? and instr(coalesce(roles, ''), ?) = 0", roleName, input.runId, `|${roleName}|`);
  const spaceId = spec?.space && !input.spaceId ? spec.space : input.spaceId;
  const space = findSpace(app, spaceId);
  if (!space) throw new HttpError(404, `空间不存在：${spaceId}`);
  if (!app.baseUrl) throw new Error("omem 服务尚未启动，无法为 Agent 提供工具");
  const cwd = input.cwd ?? spec?.cwd ?? space.rootPath ?? spaceDir(app, space.id);
  const tools = new Set(spec ? (spec.tools.length ? expandTools(spec.tools) : DEFAULT_SPEC_TOOLS) : role!.tools);
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
  if (spec || roleName === "assistant") { tools.add("ask_agent"); tools.add("list_ai_backends"); }
  // …and the owner: a question, or next steps as buttons under the reply. Waiting is for anyone
  // whose tool call is held for approval.
  if (spec || roleName === "assistant") for (const t of ["ask_owner", "suggest_next"]) tools.add(t);
  // Working files: where a long task keeps its current results and a scheduled rule its report.
  if (spec || roleName === "assistant") tools.add("write_file");
  // Wake-ups for its own follow-up work (after a while, or on a message in a chat).
  if (spec || roleName === "assistant") for (const t of ["wake_later", "wake_on_message", "cancel_wake"]) tools.add(t);
  if (!guest) tools.add("wait_answer");
  // A thread that may post into specific Feishu chats (watched groups) gets the bot's voice and notify.
  if (input.lark?.chats?.length) for (const t of ["lark_send", "lark_react", "lark_card", "lark_update_card", "lark_send_file", "notify"]) tools.add(t);
  for (const t of input.denyTools ?? []) tools.delete(t);
  // A review check only reads and reports, whatever its profile may do elsewhere.
  if (input.reviewCheck || input.reviewLead) {
    for (const t of [...tools]) if (!REVIEW_TOOLS.includes(t) && t !== "wait_answer") tools.delete(t);
    tools.add(input.reviewLead ? "rule_review" : "submit_review");
    if (input.reviewCheck) tools.add("submit_change_points");
  }
  const spaces =
    input.spaces !== undefined ? input.spaces : spec ? (spec.spaces.includes("*") ? null : [...new Set([space.id, ...spec.spaces])]) : roleName === "assistant" ? null : [space.id];
  const scoped = scopeFor(app, userId, spaces)?.filter(id => !input.readScope || input.readScope.includes(id)) ?? (input.readScope ?? null);
  if (scoped && !scoped.includes(space.id)) throw new HttpError(403, `${userName(app, userId)} 不能访问空间 ${space.id}`);
  // Related spaces: a run limited to its space also reads them (never writes), so work in one
  // repo or project sees what the others it depends on already say.
  const allowed = scopeFor(app, userId, input.readScope ?? null);
  const related = guest ? [] : relatedSpaces(app, space.id).filter((r) => !allowed || allowed.includes(r.space));
  const readable = scoped ? [...new Set([...scoped, ...related.map((r) => r.space), ...(input.alsoRead ?? []).filter((id) => !allowed || allowed.includes(id))])] : null;
  // Feishu posting: the owner's own runs may post anywhere they are asked to; others only where their thread lives.
  const lark = input.lark ?? { chats: userId === OWNER ? null : [] };
  const token = issueToolToken({ runId: input.runId, spaceId: space.id, spaces: readable, writable: scoped ?? undefined, itemDiscoverySpaces: !spec && roleName === "ingest" ? (input.spaces === undefined ? allowed : scoped) : undefined, tools, actor: "agent", userId, larkChats: lark.chats, larkDraft: !!lark.draft, larkPowers: larkPowers(lark, userId), larkBot: lark.bot, agentProfile: profile.id, model: profile.model, effort: profile.effort, role: spec ? undefined : roleName, spec: spec?.name, plugin: spec?.plugin, shadow: input.shadow });
  const guide = spaceGuide(app, space.id).trim();
  // A built-in role learns like a spec: its own experience and preferences, its regular skills first.
  const lessons = guest ? "" : input.lessons ?? learnedContext(app, space.id, userId, spec?.name ?? (roleName === "assistant" ? null : roleName));
  const skills = guest ? "" : skillIndex(app, spec ? spec.skills : roleName === "assistant" ? undefined : role!.skills);
  const agents = roleName === "assistant" && !spec ? agentIndex(app) : "";
  const routing = !guest && DELEGATING.some((t) => tools.has(t)) ? routingGuide(app, profile) : "";
  const body = spec
    ? `# 角色：${spec.description}\n\n${spec.prompt}${spec.instructions ? `\n\n## 工作约定（AGENTS.md）\n\n${spec.instructions}` : ""}`
    : `# 角色：${role!.description}\n\n${role!.body}`;
  const system = [
    commonGuide(tools),
    body,
    `# 环境\n\n${userId !== OWNER ? `- 这次是在为 ${userName(app, userId)} 工作（不是 omem 的主人），只能使用其有权访问的空间；对话里的“本人”指 ${userName(app, userId)}\n` : ""}- 当前空间：${space.id}（${space.name}，${kindLabel(space.kind)}）${space.rootPath ? `\n- 工作目录是该空间关联的目录：${space.rootPath}` : `\n- 工作目录是该空间的知识库目录（wiki/ 下是页面 Markdown）`}${guide ? `\n\n## 空间说明（SPACE.md）\n\n${guide}` : ""}${related.length ? `\n\n## 相关空间\n\n${relatedGuide(related, !!scoped)}` : ""}${lessons ? `\n\n## 本人的偏好与以往经验（记忆中保存，按需遵循；与本次要求冲突时以本次为准）\n\n${lessons}` : ""}${skills ? `\n\n## 可用技能（做对应的事之前先读全文并照做）\n\n${skills}` : ""}${agents ? `\n\n## 已有的 Agent 档案（可用 run_agent 交给它们）\n\n${agents}` : ""}${routing ? `\n\n## 任务选型（交办时用 execution 选择）\n\n${routing}` : ""}`,
  ].join("\n\n---\n\n");
  return {
    profile,
    cwd,
    system,
    now: `现在：${localTime(app)}`,
    token,
    mcp: { url: `${app.baseUrl}/mcp`, baseUrl: app.baseUrl, token, stdio: mcpBridge(), env: agentToolEnv(app.home, app.baseUrl, token) },
    extraMcp: input.reviewCheck || input.reviewLead ? {} : spec?.mcp ?? {},
    allowWrites: input.reviewCheck || input.reviewLead ? false : spec ? spec.writes : role!.writes,
    modes: input.reviewCheck || input.reviewLead ? ["read-only", "default", "plan"] : spec ? (spec.writes ? ["acceptEdits", "default"] : ["read-only", "default", "plan"]) : role!.modes,
    label: spec ? spec.name : roleName,
    // Guests never see the owner's memories unasked.
    recall: guest ? null : { spaces: readable, agent: spec?.name ?? (roleName === "assistant" ? null : roleName), userId },
  };
}

/** Tools that hand work to another run and accept an `execution` choice. */
const DELEGATING = ["run_agent", "continue_agent_work", "ask_agent", "delegate_code", "review_branch", "continue_code_run", "generate_wiki"];
/**
 * The owner's routing candidates, for a run that delegates. Without them in view the assistant
 * never looked them up (list_ai_backends) and every delegation used the profile default.
 */
function routingGuide(app: App, profile: AgentProfile) {
  const r = app.config.agents.routing;
  if (!r.automatic) return "";
  const ai = (c: { profile: string; model?: string; effort?: string }) => [c.profile, c.model, c.effort].filter(Boolean).join(" / ");
  const choosable = choosableProfiles(app);
  // The models worth a look: the owner's candidates, each backend's default and the models roles use.
  const models: { profile: AgentProfile; model?: string }[] = [];
  const add = (id: string, model?: string) => { const p = choosable.find((x) => x.id === id); if (p) models.push({ profile: p, model }); };
  for (const c of r.candidates) add(c.profile, c.model);
  for (const p of choosable) if (p.transport !== "doubao") add(p.id, p.model);
  for (const byProfile of Object.values(app.config.agents.roleModels)) for (const [id, m] of Object.entries(byProfile)) add(id, m.model);
  const load = loadLines(app, models).slice(0, 16);
  const doubao = choosable.some((p) => p.transport === "doubao");
  return [
    `你这次用的是 ${ai({ profile: profile.id, model: profile.model, effort: profile.effort })}；交办出去的运行不带 execution 时用对方档案的设置。`,
    ...(r.guidance.trim() ? [`本人的总体偏好：${r.guidance.trim()}`] : []),
    ...(r.candidates.length ? ["本人列出的候选：", ...r.candidates.map((c) => `- ${ai(c)}：${c.when}`)] : []),
    ...(load.length ? ["各模型现在的占用（正在用/上限）和近况；同样合适时选空闲、失败少的，满了的会排队：", ...load] : []),
    ...(doubao ? ["doubao（豆包 OpenAPI）在云端运行，用不了 omem 的工具：只适合纯调研、写作。交给它时先自己把要用的材料取出来，原文一次性写进任务。"] : []),
  ].join("\n");
}

/**
 * The role's other backends the owner configured a model for (roleModels), for when its default
 * model is full. CLI fallbacks of an installed ACP agent are left out (same account).
 */
function roleAlternatives(app: App, role: RoleName, base: AgentProfile): AgentProfile[] {
  const own = app.config.agents.roleModels[role] ?? {};
  return choosableProfiles(app).filter((p) => p.id !== base.id && own[p.id]).map((p) => resolveRoleProfile(app, p, role));
}
function distinctProfiles(list: AgentProfile[]) {
  return list.filter((p, i) => list.findIndex((q) => q.id === p.id && q.model === p.model && q.effort === p.effort) === i);
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
    if (p && !excluded(app, p) && !chain.some((x) => x.id === p.id && x.model === p.model && x.effort === p.effort)) chain.push(p);
  }
  return chain;
}

/** Run a role-defined agent turn with omem tools attached. */
/**
 * A model swapped in for one run (generate_wiki's execution, switch_run_ai), kept as the run's
 * input.ai. Coding and review runs choose per role (coder / reviewer) instead.
 */
function runAI(app: App, runId: string | null): Execution | undefined {
  if (!runId) return undefined;
  const r = one<{ kind: string; input: string }>(app.db, "select kind, input from runs where id = ?", runId);
  if (!r || r.kind === "code" || r.kind === "review") return undefined;
  return (JSON.parse(r.input || "{}") as { ai?: Execution }).ai;
}

export async function runRole(app: App, input: RoleRunInput & { spec?: AgentSpec; userId?: string }): Promise<AgentResult & { profileId: string; ai: { profile: string; model?: string; effort?: string } }> {
  const execution = validateExecution(app, input.execution ?? runAI(app, input.runId));
  input = { ...input, ...executionArgs(execution) };
  const actor: Actor = input.spec ? { spec: input.spec } : { role: input.role };
  // The lessons that bear on this task (a conversation gets the newest instead, see prepareRun).
  const lessons = input.role === "guest" && !input.spec ? "" : await taskLessons(app, input.spec?.space && !input.spaceId ? input.spec.space : input.spaceId, input.userId ?? OWNER, input.spec?.name ?? (input.role === "assistant" ? null : input.role), `${input.spec?.description ?? loadRole(input.role, app).description}
${input.task}`);
  const base = prepareRun(app, { actor, lessons, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, readScope: input.readScope, runId: input.runId, cwd: input.cwd, profileId: input.profileId, userId: input.userId, model: input.model, effort: input.effort, shadow: input.shadow, denyTools: input.denyTools, lark: input.lark, reviewCheck: input.reviewCheck, reviewLead: input.reviewLead });
  if (execution) {
    try { validateExecution(app, { ...execution, model: base.profile.model, effort: base.profile.effort }); }
    catch (e) { revokeToolToken(base.token); throw e; }
  }
  // Explicit agent specs choose their own backend; no silent rerouting. A role run may move to its
  // other configured backends when its model is full, and to the fallbacks on a queue / rate limit.
  const chain = input.spec || input.shadow || execution
    ? [base.profile]
    : distinctProfiles([base.profile, ...roleAlternatives(app, input.role, base.profile), ...fallbackProfiles(app, actor, base.profile.id).slice(1)]);
  const emit = input.onEvent ?? (() => {});
  let lastError: unknown;
  let failed = false;
  for (let i = 0; i < chain.length; i++) {
    let slot;
    try {
      slot = await acquire(app, chain.slice(i), { runId: input.runId, signal: input.signal, onWait: (text) => emit({ type: "status", text }) });
    } catch (e) {
      if (i === 0) revokeToolToken(base.token);
      throw e;
    }
    if (i === 0 && slot.index > 0) revokeToolToken(base.token);
    const moved = slot.index > 0;
    i += slot.index;
    const profile = chain[i];
    const prep = i === 0 ? base : prepareRun(app, { actor, lessons, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, readScope: input.readScope, runId: input.runId, cwd: input.cwd ?? base.cwd, profileId: profile.id, userId: input.userId, model: profile.model ?? undefined, effort: profile.effort ?? undefined, denyTools: input.denyTools, lark: input.lark, reviewCheck: input.reviewCheck, reviewLead: input.reviewLead });
    if (i > 0 && !input.shadow) recordRunAI(app, input.runId, prep.profile, true);
    try {
      const req = {
        strictSelection: execution ? { model: !!execution.model, effort: !!execution.effort } : undefined,
        cwd: prep.cwd,
        // The instructions go once per session (see withInstructions); a resumed session gets the task alone.
        system: prep.system,
        prompt: `（${prep.now}）\n\n# 任务\n\n${input.task}`,
        allowWrites: prep.allowWrites,
        modes: prep.modes,
        signal: input.signal,
        mcp: prep.mcp,
        extraMcp: prep.extraMcp,
        resumeSessionId: i === 0 ? input.resumeSessionId : undefined,
        persistSession: input.persistSession ?? !!input.resumeSessionId,
        queueTimeoutMs: app.config.agents.queueTimeoutMinutes * 60_000,
      };
      if (i > 0) emit({ type: "status", text: `${failed && !moved ? "默认后端不可用（排队/限流）" : failed ? "重试时原来的模型已满" : "默认模型已满"}，改用 ${profile.name ?? profile.id}${profile.model ? ` · ${profile.model}` : ""}` });
      emit({ type: "status", text: `使用 AI：${profile.id} · ${profile.model ?? "默认模型"} · ${profile.effort ?? "默认强度"}${execution ? `（${execution.source === "user" ? "本人指定" : "任务选型"}：${execution.reason}）` : ""}` });
      const result = input.reuseSession && !input.shadow && !input.persistSession && !input.resumeSessionId && prep.profile.transport === "acp"
        ? await backgroundTurn(app, prep, req, input.task, input.runId, emit)
        : await runBackend(app, prep.profile, req, emit);
      revokeToolToken(prep.token);
      return { ...result, profileId: prep.profile.id, ai: { profile: prep.profile.id, model: prep.profile.model, effort: prep.profile.effort } };
    } catch (e) {
      revokeToolToken(prep.token);
      if ((e as Error).message === "CANCELLED" || input.signal?.aborted || !isRetryableAgentError(e) || i === chain.length - 1) throw e;
      lastError = e;
      failed = true;
    } finally {
      slot.release();
    }
  }
  throw lastError ?? new Error("没有可用的 Agent");
}
