import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { saveOperationRules } from "../src/agents/operation-policy.ts";
import { createRun } from "../src/agents/runs.ts";
import { auditRows } from "../src/auth/audit-view.ts";
import { audit } from "../src/auth/permissions.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const servers: FastifyInstance[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

function seed() {
  const app = testApp();
  createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
  createUser(app, { id: "wang", name: "小王" });
  addMember(app, "shop", "wang", "editor");
  upsertSource(app, { spaceId: "shop", kind: "chat", uri: "lark:oc_demo", title: "退款答疑群", text: "x" });
  saveOperationRules(app, [{ id: "mr", revision: 1, enabled: true, title: "建合并请求前问本人", match: { kind: "command", executable: "acme", subcommand: ["mr", "create"] }, action: "approve", approval: { approver: "owner", waitSeconds: 60 } }]);
  // Oldest first, as they would be written.
  audit(app, "owner", "space.member", "shop", { user: "wang", role: "editor" });
  audit(app, "agent", "lark.mention-reply", "oc_demo", { runId: "r0maaaaaaaaaaaaaaaaa", by: "auto", text: "周四上线后生效。" });
  audit(app, "owner", "lark.mention-reply.drop", "oc_demo", { reason: "对方撤回了问题" });
  audit(app, "wang", "command.approve", "acme", { kind: "command", member: "wang", runId: "r0mbbbbbbbbbbbbbbbbb", ruleId: "mr", action: "approve", result: "策略判定", commandLine: "acme mr create" });
  audit(app, "owner", "command.approve", "acme", { kind: "command", member: "wang", ruleId: "mr", approver: "本人", result: "本人 批准" });
  audit(app, "wang", "tool.deny", "lark_send", { kind: "tool", member: "wang", ruleId: "gone", action: "deny", result: "denied" });
  audit(app, "owner", "connection.add", "owner", { provider: "connect-github" });
  audit(app, "owner", "something.new", "whatever", { result: "照原样" });
  return app;
}

it("目标是一次运行时显示它的标题并能点过去", () => {
  const app = testApp();
  const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款按已发货行分摊" });
  audit(app, "owner", "share.review", r.id, { share: "sh1" });
  expect(auditRows(app, "owner").rows[0]).toMatchObject({ text: "分享评审", target: "退款按已发货行分摊", runId: r.id });
});

it("每一行用人话说：谁、做了什么、对谁、结果怎样；按类分组，新的在前", () => {
  const app = seed();
  const { rows, more } = auditRows(app, "owner");
  expect(more).toBe(false);
  expect(rows.map((r) => [r.group, r.actor, r.text, r.target, r.result, r.tone, r.rule])).toEqual([
    ["other", "你", "something.new", "whatever", "照原样", null, null],
    ["other", "你", "连接应用", "", "connect-github", null, null],
    ["ops", "小王的运行", "工具 · 拒绝", "lark_send", "拒绝", "danger", null],
    ["ops", "你", "命令 · 批准", "acme", "本人 批准", "ok", "建合并请求前问本人"],
    ["ops", "小王的运行", "命令 · 要批准", "acme mr create", null, "warn", "建合并请求前问本人"],
    ["identity", "你", "给找你的人的回复没有发出", "退款答疑群", "对方撤回了问题", "warn", null],
    ["identity", "助手", "自动回复了找你的人", "退款答疑群", "周四上线后生效。", null, null],
    ["access", "你", "空间成员", "示例商城", "小王 · editor", null, null],
  ]);
  expect(rows[4].runId).toBe("r0mbbbbbbbbbbbbbbbbb");
  expect(rows[6].detail).toMatchObject({ by: "auto" });
});

it("按类筛、往前翻；不是本人的看不到记下的原样内容", () => {
  const app = seed();
  expect(auditRows(app, "owner", { group: "ops" }).rows.map((r) => r.action)).toEqual(["tool.deny", "command.approve", "command.approve"]);
  expect(auditRows(app, "owner", { group: "identity" }).rows).toHaveLength(2);
  expect(auditRows(app, "owner", { group: "access" }).rows.map((r) => r.action)).toEqual(["space.member"]);
  expect(auditRows(app, "owner", { group: "other" }).rows.map((r) => r.action)).toEqual(["something.new", "connection.add"]);
  const first = auditRows(app, "owner", { limit: 3 });
  expect(first.more).toBe(true);
  const next = auditRows(app, "owner", { limit: 3, before: first.rows[2].id });
  expect(next.rows.map((r) => r.id)).toEqual([first.rows[2].id - 1, first.rows[2].id - 2, first.rows[2].id - 3]);
  const seen = auditRows(app, "wang");
  expect(seen.rows.every((r) => Object.keys(r.detail).length === 0)).toBe(true);
  expect(seen.rows.find((r) => r.action === "tool.deny")?.actor).toBe("你的运行");
});

it("GET /api/security/audit 要能管成员才看得到", async () => {
  const app = seed();
  const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
  const mine = await server.inject("/api/security/audit?group=ops&limit=2");
  expect(mine.statusCode).toBe(200);
  expect(mine.json()).toMatchObject({ more: true, rows: [{ action: "tool.deny" }, { action: "command.approve" }] });
  const headers = { authorization: `Bearer ${createApiToken(app, "wang", "test")}` };
  expect((await server.inject({ url: "/api/security/audit", headers })).statusCode).toBe(403);
  expect((await server.inject("/api/security/audit?group=nope")).statusCode).toBe(400);
});
