import { describe, expect, it } from "vitest";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { triggerers, withTrigger } from "../src/core/run-trigger.ts";
import { testApp } from "./helpers.ts";

describe("who was behind a run", () => {
  it("is read from the input, taken over from the parent, and filters the run list", () => {
    const app = testApp();
    const guest = createRun(app, { kind: "guest", title: "访客 小王：退款怎么算", input: { chatId: "oc_1", chatType: "p2p", messageId: "om_1", senderId: "ou_wang", senderName: "小王", fromApp: false, text: "退款怎么算" } });
    expect(guest.trigger).toEqual({ via: "guest", by: { key: "lark:ou_wang", name: "小王" }, where: "私聊机器人" });

    const handling = createRun(app, { kind: "agent", title: "有人找你：小李", input: { spec: "assistant", task: "…", mention: { senderId: "ou_li", senderName: "小李", chatKind: "group", chatName: "项目 A 群" } } });
    expect(handling.trigger).toMatchObject({ via: "mention", by: { key: "lark:ou_li" }, where: "项目 A 群" });

    // What a run starts carries who was behind it.
    const child = createRun(app, { kind: "agent", title: "接着查", parentId: guest.id, input: { spec: "assistant", task: "…" } });
    expect(child.trigger).toMatchObject({ via: "guest", by: { key: "lark:ou_wang" }, followUp: "child" });
    // A wake the handling set for itself: still 小李's, marked as a follow-up rather than 小李 looking for the owner again.
    const wake = createRun(app, { kind: "ask", title: "唤醒：复查", parentId: handling.id, input: { conversationId: "c1", messageIds: ["m1"], wake: true } });
    expect(wake.trigger).toMatchObject({ via: "mention", by: { name: "小李" }, followUp: "wake" });
    // One stored before `followUp` was: read as a wake all the same.
    const old = createRun(app, { kind: "ask", title: "唤醒：更早的", parentId: handling.id, input: { conversationId: "c1", messageIds: ["m2"], wake: true } });
    run(app.db, "update runs set trigger = ? where id = ?", JSON.stringify({ via: "mention", by: { key: "lark:ou_li", name: "小李" } }), old.id);
    expect(getRun(app, old.id).trigger?.followUp).toBe("wake");

    // A schedule's runner: the runs it creates right away say which schedule.
    const nightly = withTrigger({ via: "schedule", source: { kind: "schedule", id: "dream", name: "做梦" } }, () => createRun(app, { kind: "dream", title: "做梦" }));
    expect(nightly.trigger).toMatchObject({ via: "schedule", source: { id: "dream" } });
    // The system's own work: nobody.
    expect(createRun(app, { kind: "ingest", title: "整理" }).trigger).toBeNull();

    expect(listRuns(app, { by: "lark:ou_wang" }).map((r) => r.id).sort()).toEqual([guest.id, child.id].sort());
    // 小李 also looked for the owner through the capture app (another open_id): still one person, two ways.
    const again = createRun(app, { kind: "agent", title: "有人找你：小李", input: { spec: "assistant", task: "…", mention: { senderId: "ou_li_cli", senderName: "小李", chatKind: "p2p" } } });
    // Follow-ups are not counted as more of their runs, but the person's filter still finds them.
    expect(triggerers(app).map((p) => [p.key, p.name, p.runs, p.ways]).sort()).toEqual([["name:小李", "小李", 2, { mention: 2 }], ["name:小王", "小王", 1, { guest: 1 }]].sort());
    expect(listRuns(app, { by: "name:小李" }).map((r) => r.id).sort()).toEqual([handling.id, again.id, wake.id, old.id].sort());
    expect(listRuns(app, { by: "name:小王", via: "mention" })).toEqual([]);
    expect(listRuns(app, { via: "mention" })).toHaveLength(4);
  });

  it("a run that ended quietly is hidden from the list but found by its exact id", () => {
    const app = testApp();
    const r = createRun(app, { kind: "agent", title: "有人找你：小李", input: { spec: "assistant", task: "…" } });
    run(app.db, "update runs set status = 'done', quiet = 1 where id = ?", r.id);
    expect(listRuns(app, { q: "小李" })).toEqual([]);
    expect(listRuns(app, { q: r.id }).map((x) => x.id)).toEqual([r.id]);
  });
});
