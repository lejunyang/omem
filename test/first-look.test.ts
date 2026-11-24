import { resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, getRun, listRuns, setRunOutput, startWorker, updateQueuedRun, waitForRun } from "../src/agents/runs.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setOwnerInChatForTests } from "../src/channels/lark-guest.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages } from "../src/channels/lark-watch.ts";
import { getContext, saveContext } from "../src/channels/listen.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { listNotifications } from "../src/core/notify.ts";
import { OWNER } from "../src/core/users.ts";
import { runActions } from "../src/rules/actions.ts";
import { deliverFirst, resolveDest, setFirstLookBudgetForTests, type FirstLookInput } from "../src/rules/first-look.ts";
import { getProbe, listProbes, matchProbe, runProbes, saveProbe } from "../src/rules/probes.ts";
import { saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * 快速通道 (docs/v2/first-look.md) through the real ACP + MCP path: the first look is the fake agent in
 * FAKE_MODE=first-look (test/fake-acp-agent.ts), handing in with first_look_outcome over the bridge.
 */
const app = testApp();
app.config.lark.ownerOpenId = "ou_owner";
app.config.agents.routing.choose.rules = "off";
const fake = (id: string) => agentProfileSchema.parse({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "first-look" }, idleTimeoutMs: 60000 });
app.config.agents.default = "fake";
app.config.agents.profiles = [fake("fake")];
const server = await startServer(app, { port: 0, quiet: true });
startWorker(app);
afterAll(() => server.close());

/** Records what the bot would post; ephemeral cards go through `request` (failing when told to). */
function fakeClient(opts: { ephemeralFails?: boolean } = {}) {
  const calls: { op: string; args: any }[] = [];
  let n = 0;
  const ok = (data: any) => ({ code: 0, data });
  return {
    calls,
    opts,
    sent: () => calls.map((c) => JSON.stringify(c.args)).join("\n"),
    request: async (args: any) => {
      calls.push({ op: "ephemeral", args });
      return opts.ephemeralFails ? { code: 230002, msg: "bot or user not in chat" } : ok({ message_id: `om_e${++n}` });
    },
    im: {
      message: {
        create: async (args: any) => (calls.push({ op: "create", args }), ok({ message_id: `om_b${++n}` })),
        reply: async (args: any) => (calls.push({ op: "reply", args }), ok({ message_id: `om_b${++n}` })),
        patch: async (args: any) => (calls.push({ op: "patch", args }), ok({})),
        get: async () => ok({ items: [] }),
      },
    },
  };
}
let client = fakeClient();
const useClient = (opts: { ephemeralFails?: boolean } = {}) => {
  client = fakeClient(opts);
  setLarkClient(client as never);
  return client;
};
afterEach(() => {
  setDecisionFetchForTests(null);
  setFirstLookBudgetForTests(null);
});

const click = (messageId: string, action: string, who = "ou_owner") =>
  handleCardAction(app, { operator: { open_id: who }, context: { open_message_id: messageId }, action: { value: { action } } } as never);
const cardOf = (purpose: string) => one<{ message_id: string }>(app.db, "select message_id from card_interactions where purpose = ? order by rowid desc limit 1", purpose)!.message_id;

/** A probe that prints what the regex took, as the first look and the deep run read it. */
const UID_PROBE = { name: "uid", description: "查 UID 的账号状态", match: "UID\\s*(?<uid>\\d+)", runtime: "node" as const, code: "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);console.log('PROBE-OUT:'+e.captures.uid+' env:'+JSON.parse(process.env.OMEM_CAPTURES).uid+' chat:'+e.chat.id)})", timeoutSec: 20 };
saveProbe(app, UID_PROBE, OWNER);

const event = (id: string, text: string, chat: RuleEvent["chat"] = { id: "oc_oncall", name: "值班群", kind: "group" }): RuleEvent => ({
  key: `lark:${id}`, kind: "message", at: new Date().toISOString(), chat, sender: { name: "小王", kind: "user" },
  message: { id, text, type: "text", mentionsOwner: false, mentionsBot: false }, via: "bot",
});

function rule(name: string, actions: unknown[]) {
  return saveRule(app, { name, description: `${name}：值班群里有人报 UID 的问题就先查`, enabled: true, trigger: { event: "message" }, conditions: { field: "message.text", op: "contains", value: "UID" }, judge: "code", actions } as never, "user", OWNER);
}

