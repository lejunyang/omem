import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { doubaoArgs, probeDoubaoCli, runDoubaoCli } from "../src/agents/doubao-cli.ts";
import type { AgentProfile } from "../src/core/config.ts";
import type { AgentEvent } from "../src/agents/types.ts";

const fake: AgentProfile = { id: "doubao-cli", transport: "doubao-cli", command: process.execPath, args: [resolve("test/fake-doubao-cli.ts")], env: {}, idleTimeoutMs: 60_000 };

describe("doubao cli", () => {
  it("passes model, effort, a permission mode by whether it may write, and the working directory", () => {
    const p = { ...fake, command: "doubao", args: [], model: "Auto", effort: "low" };
    expect(doubaoArgs(p, { cwd: "/w", prompt: "" }, "hi")).toEqual(["-p", "hi", "--model", "Auto", "--effort", "low", "--permission-mode", "ask_risky", "-C", "/w"]);
    expect(doubaoArgs(p, { cwd: "/w", prompt: "", allowWrites: true, resumeSessionId: "9" }, "hi").slice(0, 2)).toEqual(["--resume", "9"]);
    expect(doubaoArgs(p, { cwd: "/w", prompt: "", allowWrites: true }, "hi")).toContain("always_allow");
  });

  it("runs a turn: the prompt reaches it, the session comes from stderr, the run's env reaches it", async () => {
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
  });

  it("continues a session and reports a failed turn with the CLI's message", async () => {
    const r = await runDoubaoCli(fake, { cwd: process.cwd(), prompt: "again", resumeSessionId: "s-7" }, () => {});
    expect(r.sessionId).toBe("s-7");
    await expect(runDoubaoCli(fake, { cwd: process.cwd(), prompt: "fail" }, () => {})).rejects.toThrow("无法启动主任务");
  });

  it("probes models and each model's effort levels from argument errors", async () => {
    expect(await probeDoubaoCli(fake)).toEqual({ models: ["Auto", "Pro 1"], effortsByModel: { Auto: ["low", "medium", "high"], "Pro 1": ["low", "medium", "high", "xhigh", "max"] } });
  });
});
