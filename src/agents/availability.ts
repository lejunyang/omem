import type { AgentProfile } from "../core/config.ts";
import { doubaoTokenExists } from "./doubao.ts";
import { commandExists } from "./spawn.ts";
import { backOnly, pairedIn } from "../core/peers.ts";
import { backOnline } from "../core/peer-back.ts";
import { keyOf } from "../core/ai-keys.ts";
import { pluginBackendStatus } from "./catalog.ts";

const available = new Map<string, boolean>();
/** Look for the commands again (after an adapter was installed, upgraded or broke halfway: agents/adapter.ts). */
export function forgetAvailability() {
  available.clear();
}
export function backendAvailable(profile: AgentProfile, home: string) {
  if (profile.transport === "doubao") return doubaoTokenExists(home);
  // Whether the device still answers is the run's to find out; unpaired, it is gone.
  // One reached only over the connection it keeps here is there while that connection is.
  if (profile.peer) {
    const p = pairedIn(home).find((x) => x.id === profile.peer!.id);
    return !!p && (!backOnly(p) || backOnline(home, p.id));
  }
  if (pluginBackendStatus(profile)?.available === false) return false;
  if (profile.keyRef && !keyOf(profile.keyRef, home)) return false;
  if (!available.has(profile.command)) available.set(profile.command, commandExists(profile.command));
  return available.get(profile.command)!;
}
