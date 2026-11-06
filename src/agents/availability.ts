import type { AgentProfile } from "../core/config.ts";
import { doubaoTokenExists } from "./doubao.ts";
import { commandExists } from "./spawn.ts";
import { pairedIn } from "../core/peers.ts";
import { keyOf } from "../core/ai-keys.ts";

const available = new Map<string, boolean>();
export function backendAvailable(profile: AgentProfile, home: string) {
  if (profile.transport === "doubao") return doubaoTokenExists(home);
  // Whether the device still answers is the run's to find out; unpaired, it is gone.
  if (profile.peer) return pairedIn(home).some((p) => p.id === profile.peer!.id);
  if (profile.keyRef && !keyOf(profile.keyRef, home)) return false;
  if (!available.has(profile.command)) available.set(profile.command, commandExists(profile.command));
  return available.get(profile.command)!;
}
