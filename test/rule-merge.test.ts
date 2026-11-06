import { resolve } from "node:path";
import { expect, it } from "vitest";
import { __testHandlers, addRunEvent, flushRunText, getRun, setRunOutput } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { all, run } from "../src/core/db.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { dispatchRuleEvent } from "../src/rules/engine.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

const alert = (id: string, text: string, chat = "oc_alerts"): RuleEvent => ({
  key: `lark:${id}`,
  kind: "message",
  at: new Date().toISOString(),
  chat: { id: chat, name: "项目 A 报警群", kind: "group" },
  sender: { name: "监控机器人", email: "", kind: "bot" },
  message: { id, text, type: "interactive", mentionsOwner: false, mentionsBot: false, topicId: null, cardTitle: "P1 报警" },
  via: "test",
});

function setup(merge?: boolean, mergeReply?: "combined" | "separate") {
  const app = testApp();
  saveAgentSpec(app, { name: "alert-analyst", description: "分析报警", prompt: "分析报警。" }, "user");
  setLarkClient({ im: { message: { reply: async () => ({ code: 0, data: { message_id: "om_r" } }) } } });
  const rule = saveRule(app, {
    name: "报警分析",
    description: "报警卡片开话题分析，直接回复",
    enabled: true,
    conditions: { field: "message.type", op: "equals", value: "interactive" },
    judge: "code",
    actions: [{ type: "agent", spec: "alert-analyst", task: "核对本条来源的接手状态", ownTopic: true, reply: "auto", ...(merge === undefined ? {} : { merge }), ...(mergeReply ? { mergeReply } : {}) }],
  });
  const agentRuns = () => all<{ id: string; status: string; lane: string | null; input: string }>(app.db, "select id, status, lane, input from runs where kind = 'agent' order by created_at, rowid");
  return { app, rule, agentRuns };
}

it("joins triggers that come while the rule's run for that chat is in progress", async () => {
  const { app, rule, agentRuns } = setup();
  try {
    await dispatchRuleEvent(app, alert("om_1", "CPU 使用率超过 90%"));
    const [first] = agentRuns();
    expect(first.lane).toBe(`rule:${rule.id}:oc_alerts`);
    run(app.db, "update runs set status = 'running' where id = ?", first.id);
    // A burst while it works: one waiting run collects them all.
    await dispatchRuleEvent(app, alert("om_2", "CPU 使用率超过 95%"));
    await dispatchRuleEvent(app, alert("om_3", "接口超时率 12%"));
    const runs = agentRuns();
    expect(runs).toHaveLength(2);
    const waiting = getRun(app, runs[1].id);
    expect(waiting.status).toBe("queued");
    expect(waiting.input.resumeFromRun).toBe(first.id);
    expect((waiting.input.triggers as { messageId: string }[]).map((t) => t.messageId)).toEqual(["om_2", "om_3"]);
    expect(listFirings(app, rule.id).map((f) => f.results[0].detail).find((d) => d.includes("并入"))).toBeTruthy();
    // Another chat is another investigation.
    await dispatchRuleEvent(app, alert("om_9", "磁盘满", "oc_other"));
    expect(agentRuns()).toHaveLength(3);

    // The running one takes them at its next tool call; the waiting run is dropped.
    const note = takeSteering(app, first.id)!;
    expect(note).toContain("又触发了 2 次");
    expect(note).toContain("om_2");
    expect(note).toContain("om_3");
    expect(note).toContain("reply_to");
    expect(getRun(app, waiting.id).status).toBe("cancelled");
    expect(getRun(app, first.id).output.joinedTriggers).toBe(2);
    expect(takeSteering(app, first.id)).toBeNull();
    // A trigger after that starts a new waiting run, since the first is still at work.
    await dispatchRuleEvent(app, alert("om_4", "CPU 恢复"));
    expect(agentRuns().filter((r) => r.status === "queued" && r.lane === first.lane)).toHaveLength(1);
  } finally {
    setLarkClient(null);
    app.db.close();
  }
});

it("runs what joined after the run ended in that run's agent session, with every trigger in its task", async () => {
  const { app, agentRuns } = setup();
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo" } })];
  const server = await startServer(app, { port: 0, quiet: true });
  const exec = async (id: string) => {
    const out = (await __testHandlers.get("agent")!({ app, run: getRun(app, id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, id, type, data), output: (data) => setRunOutput(app, id, data) })) as Record<string, unknown>;
    setRunOutput(app, id, out);
    flushRunText(app, id);
    run(app.db, "update runs set status = 'done' where id = ?", id);
    return JSON.parse(String(out.answer)) as { session: string; resumed: boolean; prompt: string };
  };
  try {
    await dispatchRuleEvent(app, alert("om_1", "CPU 使用率超过 90%"));
    const first = agentRuns()[0];
    run(app.db, "update runs set status = 'running' where id = ?", first.id);
    await dispatchRuleEvent(app, alert("om_2", "CPU 使用率超过 95%"));
    await dispatchRuleEvent(app, alert("om_3", "接口超时率 12%"));
    // The first ends without another tool call, so nothing was handed to it: the waiting run goes next.
    const a = await exec(first.id);
    const waiting = agentRuns().find((r) => r.status === "queued")!;
    const b = await exec(waiting.id);
    expect(b.session).toBe(a.session);
    expect(b.resumed).toBe(true);
    expect(b.prompt).toContain("om_2");
    expect(b.prompt).toContain("上一轮处理期间同一条规则又触发了 1 次");
    expect(b.prompt).toContain("om_3");
  } finally {
    await server.close();
    setLarkClient(null);
    app.db.close();
  }
}, 60000);

