import { createHmac } from "node:crypto";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, tx } from "../core/db.ts";
import { getSpace, spaceDir } from "../core/spaces.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { HttpError, now, sameSecret, sha256, truncate } from "../core/util.ts";
import { nodeId } from "../core/peers.ts";
import { can } from "../auth/permissions.ts";
import { cancelRun, createRun, getRun, type RunContext } from "./runs.ts";
import { backendLimitOf, backendUsedOf, excluded, limitOf, usedOf } from "./capacity.ts";
import { workAgentSpec } from "./work-device.ts";

export type WorkCaller = { user: string; token: string; workPair?: string };
const key = z.string().regex(/^[\w-]{1,100}$/);
const scope = z.object({ space: z.string().min(1).max(200), access: z.enum(["read", "write"]).default("read") }).strict();
const request = scope.extend({
  key, from: key, goal: z.string().min(1).max(32000), accept: z.string().min(1).max(8000),
  agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/).optional(),
  model: z.string().max(200).optional(), effort: z.string().max(50).optional(), deadline: z.string().datetime(),
}).strict();
export type WorkRequest = z.infer<typeof request>;
const lookup = z.object({ key }).strict();

function pairing(app: App, caller?: WorkCaller) {
  const hash = sha256(caller?.token ?? "");
  if (caller?.user !== OWNER || !one(app.db, "select 1 from api_tokens where token_hash=? and user_id=? and label like 'peer:%'", hash, caller.user))
    throw new HttpError(403, "派活需要本人设备的配对令牌");
  return caller.workPair ?? hash.slice(0, 16);
}

// Bind the command to both credentials without sending the direct bearer down the reverse tunnel.
function workRouteMac(pairHash: string, transportToken: string, command: string, args: object) {
  return createHmac("sha256", pairHash).update(JSON.stringify(["omem/work/v1", sha256(transportToken), command, args])).digest("hex");
}

// Both transports authenticate as a paired owner. On fallback the original pairing also signs the
// operation, its arguments and the particular reverse credential. A node name never grants access.
const routed = z.object({
  request: z.record(z.string(), z.unknown()), pair: z.string().regex(/^[a-f0-9]{16}$/), mac: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** The final hop uses its usual direct pairing even when the HTTP request travels back over a tunnel. */
export function reverseWorkBody(body: string, directToken: string, backToken: string) {
  let message;
  try { message = JSON.parse(body); } catch { return body; }
  if (!message || !Object.hasOwn(workCommands,message.command)) return body;
  const request = message.args ?? {};
  const hash = sha256(directToken);
  return JSON.stringify({ ...message, args: { request, pair: hash.slice(0,16), mac: workRouteMac(hash,backToken,message.command,request) } });
}

export function unpackWorkCommand(app: App, name: string, args: unknown, caller?: WorkCaller) {
  if (!args || typeof args !== "object" || !("request" in args)) return {args,caller};
  const envelope = routed.safeParse(args);
  if (!envelope.success) throw new HttpError(400,"设备派单凭据格式错误");
  const {request, pair, mac} = envelope.data;
  if (!caller || caller.user !== OWNER) throw new HttpError(403,"派活需要本人设备的配对令牌");
  const origin = one<{token_hash:string}>(app.db,
    "select token_hash from api_tokens where token_hash glob ? and user_id=? and label like 'peer:%'", pair + "*", OWNER);
  if (!origin || !sameSecret(mac, workRouteMac(origin.token_hash,caller.token,name,request)))
    throw new HttpError(403,"反向连接的派单与原配对不符");
  return {args:request,caller:{...caller,workPair:pair}};
}

function checkScope(app: App, pair: string, target: z.infer<typeof scope>, remote: boolean) {
  getSpace(app, target.space);
  if (!can(app, OWNER, "sources.view", target.space) || target.access === "write" && !canWrite(app, OWNER, target.space))
    throw new HttpError(403, "配对用户没有这个空间所需的权限");
  const policy = app.config.node.acceptWorkFrom?.[pair] ?? app.config.node.acceptWork ?? "off";
  if (remote && (policy === "off" || policy === "read" && target.access === "write"))
    throw new HttpError(403, policy === "off" ? "对方已关闭接活" : "对方只接只读任务");
  return policy;
}

async function inventory(app: App, args: { target?: z.infer<typeof scope>; remote?: boolean }, caller?: WorkCaller) {
  const pair = pairing(app, caller);
  if (args.target) checkScope(app, pair, args.target, !!args.remote);
  const { listAgentProfiles } = await import("./runner.ts");
  const backends = listAgentProfiles(app).filter(p => p.installed && !p.peer && p.transport === "acp" && !excluded(app, p)).map(p => ({
    id: p.id, name: p.name ?? p.id, free: Math.max(0, Math.min(limitOf(app,p) - usedOf(app,p), (backendLimitOf(app,p) ?? Infinity) - backendUsedOf(app,p))),
  }));
  return { version: 1, routedWork: true, device: nodeId(app), backends, repos: all<{ id: string; name: string }>(app.db, "select id,name from spaces where kind='repo' order by id limit 500"),
    acceptWork: app.config.node.acceptWorkFrom?.[pair] ?? app.config.node.acceptWork ?? "off" };
}

function incoming(app: App, pair: string, key: string) {
  return one<{ id: string }>(app.db, "select id from runs where kind='peer-work' and json_extract(input,'$.pair')=? and json_extract(input,'$.request.key')=?", pair,key)?.id;
}

function accept(app: App, req: WorkRequest, caller?: WorkCaller) {
  const pair = pairing(app, caller);
  return tx(app.db, () => {
    const existing = incoming(app, pair, req.key);
    if (existing) return { runId: existing };
    checkScope(app, pair, req, true);
    if (req.deadline <= now()) throw new HttpError(409, "任务期限已过");
    const r = createRun(app, { kind: "peer-work", userId: OWNER, spaceId: req.space, title: truncate(`从 ${req.from} 设备派来的：${req.goal}`, 120),
      input: { pair, request: req, spaces: [req.space] }, trigger: { via: "peer", where: req.from, by: { key: "user:owner", name: "你" } } });
    return { runId: r.id };
  });
}

export async function runIncomingWork(ctx: RunContext) {
  const { app } = ctx;
  const req = ctx.run.input.request as WorkRequest;
  checkScope(app, String(ctx.run.input.pair), req, true);
  const remaining = Date.parse(req.deadline) - Date.now();
  if (remaining <= 0) throw new Error("任务期限已过");
  const space = getSpace(app, req.space);
  const spec = workAgentSpec(app, req.agent, space.id);
  const { runRole, listAgentProfiles, resolveRunProfile } = await import("./runner.ts");
  const preferred = resolveRunProfile(app, { actor: spec ? { spec } : { role: "assistant" } });
  const available = listAgentProfiles(app).filter(p => p.installed && !p.peer && p.transport === "acp" && !excluded(app,p));
  const backend = available.find(p => p.id === preferred.id) ?? available[0];
  if (!backend) throw new Error("接活设备没有可用的 ACP 后端");
  const { validateExecution } = await import("./execution.ts");
  let execution;
  try { execution = validateExecution(app, { profile: backend.id, model: req.model, effort: req.effort, source: "auto", reason: "派单的模型偏好" }); } catch { /* Use this device's own defaults. */ }
  const result = await runRole(app, { role: "assistant", spec, execution, profileId: backend.id, ownAI: true, boardAccess: req.access,
    cwd: space.rootPath ?? spaceDir(app,space.id), spaceId: space.id, spaces: [space.id], readScope: [space.id], runId: ctx.run.id,
    requiredTools: ["read_source"], addTools: ["attach_artifact"], artifacts: true, lark: { chats: [] },
    task: `${req.goal}\n\n验收条件：${req.accept}`, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(Math.min(remaining, 2147483647))]),
    onEvent: e => ctx.event(e.type,e) });
  return { answer: result.text, ai: result.ai };
}

