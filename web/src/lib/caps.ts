/**
 * What the person using the page may do, by capability (src/auth/capabilities.ts, docs/v2/multi-user.md
 * “成员能力”): `caps` are the global ones, `spaceCaps` where each space-scoped one holds ("*" is every
 * space), `ownSpaceCaps` the same for items and runs counting the person's own. The owner can do
 * everything; before `/api/me` arrives the page is the owner's on this machine, as everywhere else.
 * An older server sends no `caps`: then the pages open as they did before capabilities.
 *
 * The store hands over who is using the page (`followMe`), so this file stays free of the page's state.
 */
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
