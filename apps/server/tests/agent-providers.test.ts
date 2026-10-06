import { expect, it } from "vitest";
import {
  acpProvider,
  developmentProfile,
  freezeDevelopmentProfiles,
  sessionMetadata,
} from "../src/agent-providers.js";
import { developmentProfiles } from "../src/config.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { codexSessionConfig } from "../src/codex-session.js";
const profile = (id: string, extra = {}) =>
  profileSchema.parse({
    id,
    name: id,
    transport: "acp",
    command: "traex",
    ...extra,
  });

it("selects separate role profiles without changing identity and freezes their configuration", () => {
  const coding = profile("coder", {
    args: ["--yolo", "-c", 'sandbox_mode="danger-full-access"', "acp", "serve"],
  });
  const review = profile("reviewer", {
    command: "/wrapper",
    acpProvider: "claude",
  });
  const selected = developmentProfiles({
    profiles: [coding, review],
    development: { codingProfileId: "coder", reviewProfileId: "reviewer" },
  })!;
  const frozen = freezeDevelopmentProfiles(selected.coding, selected.review);
  coding.args.push("later");
  expect(frozen.coding.args).not.toContain("later");
  expect(developmentProfile(frozen.coding)).toMatchObject({
    id: "coder",
    args: ["-c", 'sandbox_mode="read-only"', "acp", "serve"],
  });
  expect(acpProvider(frozen.review)).toBe("claude");
  expect(() =>
    developmentProfiles({
      profiles: [coding],
      development: { codingProfileId: "coder", reviewProfileId: "missing" },
    }),
  ).toThrow("existing ACP");
});

it("limits Claude sessions to the registered omem tools and accepts explicitly configured Codex", () => {
  const claude = profile("reviewer", { command: "claude-agent-acp" });
  expect(sessionMetadata(claude)).toMatchObject({
    claudeCode: {
      options: {
        tools: [],
        allowedTools: ["mcp__omem__*"],
        settingSources: [],
        strictMcpConfig: true,
        allowDangerouslySkipPermissions: false,
      },
    },
  });
  expect(sessionMetadata(claude)).not.toHaveProperty("trae");
  expect(
    developmentProfile(profile("codex", { command: "codex-acp" })).id,
  ).toBe("codex");
});

it("disables personal tools without replacing authentication or the adapter's task MCP table", () => {
  const config = codexSessionConfig(
    { mcp_servers: { personal: {} }, plugins: { "tools@local": {} } },
    ["/skill/SKILL.md", "/skill/SKILL.md"],
  );
  const assembled = {
    ...config,
    mcp_servers: { omem: { url: "http://127.0.0.1/task" } },
  };
  expect(assembled["mcp_servers.personal.enabled"]).toBe(false);
  expect(config).toMatchObject({
    features: { hooks: false, shell_tool: false, apps: false },
    plugins: { "tools@local": { enabled: false } },
    skills: { config: [{ path: "/skill/SKILL.md", enabled: false }] },
  });
  expect(config).not.toHaveProperty("model_provider");
  expect(config).not.toHaveProperty("cli_auth_credentials_store");
  expect(() => codexSessionConfig({ mcp_servers: { omem: {} } }, [])).toThrow(
    "CONFLICT",
  );
});
