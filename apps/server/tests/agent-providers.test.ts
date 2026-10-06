import { expect, it } from "vitest";
import {
  acpProvider,
  developmentProfile,
  freezeDevelopmentProfiles,
  sessionMetadata,
} from "../src/agent-providers.js";
import { developmentProfiles } from "../src/config.js";
import { profileSchema } from "../../../packages/contracts/src/index.js";
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

it("limits Claude sessions to the registered omem tools and keeps unverified Codex execution closed", () => {
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
  expect(() =>
    developmentProfile(profile("codex", { command: "codex-acp" })),
  ).toThrow("暂仅支持能力探测");
});
