import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { roleNames, upkeepRoles } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { lessonsForTask, lessonIdsForTask, prepareRun, runRole } from "../src/agents/runner.ts";
import { agentSpecSchema } from "../src/agents/specs.ts";
import { receive } from "../src/agents/inbox.ts";
import { createRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { boot } from "../src/main.ts";
import { ensureFolder, ownFolderNote } from "../src/memory/folders.ts";
import { remember } from "../src/memory/store.ts";
import { markUsed, memoriesWithRecall, recallPurpose, recallStats, recordRecalls } from "../src/memory/recall-stats.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

type TestApp = ReturnType<typeof testApp>;
const apps: TestApp[] = [];
function setup() {
  const app = testApp();
  apps.push(app);
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.default = "fake";
  app.config.agents.profiles = [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: {}, idleTimeoutMs: 60000 }];
  return app;
}
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); setEmbedderForTests(null); });
const spec = (tools = ["recall"]) => ({ ...agentSpecSchema.parse({ name: "investigator", description: "发布排查", tools }), prompt: "检查发布约定。" });
const task = (tools?: string[]) => ({ role: "assistant" as const, spec: spec(tools), spaceId: "personal", task: "项目 A 周二发布前跑回归测试" });
function memory(app: TestApp, content: string, extra: Partial<Parameters<typeof remember>[1]> = {}) {
  return remember(app, { spaceId: "personal", kind: "experience", content, createdBy: "user", ...extra });
}
async function vectors(app: TestApp) {
  app.config.embeddings.provider = "local";
  setEmbedderForTests(fakeEmbedder());
  await embedPending(app);
  while (await embedPendingMemories(app)) {}
}
function date(app: TestApp, id: string, day: number) {
  run(app.db, "update memories set updated_at = ? where id = ?", `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, id);
}

describe("memory recall scope", () => {
  it("separates upkeep from every answer figure and per-memory count", () => {
    const app = setup();
    const pref = memory(app, "回答用中文。", { kind: "preference" });
    const a = memory(app, "发布前回归。"), b = memory(app, "生日在三月。"), c = memory(app, "回滚先核对版本。");
    recordRecalls(app, [a.id], { runId: "r1", via: "passive" });
    recordRecalls(app, [a.id], { runId: "r1", via: "recall" });
    recordRecalls(app, [pref.id], { runId: "r2", via: "lesson" });
    markUsed(app, "r1", [a.id]);
    const before = recallStats(app);
    recordRecalls(app, [a.id, b.id, c.id, pref.id], { runId: "r3", spec: "ingest" });
    markUsed(app, "r3", [a.id, b.id, c.id, pref.id]);
    expect(recallStats(app)).toEqual({ ...before, upkeepRecalls: 4 });
    expect(before).toMatchObject({ total: 4, standing: 1, recalled: 2, neverRecalled: 2, totalRecalls: 3, usedRecalls: 2, distinctRecalls: 2, distinctUsed: 1, passiveRecalls: 1, passiveUsed: 1 });
    expect(before.byVia).toEqual({ passive: { shown: 1, used: 1, memories: 1, runs: 1 }, recall: { shown: 1, used: 1, memories: 1, runs: 1 }, lesson: { shown: 1, used: 0, memories: 1, runs: 1 } });
    expect(memoriesWithRecall(app).find((m) => m.id === a.id)).toMatchObject({ recalls: 2, used: 2 });
    expect(memoriesWithRecall(app).find((m) => m.id === b.id)).toMatchObject({ recalls: 0, used: 0, lastRecalledAt: null });
    expect(memoriesWithRecall(app, { sort: "never" }).map((m) => m.id)).not.toContain(pref.id);
    expect(() => memoriesWithRecall(app, { sort: "recent" })).not.toThrow();
    expect(memoriesWithRecall(app, { sort: "recent" }).slice(0, 2).map((m) => m.id)).toEqual(expect.arrayContaining([a.id, pref.id]));
  });

  it("classifies only built-in upkeep roles as upkeep", () => {
    expect(recallPurpose("ingest")).toBe("upkeep");
    for (const name of ["heartbeat", "investigator", undefined]) expect(recallPurpose(name)).toBe("answer");
    expect([...upkeepRoles].every((name) => (roleNames as readonly string[]).includes(name))).toBe(true);
  });

  it("orders folder hints by count, describes them and prefixes spaces only across spaces", () => {
    const app = setup();
    for (let i = 0; i < 3; i++) memory(app, `发布经验 ${i}`, { agent: "investigator", folder: "发布" });
    for (let i = 0; i < 2; i++) memory(app, `回滚经验 ${i}`, { agent: "investigator", folder: "回滚" });
    memory(app, "尚未归档", { agent: "investigator" });
    ensureFolder(app, "personal", "发布", "发布前的检查", "user");
    expect(ownFolderNote(app, "investigator", 1)).toBe("- 发布（3 条）：发布前的检查\n- 其他目录和未归档的共 3 条");
    expect(ownFolderNote(app, "investigator").indexOf("发布")).toBeLessThan(ownFolderNote(app, "investigator").indexOf("回滚"));
    createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    memory(app, "跨空间的经验", { spaceId: "project-a", agent: "investigator", folder: "调查" });
    expect(ownFolderNote(app, "investigator")).toContain("空间 personal · 发布");
    expect(ownFolderNote(app, "investigator")).toContain("空间 project-a · 调查");
  });

  it("keeps memories denied in one space out of standing, task and passive recall", async () => {
    const app = setup();
    const user = createUser(app, { id: "reader", name: "项目成员" });
    for (const spaceId of ["shared", "other"]) {
      createSpace(app, { id: spaceId, name: spaceId });
      addMember(app, spaceId, user.id, "reader");
      memory(app, `项目经验-${spaceId}`, { spaceId, agent: "investigator" });
    }
    run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'memories.view','space','other','deny',current_timestamp,'owner')", user.id);
    const prep = prepareRun(app, { userId: user.id, runId: null, actor: { spec: spec() }, spaceId: "shared", spaces: ["shared", "other"] });
    expect(prep.recall?.spaces).toEqual(["shared"]);
    for (const instructions of [prep.system, await lessonsForTask(app, { ...task(), spaceId: "shared", userId: user.id })]) {
      expect(instructions).toContain("项目经验-shared");
      expect(instructions).not.toContain("项目经验-other");
    }
  });

  it("tells a task the own and shared lessons close to it, at most 12 and 8, and rejects unvetted ones", async () => {
    const app = setup();
    const own = Array.from({ length: 20 }, (_, i) => {
      const m = memory(app, i === 0 ? "项目 A 周二发布前跑回归测试" : `生日祝福与蛋糕鲜花 ${i}`, { agent: "investigator", folder: "发布" });
      date(app, m.id, i + 1); return m;
    });
    const shared = Array.from({ length: 10 }, (_, i) => memory(app, `项目 A 周二发布前跑回归测试，经验 ${i}`));
    const bad = memory(app, "项目 A 周二发布前跑回归测试，尚未复核", { agent: "investigator", createdBy: "agent" });
    const badShared = memory(app, "项目 A 周二发布前跑回归测试，共享未复核", { createdBy: "agent" });
    await vectors(app);
    const far = memory(app, "生日祝福与蛋糕鲜花，共享");
    await embedPendingMemories(app);
    const ids = await lessonIdsForTask(app, task());
    const text = await lessonsForTask(app, task());
    // Of the profile's own experience only what is close to the task: the birthday ones stay in their folder.
    expect(ids.filter((id) => own.some((m) => m.id === id))).toEqual([own[0].id]);
    expect(ids.filter((id) => shared.some((m) => m.id === id))).toHaveLength(8);
    expect(ids).not.toContain(far.id);
    expect(ids).not.toContain(bad.id); expect(ids).not.toContain(badShared.id);
    expect(text).toContain("还有 19 条"); expect(text).toContain('recall(folder="目录", query="关键词")');
    // An experience is told with its id, to cite or correct.
    expect(text).toContain(`- 经验 mem:${own[0].id}（本档案）：项目 A 周二发布前跑回归测试`);
    expect(text).toContain("照常写它的 mem:<id>");
    // Without a floor the closest fill the places, however far.
    app.config.memory.lessonFloor = 0;
    const loose = await lessonIdsForTask(app, task());
    expect(loose.filter((id) => own.some((m) => m.id === id))).toHaveLength(12);
    expect(loose).toContain(own[0].id);
    app.config.memory.lessonFloor = 0.55;
    expect(await lessonsForTask(app, task(["search"]))).not.toContain("按目录放着");
    for (const m of [...own, ...shared, far, bad, badShared]) expect(text.includes(m.content)).toBe(ids.includes(m.id));
    app.config.embeddings.provider = "none";
    expect((await lessonIdsForTask(app, task())).filter((id) => own.some((m) => m.id === id))).toEqual(own.slice(8).reverse().map((m) => m.id));
  });

  it("keeps all standing preferences, small own experience sets, then the newest six with a map", () => {
    const app = setup();
    const prefs = Array.from({ length: 30 }, (_, i) => memory(app, `偏好第 ${i} 项用中文说明。`, { kind: "preference" }));
    const own = Array.from({ length: 12 }, (_, i) => {
      const m = memory(app, `本档案经验第 ${i} 项。`, { agent: "investigator", folder: "发布" }); date(app, m.id, i + 1); return m;
    });
    const shared = memory(app, "共享经验不在常驻段里。");
    const main = memory(app, "主助手的专属经验。", { agent: "assistant" });
    const bad = memory(app, "未复核的偏好。", { kind: "preference", createdBy: "agent" });
    const prep = () => prepareRun(app, { actor: { spec: spec() }, spaceId: "personal", runId: null });
    let p = prep();
    expect(new Set(p.lessonIds)).toEqual(new Set([...prefs, ...own].map((m) => m.id)));
    for (const m of [...prefs, ...own]) expect(p.system).toContain(m.content);
    expect(p.system).not.toContain(shared.content); expect(p.system).not.toContain(bad.content);
    expect(p.system).not.toContain(main.content);
    const extra = memory(app, "最新的档案经验。", { agent: "investigator", folder: "发布" }); date(app, extra.id, 30);
    p = prep();
    const shown = [extra, ...own.slice(7).reverse()];
    expect(new Set(p.lessonIds)).toEqual(new Set([...prefs, ...shown].map((m) => m.id)));
    for (const m of [...prefs, ...own, extra]) expect(p.system.includes(m.content)).toBe(p.lessonIds.includes(m.id));
    expect(p.system).toContain("还有 7 条"); expect(p.system).toContain("发布（13 条）");
    const assistant = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: null });
    expect(assistant.system).toContain(main.content); expect(assistant.lessonIds).toContain(main.id);
    expect(assistant.recall?.own).toBe("assistant");
  });
});

describe("recall scope over ACP", () => {
  async function backend(mode: "echo" | "thread") {
    const home = mkdtempSync(join(tmpdir(), "omem-recall-scope-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: mode } }] }, sessions: { mergeMs: 0 } }));
    return boot(home, { port: 0, quiet: true, background: false });
  }

  it("adds task memories and records answer lessons and passive hits, but not upkeep", async () => {
    const { app, server } = await backend("echo");
    try {
      const lesson = memory(app, "项目 A 周二发布前跑回归测试", { agent: "assistant" });
      const fact = memory(app, "项目 A 周二发布前跑回归测试，先确认回滚版本。", { kind: "fact" });
      await vectors(app); app.config.memory.passive.threshold = 0.5;
      const answerRun = createRun(app, { kind: "agent", spaceId: "personal", title: "发布检查", input: { inline: true } });
      const upkeepRun = createRun(app, { kind: "agent", spaceId: "personal", title: "整理材料", input: { inline: true } });
      run(app.db, "update runs set status = 'done' where id in (?,?)", answerRun.id, upkeepRun.id);
      const result = await runRole(app, { role: "assistant", spaceId: "personal", task: "项目 A 周二发布前跑回归测试", runId: answerRun.id, profileId: "fake" });
      const echo = JSON.parse(result.text);
      expect(echo.prompt).toContain("按这次任务自动找到的"); expect(echo.prompt).toContain(`mem:${fact.id}`);
      // The lesson is in the instructions, with its id to cite; the found memories do not repeat it.
      expect(echo.prompt.split("## 可能相关的记忆")[1]).not.toContain(`mem:${lesson.id}`);
      expect(echo.prompt.split("## 可能相关的记忆")[0]).toContain(`经验 mem:${lesson.id}（本档案）`);
      expect(JSON.stringify(echo)).toContain(lesson.content);
      expect(all(app.db, "select memory_id, via, purpose from memory_recalls where run_id = ? order by via", answerRun.id)).toEqual([{ memory_id: lesson.id, via: "lesson", purpose: "answer" }, { memory_id: fact.id, via: "passive", purpose: "answer" }]);
      const upkeep = await runRole(app, { role: "ingest", spaceId: "personal", task: "项目 A 周二发布前跑回归测试", runId: upkeepRun.id, profileId: "fake" });
      expect(JSON.parse(upkeep.text).prompt).not.toContain("## 可能相关的记忆");
      expect(all(app.db, "select * from memory_recalls where run_id = ?", upkeepRun.id)).toEqual([]);
    } finally { releaseAll(); await server.close(); }
  }, 60000);

  it("does not repeat a standing preference in chat, and passively adds accepted shared experience", async () => {
    const { app, server } = await backend("thread");
    try {
      const pref = memory(app, "项目 A 周二发布前跑回归测试，用中文说明。", { kind: "preference" });
      const shared = memory(app, "项目 A 周二发布前跑回归测试，先核对版本。", { createdBy: "agent" });
      run(app.db, "update memories set review_verdict = 'keep' where id = ?", shared.id);
      await vectors(app); app.config.memory.passive.threshold = 0.5;
      const first = await receive(app, { channel: "web", text: "项目 A 周二发布前跑回归测试？", mergeMs: 0 });
      const result = await waitForRun(app, first.runId!);
      expect(result.error).toBeNull();
      const echo = JSON.parse((result.output as { answer: string }).answer);
      expect(echo.memories).toContain(shared.id); expect(echo.memories).not.toContain(pref.id);
      const rows = all<{ memory_id: string }>(app.db, "select memory_id from memory_recalls where run_id = ? and via = 'passive'", first.runId!);
      expect(rows).toEqual([{ memory_id: shared.id }]);
    } finally { releaseAll(); await server.close(); }
  }, 60000);
});
