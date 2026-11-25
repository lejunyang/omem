import { guardUrlNow } from "../remote/browser-guard.ts";
import { audit } from "../auth/permissions.ts";
import { credentialSucceeded, mayUseCredential, selectedCredential } from "./credentials.ts";
import { commandLoginNote } from "./credential-execution.ts";
import { sceneWords, toolSections, UnknownScene, type InstructionScene } from "./instruction-sections.ts";
import type { RunKind } from "./run-kinds.ts";
export { toolSections } from "./instruction-sections.ts";
import { spacesWithCapability } from "../auth/capabilities.ts";
import { lentByOthers, localOnly, meshNote } from "../core/mesh.ts";
import { REVIEW_TOOLS } from "./review.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { peerProfile, allProfiles, type AgentProfile, type RoleName } from "../core/config.ts";
import { ownFolderNote } from "../memory/folders.ts";
import { passiveBlock, passiveRecall } from "../memory/passive.ts";
import { recallPurpose, recordRecalls } from "../memory/recall-stats.ts";
import { findSpace, kindLabel, relatedSpaces, spaceDir } from "../core/spaces.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { spaceGuide } from "../wiki/store.ts";
import { executionArgs, validateExecution, type Execution } from "./execution.ts";
import { resolveRoleProfile } from "./models.ts";
import { runBackend } from "./dispatch.ts";
import { backgroundTurn } from "./background-sessions.ts";
import { backendAvailable } from "./availability.ts";
import { NetworkUnavailableError, networkReason, refreshForRun } from "./network-policy.ts";
import { acquire, choosableProfiles, clearDown, dailyCapReached, downReason, excluded, isModelQuotaMessage, isQuotaMessage, markOutOfQuota, noteFailure, outOfQuotaUntil } from "./capacity.ts";
import { aiLabel, candidateProfiles, candidateWhen, choiceEvent, chooseAI, fallbackOrder, ORDER_LABEL, type ChoiceRecord, type ChooseResult, type ChooseScene, type OrderSource } from "./choose-ai.ts";
import { quotaAvoid, quotaPressure } from "./quota.ts";
import { catalogEntry, installHint, PluginBackendUnavailable, pluginBackendStatus, referencedPluginProfiles } from "./catalog.ts";
import { cloudAccess } from "./cloud-probe.ts";
import { backendCapabilities, type BackendCapabilities } from "./capabilities.ts";
import { DOUBAO_CLI_INSTALL, DOUBAO_TOOL_NOTE, doubaoFeatures } from "./doubao-cli.ts";
import { dropUnavailable, issueToolToken, revokeToolToken } from "./tools.ts";
import { aiUsageText, isAgentRunError, type AgentEvent, type AgentResult, type InstructionParts, type McpAccess } from "./types.ts";
import { OWNER, personalSpaceId, scopeFor, userName } from "../core/users.ts";
import { trimTools } from "../auth/tools.ts";
import { agentIndex, listAgentSpecs, DEFAULT_SPEC_TOOLS, skillIndex, skillsOutsideScope, spaceSkillsText, type AgentSpec, type McpServerSpec } from "./specs.ts";
import { expandTools, ROLE_TOOLS } from "./tool-help.ts";
import { applyOverlay, GUEST_ROLES, isBuiltinRole, overlayEmpty, roleOverlay, roleOverrideText, rolesDir, type RoleOverlay } from "./builtin-roles.ts";
import { agentToolEnv } from "./tool-cli.ts";
import { mcpServersFor } from "./mcp-servers.ts";
import { commandGateDir } from "./command-gate.ts";
import { embedQuery } from "../search/embeddings.ts";
import { asOfContent, memoryWhere, type RunView } from "./replay-view.ts";
import { categoryStatus } from "../core/ai-keys.ts";
import { accountBlocked, accountPolicy, accountFor, isAiMember, memberAccountPlan, MemberOwnerQuotaChanged, selectedMemberAccount, unisolatedReason, withAccount } from "./accounts.ts";
import { memberAi } from "./member-ai.ts";
import { selectMemberRunAccount } from "./member-run-ai.ts";
import { aiLoginWait } from "./credential-wait.ts";
import { addRunEvent, runUser } from "./runs.ts";
import { SandboxStartError } from "./spawn.ts";
import { canonical, runAccess, under } from "./own-sandbox.ts";
import { ownRun } from "./own-run.ts";
import { workspaceMounts } from "./workspaces.ts";
import type { WorktreeRef } from "./worktree-index.ts";
import { accountOf, egressRequested, egressSupport } from "./sandbox.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** What a run is told about the spaces related to its own. */
function relatedGuide(related: { space: string; name: string; kind: string; note: string }[], readOnly: boolean, hasTools: boolean) {
  return [
    ...related.map((r) => `- ${r.space}（${r.name}，${kindLabel(r.kind)}）${r.note ? `：${r.note}` : ""}`),
    "",
    hasTools ? `search、scan、find_symbol 不指定 space 时会同时查当前空间和这些空间，结果里标出所在空间；只查当前空间就传 space。问题或材料涉及它们（调用、依赖、共用的约定）时去读它们的原件和页面，不要只凭当前空间下结论。${readOnly ? "这次对这些空间只能读：记忆、事项、页面只写进当前空间，用到它们的材料时照常引用原件。" : ""}` : "",
  ].join("\n").trimEnd();
}
export type Role = { name: string; description: string; tools: string[]; writes: boolean; modes: string[]; skills: string[]; body: string; customized: boolean };

