import { readFileSync } from "node:fs";
import { helpText, TOOL_GROUPS } from "../src/agents/tool-help.ts";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRole, prepareRun, runRole, toolSections } from "../src/agents/runner.ts";
import { remember } from "../src/memory/store.ts";
import type { App } from "../src/core/app.ts";
import { createRun } from "../src/agents/runs.ts";
import { agentProfileSchema, roleNames } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { embedPending, embedPendingMemories, setEmbedderForTests } from "../src/search/embeddings.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); });

let lastApp: App | null = null;

type Echo = { session: string; resumed: boolean; system: string | null; prompt: string; sent: Record<string, unknown> };

async function setup(env: Record<string, string>) {
  const app = testApp();
  lastApp = app;
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo", ...env } })];
  const server = await startServer(app, { port: 0, quiet: true });
  cleanups.push(() => server.close());
  return async (task: string, resumeSessionId?: string) => {
    const run = createRun(app, { kind: "code", spaceId: "personal", title: "测试交办" });
    const events: { type: string }[] = [];
    const r = await runRole(app, { role: "coder", spaceId: "personal", task, runId: run.id, resumeSessionId, persistSession: true, onEvent: (e) => events.push(e) });
    // What the run page reads: how the instructions went and how big the turn was.
    return { ...JSON.parse(r.text), sent: events.find((e) => e.type === "prompt") } as Echo;
  };
}

