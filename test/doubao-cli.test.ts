import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deleteDoubaoCliSession, doubaoAcpSessionId, doubaoCommand, doubaoCwdOptionFromHelp, doubaoFeatures, doubaoFeaturesFromHelp, modelList, probeDoubaoCli, runDoubaoCli } from "../src/agents/doubao-cli.ts";
import { agentProfileSchema, type AgentProfile } from "../src/core/config.ts";
import { agentRunError, type AgentEvent } from "../src/agents/types.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { testApp } from "./helpers.ts";
import { all } from "../src/core/db.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { askModel } from "../src/agents/oneshot.ts";
import { backendCapabilities } from "../src/agents/capabilities.ts";
import * as acp from "../src/agents/acp.ts";
import { threadTurn } from "../src/agents/sessions.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { runCodeTask } from "../src/agents/code.ts";
import { addRunEvent, createRun, getRun, runEvents, setRunOutput } from "../src/agents/runs.ts";
import { createUser, addMember } from "../src/core/users.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { createSpace } from "../src/core/spaces.ts";
import * as reviews from "../src/agents/review-chain.ts";
import * as runner from "../src/agents/runner.ts";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { agentToolEnv } from "../src/agents/tool-cli.ts";
import { startServer } from "../src/server/http.ts";

const fake: AgentProfile = { id: "doubao-cli", transport: "doubao-cli", command: process.execPath, args: [resolve("test/fake-doubao-cli.ts")], env: {}, idleTimeoutMs: 60_000 };