describe("预查库", () => {
  it("only the owner saves or deletes a probe, over HTTP too; the list leaves the code out", async () => {
    expect(() => saveProbe(app, { ...UID_PROBE, name: "x" }, "u_member")).toThrow(/只能由本人/);
    const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
    const put = await fetch(`${base}/api/probes/order`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "查订单", runtime: "bash", code: "echo ok" }) });
    expect(put.status).toBe(200);
    expect(getProbe(app, "order")).toMatchObject({ description: "查订单", timeoutSec: 20, direct: false, createdBy: OWNER });
    const list = (await (await fetch(`${base}/api/probes`)).json()) as Record<string, unknown>[];
    expect(list.find((p) => p.name === "order")).toMatchObject({ lines: 1 });
    expect(list.find((p) => p.name === "order")).not.toHaveProperty("code");
    const tried = (await (await fetch(`${base}/api/probes/uid/try`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "UID 9 打不开", event: { chat: { id: "oc_try" } } }) })).json()) as { ok: boolean; output: string; ms: number; matched: boolean };
    expect(tried).toMatchObject({ ok: true, matched: true });
    expect(tried.output).toContain("PROBE-OUT:9 env:9");
    expect((await fetch(`${base}/api/probes/order`, { method: "DELETE" })).status).toBe(200);
    expect(getProbe(app, "order")).toBeNull();
    // A rule may only name a probe that exists.
    expect(() => rule("没有的预查", [{ type: "probe", name: "nope" }, { type: "notify" }])).toThrow(/没有「nope」/);
  });

  it("skips a probe whose regex does not match, hands the captures to the script, and never blocks on a failure or a timeout", async () => {
    expect(matchProbe(UID_PROBE, ["没有编号"])).toMatchObject({ matched: false });
    saveProbe(app, { name: "boom", description: "会失败", runtime: "node", code: "console.error('坏了');process.exit(3)" }, OWNER);
    saveProbe(app, { name: "hang", description: "不结束", runtime: "node", code: "setTimeout(()=>{}, 60000)", timeoutSec: 1 }, OWNER);
    const before = listRuns(app, { kind: "probe" }).length;
    const out = await runProbes(app, { names: ["uid", "boom", "hang", "gone"], event: { chat: { id: "oc_x" } }, texts: ["UID 42 打不开"], spaceId: "personal" });
    const by = Object.fromEntries(out.map((r) => [r.name, r]));
    expect(by.uid).toMatchObject({ ok: true });
    expect(by.uid.output).toBe("PROBE-OUT:42 env:42 chat:oc_x");
    expect(by.boom).toMatchObject({ ok: false, exitCode: 3 });
    expect(by.hang).toMatchObject({ ok: false, timedOut: true });
    expect(by.gone.skipped).toMatch(/没有这个名字/);
    // Three ran, each a run of its own.
    expect(listRuns(app, { kind: "probe" }).length - before).toBe(3);
    expect(getRun(app, by.hang.runId!).status).toBe("failed");
    const skipped = await runProbes(app, { names: ["uid"], event: {}, texts: ["没有编号"], spaceId: "personal" });
    expect(skipped[0].skipped).toMatch(/不匹配/);
    expect(listRuns(app, { kind: "probe" }).length - before).toBe(3);
  });

  it("proposes a probe on a card with its code; 保存 keeps it in the owner's name, 不要 is not proposed again", async () => {
    useClient();
    const hold = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: hold.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const proposal = { name: "接口报错数", description: "查接口最近一小时的报错数", match: "接口\\s*(\\S+)", runtime: "bash", code: "echo \"$OMEM_CAPTURES\"", why: "这个群每次报接口问题都先查报错数" };
    const r = await callTool(ctx, "propose_probe", proposal);
    expect(r.isError, r.text).toBe(false);
    expect(client.sent()).toContain("echo");
    expect(getProbe(app, "接口报错数")).toBeNull();
    // Only the owner may answer it.
    expect((await click(cardOf("probe-proposal"), "save", "ou_other")).toast.type).toBe("error");
    await click(cardOf("probe-proposal"), "save");
    expect(getProbe(app, "接口报错数")).toMatchObject({ createdBy: OWNER, via: "proposal", match: "接口\\s*(\\S+)" });
    await callTool(ctx, "propose_probe", { ...proposal, name: "慢查询" });
    const dropped = await click(cardOf("probe-proposal"), "drop");
    expect(JSON.stringify(dropped.card)).toContain("不再提");
    expect(getProbe(app, "慢查询")).toBeNull();
    const again = await callTool(ctx, "propose_probe", { ...proposal, name: "慢查询" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/不再提/);
    expect(listProbes(app).some((p) => p.name === "慢查询")).toBe(false);
  });
});

