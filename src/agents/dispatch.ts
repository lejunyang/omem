import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { runAcp } from "./acp.ts";
import { runCli } from "./cli.ts";
import { doubaoAppFor, doubaoApps, runDoubao } from "./doubao.ts";
import type { AgentEvent, AgentRequest, AgentResult } from "./types.ts";

/** One turn on any backend: ACP, a CLI fallback, or the Doubao OpenAPI. */
export async function runBackend(app: App, profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  if (profile.transport === "acp") return runAcp(profile, req, emit);
  if (profile.transport === "doubao") {
    const da = doubaoAppFor(app.home, profile, await doubaoApps(app.home, app.config));
    if (!da) throw new Error("豆包需要一个绑定了 App Secret 的飞书应用（omem setup → 飞书机器人），再运行 omem doubao login 授权");
    if (req.mcp || Object.keys(req.extraMcp ?? {}).length) emit({ type: "status", text: "豆包在云端运行，用不了 omem 的工具；只按提示里给的材料回答" });
    return runDoubao(profile, req, emit, { home: app.home, app: da });
  }
  return runCli(profile, req, emit);
}
