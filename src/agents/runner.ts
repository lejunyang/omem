import { REVIEW_TOOLS } from "./review.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile, type RoleName } from "../core/config.ts";
import { findSpace, kindLabel, relatedSpaces, spaceDir } from "../core/spaces.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json } from "../core/util.ts";
import { spaceGuide } from "../wiki/store.ts";
import { executionArgs, validateExecution, type Execution } from "./execution.ts";
import { resolveRoleProfile } from "./models.ts";
import { runBackend } from "./dispatch.ts";
import { backgroundTurn } from "./background-sessions.ts";
import { backendAvailable } from "./availability.ts";
import { acquire, choosableProfiles, clearDown, dailyCapReached, downReason, excluded, isModelQuotaMessage, isQuotaMessage, markOutOfQuota, noteFailure, outOfQuotaUntil } from "./capacity.ts";
import { aiLabel, candidateProfiles, choiceEvent, chooseAI, fallbackOrder, ORDER_LABEL, type ChooseResult, type ChooseScene, type OrderSource } from "./choose-ai.ts";
import { quotaAvoid } from "./quota.ts";
import { catalogEntry, installHint } from "./catalog.ts";
import { DOUBAO_CLI_INSTALL } from "./doubao-cli.ts";
import { dropUnavailable, issueToolToken, revokeToolToken } from "./tools.ts";
import { isAgentRunError, type AgentEvent, type AgentResult, type InstructionParts, type McpAccess } from "./types.ts";
import { OWNER, personalSpaceId, scopeFor, userName } from "../core/users.ts";
import { trimTools } from "../auth/tools.ts";
import { agentIndex, DEFAULT_SPEC_TOOLS, skillIndex, spaceSkillsText, type AgentSpec, type McpServerSpec } from "./specs.ts";
import { expandTools } from "./tool-help.ts";
import { applyOverlay, GUEST_ROLES, isBuiltinRole, overlayEmpty, roleOverlay, roleOverrideText, rolesDir, type RoleOverlay } from "./builtin-roles.ts";
import { agentToolEnv } from "./tool-cli.ts";
import { commandGateDir } from "./command-gate.ts";
import { embedQuery } from "../search/embeddings.ts";
import { asOfContent, memoryWhere, type RunView } from "./replay-view.ts";
import { categoryStatus } from "../core/ai-keys.ts";

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

function parseRole(name: string, raw: string, customized: boolean, overlay?: RoleOverlay): Role {
  // Windows checkouts may have CRLF line endings.
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = (m ? YAML.parse(m[1]) : {}) as Partial<Role>;
  return {
    name,
    description: meta.description ?? "",
    tools: expandTools(overlay ? applyOverlay(meta.tools ?? [], overlay.tools) : (meta.tools ?? [])),
    writes: !!meta.writes,
    modes: meta.modes ?? [],
    skills: overlay ? applyOverlay(meta.skills ?? [], overlay.skills) : (meta.skills ?? []),
    body: m ? text.slice(m[0].length) : text,
    customized,
  };
}

const roleCache = new Map<string, Role>();
/** A built-in role: the owner's customized copy in the library when there is one, else the package's. */
export function loadRole(name: string, app?: App): Role {
  const own = app && isBuiltinRole(name) ? roleOverrideText(app, name) : null;
  // Skills and tools the owner added on top, whichever version is in use (builtin-roles.ts).
  const overlay = app && isBuiltinRole(name) ? roleOverlay(app, name) : undefined;
  const adjusted = !!overlay && !overlayEmpty(overlay);
  if (own !== null) {
    try {
      return parseRole(name, own, true, overlay);
    } catch (e) {
      console.warn(`[omem] 自定义角色 ${name} 无法解析，改用源码版本：${(e as Error).message}`);
    }
  }
  const cached = roleCache.get(name);
  if (cached && !adjusted && process.env.NODE_ENV === "production") return cached;
  const file = join(rolesDir(), `${name}.md`);
  if (!existsSync(file)) throw new HttpError(400, `未知角色：${name}`);
  if (adjusted) return parseRole(name, readFileSync(file, "utf8"), false, overlay);
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
  return toolSections(readFileSync(join(rolesDir(), "_common.md"), "utf8"), tools);
}

