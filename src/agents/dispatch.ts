import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { credentialSucceeded } from "./credentials.ts";
import { findAcpSession, runAcp } from "./acp.ts";
import { runCli } from "./cli.ts";
import { doubaoAppFor, doubaoApps, runDoubao } from "./doubao.ts";
import { retireRecordedSession, sessionCleanup } from "./session-cleanup.ts";
import { backendCapabilities } from "./capabilities.ts";
import { doubaoAcpProfile, doubaoAcpSessionId, doubaoFeatures, doubaoRetry, runDoubaoCli } from "./doubao-cli.ts";
import { probeFor } from "./probe.ts";
import { resolveModelOption } from "./models.ts";
import { afterTurn, quotaEvents } from "./quota.ts";
import { sessionPrompt, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";
import { networkEnvironment, withNetworkPolicy } from "./network-policy.ts";
import { cloudTurn } from "./cloud-tools.ts";
import { toolContextForToken, revokeToolToken } from "./tools.ts";

/** One turn on any backend: ACP, a CLI fallback, the Doubao CLI or the Doubao OpenAPI. */
export async function runBackend(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  try {
    const result = await withNetworkPolicy(app, profile, { signal: req.signal, runId: req.runId, stop: () => { if (req.mcp) revokeToolToken(req.mcp.token); } }, (p, signal) => {
      const turn = { ...req, capabilities: req.capabilities ?? backendCapabilities(p), signal, env: { ...req.env, ...networkEnvironment(app, p) } };
      const events = quotaEvents(app, p, emit);
      if (turn.capabilities.omemAccess !== "http") return runOn(app, p, turn, events);
      const ctx = req.mcp && toolContextForToken(app, req.mcp.token);
      if (!ctx) throw new Error("缺少本轮的工具权限");
      return cloudTurn(app, profile, ctx, turn, events, (request, watch) => runOn(app, p, request, watch));
    });
    credentialSucceeded(app, profile);
    return result;
  } finally {
    afterTurn(app, profile);
  }
}

async function runOn(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "acp") return runAcp(profile, { ...req, app, cleanup: await sessionCleanup(app, profile, req, emit) }, emit);
  if (profile.transport === "doubao-cli" && doubaoFeatures(profile).acp) {
    // A Doubao CLI that speaks ACP runs as an ACP agent. Its sessions stay under the Doubao CLI's cleanup
    // (it has no session/delete): deleted with `doubao delete`, or through the OpenAPI on older installs.
    if (profile.model) profile = { ...profile, model: resolveModelOption(profile.model, probeFor(app, profile)?.models ?? []).value };
    const cleanup = await sessionCleanup(app, profile, req, emit);
    const acpProfile = doubaoAcpProfile(profile);
    const resumeSessionId = req.resumeSessionId && doubaoAcpSessionId(req.resumeSessionId);
    // It loads a conversation from before ACP only once its session list has shown it.
    if (resumeSessionId?.startsWith("conversation-"))
      await doubaoRetry(() => findAcpSession(acpProfile, resumeSessionId, req.cwd, req.signal), req.signal).catch(() => null);
    return doubaoRetry(() => runAcp(acpProfile, {
      ...req, app,
      resumeSessionId,
      cleanup: { ...cleanup, discard: (id) => cleanup.discard(id) },
    }, emit), req.signal, () => emit({ type: "status", text: "豆包 CLI 的后台服务正在退出，稍后重新连接" }));
  }
  if (profile.transport === "doubao" || profile.transport === "doubao-cli") {
    // Doubao keeps every conversation in the owner's account: a one-off turn's session is deleted
    // once the turn is over, failed or not (ACP agents do the same with session/delete).
    const cleanup = await sessionCleanup(app, profile, req, emit);
    const discardAfterTurn = new Map<string, boolean>();
    const remember = (id: string) => {
      // A create receipt arriving after cancellation has no caller to retain the new session.
      const retain = !!req.persistSession && !(profile.transport === "doubao" && req.signal?.aborted);
      cleanup.created(id, retain);
      discardAfterTurn.set(id, !retain);
    };
    const track = (e: AgentEvent) => {
      if (e.type === "session" && !e.resumed) remember(e.sessionId);
      emit(e);
    };
    try {
      const r = await runDoubaoTurn(app, profile, req, track);
      if (r.sessionId && r.sessionId !== req.resumeSessionId && !discardAfterTurn.has(r.sessionId)) remember(r.sessionId);
      return r;
    } finally {
      for (const [id, discard] of discardAfterTurn) if (discard) await cleanup.discard(id);
    }
  }
  // The CLIs take no system prompt here: the instructions open a new session, a resumed one has them
  // (a session that cannot be resumed fails, and the caller starts a new one).
  return runCli(profile, { ...req, app, prompt: sessionPrompt({ resumed: !!req.resumeSessionId }, req, req.prompt, emit), system: undefined }, emit);
}

async function runDoubaoTurn(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "doubao") {
    const da = doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config));
    if (!da) throw new Error("豆包需要一个绑定了 App Secret 的飞书应用（omem setup → 飞书机器人），再运行 omem doubao login 授权");
    if (req.mcp || Object.keys(req.extraMcp ?? {}).length) emit({ type: "status", text: "豆包在云端运行，用不了 omem 的工具；只按提示里给的材料回答" });
    return runDoubao(profile, req, emit, { home: app.home, app: da });
  }
  if (Object.keys(req.extraMcp ?? {}).length) emit({ type: "status", text: "豆包 CLI 接不了额外的 MCP 服务器，只用 omem 的工具" });
  // The CLI requires its exact offered spelling, including spaces and capitalization.
  // Resolve here so profile defaults, role overrides and automatic choices all use the probe.
  if (profile.model) profile = { ...profile, model: resolveModelOption(profile.model, probeFor(app, profile)?.models ?? []).value };
  return runDoubaoCli(profile, { ...req, app, prompt: sessionPrompt({ resumed: !!req.resumeSessionId }, req, req.prompt, emit), system: undefined }, emit);
}

/**
 * Remove a backend session omem made and no longer needs (a one-off turn's, or a thread's that a
 * fresh one replaced). Only ids omem itself got back from the backend reach here. ACP agents archive
 * through their archive command or `session/delete` on a connection of their own; Doubao (the
 * OpenAPI, and the CLI's conversations through it when the OpenAPI is authorized on this machine)
 * deletes it; the claude/codex CLI fallbacks keep theirs. Never throws: a failure is a status line.
 */
export async function retireSession(app: App, profile: AgentProfile, sessionId: string, cwd: string, emit: (e: AgentEvent) => void = () => {}) {
  try {
    if (!["acp", "doubao", "doubao-cli"].includes(profile.transport)) return;
    if (await retireRecordedSession(app, sessionId, emit)) return;
    const cleanup = await sessionCleanup(app, profile, { cwd }, emit);
    cleanup.created(sessionId);
    await cleanup.discard(sessionId);
  } catch (e) {
    emit({ type: "status", text: `${profile.transport.startsWith("doubao") ? "豆包" : "后端"}会话清理失败：${(e as Error).message.slice(0, 160)}` });
  }
}
