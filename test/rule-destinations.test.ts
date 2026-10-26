import { describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { all, run } from "../src/core/db.ts";
import { createThread } from "../src/agents/threads.ts";
import { getRun } from "../src/agents/runs.ts";
import { ruleGroups, ruleGroupConversation } from "../src/rules/destinations.ts";
import { saveRule } from "../src/rules/store.ts";
import { runActions } from "../src/rules/actions.ts";

const tick = { key: "tick", kind: "schedule" as const, at: new Date().toISOString(), via: "schedule" as const };
const input = { name: "值班提醒", description: "每周在项目 A 群提醒", trigger: { event: "schedule" as const, cron: "0 11 * * 1" }, actions: [{ type: "agent" as const, reply: "auto" as const }] };

describe("scheduled rule destinations", () => {
  it("offers captured groups without assistant threads and resolves a stable owner destination", async () => {
    const app = testApp();
    try {
      for (const [id, mode] of [["oc_group", "group"], ["oc_topic", "topic"], ["oc_private", "p2p"]]) {
        run(app.db, "insert into lark_cursors(chat_id,name,chat_mode) values(?,?,?)", id, "项目 A", mode);
      }
      expect(ruleGroups(app).map(c => c.chat_id)).toEqual(["oc_group", "oc_topic"]);
      expect(all(app.db, "select id from conversations")).toHaveLength(0);
      expect(() => ruleGroupConversation(app, "oc_private")).toThrow(/已采集/);
      expect(() => ruleGroupConversation(app, "oc_unknown")).toThrow(/已采集/);
      const guest = createThread(app, { channel: "lark", key: "oc_group", spaceId: "personal", userId: "visitor" });
      const t = ruleGroupConversation(app, "oc_group");
      expect(t.id).not.toBe(guest.id);
      expect(ruleGroupConversation(app, "oc_group").id).toBe(t.id);
      const r = saveRule(app, { ...input, conversationId: t.id });
      const result = await runActions(app, r, tick, "定时");
      expect(getRun(app, result[0].runId!).input).toMatchObject({ threadId: t.id, lark: { chats: ["oc_group"], draft: false } });
      expect(all(app.db, "select id from messages")).toHaveLength(0);
    } finally { app.db.close(); }
  });

  it("fails legacy rules with no destination instead of privately answering with contradictory instructions", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "web", spaceId: "personal" });
      const r = saveRule(app, { ...input, conversationId: t.id });
      const result = await runActions(app, { ...r, conversationId: undefined }, tick, "定时");
      expect(result[0]).toMatchObject({ ok: false, detail: expect.stringContaining("缺少投递会话") });
      expect(all(app.db, "select id from runs")).toHaveLength(0);
    } finally { app.db.close(); }
  });

  it("retains the selected bot for a scheduled group conversation", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { channel: "lark:helper", key: "oc_group", spaceId: "personal" });
      const r = saveRule(app, { ...input, conversationId: t.id });
      const result = await runActions(app, r, tick, "定时");
      expect(getRun(app, result[0].runId!).input).toMatchObject({ threadId: t.id, lark: { chats: ["oc_group"], bot: "helper" } });
    } finally { app.db.close(); }
  });
});
