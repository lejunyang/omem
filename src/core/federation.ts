import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { createSpace, findSpace, getSpace, updateSpace } from "./spaces.ts";
import { HttpError, json, newId, now, slugify } from "./util.ts";
import { createApiToken, findUser, OWNER } from "./users.ts";
import { invite, peerJson } from "./peers.ts";
import { search } from "../search/search.ts";
import { deleteSource, sourceText, upsertSource } from "../sources/store.ts";
import { deletePage, readPage, writePage } from "../wiki/store.ts";
import { getMemory, remember, retract, type MemoryKind } from "../memory/store.ts";

/**
 * Sharing between omem servers (docs/v2/multi-user.md, “多服务连接”).
 *
 * Serving: another server pairs as a *service account* (users.kind = service, no personal space, no
 * login), with grants per space (`peer_shares`): `query` lets it search and read, `sync` also lets it
 * follow the change log; `kinds` says what: `wiki`, `memory`, and source kinds (`doc`, `chat`, `web`,
 * `note`, `code`…, or `source` for all). Restricted things never leave: other kinds, other spaces.
 *
 * Subscribing: this server keeps `peer_subscriptions` to the other's spaces. Search reaches them live
 * (`peerSearch`); citing a result brings that source into a local, read-only mirror space first
 * (`peerRead`), so citations stay `src:<local id>`. `sync` subscriptions copy sources, pages and
 * memories into the mirror on a schedule. Mirrored material is not digested again (its memories came
 * along). Tokens never travel: only content does.
 */
export type ShareMode = "query" | "sync";
export type Share = { space: string; name: string; mode: ShareMode; kinds: string[] };
export const DEFAULT_KINDS = ["wiki", "memory", "doc"];
const MAX_TEXT = 400_000;

// ---- serving -------------------------------------------------------------------

/** A service account for another server: created once per label, never able to log in. */
export function serviceAccount(app: App, label: string) {
  const id = `svc-${slugify(label).replace(/[^a-z0-9-]/g, "") || newId("").slice(0, 8)}`;
  if (!findUser(app, id)) run(app.db, "insert into users(id,name,role,kind,status,created_at) values(?,?,'viewer','service','active',?)", id, label, now());
  return id;
}

/** Grants for a service account (replacing its old ones). */
export function setShares(app: App, userId: string, shares: { space: string; mode?: ShareMode; kinds?: string[] }[]) {
  const u = findUser(app, userId);
  if (!u || u.kind !== "service") throw new HttpError(400, "只能给设备的服务账号设共享");
  for (const s of shares) {
    const sp = getSpace(app, s.space);
    if (sp.kind === "personal" || sp.kind === "worktree") throw new HttpError(400, `个人空间和临时空间不能共享：${s.space}`);
  }
  run(app.db, "delete from peer_shares where user_id = ?", userId);
  for (const s of shares) run(app.db, "insert into peer_shares(user_id,space_id,mode,kinds,created_at) values(?,?,?,?,?)", userId, s.space, s.mode ?? "query", JSON.stringify(s.kinds?.length ? s.kinds : DEFAULT_KINDS), now());
}

/** What this caller may see: the owner (one of their own devices) everything, a service account its grants. */
export function sharesFor(app: App, userId: string): Share[] {
  if (userId === OWNER)
    return all<{ id: string; name: string }>(app.db, "select id, name from spaces where kind not in ('worktree')").map((s) => ({ space: s.id, name: s.name, mode: "sync" as const, kinds: ["wiki", "memory", "source"] }));
  const u = findUser(app, userId);
  if (!u || u.kind !== "service" || u.disabledAt) return [];
  return all<{ space_id: string; mode: string; kinds: string }>(app.db, "select space_id, mode, kinds from peer_shares where user_id = ?", userId).flatMap((r) => {
    const s = findSpace(app, r.space_id);
    return s ? [{ space: r.space_id, name: s.name, mode: r.mode === "sync" ? "sync" : "query", kinds: json<string[]>(r.kinds, DEFAULT_KINDS) } as Share] : [];
  });
}

const allowsSource = (kinds: string[], kind: string) => kinds.includes("source") || kinds.includes(kind);

/** A pairing code for another server: a service account of its own, with these grants. */
export function shareInvite(app: App, input: { label: string; shares: { space: string; mode?: ShareMode; kinds?: string[] }[]; url?: string }) {
  const userId = serviceAccount(app, input.label);
  setShares(app, userId, input.shares);
  const code = invite(app, { url: input.url, label: input.label, userId });
  return { ...code, userId };
}

