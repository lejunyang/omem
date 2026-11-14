import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";
import { one, run } from "../src/core/db.ts";
import { configSchema } from "../src/core/config.ts";
import { runPeerCommand } from "../src/core/peer-exec.ts";
import { createSpace } from "../src/core/spaces.ts";
import { dreamFolders, dreamFoldersText, markDreamFolders } from "../src/agents/dream-consolidate.ts";
import { __testHandlers, addRunEvent, createRun, runEvents, stopWorker, waitForRun } from "../src/agents/runs.ts";
import * as runner from "../src/agents/runner.ts";
import { findSkill, readAgentSpec, saveAgentSpec, saveSkill, setSkillStatus } from "../src/agents/specs.ts";
import { skillCandidates } from "../src/agents/replay-skills.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { boot } from "../src/main.ts";
import { testApp } from "./helpers.ts";

// The feature tests do not create commits, even in their disposable libraries.
vi.mock("../src/core/git.ts", async (original) => ({
  ...await original<typeof import("../src/core/git.ts")>(), ensureLibraryRepo: vi.fn(), commitLibrary: vi.fn(),
}));

const apps: App[] = [];
const homes: string[] = [];
const servers: { close(): Promise<unknown> }[] = [];
function setup() {
  const app = testApp();
  apps.push(app); homes.push(app.home);
  saveAgentSpec(app, { name: "investigator", description: "调查项目 A", prompt: "按原件调查" }, "user");
  return app;
}
function seed(app: App, n: number, profile: string | null = "investigator", folder = "工作/排查", options: { kind?: string; status?: string; space?: string; prefix?: string } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `m_${createHash("sha256").update(`${options.prefix ?? "own"}:${profile}:${folder}:${i}`).digest("hex").slice(0, 20)}`;
    run(app.db, `insert into memories(id, space_id, kind, subject, content, status, agent, folder, created_at, updated_at)
      values(?,?,?,?,?,?,?,?,?,?)`, id, options.space ?? "personal", options.kind ?? "experience", `标题 ${i}`, "项目 A 超时先检查连接池。", options.status ?? "active", profile, folder,
      new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), "2026-10-01T00:00:00Z");
    ids.push(id);
  }
  return ids;
}
const nextNight = (app: App) => run(app.db, "delete from kv where key = 'dream_consolidate_night'");
const marked = (app: App) => one<{ value: string }>(app.db, "select value from kv where key = 'dream_consolidated:investigator:工作/排查'");
const dreamContext = (app: App) => {
  const queued = createRun(app, { kind: "dream", spaceId: "personal", title: "做梦" });
  return { app, run: queued, signal: new AbortController().signal, event: vi.fn(), output: vi.fn() };
};
afterEach(async () => {
  vi.restoreAllMocks();
  if (servers.length) stopWorker();
  for (const server of servers.splice(0)) await server.close();
  for (const app of apps.splice(0)) app.db.close();
  for (const home of homes.splice(0)) {
    const within = relative(resolve(tmpdir()), resolve(home));
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("测试目录不在临时目录内");
    // Empty directories bottom-up: Windows may refuse fs.rm's initial rmdir on a nonempty home.
    const remove = async (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) await remove(path);
        else unlinkSync(path);
      }
      for (let attempt = 0; ; attempt++) {
        try { rmdirSync(dir); break; }
        catch (error) {
          // The ACP shell may still be exiting with this directory as its cwd.
          if (attempt >= 40 || !["EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise((done) => setTimeout(done, 100));
        }
      }
    };
    await remove(home);
  }
});