describe("what the instructions carry", () => {
  it("combines tool names and capability markers under a heading", () => {
    const text = "intro\r\n## A\r\n<!-- needs: local -->\r\n<!-- tools: search scan -->\r\nfiles\r\n## B\r\n<!-- needs: tools -->\r\nlookup";
    expect(toolSections(text, new Set(["scan"]))).toBe("intro\n## A\nfiles\n## B\nlookup");
    expect(toolSections(text, new Set(["scan"]), false)).toBe("intro\n## B\nlookup");
    expect(toolSections(text, new Set(), true)).toBe("intro");
  });

  it("requires all words on one when line, accepts alternate lines and checks hidden words", () => {
    const body = "## 条件\n<!-- tools: search -->\n<!-- when: chat !awareness -->\n<!-- when: background code -->\n正文";
    const render = (...scene: string[]) => toolSections(body, new Set(["search"]), true, scene);
    expect(render("chat")).toContain("## 条件");
    expect(render("background", "code")).toContain("## 条件");
    expect(render("chat", "awareness")).toBe("");
    expect(render("background", "review")).toBe("");
    expect(toolSections(body, new Set(), true, ["chat"])).toBe("");
    expect(() => toolSections(body.replace("code", "!typo"), new Set(), true, ["chat"])).toThrow("!typo");
  });

  it("checks the owner's role copy on load and renders both parts of an agent profile", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    const { customizeRole, saveRoleOverride } = await import("../src/agents/builtin-roles.ts");
    const { readAgentSpec, saveAgentSpec } = await import("../src/agents/specs.ts");
    const { revokeToolToken } = await import("../src/agents/tools.ts");
    const original = customizeRole(app, "coder");
    const extra = "\n## 仅交谈\n<!-- when: chat -->\n正文";
    saveRoleOverride(app, "coder", original + extra);
    saveAgentSpec(app, { name: "reader", description: "阅读", prompt: "## 常规\n正文" + extra,
      instructions: "## 写入\n<!-- when: memory-write -->\n正文", tools: ["search"] }, "user");
    for (const actor of [{ role: "coder" as const }, { spec: readAgentSpec(app, "reader") }]) {
      for (const chat of [true, false]) {
        const prepared = prepareRun(app, { actor, spaceId: "personal", runId: null, scene: { chat } });
        revokeToolToken(prepared.token);
        expect(prepared.system.includes("## 仅交谈")).toBe(chat);
        expect(prepared.system).not.toContain("## 写入");
        if ("spec" in actor) expect(prepared.system).toContain("## 常规");
      }
    }
    saveRoleOverride(app, "coder", original + extra.replace("when: chat", "when: typo"));
    expect(() => loadRole("coder", app)).toThrow("typo");
    app.db.close();
  });

  it("leaves out the shared guide's sections about tools the run does not have", () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    const coder = prepareRun(app, { actor: { role: "coder" }, spaceId: "personal", runId: null }).system;
    expect(coder).toContain("## 工作方式");
    expect(coder).toContain("## 问本人、给本人选项");
    for (const h of ["## 怎么写记忆", "## 事项与本人的回复", "## 等一会再接着做", "## 按任务选择 AI", "## 工作文件与案例"]) expect(coder).not.toContain(h);
    const assistant = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: null }).system;
    for (const h of ["## 怎么写记忆", "## 事项与本人的回复", "## 等一会再接着做", "## 按任务选择 AI"]) expect(assistant).toContain(h);
    expect(assistant).not.toContain("<!-- tools:");
    app.db.close();
  });

  it("selects the sections for the people and the task in this turn", () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    const render = (role: "assistant" | "coach", kind: "ask" | "flow-stage" | "profile-review" | "flow-review", chat = false, denyTools: string[] = []) =>
      prepareRun(app, { actor: { role }, spaceId: "personal", runId: null, scene: { chat, kind, awareness: chat }, denyTools, addTools: ["stage_report", "stay_quiet"] }).system;
    const chat = render("assistant", "ask", true);
    expect(chat).toContain("## 会话与上下文");
    expect(chat).toContain("## 在聊天里处理或忽略事项");
    expect(chat).not.toContain("## 后台工作期间本人的补充");
    expect(chat).not.toContain("## 流程里的一个阶段");
    const stage = render("assistant", "flow-stage");
    expect(stage).toContain("## 后台工作期间本人的补充");
    expect(stage).toContain("## 流程里的一个阶段");
    expect(stage).not.toContain("## 会话与上下文");
    expect(stage).not.toContain("## 在聊天里处理或忽略事项");
    expect(render("assistant", "ask", true, ["remember", "supersede"])).not.toContain("## 怎么写记忆");
    expect(render("coach", "flow-review")).toContain("## 读流程回顾");
    expect(render("coach", "flow-review")).not.toContain("## 复盘步骤");
    expect(render("coach", "profile-review")).toContain("## 复盘步骤");
    app.db.close();
  });

  it("can open every procedure named by a role in the advertised help group", () => {
    const roles = ["_common", ...roleNames].map(name => readFileSync(resolve("roles", name + ".md"), "utf8"));
    const pointers = roles.flatMap(text => [...text.matchAll(/omem_help\("([^"]+)"\)` 的「([^」]+)」/g)]);
    expect(pointers.length).toBe(roles.reduce((n, text) => n + (text.match(/omem_help\("/g)?.length ?? 0), 0));
    expect(pointers.length).toBeGreaterThan(0);
    for (const [, group, heading] of pointers) {
      expect(TOOL_GROUPS.some(g => g.id === group), group).toBe(true);
      expect(helpText([], group).split("\n"), group).toContain("## " + heading);
    }
  });

  it("tells a task run its own lessons and only the closest shared ones", async () => {
    const turn = await setup({});
    const app = lastApp!;
    app.config.memory.review.enabled = false;
    for (let i = 1; i <= 12; i++) remember(app, { spaceId: "personal", kind: "preference", subject: `偏好${i}`, content: `本人的第 ${i} 条偏好。`, createdBy: "user", userId: "owner" });
    remember(app, { spaceId: "personal", kind: "experience", subject: "编码自己的", content: "改接口先跑契约测试。", createdBy: "user", agent: "coder" });
    const first = await turn("实现退款按钮");
    expect(first.prompt).toContain("改接口先跑契约测试。");
    // Without vectors: the newest eight shared ones.
    expect(first.prompt).toContain("本人的第 12 条偏好。");
    expect(first.prompt).toContain("本人的第 5 条偏好。");
    expect(first.prompt).not.toContain("本人的第 4 条偏好。");
  }, 60000);

  it("ranks the shared lessons by closeness to the task when there are vectors", async () => {
    const turn = await setup({});
    const app = lastApp!;
    app.config.memory.review.enabled = false;
    app.config.embeddings.provider = "local";
    setEmbedderForTests(fakeEmbedder());
    try {
      const unrelated = ["周末喜欢爬山看日出", "手机上习惯从屏幕边缘斜滑返回", "出差优先选靠窗座位", "晚饭后散步半小时", "读书笔记按月整理", "喝咖啡不加糖", "看电影选中间排", "早上先回邮件", "冬天穿深色外套", "旅行带两本纸质书", "跑步听播客", "周报周五下午写"];
      for (const c of unrelated) remember(app, { spaceId: "personal", kind: "preference", content: `本人${c}。`, createdBy: "user", userId: "owner" });
      remember(app, { spaceId: "personal", kind: "preference", content: "实现退款按钮时先弹窗确认退款金额。", createdBy: "user", userId: "owner" });
      await embedPending(app);
      while (await embedPendingMemories(app)) {}
      // The stand-in vectors count characters, so the floor is set where the related one clears it.
      app.config.memory.lessonFloor = 0.3;
      const first = await turn("实现退款按钮");
      expect(first.prompt).toContain("实现退款按钮时先弹窗确认退款金额。");
      // Only what is close to the task: the places are not filled with whatever is least far.
      expect(first.prompt).not.toContain("周末喜欢爬山看日出");
      expect(first.prompt.match(/^- 偏好/gm)!.length).toBeLessThan(8);
    } finally {
      setEmbedderForTests(null);
    }
  }, 60000);
});

describe("standing instructions", () => {
  it("open a new session and are not repeated into a resumed one", async () => {
    const turn = await setup({});
    const first = await turn("实现退款按钮");
    expect(first).toMatchObject({ resumed: false, system: null });
    expect(first.prompt).toContain("# 角色：");
    expect(first.prompt).toMatch(/（现在：.+）\n\n# 任务\n\n实现退款按钮/);
    const next = await turn("按评审修改：补上测试", first.session);
    expect(next).toMatchObject({ session: first.session, resumed: true });
    expect(next.prompt).not.toContain("# 角色：");
    expect(next.prompt).toContain("按评审修改：补上测试");
    expect(first.sent).toMatchObject({ via: "message", scene: ["background", "code"], message: first.prompt.length, parts: { lessonCount: 0 } });
    expect(next.sent).toMatchObject({ via: "resumed", message: next.prompt.length });
    expect(next.sent).toMatchObject({ systemSent: false, omemAccess: "mcp", localTools: true });
  }, 60000);

  it("go in as the system prompt when the agent takes one, without the clock", async () => {
    const turn = await setup({ FAKE_SYSTEM: "1" });
    const first = await turn("实现退款按钮");
    expect(first.system).toContain("# 角色：");
    expect(first.system).not.toMatch(/现在：/);
    expect(first.prompt).not.toContain("# 角色：");
    expect(first.prompt).toContain("实现退款按钮");
    // Sent again on resume (some agents set it per process), still not in the message.
    const next = await turn("按评审修改：补上测试", first.session);
    expect(next).toMatchObject({ session: first.session, resumed: true, system: first.system });
    expect(next.prompt).not.toContain("# 角色：");
    expect(next.sent).toMatchObject({ via: "system", systemSent: true });
    expect(first.sent).toMatchObject({ via: "system", instructions: first.system!.length });
  }, 60000);
});