it("starts every trigger on its own when the rule does not merge", async () => {
  const { app, agentRuns } = setup(false);
  try {
    await dispatchRuleEvent(app, alert("om_1", "CPU 使用率超过 90%"));
    run(app.db, "update runs set status = 'running' where id = ?", agentRuns()[0].id);
    await dispatchRuleEvent(app, alert("om_2", "CPU 使用率超过 95%"));
    const runs = agentRuns();
    expect(runs).toHaveLength(2);
    // No lane: they also run side by side, as before.
    expect(runs.map((r) => r.lane)).toEqual([null, null]);
    expect(takeSteering(app, runs[0].id)).toBeNull();
  } finally {
    setLarkClient(null);
    app.db.close();
  }
});

it("queues separate replies in one agent session, preserving every trigger's task and reply target", async () => {
  const { app, rule, agentRuns } = setup(true, "separate");
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo" } })];
  const replies: { messageId: string; inThread: boolean }[] = [];
  setLarkClient({ im: { message: { reply: async (p: { path: { message_id: string }; data: { reply_in_thread?: boolean } }) => {
    replies.push({ messageId: p.path.message_id, inThread: !!p.data.reply_in_thread });
    return { code: 0, data: { message_id: `om_reply_${replies.length}` } };
  } } } });
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    await dispatchRuleEvent(app, alert("om_1", "CPU 使用率超过 90%"));
    const first = agentRuns()[0];
    run(app.db, "update runs set status = 'running' where id = ?", first.id);
    // Include a source longer than combined-mode summaries and a trigger in an existing topic.
    const second = alert("om_2", `${"详细材料".repeat(200)}独立核对标记`);
    second.message!.topicId = "omt_second";
    await dispatchRuleEvent(app, second);
    saveRule(app, { ...rule, temporary: rule.temporary ?? undefined, actions: rule.actions.map((a) => a.type === "agent" ? { ...a, ownTopic: false } : a) });
    await dispatchRuleEvent(app, alert("om_3", "接口超时率 12%"));
    const runs = agentRuns();
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.lane)).size).toBe(1);
    expect(getRun(app, runs[1].id).input.resumeFromRun).toBe(first.id);
    expect(getRun(app, runs[2].id).input.resumeFromRun).toBe(runs[1].id);
    expect(takeSteering(app, first.id)).toBeNull();
    expect(runs.slice(1).every((r) => getRun(app, r.id).status === "queued")).toBe(true);
    let session: string | undefined;
    for (const [i, r] of runs.entries()) {
      run(app.db, "update runs set status = 'running' where id = ?", r.id);
      expect(takeSteering(app, r.id)).toBeNull();
      const out = await __testHandlers.get("agent")!({ app, run: getRun(app, r.id), signal: new AbortController().signal, event: (type, data) => addRunEvent(app, r.id, type, data), output: (data) => setRunOutput(app, r.id, data) }) as Record<string, unknown>;
      setRunOutput(app, r.id, out);
      flushRunText(app, r.id);
      run(app.db, "update runs set status = 'done' where id = ?", r.id);
      const result = JSON.parse(String(out.answer)) as { session: string; resumed: boolean; prompt: string };
      if (session) expect(result.session).toBe(session);
      session = result.session;
      expect(result.resumed).toBe(i > 0);
      expect(result.prompt).toContain("核对本条来源的接手状态");
      expect(result.prompt).toContain("每次触发分别处理");
      expect(result.prompt).not.toContain("上一轮处理期间同一条规则又触发");
      if (i === 1) expect(result.prompt).toContain("独立核对标记");
    }
    expect(replies).toEqual([{ messageId: "om_1", inThread: true }, { messageId: "om_2", inThread: true }, { messageId: "om_3", inThread: false }]);
  } finally {
    await server.close();
    setLarkClient(null);
    app.db.close();
  }
}, 60000);

it("does not take a separately queued trigger into an older combined turn", async () => {
  const { app, rule, agentRuns } = setup();
  try {
    await dispatchRuleEvent(app, alert("om_1", "CPU 使用率超过 90%"));
    const first = agentRuns()[0];
    run(app.db, "update runs set status = 'running' where id = ?", first.id);
    saveRule(app, { ...rule, temporary: rule.temporary ?? undefined, actions: rule.actions.map((a) => a.type === "agent" ? { ...a, mergeReply: "separate" } : a) });
    await dispatchRuleEvent(app, alert("om_2", "接口超时率 12%"));
    expect(takeSteering(app, first.id)).toBeNull();
    expect(getRun(app, agentRuns()[1].id).status).toBe("queued");
  } finally {
    setLarkClient(null);
    app.db.close();
  }
});
