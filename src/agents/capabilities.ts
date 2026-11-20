import type { AgentProfile } from "../core/config.ts";

export type BackendCapabilities = {
  omemAccess: "mcp" | "shell-bridge" | "none";
  localTools: boolean;
  where: "local" | "cloud";
};

const local = { omemAccess: "mcp", localTools: true, where: "local" } as const;
const transports = {
  acp: local,
  "codex-cli": local,
  "claude-cli": local,
  "doubao-cli": { ...local, omemAccess: "shell-bridge" },
  doubao: { omemAccess: "none", localTools: false, where: "cloud" },
} satisfies Record<AgentProfile["transport"], BackendCapabilities>;

export function backendCapabilities(profile: Pick<AgentProfile, "transport">): BackendCapabilities {
  return transports[profile.transport];
}
