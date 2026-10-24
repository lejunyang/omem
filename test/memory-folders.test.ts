import { describe, expect, it } from "vitest";
import { run } from "../src/core/db.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { scheduleMemoryOrganize } from "../src/agents/jobs.ts";
import { listRuns } from "../src/agents/runs.ts";
import { listFolders, folderTreeText, unfiledCount } from "../src/memory/folders.ts";
import { getMemory, listMemories, remember } from "../src/memory/store.ts";
import { testApp } from "./helpers.ts";

const agentCtx = (app: ReturnType<typeof testApp>) =>
  toolContextForToken(app, issueToolToken({ runId: "r_test", spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "assistant" }))!;
const userCtx = (app: ReturnType<typeof testApp>) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user" }))!;

describe("memory folders", () => {
  it("files a memory on write: a new folder needs a description, look-alike or too-deep folders are refused", async () => {
    const app = testApp();
    const ctx = agentCtx(app);
    const base = { kind: "fact", source_refs: [] as string[] };
    const user = userCtx(app);
    let r = await callTool(ctx, "remember", { ...base, content: "项目 A 每周二下午发布。", folder: "工作/项目A" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/folder_description/);
    expect(listMemories(app, {})).toHaveLength(0);

    r = await callTool(user, "remember", { ...base, content: "项目 A 每周二下午发布。", folder: "工作 / 项目A", folder_description: "项目 A 的发布、环境与值班" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/放在「工作\/项目A」/);
    expect(listFolders(app, "personal").map((f) => [f.path, f.description, f.total])).toEqual([
      ["工作", "", 1],
      ["工作/项目A", "项目 A 的发布、环境与值班", 1],
    ]);

    r = await callTool(ctx, "remember", { ...base, content: "项目 A 只有预发环境。", folder: "工作/项目 a", folder_description: "x" });
    expect(r.text).toMatch(/已有目录「工作\/项目A」/);
    r = await callTool(ctx, "remember", { ...base, content: "项目 A 的值班表每月初更新。", folder: "工作/项目A/值班/早班", folder_description: "x" });
    expect(r.text).toMatch(/最多 3 层/);
    // An existing folder needs nothing more; no folder at all is fine and waits for the organizer.
    expect((await callTool(ctx, "remember", { ...base, content: "项目 A 只有预发环境，没有测试环境。", folder: "工作/项目A", distinct_from: listMemories(app, {}).map((m) => m.id) })).isError).toBe(false);
    expect((await callTool(ctx, "remember", { ...base, kind: "preference", content: "本人喜欢先看结论再看细节。" })).text).toMatch(/未放目录/);
    expect(unfiledCount(app, "personal")).toBe(1);
    expect(folderTreeText(app, "personal")).toMatch(/- 工作\/项目A（2）：项目 A 的发布/);
  });

  it("keeps the folder through corrections and moves whole version chains; recall filters by folder", async () => {
    const app = testApp();
    const ctx = agentCtx(app);
    const user = userCtx(app);
    await callTool(user, "remember", { kind: "fact", content: "项目 A 每周二发布。", folder: "项目A", folder_description: "项目 A 的约定" });
    const first = listMemories(app, {})[0];
    await callTool(user, "supersede", { memory_id: first.id, content: "项目 A 改为每周四发布。" });
    const now = listMemories(app, {})[0];
    expect(now.folder).toBe("项目A");

    let r = await callTool(ctx, "organize_memories", { actions: [{ op: "create", folder: "生活/出行", description: "差旅和出行安排" }, { op: "move", folder: "生活/出行", memory_ids: [now.id] }, { op: "move", folder: "生活/新目录", memory_ids: [now.id] }] });
    expect(r.text).toMatch(/1\. 已建「生活\/出行」/);
    expect(r.text).toMatch(/2\. 1 条放进「生活\/出行」/);
    expect(r.text).toMatch(/3\. 失败：.*folder_description|3\. 失败：.*新目录/);
    expect(getMemory(app, first.id).folder).toBe("生活/出行");

    expect((await callTool(ctx, "recall", { folder: "生活" })).text).toMatch(/目录 生活\/出行/);
    expect((await callTool(ctx, "recall", { folder: "项目A" })).text).toBe("没有相关记忆。");
    remember(app, { spaceId: "personal", kind: "fact", content: "本人的工位在三楼。" });
    expect((await callTool(ctx, "recall", { folder: "未归档" })).text).toMatch(/工位在三楼/);
  });

  it("renames, merges and removes folders without losing memories", async () => {
    const app = testApp();
    const ctx = agentCtx(app);
    const a = remember(app, { spaceId: "personal", kind: "fact", content: "甲", folder: "工作/项目A/发布" });
    const b = remember(app, { spaceId: "personal", kind: "fact", content: "乙", folder: "工作/项目B" });
    run(app.db, "insert into memory_folders(space_id, path, description, created_at, updated_at) values('personal','工作/项目B','项目 B 的约定','x','x')");

    let r = await callTool(ctx, "organize_memories", { actions: [{ op: "rename", folder: "工作/项目A", to: "工作/项目B" }] });
    expect(r.text).toMatch(/并入「工作\/项目B」，涉及 1 条/);
    expect(getMemory(app, a.id).folder).toBe("工作/项目B/发布");
    expect(listFolders(app, "personal").find((f) => f.path === "工作/项目B")).toMatchObject({ description: "项目 B 的约定", count: 1, total: 2 });
    expect(listFolders(app, "personal").some((f) => f.path.startsWith("工作/项目A"))).toBe(false);

    r = await callTool(ctx, "organize_memories", { actions: [{ op: "remove", folder: "工作/项目B" }] });
    expect(getMemory(app, a.id).folder).toBe("工作/发布");
    expect(getMemory(app, b.id).folder).toBe("工作");
    r = await callTool(ctx, "organize_memories", { actions: [{ op: "remove", folder: "工作" }] });
    expect(getMemory(app, b.id).folder).toBe("");
    expect(getMemory(app, a.id).folder).toBe("发布");
    expect((await callTool(ctx, "organize_memories", { actions: [{ op: "rename", folder: "发布", to: "发布/子目录", description: "x" }] })).text).toMatch(/自己下面/);
  });

  it("queues an organizing pass only when something was filed nowhere since the last one", () => {
    const app = testApp();
    remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周二发布。" });
    const runs = scheduleMemoryOrganize(app);
    expect(runs.map((r) => r.title)).toEqual(["整理记忆目录（1 条未归档）"]);
    expect(scheduleMemoryOrganize(app)).toEqual([]);
    const later = new Date(Date.now() + 1000).toISOString();
    run(app.db, "update runs set status = 'done', started_at = ? where id = ?", later, runs[0].id);
    expect(scheduleMemoryOrganize(app)).toEqual([]);
    run(app.db, "update memories set created_at = ?", new Date(Date.now() + 5000).toISOString());
    expect(scheduleMemoryOrganize(app)).toHaveLength(1);
    expect(listRuns(app, { kind: "memory-organize" })).toHaveLength(2);
  });
});
