import type { AgentProfile } from "../core/config.ts";
import { doubaoTokenExists } from "./doubao.ts";
import { commandExists } from "./spawn.ts";

const available = new Map<string, boolean>();
export function backendAvailable(profile: AgentProfile, home: string) {
  if (profile.transport === "doubao") return doubaoTokenExists(home);
  if (!available.has(profile.command)) available.set(profile.command, commandExists(profile.command));
  return available.get(profile.command)!;
}
