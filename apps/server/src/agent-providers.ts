import { basename } from "node:path";
import type { AgentProfile } from "../../../packages/contracts/src/index.js";

/** Provider identity is explicit for wrappers; old executable names remain compatible. */
export function acpProvider(profile: AgentProfile) {
  if (profile.transport !== "acp") return null;
  if (profile.acpProvider) return profile.acpProvider;
  const name = basename(profile.command).replace(/\.exe$/, "");
  if (["traex", "traecli"].includes(name)) return "traex";
  if (name === "codex-acp") return "codex";
  if (name === "claude-agent-acp") return "claude";
  return null;
}

export function sessionMetadata(profile: AgentProfile) {
  switch (acpProvider(profile)) {
    case "claude":
      return {
        claudeCode: {
          options: {
            // Use the SDK's agent loop, with omem's scoped tools. Do not load
            // unrelated user/project MCP servers, hooks or native write tools.
            tools: [],
            allowedTools: ["mcp__omem__*"],
            settingSources: [],
            strictMcpConfig: true,
            allowDangerouslySkipPermissions: false,
            settings: {
              disableAllHooks: true,
              permissions: { defaultMode: "default" },
            },
          },
        },
      };
    case "codex":
      return {};
    default:
      // Retain the metadata contract of pre-provider custom ACP launchers.
      return { trae: { options: { skills: profile.skills, mcpServers: [] } } };
  }
}

export function developmentProfile(profile: AgentProfile): AgentProfile {
  if (profile.transport !== "acp") throw Error("编码与独立评审需要 ACP Agent");
  switch (acpProvider(profile)) {
    case "claude":
      if (profile.args.length)
        throw Error(
          "Claude ACP 编码配置不接受启动参数；模型与思考强度通过会话协商",
        );
      return profile;
    case "traex": {
      const args: string[] = [];
      for (let i = 0; i < profile.args.length; i++) {
        const arg = profile.args[i]!;
        if (arg === "--yolo") continue;
        if (
          ["-c", "--config"].includes(arg) &&
          profile.args[i + 1]?.startsWith("sandbox_mode=")
        ) {
          i++;
          continue;
        }
        args.push(arg);
      }
      return { ...profile, args: ["-c", 'sandbox_mode="read-only"', ...args] };
    }
    case "codex":
      if (profile.args.length)
        throw Error(
          "Codex ACP 编码配置不接受启动参数；模型与思考强度通过会话协商",
        );
      return profile;
    default:
      throw Error(
        "请为编码配置声明已支持的 acpProvider（traex、codex 或 claude）",
      );
  }
}

export type DevelopmentProfiles = {
  coding: AgentProfile;
  review: AgentProfile;
};
export function freezeDevelopmentProfiles(
  coding: AgentProfile,
  review = coding,
): DevelopmentProfiles {
  // Validate before enqueue. Store the actual profile identities, never rename a
  // provider to satisfy a role bundle's default profile reference.
  developmentProfile(coding);
  developmentProfile(review);
  return structuredClone({ coding, review });
}
