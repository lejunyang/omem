import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openAcp, pickMode } from "../src/agents/acp.ts";
import { claudeArgs, codexArgs } from "../src/agents/cli.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { readAgentSpec, saveAgentSpec } from "../src/agents/specs.ts";
import { getRule, saveRule } from "../src/rules/store.ts";
import { OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

describe("完全访问", () => {
  it("picks each backend's full-access mode, and the command-line flags of the fallbacks", () => {
    expect(pickMode(["full-access"], ["read-only", "workspace-write", "agent", "agent-full-access"])).toBe("agent-full-access");
    expect(pickMode(["full-access"], ["default", "acceptEdits", "plan", "auto", "bypassPermissions"])).toBe("bypassPermissions");
    expect(pickMode(["full-access"], ["default", "plan", "auto", "bypass_permissions"])).toBe("bypass_permissions");
    expect(pickMode(["full-access"], ["default", "read-only"])).toBeUndefined();
    const cli = agentProfileSchema.parse({ id: "c", transport: "codex-cli", command: "codex" });
    expect(codexArgs(cli, { cwd: ".", prompt: "", fullAccess: true })).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexArgs(cli, { cwd: ".", prompt: "", fullAccess: true })).not.toContain("--sandbox");
    expect(codexArgs(cli, { cwd: ".", prompt: "" })).toContain("read-only");
    const claude = agentProfileSchema.parse({ id: "k", transport: "claude-cli", command: "claude" });
    expect(claudeArgs(claude, { cwd: ".", prompt: "", fullAccess: true }).join(" ")).toContain("--permission-mode bypassPermissions");
  });

  it("an ACP session switches to that mode, or says the backend has none", async () => {
    const legacy = agentProfileSchema.parse({ id: "legacy", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_LEGACY: "1" } });
    const status: string[] = [];
    const h = await openAcp(legacy, { cwd: process.cwd(), modes: ["read-only", "default"], fullAccess: true }, (e) => { if (e.type === "status") status.push(e.text); });
    const r = await h.prompt("hi", () => {});
    h.close();
    expect(JSON.parse(r.text)).toMatchObject({ mode: "yolo" });
    expect(status.join("\n")).toContain("完全访问：yolo");
    const plain = agentProfileSchema.parse({ id: "plain", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } });
    const none: string[] = [];
    const h2 = await openAcp(plain, { cwd: process.cwd(), modes: ["read-only"], fullAccess: true }, (e) => { if (e.type === "status") none.push(e.text); });
    h2.close();
    expect(none.join("\n")).toContain("没有完全访问模式");
  });

  it("only the owner turns it on, for a rule or a profile; an agent's edit keeps the owner's choice", () => {
    const app = testApp();
    try {
      const rule = { name: "报警", description: "报警交给助手排查", enabled: true, conditions: { field: "chat.name", op: "contains", value: "报警" }, judge: "code", actions: [{ type: "agent", spec: "assistant", task: "排查", reply: "none", fullAccess: true }] } as never;
      expect(() => saveRule(app, rule, "agent")).toThrow(/只能由本人/);
      const saved = saveRule(app, rule, "user", OWNER);
      const edited = saveRule(app, { ...(rule as object), id: saved.id, actions: [{ type: "agent", spec: "assistant", task: "排查得更细", reply: "none" }] } as never, "agent");
      expect(edited.actions[0]).toMatchObject({ task: "排查得更细", fullAccess: true });
      expect(() => saveRule(app, { ...(rule as object), id: saved.id, actions: [{ type: "agent", spec: "other", task: "x", reply: "none", fullAccess: true }] } as never, "agent")).toThrow(/只能由本人/);
      expect(getRule(app, saved.id).actions[0]).toMatchObject({ fullAccess: true });

      saveAgentSpec(app, { name: "investigator-x", description: "排查", prompt: "自己排查", fullAccess: true }, "agent");
      expect(readAgentSpec(app, "investigator-x").fullAccess).toBe(false);
      saveAgentSpec(app, { name: "investigator-x", fullAccess: true }, "user");
      saveAgentSpec(app, { name: "investigator-x", description: "排查报警", fullAccess: false }, "agent");
      expect(readAgentSpec(app, "investigator-x")).toMatchObject({ description: "排查报警", fullAccess: true });
    } finally { app.db.close(); }
  });
});
