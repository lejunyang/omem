import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { deleteAcpSession, runAcp } from "./acp.ts";
import { runCli } from "./cli.ts";
import { deleteDoubaoSession, doubaoAppFor, doubaoApps, doubaoTokenExists, runDoubao } from "./doubao.ts";
import { DOUBAO_TOOL_NOTE, runDoubaoCli } from "./doubao-cli.ts";
import { archiveSession } from "./session-archive.ts";
import { sessionPrompt, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";

/** One turn on any backend: ACP, a CLI fallback, the Doubao CLI or the Doubao OpenAPI. */
export async function runBackend(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "acp") return runAcp(profile, req, emit);
  if (profile.transport === "doubao" || profile.transport === "doubao-cli") {
    // Doubao keeps every conversation in the owner's account: a one-off turn's session is deleted
    // once the turn is over, failed or not (ACP agents do the same with session/delete).
    let made: string | undefined;
    const track = (e: AgentEvent) => {
      if (e.type === "session" && !e.resumed) made = e.sessionId;
      emit(e);
    };
    try {
      const r = await runDoubaoTurn(app, profile, req, track);
      if (!r.sessionId || r.sessionId === req.resumeSessionId) made = undefined;
      else made = r.sessionId;
      return r;
    } finally {
      if (made && !req.persistSession && !req.resumeSessionId) await retireSession(app, profile, made, req.cwd, emit);
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
    if (!doubaoTokenExists(app.home)) {
      emit({ type: "status", text: "豆包 OpenAPI 没有在这台机器上授权，豆包 CLI 的会话留在豆包历史里（omem doubao login 后会自动删除 omem 建的会话）" });
      return;
    }
    const da = doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config));
    if (!da) {
      emit({ type: "status", text: "豆包会话没有删除：找不到授权过的豆包应用（omem doubao login），会话留在豆包历史里" });
      return;
    }
    await deleteDoubaoSession(app.home, da, sessionId);
    // Said every time: the CLI may be logged in to another account than the app deleting it.
    emit({ type: "status", text: `已经通过应用 ${da.appId} 删除豆包会话 ${sessionId}${profile.transport === "doubao-cli" ? "（豆包 CLI 登录的若是别的账号，它的历史里仍会留着）" : ""}` });
  } catch (e) {
    emit({ type: "status", text: `${profile.transport.startsWith("doubao") ? "豆包" : "后端"}会话清理失败：${(e as Error).message.slice(0, 160)}` });
  }
}
