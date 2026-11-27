import { createHash, randomBytes, randomUUID } from "node:crypto";
import { audit } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { activeUser, findUser, OWNER, scopeFor } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { searchRun } from "../search/trace.ts";
import { addRunEvent } from "./runs.ts";
import { callTool, toolList, toolSchemas, type ToolContext } from "./tools.ts";
import { cloudToolNames, type AgentProfile } from "../core/config.ts";
import { checkCloudAddress, cloudAccess } from "./cloud-probe.ts";
import type { AgentEvent, AgentRequest, AgentResult } from "./types.ts";

type Access = { mode: "header" | "url"; url: string };
type Grant = { ctx: ToolContext; runId: string; profile: AgentProfile; access: Access; hash: string; expires: number; limit: number; session?: string };
const grants = new Map<string, Grant>();
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const sanitized = (text: string) => text.replace(/oct_[\w-]+/g, "[云端凭据]");
const purposes: Record<(typeof cloudToolNames)[number], string> = {
  search: "检索材料", read_source: "读原件", read_page: "读 Wiki 页", read_item: "读事项",
  read_ledger: "读研究记录", propose_directions: "交研究方向", trial_report: "交试验证据和结果",
  record_finding: "交研究发现", close_direction: "结束方向", stage_report: "交流程阶段证据和结果",
};
const toolSummary = (tools: ReadonlySet<string>) => cloudToolNames.filter(name => tools.has(name)).map(name => `${name}（${purposes[name]}）`).join("、") || "无";

export function cloudToolGuide(tools: ReadonlySet<string>, mode: Access["mode"]) {
  return "\n\n## 云端工具\n本轮可用：" + toolSummary(tools) + "。GET 工具地址查看参数。" +
    (["trial_report", "record_finding", "stage_report"].some(name => tools.has(name))
      ? "沙箱文件宿主读不到，用对应工具的 evidence_text 交正文。" :
      tools.has("propose_directions") ? "用对应工具交结果。" : "") +
    (mode === "header" ? "带 Authorization，POST 地址/工具名，正文为 JSON 参数。" :
      "GET 地址/工具名?args=URL编码的JSON参数。每个地址只用一次，下次用响应里的 next。") +
    "只用本轮连接信息。按报错修正；授权结束或次数用完就停止。";
}
function rotate(g: Grant) {
  grants.delete(g.hash);
  const secret = "oct_" + randomBytes(32).toString("base64url");
  g.hash = hash(secret);
  grants.set(g.hash, g);
  return secret;
}
/** Credentials of runs that ended: a cloud sandbox keeps files between sessions, so a later run may find one in an old script. */
const retired = new Map<string, number>();
function revoke(g: Grant, reason: string) {
  if (!grants.delete(g.hash)) return;
  retired.set(g.hash, Date.now());
  if (retired.size > 500) retired.delete(retired.keys().next().value!);
  audit(g.ctx.app, g.ctx.userId ?? OWNER, "cloud-tools.revoke", g.runId, { reason });
}
export function revokeCloud(app: App, session?: string) {
  let count = 0;
  for (const g of grants.values()) if (g.ctx.app === app && (!session || session === g.session)) {
    revoke(g, session ? "清理会话" : "全部作废");
    count++;
  }
  return count;
}
export function cloudUsage(app: App) {
  const live = [...grants.values()].filter(g => g.ctx.app === app).map(g => ({ id: g.runId, limit: g.limit }));
  const active = one<{ n: number }>(app.db, `select count(*) n from json_each(?) j
    join runs r on r.id=json_extract(j.value,'$.id') and r.status='running'
    left join cloud_tool_usage u on u.run_id=r.id where coalesce(u.calls,0)<json_extract(j.value,'$.limit')`, JSON.stringify(live));
  return { activeCredentials: active!.n,
    availableTools: toolList(new Set(cloudToolNames)).map(({ name, description }) => ({ name, description: description.split("。")[0] + "。" })),
    recent: all(app.db, `select u.run_id as runId,r.title,u.calls,u.errors,u.last_error as lastError,u.at
      from cloud_tool_usage u join runs r on r.id=u.run_id order by u.at desc limit 50`) };
}
function remaining(g: Grant) {
  const used = one<{calls: number}>(g.ctx.app.db, "select calls from cloud_tool_usage where run_id=?", g.runId);
  return Math.max(0, g.limit - (used?.calls ?? 0));
}
const signedPath = (g: Grant, secret: string) => `${g.access.url}/api/tools/turn/${secret}`;

