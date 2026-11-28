import { expect, it } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { httpWatch } from "../src/agents/http-gate.ts";
import { currentRules, decide, saveOperationRules } from "../src/agents/operation-policy.ts";
import { callTool, contextToolNames, type ToolContext } from "../src/agents/tools.ts";
import { createUser } from "../src/core/users.ts";
import { askCard } from "../src/channels/lark-asks.ts";
import { importRecording, importSchema } from "../src/remote/import.ts";
import { readRecording } from "../src/remote/recordings.ts";
import { draftOperationRule, proposalSchema, proposeOperationRule } from "../src/remote/operation-rule.ts";
import { testApp } from "./helpers.ts";

const host = "shop.example.test";
const path = "/api/v1/orders/8812/cancel";
const title = "取消订单";
function fixture() {
  const app = testApp();
  const request = (method: string, path: string, at: number) => ({ method, url: "https://" + host + path, at });
  const rec = importRecording(app, "owner", importSchema.parse({
    steps: [{ kind: "action", at: 1, action: { kind: "click", label: title } },
      { kind: "action", at: 3, action: { kind: "click", label: "取消另一笔订单" } }],
    network: [
      { ...request("POST", path + "?ticket=demo", 2), requestBody: '{"state":"open","intent":"cancel"}' },
      { ...request("POST", path.replace("8812", "5432"), 3), requestBody: '{"state":"closed"}' },
      request("GET", path, 4), request("HEAD", path, 5),
      { ...request("POST", "/metrics", 6), type: "Ping" },
      request("POST", path.replace("cancel", "preview"), 7),
    ],
  }));
  const input = { recording_id: rec.id, request_id: "req-1", title };
  return { app, input, draft: (params = {}) => draftOperationRule(app, proposalSchema.parse({ ...input, ...params })) };
}

it("用所有调用核对接口形状，保存来源和步骤，查询串不入规则", () => {
  const { app, draft, input } = fixture();
  expect(readRecording(app, input.recording_id, "owner", { part: "requests" })).toContain("第 1 步 [req-1]、第 2 步 [req-2]");
  expect(draft({ request_id: "req-2" })).toMatchObject({ rule: { recording: { step: 2 } }, stepLabel: "取消另一笔订单" });
  expect(draft()).toMatchObject({
    rule: { action: "approve", approval: { approver: "caller" }, recording: { id: input.recording_id, requestId: "req-1", step: 1 },
      match: { kind: "http", host, methods: ["POST"], pathRegex: "^/api/v1/orders/[^/]+/cancel$" } },
    check: { matched: 2, reads: 2, noise: 1 }, stepLabel: title,
  });
  expect(draft({ body: { jsonPath: "$.state", regex: "^open$" } }).check?.matched).toBe(1);
  expect(() => draft({ body: { jsonPath: "$.state", regex: "^closed$" } })).toThrow(/未命中/);
  expect(() => draft({ request_id: "req-3" })).toThrow(/读请求/);
  expect(() => draft({ request_id: "req-5" })).toThrow(/噪声/);
  expect(() => draft({ request_id: "missing" })).toThrow(/没有请求/);
});

it("直接指定接口时转义固定段、泛化 UUID 和哈希，并明确没有录制核对", () => {
  const input = { method: "patch", host, path: "/v2/a.b+/123e4567-e89b-12d3-a456-426614174000/abcdefabcdef0123?dry=1", title };
  const draft = draftOperationRule(testApp(), proposalSchema.parse(input));
  expect(draft.rule.match).toEqual({ kind: "http", host, methods: ["PATCH"], pathRegex: "^/v2/a\\.b\\+/[^/]+/[^/]+$" });
  expect(draft.check).toBeNull();
  expect(proposalSchema.safeParse({ ...input, recording_id: "r" }).success).toBe(false);
  expect(proposalSchema.safeParse({ title, request_id: "q" }).success).toBe(false);
});

it("草稿只给本人确认，启用时保留最新规则并排在宽泛放行之前，aad 开始监听", async () => {
  const { app, input } = fixture();
  const ctx: ToolContext = { app, userId: "owner", actor: "agent", runId: null, spaceId: "personal", spaces: null, tools: null };
  createUser(app, { id: "member", name: "成员" });
  const member = { ...ctx, userId: "member" };
  const tool = "propose_operation_rule";
  expect(contextToolNames(member).has(tool)).toBe(false);
  expect((await callTool(member, tool, input)).isError).toBe(true);
  expect(listAsks(app)).toEqual([]);
  expect((await callTool(ctx, tool, input)).isError).toBe(false);
  const [ask] = listAsks(app, { status: "pending" });
  expect(ask).toMatchObject({ userId: "owner", options: [{ label: "启用" }, { label: "不用" }] });
  const card = JSON.stringify(askCard(app, ask!));
  for (const text of [host, "POST /api/v1/orders/*/cancel", "要发起人批准", "第 1 步", title, "req-1", "命中 2 次", "读请求 2 个、噪声请求 1 个"]) expect(card).toContain(text);
  await expect(answerAsk(app, ask!.id, { by: "member", choice: 0 })).rejects.toThrow(/只有本人/);
  expect(currentRules(app)).toHaveLength(0);
  expect(httpWatch(app, ctx).watch).toEqual([]);

  const allow = { enabled: true, revision: 1, action: "allow" } as const;
  saveOperationRules(app, [
    { ...allow, id: "one-order", match: { kind: "http", host, pathRegex: "^/api/v1/orders/2345/cancel$" } },
    { ...allow, id: "other", match: { kind: "http", host: "other.example.test" } },
    { ...allow, id: "orders", match: { kind: "http", host: "*.example.test", pathRegex: "^/api/v1/orders/[0-9]+/" } },
  ]);
  await answerAsk(app, ask!.id, { by: "owner", choice: 0 });
  const rules = currentRules(app);
  expect(rules.map(r => r.id)).toEqual(["one-order", "other", rules[2]!.id, "orders"]);
  expect(rules[2]).toMatchObject({ title, approval: { approver: "caller" }, recording: { id: input.recording_id, requestId: "req-1", step: 1 } });
  expect(decide(app, { kind: "http", method: "POST", url: "https://" + host + path }, { member: "member" }).action).toBe("approve");
  expect(httpWatch(app, member).watch).toEqual([{ host, methods: ["POST"] }]);
  await expect(answerAsk(app, ask!.id, { by: "owner", choice: 0 })).rejects.toThrow(/回答过/);
});

