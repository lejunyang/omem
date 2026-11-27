import type { AgentProfile } from "../core/config.ts";
import { doubaoFeatures } from "./doubao-cli.ts";

export type BackendCapabilities = {
  omemAccess: "mcp" | "shell-bridge" | "http" | "none";
  cloudHttp?: false | "header" | "url";
  credentialChannel?: boolean;
  localTools: boolean;
  where: "local" | "cloud";
};

const local = { omemAccess: "mcp", localTools: true, where: "local" } as const;
const transports = {
  acp: local,
  "codex-cli": local,
  "claude-cli": local,
  "doubao-cli": { ...local, omemAccess: "shell-bridge" },
  doubao: { omemAccess: "none", cloudHttp: false, localTools: false, where: "cloud" },
} satisfies Record<AgentProfile["transport"], BackendCapabilities>;

/** The Doubao CLI has omem's tools over MCP once it speaks ACP (`doubao acp serve`); older ones through the shell. */
export function backendCapabilities(profile: Pick<AgentProfile, "transport"> & Partial<Pick<AgentProfile, "command" | "args" | "peer">>): BackendCapabilities {
  if (profile.transport === "doubao-cli" && profile.command && doubaoFeatures({ command: profile.command, args: profile.args ?? [], peer: profile.peer }).acp) return local;
  return transports[profile.transport];
}

/** Whether the backend can use the workspace and commands of this host. */
export const hasHostTools = (profile: AgentProfile) => !profile.peer && backendCapabilities(profile).localTools;