export function listShareAccounts(app: App) {
  return all<{ id: string; name: string; created_at: string; disabled_at: string | null }>(app.db, "select id, name, created_at, disabled_at from users where kind = 'service' order by created_at").map((u) => ({
    id: u.id,
    name: u.name,
    createdAt: u.created_at,
    disabled: !!u.disabled_at,
    lastUsedAt: one<{ at: string | null }>(app.db, "select max(last_used_at) at from api_tokens where user_id = ?", u.id)?.at ?? null,
    shares: sharesFor(app, u.id),
  }));
}

/** Stop sharing with a server: its tokens go, the account stays (disabled) for the record. */
export function revokeShareAccount(app: App, userId: string) {
  const u = findUser(app, userId);
  if (!u || u.kind !== "service") throw new HttpError(404, "没有这个服务账号");
  run(app.db, "delete from api_tokens where user_id = ?", userId);
  run(app.db, "delete from peer_shares where user_id = ?", userId);
  run(app.db, "update users set disabled_at = ? where id = ?", now(), userId);
}

function grant(app: App, userId: string, space: string, mode?: ShareMode) {
  const g = sharesFor(app, userId).find((s) => s.space === space);
  if (!g || (mode === "sync" && g.mode !== "sync")) throw new HttpError(403, `没有共享空间 ${space}${mode === "sync" ? "（同步）" : ""}`);
  return g;
}

export type FedHit = { type: "source" | "page" | "memory"; id: string; space: string; title: string; snippet: string; sourceId?: string; lineStart?: number; lineEnd?: number; originKey?: string | null; kind?: string };

/** Search within what is shared with the caller. */
export async function fedSearch(app: App, userId: string, input: { query: string; spaces?: string[]; limit?: number }): Promise<FedHit[]> {
  const shares = sharesFor(app, userId).filter((s) => !input.spaces?.length || input.spaces.includes(s.space));
  if (!shares.length) return [];
  const hits = await search(app, input.query, { spaces: shares.map((s) => s.space), types: ["chunk", "page", "memory"], limit: Math.min(input.limit ?? 10, 30) * 2 });
  const out: FedHit[] = [];
  for (const h of hits) {
    const g = shares.find((s) => s.space === h.spaceId);
    if (!g) continue;
    if (h.type === "page" && g.kinds.includes("wiki")) out.push({ type: "page", id: h.id, space: h.spaceId, title: h.title, snippet: h.snippet });
    else if (h.type === "memory" && g.kinds.includes("memory")) out.push({ type: "memory", id: h.id, space: h.spaceId, title: h.title, snippet: h.snippet });
    else if (h.type === "chunk" && h.sourceKind && allowsSource(g.kinds, h.sourceKind)) {
      const origin = h.sourceId ? one<{ origin_key: string | null }>(app.db, "select origin_key from sources where id = ?", h.sourceId)?.origin_key : null;
      out.push({ type: "source", id: h.sourceId!, space: h.spaceId, title: h.title, snippet: h.snippet, sourceId: h.sourceId, lineStart: h.lineStart, lineEnd: h.lineEnd, originKey: origin, kind: h.sourceKind });
    }
  }
  return out.slice(0, input.limit ?? 10);
}

