import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { notify } from "./notify.ts";
import { peerFetch } from "./peers.ts";
import { findSpace } from "./spaces.ts";
import { OWNER } from "./users.ts";
import { HttpError, json, newId, now, truncate } from "./util.ts";

/**
 * A space has one home (docs/v2/mesh.md §5). A mirror of another node's space is read-only here:
 * what a tool would write into it is written on the home instead and comes back with the next sync —
 * so the two never hold different versions of the same thing. The home offline, the write waits in
 * the outbox (`fed_outbox`) and is sent again when the mirrors are synced; a write the home refuses
 * is not retried, the owner is told.
 *
 * Only what the sync brings back is forwarded (memories, notes and pages); what a mirror keeps of its
 * own (annotations, levels, this node's items) is written here as before. Forwarding uses the home's
 * tool interface for the owner's own devices (`/api/peer/tool`): a mirror of another person's server
 * cannot be written from here, and its home says so.
 */

/** Tools whose write into a mirror goes to the home. */
export const FORWARDED = new Set(["remember", "supersede", "forget", "save_note", "write_page"]);

type Mirror = { peer: string; remoteSpace: string };
const mirrorOfSpace = (app: App, spaceId: string | null | undefined): Mirror | null => (spaceId ? ((findSpace(app, spaceId)?.settings.mirror as Mirror | undefined) ?? null) : null);

/** The space a write tool's call lands in, as far as its arguments say (a memory's own space for calls that name one). */
function targetSpace(app: App, name: string, args: Record<string, unknown>, fallback: string) {
  if (typeof args.memory_id === "string") return one<{ space_id: string }>(app.db, "select space_id from memories where id = ?", args.memory_id)?.space_id ?? fallback;
  return typeof args.space === "string" && args.space ? args.space : fallback;
}

const remoteId = (app: App, peer: string, entity: "source" | "memory", localId: string) =>
  one<{ remote_id: string }>(app.db, "select remote_id from peer_aliases where peer = ? and entity = ? and local_id = ?", peer, entity, localId)?.remote_id;

/** This node's ids of mirrored sources and memories, as the home knows them; an id the home never had stays and is named. */
function toHomeIds(app: App, peer: string, value: unknown, unknown: Set<string>): unknown {
  if (typeof value === "string")
    return value
      .replace(/src:([A-Za-z0-9_-]{6,})/g, (m, id: string) => {
        const r = remoteId(app, peer, "source", id);
        if (!r) unknown.add(`src:${id}`);
        return r ? `src:${r}` : m;
      })
      .replace(/mem:([A-Za-z0-9_-]{6,})/g, (m, id: string) => {
        const r = remoteId(app, peer, "memory", id);
        return r ? `mem:${r}` : m;
      });
  if (Array.isArray(value)) return value.map((v) => toHomeIds(app, peer, v, unknown));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toHomeIds(app, peer, v, unknown)]));
  return value;
}

type Outgoing = { peer: string; space: string; tool: string; args: Record<string, unknown> };

async function send(app: App, o: Outgoing) {
  // The status tells a refusal from a home that cannot be reached (peerJson keeps only the message).
  const res = await peerFetch(app, o.peer, "/api/peer/tool", { method: "POST", body: JSON.stringify({ session: "镜像空间的写入", name: o.tool, args: o.args, spaces: [o.space] }), headers: { "content-type": "application/json" }, timeoutMs: 60_000 });
  const text = await res.text();
  const data = json<{ text?: string; isError?: boolean; error?: string } | null>(text, null);
  if (!res.ok) throw new HttpError(res.status, data?.error ?? res.statusText);
  if (data?.isError) throw new HttpError(400, data.text ?? "主没有接受");
  return data?.text ?? "";
}
/** The home said no (not “could not be reached”): sending again will not help. */
const refused = (e: unknown) => {
  const s = (e as { status?: number }).status;
  return typeof s === "number" && s >= 400 && s < 500 && s !== 408 && s !== 429;
};

/** Bring the home's change back now, where this mirror is synced. */
async function syncBack(app: App, m: Mirror) {
  const sub = one<{ id: string }>(app.db, "select id from peer_subscriptions where peer = ? and remote_space = ? and mode = 'sync'", m.peer, m.remoteSpace);
  if (!sub) return;
  const { syncSubscription } = await import("./federation.ts");
  await syncSubscription(app, sub.id).catch(() => {});
}

/**
 * A write tool called on a mirror space: its result when the call was taken care of here (written on
 * the home, queued, or refused), null when the space is this node's own and the tool should just run.
 */
