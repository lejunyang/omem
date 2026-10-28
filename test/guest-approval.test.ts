import { afterEach, expect, it } from "vitest";
import { createRun, runEvents } from "../src/agents/runs.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { guestApprovalCard, onGuestApproved, type GuestApproval } from "../src/channels/lark-guest.ts";
import { buildCard, getInteraction, recordInteraction } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
});

function setup() {
  const app = testApp();
  apps.push(app);
  const run = createRun(app, { kind: "guest", spaceId: "personal", title: "访客 小李：帮我改一下表格", lane: "hold", notBefore: "2999-01-01T00:00:00Z" });
  const a: GuestApproval = { bot: "main", runId: run.id, chatId: "oc_team", chatName: "项目 A 讨论群", senderName: "小李", text: "帮我把表格 J 列补上", reason: "要改表格，访客不能要求写入", inbound: { messageId: "om_g1", chatId: "oc_team" } };
  const id = recordInteraction(app, { messageId: "om_card", chatId: "oc_team", conversationId: null, runId: run.id, purpose: "guest-approval", allowed: ["ou_owner"], payload: a });
  const passed: unknown[] = [];
  onGuestApproved("main", async (inbound) => void passed.push(inbound));
  const click = (who: string, action: string) => handleCardAction(app, { operator: { open_id: who }, context: { open_message_id: "om_card" }, action: { tag: "button", value: { action } } });
  return { app, run, a, id, passed, click };
}

it("asks only the owner, with the request, who sent it and why it was refused", () => {
  const card = JSON.stringify(buildCard(guestApprovalCard({ chatId: "oc_team", chatName: "项目 A 讨论群", senderName: "小李", text: "帮我把表格 J 列补上", reason: "要改表格", runId: "r1" })));
  expect(card).toContain("帮我把表格 J 列补上");
  expect(card).toContain("要改表格");
  expect(card).toContain("同意这次");
  expect(card).toContain("只有你能看到");
});

it("approved: the message goes back to the bot that took it, once; the run records the decision", async () => {
  const { app, run, id, passed, click } = setup();
  expect(await click("ou_other", "approve")).toMatchObject({ toast: { type: "error" } });
  const r = await click("ou_owner", "approve");
  expect(r.toast.content).toContain("已同意");
  expect(JSON.stringify(r.card)).toContain("已同意访客使用");
  expect(passed).toEqual([{ messageId: "om_g1", chatId: "oc_team" }]);
  expect(getInteraction(app, id)?.status).toBe("done");
  expect(runEvents(app, run.id).some((e) => String((e.data as { text?: string }).text).includes("本人同意"))).toBe(true);
  expect((await click("ou_owner", "approve")).toast.content).toBe("已经处理过了");
  expect(passed).toHaveLength(1);
});

it("declined: nothing is answered", async () => {
  const { passed, click } = setup();
  const r = await click("ou_owner", "decline");
  expect(r.toast.content).toBe("已忽略");
  expect(passed).toEqual([]);
});
