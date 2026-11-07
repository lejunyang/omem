import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { artifactFile, artifactInbox, attachPath, collectInbox, listArtifacts } from "../src/agents/artifacts.ts";
import { codeChainFor, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { addTask, listTasks } from "../src/agents/code-tasks.ts";
import { codeHistory } from "../src/agents/code-history.ts";
import { preCheckOf, preCheckText } from "../src/agents/pre-check.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { OWNER } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

async function work(app: ReturnType<typeof testApp>, id: string) {
  run(app.db, "update runs set status = 'running' where id = ?", id);
  const r = getRun(app, id);
  const out = await __testHandlers.get(r.kind)!({
    app, run: r, signal: new AbortController().signal,
    event: (type, data) => addRunEvent(app, id, type, data),
    output: (data) => setRunOutput(app, id, data),
  }) as Record<string, unknown>;
  setRunOutput(app, id, out ?? {});
  run(app.db, "update runs set status = 'done' where id = ?", id);
  trySettleCodeChain(app, id);
  return out as { verdict: string };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "omem-art-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "refund.ts"), "export const refund = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}

describe("run artifacts", () => {
  it("takes an inbox by task folder, groups by folder, keeps a report folder whole and empties the inbox", async () => {
    const app = testApp();
    const { dir } = repo();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const root = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"], taskMode: true } });
    addTask(app, root.id, { title: "退款只算未发货的行", kind: "build" }, "coder");
    addTask(app, root.id, { title: "补测试", kind: "build" }, "coder");
    const inbox = artifactInbox(app, root.id);
    mkdirSync(join(inbox, "T2"), { recursive: true });
    mkdirSync(join(inbox, "改前"), { recursive: true });
    mkdirSync(join(inbox, "report", "data"), { recursive: true });
    writeFileSync(join(inbox, "T2", "list.png"), PNG);
    writeFileSync(join(inbox, "改前", "list.png"), PNG);
    writeFileSync(join(inbox, "report", "index.html"), "<script src='data/app.js'></script>");
    writeFileSync(join(inbox, "report", "data", "app.js"), "1");
    writeFileSync(join(inbox, "T9-not-a-folder.log"), "x");
    writeFileSync(join(inbox, ".hidden"), "x");

    const taken = await collectInbox(app, root.id, { task: 1, source: "agent", by: "coder" });
    const by = Object.fromEntries(taken.made.map((a) => [a.name, a]));
    expect(Object.keys(by).sort()).toEqual(["T9-not-a-folder.log", "list.png", "report", "改前/list.png"].sort());
    expect(by["list.png"]).toMatchObject({ task: 2, kind: "image" });
    expect(by["改前/list.png"]).toMatchObject({ task: 1, kind: "image" });
    expect(by.report).toMatchObject({ kind: "site", task: 1, entry: "index.html", size: 35 + 1 });
    expect(by["T9-not-a-folder.log"]).toMatchObject({ kind: "text", task: 1 });
    // The run's turn is over: the inbox goes (finish_task keeps it, emptied, for the agent still at work).
    expect(existsSync(inbox)).toBe(false);

    // Served by key: the page and its own files; a wrong key, another path or a way out are not.
    const [id, key] = /\/api\/artifacts\/([^/]+)\//.exec(by.report.url)![1].split(".");
    expect(artifactFile(app, `${id}.${key}`, "data/app.js")?.mime).toContain("javascript");
    expect(artifactFile(app, `${id}.wrong`, "index.html")).toBeNull();
    expect(artifactFile(app, `${id}.${key}`, "../../config.json")).toBeNull();
    const img = /\/api\/artifacts\/([^/]+)\//.exec(by["list.png"].url)![1];
    expect(artifactFile(app, img, "other.png")).toBeNull();
    expect((await listArtifacts(app, root.id)).length).toBe(4);
  });

  it("hands in a file or report folder by path only from the delegation's workspaces and the inbox", async () => {
    const app = testApp();
    const { dir } = repo();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const root = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款", input: { task: "退款", repos: ["shop-api"] } });
    mkdirSync(join(dir, "shots"), { recursive: true });
    writeFileSync(join(dir, "shots", "a.png"), PNG);
    const outside = mkdtempSync(join(tmpdir(), "omem-out-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    const made = await attachPath(app, root.id, "shots/a.png", [dir], { caption: "退款单列表，改后", source: "agent", by: "coder" });
    expect(made.made[0]).toMatchObject({ name: "a.png", caption: "退款单列表，改后", kind: "image" });
    // The original stays where it is.
    expect(existsSync(join(dir, "shots", "a.png"))).toBe(true);
    await expect(attachPath(app, root.id, join(outside, "secret.txt"), [dir], { source: "agent", by: "coder" })).rejects.toThrow(/找不到/);
    await expect(attachPath(app, root.id, "../" + outside.split(/[\\/]/).pop() + "/secret.txt", [dir], { source: "agent", by: "coder" })).rejects.toThrow(/找不到/);
    await expect(attachPath(app, root.id, ".", [dir], { source: "agent", by: "coder" })).rejects.toThrow(/整个工作区/);
  });

  it("serves files by key without a login (ranges, a sandbox for pages) and lists them behind the run's permission", async () => {
    const app = testApp();
    app.config.token = "secret-token";
    const root = createRun(app, { kind: "agent", spaceId: "personal", title: "截图", input: {} });
    const inbox = artifactInbox(app, root.id);
    writeFileSync(join(inbox, "page.html"), "<h1>hi</h1>");
    writeFileSync(join(inbox, "clip.mp4"), Buffer.alloc(1000, 7));
    await collectInbox(app, root.id, { source: "command", by: "host" });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
      expect((await fetch(`${base}/api/runs/${root.id}/artifacts`)).status).toBe(401);
      const list = await (await fetch(`${base}/api/runs/${root.id}/artifacts`, { headers: { authorization: "Bearer secret-token" } })).json() as { artifacts: { name: string; url: string; id: string }[] };
      const page = list.artifacts.find((a) => a.name === "page.html")!;
      const clip = list.artifacts.find((a) => a.name === "clip.mp4")!;
      const r = await fetch(`${base}${page.url}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
      expect(await r.text()).toBe("<h1>hi</h1>");
      const part = await fetch(`${base}${clip.url}`, { headers: { range: "bytes=10-19" } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-range")).toBe("bytes 10-19/1000");
      expect((await part.arrayBuffer()).byteLength).toBe(10);
      expect((await fetch(`${base}${clip.url.replace(/\.[\w-]+\//, ".nope/")}`)).status).toBe(404);
      const gone = await fetch(`${base}/api/runs/${root.id}/artifacts/${clip.id}`, { method: "DELETE", headers: { authorization: "Bearer secret-token" } });
      expect(gone.status).toBe(200);
      expect((await fetch(`${base}${clip.url}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("the check before coding reaches the coder, the coder's screenshots land on their tasks, and the reviews get both", async () => {
    const app = testApp();
    app.config.agents.autoAdvance.preCheck = true;
    const prompts = join(mkdtempSync(join(tmpdir(), "omem-prompts-")), "p.log");
    app.config.agents.profiles.push({ id: "fake", name: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "tasks", FAKE_SHOTS: "1", FAKE_PROMPT_LOG: prompts }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    const { dir } = repo();
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "shop-api", userId: OWNER });
      const ask = createRun(app, { kind: "ask", spaceId: "shop-api", title: "交办", input: { conversationId: t.id } });
      const r1 = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款金额", input: { task: "退款只按未发货的行计算", repos: ["shop-api"], taskMode: true }, parentId: ask.id });
      codeChainFor(app, r1);
      await work(app, r1.id);

      const pc = preCheckOf(app, r1.id)!;
      expect(pc.summary).toContain("对账");
      expect(pc.summary).toContain("提交记录");
      expect(pc.regressions?.map((x) => x.auto)).toEqual([true, false]);
      expect(pc.by?.profile).toBe("fake");
      const sent = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string);
      const coder = sent.find((p) => p.includes("先用 `plan_tasks` 拆分"))!;
      expect(coder).toContain("## 编码前的检查");
      expect(coder).toContain("对账脚本按退款金额汇总");
      // The stage review's checks read the brief and the screenshots (with their files on this machine).
      const check = sent.find((p) => p.includes("你负责的评审项："))!;
      expect(check).toContain("## 编码前的检查");
      expect(check).toContain("## 截图、录屏和报告");

      const tasks = listTasks(app, r1.id).filter((x) => x.kind === "build");
      const shots = await listArtifacts(app, r1.id);
      const on = (seq: number) => shots.filter((a) => a.task === seq).map((a) => a.name).sort();
      expect(on(tasks[0].seq)).toEqual([`改后/T${tasks[0].seq}-退款单.png`]);
      expect(on(tasks[1].seq)).toEqual(["测试报告.txt", `改后/T${tasks[1].seq}-退款单.png`].sort());
      expect(shots.every((a) => existsSync(join(app.home, "artifacts", a.id)))).toBe(true);
      expect(preCheckText(pc, "review")).toContain("[人工] 退款单列表展示的金额");
    } finally {
      await server.close();
    }
  }, 120_000);

  it("looks up what is known about files: findings raised on them, the tasks that planned them, their commits", async () => {
    const app = testApp();
    const { dir, git } = repo();
    writeFileSync(join(dir, "refund.ts"), "export const refund = 1;\n");
    git("commit", "-qam", "退款按行计算");
    createSpace(app, { id: "shop-api", name: "订单服务", kind: "repo", rootPath: dir });
    const root = createRun(app, { kind: "code", spaceId: "shop-api", title: "退款按行计算", input: { task: "退款", repos: ["shop-api"], taskMode: true } });
    addTask(app, root.id, { title: "改退款", kind: "build", origin: { files: ["refund.ts"] } }, "coder");
    run(app.db, "insert into reviews(id, code_run_id, round, check_name, verdict, created_at) values('rv1', ?, 1, 'review-business', 'changes_requested', '2026-11-01T00:00:00Z')", root.id);
    run(app.db, "insert into review_findings(review_id, severity, file_path, line, title) values('rv1', 'major', 'refund.ts', 1, '已发货的行不能退')");
    const text = codeHistory(app, { space: "shop-api", paths: ["./refund.ts", "nope.ts"], spaces: null });
    expect(text).toContain("「退款按行计算」");
    expect(text).toContain("[严重] 已发货的行不能退");
    expect(text).toContain("退款按行计算\n");
    expect(text).toMatch(/### nope\.ts\n仓库里没有这个文件/);
    // Through the tool, within the caller's spaces.
    const ctx: ToolContext = { app, runId: null, spaceId: "shop-api", spaces: ["personal"], tools: null, actor: "agent" };
    expect(await callTool(ctx, "code_history", { space: "shop-api", paths: ["refund.ts"] })).toMatchObject({ isError: true });
    expect(await callTool({ ...ctx, spaces: ["shop-api"] }, "code_history", { space: "shop-api", paths: ["refund.ts"] })).toMatchObject({ isError: false });
  });
});
