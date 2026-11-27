import type { AgentProfile } from "../core/config.ts";
import { acpCatalog } from "./catalog.ts";

type ProgramProfile = Pick<AgentProfile, "id" | "source" | "stateLayout" | "peer"> & { command?: string };
export const commonBackendAliases: Readonly<Record<string, string>> = { cc: "claude", gemini: "antigravity", agy: "antigravity" };

export const commandName = (command: string) => command.split(/[/\\]/).at(-1)!.replace(/\.[^.]+$/, "").toLowerCase();
export const normalizeProgram = (name: string) => name.toLowerCase().split("@")[0].replace(/-(?:cli|acp)$/, "");

export function backendProgram(p: ProgramProfile): string {
  // Generated key profiles use source for quota accounting (key:<provider>).
  const source = p.source && !p.source.startsWith("key:") ? p.source : undefined;
  const direct = p.peer?.agent || source || p.stateLayout;
  if (direct) return normalizeProgram(direct);
  const command = p.command && commandName(p.command);
  const catalog = command && acpCatalog.find(e => commandName(e.command) === command);
  return normalizeProgram(catalog ? catalog.id : p.id);
}

export const defaultModelFamilies: Readonly<Record<string, string>> = {
  antigravity: "google", gemini: "google", claude: "anthropic", codex: "openai",
};
