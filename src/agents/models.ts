import type { AgentProfile } from "../core/config.ts";

/**
 * Agent CLIs spell model names inconsistently (GPT-Sol-6.1 vs gpt-6.1-sol).
 * Match case-insensitively after stripping everything except letters, digits
 * and dots, then by progressively looser normalized forms. Probe options are
 * preferred over free text when they are available.
 */
export function normalizeModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/-+/g, "-");
}

/** Very loose key for fuzzy matching: letters and digits only. */
function loose(value: string): string {
  return normalizeModel(value).replace(/[^a-z0-9]/g, "");
}

/** Whether a user-typed name names one of the offered values (any normalization level). */
export function modelMatches(typed: string, offered: string): boolean {
  const n = normalizeModel(typed);
  const o = normalizeModel(offered);
  if (n === o || loose(typed) === loose(offered)) return true;
  // Token set: exact equality ("gpt-sol-6.1" vs "gpt-6.1-sol") or the typed
  // tokens are a subset that still names a model family (a letter token) and a
  // version. "sol 6.1" matches "gpt-6.1-sol"; bare "6.1" does not.
  const t = new Set(tokens(n));
  const f = new Set(tokens(o));
  if (t.size === f.size && [...t].every((x) => f.has(x))) return true;
  const names = [...t].filter((x) => /[a-z]/.test(x));
  return t.size < f.size && names.length > 0 && [...t].every((x) => f.has(x));
}
function tokens(n: string) {
  return n.split(/[.-]/).filter(Boolean);
}

/**
 * Resolve a user-typed model against the values an agent actually offers.
 * Returns the offered spelling when matched (so the API gets what it expects),
 * or the typed value unchanged when nothing fits — the caller decides whether
 * that is an error or a request to try the agent's default.
 */
export function resolveModelOption(typed: string, offered: string[]): { value: string; matched: boolean } {
  if (offered.includes(typed)) return { value: typed, matched: true };
  const hit = offered.find((o) => modelMatches(typed, o));
  return hit ? { value: hit, matched: true } : { value: typed, matched: false };
}

/**
 * Resolve model/effort for a role run: roleModels[role][profile.id] first,
 * then the profile's own values. Used together with {@link resolveModelOption}
 * against the probed options so names like GPT-Sol-6.1 land on gpt-6.1-sol.
 */
export function resolveRoleProfile(app: { config: { agents: { roleModels?: Record<string, Record<string, { model?: string; effort?: string }>> } } }, profile: AgentProfile, role: string): AgentProfile {
  const override = app.config.agents.roleModels?.[role]?.[profile.id];
  if (!override) return profile;
  return { ...profile, model: override.model ?? profile.model, effort: override.effort ?? (override.model && override.model !== profile.model ? undefined : profile.effort) };
}