export async function cloudTurn(app: App, profile: AgentProfile, ctx: ToolContext, req: AgentRequest,
  emit: (e: AgentEvent) => void, execute: (req: AgentRequest, emit: (e: AgentEvent) => void) => Promise<AgentResult>) {
  const access = cloudAccess(app, profile);
  if (!ctx.runId || req.runId !== ctx.runId || !access.mode) throw new Error(access.reason ?? "缺少对应的云端运行");
  try { await checkCloudAddress(app, access.url); }
  catch {
    emit({ type: "status", text: "回调地址不可用，本轮只使用已有材料" });
    return execute({ ...req, system: req.system?.replace(/\n\n## 云端工具[\s\S]*?(?=\n\n---|$)/, ""),
      capabilities: { ...req.capabilities!, cloudHttp: false, omemAccess: "none" }, mcp: undefined, extraMcp: undefined }, emit);
  }
  req.signal?.throwIfAborted();
  if (cloudAccess(app, profile).mode !== access.mode) throw new HttpError(403, "云端权限已变化");
  const cfg = app.config.agents.cloudTools;
  const g: Grant = { ctx: { ...ctx, itemDiscoverySpaces: undefined, tools: new Set(cfg.tools.filter(t => ctx.tools?.has(t))) },
    runId: ctx.runId, profile, access, hash: "", expires: Date.now() + cfg.ttlMinutes * 60000, limit: cfg.maxCalls, session: req.resumeSessionId };
  const secret = rotate(g);
  const stop = () => revoke(g, "取消运行");
  req.signal?.addEventListener("abort", stop, { once: true });
  try {
    audit(app, ctx.userId ?? OWNER, "cloud-tools.issue", g.runId, { backend: profile.id, tools: [...g.ctx.tools!], spaces: ctx.spaces, expires: g.expires });
    const channel = access.mode === "url" ? { url: signedPath(g, secret) } : {
      url: access.url + "/api/tools", headers: { Authorization: "Bearer " + secret },
    };
    const turn = { ...req, mcp: undefined, extraMcp: undefined };
    if (cfg.credentialIn === "channel") turn.cloudChannel = channel;
    else {
      const connection = "\n\n本轮工具连接（仅用于请求，不要复述）\n" + JSON.stringify(channel);
      turn.prompt += connection;
      if (turn.freshPrompt) turn.freshPrompt += connection;
    }
    const result = await execute(turn, event => {
      if (event.type === "session") g.session = event.sessionId;
      // A streamed echo can split the token across frames. Emit the redacted, assembled reply once.
      if (event.type !== "text" && event.type !== "thought") emit(JSON.parse(sanitized(JSON.stringify(event))));
    });
    const clean: AgentResult = JSON.parse(sanitized(JSON.stringify(result)));
    if (clean.text) emit({ type: "text", text: clean.text });
    return clean;
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(sanitized(String(error)));
    if (error.stack) error.stack = sanitized(error.stack);
    if (sanitized(error.message) !== error.message)
      Object.defineProperty(error, "message", { value: sanitized(error.message), configurable: true });
    // Nested provider errors can contain the original request.
    delete error.cause;
    throw error;
  } finally {
    req.signal?.removeEventListener("abort", stop);
    revoke(g, "本轮结束");
  }
}

function current(g: Grant) {
  const { app } = g.ctx;
  const access = cloudAccess(app, g.profile);
  if (!grants.has(g.hash) || access.url !== g.access.url || access.mode !== g.access.mode ||
    !one(app.db, "select 1 from runs where id=? and status='running'", g.runId))
    throw new HttpError(403, "本轮授权已结束，请停止重试");
  // Renew on demand after checking the live turn. A quiet period in the sandbox does not end the run.
  const at = Date.now();
  if (at >= g.expires) g.expires = at + app.config.agents.cloudTools.ttlMinutes * 60_000;
}

function logFailure(g: Grant, error: string) {
  const reason = sanitized(error).slice(0, 500);
  run(g.ctx.app.db, `insert into cloud_tool_usage(run_id,calls,errors,last_error,at) values(?,0,1,?,?)
    on conflict(run_id) do update set errors=errors+1,last_error=excluded.last_error,at=excluded.at`,
  g.runId, reason.slice(0, 200), new Date().toISOString());
  return reason;
}

export async function cloudRequest(app: App, secret: string, mode: Access["mode"], name?: string, args?: unknown) {
  const g = grants.get(hash(secret));
  if (!g && retired.has(hash(secret))) throw new HttpError(401, "这是之前一次运行的凭据，已作废：沙箱里早先留下的脚本或文件里的地址和凭据都不能用。只用本轮消息（或安全通道）里给的连接信息重新请求");
  if (!g || g.ctx.app !== app) throw new HttpError(401, "凭据无效、已使用或已作废，请停止重试");
  try {
    if (g.access.mode !== mode) throw new HttpError(403, "凭据与本轮请求不符，请停止重试");
    current(g);
    if (!remaining(g)) throw new HttpError(429, "本次运行的调用次数已用完，请停止重试");
  } catch (e) {
    const reason = logFailure(g, (e as Error).message);
    addRunEvent(app, g.runId, "tool", { id: randomUUID(), title: "云端工具请求", kind: "omem", via: "cloud-http", status: "failed", output: reason });
    throw e;
  }
  // Reserve before any await, including rotating the URL so a concurrent replay cannot reuse it.
  const next = mode === "url" ? signedPath(g, rotate(g)) : undefined;
  run(app.db, `insert into cloud_tool_usage(run_id,calls,at) values(?,1,?) on conflict(run_id)
    do update set calls=calls+1,at=excluded.at`, g.runId, new Date().toISOString());
  const user = g.ctx.userId ?? OWNER;
  const tools = new Set(app.config.agents.cloudTools.tools.filter(t => g.ctx.tools?.has(t)));
  const id = randomUUID();
  const input = JSON.stringify(args ?? {});
  const title = sanitized(name ?? "/api/tools").slice(0, 80);
  const event = (status: string, details = {}) => addRunEvent(app, g.runId, "tool", { id, title, kind: "omem", via: "cloud-http", status, ...details });
  event("in_progress", { input: sanitized(input).slice(0, 2000) });
  try {
    if (!activeUser(findUser(app, user))) throw new HttpError(403, "成员已停用，请停止重试");
    if (input.includes("oct_")) throw new HttpError(400, "工具参数不能包含凭据");
    if (name !== undefined && ![...tools].some(t => t === name)) {
      const reason = `工具不在本轮名单内。本轮可用：${toolSummary(tools)}。请按括号里的用途选择工具，GET 本轮工具地址可查看参数。`;
      event("failed", { output: logFailure(g, reason) });
      return { text: reason, isError: true, next, remaining: remaining(g) };
    }
    const ctx: ToolContext = { ...g.ctx, via: "cloud-http", tools, spaces: scopeFor(app, user, g.ctx.spaces) };
    const result = name === undefined ? { tools: toolSchemas(tools) } : await searchRun.run(g.runId, () => callTool(ctx, name, args));
    current(g);
    if ("text" in result) result.text = sanitized(result.text);
    if ("isError" in result && result.isError) event("failed", { output: logFailure(g, result.text) });
    else event("completed");
    if ("text" in result && Buffer.byteLength(JSON.stringify(result)) > 32000)
      result.text = result.text.slice(0, 4900) + "\n结果超过 32 KB，已截断；请缩小范围，不要重复原请求。";
    return { ...result, next, remaining: remaining(g) };
  } catch (e) {
    const reason = logFailure(g, (e as Error).message);
    event("failed", { output: reason });
    if (e instanceof HttpError) throw new HttpError(e.status, reason);
    throw new Error(reason);
  }
}
