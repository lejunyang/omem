import { z } from "zod";
import { createAsk, registerAskAction } from "../agents/asks.ts";
import { currentRules, decide, saveOperationRules } from "../agents/operation-policy.ts";
import { parsedBody } from "../agents/http-gate.ts";
import { audit } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { jsonPattern, operationRuleSchema, type OperationRule } from "../core/config.ts";
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
  approver: z.string().regex(/^(caller|owner|user:.+|lark:.+)$/).default("caller").describe("默认 caller，谁发起运行就由谁审批。只有本人明确指定其他审批人时才更改。"),
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
  return { rule, method, host, path, displayPath, check, stepLabel: recorded?.label };
}

/** Run the gate's bounded matcher on a single rule without changing the live config.
 * A log action distinguishes a match from default allow and regex budget denial. */
function previewRule(app: App, rule: OperationRule): App {
  const config = { ...app.config, security: { ...app.config.security, operationRules: [{ ...rule, action: "log" as const }] } };
  return Object.assign(Object.create(app), { config });
}

function verifyRecording(app: App, rule: OperationRule, list: Endpoint[], target: Req) {
  const preview = previewRule(app, rule);
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

export function proposeOperationRule(app: App, runId: string | null, input: z.output<typeof proposalSchema>) {
  const { rule, method, host, path, displayPath, check, stepLabel } = draftOperationRule(app, input);
  const by = input.approver === "caller" ? "发起人" : input.approver === "owner" ? "本人" : input.approver;
  const action = { approve: `要${by}批准`, deny: "拒绝请求", allow: "放行请求", log: "记录后放行" }[rule.action];
  const source = rule.recording;
  const where = source?.step ? `第 ${source.step} 步${stepLabel ? `「${stepLabel}」` : ""}` : "未关联操作步骤";
  return createAsk(app, {
    runId, userId: OWNER, question: [
      `启用「${rule.title}」吗？`,
      `在 ${host} 上调用 \`${method} ${displayPath}\` 时，${action}。`,
      input.body && `仅当请求体字段 \`${input.body.jsonPath}\` 匹配正则 \`${input.body.regex}\` 时生效。`,
      source && `录制 ${source.id}，${where}，请求 ${source.requestId}。`,
      check ? `核对了整段录制：命中所选请求，共命中 ${check.matched} 次。读请求 ${check.reads} 个、噪声请求 ${check.noise} 个，均未命中。` : "按指定的方法、主机和路径起草，未经录制核对。",
      "启用后排在覆盖该接口的宽泛放行规则之前。可在设置 → 安全 → 操作规则中删除。",
    ].filter(Boolean).join("\n\n"),
    options: [{ label: "启用" }, { label: "不用" }], allowText: false,
    context: { handler: "operation-rule-enable", rule, path },
  });
}

registerAskAction("operation-rule-enable", (app, ask, context) => {
  if (ask.userId !== OWNER || ask.answeredBy !== OWNER) throw new HttpError(403, "只有本人可以确认操作规则");
  if (ask.choice === 1) return "已放弃草稿。";
  if (ask.choice !== 0) throw new HttpError(400, "请选择启用或不用");
  const rule = operationRuleSchema.parse(context.rule);
  const m = rule.match;
  if (m.kind !== "http") throw new HttpError(400, "请选择网页请求规则");
  const rules = currentRules(app).slice();
  // Match the concrete path, so existing numeric/prefix allow patterns are found too.
  // For regexes on the same body field give the new rule priority on overlap.
  const op = { kind: "http" as const, method: m.methods![0]!, url: "https://" + m.host + String(context.path) };
  const before = rules.findIndex(existing => {
    const match = existing.match;
    if (existing.action !== "allow" || match.kind !== "http") return false;
    if (match.body && match.body.jsonPath !== m.body?.jsonPath) return false;
    const preview = previewRule(app, { ...existing, enabled: true, scope: undefined, match: { ...match, body: undefined } });
    return decide(preview, op, { member: OWNER }).action === "log";
  });
  rules.splice(before < 0 ? rules.length : before, 0, rule);
  saveOperationRules(app, rules);
  audit(app, OWNER, "operation.rules", "security", { ruleId: rule.id, recording: rule.recording, askId: ask.id });
  return `已启用「${rule.title}」。`;
});
