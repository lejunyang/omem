import { afterEach, beforeEach, expect, it } from "vitest";
import { createRun, getRun, listRuns, setRunOutput } from "../src/agents/runs.ts";
import { claimSteering } from "../src/agents/steer.ts";
import { threadMessages } from "../src/agents/threads.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setOwnerInChatForTests } from "../src/channels/lark-guest.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages } from "../src/channels/lark-watch.ts";
import { deliverRequestedLooks, settle } from "../src/channels/listen-first-look.ts";
import { saveContext } from "../src/channels/listen.ts";
import { run } from "../src/core/db.ts";
import { handlingOf } from "../src/core/handling.ts";
import { OWNER } from "../src/core/users.ts";
import { now } from "../src/core/util.ts";
import { runActions } from "../src/rules/actions.ts";
import { evidenceLines, splitFirstLookText } from "../src/rules/first-look-material.ts";
import { deliverFirst, type FirstLookInput, type Outcome } from "../src/rules/first-look.ts";
import { saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
const sent: { op: string; content: string }[] = [];
const chat = { id: "oc_export", name: "项目 A", kind: "group" } as const;
const outcome: Outcome = { outcome: "answered", text: "导出用了旧模板。", evidence: "任务页记录", next: "核对模板版本", reason: "已查任务记录", by: "model" };

beforeEach(() => {
  app = testApp();
  app.config.lark.ownerOpenId = "ou_owner";
  sent.length = 0;
  const send = (op: string) => async (args: unknown) => {
    sent.push({ op, content: JSON.stringify(args) });
    return { code: 0, data: { message_id: `om_card_${sent.length}` } };
  };
  setLarkClient({ request: send("ephemeral"), im: { message: { create: send("dm"), reply: send("reply"), patch: send("patch") } } } as never);
  setOwnerInChatForTests(chat.id, true);
});

afterEach(() => {
  setLarkClient(null);
  app.db.close();
});

const click = (messageId: string, action: string, who = "ou_owner") => handleCardAction(app, { operator: { open_id: who }, context: { open_message_id: messageId }, action: { value: { action } } });

async function ruleLook(firstTo: "dm" | "ephemeral" | "chat", first: Outcome) {
  const rule = saveRule(app, { name: "核对导出", description: "导出失败先核对", enabled: true, trigger: { event: "message" }, conditions: { field: "message.text", op: "contains", value: "导出" }, judge: "code", actions: [{ type: "agent", spec: "assistant", reply: "auto", firstLook: true, firstTo }] } as never, "user", OWNER);
  const event: RuleEvent = { key: "lark:om_export", kind: "message", at: now(), via: "bot", chat, sender: { name: "小王", kind: "user" }, message: { id: "om_export", text: "导出失败", type: "text", mentionsOwner: false, mentionsBot: false } };
  const [queued] = await runActions(app, rule, event, "");
  const look = getRun(app, queued.runId!);
  const input = look.input as unknown as FirstLookInput;
  const delivered = await deliverFirst(app, look, input, input.messages, first);
  setRunOutput(app, look.id, { delivered, firstLookResult: first, outcome: first.outcome });
  run(app.db, "update runs set status = 'done' where id = ?", look.id);
  return { look, delivered };
}

it("私聊卡片只让本人交接一次，旧预查没有全文时链接运行", async () => {
  const { look, delivered } = await ruleLook("dm", outcome);
  run(app.db, "update runs set input = json_set(input, '$.probes', json('[\"old-probe\"]')) where id = ?", look.id);
  expect(sent[0].content).toContain("接着查");
  expect((await click(delivered.messageId!, "continue", "ou_other")).toast.type).toBe("error");
  const attempts = await Promise.all([click(delivered.messageId!, "continue"), click(delivered.messageId!, "continue")]);
  const accepted = attempts.filter((attempt) => attempt.toast.content === "已交给深查");
  expect(accepted).toHaveLength(1);
  expect(JSON.stringify(accepted[0].card)).toContain("不用查了");
  expect(JSON.stringify(accepted[0].card)).not.toContain('"action":"continue"');
  const [deep] = listRuns(app, { parentId: look.id, kind: "agent" });
  expect(listRuns(app, { parentId: look.id, kind: "agent" })).toHaveLength(1);
  for (const part of ["本人要求接着查", outcome.text, outcome.evidence!, outcome.next!, outcome.reason!, `预查结果见先看一眼运行 ${look.id}`]) expect(deep.input.task).toContain(part);
  expect(handlingOf(app, "om_export").map((entry) => entry.decision)).toEqual(["drafted", "handed"]);
  expect((await click(delivered.messageId!, "stop")).toast.content).toBe("已停下深查");
  expect(getRun(app, deep.id).status).toBe("cancelled");
});

it("关注被拿空的批次另起，结论只回个人卡片", async () => {
  const context = saveContext(app, { kind: "place", name: "项目 A", chats: [chat.id], knobs: { listen: "all", reply: "none", firstLook: true, firstTo: "ephemeral", perDay: 1 } });
  await routeWatchedMessages(app, chat.id, chat.name, [{ id: "om_export", time: String(Date.now()), sender: "小王", text: "导出失败" }]);
  const [look] = listRuns(app, { kind: "first-look" });
  const [oldBatch] = listRuns(app, { kind: "ask" });
  const input = look.input as unknown as FirstLookInput;
  const delivered = await deliverFirst(app, look, input, input.messages, outcome);
  settle(app, look, input, input.messages, outcome, delivered, []);
  setRunOutput(app, look.id, { delivered, firstLookResult: outcome, outcome: outcome.outcome });
  run(app.db, "update runs set status = 'done' where id = ?", look.id);
  expect(getRun(app, oldBatch.id).status).toBe("cancelled");
  const active = createRun(app, { kind: "ask", title: "正在处理的一批", lane: context.conversationId, input: { conversationId: context.conversationId } });
  run(app.db, "update runs set status = 'running' where id = ?", active.id);
  expect((await click(delivered.messageId!, "continue")).toast.content).toContain("这个关注每天的上限");
  saveContext(app, { id: context.id, kind: "place", knobs: { perDay: 2 } });
  expect((await click(delivered.messageId!, "continue")).toast.content).toBe("已交给深查");
  const deepId = (getRun(app, look.id).output.deep as { runId: string }).runId;
  expect(deepId).not.toBe(oldBatch.id);
  const batch = getRun(app, deepId);
  const messages = threadMessages(app, context.conversationId!).filter((message) => (batch.input.messageIds as string[]).includes(message.id));
  expect(messages[0].text).toContain("本人要求接着查");
  expect(messages[0].text).toContain(outcome.text);
  expect(messages[0].text).toContain(outcome.evidence);
  expect(claimSteering(app, active.id)).toBeNull();
  await deliverRequestedLooks(app, batch, messages, "已核对：模板需要更新。");
  expect(sent.map((entry) => entry.op)).toEqual(["ephemeral", "ephemeral"]);
  expect(sent.at(-1)!.content).toContain("深查结论");
  expect(sent.at(-1)!.content).not.toContain("发给大家");
});

it("卡片只折叠能断句的长段，分享只发回复", async () => {
  const more = "先去任务页核对导出记录。".repeat(14);
  const text = `导出暂时不可用；${more}`;
  expect(splitFirstLookText(text)).toEqual({ lead: "导出暂时不可用；", more });
  for (const original of [`导出暂时不可用。\n- ${more}`, `- ${more}`, "长".repeat(121), "短。还有一句"]) expect(splitFirstLookText(original)).toEqual({ lead: original });
  const { delivered } = await ruleLook("ephemeral", { ...outcome, text });
  expect(sent[0].content).toContain("collapsible_panel");
  expect(sent[0].content).toContain("展开");
  expect((await click(delivered.messageId!, "share")).toast.content).toBe("已发到群里");
  expect(sent.at(-1)!.content).toContain(text);
  expect(sent.at(-1)!.content).not.toContain(outcome.evidence);
  expect(sent.at(-1)!.content).not.toContain("依据");
});

it("背景和依据紧跟触发的消息，长段拆成一行一条", async () => {
  const evidence = "案例页写明要用主体超管操作。手机号只是登录凭证；权限看账号在主体下的角色。缺 11:21 之前的对话，还不知道说的是哪个账号，需要往前读几条消息，确认那个手机号登录的是哪个账号、从哪个入口进的详情页。";
  expect(evidenceLines(evidence).split("\n")).toHaveLength(4);
  expect(evidenceLines("短依据。两句")).toBe("短依据。两句");
  await ruleLook("ephemeral", { ...outcome, evidence });
  const card = sent[0].content;
  expect(card.indexOf("小王")).toBeLessThan(card.indexOf("背景和依据"));
  expect(card.indexOf("背景和依据")).toBeLessThan(card.indexOf(outcome.text));
  expect(card).toContain("- 案例页写明要用主体超管操作。");
});

it("在群里公开答复或情境照常跟进时没有接着查", async () => {
  const { delivered } = await ruleLook("chat", outcome);
  expect(delivered.interactionId).toBeNull();
  expect(sent[0].content).not.toContain("接着查");
  const look = createRun(app, { kind: "first-look", title: "情境先看一眼" });
  const input: FirstLookInput = { source: "situation", userId: OWNER, messages: [], brief: "", probes: [], to: "dm", direct: false, situation: { instanceId: "example", contextId: "example", name: "项目 A 演练", text: "演练开始", event: {} } };
  await deliverFirst(app, look, input, [], outcome);
  expect(sent.at(-1)!.content).toContain("照常跟进");
  expect(sent.at(-1)!.content).not.toContain("接着查");
});
