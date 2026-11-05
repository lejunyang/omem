import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { deleteAcpSession, runAcp } from "./acp.ts";
import { runCli } from "./cli.ts";
import { doubaoAppFor, doubaoApps, runDoubao } from "./doubao.ts";
import { finishDoubaoCleanup, queueDoubaoCleanup } from "./doubao-cleanup.ts";
import { DOUBAO_TOOL_NOTE, runDoubaoCli } from "./doubao-cli.ts";
import { archiveSession } from "./session-archive.ts";
import { sessionPrompt, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";

/** One turn on any backend: ACP, a CLI fallback, the Doubao CLI or the Doubao OpenAPI. */
export async function runBackend(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "acp") return runAcp(profile, req, emit);
  if (profile.transport === "doubao" || profile.transport === "doubao-cli") {
    // Doubao keeps every conversation in the owner's account: a one-off turn's session is deleted
    // once the turn is over, failed or not (ACP agents do the same with session/delete).
    const disposable = !req.persistSession && !req.resumeSessionId;
    const da = disposable ? doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config)) : null;
    const made = new Set<string>();
    const remember = (id: string) => {
      made.add(id);
      if (disposable) queueDoubaoCleanup(app, id, profile.transport, profile.env?.DOUBAO_APP_ID ?? da?.appId, req.runId);
    };
    const track = (e: AgentEvent) => {
      if (e.type === "session" && !e.resumed) remember(e.sessionId);
      emit(e);
    };
    try {
      const r = await runDoubaoTurn(app, profile, req, track);
      if (r.sessionId && r.sessionId !== req.resumeSessionId) remember(r.sessionId);
      return r;
    } finally {
      if (disposable) for (const id of made) await retireSession(app, profile, id, req.cwd, emit);
    }
  }
  // The CLIs take no system prompt here: the instructions open a new session, a resumed one has them
  // (a session that cannot be resumed fails, and the caller starts a new one).
  return runCli(profile, { ...req, prompt: sessionPrompt({ resumed: !!req.resumeSessionId }, req, req.prompt, emit), system: undefined }, emit);
}

async function runDoubaoTurn(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "doubao") {
    const da = doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config));
    if (!da) throw new Error("豆包需要一个绑定了 App Secret 的飞书应用（omem setup → 飞书机器人），再运行 omem doubao login 授权");
    if (req.mcp || Object.keys(req.extraMcp ?? {}).length) emit({ type: "status", text: "豆包在云端运行，用不了 omem 的工具；只按提示里给的材料回答" });
    return runDoubao(profile, req, emit, { home: app.home, app: da });
  }
  if (Object.keys(req.extraMcp ?? {}).length) emit({ type: "status", text: "豆包 CLI 接不了额外的 MCP 服务器，只用 omem 的工具" });
  const system = req.mcp ? [req.system, DOUBAO_TOOL_NOTE].filter(Boolean).join("\n\n") : req.system;
  return runDoubaoCli(profile, { ...req, prompt: sessionPrompt({ resumed: !!req.resumeSessionId }, { ...req, system }, req.prompt, emit), system: undefined }, emit);
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
    if (profile.transport === "acp") {
      if (profile.archiveArgs?.length) await archiveSession(profile, sessionId, cwd);
      else await deleteAcpSession(profile, sessionId, cwd).catch((e) => {
        if (!/不支持删除会话/.test((e as Error).message)) throw e;
      });
      return;
    }
    if (profile.transport !== "doubao" && profile.transport !== "doubao-cli") return;
    const da = doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config));
    queueDoubaoCleanup(app, sessionId, profile.transport, profile.env?.DOUBAO_APP_ID ?? da?.appId);
    await finishDoubaoCleanup(app, sessionId, emit);
  } catch (e) {
    emit({ type: "status", text: `${profile.transport.startsWith("doubao") ? "豆包" : "后端"}会话清理失败：${(e as Error).message.slice(0, 160)}` });
  }
}
