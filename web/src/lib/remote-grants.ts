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
/**
 * The same from `GET /api/remote/grant-candidates` (members holding either capability, logged in, as the
 * server sees it; also when the session's owner is not the owner of omem): minus those already given it.
 */
export function fromCandidates(rows: { id: string; name: string; caps: string[] }[], granted: string[] = []): GrantCandidate[] {
  return rows
    .filter((r) => !granted.includes(r.id))
    .map((r) => ({ id: r.id, name: r.name, view: r.caps.includes("remote.view"), operate: r.caps.includes("remote.operate") }))
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

/** Why a grant ended, as the server says it (the session list's `ended`, the `remote-grant-ended` event). */
export type EndReason = "revoked" | "expired" | "closed";
/** A session handed to this person that ended in the last minutes (`GET /api/remote` lists it so). */
export type EndedGrant = { id: string; grantId: string; ended: EndReason; endedAt: string };
export const isEnded = (s: object): s is EndedGrant => "ended" in s && typeof (s as { ended?: unknown }).ended === "string" && !("kind" in s);

/** What the member is told when a session handed to them ends: by the server's reason. */
export function endedText(reason: EndReason, owner: string | null | undefined) {
  return reason === "expired" ? "授权到期了" : reason === "closed" ? "会话已经关了" : `${owner || "会话的主人"}收回了这次授权`;
}
/** The same guessed from the grant alone (an older server says no reason): past its end means it ran out. */
export function endedMessage(grant: Pick<RemoteGrant, "expiresAt">, owner: string | null | undefined, now = Date.now()) {
  return endedText(Date.parse(grant.expiresAt) <= now + 5_000 ? "expired" : "revoked", owner);
}
