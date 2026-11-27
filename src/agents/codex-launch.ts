import { join } from "node:path";
import type { AgentProfile } from "../core/config.ts";
import { withAgentPath } from "../core/tools.ts";
import { backendProgram } from "./backend-names.ts";
import { omemInstallDir } from "./sandbox.ts";
import { resolveCommand } from "./spawn.ts";

export const codexNoPluginPrefetch = ["-c", "features.plugin_discovery_prefetch=false"] as const;

/** codex-acp applies CODEX_CONFIG to sessions, after the app-server starts its catalog refresh. */
export function codexAcpEnv(profile: AgentProfile, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (backendProgram(profile) !== "codex") return env;
  const effectiveEnv = withAgentPath({ ...process.env, ...env });
  const codexPath = effectiveEnv.CODEX_PATH;
  const command = resolveCommand(codexPath || profile.command, effectiveEnv);
  if (!command) return env;
  // The adapter's cli subcommand runs the Codex bundled with that adapter.
  const args = codexPath ? [] : [...profile.args, "cli"];
  return {
    ...env,
    CODEX_PATH: join(omemInstallDir(), "vendor", process.platform === "win32" ? "codex-prefetch.cmd" : "codex-prefetch.cjs"),
    CODEX_OMEM_EXEC: JSON.stringify([command.file, ...command.prefix, ...args, ...codexNoPluginPrefetch]),
    CODEX_OMEM_ORIGINAL_PATH: codexPath,
  };
}
