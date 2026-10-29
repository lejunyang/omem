import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { remember } from "../src/memory/store.ts";
import type { App } from "../src/core/app.ts";
import { createRun } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
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
      const first = await turn("实现退款按钮");
      expect(first.prompt).toContain("实现退款按钮时先弹窗确认退款金额。");
      expect(first.prompt.match(/^- 偏好/gm)).toHaveLength(8);
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
    expect(first.sent).toMatchObject({ via: "message", message: first.prompt.length, parts: { lessonCount: 0 } });
    expect(next.sent).toMatchObject({ via: "resumed", message: next.prompt.length });
    expect(next.sent.parts).toBeUndefined();
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
    expect(first.sent).toMatchObject({ via: "system", instructions: first.system!.length });
  }, 60000);
});
