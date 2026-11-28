import { expect, it } from "vitest";
import { importRecording, importSchema } from "../src/remote/import.ts";
import { draftOperationRule, proposalSchema } from "../src/remote/operation-rule.ts";
import { testApp } from "./helpers.ts";

const host = "shop.example.test";
const path = "/api/v1/orders/8812/cancel";
const title = "取消订单";
function fixture() {
  const app = testApp();
  const request = (method: string, path: string, at: number) => ({ method, url: "https://" + host + path, at });
  const rec = importRecording(app, "owner", importSchema.parse({
    steps: [{ kind: "action", at: 1, action: { kind: "click", label: title } }],
    network: [
      { ...request("POST", path + "?ticket=demo", 2), requestBody: '{"state":"open"}' },
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
  const { draft, input } = fixture();
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
