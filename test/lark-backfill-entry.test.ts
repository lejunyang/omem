import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { testApp } from "./helpers.ts";
import { callTool } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { backfillStatus, pollLark, requestBackfill } from "../src/channels/lark-personal.ts";
import { historyScan } from "../src/channels/lark-history.ts";
import { fillResourcesStatus, missingResources, storeMessages } from "../src/channels/lark-messages.ts";

const selected = "oc_resume_selected";
const stamp = Date.now() - 10 * 86400_000;
const message = (id: string) => ({ message_id: id, chat_id: selected, msg_type: "text", content: id, create_time: String(stamp), sender: { id: "ou_other", name: "小王" } });
afterEach(() => setLarkCliForTests(null));

describe("main official set_lark_backfill entry", () => {
  it.each(["main", "threads"] as const)("restores files and ingest intent from %s phase without losing checkpoint or other 39 queued chats", async (phase) => {
    const app = testApp();
    Object.assign(app.config.lark.capture, { mode: "subscribed", attachments: false, docs: false, calendar: false, minutes: false });
    app.config.lark.capture.backfill = { days: 0, policies: [], pagesPerPoll: 1 };
    const chats = [selected, ...Array.from({ length: 39 }, (_, i) => `oc_resume_other_${i}`)];
    for (const chat of chats) requestBackfill(app, chat, 0);
    run(app.db, "update lark_cursors set oldest_ms=backfill_to_ms"); // Simulate the old false-completion defect.
    storeMessages(app, selected, [{ ...message("om_fill_requested"), msg_type: "image", content: "[Image: img_requested]" }], {});
    storeMessages(app, chats[1], [{ ...message("om_fill_unrelated"), chat_id: chats[1], msg_type: "image", content: "[Image: img_unrelated]" }], {});
    const calls: string[][] = [];
    let unrelatedToken = 0;
    setLarkCliForTests(async (args, cwd) => {
      calls.push(args);
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_owner" } } } };
      if (args[1] === "+messages-search") return { data: { messages: [], has_more: false } };
      if (args[1] === "+messages-mget") {
        expect(args[args.indexOf("--message-ids") + 1]).toBe("om_fill_requested");
        mkdirSync(`${cwd}/resources`, { recursive: true });
        writeFileSync(`${cwd}/resources/image.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        return { data: { messages: [{ message_id: "om_fill_requested", resources: [{ key: "img_requested", type: "image", local_path: "resources/image.png" }] }] } };
      }
      if (args[1] === "+chat-messages-list") {
        const chat = args[args.indexOf("--chat-id") + 1];
        if (chat !== selected) return { data: { messages: [], has_more: true, page_token: `unrelated-${++unrelatedToken}` } };
        if (phase === "threads") return { data: { messages: [{ ...message("om_before_recovery"), thread_id: "omt_resume" }], has_more: false } };
        if (!args.includes("--page-token")) return { data: { messages: [message("om_before_recovery")], has_more: true, page_token: "resume-selected" } };
        expect(args[args.indexOf("--page-token") + 1]).toBe("resume-selected");
        return { data: { messages: [message("om_after_recovery")], has_more: false } };
      }
      if (args[1] === "+threads-messages-list") {
        if (!args.includes("--page-token")) return { data: { messages: [message("om_thread_before_recovery")], has_more: true, page_token: "resume-selected" } };
        expect(args[args.indexOf("--page-token") + 1]).toBe("resume-selected");
        return { data: { messages: [message("om_thread_after_recovery")], has_more: false } };
      }
      return { data: {} };
    });
    await pollLark(app); // Automatic revalidation starts before the user restores intent.
    if (phase === "threads") for (let i = 0; i < 41 && historyScan(app, selected)?.token !== "resume-selected"; i++) await pollLark(app);
    const checkpoint = historyScan(app, selected)!;
    expect(checkpoint).toMatchObject({ phase, token: "resume-selected" });
    expect(backfillStatus(app, selected).pending).toBe(true);
    const others = () => all(app.db, "select chat_id,backfill_to_ms,backfill_ingest,oldest_ms from lark_cursors where chat_id != ? order by chat_id", selected);
    const beforeOthers = others();
    const result = await callTool({ app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user" }, "set_lark_backfill", { chat_ids: [selected], days: 0, files: true, ingest: true });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("完成后整理");
    expect(result.text).toContain("开始补拉 1");
    expect(historyScan(app, selected)).toEqual(checkpoint);
    expect(others()).toEqual(beforeOthers);
    expect(one(app.db, "select backfill_ingest from lark_cursors where chat_id=?", selected)).toMatchObject({ backfill_ingest: 1 });
    await expect.poll(() => fillResourcesStatus()?.finishedAt).toBeTruthy();
    expect(missingResources(app, [selected])).toEqual([]);
    expect(missingResources(app, [chats[1]])).toEqual([{ messageId: "om_fill_unrelated", key: "img_unrelated" }]);
    expect(all(app.db, "select id from runs where kind='ingest'")).toEqual([]);
    for (let i = 0; i < 41 && backfillStatus(app, selected).pending; i++) await pollLark(app);
    expect(backfillStatus(app, selected)).toMatchObject({ pending: false, evidence: "remote-exhausted" });
    const ingests = all<{ input: string }>(app.db, "select input from runs where kind='ingest'");
    expect(ingests).toHaveLength(1);
    expect(JSON.parse(ingests[0].input).sourceIds).toEqual(expect.arrayContaining(checkpoint.touched));
    for (const chat of chats.slice(1)) expect(backfillStatus(app, chat)).toMatchObject({ pending: true, target: backfillStatus(app, selected).target });
    expect(others()).toEqual(beforeOthers);
    expect(calls.filter(a => a[1] === "+messages-mget")).toHaveLength(1);
  });
});