function ownedRun(app: App, key: string, caller?: WorkCaller) {
  const id = incoming(app, pairing(app, caller), key);
  if (!id) throw new HttpError(404, "没有这次派单");
  return getRun(app, id);
}

async function status(app: App, args: z.infer<typeof lookup>, caller?: WorkCaller) {
  const r = ownedRun(app, args.key, caller);
  const ids = r.status === "done" ? all<{ id: string }>(app.db, "select id from run_artifacts where run_id=? order by id limit 100", r.id) : [];
  const evidence = ids.length ? (await import("../studies/remote-host.ts")).evidenceFiles(app, ids.map(a => a.id)) : { files: [], omitted: [] };
  const usage = one<{ input: number; output: number; cached: number | null }>(app.db, `select json_extract(data,'$.input') input,json_extract(data,'$.output') output,json_extract(data,'$.cached') cached
    from run_events where run_id=? and type='usage' and json_type(data,'$.input')='integer' and json_type(data,'$.output')='integer' order by seq desc limit 1`,r.id);
  const used = one<{ n: number | null }>(app.db,"select json_extract(data,'$.used') n from run_events where run_id=? and type='usage' order by seq desc limit 1",r.id)?.n ?? null;
  const raw = String(r.output.answer ?? "");
  const answer = truncate(raw,64000).replace(/\[([^\]]*)\]\((src:[^)]+)\)/g, `$1（在 ${nodeId(app)} 上，$2）`);
  if (raw.length > 64000) evidence.omitted.push("回答超过带回上限，完整回答在对方运行页");
  if (evidence.omitted.length) evidence.omitted.push(`在 ${nodeId(app)} 上看：${app.baseUrl}/#/runs/${r.id}`);
  return { runId: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, answer, ai: r.ai, error: r.error, usage, used, ...evidence };
}
export type WorkResult = Awaited<ReturnType<typeof status>>;
export type WorkInventory = Awaited<ReturnType<typeof inventory>>;

export const workCommands = {
  "work-info": { description: "派单协议、可用后端和仓库空间", schema: z.object({ target: scope.optional(), remote: z.boolean().optional() }).strict(), run: inventory },
  "work-accept": { description: "按配对授权接一块任务", schema: request, run: accept },
  "work-status": { description: "查询这台设备派来的尝试", schema: lookup, run: status },
  "work-cancel": { description: "取消这台设备派来的尝试", schema: lookup, run: (app: App, args: z.infer<typeof lookup>, caller?: WorkCaller) => {
    const pair = pairing(app,caller);
    // A cancel may overtake a request whose response was lost. Keep its key invalidated.
    const id = incoming(app,pair,args.key) ?? createRun(app, { kind: "peer-work", userId: OWNER,
      title: "已作废的设备尝试", input: { pair, request: { key: args.key } } }).id;
    return { status: cancelRun(app,id).status };
  } },
};