/** One shared source, whole (up to a size). */
export function fedSource(app: App, userId: string, id: string) {
  const s = one<{ id: string; space_id: string; kind: string; uri: string; title: string; origin_key: string | null; updated_at: string; deleted_at: string | null }>(app.db, "select id, space_id, kind, uri, title, origin_key, updated_at, deleted_at from sources where id = ?", id);
  if (!s || s.deleted_at) throw new HttpError(404, "原件不存在");
  const g = grant(app, userId, s.space_id);
  if (!allowsSource(g.kinds, s.kind)) throw new HttpError(403, "这类原件没有共享");
  const text = sourceText(app, s.id);
  return { id: s.id, space: s.space_id, kind: s.kind, uri: s.uri, title: s.title, originKey: s.origin_key, updatedAt: s.updated_at, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

export type Change = { seq: number; entity: "source" | "page" | "memory"; op: "upsert" | "delete"; id: string; data?: Record<string, unknown> };

/** What changed in a space shared for syncing since `since`, with each thing as it is now. */
export function fedChanges(app: App, userId: string, space: string, since: number, limit = 100) {
  const g = grant(app, userId, space, "sync");
  const rows = all<{ seq: number; entity: string; entity_id: string; op: string }>(app.db, "select seq, entity, entity_id, op from change_log where space_id = ? and seq > ? order by seq limit ?", space, since, Math.min(limit, 500) + 1);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  // The latest change of each thing in this page is enough: it carries the current state.
  const last = new Map<string, (typeof page)[number]>();
  for (const r of page) last.set(`${r.entity}:${r.entity_id}`, r);
  const changes: Change[] = [];
  for (const r of [...last.values()].sort((a, b) => a.seq - b.seq)) {
    const c: Change = { seq: r.seq, entity: r.entity as Change["entity"], op: r.op as Change["op"], id: r.entity_id };
    if (r.op === "upsert") {
      if (r.entity === "source") {
        const s = one<{ kind: string; uri: string; title: string; origin_key: string | null; space_id: string; deleted_at: string | null }>(app.db, "select kind, uri, title, origin_key, space_id, deleted_at from sources where id = ?", r.entity_id);
        if (!s || s.deleted_at || s.space_id !== space) c.op = "delete";
        else if (!allowsSource(g.kinds, s.kind)) continue;
        else c.data = { kind: s.kind, uri: s.uri, title: s.title, originKey: s.origin_key, text: sourceText(app, r.entity_id).slice(0, MAX_TEXT) };
      } else if (r.entity === "page") {
        if (!g.kinds.includes("wiki")) continue;
        try {
          const p = readPage(app, space, r.entity_id.slice(space.length + 1));
          c.data = { slug: p.slug, meta: p.meta, body: p.body };
        } catch {
          c.op = "delete";
        }
      } else if (r.entity === "memory") {
        if (!g.kinds.includes("memory")) continue;
        try {
          const m = getMemory(app, r.entity_id);
          if (m.spaceId !== space) continue;
          c.data = { kind: m.kind, subject: m.subject, content: m.content, status: m.status, sourceRefs: m.sourceRefs };
        } catch {
          c.op = "delete";
        }
      }
    } else if ((r.entity === "page" && !g.kinds.includes("wiki")) || (r.entity === "memory" && !g.kinds.includes("memory"))) continue;
    changes.push(c);
  }
  return { changes, next: page.at(-1)?.seq ?? since, more };
}

// ---- subscribing -----------------------------------------------------------------

export type Subscription = { id: string; peer: string; remoteSpace: string; remoteName: string; localSpace: string; mode: ShareMode; lastSeq: number; syncedAt: string | null; error: string | null };
type SubRow = { id: string; peer: string; remote_space: string; remote_name: string; local_space: string; mode: string; last_seq: number; synced_at: string | null; error: string | null };
const toSub = (r: SubRow): Subscription => ({ id: r.id, peer: r.peer, remoteSpace: r.remote_space, remoteName: r.remote_name, localSpace: r.local_space, mode: r.mode === "sync" ? "sync" : "query", lastSeq: r.last_seq, syncedAt: r.synced_at, error: r.error });
export const listSubscriptions = (app: App) => all<SubRow>(app.db, "select * from peer_subscriptions order by created_at").map(toSub);

/** Whether a space mirrors another server's: read-only here (src/auth/permissions.ts). */
export const mirrorOf = (app: App, spaceId: string) => (findSpace(app, spaceId)?.settings.mirror as { peer: string; remoteSpace: string } | undefined) ?? null;

/** Follow a space another server shares with this one; `sync` copies it into a local mirror space. */
export async function subscribe(app: App, input: { peer: string; remoteSpace: string; localSpace?: string; mode?: ShareMode }) {
  const info = await peerJson<{ node: string; shares: Share[] }>(app, input.peer, "/api/fed/info", undefined, 15_000);
  const share = info.shares.find((s) => s.space === input.remoteSpace);
  if (!share) throw new HttpError(404, `${input.peer} 没有向这里共享空间 ${input.remoteSpace}`);
  const mode = input.mode ?? share.mode;
  if (mode === "sync" && share.mode !== "sync") throw new HttpError(403, `${input.peer} 只允许检索 ${input.remoteSpace}，不能同步`);
  const localSpace = input.localSpace ?? slugify(`${input.peer}-${input.remoteSpace}`);
  const existing = findSpace(app, localSpace);
  if (!existing) createSpace(app, { id: localSpace, name: `${share.name}（${input.peer}）`, kind: "topic", description: `镜像 ${input.peer} 的空间 ${share.name}，只读。` });
  else if (!mirrorOf(app, localSpace) && (all(app.db, "select 1 from sources where space_id = ? limit 1", localSpace).length || all(app.db, "select 1 from pages where space_id = ? limit 1", localSpace).length))
    throw new HttpError(409, `空间 ${localSpace} 已有内容，换一个空间名`);
  const sp = getSpace(app, localSpace);
  updateSpace(app, localSpace, { settings: { ...sp.settings, mirror: { peer: input.peer, remoteSpace: input.remoteSpace }, autoOrganize: false } });
  run(
    app.db,
    `insert into peer_subscriptions(id,peer,remote_space,remote_name,local_space,mode,created_at) values(?,?,?,?,?,?,?)
     on conflict(peer, remote_space) do update set mode = excluded.mode, local_space = excluded.local_space, remote_name = excluded.remote_name`,
    newId("sub"), input.peer, input.remoteSpace, share.name, localSpace, mode, now(),
  );
  return toSub(one<SubRow>(app.db, "select * from peer_subscriptions where peer = ? and remote_space = ?", input.peer, input.remoteSpace)!);
}

export function unsubscribe(app: App, id: string) {
  const s = one<SubRow>(app.db, "select * from peer_subscriptions where id = ?", id);
  if (!s) throw new HttpError(404, "没有这个订阅");
  run(app.db, "delete from peer_subscriptions where id = ?", id);
  // The mirror stays as it is (searchable, no longer updated); it is no longer read-only.
  const sp = findSpace(app, s.local_space);
  if (sp?.settings.mirror) updateSpace(app, sp.id, { settings: { ...sp.settings, mirror: undefined } });
}

export type PeerHit = FedHit & { peer: string };

/** Search the spaces subscribed to on other servers, live; a server that does not answer in time is left out. */
export async function peerSearch(app: App, query: string, opts: { peer?: string; limit?: number; timeoutMs?: number } = {}) {
  const byPeer = new Map<string, string[]>();
  for (const s of listSubscriptions(app)) if (!opts.peer || s.peer === opts.peer) byPeer.set(s.peer, [...(byPeer.get(s.peer) ?? []), s.remoteSpace]);
  const missed: string[] = [];
  const results = await Promise.all(
    [...byPeer].map(async ([peer, spaces]) => {
      try {
        const hits = await peerJson<FedHit[]>(app, peer, "/api/fed/search", { query, spaces, limit: opts.limit ?? 8 }, opts.timeoutMs ?? 5000);
        return hits.map((h) => ({ ...h, peer }) as PeerHit);
      } catch {
        missed.push(peer);
        return [];
      }
    }),
  );
  return { hits: results.flat().slice(0, (opts.limit ?? 8) * Math.max(1, byPeer.size)), missed };
}

const aliasOf = (app: App, peer: string, entity: string, remoteId: string) => one<{ local_id: string }>(app.db, "select local_id from peer_aliases where peer = ? and entity = ? and remote_id = ?", peer, entity, remoteId)?.local_id ?? null;
const setAlias = (app: App, peer: string, entity: string, remoteId: string, localId: string) =>
  run(app.db, "insert into peer_aliases(peer,entity,remote_id,local_id) values(?,?,?,?) on conflict(peer,entity,remote_id) do update set local_id = excluded.local_id", peer, entity, remoteId, localId);

/** Another server's `src:<id>` in mirrored text, as this server's copy where there is one. */
function localRefs(app: App, peer: string, text: string) {
  return text.replace(/src:([A-Za-z0-9_-]{6,})/g, (m, id: string) => {
    const local = aliasOf(app, peer, "source", id);
    return local ? `src:${local}` : m;
  });
}

function storeMirrorSource(app: App, peer: string, space: string, remoteId: string, d: { kind: string; uri: string; title: string; originKey?: string | null; text: string }) {
  const r = upsertSource(app, { spaceId: space, kind: d.kind as "doc", uri: `peer:${peer}:${remoteId}`, title: d.title, text: d.text, meta: { mirror: { peer, id: remoteId, uri: d.uri }, ...(d.originKey ? { originKey: d.originKey } : {}) } });
  if (d.originKey) run(app.db, "update sources set origin_key = ? where id = ?", d.originKey, r.id);
  setAlias(app, peer, "source", remoteId, r.id);
  return r.id;
}

/** Bring one of another server's sources here (to cite it): into the mirror space of its subscription. */
export async function peerRead(app: App, peer: string, remoteId: string) {
  const known = aliasOf(app, peer, "source", remoteId);
  const d = await peerJson<{ id: string; space: string; kind: string; uri: string; title: string; originKey: string | null; text: string; truncated: boolean }>(app, peer, `/api/fed/source/${encodeURIComponent(remoteId)}`, undefined, 30_000);
  const sub = listSubscriptions(app).find((s) => s.peer === peer && s.remoteSpace === d.space);
  if (!sub) throw new HttpError(404, `没有订阅 ${peer} 的空间 ${d.space}`);
  const id = storeMirrorSource(app, peer, sub.localSpace, remoteId, d);
  return { id, title: d.title, space: sub.localSpace, lines: d.text.split("\n").length, truncated: d.truncated, existed: known === id };
}

/** One sync subscription: apply the other server's changes since the last time. */
export async function syncSubscription(app: App, id: string) {
  const s = one<SubRow>(app.db, "select * from peer_subscriptions where id = ?", id);
  if (!s) throw new HttpError(404, "没有这个订阅");
  if (s.mode !== "sync") throw new HttpError(400, "这个订阅只检索，不同步");
  let since = s.last_seq;
  let applied = 0;
  try {
    for (let page = 0; page < 50; page++) {
      const r = await peerJson<{ changes: Change[]; next: number; more: boolean }>(app, s.peer, `/api/fed/changes?space=${encodeURIComponent(s.remote_space)}&since=${since}&limit=100`, undefined, 60_000);
      // Sources first, so pages and memories that cite them find their local copies.
      const order = { source: 0, page: 1, memory: 2 } as const;
      for (const c of [...r.changes].sort((a, b) => order[a.entity] - order[b.entity])) {
        applyChange(app, s, c);
        applied++;
      }
      since = r.next;
      run(app.db, "update peer_subscriptions set last_seq = ?, synced_at = ?, error = null where id = ?", since, now(), id);
      if (!r.more) break;
    }
  } catch (e) {
    run(app.db, "update peer_subscriptions set error = ? where id = ?", (e as Error).message.slice(0, 300), id);
    throw e;
  }
  return { applied, lastSeq: since };
}

function applyChange(app: App, s: SubRow, c: Change) {
  const space = s.local_space;
  if (c.entity === "source") {
    const local = aliasOf(app, s.peer, "source", c.id);
    if (c.op === "delete") {
      if (local) deleteSource(app, local);
      return;
    }
    storeMirrorSource(app, s.peer, space, c.id, c.data as { kind: string; uri: string; title: string; originKey?: string | null; text: string });
  } else if (c.entity === "page") {
    const slug = c.id.slice(s.remote_space.length + 1);
    if (c.op === "delete") {
      try {
        deletePage(app, space, slug, "peer");
      } catch {}
      return;
    }
    const d = c.data as { slug: string; meta: { title: string } & Record<string, unknown>; body: string };
    writePage(app, space, d.slug, { meta: d.meta, body: localRefs(app, s.peer, d.body) }, { actor: "peer", message: `peer ${s.peer}: sync ${d.slug}` });
  } else if (c.entity === "memory") {
    const local = aliasOf(app, s.peer, "memory", c.id);
    const d = c.data as { kind: MemoryKind; subject: string; content: string; status: string; sourceRefs: string[] } | undefined;
    if (c.op === "delete" || (d && d.status !== "active")) {
      if (local && getMemory(app, local).status === "active") retract(app, local, `${s.peer} 上已${d?.status === "superseded" ? "更新" : "撤回"}`);
      if (!d || d.status !== "active") return;
    }
    if (!d) return;
    const content = localRefs(app, s.peer, d.content);
    if (local && getMemory(app, local).content === content) return;
    if (local) retract(app, local, `${s.peer} 上已更新`);
    const m = remember(app, { spaceId: space, kind: d.kind, subject: d.subject, content, sourceRefs: d.sourceRefs.map((r) => localRefs(app, s.peer, r)), createdBy: "agent", agentProfile: `peer:${s.peer}` });
    // Reviewed where it was written: this server's reviewer leaves it alone.
    run(app.db, "update memories set reviewed_at = ?, review_verdict = 'keep' where id = ?", now(), m.id);
    setAlias(app, s.peer, "memory", c.id, m.id);
  }
}

/** The scheduler's pass over every sync subscription. */
export async function syncAll(app: App) {
  const out: { id: string; applied?: number; error?: string }[] = [];
  for (const s of listSubscriptions(app).filter((x) => x.mode === "sync")) {
    try {
      out.push({ id: s.id, applied: (await syncSubscription(app, s.id)).applied });
    } catch (e) {
      out.push({ id: s.id, error: (e as Error).message });
    }
  }
  return out;
}
