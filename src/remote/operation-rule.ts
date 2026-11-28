import { z } from "zod";
import { decide } from "../agents/operation-policy.ts";
import { parsedBody } from "../agents/http-gate.ts";
import type { App } from "../core/app.ts";
import { jsonPattern, operationRuleSchema } from "../core/config.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, newId } from "../core/util.ts";
import { getRecording, recordingEndpoints, recordingStepLabel } from "./recordings.ts";
import { isPathId, type Endpoint, type Req } from "./requests.ts";

export const proposalSchema = z.object({
  recording_id: z.string().min(1).optional(),
  request_id: z.string().min(1).optional().describe("read_recording part=requests 列出的请求编号"),
  method: z.string().trim().regex(/^[a-z]+$/i).optional(),
  host: z.string().trim().regex(/^[a-z0-9.-]+$/i).optional(),
  path: z.string().startsWith("/").optional().describe("一个具体请求的路径"),
  body: jsonPattern.optional(),
  action: operationRuleSchema.shape.action.default("approve"),
  approver: z.string().regex(/^(caller|owner|user:.+|lark:.+)$/).default("caller"),
  title: z.string().trim().min(1).max(1000),
}).refine(a => a.recording_id || a.request_id
  ? !!(a.recording_id && a.request_id) && !a.method && !a.host && !a.path
  : !!(a.method && a.host && a.path), "请指定一段录制和一个请求编号，或指定方法、主机和路径");

function recordedTarget(app: App, recordingId: string, requestId: string) {
  const recording = getRecording(app, recordingId, OWNER);
  const list = recordingEndpoints(recording.dir);
  for (const endpoint of list) {
    const request = endpoint.requests.find(r => r.id === requestId);
    if (request) return { list, request, label: recordingStepLabel(recording.dir, request.step) };
  }
  throw new HttpError(400, `录制里没有请求 ${requestId}`);
}

export function draftOperationRule(app: App, input: z.output<typeof proposalSchema>) {
  const recorded = input.recording_id ? recordedTarget(app, input.recording_id, input.request_id!) : null;
  const method = recorded?.request.method ?? input.method!.toUpperCase();
  const host = recorded?.request.host ?? input.host!;
  const path = recorded?.request.path ?? new URL("https://" + host + input.path!).pathname;
  if (recorded && !/^https?:\/\//i.test(recorded.request.url)) throw new HttpError(400, "请选择 HTTP 或 HTTPS 请求");
  if (host.includes(":")) throw new HttpError(400, "操作规则按主机名匹配，无法限定录制地址中的端口或 IPv6 地址");
  const segments = path.split("/");
  const regex = segments.map(s => isPathId(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  const displayPath = segments.map(s => isPathId(s) ? "*" : s).join("/");
  const rule = operationRuleSchema.parse({
    id: newId("http"), revision: 1, enabled: true, title: input.title, action: input.action,
    match: { kind: "http", host, methods: [method], pathRegex: "^" + regex + "$", body: input.body },
    approval: input.action === "approve" ? { approver: input.approver } : undefined,
    recording: recorded ? { id: input.recording_id, requestId: recorded.request.id, step: recorded.request.step } : undefined,
  });
  const check = recorded ? verifyRecording(app, rule, recorded.list, recorded.request) : null;
  return { rule, method, host, displayPath, check, stepLabel: recorded?.label };
}

function verifyRecording(app: App, rule: z.output<typeof operationRuleSchema>, list: Endpoint[], target: Req) {
  // Use the live gate's matcher on just the draft. A log action distinguishes a match
  // from both the default allow and a regex budget denial, whatever action was requested.
  const config = { ...app.config, security: { ...app.config.security, operationRules: [{ ...rule, action: "log" as const }] } };
  const preview: App = Object.assign(Object.create(app), { config });
  let matched = 0, reads = 0, noise = 0;
  let hitTarget = false;
  for (const endpoint of list) {
    for (const req of endpoint.requests) {
      const read = req.method === "GET" || req.method === "HEAD";
      if (read) reads++;
      if (endpoint.noise) noise++;
      if (!/^https?:\/\//i.test(req.url)) continue;
      const body = typeof req.sent === "string" ? parsedBody({ body: req.sent }) : req.sent;
      const decision = decide(preview, { kind: "http", method: req.method, url: req.url, body }, { member: OWNER });
      if (decision.action === "deny") throw new HttpError(400, "录制核对时正则匹配超限，请缩小条件");
      if (decision.action !== "log") continue;
      if (read || endpoint.noise) throw new HttpError(400, `规则命中${read ? "读请求" : "噪声请求"} ${req.id}，请重新选择或收窄条件`);
      matched++;
      if (req === target) hitTarget = true;
    }
  }
  if (!hitTarget) throw new HttpError(400, "规则未命中所选请求，请核对请求体字段条件");
  return { matched, reads, noise };
}
