import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";

/**
 * How skills are offered (docs/v2/agent-skills.md): which group a skill is in, whether it is switched
 * on, what it is for inside its group. Kept beside the skills in the library (`skill-groups.json`,
 * under Git) and not in each SKILL.md, so a skill taken over from an agent's own folder can be
 * replaced by its newer upstream version without losing these settings.
 *
 * A skill in a group is never listed on its own: agents see the group (one entry, a hub that sends
 * them on by purpose) and read the skill from there. A skill without an entry here is on and
 * ungrouped, as before.
 */
export type GroupState = {
  title?: string;
  description?: string;
  enabled: boolean;
  /** The owner (or the assistant at their word) wrote the title or description: the skill organizer leaves them. */
  userSet?: boolean;
};
export type SkillState = {
  group?: string;
  /** Off: offered nowhere (the group's switch turns off all of its skills). */
  enabled?: boolean;
  /** What it is for, the heading the group's hub lists it under. */
  purpose?: string;
  /** Taken over from this agent folder (agent-skills.ts); a newer version found there replaces the library copy. */
  origin?: string;
  adoptedAt?: string;
  hash?: string;
  /** The owner (or the assistant at their word) placed it: the skill organizer leaves its group and purpose. */
  userSet?: boolean;
  /** Its description as the skill organizer last saw it (clipped); a skill whose description differs is looked at again. */
  seen?: string;
};
export type SkillGroups = { groups: Record<string, GroupState>; skills: Record<string, SkillState> };

export const GROUP_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const file = (app: Pick<App, "libraryDir">) => join(app.libraryDir, "skill-groups.json");
let cache: { path: string; mtime: number; value: SkillGroups } | null = null;

export function loadSkillGroups(app: Pick<App, "libraryDir">): SkillGroups {
  const path = file(app);
  if (!existsSync(path)) return { groups: {}, skills: {} };
  const mtime = statSync(path).mtimeMs;
  if (cache && cache.path === path && cache.mtime === mtime) return structuredClone(cache.value);
  let value: SkillGroups;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SkillGroups>;
    value = { groups: raw.groups ?? {}, skills: raw.skills ?? {} };
  } catch {
    value = { groups: {}, skills: {} };
  }
  cache = { path, mtime, value };
  return structuredClone(value);
}

export function saveSkillGroups(app: Pick<App, "libraryDir">, s: SkillGroups) {
  // Groups nobody is in any more go; sorted keys keep the Git diff readable.
  const used = new Set(Object.values(s.skills).map((x) => x.group).filter(Boolean));
  const groups = Object.fromEntries(Object.entries(s.groups).filter(([id]) => used.has(id)).sort(([a], [b]) => a.localeCompare(b)));
  const skills = Object.fromEntries(Object.entries(s.skills).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file(app), JSON.stringify({ groups, skills }, null, 2) + "\n");
  cache = null;
}

/** Whether the skill is offered at all: its own switch and its group's. */
export function skillEnabled(s: SkillGroups, name: string) {
  const e = s.skills[name];
  if (!e) return true;
  if (e.enabled === false) return false;
  return !(e.group && s.groups[e.group]?.enabled === false);
}

export const groupOf = (s: SkillGroups, name: string) => s.skills[name]?.group;
export const groupTitle = (s: SkillGroups, id: string) => s.groups[id]?.title || (id === "other" ? "其他" : id);
