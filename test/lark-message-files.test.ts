import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { callTool } from "../src/agents/tools.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { persistChatMessages, type ResourceRef } from "../src/channels/lark-messages.ts";
import { one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkCliForTests(null));

const at = String(Date.now() - 60_000);
const fileMsg = (id: string, key: string, name: string, type = "file") => ({
  message_id: id,
  chat_id: "oc_proj",
  msg_type: type,
  content: `<file key="${key}" name="${name}"/>`,
  create_time: at,
  sender: { id: "cli_other_bot", name: "数据机器人", sender_type: "app" },
});
/** What lark-cli's read of each message (with its resources) downloads. */
const files: Record<string, [key: string, file: string, body: string]> = {
  om_txt: ["file_txt", "a.txt", "activity_id 101 春季活动\nactivity_id 102 测试活动\n"],
  om_csv: ["file_csv", "a.csv", "activity_id,name\n101,春季活动\n"],
  om_video: ["file_vid", "v.mp4", "not really a video"],
};

function setup() {
  const app = testApp();
  createSpace(app, { id: "proj", name: "项目 A" });
  persistChatMessages(app, {
    chatId: "oc_proj",
    spaceId: "proj",
    name: "项目 A 需求群",
    messages: [fileMsg("om_txt", "file_txt", "明细.txt"), fileMsg("om_csv", "file_csv", "明细.csv"), fileMsg("om_video", "file_vid", "录屏.mp4", "media")],
    resources: new Map<string, Record<string, ResourceRef>>([
      ["om_txt", { file_txt: { type: "file", name: "明细.txt" } }],
      ["om_csv", { file_csv: { type: "file", name: "明细.csv" } }],
      ["om_video", { file_vid: { type: "media", name: "录屏.mp4" } }],
    ]),
  });
  const downloads: string[] = [];
  // Capture never downloaded them.
  setLarkCliForTests(async (args, cwd) => {
    if (args.includes("+messages-mget") && args.includes("--download-resources")) {
      const id = args[args.indexOf("--message-ids") + 1];
      downloads.push(id);
      const [key, file, body] = files[id];
      writeFileSync(join(cwd!, file), body);
      return { ok: true, data: { messages: [{ message_id: id, resources: [{ key, local_path: file }] }] } };
    }
    return { ok: true, data: {} };
  });
  const ctx = (spaces: string[] | null) => ({ app, runId: null, spaceId: "proj", spaces, tools: null, actor: "agent" as const, userId: "owner", larkChats: [] });
  return { app, ctx, downloads };
}

it("gives an agent a message's file as a source it can read, downloading it once", async () => {
  const { app, ctx, downloads } = setup();
  try {
    const r = await callTool(ctx(["proj"]), "lark_message_file", { message_id: "om_txt" });
    expect(r.isError).toBe(false);
    const id = /src:(s\w+)/.exec(r.text)![1];
    const s = one<{ space_id: string; title: string; text: string }>(app.db, "select space_id, title, text from sources where id = ?", id)!;
    expect(s.space_id).toBe("proj");
    expect(s.title).toContain("明细");
    expect(s.text).toContain("测试活动");
    const refs = JSON.parse(one<{ resources: string }>(app.db, "select resources from lark_messages where message_id = 'om_txt'")!.resources);
    expect(refs.file_txt.sourceId).toBe(id);
    // Asked again (or through lark_read's download command): the same source, nothing downloaded again.
    const again = await callTool(ctx(["proj"]), "lark_read", { command: ["im", "+messages-resources-download", "--message-id", "om_txt", "--file-key", "file_txt", "--type", "file", "--output", "/tmp/x.txt"] });
    expect(again.isError).toBe(false);
    expect(again.text).toContain(`src:${id}`);
    expect(downloads).toEqual(["om_txt"]);
  } finally {
    app.db.close();
  }
});

it("refuses a chat outside the run's spaces; a file it cannot parse or a video comes back as the file", async () => {
  const { app, ctx } = setup();
  try {
    const out = await callTool(ctx(["personal"]), "lark_message_file", { message_id: "om_txt" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("不在本次任务");
    // Exercise the fallback regardless of which converters are installed on this machine.
    app.config.documents.engines = [];
    const csv = await callTool(ctx(["proj"]), "lark_message_file", { message_id: "om_csv" });
    expect(csv.isError).toBe(false);
    expect(csv.text).toContain("已下载到");
    const video = await callTool(ctx(["proj"]), "lark_message_file", { message_id: "om_video" });
    expect(video.isError).toBe(false);
    expect(video.text).toContain("不转写、不抽帧");
    expect(one(app.db, "select 1 from sources where uri like 'lark:oc_proj/om_video/%'")).toBeFalsy();
    expect((await callTool(ctx(["proj"]), "lark_message_file", { message_id: "om_none" })).isError).toBe(true);
  } finally {
    app.db.close();
  }
});
