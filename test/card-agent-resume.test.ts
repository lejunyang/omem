import { afterEach, expect, it } from "vitest";
import { createRun, getRun } from "../src/agents/runs.ts";
import { all } from "../src/core/db.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { recordInteraction } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

it("a card a rule's agent posted outside any conversation starts that agent again with the click, however late", async () => {
  const app = testApp(); apps.push(app);
  app.config.lark.ownerOpenId = "ou_owner";
  const replyAt = { chatId: "oc_ops", messageId: "om_request", inThread: true };
  const first = createRun(app, { kind: "agent", spaceId: "personal", title: "核验", input: { spec: "assistant", task: "核验这位员工号并请本人确认", replyAt, rule: { id: "rule1", name: "未过审核验" }, triggers: [{ messageId: "om_request" }] } });
  recordInteraction(app, { messageId: "om_card", chatId: "oc_ops", conversationId: null, runId: first.id, purpose: "agent", allowed: ["ou_owner"], payload: {} });
  const r = await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_card", open_chat_id: "oc_ops" }, action: { tag: "button", value: { choice: "通过" } } });
  expect(r.toast.content).toContain("接着处理");
  const runs = all<{ id: string }>(app.db, "select id from runs where id != ? and kind = 'agent'", first.id);
  expect(runs).toHaveLength(1);
  const next = getRun(app, runs[0].id);
  expect(next.input).toMatchObject({ spec: "assistant", replyAt, resumeFromRun: first.id, rule: { id: "rule1" } });
  expect(next.input.triggers).toBeUndefined();
  expect(String(next.input.task)).toContain("om_card");
  expect(String(next.input.task)).toContain("核验这位员工号");
});
