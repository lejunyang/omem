import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doubaoArgs, probeDoubaoCli, runDoubaoCli } from "../src/agents/doubao-cli.ts";
import { agentProfileSchema, type AgentProfile } from "../src/core/config.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { testApp } from "./helpers.ts";
import { all } from "../src/core/db.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { askModel } from "../src/agents/oneshot.ts";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { revokeToolToken } from "../src/agents/tools.ts";

const fake: AgentProfile = { id: "doubao-cli", transport: "doubao-cli", command: process.execPath, args: [resolve("test/fake-doubao-cli.ts")], env: {}, idleTimeoutMs: 60_000 };

describe("doubao cli", () => {
  it("passes model, effort, a permission mode by whether it may write, and the working directory", () => {
    const p = { ...fake, command: "doubao", args: [], model: "Auto", effort: "low" };
    expect(doubaoArgs(p, { cwd: "/w", prompt: "" }, "hi")).toEqual(["-p", "hi", "--model", "Auto", "--effort", "low", "--permission-mode", "ask_risky", "-C", "/w"]);
    expect(doubaoArgs(p, { cwd: "/w", prompt: "", doubaoPermission: "always_allow", resumeSessionId: "9" }, "hi").slice(0, 2)).toEqual(["--resume", "9"]);
    expect(doubaoArgs(p, { cwd: "/w", prompt: "", doubaoPermission: "always_allow" }, "hi")).toContain("always_allow");
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
            expect(doubaoArgs(fake, { app, cwd: prep.cwd, prompt: "", doubaoPermission: prep.doubaoPermission, fullAccess: prep.fullAccess }, "hi")).toContain("ask_risky");
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
            if (transport === "doubao-cli") expect(doubaoArgs(profile, { cwd: prep.cwd, prompt: "", doubaoPermission: prep.doubaoPermission }, "hi"))
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