/** A guide without its sections about tools this run does not have (roles may have such sections too). */
export function toolSections(text: string, tools: Set<string>) {
  return text
    .replace(/\r\n/g, "\n")
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
    if (p.transport === "doubao-cli") return { ...p, installed: backendAvailable(p, app.home), install: backendAvailable(p, app.home) ? undefined : DOUBAO_CLI_INSTALL };
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

export function mcpBridge(): { command: string; args: string[] } {
  const ts = resolve(here, "../mcp-bridge.ts");
  const js = resolve(here, "../mcp-bridge.js");
  return { command: process.execPath, args: [existsSync(js) ? js : ts] };
}

function localTime(app: App, at?: string) {
  const now = at ? new Date(at) : new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", { timeZone: app.config.timezone, dateStyle: "full", timeStyle: "short" });
  return `${fmt.format(now)}（时区 ${app.config.timezone}，ISO ${now.toISOString()}）`;
}

/**
 * Self-improvement loop: preferences the owner stated and lessons distilled by
 * the dreamer (experience memories) are handed to every future run.
 */
type Lesson = { kind: string; subject: string; content: string; agent: string | null; embedding: Uint8Array | null };

function lessonRows(app: App, spaceId: string, userId: string, spec: string | null, vectors = false, view?: RunView) {
  // With review on, only memories the reviewer (or the owner) accepted are handed to every run:
  // a bad lesson repeated in every prompt costs more than a missing one.
  const vetted = app.config.memory.review.enabled ? "and (created_by = 'user' or review_verdict = 'keep')" : "";
  // A replay arm: the lessons as they stood at the question's time, minus what its variant leaves out.
  const w = memoryWhere(view, "memories");
  return all<Lesson & { id: string }>(
    app.db,
    // A profile's own experience goes with it whatever space it runs in (an investigator learns from
    // the on-call groups of one project space and is called from the personal space).
    `select id, kind, subject, content, agent, ${vectors ? "embedding" : "null as embedding"} from memories where ${view ? w.sql : "status = 'active'"} ${vetted} and (agent is null or agent = ?) and (
       (kind = 'preference' and space_id in (?, ?) and coalesce(user_id, 'owner') = ?) or (kind = 'experience' and (space_id = ? or agent = ?))
     ) order by kind = 'preference' desc, agent is not null desc, updated_at desc limit 2000`,
    ...(view ? w.params : []),
    spec ?? "",
    personalSpaceId(userId),
    spaceId,
    userId,
    spaceId,
    spec ?? "",
  ).map((r) => ({ ...r, content: asOfContent(view, r.content) }));
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
async function taskLessons(app: App, spaceId: string, userId: string, spec: string | null, about: string, view?: RunView) {
  const rows = lessonRows(app, spaceId, userId, spec, true, view);
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

/** The ids of the lessons a task run is told (a replay records what the original run had in view). */
export async function lessonIdsForTask(app: App, input: { role: RoleName; spec?: AgentSpec; spaceId: string; userId?: string; task: string; replay?: ReplayArm }) {
  const text = await lessonsForTask(app, input);
  const rows = lessonRows(app, input.spec?.space && !input.spaceId ? input.spec.space : input.spaceId, input.userId ?? OWNER, input.spec?.name ?? (input.role === "assistant" ? null : input.role), false, input.replay?.view);
  return rows.filter((r) => text.includes(r.content)).map((r) => r.id);
}

/** The lessons that bear on a task run (a conversation gets the newest instead, see prepareRun). */
export async function lessonsForTask(app: App, input: { role: RoleName; spec?: AgentSpec; spaceId: string; userId?: string; task: string; replay?: ReplayArm }) {
  if (input.role === "guest" && !input.spec) return "";
  return taskLessons(app, input.spec?.space && !input.spaceId ? input.spec.space : input.spaceId, input.userId ?? OWNER, input.spec?.name ?? (input.role === "assistant" ? null : input.role), `${input.spec?.description ?? loadRole(input.role, app).description}
${input.task}`, input.replay?.view);
}

export type RoleRunInput = {
  execution?: Execution;
  /** Which choice setting applies when nothing pins the AI (choose-ai.ts): a rule's run, or any other task (the default). */
  choose?: ChooseScene;
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
  /** 完全访问 decided for this run (a rule's switch, the guest setting); undefined = the profile's or role's own (prepareRun). */
  fullAccess?: boolean;
  /** Feishu chats it may post into (a rule's agent: only the chat that triggered it), and whether it may buzz people or post to some members only. */
  lark?: LarkAccess;
  /** Running as a review check of a delegation: read-only tools plus submit_review, no writes or extra MCP. */
  reviewCheck?: boolean;
  /** The check's name when it is not the role's or spec's own: a second look by another model (`<check>@复看`, code-overlap.ts). */
  checkName?: string;
  /** Hand-in tools this run gets on top of its role's (and after a review run is cut to read-only): a task-driven delegation's plan_tasks, verify_tasks… */
  addTools?: string[];
  /** Running as review-lead of a delegation round: read-only tools plus rule_review. */
  reviewLead?: boolean;
  /** A replay arm (agents/replay.ts): what it sees and the only tools it gets. */
  replay?: ReplayArm;
  /**
   * Hands in artifacts (agents/artifacts.ts): the agent's commands get OMEM_ARTIFACTS, a folder
   * whose contents become the run's artifacts when its turn ends (or a task is finished).
   */
  artifacts?: boolean;
};

/**
 * A replay arm: it answers a past question as of its time (`view`), with only these read-only tools,
 * the backend in read-only mode, only the extra MCP servers marked `readOnly`, and the clock set to
 * the question's time.
 */
export type ReplayArm = { view: RunView; tools: string[] };

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
  /** What `system` is made of, reported with each turn for the run page. */
  parts: InstructionParts;
  token: string;
  mcp: McpAccess;
  extraMcp: Record<string, McpServerSpec>;
  allowWrites: boolean;
  modes: string[];
  /** Commands outside the backend's sandbox, no approvals (see prepareRun). */
  fullAccess: boolean;
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

/**
 * The repositories a coding run works in: a round's own (`repos`, or the worktrees it made), else
 * those of the round it continues, helps (`helperOf`) or reviews (`codeRunId`).
 */
function workRepos(app: App, runId: string | null): string[] {
  let id = runId;
  for (let i = 0; id && i < 8; i++) {
    const r = one<{ input: string; output: string }>(app.db, "select input, output from runs where id = ?", id);
    if (!r) break;
    const inp = json<Record<string, unknown>>(r.input, {});
    const out = json<Record<string, unknown>>(r.output, {});
    if (Array.isArray(inp.repos) && inp.repos.length) return inp.repos.filter((x): x is string => typeof x === "string");
    if (Array.isArray(out.worktrees) && out.worktrees.length) return [...new Set((out.worktrees as { space?: string }[]).flatMap((w) => (w.space ? [w.space] : [])))];
    const next = inp.codeRunId ?? inp.helperOf ?? inp.continueFrom;
    id = typeof next === "string" ? next : null;
  }
  return [];
}

export function prepareRun(
  app: App,
  input: { actor: Actor; spaceId: string; spaces?: string[] | null; alsoRead?: string[]; readScope?: string[]; runId: string | null; cwd?: string; profileId?: string; userId?: string; model?: string; effort?: string; lark?: LarkAccess; shadow?: { parentRunId: string | null }; denyTools?: string[]; reviewCheck?: boolean; checkName?: string; reviewLead?: boolean; addTools?: string[]; lessons?: string; replay?: ReplayArm; fullAccess?: boolean },
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
  if (spec || roleName === "assistant") for (const t of ["ask_user", "suggest_next"]) tools.add(t);
  // Working files: where a long task keeps its current results and a scheduled rule its report.
  if (spec || roleName === "assistant") tools.add("write_file");
  // Wake-ups for its own follow-up work (after a while, or on a message in a chat).
  if (spec || roleName === "assistant") for (const t of ["wake_later", "wake_on_message", "cancel_wake"]) tools.add(t);
  if (!guest) tools.add("wait_answer");
  // A thread that may post into specific Feishu chats (watched groups) gets the bot's voice and notify.
  if (input.lark?.chats?.length) for (const t of ["lark_send", "lark_react", "lark_card", "lark_update_card", "lark_send_file", "notify"]) tools.add(t);
  for (const t of input.denyTools ?? []) tools.delete(t);
  // Tools that need a model configured in settings → AI exist only once it is (generate_image).
  if (tools.has("generate_image") && !categoryStatus(app.config, "image", app.home).ready) tools.delete("generate_image");
  // A review check only reads and reports, whatever its profile may do elsewhere.
  if (input.reviewCheck || input.reviewLead) {
    for (const t of [...tools]) if (!REVIEW_TOOLS.includes(t) && t !== "wait_answer") tools.delete(t);
    tools.add(input.reviewLead ? "rule_review" : "submit_review");
    if (input.reviewCheck) tools.add("submit_change_points");
  }
  for (const t of input.addTools ?? []) tools.add(t);
  // A replay arm reads and nothing else, whatever its role or profile may do elsewhere.
  if (input.replay) for (const t of [...tools]) if (!input.replay.tools.includes(t)) tools.delete(t);
  // Not what the person it works for may not do (src/auth/tools.ts), nor what needs something they lack.
  trimTools(app, userId, tools);
  dropUnavailable(app, userId, tools);
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
  const token = issueToolToken({ runId: input.runId, spaceId: space.id, spaces: readable, writable: scoped ?? undefined, itemDiscoverySpaces: !spec && roleName === "ingest" ? (input.spaces === undefined ? allowed : scoped) : undefined, tools, actor: "agent", userId, larkChats: lark.chats, larkDraft: !!lark.draft, larkPowers: larkPowers(lark, userId), larkBot: lark.bot, agentProfile: profile.id, model: profile.model, effort: profile.effort, role: spec ? undefined : roleName, spec: spec?.name, ...(input.checkName ? { check: input.checkName } : {}), plugin: spec?.plugin, shadow: input.shadow, view: input.replay?.view });
  const guide = spaceGuide(app, space.id).trim();
  // A coding run (a round, its reviews and helpers) also gets what its repositories say about themselves.
  const repos = guest ? [] : workRepos(app, input.runId).filter((id) => id !== space.id).flatMap((id) => findSpace(app, id) ?? []);
  const repoGuides = repos.map((r) => ({ r, text: spaceGuide(app, r.id).trim() })).filter((g) => g.text).map((g) => `## 仓库 ${g.r.name}（${g.r.id}）的说明（SPACE.md）\n\n${g.text}`).join("\n\n");
  // Skills mounted on the space, the business it belongs to and the repositories it works in.
  const parent = space.parentId ? findSpace(app, space.parentId) : null;
  const mounted = guest ? { text: "", names: [] as string[] } : spaceSkillsText(app, [space, ...(parent ? [parent] : []), ...repos]);
  // A built-in role learns like a spec: its own experience and preferences, its regular skills first.
  const lessons = guest ? "" : input.lessons ?? learnedContext(app, space.id, userId, spec?.name ?? (roleName === "assistant" ? null : roleName));
  const skills = guest ? "" : skillIndex(app, spec ? spec.skills : roleName === "assistant" ? undefined : role!.skills, mounted.names);
  // Only what this run can do with them: an assistant run by a rule may consult but not hand work over.
  const agentUse = tools.has("run_agent") ? "可用 run_agent 交给它们" : tools.has("ask_agent") ? "这次运行不能交办，需要它们的专长时用 ask_agent 请教" : "";
  const agents = roleName === "assistant" && !spec && agentUse ? agentIndex(app) : "";
  const routing = !guest && DELEGATING.some((t) => tools.has(t)) ? routingGuide(app, profile) : "";
  const body = spec
    ? `# 角色：${spec.description}\n\n${spec.prompt}${spec.instructions ? `\n\n## 工作约定（AGENTS.md）\n\n${spec.instructions}` : ""}`
    : `# 角色：${role!.description}\n\n${toolSections(role!.body, tools)}`;
  const common = commonGuide(tools);
  const environment = `# 环境\n\n${userId !== OWNER ? `- 这次是在为 ${userName(app, userId)} 工作（不是 omem 的主人），只能使用其有权访问的空间；对话里的“本人”指 ${userName(app, userId)}\n` : ""}- 当前空间：${space.id}（${space.name}，${kindLabel(space.kind)}）${space.rootPath ? `\n- 工作目录是该空间关联的目录：${space.rootPath}` : `\n- 工作目录是该空间的知识库目录（wiki/ 下是页面 Markdown）`}${guide ? `\n\n## 空间说明（SPACE.md）\n\n${guide}` : ""}${repoGuides ? `\n\n${repoGuides}` : ""}${related.length ? `\n\n## 相关空间\n\n${relatedGuide(related, !!scoped)}` : ""}${lessons ? `\n\n## 本人的偏好与以往经验（记忆中保存，按需遵循；与本次要求冲突时以本次为准）\n\n${lessons}` : ""}${mounted.text ? `\n\n## 这个空间和仓库的技能（这里的做法，做对应的事之前先读全文并照做）\n\n${mounted.text}` : ""}${skills ? `\n\n## 可用技能（做对应的事之前先读全文并照做）\n\n${skills}` : ""}${agents ? `\n\n## 已有的 Agent 档案（${agentUse}）\n\n${agents}` : ""}${routing ? `\n\n## 任务选型（交办时用 execution 选择）\n\n${routing}` : ""}`;
  const system = [common, body, environment].join("\n\n---\n\n");
  const readOnly = !!(input.reviewCheck || input.reviewLead || input.replay);
  // 完全访问: a run's own setting (a rule's switch, or the guest setting for a turn answering a guest) wins;
  // otherwise the profile's or the built-in role's, for the owner's own runs only. Checks, replays and comparisons never.
  const ownDefault = userId === OWNER && (spec ? spec.fullAccess : !GUEST_ROLES.includes(roleName) && !!roleOverlay(app, roleName).fullAccess);
  const fullAccess = !readOnly && !input.shadow && (input.fullAccess ?? ownDefault);
  return {
    profile,
    cwd,
    system,
    // A replay arm answers as of the question's time.
    now: `现在：${localTime(app, input.replay?.view.asOf)}`,
    parts: { common: common.length, role: body.length, environment: environment.length - lessons.length - skills.length - mounted.text.length, lessons: lessons.length, lessonCount: lessons ? lessons.split("\n").length : 0, skills: skills.length + mounted.text.length },
    token,
    mcp: { url: `${app.baseUrl}/mcp`, baseUrl: app.baseUrl, token, stdio: mcpBridge(), env: { ...agentToolEnv(app.home, app.baseUrl, token, commandGateDir(app)),...(guest || input.replay ? { OMEM_DESKTOP_TOOLS: "off" } : {}) } },
    extraMcp: input.reviewCheck || input.reviewLead ? {} : extraMcpFor(spec?.mcp ?? {}, !!input.replay),
    allowWrites: readOnly ? false : spec ? spec.writes : role!.writes,
    fullAccess,
    modes: readOnly ? ["read-only", "default", "plan"] : spec ? (spec.writes ? ["acceptEdits", "default"] : ["read-only", "default", "plan"]) : role!.modes,
    label: spec ? spec.name : roleName,
    // Guests never see the owner's memories unasked.
    recall: guest ? null : { spaces: readable, agent: spec?.name ?? (roleName === "assistant" ? null : roleName), userId },
  };
}

/**
 * A profile's extra MCP servers as the backend gets them (without omem's own `readOnly` mark); a
 * replay arm only gets those marked `readOnly: true` (a research profile's search, never one that writes).
 */
function extraMcpFor(mcp: Record<string, McpServerSpec>, onlyReadOnly: boolean): Record<string, McpServerSpec> {
  return Object.fromEntries(
    Object.entries(mcp)
      .filter(([, s]) => !onlyReadOnly || s.readOnly === true)
      .map(([name, s]) => {
        const { readOnly: _, ...rest } = s;
        return [name, rest as McpServerSpec];
      }),
  );
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
  const doubao = choosableProfiles(app).some((p) => p.transport === "doubao");
  // What changes during a session (load, the time) is not written here: these instructions are sent
  // once per session. The time opens every turn; the load comes from list_ai_backends.
  return [
    `你这次用的是 ${ai({ profile: profile.id, model: profile.model, effort: profile.effort })}；交办出去的运行不带 execution 时用对方档案的设置。`,
    ...(r.guidance.trim() ? [`本人的总体偏好：${r.guidance.trim()}`] : []),
    ...(r.candidates.length ? ["本人列出的候选：", ...r.candidates.map((c) => `- ${ai(c)}：${c.when}`)] : []),
    "偏好和候选里写了时段的（峰谷价格、排队高峰、某段时间不用），按每轮消息开头的现在时间对照着选。",
    "交办前用 list_ai_backends 看各模型现在的占用（正在用/上限）和近 7 天的完成、失败：同样合适时选空闲、失败少的，满了的会排队。",
    "它的 quota 是账号的套餐额度（各窗口已用百分比、多久后重置、周额度每天还能用多少）：标了 avoid 的账号快用完了，同样合适时选别的；本人偏好里写了额度条件的，按这些数字对照。",
    ...(one(app.db, "select 1 from replays where verdict in ('win','loss','tie') and axis in ('A1','A2') limit 1") ? ["其中的 replay28d 是夜间复盘的单变量对比（同一题只换模型），样本小，只作参考。"] : []),
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
export function distinctProfiles(list: AgentProfile[]) {
  return list.filter((p, i) => list.findIndex((q) => q.id === p.id && q.model === p.model && q.effort === p.effort) === i);
}

/**
 * The backend itself broke down (its process died, the connection dropped, it went silent past the
 * idle watchdog, the command is missing): another backend should take over, and this one is set
 * aside for a while (capacity.ts markDown).
 */
export function isBackendDown(e: unknown): boolean {
  return breakdownKind(e) !== null;
}

/**
 * The provider's side broke off the model's answer (the stream was cut, came back empty, was reset):
 * the backend process is fine and another try, or another backend, usually works.
 */
export function isTransientUpstream(e: unknown): boolean {
  return e instanceof Error && /stream disconnected|empty (llm )?(response|stream)|llm response empty|RST_STREAM|stream (was )?(terminated|closed|reset)|upstream (error|connect|request timeout|timed out)|bad gateway|service unavailable|gateway time-?out|\b50[234] (bad gateway|service|gateway)|ECONNREFUSED|ETIMEDOUT|unexpected EOF/i.test(e.message);
}

/** How a backend broke down: its process or connection (`crash`), or the upstream model stream (`transient`); null when it did not. */
export function breakdownKind(e: unknown): "crash" | "transient" | null {
  if (!(e instanceof Error)) return null;
  if (isAgentRunError(e) && e.kind === "idle") return "crash";
  if (isTransientUpstream(e)) return "transient";
  return /进程退出|进程已结束|connection closed|EPIPE|ECONNRESET|socket hang up|没有任何活动|长时间没有活动|退出码|找不到命令|spawn .*ENOENT/i.test(e.message) ? "crash" : null;
}

/**
 * Set a backend (or its model) aside after a failure that says it is not usable now — a crash, a
 * queue past the owner's limit, upstream errors in a row (capacity.ts noteFailure) — so the runs
 * after this one go elsewhere first instead of each meeting the same failure.
 */
export function noteBreakdown(app: App, p: AgentProfile, e: unknown, emit: (e: AgentEvent) => void) {
  const kind = breakdownKind(e) ?? (isAgentRunError(e) && e.kind === "queue" ? "queue" : null);
  if (!kind) return;
  const said = noteFailure(app, p, kind, (e as Error).message);
  if (said) emit({ type: "status", text: said });
}

/** Whether the run said it has nothing more to say (stay_quiet): set in its output by the tool. */
export function quietSet(app: App, runId: string | null) {
  return !!runId && !!one<{ q: string | null }>(app.db, "select json_extract(output, '$.stayQuiet') q from runs where id = ?", runId)?.q;
}

/**
 * The attempt ended its work with stay_quiet (nothing to post) and the backend failed only while
 * closing the turn — some providers answer an empty final message with an error ("empty stream")
 * after waiting minutes. Nothing is lost: the run is done, not failed, and no other backend redoes it.
 */
export function quietAfterAll(app: App, runId: string | null, quietBefore: boolean, e: unknown) {
  return !quietBefore && e instanceof Error && e.message !== "CANCELLED" && quietSet(app, runId);
}

/**
 * Where a run may go when the AI it started on cannot finish: the run's own AI when another was
 * chosen for it, the role's other configured backends, the fallbacks, then the owner's routing
 * candidates. Duplicates and options left out (limit 0, quota spent) are dropped.
 */
export function failoverProfiles(app: App, actor: Actor, first: AgentProfile, own?: AgentProfile): AgentProfile[] {
  const role = "spec" in actor ? "assistant" : (actor as { role: RoleName }).role;
  const list = [first, ...(own ? [own] : []), ...roleAlternatives(app, role, first), ...fallbackProfiles(app, actor, first.id).slice(1), ...candidateProfiles(app).map(({ when: _, ...p }) => p as AgentProfile)];
  return distinctProfiles(list).filter((p, i) => i === 0 || !excluded(app, p));
}

/** Whether a failure is worth retrying on a fallback backend/model. */
export function isRetryableAgentError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (isAgentRunError(e)) return e.kind === "queue" || e.kind === "rate-limit" || e.kind === "quota" || e.queued === true;
  return isQuotaMessage(e.message) || /rate.?limit|too many requests|429|capacity|overloaded|busy|try again later|resource.*(exhaust|unavailable)|排队/i.test(e.message);
}

/**
 * The account's usage quota is spent: leave its backends out until the reset time the provider
 * gave, so this run's fallback and later runs skip it instead of failing one by one.
 */
export function noteQuota(app: App, profile: AgentProfile, e: unknown, emit: (e: AgentEvent) => void) {
  if (!(e instanceof Error) || !(isAgentRunError(e) ? e.kind === "quota" : isQuotaMessage(e.message))) return;
  const until = markOutOfQuota(app, profile, e.message);
  const one = !!profile.model && isModelQuotaMessage(e.message, profile.model);
  emit({ type: "status", text: `${profile.name ?? profile.id}${one ? ` 的模型 ${profile.model}` : ""} 的额度用完了，${until.toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 前自动改用${one ? "其他模型和后端" : "其他后端"}` });
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
  const lessons = await lessonsForTask(app, input);
  // Nothing pins the AI (no execution, no caller's pick, not a session being continued, not a coding
  // or review run): choose among the owner's candidates (choose-ai.ts). The run's own AI then follows
  // the chosen one as a failover.
  let own: AgentProfile | undefined;
  let chosen: ChooseResult | null = null;
  const runKind = input.runId ? one<{ kind: string }>(app.db, "select kind from runs where id = ?", input.runId)?.kind : undefined;
  // Checks, replays and comparisons run on what their caller set and are not choices of their own.
  const internal = !!(input.shadow || input.replay || input.reviewCheck || input.reviewLead || input.checkName);
  const scene = input.choose ?? "tasks";
  const say = (text: string) => input.onEvent?.({ type: "status", text });
  const notChosen = (reason: string) => {
    const current = resolveRunProfile(app, { actor, profileId: input.profileId, model: input.model, effort: input.effort });
    input.onEvent?.(choiceEvent({ scene, outcome: "skipped", current: aiLabel({ profile: current.id, model: current.model, effort: current.effort }), reason }));
  };
  if (internal) {
    // nothing to record
  } else if (execution) notChosen(`${execution.source === "user" ? "本人指定了" : "助手交办时选了"} ${aiLabel(execution)}（${execution.reason}）`);
  else if (runKind === "code" || runKind === "review") notChosen("编码和评审按各自角色的设置，不在运行前自动选");
  else if (input.resumeSessionId) notChosen("接着之前的 Agent 会话，沿用它的 AI");
  else if (input.profileId || input.model || input.effort) notChosen("发起这次运行时已经定了 AI");
  else {
    const current = resolveRunProfile(app, { actor });
    chosen = await chooseAI(app, { scene, task: input.task, who: input.spec?.name ?? input.role, current, signal: input.signal, onStatus: say, onRecord: (r) => input.onEvent?.(choiceEvent(r)) });
    const pick = chosen?.pick;
    if (pick) {
      own = current;
      input = { ...input, profileId: pick.profile, model: pick.model, effort: pick.effort };
    }
  }
  const base = prepareRun(app, { actor, lessons, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, readScope: input.readScope, runId: input.runId, cwd: input.cwd, profileId: input.profileId, userId: input.userId, model: input.model, effort: input.effort, shadow: input.shadow, denyTools: input.denyTools, lark: input.lark, reviewCheck: input.reviewCheck, checkName: input.checkName, reviewLead: input.reviewLead, addTools: input.addTools, replay: input.replay, fullAccess: input.fullAccess });
  if (execution) {
    try { validateExecution(app, { ...execution, model: base.profile.model, effort: base.profile.effort }); }
    catch (e) { revokeToolToken(base.token); throw e; }
  }
  // A run (a role's or an Agent 档案's) may move to its other configured backends when its model is
  // full, and to the fallbacks when the backend is busy, out of quota, or breaks down (failoverProfiles).
  // An AI the owner or the assistant named for this run is used first and alone while it can take the
  // run (a full model waits for it, a nearly spent account is still used); only when it cannot —
  // busy, out of quota, broke down — does the run move on, unless the owner set `pinnedFallback: never`.
  const pinned = !!execution;
  // The order to move on in: the chooser's ranking by the owner's routing notes when it ran, then the
  // static order (the role's other backends, the fallbacks, the candidates) for whatever it did not rank.
  const single = !!input.shadow || (pinned && app.config.agents.routing.pinnedFallback === "never");
  const chain = single ? [base.profile] : chosen ? distinctProfiles([base.profile, ...chosen.order, ...failoverProfiles(app, actor, base.profile, own)]).filter((p, i) => i === 0 || !excluded(app, p)) : failoverProfiles(app, actor, base.profile, own);
  let orderBy: OrderSource = chosen ? chosen.by : "static";
  let orderReason = chosen?.reason ?? "";
  /**
   * A run the chooser did not rank (its AI was named, choosing is off, no decision model for it):
   * the first time it has to move on, the decision model ranks what is left by the routing notes
   * (cached per kind of run and set of options, fallbackOrder), else the static order stays.
   */
  let ordered = !!chosen || single;
  const reorder = async (from: number, why: string) => {
    if (ordered || chain.length - from < 2) return;
    ordered = true;
    const r = await fallbackOrder(app, { scene, who: input.spec?.name ?? input.role, from: chain[0], why, options: chain.slice(from), signal: input.signal });
    chain.splice(from, chain.length - from, ...r.order);
    orderBy = r.by;
    orderReason = r.reason;
  };
  const emit = input.onEvent ?? (() => {});
  let lastError: unknown;
  let failed = false;
  /** Why the previous backend was left: busy (queue, rate limit, quota), it failed before doing anything, or it broke down midway. */
  let leftBecause: { busy: boolean; untouched: boolean; why: string; first?: boolean } | null = null;
  /** What a backend that broke down midway already did, for the one taking over. */
  let carry = "";
  let acted = false;
  let writesBefore = 0;
  // The default account's plan limit is nearly used: acquire puts it after the others.
  const nearlySpent = chain.length > 1 ? quotaAvoid(app, chain[0]) : null;
  const writes = () => (input.runId ? one<{ n: number }>(app.db, "select count(*) n from run_events where run_id = ? and type = 'tool-write'", input.runId)!.n : 0);
  const { artifactInbox, collectInbox, takenText } = await import("./artifacts.ts");
  const inbox = input.artifacts && input.runId && !input.shadow ? artifactInbox(app, input.runId) : null;
  /** Who the first AI was, for the words when the run moves on. */
  const firstWho = pinned ? `原指定的 AI（${aiLabel(execution!)}）` : own ? `自动选中的 AI（${aiLabel({ profile: chain[0].id, model: chain[0].model })}）` : "默认后端";
  try {
    for (let i = 0; i < chain.length; i++) {
      // The named AI is out of quota or past the owner's daily cap: go straight to the next.
      if (pinned && i === 0 && chain.length > 1) {
        const until = outOfQuotaUntil(app, chain[0]);
        const why = until ? `额度用完（${new Date(until).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 恢复）` : dailyCapReached(app, chain[0]);
        if (why) {
          revokeToolToken(base.token);
          leftBecause = { busy: true, untouched: true, why, first: true };
          failed = true;
          await reorder(1, why);
          continue;
        }
      }
      // The first AI will be set aside (nearly spent, just broke down): who goes instead follows the notes.
      if (i === 0 && !pinned) {
        const aside = quotaAvoid(app, chain[0]) ?? downReason(app, chain[0]);
        if (aside) await reorder(1, aside);
      }
      let slot;
      try {
        slot = await acquire(app, pinned && i === 0 ? [chain[0]] : chain.slice(i), { runId: input.runId, signal: input.signal, onWait: (text) => emit({ type: "status", text }) });
      } catch (e) {
        if (i === 0) revokeToolToken(base.token);
        throw e;
      }
      if (i === 0 && slot.index > 0) revokeToolToken(base.token);
      const moved = slot.index > 0;
      i += slot.index;
      const profile = chain[i];
      const prep = i === 0 ? base : prepareRun(app, { actor, lessons, spaceId: input.spaceId, spaces: input.spaces, alsoRead: input.alsoRead, readScope: input.readScope, runId: input.runId, cwd: input.cwd ?? base.cwd, profileId: profile.id, userId: input.userId, model: profile.model ?? undefined, effort: profile.effort ?? undefined, denyTools: input.denyTools, lark: input.lark, reviewCheck: input.reviewCheck, checkName: input.checkName, reviewLead: input.reviewLead, addTools: input.addTools, replay: input.replay, fullAccess: input.fullAccess });
      if (i > 0 && !input.shadow) recordRunAI(app, input.runId, prep.profile, true);
      try {
        const req = {
          runId: input.runId,
          strictSelection: execution && i === 0 ? { model: !!execution.model, effort: !!execution.effort } : undefined,
          cwd: prep.cwd,
          // The instructions go once per session (see withInstructions); a resumed session gets the task alone.
          system: prep.system,
          parts: prep.parts,
          prompt: `（${prep.now}）\n\n${carry ? `${carry}\n\n---\n\n` : ""}# 任务\n\n${input.task}`,
          allowWrites: prep.allowWrites,
          modes: prep.modes,
          fullAccess: prep.fullAccess,
          signal: input.signal,
          mcp: inbox ? { ...prep.mcp, env: { ...prep.mcp.env, OMEM_ARTIFACTS: inbox } } : prep.mcp,
          extraMcp: prep.extraMcp,
          resumeSessionId: i === 0 ? input.resumeSessionId : undefined,
          persistSession: input.persistSession ?? !!input.resumeSessionId,
          queueTimeoutMs: app.config.agents.queueTimeoutMinutes * 60_000,
        };
        if (i > 0) {
          const why = leftBecause && !leftBecause.busy && !moved
            ? `${leftBecause.first ? firstWho : "上一个后端"}${leftBecause.untouched ? "没有开始工作就失败了" : "中途出错"}（${leftBecause.why}）`
            : failed && !moved ? `${firstWho}不可用（${leftBecause?.why ?? "排队、限流或额度用完"}）`
            : failed ? "重试时原来的模型已满"
            : nearlySpent ? `${firstWho}的额度快用完了（${nearlySpent}）`
            : `${firstWho}的模型已满`;
          const to = aiLabel({ profile: profile.id, model: profile.model, effort: profile.effort });
          emit({ type: "status", text: `${why}，改用 ${profile.name ?? profile.id}${profile.model ? ` · ${profile.model}` : ""}（${ORDER_LABEL[orderBy]}）`, failover: { from: aiLabel({ profile: chain[0].id, model: chain[0].model, effort: chain[0].effort }), to, why, orderBy: ORDER_LABEL[orderBy], ...(orderReason ? { orderReason } : {}), ...(pinned ? { pinned: true } : {}), ...(own ? { chosen: true } : {}) } });
        }
        emit({ type: "status", text: `使用 AI：${profile.id} · ${profile.model ?? "默认模型"} · ${profile.effort ?? "默认强度"}${prep.fullAccess ? " · 完全访问" : ""}${execution && i === 0 ? `（${execution.source === "user" ? "本人指定" : "任务选型"}：${execution.reason}）` : ""}` });
        // Whether this attempt did anything (a tool call of its own, or a write through omem's tools).
        acted = false;
        writesBefore = writes();
        const quietBefore = quietSet(app, input.runId);
        const watch = (e: AgentEvent) => {
          if (e.type === "tool") acted = true;
          emit(e);
        };
        const ai = { profile: prep.profile.id, model: prep.profile.model, effort: prep.profile.effort };
        let result: AgentResult;
        try {
          result = input.reuseSession && !input.shadow && !input.persistSession && !input.resumeSessionId && prep.profile.transport === "acp"
            ? await backgroundTurn(app, prep, req, input.task, input.runId, watch)
            : await runBackend(app, prep.profile, req, watch);
        } catch (e) {
          if (!quietAfterAll(app, input.runId, quietBefore, e)) throw e;
          emit({ type: "status", text: `这一轮已经用 stay_quiet 结束，后端收尾时出错（${(e as Error).message.slice(0, 120)}），按已完成处理` });
          result = { text: "", stopReason: "end_turn", agent: prep.profile.name ?? prep.profile.id };
        }
        revokeToolToken(prep.token);
        clearDown(app, prep.profile);
        return { ...result, profileId: prep.profile.id, ai };
      } catch (e) {
        revokeToolToken(prep.token);
        noteQuota(app, prep.profile, e, emit);
        // A backend that failed before doing anything (it could not start, prepare its environment, log
        // in) is left for the next one too: nothing was done, so nothing is done twice.
        const busy = isRetryableAgentError(e);
        // The backend broke down (crash, dropped connection, silent past the watchdog, the upstream
        // stream cut off): another one takes over even midway, told what this attempt already wrote.
        const down = !busy && isBackendDown(e);
        // Set it (or its model) aside for a while, so the next runs go elsewhere first.
        noteBreakdown(app, prep.profile, e, emit);
        const untouched = !acted && writes() === writesBefore;
        // The AI named for the run moves on only when it cannot take it (busy or broke down).
        const movable = pinned && i === 0 ? busy || down : busy || untouched || down;
        if ((e as Error).message === "CANCELLED" || input.signal?.aborted || !movable || i === chain.length - 1) throw e;
        if (!untouched) carry = (await import("./retry.ts")).partialAttemptNote(app, input.runId, writesBefore, e, aiLabel({ profile: prep.profile.id, model: prep.profile.model }));
        leftBecause = { busy, untouched, why: (e as Error).message.slice(0, 120), first: i === 0 };
        await reorder(i + 1, (e as Error).message);
        lastError = e;
        failed = true;
      } finally {
        slot.release();
      }
    }
    throw lastError ?? new Error("没有可用的 Agent");
  } finally {
    // What the agent left in its artifacts folder (finish_task took what belongs to a task).
    if (inbox && input.runId) {
      const taken = await collectInbox(app, input.runId, { source: "agent", by: input.spec?.name ?? input.checkName ?? input.role }).catch((e: Error) => ({ made: [], skipped: [e.message] }));
      if (taken.made.length || taken.skipped.length) emit({ type: "status", text: takenText(taken) });
    }
  }
}
