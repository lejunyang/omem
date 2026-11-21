/**
 * How the owner is named to someone else (`ownerName` in `GET /api/me`, src/core/users.ts `nameForOthers`):
 * the owner's own name, or “主人” when there is none (or from an older server). The owner reads “你”. Pure.
 */
type Who = { role: string; ownerName?: string } | null | undefined;

export function ownerCalled(me: Who): string {
  return me?.ownerName?.trim() || "主人";
}

/** “你” for the owner, the owner's name for anyone else: who set or decided something the owner did. */
export function ownerWord(me: Who): string {
  return !me || me.role === "owner" ? "你" : ownerCalled(me);
}
