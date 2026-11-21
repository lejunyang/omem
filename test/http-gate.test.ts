import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { httpGate, httpWatch } from "../src/agents/http-gate.ts";
import { saveOperationRules } from "../src/agents/operation-policy.ts";
import { issueToolToken, type ToolContext } from "../src/agents/tools.ts";
import { auditRows } from "../src/auth/audit-view.ts";
import { run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const servers: FastifyInstance[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

function fixture() {
  const app = testApp();
  run(app.db, "insert into runs(id,kind,status,title,input,created_at) values('rtest','ask','running','操作网页','{}',?)", new Date().toISOString());
  const ctx: ToolContext = { app, runId: "rtest", spaceId: "personal", spaces: null, tools: null, actor: "agent" };
  const rules = () => saveOperationRules(app, [
    { id: "open", revision: 1, enabled: true, action: "allow", match: { kind: "http", host: "api.example.com", methods: ["POST"], pathRegex: "^/v1/refunds/preview$" } },
    { id: "refund", revision: 1, enabled: true, title: "退款接口不让 Agent 调", action: "deny", match: { kind: "http", host: "api.example.com", methods: ["post"], pathRegex: "^/v1/refunds" } },
    { id: "orders", revision: 1, enabled: true, action: "approve", match: { kind: "http", host: "*.example.org", methods: ["PUT", "DELETE"] }, approval: { waitSeconds: 1 } },
    { id: "big", revision: 1, enabled: true, action: "deny", match: { kind: "http", host: "pay.example.net", body: { jsonPath: "$.amount", regex: "^[0-9]{5,}$" } } },
    { id: "theirs", revision: 1, enabled: true, action: "deny", scope: { members: ["someone-else"] }, match: { kind: "http", host: "other.example.com" } },
    { id: "off", revision: 1, enabled: false, action: "deny", match: { kind: "http", host: "off.example.com" } },
    { id: "cmd", revision: 1, enabled: true, action: "deny", match: { kind: "command", executable: "acme" } },
  ]);
  const pendingAsk = async () => { await new Promise((r) => setTimeout(r, 20)); return listAsks(app, { status: "pending" })[0]!; };
  return { app, ctx, rules, pendingAsk };
}

it("要问哪些请求：只列对这个调用方生效、会拦或要批准的 HTTP 规则，规则变了 revision 跟着变", () => {
  const { app, ctx, rules } = fixture();
  expect(httpWatch(app, ctx)).toMatchObject({ watch: [] });
  rules();
  const first = httpWatch(app, ctx);
  expect(first.watch).toEqual([
    { host: "api.example.com", methods: ["POST"] },
    { host: "*.example.org", methods: ["DELETE", "PUT"] },
    { host: "pay.example.net", methods: null },
  ]);
  expect(httpWatch(app, { ...ctx, userId: "someone-else" }).watch).toContainEqual({ host: "other.example.com", methods: null });
  saveOperationRules(app, [{ id: "refund", revision: 1, enabled: true, action: "approve", match: { kind: "http", host: "api.example.com" } }]);
  expect(httpWatch(app, ctx).revision).not.toBe(first.revision);
});

it("拒绝、放行的口子、按正文字段匹配；判定记进审计，写的是方法、主机和路径", async () => {
  const { app, ctx, rules } = fixture();
  rules();
  const refund = await httpGate(app, ctx, { method: "post", url: "https://api.example.com/v1/refunds?token=secret-value", body: "{\"order\":42}", contentType: "application/json", page: { url: "https://shop.example.com/orders/42", title: "订单 42" } });
  expect(refund).toMatchObject({ decision: "deny" });
  expect(refund.message).toContain("退款接口不让 Agent 调");
  expect((await httpGate(app, ctx, { method: "POST", url: "https://api.example.com/v1/refunds/preview" })).decision).toBe("allow");
  expect((await httpGate(app, ctx, { method: "GET", url: "https://api.example.com/v1/refunds" })).decision).toBe("allow");
  expect((await httpGate(app, ctx, { method: "POST", url: "https://pay.example.net/transfer", body: "{\"amount\":120000}", contentType: "application/json" })).decision).toBe("deny");
  expect((await httpGate(app, ctx, { method: "POST", url: "https://pay.example.net/transfer", body: "{\"amount\":120}" })).decision).toBe("allow");
  expect((await httpGate(app, ctx, { method: "POST", url: "https://pay.example.net/transfer", body: "amount=120000", contentType: "application/x-www-form-urlencoded" })).decision).toBe("allow");
  expect((await httpGate(app, ctx, { method: "POST", url: "not a url" })).decision).toBe("deny");
  expect((await httpGate(app, ctx, { method: "GET", url: "data:text/plain,hello" })).decision).toBe("allow");
  const denied = auditRows(app, "owner", { group: "ops" }).rows.filter((r) => r.action === "http.deny");
  expect(denied.at(-1)).toMatchObject({ text: "HTTP 请求 · 拒绝", target: "POST api.example.com/v1/refunds", rule: "退款接口不让 Agent 调", runId: "rtest" });
  expect(JSON.stringify(denied)).not.toContain("secret-value");
});

it("要批准的请求：卡片写清请求和页面，没批准先不发；批准一次只放行同一个请求一次", async () => {
  const { app, ctx, rules, pendingAsk } = fixture();
  rules();
  const put = () => httpGate(app, ctx, { method: "PUT", url: "https://shop.example.org/v1/orders/42?x=1", page: { url: "https://shop.example.org/orders/42", title: "订单 42" } });
  const first = await put();
  expect(first.decision).toBe("pending");
  const ask = await pendingAsk();
  expect(first.askId).toBe(ask.id);
  expect(first.message).toContain("PUT shop.example.org/v1/orders/42");
  expect(ask.question).toContain("要发出受保护的请求");
  expect(ask.question).toContain("PUT shop.example.org/v1/orders/42");
  expect(ask.question).not.toContain("x=1");
  expect(ask.question).toContain("页面：订单 42 · https://shop.example.org/orders/42");
  await answerAsk(app, ask.id, { approved: true, by: "owner", choice: 0 });
  // Another path is another request: the approval does not cover it.
  expect((await httpGate(app, ctx, { method: "PUT", url: "https://shop.example.org/v1/orders/43" })).decision).toBe("pending");
  expect((await put()).decision).toBe("allow");
  expect((await put()).decision).toBe("pending");
});

it("接口只认本机带运行令牌的请求", async () => {
  const { app, rules } = fixture();
  rules();
  const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
  const token = issueToolToken({ runId: "rtest", spaceId: "personal", spaces: null, tools: null, actor: "agent" });
  const headers = { authorization: `Bearer ${token}` };
  expect((await server.inject({ url: "/api/operation-gate/http" })).statusCode).toBe(401);
  const watch = await server.inject({ url: "/api/operation-gate/http", headers });
  expect(watch.statusCode).toBe(200);
  expect(watch.json().watch).toHaveLength(3);
  const denied = await server.inject({ method: "POST", url: "/api/operation-gate/http", headers, payload: { method: "POST", url: "https://api.example.com/v1/refunds", body: "{}", contentType: "application/json", page: { url: "https://shop.example.com/" }, session: "s1" } });
  expect(denied.json()).toMatchObject({ decision: "deny" });
  expect((await server.inject({ method: "POST", url: "/api/operation-gate/http", headers, payload: { method: "GET", url: "https://www.example.com/" } })).json()).toEqual({ decision: "allow" });
  expect((await server.inject({ method: "POST", url: "/api/operation-gate/http", headers, payload: { url: "https://www.example.com/" } })).statusCode).toBe(400);
  expect((await server.inject({ method: "POST", url: "/api/operation-gate/http", headers: { ...headers, "x-forwarded-for": "203.0.113.9" }, payload: { method: "GET", url: "https://www.example.com/" } })).statusCode).toBe(403);
});