describe("doubao cli", () => {
  it("binds concurrent turns to their own tools even when the daemon passes an old token and URL", async () => {
    const app = testApp();
    const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
    const address = server.server.address() as { port: number };
    app.baseUrl = `http://127.0.0.1:${address.port}`;
    const temp = mkdtempSync(join(tmpdir(), "doubao-tools-'$-"));
    const log = join(temp, "paths.log");
    const tokens: string[] = [];
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temp);
    try {
      const results = await Promise.all(["one", "two"].map(async id => {
        createSpace(app, { id, name: `项目 ${id}` });
        const token = issueToolToken({ runId: null, spaceId: id, spaces: [id], tools: new Set(["list_spaces"]), actor: "agent" });
        tokens.push(token);
        return runDoubaoCli({ ...fake, env: { FAKE_STALE_TOOLS: "1", FAKE_TOOL_PATHS: log } }, {
          cwd: app.home, prompt: "列出本轮空间", mcp: { url: "", baseUrl: app.baseUrl!, token, stdio: { command: "", args: [] }, env: agentToolEnv(app.home, app.baseUrl!, token) },
        }, () => {});
      }));
      expect(results[0].text).toContain("项目 one"); expect(results[0].text).not.toContain("项目 two");
      expect(results[1].text).toContain("项目 two"); expect(results[1].text).not.toContain("项目 one");
      const commands = readFileSync(log, "utf8").trim().split("\n");
      expect(new Set(commands).size).toBe(2);
      expect(readdirSync(join(temp, "omem-doubao"))).toEqual([]);
      for (const token of tokens) expect(commands.join("\n")).not.toContain(token);
      await expect(runDoubaoCli({ ...fake, command: join(temp, "missing") }, { cwd: app.home, prompt: "fail",
        mcp: { url: "", baseUrl: app.baseUrl!, token: tokens[0], stdio: { command: "", args: [] } } }, () => {})).rejects.toThrow();
      expect(readdirSync(join(temp, "omem-doubao"))).toEqual([]);
    } finally {
      vi.unstubAllEnvs(); tokens.forEach(revokeToolToken);
      await server.close(); app.db.close();
      rmSync(app.home, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
    }
  });
  it.each([
    ["  -C <目录> 设置工作区\n 必须放在 -p 之前", "-C"],
    ["  --cwd <DIRECTORY> Working directory", "--cwd"],
    ["  --directory=<path> Working directory", "--directory"],
    ["Usage: tool -C example\n  -p <prompt> Run", null],
  ] as const)("从帮助认出目录参数 %s", (help, flag) => {
    expect(doubaoCwdOptionFromHelp(help)).toBe(flag);
    const args=doubaoCommand(fake,{cwd:"workspace",prompt:"",resumeSessionId:"existing"},"hi",flag).args;
    expect(args).toEqual([...fake.args,...flag?[flag,"workspace"]:[],"--resume","existing","-p","hi","--permission-mode","ask_risky"]);
  });
  it.each(["  -C <dir> 工作目录", "  --cwd <dir> 工作目录", "  -p <prompt> Run"])("假帮助缓存且运行保持进程cwd：%s",async help => {
    const cwd=mkdtempSync(join(tmpdir(),"doubao-cwd-")), log=join(cwd,"help.log");
    vi.stubEnv("FAKE_CWD_HELP",help);vi.stubEnv("FAKE_HELP_LOG",log);vi.stubEnv("FAKE_DIRECTORY","1");
    const profile={...fake,args:[...fake.args,"--fixture",help]};
    try {
      const selected=doubaoFeatures(profile).cwdOption;
      expect(doubaoFeatures(profile).cwdOption).toBe(selected);
      const result=await runDoubaoCli(profile,{cwd,prompt:"fixture"},()=>{});
      expect(JSON.parse(result.text)).toEqual({cwd,...selected?{directory:cwd}:{}});
      expect(readFileSync(log,"utf8")).toBe("help\n");
    } finally {vi.unstubAllEnvs();rmSync(cwd,{recursive:true,force:true});}
  });

  it("从帮助认出 ACP 和删除会话（旧版没有这两项）", () => {
    const now = "用法：doubao [选项]\n      doubao acp serve [--model <模型>]\n      doubao model list [输出选项]\n      doubao delete <会话ID> [--yes]\n通用选项：\n  -C <目录>                  设置工作区";
    expect(doubaoFeaturesFromHelp(now)).toEqual({ cwdOption: "-C", acp: true, delete: true, modelList: true });
    expect(doubaoFeaturesFromHelp("用法：doubao -p <提示词>\n  -C <目录>  工作区")).toEqual({ cwdOption: "-C", acp: false, delete: false, modelList: false });
    expect(doubaoAcpSessionId("38456421390398210")).toBe("conversation-38456421390398210");
    expect(doubaoAcpSessionId("a4191a4d-c10a-4417-b0a9-3a6dfd8330fb")).toBe("a4191a4d-c10a-4417-b0a9-3a6dfd8330fb");
  });
  it("新版的 ACP 后端经 MCP 用 omem 工具，旧版仍走终端", () => {
    vi.stubEnv("FAKE_CWD_HELP", "  doubao acp serve\n  doubao delete <会话ID> [--yes]\n  -C <dir> 工作目录");
    try {
      const profile = { ...fake, args: [...fake.args, "--fixture", "acp"] };
      expect(backendCapabilities(profile).omemAccess).toBe("mcp");
      expect(backendCapabilities(fake).omemAccess).toBe("shell-bridge");
    } finally { vi.unstubAllEnvs(); }
  });
  it("model list --json 给出模型名和各自的思考强度", () => {
    const out = '[cli-chat] {"level":"info"}\n{"type":"result","result":{"type":"model_list","models":[{"id":"9","name":"Auto","efforts":["low","high"]},{"id":"5","name":"Doubao 2.1 Pro","efforts":[]}]}}';
    expect(modelList(out)).toEqual({ models: ["Auto", "Doubao 2.1 Pro"], effortsByModel: { Auto: ["low", "high"], "Doubao 2.1 Pro": [] } });
    expect(modelList("Error: unknown command")).toBeNull();
  });
  it("用 doubao delete 删除会话编号，已经不存在的算删掉了", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doubao-delete-")), log = join(dir, "delete.log");
    vi.stubEnv("FAKE_DELETE_LOG", log);
    try {
      await deleteDoubaoCliSession(fake, "conversation-42", dir);
      await deleteDoubaoCliSession(fake, "404", dir);
      await expect(deleteDoubaoCliSession(fake, "500", dir)).rejects.toThrow(/删除会话失败/);
      expect(readFileSync(log, "utf8")).toBe("42\n404\n500\n");
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("passes model, effort, a permission mode by whether it may write, and the working directory", () => {
    const p = { ...fake, command: "doubao", args: [], model: "Auto", effort: "low" };
    expect(doubaoCommand(p, { cwd: "/w", prompt: "" }, "hi", "-C").args).toEqual(["-C", "/w", "-p", "hi", "--model", "Auto", "--effort", "low", "--permission-mode", "ask_risky"]);
    expect(doubaoCommand(p, { cwd: "/w", prompt: "", doubaoPermission: "always_allow", resumeSessionId: "9" }, "hi").args.slice(0, 2)).toEqual(["--resume", "9"]);
    expect(doubaoCommand(p, { cwd: "/w", prompt: "", doubaoPermission: "always_allow" }, "hi").args).toContain("always_allow");
  });

  it("keeps risky approval for unboxed guest turns in every global mode", () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    setSandboxSupportForTests({ ok: false, reason: "fixture unavailable" });
    try {
      for (const sandbox of ["off", "prefer"] as const) for (const mode of ["per-role", "sandboxed", "all"] as const) {
        app.config.agents.ownSandbox.mode = sandbox;
        app.config.agents.fullAccess = mode;
        for (const role of ["guest", "assistant"] as const) {
          const prep = prepareRun(app, { actor: { role }, guestTurn: true, fullAccess: true,
            spaceId: "personal", runId: null, profile: fake });
          try {
            expect(prep.isolation.box).toBeUndefined();
            expect(prep.fullAccess).toBe(true);
            expect(doubaoCommand(fake, { app, cwd: prep.cwd, prompt: "", doubaoPermission: prep.doubaoPermission, fullAccess: prep.fullAccess }, "hi").args).toContain("ask_risky");
          } finally { revokeToolToken(prep.token); }
        }
      }
    } finally { setSandboxSupportForTests(undefined); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "linux")("forces Doubao mode only in the prepared sandbox and preserves other backends' write permission", () => {
    const app = testApp();
    const home = mkdtempSync(join(tmpdir(), "doubao-mode-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_DATA_HOME", join(home, ".local/share"));
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.ownSandbox.mode = "require";
    setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
    try {
      for (const mode of ["per-role", "sandboxed", "all"] as const) {
        app.config.agents.fullAccess = mode;
        for (const transport of ["doubao-cli", "acp", "codex-cli", "claude-cli"] as const) {
          const profile = agentProfileSchema.parse({ id: "fixture", transport, command: process.execPath });
          const prep = prepareRun(app, { actor: { role: "guest" }, spaceId: "personal", runId: null, fullAccess: true, profile });
          try {
            expect(prep.isolation.box).toBeDefined();
            expect(prep.fullAccess).toBe(true);
            expect(prep.acpWritable).toBe(false);
            expect(prep.allowWrites).toBe(false);
            if (transport === "doubao-cli") expect(doubaoCommand(profile, { cwd: prep.cwd, prompt: "", doubaoPermission: prep.doubaoPermission }, "hi").args)
              .toContain(mode === "sandboxed" ? "always_allow" : "ask_risky");
          } finally { revokeToolToken(prep.token); }
        }
      }
    } finally {
      vi.unstubAllEnvs(); setSandboxSupportForTests(undefined); app.db.close();
      rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!sandboxSupport().ok)("applies prepared approval to guest replies and tool-free one-shot judgements", async () => {
    const app = testApp();
    const home = mkdtempSync(join(tmpdir(), "approval-home-"));
    vi.stubEnv("HOME", home);
    app.baseUrl = "http://127.0.0.1:1";
    const profile = { ...fake, env: { FAKE_PERMISSION: "1" } };
    // askModel can try a second backend. Both candidates run the fixture.
    app.config.agents.profiles = [profile, { ...profile, id: "codex" }];
    app.config.agents.default = profile.id;
    try {
      app.config.agents.ownSandbox.mode = "prefer";
      for (const [support, mode, expected] of [
        [true, "sandboxed", "always_allow"], [false, "sandboxed", "ask_risky"],
        [true, "all", "ask_risky"], [true, "per-role", "ask_risky"],
      ] as const) {
        setSandboxSupportForTests(support ? undefined : { ok: false, reason: "fixture" });
        app.config.agents.fullAccess = mode;
        const answer = await askModel(app, "判断");
        expect(JSON.parse(answer!)).toMatchObject({ reason: expected });
        const events: string[] = [];
        const r = await runRole(app, { role: "guest", fullAccess: true, spaceId: "personal",
          task: "回答访客", runId: null, profileId: profile.id, onEvent: e => { if (e.type === "status") events.push(e.text); } });
        const permission = JSON.parse(r.text).reason;
        expect(permission).toBe(expected);
        expect(events.filter(text => text.startsWith("使用 AI："))).toEqual([
          expect.stringMatching(permission === "always_allow" ? / · 完全访问$/ : / · 风险审批$/),
        ]);
      }
    } finally {
      setSandboxSupportForTests(undefined); vi.unstubAllEnvs(); app.db.close();
      rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  it.skipIf(!sandboxSupport().ok).each([["member", "ask_risky"], ["owner", "always_allow"]])(
    "uses the %s initiator for both delegation tier judgements", async (userId, permission) => {
      const app = testApp();
      const home = mkdtempSync(join(tmpdir(), "tier-home-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_DATA_HOME", join(home, ".local/share"));
      const backend = { ...fake, env: { FAKE_PERMISSION: "1", FAKE_TIER: "heavy" } };
      app.config.agents.profiles = [backend, { ...backend, id: "codex" }];
      app.config.agents.default = backend.id;
      app.config.agents.ownSandbox.mode = "require";
      app.config.agents.fullAccess = "sandboxed";
      app.config.review.tiers = [
        { id: "heavy", name: "完整", guide: "跨仓", checks: ["reviewer"], lead: true, confirmPlan: false,
          maxRounds: 2, when: { field: "change.repos", op: "gte", value: 2 } },
        { id: "light", name: "轻量", guide: "", checks: ["reviewer"], lead: false, confirmPlan: false, maxRounds: 1, when: null },
      ];
      const repo = mkdtempSync(join(app.home, "repo-"));
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "init", "--allow-empty"], { cwd: repo });
      const space = createSpace(app, { id: "sample", name: "示例", kind: "repo", rootPath: repo });
      if (userId !== "owner") {
        const role = saveRole(app, { name: "交办开发者", scope: "global", permissions: ["code.delegate"] });
        createUser(app, { id: userId, name: "成员", role: role.id });
        addMember(app, space.id, userId, "manager");
      }
      const run = createRun(app, { kind: "code", spaceId: space.id, userId, title: "示例", input: { task: "更新示例" } });
      const review = vi.spyOn(reviews, "reviewRound").mockResolvedValue({ verdict: "approved" });
      const coder = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
        expect(input.role).toBe("coder");
        writeFileSync(join(input.cwd!, "example.txt"), "change");
        return { text: "完成", stopReason: "end_turn", agent: "fixture", profileId: "fixture", ai: { profile: "fixture" } };
      });
      try {
        await runCodeTask({ app, run, signal: new AbortController().signal, event() {}, output: data => setRunOutput(app, run.id, data) });
        const out = getRun(app, run.id).output;
        expect(out.reviewEstimate).toMatchObject({ tier: "heavy", reason: permission });
        expect(out.reviewPlan).toMatchObject({ tier: "heavy", reasons: expect.arrayContaining([expect.stringContaining("完整」档：" + permission)]) });
      } finally {
        review.mockRestore(); coder.mockRestore(); vi.unstubAllEnvs(); app.db.close();
        rmSync(app.home, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
      }
    });

  it.each(["direct", "fallback"])("records the launched approval once for a guest answered by the assistant (%s)", async route => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.lark.guests.fullAccess = true;
    app.config.agents.fullAccess = "sandboxed";
    const cli = { ...fake, env: { FAKE_PERMISSION: "1" } };
    const primary = { ...fake, id: "busy", transport: "acp" as const };
    app.config.agents.profiles = [primary, cli];
    app.config.agents.default = route === "fallback" ? primary.id : cli.id;
    app.config.agents.fallback = [{ profile: cli.id }];
    const busy = vi.spyOn(acp, "openAcp").mockRejectedValue(agentRunError("排队超时", "queue", true));
    try {
      const thread = createThread(app, { channel: "lark", spaceId: "personal", settings: { profile: app.config.agents.default } });
      addMessage(app, thread.id, "user", "查看材料", null, { asker: "访客" });
      const run = createRun(app, { kind: "ask", title: "群内代答", input: { conversationId: thread.id } });
      const result = await threadTurn({ app, run, signal: new AbortController().signal, output() {},
        event: (type, data) => addRunEvent(app, run.id, type, data) }, thread.id, threadMessages(app, thread.id));
      expect(busy).toHaveBeenCalledTimes(route === "fallback" ? 1 : 0);
      expect(result.profileId).toBe(cli.id);
      expect(JSON.parse(result.text).reason).toBe("ask_risky");
      const status = runEvents(app, run.id).filter(e => e.type === "status").map(e => (e.data as { text: string }).text);
      expect(status.filter(s => s.startsWith("使用 AI："))).toEqual([`使用 AI：${cli.id} · 默认模型 · 默认强度 · 风险审批`]);
    } finally {
      busy.mockRestore(); app.db.close(); rmSync(app.home, { recursive: true, force: true });
    }
  });

  it("runs a turn: the prompt reaches it, the session comes from stderr, the run's env reaches it", async () => {
    // A live service may also have prompt files in the system temp directory.
    const temp = mkdtempSync(join(tmpdir(), "omem-doubao-test-"));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temp);
    try {
      const events: AgentEvent[] = [];
      const prompt = "多行\n提示 \"带引号\" %PATH% " + "长".repeat(7000);
      const r = await runDoubaoCli({ ...fake, model: "Auto" }, { cwd: process.cwd(), prompt, mcp: { url: "", baseUrl: "", token: "", stdio: { command: "", args: [] }, env: { OMEM_TOKEN: "tok" } } }, (e) => events.push(e));
      expect(r.text.startsWith(`echo:${prompt} model=Auto`)).toBe(true);
      expect(r.text.endsWith("env=tok")).toBe(true);
      expect(r.sessionId).toBe("s-1");
      expect(events.some((e) => e.type === "session" && e.sessionId === "s-1" && !e.resumed)).toBe(true);
      // The prompt file is gone after the turn.
      const dir = join(tmpdir(), "omem-doubao");
      if (existsSync(dir)) expect(readdirSync(dir)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each(["只回复两个字：收到", "只回复两个字：收到" + "\n".repeat(7000)])("uses readable empty stdin for inline and file prompts (%#)", async prompt => {
    const temp = mkdtempSync(join(tmpdir(), "doubao-stdin-test-"));
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, temp);
    try {
      const result = await runDoubaoCli(fake, { cwd: temp, prompt, env: { OMEM_TOKEN: "fixture" } }, () => {});
      expect(result.text).toBe(`echo:${prompt} model= effort= env=fixture`);
      expect(result.sessionId).toBe("s-1");
      expect(readdirSync(join(temp, "omem-doubao"))).toEqual([]);
      expect(await probeDoubaoCli(fake)).toEqual({ models: ["Auto", "Pro 1"], effortsByModel: { Auto: ["low", "medium", "high"], "Pro 1": ["low", "medium", "high", "xhigh", "max"] } });
      expect(readdirSync(join(temp, "omem-doubao"))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("continues a session and reports a failed turn with the CLI's message", async () => {
    const r = await runDoubaoCli(fake, { cwd: process.cwd(), prompt: "again", resumeSessionId: "s-7" }, () => {});
    expect(r.sessionId).toBe("s-7");
    await expect(runDoubaoCli(fake, { cwd: process.cwd(), prompt: "fail" }, () => {})).rejects.toThrow("无法启动主任务");
  });

  it("uses the probed spelling for a configured model when dispatching new and resumed turns", async () => {
    const app = testApp();
    saveProbe(app, fake.id, { at: new Date().toISOString(), agent: "fake", models: ["Auto", "Pro 1"], efforts: [] });
    const profile = { ...fake, model: "pro-1", effort: "high" };
    for (const resumeSessionId of [undefined, "s-7"]) {
      const result = await runBackend(app, profile, { cwd: process.cwd(), prompt: "hello", persistSession: true, resumeSessionId }, () => {});
      expect(result.text).toContain("model=Pro 1 effort=high");
      expect(result.sessionId).toBe(resumeSessionId ?? "s-1");
    }
    expect(profile.model).toBe("pro-1");
    // An unrelated or undetected name still reaches the CLI and reports its original error.
    await expect(runBackend(app, { ...fake, model: "Unknown" }, { cwd: process.cwd(), prompt: "hello" }, () => {})).rejects.toThrow("Unsupported --model value");
    await expect(runBackend(testApp(), profile, { cwd: process.cwd(), prompt: "hello" }, () => {})).rejects.toThrow("Unsupported --model value");
  });

  it("deletes a one-off turn's conversation through the OpenAPI, and keeps a thread's", async () => {
    const app = testApp();
    saveLarkSecret(app.home, { appId: "cli_bot", appSecret: "s" });
    app.config.lark.appId = "cli_bot";
    saveDoubaoToken(app.home, { appId: "cli_bot", accessToken: "u-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), savedAt: "" });
    const deleted: string[] = [];
    setDoubaoFetchForTests(async (input, init) => {
      if (init?.method === "DELETE") deleted.push(String(input).split("/v1/sessions/")[1]);
      return new Response(JSON.stringify({ code: 0, msg: "success", data: {} }));
    });
    try {
      await runBackend(app, fake, { cwd: process.cwd(), prompt: "one-off" }, () => {});
      expect(deleted).toEqual(["s-1"]);
      await runBackend(app, fake, { cwd: process.cwd(), prompt: "thread", persistSession: true }, () => {});
      await runBackend(app, fake, { cwd: process.cwd(), prompt: "again", resumeSessionId: "s-7" }, () => {});
      expect(deleted).toEqual(["s-1"]);
      expect(all(app.db, "select * from session_cleanup where ready >= 0")).toEqual([]);
      // A failed turn's conversation goes too.
      await expect(runBackend(app, fake, { cwd: process.cwd(), prompt: "fail-after-session" }, () => {})).rejects.toThrow();
      expect(deleted).toEqual(["s-1", "s-1"]);
    } finally {
      setDoubaoFetchForTests(null);
    }
  });

  it("without the OpenAPI on this machine, says the conversation stays", async () => {
    const app = testApp();
    const events: AgentEvent[] = [];
    await runBackend(app, fake, { cwd: process.cwd(), prompt: "one-off" }, (e) => events.push(e));
    expect(events.some((e) => e.type === "status" && e.text.includes("留在豆包历史里"))).toBe(true);
  });

  it("probes models and each model's effort levels from argument errors", async () => {
    expect(await probeDoubaoCli(fake)).toEqual({ models: ["Auto", "Pro 1"], effortsByModel: { Auto: ["low", "medium", "high"], "Pro 1": ["low", "medium", "high", "xhigh", "max"] } });
  });
});