describe("做梦把过大的专属经验目录交给 Agent", () => {
  it("默认 30 条、每晚 2 个；配置可分别覆盖", () => {
    expect(configSchema.parse({}).dream.consolidate).toEqual({ min: 30, perNight: 2 });
    expect(configSchema.parse({ dream: { consolidate: { min: 12 } } }).dream.consolidate).toEqual({ min: 12, perNight: 2 });
    expect(configSchema.safeParse({ dream: { consolidate: { min: 0, perNight: -1 } } }).success).toBe(false);
  });

  it("同伴设备的现有配置命令包含两个设置", async () => {
    const app = setup();
    expect(await runPeerCommand(app, "config", {})).toMatchObject({ dream: { consolidate: { min: 30, perNight: 2 } } });
  });

  it("只数专属的有效经验，含内置角色，最大目录优先，最多 12 个标题", () => {
    const app = setup();
    seed(app, 29); seed(app, 40, null); seed(app, 35, "coder", "工作/编码");
    seed(app, 30, "investigator", "工作/发布");
    seed(app, 40, "missing"); seed(app, 40, "investigator", "工作/事实", { kind: "fact" });
    seed(app, 40, "investigator", "工作/旧经验", { status: "retracted" }); seed(app, 40, "investigator", "");
    const picked = dreamFolders(app);
    expect(picked.map((f) => [f.profile, f.folder, f.count])).toEqual([["coder", "工作/编码", 35], ["investigator", "工作/发布", 30]]);
    expect(picked[0].subjects).toHaveLength(12);
    expect(picked[0].subjects[0]).toBe("标题 34");
  });

  it("标题按实际回答的召回次数优先；整理读取不影响排序", () => {
    const app = setup(); const ids = seed(app, 30);
    for (const [id, purpose] of [[ids[0], "answer"], [ids[0], "answer"], [ids[1], "answer"], [ids[2], "upkeep"]])
      run(app.db, "insert into memory_recalls(memory_id, used, at, via, purpose) values(?,0,?,'recall',?)", id, "2026-11-01", purpose);
    expect(dreamFolders(app)[0].subjects.slice(0, 3)).toEqual(["标题 0", "标题 1", "标题 29"]);
  });

  it("阈值、每晚总量与关闭开关生效，手动再跑同晚也不超额", () => {
    const app = setup();
    seed(app, 35); seed(app, 33, "coder", "工作/编码"); seed(app, 31, "investigator", "工作/发布");
    app.config.dream.consolidate.min = 34;
    expect(dreamFolders(app)).toHaveLength(1);
    app.config.dream.consolidate.min = 30;
    const ctx = dreamContext(app);
    markDreamFolders(app, dreamFolders(app), ctx.run.id);
    expect(dreamFolders(app)).toEqual([]);
    nextNight(app);
    expect(dreamFolders(app).map((f) => f.folder)).toEqual(["工作/发布"]);
    app.config.dream.consolidate.perNight = 0;
    expect(dreamFolders(app)).toEqual([]);
  });

  it("不足阈值的不同空间不会漏数，也不会泄露被限定空间的标题", () => {
    const app = setup(); const other = createSpace(app, { name: "项目 A", kind: "project" });
    seed(app, 20); seed(app, 10, "investigator", "工作/排查", { space: other.id, prefix: "other" });
    expect(dreamFolders(app)[0].count).toBe(30);
    expect(dreamFolders(app, ["personal"])).toEqual([]);
    expect(dreamFolders(app, [])).toEqual([]);
  });

  it("增长至少 30% 才再交；跳过的目录也等增长，不会每晚重复", () => {
    const app = setup(); seed(app, 30);
    markDreamFolders(app, dreamFolders(app), dreamContext(app).run.id); nextNight(app);
    expect(JSON.parse(marked(app)!.value)).toMatchObject({ count: 30, date: expect.any(String), skills: [] });
    expect(dreamFolders(app)).toEqual([]);
    seed(app, 8, "investigator", "工作/排查", { prefix: "growth" });
    expect(dreamFolders(app)).toEqual([]);
    seed(app, 1, "investigator", "工作/排查", { prefix: "boundary" });
    expect(dreamFolders(app)[0].count).toBe(39);
  });

  it("用引用关联到正确目录；删除草稿可重试，复盘启用后不重写", () => {
    const app = setup(); const ids = seed(app, 30); seed(app, 32, "investigator", "工作/发布");
    const ctx = dreamContext(app);
    saveSkill(app, { name: "pool-check", description: "连接池排查", body: `先看连接池 mem:${ids[0]}`, status: "draft" });
    addRunEvent(app, ctx.run.id, "dream-skill", { name: "pool-check", agent: "investigator" });
    expect(markDreamFolders(app, dreamFolders(app), ctx.run.id)).toEqual([{ profile: "investigator", folder: "工作/排查", skill: "pool-check" }]);
    nextNight(app); expect(dreamFolders(app)).toEqual([]);
    setSkillStatus(app, "pool-check", "active", "agent");
    expect(dreamFolders(app)).toEqual([]);
    rmSync(join(app.libraryDir, "_skills", "pool-check", "SKILL.md"));
    expect(dreamFolders(app).map((f) => f.folder)).toEqual(["工作/排查"]);
  });

  it("无目录时没有任务段落；有目录时包括归属、路径、数量和标题", () => {
    expect(dreamFoldersText([])).toBe("");
    const app = setup(); seed(app, 30);
    expect(dreamFoldersText(dreamFolders(app))).toContain("经验太多的目录：\n- 档案/角色 investigator · 目录 工作/排查 · 30 条经验\n  标题样本：标题 29");
  });

  it("只有旧目录可整理时仍启动 dreamer，任务包含段落，成功后才标记", async () => {
    const app = setup(); seed(app, 30);
    const ctx = dreamContext(app);
    const role = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.role).toBe("dreamer"); expect(input.task).toContain("经验太多的目录");
      expect(marked(app)).toBeUndefined();
      return { text: "这个目录没有稳定的共同做法，跳过。", stopReason: "end_turn", agent: "fake", profileId: "fake", ai: { profile: "fake" } };
    });
    run(app.db, "insert into kv(key,value) values('dream_at','2099-01-01')");
    await __testHandlers.get("dream")!(ctx);
    expect(role).toHaveBeenCalledOnce(); expect(marked(app)).toBeDefined();
  });

  it("运行失败不标记，也不消耗当晚额度", async () => {
    const app = setup(); seed(app, 30);
    vi.spyOn(runner, "runRole").mockRejectedValue(new Error("假 Agent 失败"));
    await expect(__testHandlers.get("dream")!(dreamContext(app))).rejects.toThrow("假 Agent 失败");
    expect(marked(app)).toBeUndefined(); expect(dreamFolders(app)).toHaveLength(1);
  });

  it("Agent 返回时运行已取消，不标记目录", async () => {
    const app = setup(); seed(app, 30);
    const ctx = dreamContext(app); const controller = new AbortController();
    vi.spyOn(runner, "runRole").mockImplementation(async () => {
      controller.abort();
      return { text: "已中止", stopReason: "cancelled", agent: "fake", profileId: "fake", ai: { profile: "fake" } };
    });
    await expect(__testHandlers.get("dream")!({ ...ctx, signal: controller.signal })).rejects.toThrow("CANCELLED");
    expect(marked(app)).toBeUndefined(); expect(dreamFolders(app)).toHaveLength(1);
  });

  it("dreamer 也能将草稿挂到内置角色，不改仓库角色文件", async () => {
    const app = setup();
    const result = await callTool({ app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "dreamer" },
      "save_skill", { name: "code-check", description: "项目 A 检查步骤", body: "先核对输入再执行检查。", draft: true, agent: "coder" });
    expect(result.isError).toBe(false); expect(result.text).toContain("等待夜间复盘试用");
    expect(runner.loadRole("coder", app).skills).toContain("code-check");
    expect(findSkill(app, "code-check")?.status).toBe("draft");
    expect(skillCandidates(app)).toContainEqual(expect.objectContaining({ name: "code-check", owners: ["coder"] }));
  });

  it("dreamer 能跨档案分页读完整目录，仍按空间限制且看不到别的档案", async () => {
    const app = setup(); const ids = seed(app, 205); seed(app, 3, "coder");
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent", role: "dreamer" };
    const first = await callTool(ctx, "recall", { agent: "investigator", folder: "工作/排查" });
    expect(first.isError).toBe(false); expect(first.text).toContain("offset=200"); expect(first.text).not.toContain("coder 专用");
    const rest = await callTool(ctx, "recall", { agent: "investigator", folder: "工作/排查", offset: 200 });
    const read = [...(first.text + "\n" + rest.text).matchAll(/^- (m_\S+)/gm)].map((m) => m[1]);
    expect(new Set(read)).toEqual(new Set(ids)); expect(read).toHaveLength(205);
    expect((await callTool({ ...ctx, spaces: [] }, "recall", { agent: "investigator", folder: "工作/排查" })).text).toBe("没有相关记忆。");
  });

  it("真实 ACP + MCP：梦中读档案经验、保存并挂载草稿，摘要可见且进入 K1 候选", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-dream-")); homes.push(home);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "dream" } }] },
      sessions: { background: { enabled: false } },
    }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    apps.push(app); servers.push(server);
    saveAgentSpec(app, { name: "investigator", description: "调查项目 A", prompt: "按原件调查" }, "user");
    seed(app, 30);
    const queued = createRun(app, { kind: "dream", spaceId: "personal", title: "做梦" });
    const done = await waitForRun(app, queued.id);
    expect(done.error).toBeNull(); expect(done.status).toBe("done");
    expect(findSkill(app, "folder-troubleshooting")?.status).toBe("draft");
    expect(readAgentSpec(app, "investigator").skills).toContain("folder-troubleshooting");
    expect(skillCandidates(app)).toContainEqual(expect.objectContaining({ name: "folder-troubleshooting", owners: ["investigator"] }));
    expect(done.output.summary).toContain("folder-troubleshooting（investigator · 工作/排查）");
    expect(JSON.parse(marked(app)!.value).skills).toEqual(["folder-troubleshooting"]);
    expect(runEvents(app, queued.id).some((e) => e.type === "dream-skill")).toBe(true);
  }, 60_000);
});