export async function forwardToHome(app: App, ctx: { spaceId: string; userId?: string | null; runId?: string | null }, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean } | null> {
  const space = targetSpace(app, name, args, ctx.spaceId);
  const m = mirrorOfSpace(app, space);
  // What the sync does not carry (annotations, levels, items of this node's own) stays local, as before.
  if (!m || !FORWARDED.has(name)) return null;
  const local = findSpace(app, space)?.name ?? space;
  if ((ctx.userId ?? OWNER) !== OWNER) return { text: `空间「${local}」的主在 ${m.peer}，只有本人能从镜像往主上写。`, isError: true };
  const unknown = new Set<string>();
  const out: Outgoing = { peer: m.peer, space: m.remoteSpace, tool: name, args: { ...(toHomeIds(app, m.peer, args, unknown) as Record<string, unknown>), ...("space" in args || !("memory_id" in args) ? { space: m.remoteSpace } : {}) } };
  // A memory named by this node's id: the home's id of the same memory.
  if (typeof args.memory_id === "string") {
    const r = remoteId(app, m.peer, "memory", args.memory_id);
    if (!r) return { text: `记忆 ${args.memory_id} 在 ${m.peer} 上没有对应的一条（它是只在这台写的），不能在主上改。`, isError: true };
    out.args.memory_id = r;
  }
  if (unknown.size) return { text: `引用了主（${m.peer}）上没有的原件：${[...unknown].join("、")}。镜像空间里的内容只能引用从主同步来的原件；本机别的空间的材料先放到主上。`, isError: true };
  try {
    const text = await send(app, out);
    await syncBack(app, m);
    return { text: `${text}\n（空间「${local}」的主在 ${m.peer}：已写在那边${one(app.db, "select 1 from peer_subscriptions where peer = ? and remote_space = ? and mode = 'sync'", m.peer, m.remoteSpace) ? "并同步回来" : "；这里只检索不同步，结果里的 id 是那边的"}。）`, isError: false };
  } catch (e) {
    if (refused(e)) return { text: `${m.peer} 没有接受这次写入：${(e as Error).message}`, isError: true };
    const id = newId("ob");
    run(app.db, "insert into fed_outbox(id, peer, space, tool, args, run_id, created_at, tries, status) values(?,?,?,?,?,?,?,0,'waiting')", id, out.peer, out.space, out.tool, JSON.stringify(out.args), ctx.runId ?? null, now());
    return { text: `空间「${local}」的主（${m.peer}）现在连不上，这次写入放进了发件箱（${id}），连上后自动补发；补发前这里查不到它。`, isError: false };
  }
}

export type OutboxEntry = { id: string; peer: string; space: string; tool: string; summary: string; createdAt: string; tries: number; status: "waiting" | "sent" | "rejected"; error: string | null };
const summaryOf = (args: Record<string, unknown>) => truncate(String(args.content ?? args.text ?? args.title ?? args.slug ?? args.reason ?? args.memory_id ?? "").replace(/\s+/g, " "), 80);

/** Writes waiting for a home (and the ones it refused, for the owner to see). */
export function listOutbox(app: App): OutboxEntry[] {
  return all<{ id: string; peer: string; space: string; tool: string; args: string; created_at: string; tries: number; status: string; error: string | null }>(app.db,
    "select * from fed_outbox where status != 'sent' order by created_at limit 200")
    .map((r) => ({ id: r.id, peer: r.peer, space: r.space, tool: r.tool, summary: summaryOf(json(r.args, {})), createdAt: r.created_at, tries: r.tries, status: r.status as OutboxEntry["status"], error: r.error }));
}

/** Send what waits, oldest first; a home that still does not answer keeps its writes for next time, one that refuses gets no second try. */
export async function flushOutbox(app: App, opts: { peer?: string } = {}) {
  const rows = all<{ id: string; peer: string; space: string; tool: string; args: string }>(app.db, `select id, peer, space, tool, args from fed_outbox where status = 'waiting' ${opts.peer ? "and peer = ?" : ""} order by created_at limit 200`, ...(opts.peer ? [opts.peer] : []));
  const down = new Set<string>();
  const touched = new Map<string, Mirror>();
  let sent = 0;
  let rejected = 0;
  for (const r of rows) {
    if (down.has(r.peer)) continue;
    try {
      await send(app, { peer: r.peer, space: r.space, tool: r.tool, args: json(r.args, {}) });
      run(app.db, "update fed_outbox set status = 'sent', sent_at = ?, error = null, tries = tries + 1 where id = ?", now(), r.id);
      touched.set(`${r.peer}|${r.space}`, { peer: r.peer, remoteSpace: r.space });
      sent++;
    } catch (e) {
      const error = (e as Error).message.slice(0, 300);
      if (refused(e)) {
        run(app.db, "update fed_outbox set status = 'rejected', error = ?, tries = tries + 1 where id = ?", error, r.id);
        rejected++;
        notify(app, { title: `${r.peer} 没有接受一条补发的写入`, body: `${r.tool}：${summaryOf(json(r.args, {}))}\n\n原因：${error}\n\n它留在 设置 → 设备 的发件箱里，可以删掉或到 ${r.peer} 上重做。`, link: "#/settings?tab=peers" });
      } else {
        run(app.db, "update fed_outbox set error = ?, tries = tries + 1 where id = ?", error, r.id);
        down.add(r.peer);
      }
    }
  }
  for (const m of touched.values()) await syncBack(app, m);
  return { sent, rejected, waiting: rows.length - sent - rejected };
}

/** Drop an entry (a refused write the owner gave up on, or one they no longer want sent). */
export function dropOutbox(app: App, id: string) {
  return { ok: run(app.db, "delete from fed_outbox where id = ? and status != 'sent'", id).changes > 0 };
}

/** How a space is placed: this node's own, kept on this machine only, or a mirror of another node's. */
export function placementOf(app: App, spaceId: string): { kind: "home" | "local" | "replica"; peer?: string; sync?: boolean } {
  const s = findSpace(app, spaceId);
  const m = s?.settings.mirror as Mirror | undefined;
  if (m) return { kind: "replica", peer: m.peer, sync: !!one(app.db, "select 1 from peer_subscriptions where peer = ? and remote_space = ? and mode = 'sync'", m.peer, m.remoteSpace) };
  return { kind: (s?.settings as { local?: boolean } | undefined)?.local ? "local" : "home" };
}
