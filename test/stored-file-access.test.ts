import { it, expect } from "vitest";
import { addRunEvent, createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { saveAttachment } from "../src/agents/attachments.ts";
import { setVisibility } from "../src/auth/visibility.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser, createApiToken, addMember, removeMember } from "../src/core/users.ts";
import { deleteSource, upsertSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("用原件、聊天上传者或运行的当前权限读取文件，包括压缩副本和历史附件", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, quiet: true });
  createSpace(app, { id: "team", name: "团队" });
  const tokens = new Map<string, string>();
  for (const user of ["a", "b"]) {
    createUser(app, { id: user, name: user });
    addMember(app, "team", user, "editor");
    tokens.set(user, createApiToken(app, user, "test"));
  }
  const get = async (name: string, user = "a") => (await server.inject({ url: "/api/files/" + name, headers: tokens.has(user) ? { authorization: "Bearer " + tokens.get(user) } : {} })).statusCode;
  const file = (content: string) => saveAttachment(app, Buffer.from(content), "file.txt").name;
  try {
    const pdf = file("原件"), media = file("插图"), copy = file("压缩"), other = file("个人"), orphan = file("无归属");
    const source = upsertSource(app, { spaceId: "team", kind: "doc", uri: "guide", title: "指引", text: "正文", meta: { original: pdf, media: { cover: media } } });
    upsertSource(app, { spaceId: "personal-b", kind: "doc", uri: "private", title: "个人", text: "", meta: { original: other } });
    run(app.db, "insert into file_variants(original,file,status,mode,original_bytes,created_at) values(?,?,'done','test',10,'2026-11-01')", pdf, copy);
    expect(await get(pdf)).toBe(200);
    setVisibility(app, source.id, "restricted", ["b"]);
    for (const name of [pdf, media, copy, other, orphan]) {
      expect(await get(name)).toBe(404);
      expect(await get(name, "owner")).toBe(200);
    }
    expect(await get(copy, "b")).toBe(200);
    const chatFile = file("群聊图片");
    run(app.db, "insert into lark_messages(message_id,chat_id,create_ms,source_id,resources) values(?,?,?,?,?)", "demo-msg", "demo-chat", 1, source.id, JSON.stringify({ image: { file: chatFile } }));
    expect(await get(chatFile)).toBe(404);
    expect(await get(chatFile, "b")).toBe(200);
    const mine = saveAttachment(app, Buffer.from("上传"), "image.png", "image/png", "a");
    expect(await get(mine.name)).toBe(200);
    expect(await get(mine.name, "b")).toBe(404);
    const forged = await server.inject({ method: "POST", url: "/api/ask", headers: { authorization: "Bearer " + tokens.get("a") }, payload: { text: "附件", attachments: [{ ...mine, name: other, label: "图" }] } });
    expect(forged.statusCode).toBe(403);

    const sharedRun = createRun(app, { kind: "ask", title: "共享运行", userId: "b", spaceId: "team", input: { spaces: ["team"] } });
    const image = file("生成图"), attached = file("历史附件");
    addRunEvent(app, sharedRun.id, "image", { name: image });
    const thread = createThread(app, { spaceId: "team", userId: "b", channel: "web" });
    addMessage(app, thread.id, "user", "附件", sharedRun.id, { attachments: [{ name: attached }] });
    addMessage(app, thread.id, "user", "旧引用", sharedRun.id, { attachments: [{ name: pdf }] });
    expect(await get(pdf)).toBe(404);
    deleteSource(app, source.id);
    for (const name of [pdf, media, copy, chatFile]) {
      expect(await get(name)).toBe(404);
      expect(await get(name, "b")).toBe(404);
      expect(await get(name, "owner")).toBe(200);
    }
    // Simulate records written before the ownership index existed.
    addRunEvent(app, sharedRun.id, "status", { note: "旧记录" });
    run(app.db, "delete from stored_file_refs where origin in ('messages','run_events','sources')");
    for (const table of ["messages", "run_events", "sources"])
      run(app.db, `insert into stored_file_backfill select ?,0,max(rowid) from ${table}`, table);
    for (const name of [image, attached]) expect(await get(name)).toBe(200);
    expect(await get(pdf)).toBe(404);
    removeMember(app, "team", "a");
    for (const name of [image, attached]) {
      expect(await get(name)).toBe(404);
      expect(await get(name, "b")).toBe(200);
    }
  } finally { await server.close(); app.db.close(); }
});
