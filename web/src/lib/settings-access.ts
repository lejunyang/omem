/**
 * Who may see and change which settings (`GET /api/settings/sections`, src/auth/settings-sections.ts):
 * the configuration is split into seven areas, each with a view and an edit capability; `keys` says which
 * area a configuration key (or a key inside one, `agents.accounts`) belongs to, the more specific path
 * first; `ownerOnly` lists the keys only the owner changes, whatever the area allows. Pure: the page
 * hands over the answer and whether this is the owner.
 */
export type SettingsSection = "knowledge" | "assistant" | "ai" | "channels" | "members" | "security" | "system";
export type SectionGrant = { view: boolean; edit: boolean };
export type SettingsSections = { keys: Record<string, SettingsSection>; ownerOnly: string[]; sections: Partial<Record<SettingsSection, SectionGrant>> };

export const SECTION_NAMES: Record<SettingsSection, string> = {
  knowledge: "知识", assistant: "助手", ai: "AI", channels: "渠道与协作", members: "成员", security: "安全", system: "系统",
};

/** The area of a key: the longest path the server names (`agents.accounts` before `agents`). */
export function sectionOfKey(s: SettingsSections, path: string): SettingsSection | null {
  const parts = path.split(".");
  for (let n = parts.length; n > 0; n--) {
    const hit = s.keys[parts.slice(0, n).join(".")];
    if (hit) return hit;
  }
  return null;
}

/** Only the owner changes it: the key itself or one inside a key on the list. */
export function isOwnerOnly(s: SettingsSections, path: string) {
  return s.ownerOnly.some((o) => path === o || path.startsWith(o + "."));
}

export type KeyAccess = { view: boolean; edit: boolean; ownerOnly: boolean };
/** One key for this person. The owner sees and changes everything. */
export function keyAccess(s: SettingsSections | null, path: string, owner: boolean): KeyAccess {
  if (owner || !s) return { view: owner, edit: owner, ownerOnly: false };
  const area = sectionOfKey(s, path);
  const grant = area ? s.sections[area] : undefined;
  const ownerOnly = isOwnerOnly(s, path);
  return { view: !!grant?.view, edit: !!grant?.view && !!grant?.edit && !ownerOnly, ownerOnly };
}

/**
 * A card that reads and writes several keys: shown when any of them may be seen, changeable only when
 * all of them may be changed (a row with its own keys decides for itself). `ownerOnly`: what keeps it
 * read-only is that only the owner changes one of them (so the card can say whose it is).
 */
export function cardAccess(s: SettingsSections | null, keys: string[], owner: boolean): KeyAccess {
  const each = keys.map((k) => keyAccess(s, k, owner));
  const view = each.some((a) => a.view);
  const edit = view && each.every((a) => a.edit || !a.view);
  return { view, edit, ownerOnly: !edit && each.some((a) => a.view && a.ownerOnly) };
}

/** A tab is offered when anything on it may be seen. */
export function anyVisible(s: SettingsSections | null, keys: string[], owner: boolean) {
  return keys.some((k) => keyAccess(s, k, owner).view);
}

/**
 * The sentence for a refused save (`PUT /api/settings` answers 403 naming the key): whose it is and what
 * this person may do instead of the server's wording. Anything else is passed on as it came.
 */
export function saveRefusal(message: string, s: SettingsSections | null, ownerName: string): string {
  const m = /没有修改设置\s*(\S+)\s*的权限/.exec(message);
  if (!m) return message;
  const path = m[1];
  if (s && isOwnerOnly(s, path)) return `没有保存：这一项只有${ownerName}能改（${path}）`;
  const area = s ? sectionOfKey(s, path) : null;
  return area ? `没有保存：你能看“${SECTION_NAMES[area]}”区域的设置，但不能改（${path}）` : `没有保存：你不能改这一项（${path}）`;
}
