import { describe, expect, it } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
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
    expect(child.trigger?.by?.key).toBe("lark:ou_wang");

    // A schedule's runner: the runs it creates right away say which schedule.
    const nightly = withTrigger({ via: "schedule", source: { kind: "schedule", id: "dream", name: "做梦" } }, () => createRun(app, { kind: "dream", title: "做梦" }));
    expect(nightly.trigger).toMatchObject({ via: "schedule", source: { id: "dream" } });
    // The system's own work: nobody.
    expect(createRun(app, { kind: "ingest", title: "整理" }).trigger).toBeNull();

    expect(listRuns(app, { by: "lark:ou_wang" }).map((r) => r.id).sort()).toEqual([guest.id, child.id].sort());
    expect(triggerers(app).map((p) => [p.key, p.name, p.runs])).toEqual([["lark:ou_wang", "小王", 2], ["lark:ou_li", "小李", 1]]);
  });
});
