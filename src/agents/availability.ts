import type { AgentProfile } from "../core/config.ts";
import { doubaoTokenExists } from "./doubao.ts";
import { commandExists } from "./spawn.ts";
import { backOnly, pairedIn } from "../core/peers.ts";
import { backOnline } from "../core/peer-back.ts";
import { keyOf } from "../core/ai-keys.ts";

const available = new Map<string, boolean>();
export function backendAvailable(profile: AgentProfile, home: string) {
  if (profile.transport === "doubao") return doubaoTokenExists(home);
  // Whether the device still answers is the run's to find out; unpaired, it is gone.
  // One reached only over the connection it keeps here is there while that connection is.
  if (profile.peer) {
    const p = pairedIn(home).find((x) => x.id === profile.peer!.id);
    return !!p && (!backOnly(p) || backOnline(home, p.id));
  }
  if (profile.keyRef && !keyOf(profile.keyRef, home)) return false;
  if (!available.has(profile.command)) available.set(profile.command, commandExists(profile.command));
  return available.get(profile.command)!;
}
