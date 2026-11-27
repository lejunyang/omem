import { expect, it } from "vitest";
import { codexArgs } from "../src/agents/cli.ts";
import { codexAcpEnv } from "../src/agents/codex-launch.ts";
import type { AgentProfile } from "../src/core/config.ts";

const profile: AgentProfile = { id: "codex-cli", name: "Codex (CLI)", transport: "codex-cli", command: "codex", args: [], env: {}, idleTimeoutMs: 600_000 };
const mcp = { url: "http://127.0.0.1:4399/mcp", baseUrl: "http://127.0.0.1:4399", token: "t", stdio: { command: "node", args: ["bridge.js"] } };

function overrides(args: string[]) {
  return args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
}

it("codex exec auto-approves only the omem MCP server's tools", () => {
  const args = codexArgs(profile, {
    cwd: ".",
    prompt: "",
    mcp,
    extraMcp: { other: { command: "x", args: [], env: {} }, web: { url: "http://example.test/mcp", headers: {} } },
  });
  const c = overrides(args);
  expect(c).toContain(`mcp_servers.omem.default_tools_approval_mode="approve"`);
  expect(c.filter((s) => s.includes("approval"))).toHaveLength(1);
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
  expect(args.at(-1)).toBe("-");
});

it("codex exec without omem MCP adds no approval override", () => {
  const args = codexArgs(profile, { cwd: ".", prompt: "" });
  expect(overrides(args).some((s) => s.includes("approval"))).toBe(false);
});

it("sets only the Codex plugin discovery prefetch feature for CLI launches", () => {
  const req = { cwd: ".", prompt: "" };
  expect(overrides(codexArgs(profile, req))).toEqual(["features.plugin_discovery_prefetch=false"]);
  expect(overrides(codexArgs({ ...profile, id: "traex-cli", command: "traex" }, req))).toEqual([]);
});

it("passes the prefetch override to the adapter's bundled Codex or the explicitly selected executable", () => {
  const acp: AgentProfile = { ...profile, id: "codex", transport: "acp", command: process.execPath, args: ["adapter.js"] };
  const env = { CODEX_PATH: "", CODEX_CONFIG: '{"features":{"plugins":true}}' };
  const bundled = codexAcpEnv(acp, env);
  expect(bundled.CODEX_PATH).toMatch(/codex-prefetch\.(cjs|cmd)$/);
  expect(JSON.parse(bundled.CODEX_OMEM_EXEC!)).toEqual([process.execPath, "adapter.js", "cli", "-c", "features.plugin_discovery_prefetch=false"]);
  expect(bundled.CODEX_CONFIG).toBe(env.CODEX_CONFIG);
  const explicit = codexAcpEnv(acp, { ...env, CODEX_PATH: process.execPath });
  expect(JSON.parse(explicit.CODEX_OMEM_EXEC!)).toEqual([process.execPath, "-c", "features.plugin_discovery_prefetch=false"]);
  expect(explicit.CODEX_OMEM_ORIGINAL_PATH).toBe(process.execPath);
});
