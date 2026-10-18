import { expect, it } from "vitest";
import { codexArgs } from "../src/agents/cli.ts";
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