it.each([
  { name: "草稿不限请求体", body: undefined },
  { name: "两个不同字段同时满足条件", body: { jsonPath: "$.intent", regex: "^cancel$" } },
])("$name 时启用审批后优先于带正文条件的放行规则", async ({ body }) => {
  const { app, input } = fixture();
  const ask = proposeOperationRule(app, null, proposalSchema.parse({ ...input, body }));
  saveOperationRules(app, [{
    id: "open-orders", enabled: true, revision: 1, action: "allow",
    match: { kind: "http", host, methods: ["POST"], pathRegex: "^/api/", body: { jsonPath: "$.state", regex: "^open$" } },
  }]);
  const op = { kind: "http" as const, method: "POST", url: "https://" + host + path, body: { state: "open", intent: "cancel" } };
  const who = { member: "owner" };
  expect(decide(app, op, who)).toMatchObject({ action: "allow", rule: { id: "open-orders" } });
  await answerAsk(app, ask.id, { by: "owner", choice: 0 });
  expect(decide(app, op, who)).toMatchObject({ action: "approve", rule: { title } });
  expect(decide(app, { ...op, url: op.url.replace("/cancel", "/preview") }, who)).toMatchObject({ action: "allow", rule: { id: "open-orders" } });
  if (body) {
    expect(decide(app, { ...op, body: { state: "open" } }, who)).toMatchObject({ action: "allow", rule: { id: "open-orders" } });
  }
});

it("选择不用或指定有误时不增加规则；无录制的草稿标出核对范围和动作", async () => {
  const { app, input } = fixture();
  const ctx: ToolContext = { app, actor: "agent", runId: null, spaceId: "personal", spaces: null, tools: null };
  const tool = "propose_operation_rule";
  expect((await callTool(ctx, tool, { ...input, request_id: "req-5" })).isError).toBe(true);
  expect(listAsks(app)).toHaveLength(0);
  const r = await callTool(ctx, tool, { host, method: "DELETE", path, title, action: "deny", body: { jsonPath: "$.mode", regex: "^live$" } });
  expect(r.isError).toBe(false);
  const [ask] = listAsks(app);
  for (const part of ["未经录制核对", "拒绝请求", "$.mode", "^live$"]) expect(ask!.question).toContain(part);
  await answerAsk(app, ask!.id, { by: "owner", choice: 1 });
  expect(currentRules(app)).toHaveLength(0);
});

it("按整段录制的命中范围排序，包含同一接口的第二次调用", async () => {
  const { app, input } = fixture();
  const ask = proposeOperationRule(app, null, proposalSchema.parse({ ...input, body: { jsonPath: "$.state", regex: "^(open|closed)$" } }));
  const allow = (state: string) => ({
    id: state, enabled: true, revision: 1, action: "allow" as const,
    match: { kind: "http" as const, host, pathRegex: "^/api/", body: { jsonPath: "$.state", regex: "^" + state + "$" } },
  });
  saveOperationRules(app, [allow("archived"), allow("closed")]);
  await answerAsk(app, ask.id, { by: "owner", choice: 0 });
  expect(currentRules(app).map(r => r.title ?? r.id)).toEqual(["archived", title, "closed"]);
  const url = "https://" + host + path.replace("8812", "5432");
  expect(decide(app, { kind: "http", method: "POST", url, body: { state: "closed" } }, { member: "owner" }).action).toBe("approve");
});

it("直接指定接口时卡片说明可能重叠时的顺序，启用后按正文决定", async () => {
  const app = testApp();
  const ask = proposeOperationRule(app, null, proposalSchema.parse({
    host, method: "POST", path, title, body: { jsonPath: "$.intent", regex: "^cancel$" },
  }));
  expect(ask.question).toContain("可能重叠的放行规则");
  saveOperationRules(app, [{
    id: "open", enabled: true, revision: 1, action: "allow",
    match: { kind: "http", host, pathRegex: "^/api/", body: { jsonPath: "$.state", regex: "^open$" } },
  }]);
  await answerAsk(app, ask.id, { by: "owner", choice: 0 });
  const op = { kind: "http" as const, method: "POST", url: "https://" + host + path };
  const who = { member: "owner" };
  expect(decide(app, { ...op, body: { state: "open", intent: "cancel" } }, who).action).toBe("approve");
  expect(decide(app, { ...op, body: { state: "open" } }, who)).toMatchObject({ action: "allow", rule: { id: "open" } });
});
