import { expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, getRun, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { listNotifications } from "../src/core/notify.ts";
import { testApp } from "./helpers.ts";

it("reports setup failures using the saved rule destination and falls back to the owner when chat delivery fails", async () => {
  const app = testApp();
  const chats: string[] = [];
  setLarkClient({ im: { message: { create: async ({ data }: any) => {
    chats.push(data.receive_id);
    if (data.receive_id === "oc_unavailable") throw new Error("群消息投递失败");
    return { code: 0, data: { message_id: "om_failure" } };
  } } } });
  try {
    const inputs = [
      { name: "通知本人", failureTo: "owner", failureChatId: "oc_reports" },
      { name: "通知群聊", failureTo: "chat", failureChatId: "oc_reports" },
      { name: "群不可达", failureTo: "chat", failureChatId: "oc_unavailable" },
    ];
    const runs = inputs.map(rule => createRun(app, { kind: "agent", spaceId: "personal", title: rule.name, input: { spec: "missing-profile", task: "示例任务", rule: { id: "rule_demo", ...rule } } }));
    startWorker(app);
    await Promise.all(runs.map(r => waitForRun(app, r.id)));
    expect(runs.map(r => getRun(app, r.id).status)).toEqual(["failed", "failed", "failed"]);
    expect(runs.map(r => getRun(app, r.id).output.ruleFailure)).toEqual([
      expect.objectContaining({ to: "owner" }), expect.objectContaining({ to: "chat" }), expect.objectContaining({ to: "owner" }),
    ]);
    expect(chats).toEqual(["oc_reports", "oc_unavailable"]);
    expect(listNotifications(app).map(n => n.title).sort()).toEqual(["规则「通知本人」执行失败", "规则「群不可达」执行失败"].sort());
  } finally { stopWorker(); await new Promise(resolve => setImmediate(resolve)); setLarkClient(null); app.db.close(); }
});
