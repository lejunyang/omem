import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseCommand, parseDemoOrganize, runCommand } from "../src/agents/commands.ts";
import { createThread } from "../src/agents/threads.ts";
import { demoLessonsDir, playbookOf } from "../src/channels/listen-cases.ts";
import { saveContext } from "../src/channels/listen.ts";
import { all, one, run } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { boot } from "../src/main.ts";
import { currentDemo } from "../src/remote/demos.ts";
import { createRecording, recordingDir, updateRecording } from "../src/remote/recordings.ts";
import { writeWorkFile } from "../src/sources/work.ts";

/**
 * Demonstrations (remote/demos.ts): the owner shows a piece of work; recordings, picks, their own
 * Feishu messages and 远程 recordings of the window land in one conversation in time order, without
 * turns, and stopping hands the timeline to the assistant (skill-from-demo).
 */
describe("demonstrations", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-demos-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ auth: { enabled: true }, webUrl: "https://omem.example.test" }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const owner = createApiToken(app, "owner", "chrome");
  createUser(app, { id: "wang", name: "小王" });
  const member = createApiToken(app, "wang", "chrome");
  const call = (method: string, path: string, body?: unknown, token = owner) =>
    fetch(`${app.baseUrl}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.9" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const turns = (conversationId: string) => one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'ask' and lane = ?", conversationId)!.n;
  const entries = (conversationId: string) =>
    all<{ text: string; meta: string; created_at: string }>(app.db, "select text, meta, created_at from messages where conversation_id = ? order by created_at, rowid", conversationId).map((m) => ({ text: m.text, at: m.created_at, demo: JSON.parse(m.meta).demo as Record<string, unknown> | undefined }));
  const larkMessage = (id: string, chat: string, kind: string, content: string, ms: number) =>
    run(app.db, "insert into lark_messages(message_id, chat_id, sender_kind, sender_name, content, create_ms) values (?,?,?,?,?,?)", id, chat, kind, kind === "owner" ? "本人" : "小李", content, ms);

  const ctx = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "none" } });
  run(app.db, "insert into lark_cursors(chat_id, name) values (?, ?)", "oc_ops", "退款值班群");

  it("starts one demonstration at a time, the owner's only", async () => {
    expect((await call("POST", "/api/demos", { goal: "退款失败怎么查" }, member)).status).toBe(403);
    expect((await call("POST", "/api/demos", { goal: "  " })).status).toBe(400);
    // A message the owner sent just before it began is not part of it.
    larkMessage("om_before", "oc_ops", "owner", "早上好", Date.now() - 60_000);
    const r = await call("POST", "/api/demos", { goal: "值班群里有人报退款失败时怎么查", contextId: ctx.id });
    expect(r.status).toBe(200);
    const d = (await r.json()) as { id: string; conversationId: string; status: string; context: { id: string; name: string }; lessonsPath: string; spaceId: string };
    expect(d).toMatchObject({ status: "active", context: { id: ctx.id, name: "值班群" }, lessonsPath: "关注/值班群/演示/值班群里有人报退款失败时怎么查.md" });
    expect(one<{ channel: string; title: string }>(app.db, "select channel, title from conversations where id = ?", d.conversationId)).toMatchObject({ channel: "demo", title: "演示：值班群里有人报退款失败时怎么查" });
    expect(entries(d.id)[0]).toMatchObject({ demo: { kind: "start" } });
    expect((await call("POST", "/api/demos", { goal: "另一件" })).status).toBe(409);
    const listed = (await (await call("GET", "/api/demos")).json()) as { current: { id: string } | null; recent: { id: string }[] };
    expect(listed.current?.id).toBe(d.id);
    expect((await call("GET", "/api/demos", undefined, member)).status).toBe(403);
  });

  it("keeps picks, imports, Feishu messages and 远程 recordings on its timeline without turns, then hands it over", async () => {
    const d = currentDemo(app)!;
    // A pick from the extension: kept in the demonstration, no turn.
    const pick = await call("POST", "/api/clips", {
      mode: "ask", turn: false, conversationId: d.id, space: "personal", title: "可退金额",
      text: "就是这个：大于 0 才能退\n\n---\n## 引用的记录\n\n### #3 可退金额\n- 主元素：`div.balance` 120×20\n\n{{image:r3}}",
      pageUrl: "https://admin.example.test/orders/9", images: [{ key: "r3", title: "#3 可退金额", data: png }],
    });
    expect(pick.status).toBe(200);
    expect(await pick.json()).toMatchObject({ mode: "note", conversationId: d.id });
    // Not into someone else's conversation, and not without one.
    const theirs = createThread(app, { spaceId: "personal", channel: "web", userId: "wang" });
    expect((await call("POST", "/api/clips", { mode: "ask", turn: false, conversationId: theirs.id, space: "personal", text: "x" })).status).toBe(404);
    expect((await call("POST", "/api/clips", { mode: "ask", turn: false, space: "personal", text: "x" })).status).toBe(400);

    // A recording from the extension made during it: on the timeline, not organized by itself.
    const start = Date.parse(d.startedAt);
    const t = start + 1;
    const imp = await call("POST", "/api/remote/recordings/import", {
      demoId: d.id, goal: "查订单的退款状态", startUrl: "https://admin.example.test/orders/9", startedAt: t,
      steps: [{ at: t + 1000, tab: 1, kind: "action", action: { kind: "click", label: "退款记录", role: "tab" } }],
    });
    expect(imp.status).toBe(200);
    const imported = (await imp.json()) as { recording: { id: string; conversationId: string }; conversationId: string; demoId: string };
    expect(imported).toMatchObject({ conversationId: d.id, demoId: d.id, recording: { conversationId: d.id } });

    // The owner's messages in the 关注's group during it; others' messages, other groups and the command are not.
    const at = start + 2;
    larkMessage("om_1", "oc_ops", "owner", "看了下，订单 9 的可退金额是 0，已经退过了", at);
    larkMessage("om_2", "oc_ops", "owner", "@小李 这单不用再退", at + 1);
    larkMessage("om_3", "oc_ops", "user", "订单 9 退款失败了", at - 1);
    larkMessage("om_4", "oc_other", "owner", "午饭吃什么", at);
    larkMessage("om_5", "oc_ops", "owner", "/演示结束", at + 2);
    // A 远程 recording that finished in the window.
    const rid = "rec_remote_demo";
    createRecording(app, { id: rid, kind: "browser", goal: "在后台看退款流水", target: "https://admin.example.test", dir: recordingDir(app, rid), conversationId: null, userId: "owner" });
    updateRecording(app, rid, { status: "done", summary: { actions: 3 }, finishedAt: new Date().toISOString() });
    expect(turns(d.id)).toBe(0);

    expect((await call("POST", `/api/demos/${d.id}/stop`, { organize: "lessons" }, member)).status).toBe(403);
    const stop = await call("POST", `/api/demos/${d.id}/stop`, { organize: "lessons" });
    expect(stop.status).toBe(200);
    const stopped = (await stop.json()) as { demo: { status: string; entries: Record<string, number> }; runId: string; collected: { lark: number; remote: number } };
    expect(stopped.demo).toMatchObject({ status: "stopped", entries: { recording: 1, pick: 1, lark: 1, remote: 1 } });
    expect(stopped.collected).toEqual({ lark: 2, remote: 1 });
    expect(stopped.runId).toBeTruthy();
    expect(turns(d.id)).toBe(1);

    const list = entries(d.id);
    expect(list.map((e) => e.demo?.kind)).toEqual(["start", "recording", "lark", "pick", "remote", "organize"]);
    const lark = list.find((e) => e.demo?.kind === "lark")!;
    expect(lark.text).toMatch(/我在飞书「退款值班群」里发了：\n- \d\d:\d\d:\d\d 看了下，订单 9 的可退金额是 0[^]*\n- \d\d:\d\d:\d\d @小李 这单不用再退$/);
    expect(lark.text).not.toMatch(/午饭|退款失败了|早上好|演示结束/);
    expect(lark.at).toBe(new Date(at).toISOString());
    expect(list.find((e) => e.demo?.kind === "pick")!.text).toMatch(/^我指给你看（拾取，https:\/\/admin\.example\.test\/orders\/9）：\n\n就是这个[^]*omem-file:[^]*src:/);
    const organize = list.at(-1)!.text;
    expect(organize).toContain(`我演示完了：值班群里有人报退款失败时怎么查（演示 ${d.id}`);
    expect(organize).toMatch(/时间线（4 条[^]*录制 \S+（Chrome 扩展）：查订单的退款状态[^]*飞书「退款值班群」我发了 2 条[^]*拾取：可退金额[^]*录制 rec_remote_demo（远程 · 浏览器）/);
    expect(organize).toContain("skill-from-demo");
    expect(organize).toContain("write_file 写到 关注/值班群/演示/值班群里有人报退款失败时怎么查.md（space personal");

    expect((await call("POST", `/api/demos/${d.id}/stop`, { organize: "none" })).status).toBe(409);
    expect(currentDemo(app)).toBeNull();
  });

  it("gives the 关注's handlers what was demonstrated, and leaves it out of the lessons the coach rewrites", () => {
    expect(demoLessonsDir(ctx)).toBe("关注/值班群/演示");
    writeWorkFile(app, { spaceId: "personal", path: "关注/值班群/经验.md", title: "关注「值班群」的经验", text: "# 经验\n\n## 报错\n- 先查日志" });
    writeWorkFile(app, { spaceId: "personal", path: "关注/值班群/演示/值班群里有人报退款失败时怎么查.md", title: "退款失败怎么查", text: "## 有人报退款失败\n- 看订单的可退金额，0 就是退过了" });
    const read = playbookOf(app, ctx);
    expect(read).toMatch(/# 经验[^]*## 本人演示过的做法\n\n### 退款失败怎么查\n\n## 有人报退款失败/);
    expect(playbookOf(app, ctx, 4000, { demos: false })).not.toContain("演示过的做法");
  });

  it("starts and stops from chat commands, about the 关注 of the group it is sent in", async () => {
    expect(parseCommand("/演示结束经验")).toEqual({ name: "演示结束", args: "经验" });
    expect(parseCommand("/演示 给商户开通退款")).toEqual({ name: "演示", args: "给商户开通退款" });
    expect(parseCommand("/演示给商户开通退款")).toEqual({ name: "演示", args: "给商户开通退款" });
    expect(parseCommand("/演示结束")).toEqual({ name: "演示结束", args: "" });
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseCommand("/随便说说")).toBeNull();
    expect(parseDemoOrganize("", true)).toBe("lessons");
    expect(parseDemoOrganize("", false)).toBe("skill");
    expect(parseDemoOrganize("不整理", true)).toBe("none");
    expect(parseDemoOrganize("别的", true)).toBeNull();

    const group = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_ops", userId: "owner" });
    const inb = { text: "", channel: "lark", chatId: "oc_ops", userId: "owner" };
    expect(await runCommand(app, group, "/演示", inb)).toMatch(/现在没有在演示/);
    expect(await runCommand(app, group, "/演示 退款", { ...inb, userId: "wang" })).toBe("只有本人可以演示。");
    expect(await runCommand(app, group, "/演示 有人催退款进度时怎么回", inb)).toMatch(/开始演示「有人催退款进度时怎么回」[^]*关注「值班群」[^]*默认整理成这个关注的经验/);
    expect(currentDemo(app)).toMatchObject({ goal: "有人催退款进度时怎么回", context: { id: ctx.id } });
    expect(await runCommand(app, group, "/演示 另一件", inb)).toMatch(/命令失败：已经在演示「有人催退款进度时怎么回」/);
    expect(await runCommand(app, group, "/演示", inb)).toMatch(/正在演示「有人催退款进度时怎么回」[^]*还没记下东西/);
    const d = currentDemo(app)!;
    expect(await runCommand(app, group, "/演示结束 不整理", inb)).toMatch(/演示「有人催退款进度时怎么回」结束，还没记下东西，先不整理。之后要整理，在 https:\/\/omem\.example\.test\/#\/ask\//);
    expect(turns(d.id)).toBe(0);
    expect(entries(d.id).at(-1)).toMatchObject({ demo: { kind: "stop" } });
  });

  it("reads every captured chat when it is about no 关注, and turns into a skill", async () => {
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "商户 B 退款权限", kind: "todo" }, "user");
    const web = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    expect(await runCommand(app, web, "/演示 给商户开通退款权限", { text: "", channel: "web", userId: "owner" })).toMatch(/默认整理成技能/);
    const d = currentDemo(app)!;
    expect(d.context).toBeNull();
    larkMessage("om_6", "oc_other", "owner", "商户 B 的退款开好了", Date.parse(d.startedAt) + 1);
    expect((await call("POST", `/api/demos/${d.id}/stop`, { organize: "lessons" })).status).toBe(400);
    expect(await runCommand(app, web, "/演示结束", { text: "", channel: "web", userId: "owner" })).toMatch(/记下飞书消息 1 段。助手在整理成技能/);
    const organize = entries(d.id).at(-1)!.text;
    expect(organize).toContain("飞书「oc_other」我发了 1 条");
    expect(organize).toContain("请整理成技能");

    // About an item: lessons become the item's work file.
    const r = (await (await call("POST", "/api/demos", { goal: "退款权限开通后怎么告诉商户", itemId: item.id })).json()) as { id: string; item: { id: string } };
    expect(r.item.id).toBe(item.id);
    await call("POST", `/api/demos/${r.id}/stop`, { organize: "lessons" });
    expect(entries(r.id).at(-1)!.text).toContain(`write_file 写成挂在事项上的工作文件（item ${item.id}，path 演示/退款权限开通后怎么告诉商户）`);
  });
});