describe("规则：先看一眼", () => {
  it("answered: the probe output reaches the fast model, the answer goes to the chat, no deep run", async () => {
    useClient();
    const r = rule("报 UID 直接回", [{ type: "agent", spec: "assistant", reply: "auto", firstLook: true, probes: ["uid"], firstTo: "chat" }]);
    const [res] = await runActions(app, r, event("om_a1", "UID 42 打不开 [answered]"), "报了 UID");
    expect(res.detail).toMatch(/先看一眼/);
    const look = await waitForRun(app, res.runId!);
    expect(look.status, look.error ?? "").toBe("done");
    expect(look.output).toMatchObject({ outcome: "answered", delivered: { to: "chat" } });
    const stages = look.output.stages as Record<string, any>;
    expect(stages.probes.results[0]).toMatchObject({ name: "uid", ok: true });
    expect(stages.look).toMatchObject({ outcome: "answered", by: "model" });
    expect(stages.decision).toMatchObject({ skipped: expect.stringContaining("没有决策模型") });
    expect(typeof stages.look.ms).toBe("number");
    const reply = client.calls.find((c) => c.op === "reply")!;
    expect(reply.args.path.message_id).toBe("om_a1");
    expect(JSON.stringify(reply.args)).toContain("快速结论 answered 看到 42");
    expect(listRuns(app, { parentId: look.id, kind: "agent" })).toHaveLength(0);
    expect(listRuns(app, { parentId: look.id, kind: "probe" })).toHaveLength(1);
  }, 120_000);

  it("escalate: the deep run gets the probe output and the first look's words, and answers where the first message went; 不用查了 is put away", async () => {
    useClient();
    setOwnerInChatForTests("oc_oncall", true);
    const r = rule("报 UID 先看再查", [{ type: "agent", spec: "assistant", reply: "draft", firstLook: true, probes: ["uid"], firstTo: "chat" }]);
    const [res] = await runActions(app, r, event("om_e1", "UID 7 报错 [escalate]"), "报了 UID");
    const look = await waitForRun(app, res.runId!);
    expect(look.status, look.error ?? "").toBe("done");
    // The rule's agent only drafts: the first message is a card only the owner sees, not a post in the group.
    expect(look.output).toMatchObject({ outcome: "escalate", delivered: { to: "ephemeral" } });
    expect((look.output.delivered as { why: string[] }).why.join()).toMatch(/没有允许直接/);
    expect(client.calls.filter((c) => c.op === "reply")).toHaveLength(0);
    expect(client.calls.find((c) => c.op === "ephemeral")!.args.data.chat_id).toBe("oc_oncall");
    const deep = listRuns(app, { parentId: look.id, kind: "agent" })[0];
    expect(deep.input.firstLook).toEqual({ runId: look.id });
    expect(String(deep.input.task)).toContain("PROBE-OUT:7");
    expect(String(deep.input.task)).toContain("快速结论 escalate");
    const done = await waitForRun(app, deep.id);
    expect(done.status, done.error ?? "").toBe("done");
    expect(String(done.output.answer)).toContain('"probe":true,"look":true,"material":true');
    // The conclusion went to the same place: a second card only the owner sees, with 发给大家.
    const cards = client.calls.filter((c) => c.op === "ephemeral");
    expect(cards).toHaveLength(2);
    expect(JSON.stringify(cards[1].args)).toContain("深查结论");
    expect(getRun(app, look.id).output.deepDelivered).toMatchObject({ runId: deep.id, to: "ephemeral" });
    // 发给大家 on the conclusion posts it under the message, as the bot.
    const shared = await click(cardOf("first-look"), "share");
    expect(shared.toast.content).toBe("已发到群里");
    const posted = client.calls.find((c) => c.op === "reply")!;
    expect(posted.args.path.message_id).toBe("om_e1");
    expect(JSON.stringify(posted.args)).toContain("深查结论");
  }, 180_000);

  it("a time-out and a failure are escalate; the decision model can overturn an answered", async () => {
    useClient();
    setOwnerInChatForTests("oc_oncall", true);
    setFirstLookBudgetForTests(4000);
    const r = rule("报 UID 快查", [{ type: "agent", spec: "assistant", reply: "auto", firstLook: true, firstTo: "chat" }]);
    const [slow] = await runActions(app, r, event("om_s1", "UID 1 [slow]"), "");
    const [fail] = await runActions(app, r, event("om_f1", "UID 2 [fail]"), "");
    for (const id of [slow.runId!, fail.runId!]) {
      const look = await waitForRun(app, id);
      expect(look.status, look.error ?? "").toBe("done");
      expect(look.output).toMatchObject({ outcome: "escalate", stages: { look: { by: "host" } } });
      // Nothing to say from the fast model: only the owner hears of it, never the group.
      expect((look.output.delivered as { to: string }).to).toBe("ephemeral");
      expect(listRuns(app, { parentId: id, kind: "agent" })).toHaveLength(1);
    }
    expect(String((getRun(app, slow.runId!).output.stages as any).look.reason)).toMatch(/秒内没看完/);
    expect(String((getRun(app, fail.runId!).output.stages as any).look.reason)).toMatch(/快模型出错/);
    // With a decision model that is not sure enough, an answer is looked into after all.
    app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai" as never, backends: [] }];
    app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
    setKey(app.home, "d", "key-1");
    setDecisionFetchForTests((async () => new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.5 }] }))) as unknown as typeof fetch);
    try {
      const [res] = await runActions(app, r, event("om_d1", "UID 3 [answered]"), "");
      const look = await waitForRun(app, res.runId!);
      expect(look.status, look.error ?? "").toBe("done");
      expect(look.output.outcome).toBe("escalate");
      expect((look.output.stages as any).decision).toMatchObject({ taken: "no", threshold: 0.7 });
      expect(listRuns(app, { parentId: look.id, kind: "agent" })).toHaveLength(1);
      // The deep runs finish here, not in the next test.
      for (const id of [slow.runId!, fail.runId!, look.id]) await waitForRun(app, listRuns(app, { parentId: id, kind: "agent" })[0].id);
    } finally {
      app.config.ai.decision = { provider: "", model: "", fallback: "general", gatekeeper: true };
    }
  }, 180_000);

  it("owner: the question goes to the owner only, no deep run", async () => {
    useClient();
    setOwnerInChatForTests("oc_oncall", true);
    const r = rule("报 UID 要我定", [{ type: "agent", spec: "assistant", reply: "auto", firstLook: true, firstTo: "chat" }]);
    const [res] = await runActions(app, r, event("om_o1", "UID 5 要不要提级 [owner]"), "");
    const look = await waitForRun(app, res.runId!);
    expect(look.output).toMatchObject({ outcome: "owner", delivered: { to: "ephemeral" } });
    expect(client.calls.filter((c) => c.op === "reply")).toHaveLength(0);
    expect(client.calls.map((c) => c.op)).toEqual(["ephemeral"]);
    expect(JSON.stringify(client.calls[0].args)).toContain("要你定");
    expect(listRuns(app, { parentId: look.id, kind: "agent" })).toHaveLength(0);
  }, 120_000);

  it("probe and script steps hand their output to the actions after them", async () => {
    useClient();
    const r = rule("报 UID 通知我", [{ type: "probe", name: "uid" }, { type: "notify" }]);
    const res = await runActions(app, r, event("om_n1", "UID 11 打不开"), "");
    expect(res[0]).toMatchObject({ action: "probe", ok: true });
    const n = listNotifications(app).find((x) => x.title === "规则「报 UID 通知我」")!;
    expect(n.body).toContain("PROBE-OUT:11");
    expect(n.body).toContain("```text");
    // A script needing no approval runs at once when an agent after it reads its output.
    const s = saveRule(app, { name: "脚本再交给助手", description: "先跑脚本再交给助手", enabled: true, trigger: { event: "message" }, conditions: { field: "message.text", op: "contains", value: "UID" }, judge: "code", actions: [{ type: "script", runtime: "node", code: "console.log('SCRIPT-OUT:<b>ok</b>')", approval: { by: "none" } }, { type: "agent", spec: "assistant", reply: "none", merge: false }] } as never, "user", OWNER);
    const out = await runActions(app, s, event("om_n2", "UID 12"), "");
    expect(out[0]).toMatchObject({ action: "script", ok: true });
    const agent = getRun(app, out[1].runId!);
    expect(String(agent.input.task)).toContain("前面的步骤拿到的");
    expect(String(agent.input.task)).toContain("```text\nSCRIPT-OUT:<b>ok</b>");
    await waitForRun(app, agent.id);
  }, 120_000);
});

