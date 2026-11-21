/**
 * Handing one remote browser session to a member (src/remote/grants.ts, docs/v2/remote.md
 * “把会话交给成员”): who can be given it, how long it lasts, and what to say when it ends.
 */
export type GrantMode = "view" | "operate";
/** A grant as the session list carries it (`grant` for the member, `grants[]` for the owner). */
export type RemoteGrant = { id: string; sessionId: string; userId: string; userName: string; mode: GrantMode; expiresAt: string; connected?: boolean };
/** A member and the two remote capabilities they hold. */
export type GrantCandidate = { id: string; name: string; view: boolean; operate: boolean };

export const MODE_LABEL: Record<GrantMode, string> = { view: "只看", operate: "可操作" };
/** The usual lengths offered, in hours. */
export const DURATIONS = [1, 2, 8, 24];
export const durationLabel = (h: number) => (h < 1 ? `${Math.round(h * 60)} 分钟` : `${h} 小时`);

/**
 * Who can be handed a session: active people other than the owner and the session's owner, holding
 * 看授权给他的远程会话 or 操作授权给他的远程会话, and not already given this one.
 */
export function grantCandidates(
  users: { id: string; name: string; role: string; status?: string; disabledAt?: string | null }[],
  caps: Record<string, string[] | null | undefined>,
  opts: { sessionOwner: string; granted: string[] },
): GrantCandidate[] {
  return users
    .filter((u) => u.role !== "owner" && u.id !== opts.sessionOwner && !u.disabledAt && (u.status ?? "active") === "active" && !opts.granted.includes(u.id))
    .map((u) => ({ id: u.id, name: u.name, view: !!caps[u.id]?.includes("remote.view"), operate: !!caps[u.id]?.includes("remote.operate") }))
    .filter((c) => c.view || c.operate);
}
/** The modes a member can be given: operating needs its own capability, watching needs either. */
export const modesFor = (c: Pick<GrantCandidate, "view" | "operate"> | null | undefined): GrantMode[] =>
  !c ? ["view"] : c.operate ? (c.view ? ["view", "operate"] : ["operate"]) : ["view"];

const pad = (n: number) => String(n).padStart(2, "0");
/** “还剩 25 分钟”, “到今天 20:30”, “到明天 09:00”, “到 11 月 24 日 09:00”, or “已到期”. */
export function expiryLabel(expiresAt: string, now = Date.now()) {
  const end = new Date(expiresAt);
  const left = end.getTime() - now;
  if (!(left > 0)) return "已到期";
  if (left < 60 * 60_000) return `还剩 ${Math.max(1, Math.round(left / 60_000))} 分钟`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(end) - day(new Date(now))) / 86_400_000);
  const at = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  return days === 0 ? `到今天 ${at}` : days === 1 ? `到明天 ${at}` : `到 ${end.getMonth() + 1} 月 ${end.getDate()} 日 ${at}`;
}

/** What the member is told when a session handed to them leaves their list. */
export function endedMessage(grant: Pick<RemoteGrant, "expiresAt">, owner: string | null | undefined, now = Date.now()) {
  return Date.parse(grant.expiresAt) <= now + 5_000 ? "授权到期了" : `${owner || "会话的主人"}收回了这次授权`;
}
