import { describe, expect, it } from "vitest";
import { addIgnoreRule, listIgnoreRules, recordIgnoreHit } from "../src/core/notify-lessons.ts";
import { testApp } from "./helpers.ts";

describe("notify ignore rules", () => {
  it("stores, counts hits and removes a learned rule", () => {
    const app = testApp();
    const r = addIgnoreRule(app, "群里某人请求拉群/入群的打招呼消息，本人处理后不要再推送", "小王请求加入…");
    expect(listIgnoreRules(app).map((x) => x.id)).toContain(r.id);
    // Same rule text is not duplicated.
    expect(addIgnoreRule(app, r.rule, "另一条").id).toBe(r.id);
    recordIgnoreHit(app, r.id);
    expect(listIgnoreRules(app)[0].hits).toBe(1);
  });
});

import { ownerAlreadyHandled } from "../src/channels/notify-gate.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { upsertSource } from "../src/sources/store.ts";

describe("notify gate: owner already handled", () => {
  const line = (ms: number, who: string, text: string, id: string) => `[${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}] ${who}: ${text} (${id})`;
  it("a later owner line in the chat suppresses; the times are UTC like the capture writes them", async () => {
    const app = testApp();
    // Read state: om_r1 is read, the others unknown; no reactions.
    setLarkCliForTests(async (args) =>
      args.includes("+messages-read-status") ? { data: { items: [{ message_id: "om_r1", is_read: true }, { message_id: "om_b1" }] } } : { data: { items: [] } },
    );
    const t = Date.now() - 20 * 60_000;
    const src = upsertSource(app, {
      spaceId: "personal",
      kind: "chat",
      uri: "lark:oc_test1",
      title: "项目 A 群",
      text: [line(t, "小王", "@本人 帮忙看下报销单", "om_a1"), line(t + 5 * 60_000, "本人（本人）", "好的，我看下", "om_a2")].join("\n"),
    });
    expect(await ownerAlreadyHandled(app, { sourceRefs: [`src:${src.id}#L1`] })).toBe(true);
    // Only the trigger, no owner reply: not handled (read state is unknown without lark-cli).
    const quiet = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_test2", title: "项目 B 群", text: line(t, "小王", "@本人 在吗", "om_b1") });
    expect(await ownerAlreadyHandled(app, { sourceRefs: [`src:${quiet.id}#L1`] })).toBe(false);
    // Known read suppresses; unknown (no is_read) above did not.
    const read = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_test3", title: "项目 C 群", text: line(t, "小王", "@本人 周报发了", "om_r1") });
    expect(await ownerAlreadyHandled(app, { sourceRefs: [`src:${read.id}#L1`] })).toBe(true);
    setLarkCliForTests(null);
    app.db.close();
  });
});
