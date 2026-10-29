import { createHash } from "node:crypto";
import type { App } from "../core/app.ts";
import { openAcp, runAcp, type AcpHandle } from "./acp.ts";
import type { PreparedRun } from "./runner.ts";
import { issueToolToken, retargetToolToken, revokeToolToken, toolContextForToken } from "./tools.ts";
import { sessionPrompt, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";

type Live = { key: string; handle: AcpHandle; token: string; busy: boolean; usedAt: number; usage?: AgentResult["contextUsage"]; timer?: NodeJS.Timeout; releasing?: Promise<void> };
const pools = new Map<App, Set<Live>>();

// Object key order and Set insertion order must not change the identity of a scope.
function stable(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}

async function release(app: App, entry: Live) {
  if (entry.releasing) return entry.releasing;
  pools.get(app)?.delete(entry);
  if (!pools.get(app)?.size) pools.delete(app);
  clearTimeout(entry.timer);
  revokeToolToken(entry.token);
  entry.releasing = entry.handle.discard();
  await entry.releasing;
}

export async function releaseBackgroundSessions(app?: App) {
  await Promise.all([...pools].filter(([owner]) => !app || owner === app).flatMap(([owner, pool]) => [...pool].map((entry) => release(owner, entry))));
}

process.once("exit", () => {
  for (const pool of pools.values()) for (const entry of pool) entry.handle.close();
});

/** Past the ratio of the window, or past the absolute token limit (`maxContextTokens`, 0: none). */
export function tooFull(usage: { used: number; size: number }, config: { maxContextRatio: number; maxContextTokens?: number }) {
  return usage.used / usage.size > config.maxContextRatio || (!!config.maxContextTokens && usage.used > config.maxContextTokens);
}

/** Only recurring jobs opt in. Conversations, coding chains and blind comparisons stay independent. */
export async function backgroundTurn(app: App, prep: PreparedRun, req: AgentRequest, task: string, runId: string | null, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const config = app.config.sessions.background;
  if (!config.enabled || config.maxLive === 0 || config.liveMinutes === 0) return runAcp(prep.profile, req, emit);
  const ctx = toolContextForToken(app, prep.token);
  if (!ctx) throw new Error("后台会话的工具权限已失效");
  const { app: _app, runId: _run, ...scope } = ctx;
  const key = createHash("sha256").update(JSON.stringify(stable({
    scope, system: prep.system, profile: prep.profile, cwd: prep.cwd,
    extraMcp: prep.extraMcp, allowWrites: prep.allowWrites, modes: prep.modes,
  }))).digest("hex");
  let pool = pools.get(app);
  if (!pool) { pool = new Set(); pools.set(app, pool); }
  let entry = [...pool].find((e) => !e.busy && e.key === key && e.handle.alive() && e.usage && !tooFull(e.usage, config));
  const continuing = !!entry;
  if (entry) {
    entry.busy = true;
    clearTimeout(entry.timer);
    retargetToolToken(entry.token, runId);
    emit({ type: "status", text: `复用后台会话 · 上下文 ${Math.round(entry.usage!.used / entry.usage!.size * 100)}%` });
  } else {
    const token = issueToolToken({ ...scope, runId });
    try {
      const handle = await openAcp(prep.profile, { ...req, mcp: { ...prep.mcp, token } }, emit);
      if (req.signal?.aborted) { await handle.discard(); throw new Error("CANCELLED"); }
      entry = { key, token, handle, busy: true, usedAt: Date.now() };
      // Another completed entry may have removed the empty pool while this one connected.
      pool = pools.get(app) ?? new Set();
      pools.set(app, pool);
      pool.add(entry);
      emit({ type: "status", text: "新建后台会话" });
    } catch (e) { revokeToolToken(token); throw e; }
  }
  try {
    if (req.signal?.aborted) throw new Error("CANCELLED");
    const prompt = continuing
      ? sessionPrompt({ resumed: true }, req, `（${prep.now}）\n\n# 本轮独立任务\n\n${task}\n\n只处理本轮列出的材料；历史任务不重复执行，旧材料需要时重新读取。`, emit)
      : sessionPrompt(entry.handle, req, req.prompt, emit);
    const result = await entry.handle.prompt(prompt, emit, req.signal);
    entry.usage = result.contextUsage;
    entry.usedAt = Date.now();
    if (!entry.usage || tooFull(entry.usage, config) || result.stopReason !== "end_turn") {
      emit({ type: "status", text: !entry.usage ? "后端未上报本轮上下文用量，下次使用新会话" : `释放后台会话 · 上下文 ${Math.round(entry.usage.used / entry.usage.size * 100)}%（${Math.round(entry.usage.used / 1000)}k）` });
      await release(app, entry);
    } else {
      entry.busy = false;
      entry.timer = setTimeout(() => { void release(app, entry!); }, config.liveMinutes * 60_000);
      entry.timer.unref();
      const idle = [...pool].filter((e) => !e.busy).sort((a, b) => a.usedAt - b.usedAt);
      while (pool.size > config.maxLive && idle.length) await release(app, idle.shift()!);
    }
    return result;
  } catch (e) {
    await release(app, entry);
    throw e;
  }
}
