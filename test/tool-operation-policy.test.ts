import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { answerAsk, listAsks, waitForAnswer } from "../src/agents/asks.ts";
import { callTool, registerTool, unregisterTools, type ToolContext } from "../src/agents/tools.ts";
import type { OperationRule } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

function setup(action: OperationRule["action"]) {
  const app = testApp();
  apps.push(app);
  app.config.approvals.waitSeconds = 0;
  const ctx: ToolContext = { app, actor: "agent", tools: new Set(["list_spaces"]), spaces: null, runId: null, spaceId: "personal" };
  const rule: OperationRule = { id: "space-list", revision: 1, enabled: true, match: { kind: "tool", name: "list_spaces" }, action };
  app.config.security.operationRules = [rule];
  const invoke = () => callTool(ctx, "omem_call", { tool: "list_spaces" });
  return { app, ctx, rule, invoke };
}

it.each(["allow", "deny"] as const)("applies %s to the actual tool and audits the decision", async action => {
  const { app, ctx, invoke } = setup(action);
  app.config.approvals.tools = ["list_spaces"];
  expect((await invoke()).isError).toBe(action === "deny");
  expect(all(app.db, "select action,target from audit_events where action like 'operation.%'")).toEqual([{ action: "operation." + action, target: "list_spaces" }]);
  ctx.tools!.clear();
  expect((await invoke()).text).toContain("不可用");
  expect(listAsks(app)).toHaveLength(0);
});

it("logs the call and waits for ordinary approval before executing it once", async () => {
  const { app, ctx, rule } = setup("log");
  const name = "sample_count";
  let calls = 0;
  registerTool({ name, description: "", schema: z.object({}), handler: () => String(++calls) });
  try {
    rule.match = { kind: "tool", name };
    ctx.tools!.add(name);
    app.config.approvals.tools = [name];
    await callTool(ctx, name, {});
    const pending = listAsks(app, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(calls).toBe(0);
    expect(all(app.db, "select target from audit_events where action = 'tool.log'")).toEqual([{ target: name }]);
    expect((await answerAsk(app, pending[0].id, { approved: true, by: "owner" })).result).toBe("1");
    expect(calls).toBe(1);
  } finally { unregisterTools([name]); }
});

it("logs a reported tool and sends its completion notice", async () => {
  const { app, invoke } = setup("log");
  app.config.approvals.report = ["list_spaces"];
  expect((await invoke()).isError).toBe(false);
  expect(all(app.db, "select title from notifications")).toContainEqual({ title: "助理 已调用 list_spaces" });
});

it("runs the rule-approved call once and keeps the plugin's mandatory confirmation", async () => {
  const { app, rule, ctx } = setup("approve");
  const name = "plugin_confirmed";
  let calls = 0;
  registerTool({ name, description: "", schema: z.object({}), handler: () => String(++calls) }, { approval: true });
  try {
    rule.match = { kind: "tool", name };
    ctx.tools!.add(name);
    await callTool(ctx, name, {});
    const [policy] = listAsks(app);
    await answerAsk(app, policy.id, { approved: true, by: "owner" });
    expect(calls).toBe(0);
    const [native] = listAsks(app, { status: "pending" });
    expect((await answerAsk(app, native.id, { approved: true, by: "owner" })).result).toBe("1");
    await callTool(ctx, name, {});
    expect(listAsks(app, { status: "pending" })).toHaveLength(1);
    expect(calls).toBe(1);
  } finally { unregisterTools([name]); }
});

it.each(["revision", "member", "arguments", "expiry", "removal", "approver"])("rejects a stale approval after %s changes", async change => {
  const { app, ctx, rule, invoke } = setup("approve");
  const member = createUser(app, { name: "测试成员" });
  ctx.userId = member.id;
  if (change === "arguments") {
    ctx.tools!.add("upsert_item");
    rule.match = { kind: "tool", name: "upsert_item" };
    await callTool(ctx, "upsert_item", { title: "original", kind: "todo" });
  } else await invoke();
  const [ask] = listAsks(app);
  expect(ask.userId).toBe("owner");
  if (change === "revision") rule.revision++;
  if (change === "removal") app.config.security.operationRules = [];
  if (change === "member") run(app.db, "update users set disabled_at = 'now' where id = ?", member.id);
  if (change === "arguments") run(app.db, "update asks set args = ? where id = ?", JSON.stringify({ title: "changed", kind: "todo" }), ask.id);
  if (change === "expiry") run(app.db, "update asks set context = json_set(context,'$.operationGrant.expiresAt',0) where id = ?", ask.id);
  const done = await answerAsk(app, ask.id, { approved: true, by: change === "approver" ? member.id : "owner" });
  expect(done.result).toMatch(/^失败/);
});

it("an old tool approval also rechecks a newly introduced deny rule", async () => {
  const { app, invoke, rule } = setup("allow");
  app.config.approvals.tools = ["list_spaces"];
  rule.enabled = false;
  await invoke();
  const [ask] = listAsks(app);
  rule.enabled = true;
  rule.action = "deny";
  expect((await answerAsk(app, ask.id, { approved: true, by: "owner" })).result).toContain("拒绝调用");
});

it("records a delegated refusal without running the tool or promoting it", async () => {
  const { app, rule, invoke } = setup("approve");
  const reviewer = createUser(app, { name: "审批成员" });
  rule.approval = { approver: "user:" + reviewer.id };
  await invoke();
  const [ask] = listAsks(app, { userId: reviewer.id });
  await answerAsk(app, ask.id, { approved: false, by: reviewer.id });
  expect(all(app.db, "select json_extract(detail,'$.result') result from audit_events where action='operation.approve' order by rowid"))
    .toEqual([{ result: "pending" }, { result: "refused" }]);
});

it("returns a delegated approval's tool data only to the requester", async () => {
  const { app, rule, invoke } = setup("approve");
  const reviewer = createUser(app, { name: "审批成员" });
  rule.approval = { approver: "user:" + reviewer.id };
  await invoke();
  const [ask] = listAsks(app, { userId: reviewer.id });
  expect(ask.args).toBeNull();
  const waiting = waitForAnswer(app, ask.id, 2000, "owner");
  const response = await answerAsk(app, ask.id, { approved: true, by: reviewer.id });
  expect(response.result).toBe("详情仅向发起人显示");
  expect((await waiting).result).toContain("personal");
  expect((await waitForAnswer(app, ask.id, 0, reviewer.id)).result).toBe(response.result);
});
