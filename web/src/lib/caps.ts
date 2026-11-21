/**
 * What the person using the page may do, by capability (src/auth/capabilities.ts, docs/v2/multi-user.md
 * “成员能力”): `caps` are the global ones, `spaceCaps` where each space-scoped one holds ("*" is every
 * space), `ownSpaceCaps` the same for items and runs counting the person's own. The owner can do
 * everything; before `/api/me` arrives the page is the owner's on this machine, as everywhere else.
 * An older server sends no `caps`: then the pages open as they did before capabilities.
 *
 * The store hands over who is using the page (`followMe`), so this file stays free of the page's state.
 */
import { shallowRef } from "vue";
import { cardAccess, keyAccess, type KeyAccess, type SettingsSection, type SettingsSections } from "./settings-access.js";

type Range = string[] | "*";
export type Me = {
  role: string; perms: string[]; spaces: string[] | null;
  caps?: string[]; spaceCaps?: Record<string, Range>; ownSpaceCaps?: Record<string, Range>;
};
type Who = Me | null | undefined;

let current: () => Who = () => null;
/** Called once by the store: `state.me`, read on every check. */
export function followMe(get: () => Who) {
  current = get;
}

const isOwner = (me: Who) => !me || me.role === "owner";

/** Before capabilities: what a member could open (the nav's `member: true` pages) and the old permissions. */
function legacy(me: Me, cap: string, space?: string) {
  if (cap === "settings.assistant.view" || cap === "settings.assistant.edit") return me.perms.includes("agents.manage") && me.perms.includes("code.delegate");
  if (cap === "work.view") return false;
  if (cap === "rules.view" || cap === "rules.edit") return me.perms.includes("agents.manage");
  if (cap === "settings.members") return me.perms.includes("users.manage");
  if (cap === "code.work.view" || cap === "code.review.view") return me.perms.includes("code.delegate");
  return space === undefined || !me.spaces || me.spaces.includes(space);
}
function inRange(range: Range | undefined, space?: string) {
  if (!range) return false;
  if (range === "*") return true;
  return space === undefined ? range.length > 0 : range.includes(space);
}
const rangeOf = (me: Me, cap: string, own: boolean): Range | undefined => (own ? me.ownSpaceCaps?.[cap] : undefined) ?? me.spaceCaps?.[cap];

/** A global capability (`rules.view`, `settings.members`, `ask.send`…). */
export function hasCap(cap: string, me: Who = current()) {
  if (isOwner(me)) return true;
  if (!me!.caps) return legacy(me!, cap);
  return me!.caps.includes(cap);
}
/** A space-scoped capability in one space; `own` counts the person's own items and runs too. */
export function capIn(cap: string, space: string, opts: { own?: boolean } = {}, me: Who = current()) {
  if (isOwner(me)) return true;
  if (!me!.spaceCaps) return legacy(me!, cap, space);
  return inRange(rangeOf(me!, cap, !!opts.own), space);
}
/** A space-scoped capability in any space at all: whether its page is offered. */
export function capAnywhere(cap: string, opts: { own?: boolean } = {}, me: Who = current()) {
  if (isOwner(me)) return true;
  if (!me!.spaceCaps) return legacy(me!, cap);
  return inRange(rangeOf(me!, cap, !!opts.own));
}
/** An old global permission (`agents.manage`, `code.delegate`, `desktop.control`). */
export function hasPerm(perm: string, me: Who = current()) {
  return isOwner(me) || !!me!.perms?.includes(perm);
}

/**
 * Settings by area (`GET /api/settings/sections`, lib/settings-access.ts): the settings page loads the
 * answer once and hands it here; every check of what someone may see or change in the settings goes
 * through these. Before it arrives (or from a server without it) an area is read from the same
 * capabilities in `/api/me` (`settings.<area>.view`), and from a server without those from the old
 * permissions: members and the trail for whoever manages members, everything for `settings.manage`.
 */
const sectionsRef = shallowRef<SettingsSections | null>(null);
export function setSettingsSections(s: SettingsSections | null) {
  sectionsRef.value = s;
}
export const settingsSections = () => sectionsRef.value;
export function settingsArea(area: SettingsSection, action: "view" | "edit", me: Who = current()) {
  if (isOwner(me)) return true;
  const s = sectionsRef.value;
  if (s) return !!s.sections[area]?.[action] && (action === "view" || !!s.sections[area]?.view);
  if (me!.caps?.some((c) => c.startsWith("settings.") && c !== "settings.members")) return me!.caps.includes(`settings.${area}.${action}`);
  if (me!.perms?.includes("settings.manage")) return true;
  return area === "members" && (me!.perms?.includes("users.manage") || !!me!.caps?.includes("settings.members"));
}
/** Any area at all: whether the settings page is offered. */
export const settingsAnywhere = (me: Who = current()) => SETTINGS_AREAS.some((a) => settingsArea(a, "view", me));
const SETTINGS_AREAS: SettingsSection[] = ["knowledge", "assistant", "ai", "channels", "members", "security", "system"];
/** One configuration key (`notify`, `agents.accounts`): its area, and the owner-only list. */
export function settingsKey(path: string, me: Who = current()): KeyAccess {
  const s = sectionsRef.value;
  if (isOwner(me)) return { view: true, edit: true, ownerOnly: false };
  if (!s) {
    const area: SettingsSection | null = path === "auth" || path.startsWith("agents.account") ? "members" : null;
    const view = !!me!.perms?.includes("settings.manage") || (!!area && settingsArea(area, "view", me));
    return { view, edit: view && !!me!.perms?.includes("settings.manage"), ownerOnly: false };
  }
  return keyAccess(s, path, false);
}
/** A card over several keys (lib/settings-access.ts `cardAccess`). */
export function settingsCard(keys: string[], me: Who = current()): KeyAccess {
  if (isOwner(me)) return { view: true, edit: true, ownerOnly: false };
  const s = sectionsRef.value;
  if (!s) {
    const each = keys.map((k) => settingsKey(k, me));
    const view = each.some((a) => a.view);
    return { view, edit: view && each.every((a) => a.edit || !a.view), ownerOnly: false };
  }
  return cardAccess(s, keys, false);
}