function parseRole(name: string, raw: string, customized: boolean, overlay?: RoleOverlay): Role {
  // Windows checkouts may have CRLF line endings.
  const text = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = (m ? YAML.parse(m[1]) : {}) as Partial<Role>;
  const body = m ? text.slice(m[0].length) : text;
  if (body.includes("<!-- when:")) toolSections(body, new Set());
  return {
    name,
    description: meta.description ?? "",
    tools: expandTools(overlay ? applyOverlay(meta.tools ?? [], overlay.tools) : (meta.tools ?? [])),
    writes: !!meta.writes,
    modes: meta.modes ?? [],
    skills: overlay ? applyOverlay(meta.skills ?? [], overlay.skills) : (meta.skills ?? []),
    body,
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
      if (e instanceof UnknownScene) throw e;
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
export function commonGuide(tools: Set<string>, capabilities = backendCapabilities({ transport: "acp" }), scene: string[] = [], matched?: string[]) {
  const guide = readFileSync(join(rolesDir(), "_common.md"), "utf8");
  // The preamble before the first section describes the MCP interface.
  const sections = capabilities.omemAccess === "mcp" ? guide : guide.slice(guide.search(/^## /m));
  const body = toolSections(sections, tools, capabilities.localTools, scene, matched);
  return capabilities.omemAccess === "shell-bridge" ? DOUBAO_TOOL_NOTE + "\n\n" + body : body;
}

export function listAgentProfiles(app: App) {
  const profiles = allProfiles(app.config);
  const references = new Set(listAgentSpecs(app, { includeDrafts: true }).flatMap(s => s.agent ?? []));
  for (const p of referencedPluginProfiles(references)) if (!profiles.some(e => e.id === p.id)) profiles.push(p);
  return profiles.map((p) => {
    const network = { networkReason: networkReason(app, p), pluginBackend: pluginBackendStatus(p) };
    if (p.transport === "doubao") return { ...p, ...network, installed: backendAvailable(p, app.home), install: backendAvailable(p, app.home) ? undefined : "omem doubao login（设备码授权，omem doubao status 查权限）" };
    if (p.transport === "doubao-cli") return { ...p, ...network, installed: backendAvailable(p, app.home), install: backendAvailable(p, app.home) ? undefined : DOUBAO_CLI_INSTALL };
    const e = catalogEntry(p.id);
    // `installable`: a catalog npm package settings can install from the page (agents/adapter.ts).
    return { ...p, ...network, installed: backendAvailable(p, app.home), install: e && e.command === p.command ? installHint(e) : undefined, ...(e?.npm && e.command === p.command && { installable: true }) };
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
type Lesson = { id: string; kind: string; subject: string; content: string; agent: string | null; embedding: Uint8Array | null };

/** `spec`: whose own memories count besides the shared ones — a profile, a built-in role, or `assistant` for the main assistant. */
function lessonRows(app: App, spaceId: string, userId: string, spec: string | null, vectors = false, view?: RunView) {
  // With review on, only memories the reviewer (or the owner) accepted are handed to every run:
  // a bad lesson repeated in every prompt costs more than a missing one.
  const vetted = app.config.memory.review.enabled ? "and (created_by = 'user' or review_verdict = 'keep')" : "";
  // A replay arm: the lessons as they stood at the question's time, minus what its variant leaves out.
  const w = memoryWhere(view, "memories");
  const allowed = spacesWithCapability(app, userId, "memories.view");
  return all<Lesson>(
    app.db,
    // A profile's own experience goes with it whatever space it runs in (an investigator learns from
    // the on-call groups of one project space and is called from the personal space).
    `select id, kind, subject, content, agent, ${vectors ? "embedding" : "null as embedding"} from memories where ${view ? w.sql : "status = 'active'"} ${vetted} ${allowed ? "and space_id in (select value from json_each(?))" : ""} and (agent is null or agent = ?) and (
       (kind = 'preference' and space_id in (?, ?) and coalesce(user_id, 'owner') = ?) or (kind = 'experience' and (space_id = ? or agent = ?))
     ) order by kind = 'preference' desc, agent is not null desc, updated_at desc limit 2000`,
    ...(view ? w.params : []),
    ...(allowed ? [JSON.stringify(allowed)] : []),
    spec ?? "",
    personalSpaceId(userId),
    spaceId,
    userId,
    spaceId,
    spec ?? "",
  ).map((r) => ({ ...r, content: asOfContent(view, r.content) }));
}

const lessonLines = (rows: Lesson[]) => rows.map((r) => `- ${r.kind === "preference" ? "偏好" : "经验"}${r.agent ? "（本档案）" : ""}${r.subject ? `（${r.subject}）` : ""}：${r.content}`).join("\n");

/** The preferences and experience a run is told, and which memories those are (passive recall and the recall accounting leave them out or count them). */
export type LessonSet = { text: string; ids: string[]; recallNote?: string };

/** Preferences a conversation carries whatever it turns out to be about. */
const STANDING_PREFS = 60;
/**
 * A profile's own experience is told whole while there is this little of it. Past that a run gets
 * the closest to its task (a conversation, having no task yet, the newest few); the rest it looks up
 * by folder, or passive recall brings it when a message or task is close to it.
 */
const OWN_WHOLE = 12;
const OWN_RECENT = 6;
const OWN_PREFS = 16;
/** Shared preferences and experience a task run is told: the closest to the task, at most this many. */
const TASK_LESSONS = 8;
/** A task can be a whole diff; what it is about is at its start. */
const ABOUT_CHARS = 2000;

function lessonSet(app: App, rows: Lesson[], own: string, left: number, canRecall: boolean, userId: string): LessonSet {
  const where = left > 0 && canRecall ? ownFolderNote(app, own, 12, spacesWithCapability(app, userId, "memories.view")) : "";
  const note = where ? `你自己的经验还有 ${left} 条没列在这里，按目录放着；做到相关的事时用 recall(folder="目录", query="关键词") 查：\n${where}` : "";
  return { text: lessonLines(rows), recallNote: note, ids: rows.map((r) => r.id) };
}

/**
 * With no task in view (a conversation's standing context): every preference, and the profile's own
 * experience while it is small. Shared experience and whatever did not fit reach a turn through
 * passive recall (sessions.ts), which is told these ids so it does not repeat them.
 */
function standingLessons(app: App, spaceId: string, userId: string, own: string, canRecall: boolean): LessonSet {
  const rows = lessonRows(app, spaceId, userId, own);
  const prefs = rows.filter((r) => r.kind === "preference").slice(0, STANDING_PREFS);
  const exp = rows.filter((r) => r.kind === "experience" && r.agent);
  const shown = exp.length <= OWN_WHOLE ? exp : exp.slice(0, OWN_RECENT);
  return lessonSet(app, [...prefs, ...shown], own, exp.length - shown.length, canRecall, userId);
}

/**
 * For a task: the profile's or role's own preferences, its own experience (whole while small, else
 * the closest to the task), and of the shared lessons only the closest to the task (cosine on memory
 * vectors; the newest without vectors). A coder is not told how the owner swipes back on a phone, and
 * an investigator with hundreds of cases is told the ones like this one, not the last ones it wrote.
 */
async function taskLessons(app: App, spaceId: string, userId: string, own: string, about: string, canRecall: boolean, view?: RunView): Promise<LessonSet> {
  const rows = lessonRows(app, spaceId, userId, own, true, view);
  const mine = rows.filter((r) => r.agent);
  const exp = mine.filter((r) => r.kind === "experience");
  const shared = rows.filter((r) => !r.agent);
  const q = shared.length > TASK_LESSONS || exp.length > OWN_WHOLE ? await embedQuery(app, about.slice(0, ABOUT_CHARS), "query", [spaceId]).catch(() => null) : null;
  const closest = (list: Lesson[], n: number) => {
    if (list.length <= n || !q) return list.slice(0, n);
    const scored = list.flatMap((r) => {
      if (!r.embedding) return [];
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      if (v.length !== q.length) return [];
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * q[i];
      return s > 0 ? [{ r, s }] : [];
    });
    // No vectors yet (just written, or the model changed): the newest, as without a model.
    return scored.length ? scored.sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.r) : list.slice(0, n);
  };
  const told = closest(exp, OWN_WHOLE);
  return lessonSet(app, [...mine.filter((r) => r.kind === "preference").slice(0, OWN_PREFS), ...told, ...closest(shared, TASK_LESSONS)], own, exp.length - told.length, canRecall, userId);
}

type LessonInput = { role: RoleName; spec?: AgentSpec; spaceId: string; userId?: string; task: string; replay?: ReplayArm };

/** The lessons that bear on a task run (a conversation gets the standing ones instead, see prepareRun). */
async function lessonsOfTask(app: App, input: LessonInput): Promise<LessonSet> {
  if (input.role === "guest" && !input.spec) return { text: "", ids: [] };
  const tools = input.spec ? (input.spec.tools.length ? expandTools(input.spec.tools) : DEFAULT_SPEC_TOOLS) : loadRole(input.role, app).tools;
  return taskLessons(app, input.spec?.space && !input.spaceId ? input.spec.space : input.spaceId, input.userId ?? OWNER, input.spec?.name ?? input.role, `${input.spec?.description ?? loadRole(input.role, app).description}
${input.task}`, tools.includes("recall"), input.replay?.view);
}

/** The ids of the lessons a task run is told (a replay records what the original run had in view). */
export async function lessonIdsForTask(app: App, input: LessonInput) {
  return (await lessonsOfTask(app, input)).ids;
}

export async function lessonsForTask(app: App, input: LessonInput) {
  const told = await lessonsOfTask(app, input);
  return [told.text, told.recallNote].filter(Boolean).join("\n\n");
}

export type RoleRunInput = {
  borrow?: { device: string; backend: string };
  boardAccess?: "read" | "write";
  itemTakeoverRead?: boolean;
  /** Host-assigned trees for this invocation (helpers carry their own leases). */
  worktrees?: WorktreeRef[];
  worktreeAccess?: "read" | "commit";
  /** Tools the caller needs for delivery. An empty list explicitly permits a text-only answer. */
  requiredTools?: string[];
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
  /** A second role inside someone else's run (a Wiki page's checker): its own role's AI, not the run's `ai` nor a chooser's pick. */
  ownAI?: boolean;
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
  /** A host investigation: the role’s tools intersect this allowlist, with no full access. */
  investigationTools?: readonly string[];
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
  acpWritable: boolean;
  isolation: ReturnType<typeof ownRun>;
  workspace?: import("./sandbox.ts").WorkspaceMounts;
  profile: AgentProfile;
  capabilities: BackendCapabilities;
  tools: Set<string>;
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
  scene: string[];
  awareness: string;
  sceneGuide: string;
  token: string;
  mcp: McpAccess;
  extraMcp: Record<string, McpServerSpec>;
  allowWrites: boolean;
  doubaoPermission: ReturnType<typeof runAccess>["doubaoPermission"];
  modes: string[];
  /** Commands outside the backend's sandbox, no approvals (see prepareRun). */
  fullAccess: boolean;
  label: string;
  /** The memories behind the preferences and experience in `system` (passive recall leaves them out). */
  lessonIds: string[];
  /** What passive recall may draw on: readable spaces (null = all) and whose own memories count. */
  recall: { sourceSpace: string; spaces: string[] | null; agent: string | null; own: string; userId: string } | null;
};

/** Resolve defaults and one-run overrides without creating a tool token or session. */
export function resolveRunProfile(app: App, input: { actor: Actor; profileId?: string; model?: string; effort?: string }): AgentProfile {
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const roleName = spec ? "assistant" : (input.actor as { role: RoleName }).role;
  const role = !spec;
  const baseProfile = input.profileId
    ? allProfiles(app.config).find((p) => p.id === input.profileId)
    : spec?.agent
      ? allProfiles(app.config).find((p) => p.id === spec.agent) ?? referencedPluginProfiles(new Set([spec.agent]))[0]
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

function accountProfile(app: App, input: Parameters<typeof resolveRunProfile>[1] & { userId?: string }) {
  const resolved = resolveRunProfile(app, input);
  return withAccount(app, input.userId ?? OWNER, resolved, () => failoverProfiles(app, input.actor, resolved).slice(1));
}

/** Called for the selected attempt, including a conversation reusing a live process. */
export function recordIsolation(app: App, runId: string | null, userId: string, profile: AgentProfile) {
  const choice = selectedMemberAccount(profile);
  if (choice) {
    if (!isAiMember(app, userId)) throw new Error("成员已停用");
    if (choice.holder === OWNER && (outOfQuotaUntil(app, profile) || quotaPressure(app, profile).reason))
      throw new MemberOwnerQuotaChanged("本人额度刚变紧张，需要改用成员的 AI 账号");
    if (runId) addRunEvent(app, runId, "status", { text: choice.reason, account: { ...choice, profile: profile.id } });
  }
  const use = selectedCredential(profile);
  if (use) {
    if (!mayUseCredential(app, use) || use.requester !== userId || use.holder !== userId && accountPolicy(app, use.backend) !== "owner")
      throw new Error("凭据或出借设置已变化，请重新选择账号");
    if (use.holder !== userId) {
      const detail = { ...use, runId, reason: choice?.reason ?? "发起人没有自己的后端登录" };
      audit(app, userId, "credentials.borrow", use.kind, detail);
      if (runId) addRunEvent(app, runId, "status", { ...detail, text: `借用 ${use.holder} 的 ${use.kind}：${detail.reason}` });
    }
  }
  // Said only when this run would have gone through the proxy here: a member's run, with egress isolation asked for.
  const egress = app.config.security.egress.mode;
  if (profile.peer && runId && userId !== OWNER && egress !== "off" && (egress === "all-sandboxed" || app.config.agents.accountIsolation === "require"))
    addRunEvent(app, runId, "status", { text: "代跑的运行不经这台的出网代理" });
  const reason = unisolatedReason(app, userId, profile);
  if (!reason) return;
  if (app.config.agents.accountIsolation === "require") throw new Error(`这台机器不能隔离成员的运行：${reason}`);
  if (runId) addRunEvent(app, runId, "status", { text: app.config.agents.ownSandbox.mode === "off" ? `这次运行没有隔离：${reason}` : `这次运行没有成员账号隔离：${reason}`, profile: profile.id });
}

/** Sent with every task, including a resumed session that already has its role instructions. */
export function turnHeader(prep: PreparedRun) {
  const clock = `（${prep.now}）`;
  return prep.isolation.box ? clock + "\n\n" + prep.isolation.note + " 写入失败时不要反复重试，告诉本人需要放开哪个目录。" : clock;
}

// Local host tools available for a device investigation. The run still needs the profile's tool and user permission.
const boardReads = new Set([...DEFAULT_SPEC_TOOLS, "read_item", "lark_read", "lark_doc_fetch", "connect_list", "connect_request", "attach_artifact"]);
const boardWrites = new Set(["remember", "write_page", "upsert_item"]);

export function prepareRun(
  app: App,
  input: { actor: Actor; investigationTools?: readonly string[]; itemTakeoverRead?: boolean; boardAccess?: "read" | "write"; scene?: InstructionScene; awarenessNote?: (withTools: boolean) => string; profile?: AgentProfile; spaceId: string; spaces?: string[] | null; alsoRead?: string[]; readScope?: string[]; runId: string | null; cwd?: string; profileId?: string; userId?: string; model?: string; effort?: string; lark?: LarkAccess; shadow?: { parentRunId: string | null }; denyTools?: string[]; reviewCheck?: boolean; checkName?: string; guestTurn?: boolean; reviewLead?: boolean; addTools?: string[]; lessons?: string; recallNote?: string; lessonIds?: string[]; replay?: ReplayArm; fullAccess?: boolean; worktrees?: WorktreeRef[]; reviewTrees?: WorktreeRef[]; worktreeAccess?: "read" | "commit"; inbox?: string },
): PreparedRun {
  const userId = input.userId ?? runUser(app, input.runId);
  const spec = "spec" in input.actor ? input.actor.spec : null;
  const role = spec ? null : loadRole((input.actor as { role: RoleName }).role, app);
  const roleName = role ? (input.actor as { role: RoleName }).role : "assistant";
  // A member's run uses their own account of the backend when they logged in to it (agents/accounts.ts);
  // not logged in to one that must be their own, it may move on in the run's fallback order (`own-or-other`).
  const profile = input.profile ?? accountProfile(app, { ...input, userId });
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
  if (spec || roleName === "assistant") for (const t of ["ask_user", "suggest_next", "withdraw_ask"]) tools.add(t);
  // Working files: where a long task keeps its current results and a scheduled rule its report.
  if (spec || roleName === "assistant") tools.add("write_file");
  // Wake-ups for its own follow-up work (after a while, or on a message in a chat).
  if (spec || roleName === "assistant") for (const t of ["wake", "cancel_wake"]) tools.add(t);
  if (!guest) tools.add("wait_answer");
  // A thread that may post into specific Feishu chats (watched groups) gets the bot's voice and notify.
  if (input.lark?.chats?.length) for (const t of ["lark_send", "lark_react", "lark_card", "lark_send_file", "notify"]) tools.add(t);
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
  if (input.boardAccess) {
    for (const name of tools) {
      if (!boardReads.has(name) && !(input.boardAccess === "write" && boardWrites.has(name))) tools.delete(name);
    }
  }
  if (input.investigationTools) for (const t of tools) if (!input.investigationTools.includes(t)) tools.delete(t);
  // Not what the person it works for may not do (src/auth/tools.ts), nor what needs something they lack.
  dropUnavailable(app, userId, tools);
  const baseCapabilities = backendCapabilities(profile);
  const access = input.runId && baseCapabilities.where === "cloud" ? cloudAccess(app, profile) : null;
  const capabilities: BackendCapabilities = access?.mode ? { ...baseCapabilities, omemAccess: "http", cloudHttp: access.mode } : baseCapabilities;
  if (access?.mode) for (const t of tools) if (!app.config.agents.cloudTools.tools.some(name => name === t)) tools.delete(t);
  if (capabilities.omemAccess === "none") tools.clear();
  const spaces =
    input.spaces !== undefined ? input.spaces : spec ? (spec.spaces.includes("*") ? null : [...new Set([space.id, ...spec.spaces])]) : roleName === "assistant" ? null : [space.id];
  const scoped = scopeFor(app, userId, spaces)?.filter(id => !input.readScope || input.readScope.includes(id)) ?? (input.readScope ?? null);
  if (scoped && !scoped.includes(space.id)) throw new HttpError(403, `${userName(app, userId)} 不能访问空间 ${space.id}`);
  // Related spaces: a run limited to its space also reads them (never writes), so work in one
  // repo or project sees what the others it depends on already say.
  const allowed = scopeFor(app, userId, input.readScope ?? null);
  const related = guest ? [] : relatedSpaces(app, space.id).filter((r) => !allowed || allowed.includes(r.space));
  const readable = scoped ? [...new Set([...scoped, ...related.map((r) => r.space), ...(input.alsoRead ?? []).filter((id) => !allowed || allowed.includes(id))])] : null;
  const writable = input.boardAccess === "read" ? [] : scoped ?? undefined;
  trimTools(app, userId, tools, { spaces: readable, writable });
  // Feishu posting: the owner's own runs may post anywhere they are asked to; others only where their thread lives.
  const lark = input.lark ?? { chats: userId === OWNER ? null : [] };
  const account = accountOf(profile);
  const base = new URL(app.baseUrl);
  if (egressRequested(app.config,profile) && egressSupport().ok) base.hostname = "127.0.0.1";
  const toolBase = base.origin;
  const reconciling = roleName === "flow-reconcile";
  const browserProfilesRoot = !reconciling && (spec || !GUEST_ROLES.includes(roleName)) && !input.boardAccess && !input.investigationTools && !input.itemTakeoverRead && !input.replay && !input.shadow && !input.reviewCheck && !input.reviewLead && !profile.peer && capabilities.localTools
    ? account ? join(account.home, ".omem", "remote", "profiles") : join(app.home, "remote", "profiles", ...(userId === OWNER ? [] : [`@${userId}`]))
    : undefined;
  const browserGuard = browserProfilesRoot && userId !== OWNER ? guardUrlNow() : null;
  const readOnly = reconciling || !!(input.boardAccess || input.investigationTools || input.itemTakeoverRead || input.reviewCheck || input.reviewLead || input.replay);
  // 完全访问: a run's own setting (a rule's switch, or the guest setting for a turn answering a guest) wins;
  // otherwise the profile's or the built-in role's, for the owner's own runs only. Checks, replays and comparisons never.
  const ownDefault = userId === OWNER && (spec ? spec.fullAccess : !GUEST_ROLES.includes(roleName) && !!roleOverlay(app, roleName).fullAccess);
  const legacyFull = !readOnly && !input.shadow && (input.fullAccess ?? ownDefault);
  const allowWrites = !readOnly && (spec ? spec.writes : role!.writes);
  const guestTurn = !!input.guestTurn || (!spec && GUEST_ROLES.includes(roleName));
  const mounts = (readOnly: boolean) => {
    const trees = input.worktrees ?? (readOnly ? input.reviewTrees : undefined);
    return trees && (trees.length || input.worktreeAccess === "read") ? workspaceMounts(app, trees,
      input.worktreeAccess === "commit" ? input.runId ?? undefined : undefined,
      input.worktreeAccess === "read" || readOnly ? "read" : "write") : undefined;
  };
  const isolation = ownRun(app, profile, cwd, guestTurn || !allowWrites || !!input.shadow, input.runId,
    { workspace: mounts, inbox: input.inbox, env: agentToolEnv(app.home, toolBase, "", commandGateDir(app)) });
  const workspace = isolation.box?.plan ?? (account ? mounts(false) : undefined);
  // An overlapping check can write its host-created detached snapshot, alongside the read-only originals.
  if (account && workspace && input.worktreeAccess === "read" && input.runId) {
    const dir = canonical(cwd);
    if (under(dir, join(canonical(app.runsDir), input.runId, "snap"))) workspace.rw.push(dir);
  }
  if (isolation.box && spec?.cwd && !input.cwd) {
    const target = canonical(cwd);
    if (under(target, isolation.box.data) && !under(target, canonical(space.rootPath ?? spaceDir(app, space.id))))
      throw new Error("档案的工作目录不属于本空间，不能从 omem 数据目录挂回沙箱");
  }
  const accessMode = runAccess(reconciling ? "per-role" : app.config.agents.fullAccess, {
    owner: userId === OWNER && !input.shadow && !input.boardAccess && !input.investigationTools && !input.itemTakeoverRead, guest: guestTurn, box: isolation.box, allowWrites, legacyFull,
  });
  const memorySpaces = spacesWithCapability(app, userId, "memories.view");
  const guide = spaceGuide(app, space.id).trim();
  // A coding run (a round, its reviews and helpers) also gets what its repositories say about themselves.
  const repos = guest ? [] : workRepos(app, input.runId).filter((id) => id !== space.id).flatMap((id) => findSpace(app, id) ?? []);
  const repoGuides = repos.map((r) => ({ r, text: spaceGuide(app, r.id).trim() })).filter((g) => g.text).map((g) => `## 仓库 ${g.r.name}（${g.r.id}）的说明（SPACE.md）\n\n${g.text}`).join("\n\n");
  // Skills mounted on the space, the business it belongs to and the repositories it works in.
  const parent = space.parentId ? findSpace(app, space.parentId) : null;
  const skillSpaces = [space, ...(parent ? [parent] : []), ...repos].filter(s => !input.boardAccess || !readable || readable.includes(s.id));
  const mounted = !tools.has("read_skill") ? { text: "", names: [] as string[] } : spaceSkillsText(app, skillSpaces);
  // A built-in role learns like a spec: its own experience and preferences, its regular skills first.
  // The main assistant's own are the ones taught to `assistant` (a nightly review writes them there).
  const told: LessonSet = guest ? { text: "", ids: [] } : input.lessons !== undefined ? { text: input.lessons, recallNote: input.recallNote, ids: input.lessonIds ?? [] } : standingLessons(app, space.id, userId, spec?.name ?? roleName, tools.has("recall"));
  const lessons = [told.text, tools.has("recall") && told.recallNote].filter(Boolean).join("\n\n");
  const profileSkills = input.boardAccess ? spec?.skills ?? role!.skills : undefined;
  const namedSkills = spec ? spec.skills : roleName === "assistant" ? undefined : role!.skills;
  const skills = !tools.has("read_skill") ? "" : skillIndex(app, namedSkills, mounted.names, profileSkills && skillsOutsideScope(app, profileSkills, readable));
  // Only what this run can do with them: an assistant run by a rule may consult but not hand work over.
  const agentUse = tools.has("run_agent") ? "可用 run_agent 交给它们" : tools.has("ask_agent") ? "这次运行不能交办，需要它们的专长时用 ask_agent 请教" : "";
  const agents = roleName === "assistant" && !spec && agentUse ? agentIndex(app) : "";
  const routing = !guest && DELEGATING.some((t) => tools.has(t)) ? routingGuide(app, profile) : "";
  const guideTools = access?.mode ? new Set<string>() : tools;
  const awareness = input.awarenessNote?.(tools.size > 0) ?? "";
  const scene = sceneWords({ chat: false, ...input.scene, awareness: !!(input.scene?.awareness || awareness), situation: input.scene?.situation || awareness.includes("# 正在进行的情境\n") }, tools);
  const matched: string[] = [];
  const render = (text: string) => toolSections(text, guideTools, capabilities.localTools, scene, matched);
  const instructions = spec?.instructions && render(spec.instructions);
  const body = spec
    ? `# 角色：${spec.description}\n\n${render(spec.prompt)}${instructions ? `\n\n## 工作约定（AGENTS.md）\n\n${instructions}` : ""}`
    : `# 角色：${role!.description}\n\n${render(role!.body)}`;
  const descriptions: Record<string, string> = {
    search: "检索材料", read_source: "按行读原件", read_page: "读 Wiki 页", read_item: "读事项",
    read_ledger: "读研究记录", propose_directions: "交这一轮的方向", trial_report: "交这个试验的结果", record_finding: "记一条发现", revise_study_finding: "改一条研究发现", queue_study_fixes: "把发现交给改", close_direction: "结束一个方向", stage_report: "交这一段的结果",
  };
  const common = commonGuide(guideTools, capabilities, scene, matched) + (access?.mode ? "\n\n## 云端工具\n" +
    [...tools].map(t => t + "：" + (descriptions[t] ?? t)).join("、") + "。连接信息在本轮消息或安全通道。GET 工具地址查看参数。" +
    (tools.has("trial_report") || tools.has("propose_directions") || tools.has("record_finding") || tools.has("stage_report") ? "这一段的结果要用对应的工具交回，只写在回复里不算交了。" : "") +
    (access.mode === "header" ? "按连接信息设置 Authorization 请求头，POST 地址/工具名，正文是 JSON 参数对象。" :
      "GET 地址/工具名?args=URL编码的JSON参数。每个地址只用一次，下次用响应里的 next。") +
    "连接信息每轮都不同：只用本轮给的，不要沿用沙箱里早先留下的脚本或文件中的地址和凭据。只在此地址使用凭据。被拒、过期或次数用完就停止，查不到就照实说，不要编。" : "");
  // Who else is on the network (core/mesh.ts): for the owner's own assistant and profiles that can ask.
  const mesh = userId === OWNER && tools.has("ask_agent") ? meshNote(app) : "";
  const environment = `# 环境\n\n${userId !== OWNER ? `- 这次是在为 ${userName(app, userId)} 工作（不是 omem 的主人），只能使用其有权访问的空间；对话里的“本人”指 ${userName(app, userId)}\n` : ""}${capabilities.localTools ? commandLoginNote(app, userId) : ""}- 当前空间：${space.id}（${space.name}，${kindLabel(space.kind)}）${!capabilities.localTools ? "" : space.rootPath ? `\n- 工作目录是该空间关联的目录：${space.rootPath}` : `\n- 工作目录是该空间的知识库目录（wiki/ 下是页面 Markdown）`}${guide ? `\n\n## 空间说明（SPACE.md）\n\n${guide}` : ""}${repoGuides ? `\n\n${repoGuides}` : ""}${related.length ? `\n\n## 相关空间\n\n${relatedGuide(related, !!scoped, tools.size > 0)}` : ""}${mesh ? `\n\n## 网络里的其他 omem\n\n${mesh}` : ""}${lessons ? `\n\n## 本人的偏好与以往经验（记忆中保存，按需遵循；与本次要求冲突时以本次为准）\n\n${lessons}` : ""}${mounted.text ? `\n\n## 这个空间和仓库的技能（这里的做法，做对应的事之前先读全文并照做）\n\n${mounted.text}` : ""}${skills ? `\n\n## 可用技能（做对应的事之前先读全文并照做）\n\n${skills}` : ""}${agents ? `\n\n## 已有的 Agent 档案（${agentUse}）\n\n${agents}` : ""}${routing ? `\n\n## 任务选型（交办时用 execution 选择）\n\n${routing}` : ""}`;
  const system = [common, body, environment].join("\n\n---\n\n");
  const token = issueToolToken({ commandHomeUser: guestTurn ? null : account?.userId ?? OWNER, browserProfilesRoot, incomingWork: input.scene?.kind === "peer-work" ? { chatPages: new Map() } : undefined, boardAccess: input.boardAccess, profileSkills, runId: input.runId, spaceId: space.id, spaces: readable, writable, itemDiscoverySpaces: !spec && roleName === "ingest" ? (input.spaces === undefined ? allowed : scoped) : undefined, tools, actor: "agent", userId, larkChats: lark.chats, larkDraft: !!lark.draft, larkPowers: larkPowers(lark, userId), larkBot: lark.bot, agentProfile: profile.id, model: profile.model, effort: profile.effort, role: spec ? undefined : roleName, spec: spec?.name, ...(input.checkName ? { check: input.checkName } : {}), plugin: spec?.plugin, shadow: input.shadow, view: input.replay?.view });
  return {
    isolation,
    workspace,
    ...accessMode,
    profile,
    capabilities,
    tools,
    cwd,
    system, scene, awareness, sceneGuide: matched.join("\n\n"),
    // A replay arm answers as of the question's time.
    now: `现在：${localTime(app, input.replay?.view.asOf)}`,
    parts: { common: common.length, role: body.length, environment: environment.length - lessons.length - skills.length - mounted.text.length, lessons: lessons.length, lessonCount: lessons ? lessons.split("\n").length : 0, skills: skills.length + mounted.text.length },
    token,
    mcp: { url: `${toolBase}/mcp`, baseUrl: toolBase, token, stdio: mcpBridge(), env: {
      ...agentToolEnv(app.home, toolBase, token, commandGateDir(app)),
      ...(input.inbox ? { OMEM_ARTIFACTS: input.inbox } : {}),
      ...(browserProfilesRoot ? { OMEM_BROWSER_PROFILES: browserProfilesRoot } : {}),
      // Someone else's run: the browsers it opens go through the guard that keeps them off this machine (remote/browser-guard.ts).
      ...(browserProfilesRoot && browserGuard ? { OMEM_BROWSER_PROXY: browserGuard } : {}),
      ...(profile.peer ? { OMEM_PEER_MEMBER: userId } : {}),
      ...(guest || input.boardAccess || input.investigationTools || input.itemTakeoverRead || input.replay ? { OMEM_DESKTOP_TOOLS: "off" } : {}),
    } },
    // Its own MCP servers: the ones written into the profile, and the ones it names from the owner's list
    // (mcp-servers.ts) — those only on the owner's own runs, since they carry the owner's keys.
    extraMcp: (input.boardAccess && profile.peer) || input.reviewCheck || input.reviewLead ? {} : extraMcpFor({ ...(guest || userId !== OWNER ? {} : mcpServersFor(app, spec ? spec.mcpServers : (roleOverlay(app, roleName).mcp ?? []))), ...(spec?.mcp ?? {}) }, readOnly),
    allowWrites,
    modes: readOnly ? ["read-only", "default", "plan"] : spec ? (spec.writes ? ["acceptEdits", "default"] : ["read-only", "default", "plan"]) : role!.modes,
    label: spec ? spec.name : roleName,
    lessonIds: told.ids,
    // Guests never see the owner's memories unasked. `agent` names the run in the recall accounting
    // (none for the main assistant); `own` is whose memories it sees besides the shared ones.
    recall: guest ? null : { sourceSpace: input.spaceId, spaces: memorySpaces?.filter(id => !readable || readable.includes(id)) ?? readable, agent: spec?.name ?? (roleName === "assistant" ? null : roleName), own: spec?.name ?? roleName, userId },
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
const DELEGATING = ["run_agent", "ask_agent", "delegate_code", "review_branch", "continue_code_run", "generate_wiki"];
/**
 * The owner's routing candidates, for a run that delegates. Without them in view the assistant
 * never looked them up (list_ai_backends) and every delegation used the profile default.
 */
function routingGuide(app: App, profile: AgentProfile) {
  const r = app.config.agents.routing;
  if (!r.automatic) return "";
  const ai = (c: { profile: string; model?: string; effort?: string }) => [c.profile, c.model, c.effort].filter(Boolean).join(" / ");
  const cloud = choosableProfiles(app).some(p => backendCapabilities(p).where === "cloud");
  // What changes during a session (load, the time) is not written here: these instructions are sent
  // once per session. The time opens every turn; the load comes from list_ai_backends.
  return [
    `你这次用的是 ${ai({ profile: profile.id, model: profile.model, effort: profile.effort })}；交办出去的运行不带 execution 时用对方档案的设置。`,
    ...(r.guidance.trim() ? [`本人的总体偏好：${r.guidance.trim()}`] : []),
    ...(r.candidates.length ? ["本人列出的候选：", ...r.candidates.map((c) => `- ${ai(c)}：${candidateWhen(r.candidates, c)}`)] : []),
    "偏好和候选里写了时段的（峰谷价格、排队高峰、某段时间不用），按每轮消息开头的现在时间对照着选。",
    "交办前用 list_ai_backends 看各模型现在的占用（正在用/上限）和近 7 天的完成、失败：同样合适时选空闲、失败少的，满了的会排队。",
    "它的 quota 是账号的套餐额度（各窗口已用百分比、多久后重置、周额度每天还能用多少）：标了 avoid 的账号快用完了，同样合适时选别的；本人偏好里写了额度条件的，按这些数字对照。",
    ...(one(app.db, "select 1 from replays where verdict in ('win','loss','tie') and axis in ('A1','A2') limit 1") ? ["其中的 replay28d 是夜间复盘的单变量对比（同一题只换模型），样本小，只作参考。"] : []),
    ...(cloud ? ["交给云端后端时把原文材料写进任务。本人确认并启用的后端还能经 HTTP 补查少数只读工具。需要调工具交结果的任务选本地后端。"] : []),
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
  return e instanceof NetworkUnavailableError || e instanceof PluginBackendUnavailable || breakdownKind(e) !== null;
}

/**
 * The provider's side broke off the model's answer (the stream was cut, came back empty, was reset):
 * the backend process is fine and another try, or another backend, usually works.
 */
export function isTransientUpstream(e: unknown): boolean {
  return e instanceof Error && /stream disconnected|Client network socket disconnected before secure TLS connection was established|empty (llm )?(response|stream)|llm response empty|RST_STREAM|stream (was )?(terminated|closed|reset)|upstream (error|connect|request timeout|timed out)|bad gateway|service unavailable|gateway time-?out|\b50[234] (bad gateway|service|gateway)|ECONNREFUSED|ETIMEDOUT|unexpected EOF/i.test(e.message);
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
export function failoverProfiles(app: App, actor: Actor, first: AgentProfile, own?: AgentProfile, userId?: string): AgentProfile[] {
  const role = "spec" in actor ? "assistant" : (actor as { role: RoleName }).role;
  const list = [first, ...(own ? [own] : []), ...roleAlternatives(app, role, first), ...fallbackProfiles(app, actor, first.id, undefined, userId).slice(1), ...candidateProfiles(app, undefined, userId).map(({ when: _, ...p }) => p as AgentProfile)];
  return distinctProfiles(list).filter((p, i) => i === 0 || userId || !excluded(app, p));
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
  if (!(e instanceof Error) || !(isAgentRunError(e) ? e.kind === "quota" : isQuotaMessage(e.message))) return false;
  // A user's own account is set aside for that user's runs only (capacity.ts keeps it apart from the owner's).
  const until = markOutOfQuota(app, profile, e.message);
  const one = !!profile.model && isModelQuotaMessage(e.message, profile.model);
  emit({ type: "status", text: `${accountOf(profile) ? "你自己的 " : ""}${profile.name ?? profile.id}${accountOf(profile) ? " 账号" : ""}${one ? ` 的模型 ${profile.model}` : ""} 的额度用完了，${until.toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 前自动改用${one ? "其他模型和后端" : "其他后端"}` });
  return true;
}

/** Build the ordered profile list for one role run: primary then configured fallbacks. */
export function fallbackProfiles(
  app: App,
  actor: Actor,
  baseId: string,
  thread?: { model?: string | null; effort?: string | null },
  userId?: string,
): AgentProfile[] {
  const specs = allProfiles(app.config);
  const roleName = "spec" in actor ? null : (actor as { role: RoleName }).role;
  const make = (id: string, modelOverride?: string, effortOverride?: string): AgentProfile | null => {
    const p = specs.find((x) => x.id === id) ?? referencedPluginProfiles(new Set([id]))[0];
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
    if (p && (userId || !excluded(app, p)) && !chain.some((x) => x.id === p.id && x.model === p.model && x.effort === p.effort)) chain.push(p);
  }
  return chain;
}

/** Run a role-defined agent turn with omem tools attached. */
/**
 * A model swapped in for one run (generate_wiki's execution, switch_run_ai), kept as the run's
 * input.ai. Coding and review runs choose per role (coder / reviewer) instead.
 */
export async function runRole(app: App, input: RoleRunInput & { spec?: AgentSpec; userId?: string }): Promise<AgentResult & { profileId: string; ai: { profile: string; model?: string; effort?: string } }> {
  input = { ...input, userId: input.userId ?? runUser(app, input.runId) };
  await refreshForRun(app);
  const row = input.runId ? one<{ kind: RunKind; input: string }>(app.db, "select kind, input from runs where id = ?", input.runId) : undefined;
  const runKind = row?.kind;
  const runInput = json<{ ai?: Execution; turnContext?: unknown; conversationId?: string; threadId?: string; ownAccountOnly?: boolean }>(row?.input ?? "{}", {});
  const ownAI = input.ownAI || runKind === "code" || runKind === "review";
  const member = input.role !== "guest" && input.role !== "gatekeeper" && !input.borrow && !input.shadow && !input.replay && isAiMember(app, input.userId!) ? input.userId : undefined;
  const login = aiLoginWait(app, input.runId);
  if (login && (!member || login.userId !== member)) throw new Error("等待登录的成员已不可用");
  const personal = member && !ownAI && !input.borrow && !input.resumeSessionId && !input.profileId && !input.model && !input.effort ? memberAi(app, member) : {};
  const specified = !!(personal.profile || personal.model || personal.effort);
  const requested = input.execution ?? (ownAI ? undefined : runInput.ai);
  const execution = input.borrow || login || (specified && requested?.source === "auto") ? undefined : validateExecution(app, requested, input.userId);
  input = { ...input, ...executionArgs(execution) };
  if (login) input = { ...input, profileId: login.pick.profile, model: login.pick.model, effort: login.pick.effort, resumeSessionId: undefined };
  else if (!execution && specified) input = { ...input, profileId: personal.profile, model: personal.model, effort: personal.effort };
  const actor: Actor = input.spec ? { spec: input.spec } : { role: input.role };
  const declared = input.spec ? (input.spec.tools.length ? expandTools(input.spec.tools) : DEFAULT_SPEC_TOOLS) : loadRole(input.role, app).tools;
  const selectedTools = [...declared.filter(t => !input.denyTools?.includes(t)), ...(input.addTools ?? [])];
  const handIn = input.reviewLead ? ["rule_review"] : input.reviewCheck ? ["submit_review"] : selectedTools.filter(t => ROLE_TOOLS.includes(t) && (!input.replay || input.replay.tools.includes(t)));
  const required = input.requiredTools ?? [...new Set(handIn)];
  const textAnswer = (input.role === "assistant" || input.role === "guest") && !input.choose && !input.spec;
  const needsAccess = required.length > 0 || (input.requiredTools === undefined && declared.length > 0 && !textAnswer);
  const requirement = required.length ? required.join("、") : "omem 工具";
  // A cloud backend reaches omem's tools over HTTP (cloud-tools.ts) when its probe is confirmed: enough when
  // every tool this run must hand its result in with is among the tools the owner lets a cloud backend call.
  const overHttp = (profile: AgentProfile) => required.length > 0 && !!input.runId && backendCapabilities(profile).where === "cloud"
    && !!cloudAccess(app, profile).mode && required.every(t => app.config.agents.cloudTools.tools.some(name => name === t));
  const supports = (profile: AgentProfile) => !needsAccess || ["mcp", "shell-bridge"].includes(backendCapabilities(profile).omemAccess) || overHttp(profile);
  const told = await lessonsOfTask(app, input);
  const lessons = told.text;
  // Nothing pins the AI (no execution, no caller's pick, not a session being continued, not a coding
  // or review run): choose among the owner's candidates (choose-ai.ts). The run's own AI then follows
  // the chosen one as a failover.
  let own: AgentProfile | undefined;
  let chosen: ChooseResult | null = null;
  // Checks, replays and comparisons run on what their caller set and are not choices of their own.
  const internal = !!(input.borrow || input.shadow || input.replay || input.reviewCheck || input.reviewLead || input.checkName || input.ownAI);
  const scene = input.choose ?? "tasks";
  const say = (text: string) => {
    const event = { type: "status" as const, text };
    if (input.onEvent) input.onEvent(event);
    else if (input.runId) addRunEvent(app, input.runId, "status", event);
  };
  const recordChoice = (choice: ChoiceRecord) => {
    const event = choiceEvent(choice);
    if (input.onEvent) input.onEvent(event);
    else if (input.runId) addRunEvent(app, input.runId, "status", event);
  };
  const notChosen = (reason: string) => {
    const current = resolveRunProfile(app, { actor, profileId: input.profileId, model: input.model, effort: input.effort });
    recordChoice({ scene, outcome: "skipped", current: aiLabel({ profile: current.id, model: current.model, effort: current.effort }), reason });
  };
  if (internal) {
    // nothing to record
  } else if (login) notChosen("继续等待登录前的 AI 选择");
  else if (execution) notChosen(`${execution.source === "flow" ? "流程指定了" : execution.source === "user" ? member ? "成员指定了" : "本人指定了" : "助手交办时选了"} ${aiLabel(execution)}（${execution.reason}）`);
  else if (specified) notChosen("成员指定了个人默认 AI");
  else if (runKind === "code" || runKind === "review") notChosen("编码和评审按各自角色的设置，不在运行前自动选");
  else if (input.resumeSessionId) notChosen("接着之前的 Agent 会话，沿用它的 AI");
  else if (input.profileId || input.model || input.effort) notChosen("发起这次运行时已经定了 AI");
  else {
    const current = resolveRunProfile(app, { actor });
    chosen = await chooseAI(app, { scene, accepts: supports, task: input.task, who: input.spec?.name ?? input.role, current, userId: input.userId, signal: input.signal, onStatus: say, onRecord: recordChoice });
    const pick = chosen?.pick;
    if (pick) {
      own = current;
      input = { ...input, profileId: pick.profile, model: pick.model, effort: pick.effort };
    }
  }
  const borrowed = input.borrow;
  const raw = member ? resolveRunProfile(app, { ...input, actor }) : undefined;
  const memberOptions = { userId: input.userId!, runId: input.runId, threadId: runInput.conversationId ?? runInput.threadId, pinned: specified || execution?.source === "user", ownOnly: runInput.ownAccountOnly, signal: input.signal };
  const primary = borrowed ? peerProfile({
    id: `peer:${borrowed.device}:${borrowed.backend}`, peer: { id: borrowed.device, agent: borrowed.backend },
    transport: "acp", command: "omem", args: [], env: { OMEM_HOME: app.home }, idleTimeoutMs: 600000,
    model: input.execution?.model, effort: input.execution?.effort,
  }) : member && raw ? await selectMemberRunAccount(app, raw, { ...memberOptions, alternatives: failoverProfiles(app, actor, raw, own, member).slice(1).filter(supports) })
    : accountProfile(app, { ...input, actor });
  const { artifactInbox, collectInbox, takenText } = await import("./artifacts.ts");
  const inbox = input.artifacts && input.runId && !input.shadow ? artifactInbox(app, input.runId) : undefined;
  let reviewTrees: WorktreeRef[] | undefined;
  if (!input.worktrees && input.runId && (input.reviewCheck || input.reviewLead)) {
    const { workRootOf } = await import("./code-tasks.ts");
    const { worktreesOf } = await import("./code.ts");
    reviewTrees = worktreesOf(app, workRootOf(app, input.runId));
  }
  const { awarenessNote } = await import("./awareness.ts");
  const prepare = (profile: AgentProfile) => prepareRun(app, {
    ...input, actor, profile, reviewTrees, inbox, lessons, lessonIds: told.ids, recallNote: told.recallNote,
    scene: { kind: runKind, chat: !internal && (runKind === "ask" || runKind === "guest" || runKind === "lark-command"), awareness: !internal && !!runInput.turnContext },
    awarenessNote: internal ? undefined : withTools => awarenessNote(app, input.runId, withTools),
  });
  if (execution && primary.id === execution.profile) validateExecution(app, { ...execution, model: primary.model, effort: primary.effort }, input.userId);
  // A run (a role's or an Agent 档案's) may move to its other configured backends when its model is
  // full, and to the fallbacks when the backend is busy, out of quota, or breaks down (failoverProfiles).
  // An AI the owner or the assistant named for this run is used first and alone while it can take the
  // run (a full model waits for it, a nearly spent account is still used); only when it cannot —
  // busy, out of quota, broke down — does the run move on, unless the owner set `pinnedFallback: never`.

  // The order to move on in: the chooser's ranking by the owner's routing notes when it ran, then the
  // static order (the role's other backends, the fallbacks, the candidates) for whatever it did not rank.
  const single = !!input.boardAccess || !!input.shadow || execution?.source === "flow" || ((execution || specified || login) && app.config.agents.routing.pinnedFallback === "never");
  const fallbacks = single ? [] : failoverProfiles(app, actor, primary, own, member);
  const candidates = distinctProfiles([primary, ...(single ? [] : chosen?.order ?? []), ...fallbacks]).flatMap((p, i) => {
    if (i === 0) return [p];
    if (!member) return !excluded(app, p) && !accountBlocked(app, input.userId ?? OWNER, p) ? [accountFor(app, input.userId, p)] : [];
    const plan = memberAccountPlan(app, member, p, runInput.ownAccountOnly);
    return plan.kind === "ready" && !excluded(app, plan.profile) ? [plan.profile] : [];
  });
  // A space kept on this machine only is never handed to an AI borrowed from someone else's server (core/mesh.ts):
  // such backends are passed over; when the run starts on one, it says so instead.
  // Routine work on a member's line (items/member-routine.ts): on their own account or not at all, never the owner's login.
  if (input.runId && one<{ v: number | null }>(app.db, "select json_extract(input, '$.ownAccountOnly') v from runs where id = ?", input.runId)?.v) {
    for (let k = candidates.length - 1; k >= 0; k--) if (accountOf(candidates[k])?.userId !== input.userId) candidates.splice(k, 1);
    if (!candidates.length) throw new Error("这是成员的线上的例行整理，只用成员自己的 AI 账号跑：没有登录了的、能隔离的后端");
  }
  if (localOnly(app, input.spaceId)) {
    if (lentByOthers(app, candidates[0])) throw new HttpError(400, `这个空间设了“仅本机”，不能用别人的 omem 借出的 AI（${candidates[0].id}）：给这次运行或这个角色换一个本机的后端`);
    for (let k = candidates.length - 1; k > 0; k--) if (lentByOthers(app, candidates[k])) candidates.splice(k, 1);
  }
  const chain = candidates.filter(p => {
    if (supports(p)) return true;
    say(`跳过后端 ${p.id}：本次运行需要 ${requirement}，该后端没有 omem 工具通道`);
    return false;
  });
  if (!chain.length) throw new Error(`没有可交付这次任务的后端：需要 ${requirement}`);
  const primaryKept = primary === chain[0];
  const pinned = !!(execution || specified || login) && primaryKept;
  const base = prepare(chain[0]);
  const missing = required.filter(name => !base.tools.has(name));
  if (missing.length) {
    revokeToolToken(base.token);
    const reason = `本次运行缺少必需工具：${missing.join("、")}`;
    say(reason);
    throw new Error(reason);
  }
  if (!primaryKept && !input.shadow) recordRunAI(app, input.runId, base.profile, runKind !== "code" || !(input.reviewCheck || input.reviewLead));
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
    const r = await fallbackOrder(app, { scene, who: input.spec?.name ?? input.role, from: chain[0], why, options: chain.slice(from), userId: member, signal: input.signal });
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
  /** Who the first AI was, for the words when the run moves on. */
  const firstWho = pinned ? `原指定的 AI（${aiLabel({ profile: chain[0].id, model: chain[0].model, effort: chain[0].effort })}）` : own ? `自动选中的 AI（${aiLabel({ profile: chain[0].id, model: chain[0].model })}）` : "默认后端";
  // Memories close to the task that its instructions did not carry (memory/passive.ts), for the runs
  // that answer or act. The roles that keep the knowledge in order look memories up themselves, and
  // a replay arm is given its own (replay.ts). A comparison run sees the same and is not counted.
  let hits: Awaited<ReturnType<typeof passiveRecall>> = [];
  if (base.recall && !input.replay && recallPurpose(input.spec?.name ?? input.role) === "answer") {
    const by = { runId: input.runId, profile: base.profile.id, spec: base.recall.agent ?? undefined };
    const count = !!input.runId && !input.shadow;
    if (count) recordRecalls(app, told.ids, { ...by, via: "lesson" });
    try {
      hits = await passiveRecall(app, { text: input.task.slice(0, ABOUT_CHARS), sourceSpaces: [base.recall.sourceSpace], spaces: base.recall.spaces, userId: base.recall.userId, spec: base.recall.own, exclude: new Set(told.ids) });
      if (count) recordRecalls(app, hits.map((h) => h.memory.id), { ...by, via: "passive" });
    } catch (e) {
      console.warn("[omem] 给任务带上相关记忆失败：", (e as Error).message);
    }
  }
  // A restart cut this run off (runs.ts markRestarted): the first agent turn it starts again
  // continues in the session it was in, when that is the same AI and folder, told what happened.
  const restarted = input.runId && !input.shadow && !input.replay ? takeRestart(app, input.runId) : null;
  try {
    for (let i = 0; i < chain.length; i++) {
      // The named AI is out of quota or past the owner's daily cap: go straight to the next.
      if (pinned && i === 0 && chain.length > 1) {
        const until = outOfQuotaUntil(app, chain[0]);
        const why = networkReason(app, chain[0]) ?? (until ? `额度用完（${new Date(until).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} 恢复）` : dailyCapReached(app, chain[0]));
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
      const prep = i === 0 ? base : prepare(profile);
      // A check may fall back inside the code run: its AI belongs on the review, not over the coder's.
      if (i > 0 && !input.shadow) recordRunAI(app, input.runId, prep.profile, runKind !== "code" || !(input.reviewCheck || input.reviewLead));
      acted = false;
      writesBefore = writes();
      try {
        recordIsolation(app, input.runId, input.userId!, prep.profile);
        if (prep.isolation.note) emit({ type: "status", text: prep.isolation.note });
        const task = [input.task, passiveBlock(hits, "这次任务", prep.tools.has("recall"))].filter(Boolean).join("\n\n");
        const workspace = prep.workspace;
        let resumeSessionId = primaryKept && i === 0 ? input.resumeSessionId ?? (restarted?.sessionId && restarted.profileId === prep.profile.id && restarted.cwd === prep.cwd ? restarted.sessionId : undefined) : undefined;
        if (member && resumeSessionId && prep.profile.transport === "acp") {
          const { sessionMatchesAccount } = await import("./session-cleanup.ts");
          if (!sessionMatchesAccount(app, resumeSessionId, prep.profile)) {
            emit({ type: "status", text: "未能核对原会话所属的 AI 账号，带上任务上下文开始新会话" });
            resumeSessionId = undefined;
          }
        }
        const sceneUpdate = resumeSessionId && prep.sceneGuide ? `\n\n## 本轮适用的场景说明\n\n${prep.sceneGuide}` : "";
        const req = {
          runId: input.runId,
          selection: pinned && i === 0 ? execution : undefined,
          strictSelection: pinned && profile.id === primary.id ? { model: !!(execution?.model ?? personal.model), effort: !!(execution?.effort ?? personal.effort) } : undefined,
          cwd: prep.cwd,
          workspace,
          ownSandbox: prep.isolation.box,
          // The instructions go once per session (see withInstructions); a resumed session gets the task alone.
          system: prep.system,
          capabilities: prep.capabilities,
          parts: prep.parts,
          scene: prep.scene,
          prompt: `${turnHeader(prep)}\n\n${carry ? `${carry}\n\n---\n\n` : ""}${primaryKept && i === 0 && restarted ? `${restartNote(app, input.runId!, restarted)}\n\n---\n\n` : ""}# 任务\n\n${task}${prep.awareness}${sceneUpdate}${workspace?.pointers?.length ? "\n\n成员沙箱中的 Git 目录属于本轮。请在分配的分支上直接提交，宿主按登记的分支接收提交。临时分支需要命名时用分支说明中指定的宿主工具。" : ""}`,
          allowWrites: prep.allowWrites, doubaoPermission: prep.doubaoPermission,
          modes: prep.modes,
          fullAccess: prep.fullAccess,
          acpWritable: prep.acpWritable,
          signal: input.signal,
          mcp: prep.mcp,
          extraMcp: prep.extraMcp,
          resumeSessionId,
          persistSession: input.persistSession ?? !!input.resumeSessionId,
          queueTimeoutMs: app.config.agents.queueTimeoutMinutes * 60_000,
        };
        if (i > 0) {
          const network = networkReason(app, chain[0]);
          const why = network ? `${firstWho}网络受限（${network}）` : leftBecause && !leftBecause.busy && !moved
            ? `${leftBecause.first ? firstWho : "上一个后端"}${leftBecause.untouched ? "没有开始工作就失败了" : "中途出错"}（${leftBecause.why}）`
            : failed && !moved ? `${firstWho}不可用（${leftBecause?.why ?? "排队、限流或额度用完"}）`
            : failed ? "重试时原来的模型已满"
            : nearlySpent ? `${firstWho}的额度快用完了（${nearlySpent}）`
            : `${firstWho}的模型已满`;
          const to = aiLabel({ profile: profile.id, model: profile.model, effort: profile.effort });
          emit({ type: "status", text: `${why}，改用 ${profile.name ?? profile.id}${profile.model ? ` · ${profile.model}` : ""}（${ORDER_LABEL[orderBy]}）`, failover: { from: aiLabel({ profile: chain[0].id, model: chain[0].model, effort: chain[0].effort }), to, why, orderBy: ORDER_LABEL[orderBy], ...(orderReason ? { orderReason } : {}), ...(pinned ? { pinned: true } : {}), ...(own ? { chosen: true } : {}) } });
        }
        if (profile.transport !== "doubao-cli" || doubaoFeatures(profile).acp)
          emit({ type: "status", text: aiUsageText(profile, prep.fullAccess ? "完全访问" : undefined, req.selection) });
        // Whether this attempt did anything (a tool call of its own, or a write through omem's tools).
        const quietBefore = quietSet(app, input.runId);
        const watch = (e: AgentEvent) => {
          if (e.type === "tool") acted = true;
          emit(e);
        };
        const ai = { profile: prep.profile.id, model: prep.profile.model, effort: prep.profile.effort };
        let result: AgentResult;
        try {
          if (input.reuseSession && !input.shadow && !input.persistSession && !req.resumeSessionId && prep.profile.transport === "acp") {
            result = await backgroundTurn(app, prep, req, `${task}${prep.awareness}`, input.runId, watch);
            credentialSucceeded(app, prep.profile);
          } else {
            result = await runBackend(app, prep.profile, req, watch);
          }
        } catch (e) {
          if (!quietAfterAll(app, input.runId, quietBefore, e)) throw e;
          emit({ type: "status", text: `这一轮已经用 stay_quiet 结束，后端收尾时出错（${(e as Error).message.slice(0, 120)}），按已完成处理` });
          credentialSucceeded(app, prep.profile);
          result = { text: "", stopReason: "end_turn", agent: prep.profile.name ?? prep.profile.id };
        }
        revokeToolToken(prep.token);
        clearDown(app, prep.profile);
        return { ...result, profileId: prep.profile.id, ai };
      } catch (e) {
        revokeToolToken(prep.token);
        const spent = noteQuota(app, prep.profile, e, emit);
        // A backend that failed before doing anything (it could not start, prepare its environment, log
        // in) is left for the next one too: nothing was done, so nothing is done twice.
        const busy = isRetryableAgentError(e);
        // The backend broke down (crash, dropped connection, silent past the watchdog, the upstream
        // stream cut off): another one takes over even midway, told what this attempt already wrote.
        const down = !busy && isBackendDown(e);
        // Set it (or its model) aside for a while, so the next runs go elsewhere first.
        noteBreakdown(app, prep.profile, e, emit);
        const untouched = !acted && writes() === writesBefore;
        if ((spent || e instanceof MemberOwnerQuotaChanged) && member && selectedMemberAccount(prep.profile)?.holder === OWNER && untouched && !writesBefore && !input.signal?.aborted) {
          slot.release();
          const retry = resolveRunProfile(app, { actor, profileId: profile.id, model: profile.model, effort: profile.effort });
          const next = await selectMemberRunAccount(app, retry, memberOptions);
          chain.splice(i + 1, 0, next);
          leftBecause = { busy: true, untouched: true, why: "本人额度紧张", first: i === 0 };
          failed = true;
          continue;
        }
        // The AI named for the run moves on only when it cannot take it (busy or broke down).
        const movable = e instanceof SandboxStartError || (pinned && i === 0 ? busy || down : busy || untouched || down);
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
    // The kept session was disposable: once continued (or not used), it is cleaned up as before.
    if (restarted?.sessionId && (restarted.ready ?? 0) >= 0) run(app.db, "update session_cleanup set ready = 1, retry_at = ? where session_id = ? and transport = 'acp' and ready = -1", now(), restarted.sessionId);
    // What the agent left in its artifacts folder (finish_task took what belongs to a task).
    if (inbox && input.runId) {
      const taken = await collectInbox(app, input.runId, { source: "agent", by: input.spec?.name ?? input.checkName ?? input.role }).catch((e: Error) => ({ made: [], skipped: [e.message] }));
      if (taken.made.length || taken.skipped.length) emit({ type: "status", text: takenText(taken) });
    }
  }
}

type Restarted = { at: string; writes: number; sessionId?: string; profileId?: string | null; cwd?: string; ready?: number };

/** The restart note of a run, once: later agent turns of the same run start as usual. */
function takeRestart(app: App, runId: string): Restarted | null {
  const row = one<{ r: string | null }>(app.db, "select json_extract(input, '$.restarted') r from runs where id = ? and json_extract(input, '$.restarted.used') is null", runId);
  if (!row?.r) return null;
  run(app.db, "update runs set input = json_set(input, '$.restarted.used', json('true')) where id = ?", runId);
  return json<Restarted>(row.r, { at: "", writes: 0 });
}

/** What the agent is told when it picks up a run a restart cut off: what it already wrote, by the run's own record. */
function restartNote(app: App, runId: string, r: Restarted) {
  const writes = all<{ data: string }>(app.db, "select data from run_events where run_id = ? and type = 'tool-write' order by seq limit ?", runId, r.writes).map((row) => {
    const d = json<{ name?: string; args?: unknown }>(row.data, {});
    return `- ${d.name ?? "?"} ${truncate(JSON.stringify(d.args ?? {}), 300)}`;
  });
  return [
    "# omem 重启打断了这次任务，现在接着做",
    "",
    r.sessionId ? "如果你还记得之前的对话，就从断开的地方接着做；不记得就按下面的任务重新看一遍现状再做。" : "之前的对话没有保留，按下面的任务重新看一遍现状再做。",
    writes.length ? `\n重启前已经做过这些写入，不要重复（已发的消息不要再发，写过的文件接着用）：\n${writes.slice(-30).join("\n")}` : "\n重启前还没有做过写入，可能已经读过一些材料。",
  ].join("\n");
}