describe("第一条发到哪", () => {
  const input = (over: Partial<FirstLookInput> = {}): FirstLookInput => ({
    source: "rule", userId: OWNER, chat: { id: "oc_dest", name: "测试群", kind: "group" },
    messages: [{ id: "om_dest", text: "UID 1 怎么了", sender: "小王", at: new Date().toISOString() }],
    brief: "", probes: [], to: "chat", direct: true, ...over,
  });
  const look = () => createRun(app, { kind: "first-look", title: "测试", input: {}, lane: "test-hold-look", notBefore: "2999-01-01T00:00:00Z" });
  const answered = { outcome: "answered" as const, text: "是缓存没刷新", evidence: "预查第一行", by: "model" as const };

  it("downgrades: no direct replies → ephemeral; private chat → dm; owner → only the owner", () => {
    expect(resolveDest(input(), "answered").to).toBe("chat");
    expect(resolveDest(input({ direct: false }), "answered").to).toBe("ephemeral");
    expect(resolveDest(input({ chat: { id: "oc_p", name: "私聊", kind: "p2p" } }), "answered").to).toBe("dm");
    expect(resolveDest(input(), "owner").to).toBe("ephemeral");
    expect(resolveDest(input({ to: "dm" }), "owner").to).toBe("dm");
  });

  it("sends to the chat, the owner's private chat, or a card only they see — falling back to the private chat", async () => {
    useClient();
    setOwnerInChatForTests("oc_dest", true);
    expect((await deliverFirst(app, look(), input(), input().messages, answered)).to).toBe("chat");
    expect(client.calls.at(-1)!.op).toBe("reply");
    expect((await deliverFirst(app, look(), input({ to: "dm" }), input().messages, answered)).to).toBe("dm");
    expect(client.calls.at(-1)!.args.data.receive_id).toBe("ou_owner");
    expect((await deliverFirst(app, look(), input({ to: "ephemeral" }), input().messages, answered)).to).toBe("ephemeral");
    expect(client.calls.at(-1)!.op).toBe("ephemeral");
    useClient({ ephemeralFails: true });
    const d = await deliverFirst(app, look(), input({ to: "ephemeral" }), input().messages, answered);
    expect(d.to).toBe("dm");
    expect(d.why.join()).toMatch(/发不出/);
    expect(client.calls.map((c) => c.op)).toEqual(["ephemeral", "create"]);
    // Not in the group: straight to the private chat.
    useClient();
    setOwnerInChatForTests("oc_dest", false);
    expect((await deliverFirst(app, look(), input({ to: "ephemeral" }), input().messages, answered)).to).toBe("dm");
    expect(client.calls.map((c) => c.op)).toEqual(["create"]);
  });

  it("the buttons: 发给大家 posts it, 不用查了 stops the deep run, 不用了 puts it away — only for the user it belongs to", async () => {
    useClient();
    setOwnerInChatForTests("oc_dest", true);
    const l = look();
    await deliverFirst(app, l, input({ to: "ephemeral" }), input().messages, answered);
    const card = cardOf("first-look");
    expect((await click(card, "share", "ou_someone")).toast.type).toBe("error");
    expect((await click(card, "share")).toast.content).toBe("已发到群里");
    expect(client.calls.at(-1)).toMatchObject({ op: "reply", args: { path: { message_id: "om_dest" } } });
    expect(JSON.stringify(client.calls.at(-1)!.args)).toContain("是缓存没刷新");
    expect((await click(card, "share")).toast.content).toBe("已经处理过了");
    // escalate: 不用查了 cancels the deep run; the card stays for 发给大家 / 不用了.
    const l2 = look();
    const deep = createRun(app, { kind: "agent", title: "深查", input: {}, lane: "test-hold-deep", notBefore: "2999-01-01T00:00:00Z" });
    await deliverFirst(app, l2, input({ to: "ephemeral" }), input().messages, { outcome: "escalate", text: "像是缓存问题", next: "查发布记录", by: "model" });
    setRunOutput(app, l2.id, { deep: { runId: deep.id } });
    const card2 = cardOf("first-look");
    expect((await click(card2, "stop")).toast.content).toBe("已停下深查");
    expect(getRun(app, deep.id).status).toBe("cancelled");
    expect((await click(card2, "dismiss")).toast.content).toBe("好的");
    expect((await click(card2, "share")).toast.content).toBe("已经处理过了");
  });
});

