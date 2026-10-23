import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { openAcp, pickMode } from "../src/agents/acp.ts";
import { acpCatalog, npxProfile, platformKey, registryOptions, type RegistryAgent } from "../src/agents/catalog.ts";
import { agentProfileSchema, builtinProfiles, allProfiles, configSchema } from "../src/core/config.ts";
import { codexArgs } from "../src/agents/cli.ts";

describe("ACP agent catalog", () => {
  it("builtin profiles are valid and unique", () => {
    const ids = builtinProfiles.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of builtinProfiles) expect(agentProfileSchema.parse(p)).toMatchObject({ id: p.id, command: p.command });
    expect(ids.slice(0, 3)).toEqual(["codex", "traex", "claude"]);
    expect(ids).toEqual(expect.arrayContaining(["gemini", "copilot", "qwen", "cursor", "opencode", "goose", "kimi", "codebuddy", "droid"]));
    expect(acpCatalog.length).toBeGreaterThan(20);
  });

  it("npx profile and registry options", () => {
    const gemini = acpCatalog.find((e) => e.id === "gemini")!;
    expect(npxProfile(gemini)).toMatchObject({ command: "npx", args: ["-y", "@google/gemini-cli", "--acp"] });
    const agent: RegistryAgent = {
      id: "x",
      name: "X",
      version: "1.0.0",
      distribution: {
        npx: { package: "x-acp@1.0.0", args: ["acp"], env: { A: "1" } },
        binary: { [platformKey()]: { archive: "https://example.com/x.tar.gz", cmd: "./x", args: ["acp"] }, "plan9-mips": { archive: "", cmd: "" } },
      },
    };
    const opts = registryOptions(agent);
    expect(opts.map((o) => o.kind).sort()).toEqual(["binary", "npx"]);
    const npx = opts.find((o) => o.kind === "npx")!;
    expect(npx.kind === "npx" && npx.profile).toMatchObject({ id: "x", command: "npx", args: ["-y", "x-acp@1.0.0", "acp"], env: { A: "1" } });
    expect(registryOptions(agent, "plan9-x").map((o) => o.kind)).toEqual(["npx"]);
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
  });

  it("keeps saved ACP launch arguments while supplying catalog cleanup, and offers ephemeral exec", () => {
    const config = configSchema.parse({ agents: { profiles: [{ id: "traex", command: "traex", transport: "acp", args: ["acp", "serve", "-c", "model=custom"] }] } });
    expect(allProfiles(config).find(p => p.id === "traex")).toMatchObject({ args: ["acp", "serve", "-c", "model=custom"], archiveArgs: ["archive"] });
    config.agents.profiles[0].archiveArgs = [];
    expect(allProfiles(config).find(p => p.id === "traex")?.archiveArgs).toEqual([]);
    const cli = builtinProfiles.find(p => p.id === "traex-cli")!;
    expect(cli.command).toBe("traex");
    expect(codexArgs(cli, { cwd: ".", prompt: "" })).toContain("--ephemeral");
    expect(codexArgs(cli, { cwd: ".", prompt: "", persistSession: true })).not.toContain("--ephemeral");
  });

  it("maps role modes onto agent-specific mode ids", () => {
    expect(pickMode(["acceptEdits", "auto", "default"], ["default", "autoEdit", "yolo"])).toBe("autoEdit");
    expect(pickMode(["read-only", "default", "plan"], ["code", "architect", "ask"])).toBe("ask");
    expect(pickMode(["read-only", "default", "plan"], ["build", "plan"])).toBe("plan");
    expect(pickMode(["acceptEdits"], ["x"])).toBeUndefined();
  });

  it("sets model through legacy session/set_model and aliased mode", async () => {
    const profile = agentProfileSchema.parse({ id: "legacy", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", FAKE_LEGACY: "1" }, model: "m2" });
    const probe = await openAcp(profile, { cwd: process.cwd(), probe: true }, () => {});
    expect(probe.probe?.options).toContainEqual({ id: "model", category: "model", current: "m1", values: ["m1", "m2"] });
    const h = await openAcp(profile, { cwd: process.cwd(), modes: ["acceptEdits", "auto", "default"] }, () => {});
    const r = await h.prompt("hi", () => {});
    h.close();
    expect(JSON.parse(r.text)).toMatchObject({ model: "m2", mode: "autoEdit" });
  });
});