describe("关注：先看一眼", () => {
  const BRIEF = { handle: ["用户报的页面问题，带 UID 的"], skip: ["闲聊"], valid: "说得出原因" };
  const route = (id: string, text: string, chat = "oc_listen") => routeWatchedMessages(app, chat, "值班群", [{ id, time: String(Date.now()), sender: "小王", text }]);
  const looksIn = (contextId: string) => listRuns(app, { kind: "first-look" }).filter((r) => (r.input.listen as { contextId?: string } | undefined)?.contextId === contextId);
  const batchOf = (conv: string) => listRuns(app, { kind: "ask" }).filter((r) => r.input.conversationId === conv);
  const now = () => new Date().toISOString();

  it("looks at once without waiting for the batch, merges a burst, and takes answered messages out of the batch", async () => {
    useClient();
    setOwnerInChatForTests("oc_listen", true);
    const c = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_listen"], brief: { ...BRIEF, at: now(), confirmedAt: now() }, knobs: { reply: "draft", listen: "all", batchMinutes: 10, firstLook: true, probes: ["uid"], firstTo: "chat" } });
    await route("om_l1", "UID 21 打不开");
    await route("om_l2", "还是不行 [answered]");
    const [look] = looksIn(c.id);
    expect((look.input.messages as unknown[]).length).toBe(2);
    const [batch] = batchOf(c.conversationId!);
    expect(batch.status).toBe("queued");
    updateQueuedRun(app, look.id, { notBefore: now() });
    const done = await waitForRun(app, look.id);
    expect(done.status, done.error ?? "").toBe("done");
    expect(done.output).toMatchObject({ outcome: "answered", delivered: { to: "ephemeral" } });
    expect(String((done.output.stages as any).probes.results[0].name)).toBe("uid");
    // Answered: the batch it would have waited ten minutes for is gone, and the conversation says why.
    expect(getRun(app, batch.id).status).toBe("cancelled");
    expect(threadMessages(app, c.conversationId!).some((m) => m.text.includes("先看一眼已经答了这几条"))).toBe(true);
    expect(one(app.db, "select decision from handled_messages where channel = 'handled:watch' and message_id = 'om_l2'")).toMatchObject({ decision: "drafted" });
    expect(client.calls.filter((x) => x.op === "reply")).toHaveLength(0);
  }, 120_000);

  it("escalate runs the batch now with both results; a batch already on the messages answers alone", async () => {
    useClient();
    setOwnerInChatForTests("oc_listen2", true);
    const c = saveContext(app, { kind: "place", name: "值班群二", chats: ["oc_listen2"], brief: { ...BRIEF, at: now(), confirmedAt: now() }, knobs: { reply: "draft", listen: "all", batchMinutes: 10, firstLook: true, probes: ["uid"], firstTo: "dm" } });
    await route("om_m1", "UID 31 报错 [escalate]", "oc_listen2");
    const [look] = looksIn(c.id);
    updateQueuedRun(app, look.id, { notBefore: now() });
    const done = await waitForRun(app, look.id);
    expect(done.output).toMatchObject({ outcome: "escalate", delivered: { to: "dm" } });
    const batch = getRun(app, (done.output.deep as { runId: string }).runId);
    expect(batch.kind).toBe("ask");
    const answered = await waitForRun(app, batch.id);
    expect(answered.status, answered.error ?? "").toBe("done");
    expect(String(answered.output.answer)).toContain('"probe":true,"look":true,"material":true');
    // A batch that started on the messages first: the first look steps aside, nothing is sent.
    useClient();
    await route("om_m2", "UID 32 [answered]", "oc_listen2");
    const next = looksIn(c.id).find((r) => r.id !== look.id)!;
    const b2 = batchOf(c.conversationId!).find((r) => r.status === "queued")!;
    run(app.db, "update runs set status = 'done' where id = ?", b2.id);
    updateQueuedRun(app, next.id, { notBefore: now() });
    const stepped = await waitForRun(app, next.id);
    expect(stepped.output.skipped).toMatch(/这一批在处理/);
    expect(all(app.db, "select 1 from handled_messages where channel = 'yield:watch' and message_id = 'om_m2'")).toHaveLength(1);
    expect(client.calls).toHaveLength(0);
  }, 180_000);

  it("a 关注 without it batches as before", async () => {
    const c = saveContext(app, { kind: "place", name: "普通群", chats: ["oc_plain"], brief: { ...BRIEF, at: now(), confirmedAt: now() }, knobs: { reply: "draft", listen: "all", batchMinutes: 10 } });
    await route("om_p1", "UID 41 打不开", "oc_plain");
    expect(looksIn(c.id)).toHaveLength(0);
    expect(batchOf(getContext(app, c.id)!.conversationId!)).toHaveLength(1);
  });
});
