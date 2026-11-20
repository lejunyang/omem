import { createAsk, lapseAsk, registerAskHandler } from "../agents/asks.ts";
import { findConnection } from "../auth/vault.ts";
import { z } from "zod";
import { can, requirePerm } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { itemProviders } from "../plugins/process-hooks.ts";
import type { CallContext, ExternalItem, ItemProvider } from "../plugins/types.ts";
import { addItemEvent, getItem, onItemStatus, upsertItem } from "./store.ts";

export const targetInput = z.object({
  provider: z.string().min(1), target: z.string().trim().min(1).max(500), spaceId: z.string().min(1),
  importMode: z.enum(["candidate", "direct"]).default("candidate"),
  mode: z.enum(["confirm", "direct"]).default("confirm"), enabled: z.boolean().default(true),
});
type Target = { import_mode: "candidate" | "direct"; subjects: string; id: string; provider: string; target: string; space_id: string; user_id: string; mode: "confirm" | "direct"; enabled: number; cursor: string | null; error: string | null };
type Link = { synced_at: string; item_id: string; target_id: string; snapshot: string; dismissed: number };
type Write = { ask_id: string | null; id: string; item_id: string; status: string; revision: string; state: string; error: string | null };
const pageSchema = z.object({
  items: z.array(z.object({
    key: z.string().min(1).max(500), url: z.httpUrl(), title: z.string().trim().min(1).max(1000), status: z.string().min(1),
    kind: z.enum(["todo", "watch"]).optional(), assignee: z.string().optional(), parentKey: z.string().optional(),
    updatedAt: z.iso.datetime({ offset: true }), revision: z.string().min(1).optional(), summary: z.string().optional(),
  })).max(500), cursor: z.string().optional(), done: z.boolean(),
});

function targetFor(app: App, user: string, id: string) {
  const t = one<Target>(app.db, "select * from item_provider_targets where id=? and user_id=?", id, user);
  if (!t) throw new HttpError(404, "找不到该订阅");
  requirePerm(app, user, "space.read", t.space_id);
  requirePerm(app, user, "memory.write", t.space_id);
  requirePerm(app, user, "connector.use");
  return t;
}

function providerFor(name: string, space: string) {
  const entry = itemProviders.get(name);
  if (!entry) throw new HttpError(409, "事项提供者未启用");
  if (entry.spaces.length && !entry.spaces.includes(space)) throw new HttpError(403, "超出提供者的空间范围");
  return entry;
}

export function configureTarget(app: App, userId: string, input: z.input<typeof targetInput>) {
  const t = targetInput.parse(input);
  if (!findSpace(app, t.spaceId)) throw new HttpError(404, "找不到订阅空间");
  requirePerm(app, userId, "space.read", t.spaceId);
  requirePerm(app, userId, "memory.write", t.spaceId);
  requirePerm(app, userId, "connector.use");
  if (t.enabled && !providerFor(t.provider, t.spaceId).def.setStatus && t.mode === "direct")
    throw new HttpError(400, "此提供者只支持导入");
  return tx(app.db, () => {
    const saved = one<{ id: string }>(app.db, `insert into item_provider_targets(id,provider,target,user_id,space_id,mode,enabled,import_mode)
      values(?,?,?,?,?,?,?,?) on conflict(user_id,space_id,provider,target) do update set mode=excluded.mode,enabled=excluded.enabled,import_mode=excluded.import_mode returning id`,
      newId("pt"), t.provider, t.target, userId, t.spaceId, t.mode, Number(t.enabled), t.importMode)!;
    // Revoking direct write must also revoke queued work, even if direct write is later re-enabled.
    const obsolete = all<Write>(app.db, `select w.* from item_provider_writes w join item_provider_links l on l.item_id=w.item_id
      where l.target_id=? and (?=0 or (?='confirm' and w.state='ready'))`, saved.id, Number(t.enabled), t.mode);
    for (const w of obsolete) {
      if (w.ask_id) lapseAsk(app, w.ask_id, "同步目标已暂停");
      run(app.db, "delete from item_provider_writes where id=?", w.id);
      addItemEvent(app, w.item_id, "provider", "订阅授权已变化，取消待执行的回写", "user");
    }
    return saved;
  });
}

export function targetsOf(app: App, user: string) {
  return all<Target>(app.db, "select * from item_provider_targets where user_id=?", user)
    .filter(t => can(app, user, "space.read", t.space_id));
}

const localStatus = (def: ItemProvider, external: string) => {
  if (!Object.hasOwn(def.statuses, external)) throw new Error(`未声明的外部状态 ${external}`);
  const mapped = def.statuses[external];
  return mapped === "active" ? "open" : mapped;
};
const detail = (ext: ExternalItem) => [ext.summary, ext.url].filter(Boolean).join("\n\n");
const writeFor = (app: App, item: string) => one<Write>(app.db, "select * from item_provider_writes where item_id=?", item);
const linkFor = (app: App, item: string) => one<Link>(app.db, "select * from item_provider_links where item_id=?", item);

function applyExternal(app: App, t: Target, def: ItemProvider, ext: ExternalItem) {
  const status = localStatus(def, ext.status);
  const link = one<Link>(app.db, `select l.* from item_provider_links l join item_provider_targets t on t.id=l.target_id
    where t.user_id=? and t.space_id=? and t.provider=? and t.subjects=? and l.external_key=?`, t.user_id, t.space_id, t.provider, t.subjects, ext.key);
  const snapshot = JSON.stringify(ext);
  if (!link) {
    const item = upsertItem(app, undefined, { userId: t.user_id, spaceId: t.space_id, title: ext.title, kind: ext.kind, status: t.import_mode === "candidate" ? "candidate" : status, detail: detail(ext) });
    run(app.db, "insert into item_provider_links(item_id,target_id,external_key,snapshot,synced_at) values(?,?,?,?,?)", item.id, t.id, ext.key, snapshot, now());
    return;
  }
  const prev: ExternalItem = JSON.parse(link.snapshot);
  if (link.snapshot === snapshot || Date.parse(ext.updatedAt) < Date.parse(prev.updatedAt)) return;
  run(app.db, "update item_provider_links set snapshot=?,synced_at=? where item_id=?", snapshot, now(), link.item_id);
  if (link.dismissed) return;
  const local = getItem(app, link.item_id);
  if (local.userId !== t.user_id || local.spaceId !== t.space_id) throw new Error("事项归属已变化");
  const write = writeFor(app, local.id);
  if (write && write.revision !== ext.revision) {
    if (write.ask_id) lapseAsk(app, write.ask_id, "外部版本已变化");
    run(app.db, "update item_provider_writes set state='conflict',error=? where id=?", "外部版本已变化，请重新核对", write.id);
  }
  upsertItem(app, local.id, {
    title: local.title === prev.title ? ext.title : undefined,
    detail: local.detail === detail(prev) ? detail(ext) : undefined,
    status: !write && local.status === localStatus(def, prev.status) ? status : local.status,
    note: `外部更新：${ext.title}（${ext.status}） ${ext.url}${write && write.revision !== ext.revision ? "；回写因版本冲突暂停" : ""}`,
  });
}

// Called with the same semantics as the lifecycle hooks. Candidate decisions are local only.
onItemStatus((app, before, after) => {
  const link = linkFor(app, after.id);
  if (!link) return;
  if (before.status === "candidate") {
    run(app.db, "update item_provider_links set dismissed=? where item_id=?", Number(after.status === "cancelled"), after.id);
    return;
  }
  const previous = writeFor(app, after.id);
  if (previous?.ask_id) lapseAsk(app, previous.ask_id, "本地状态已变化");
  run(app.db, "delete from item_provider_writes where item_id=?", after.id);
  const t = targetFor(app, after.userId, link.target_id);
  if (!t.enabled || t.space_id !== after.spaceId || link.dismissed) return;
  const def = providerFor(t.provider, t.space_id).def;
  if (!def.setStatus) return;
  const ext: ExternalItem = JSON.parse(link.snapshot);
  const matches = Object.keys(def.statuses).filter(s => localStatus(def, s) === after.status);
  if (matches.length !== 1 || matches[0] === ext.status) return;
  if (!ext.revision) {
    addItemEvent(app, after.id, "provider", "外部条目缺少版本，回写已暂停", "host");
    return;
  }
  const writeId = newId("iw");
  run(app.db, "insert into item_provider_writes(id,item_id,status,revision,state) values(?,?,?,?,?)",
    writeId, after.id, matches[0], ext.revision, t.mode === "direct" ? "ready" : "pending");
  if (t.mode === "confirm") {
    const ask = createAsk(app, { runId: null, userId: after.userId, allowText: false,
      question: `要把「${after.title}」在 ${ext.url} 的状态从 ${ext.status} 改为 ${matches[0]} 吗？`,
      options: [{ label: "确认回写" }, { label: "只改本地" }], context: { handler: "item-provider-write", item: after.id, writeId } });
    run(app.db, "update item_provider_writes set ask_id=? where id=?", ask.id, writeId);
  }
  addItemEvent(app, after.id, "provider", `回写 ${matches[0]}：${t.mode === "direct" ? "等待同步" : "等待确认"}`, "host");
});

export function providerState(app: App, user: string, itemId: string) {
  const link = linkFor(app, itemId);
  if (!link) return null;
  const item = getItem(app, itemId);
  if (item.userId !== user) throw new HttpError(404, "找不到事项");
  requirePerm(app, user, "space.read", item.spaceId);
  const target = one<Target>(app.db, "select * from item_provider_targets where id=? and user_id=?", link.target_id, user);
  if (!target) throw new HttpError(404, "找不到订阅");
  if (target.space_id !== item.spaceId) throw new HttpError(403, "事项空间已变化");
  return { target, syncedAt: link.synced_at, external: JSON.parse(link.snapshot) as ExternalItem, write: writeFor(app, itemId) ?? null };
}

/** Local status changes on a linked item can schedule an action using the subscriber's connection. */
export function checkProviderEdit(app: App, user: string, itemId: string) {
  const state = providerState(app, user, itemId);
  if (state) requirePerm(app, user, "memory.write", state.target.space_id);
}

// Bind the target to the connected accounts used on its first pull. A replacement login
// must never receive a write approved for the old account, even when its issue keys match.
function boundContext(app: App, t: Target, base: CallContext, writing: boolean) {
  const subjects: Record<string, string> = JSON.parse(t.subjects);
  const entry = itemProviders.get(t.provider);
  const ctx: CallContext = { ...base, async connection(provider) {
    const current = () => findConnection(app, t.user_id, provider)?.accountId;
    const conn = await base.connection(provider);
    if (!conn) return null;
    const account = current();
    if (!account || (Object.hasOwn(subjects, provider) ? subjects[provider] !== account : writing))
      throw new HttpError(409, "连接账号已变化，请核对订阅");
    subjects[provider] = account;
    return { ...conn, fetch(path, init) {
      base.signal.throwIfAborted();
      if (!targetFor(app, t.user_id, t.id).enabled || itemProviders.get(t.provider) !== entry)
        throw new HttpError(409, "订阅或提供者已变化");
      if (current() !== account) throw new HttpError(409, "连接账号已变化");
      return conn.fetch(path, init);
    } };
  } };
  return { ctx, subjects };
}

// Overlapping targets can contain the same external key. Serialize their pulls and writes.
const busy = new Set<string>();
const lockKey = (t: Target) => JSON.stringify([t.user_id, t.space_id, t.provider]);
async function withTarget<T>(target: Target, fn: () => Promise<T>) {
  const id = lockKey(target);
  if (busy.has(id)) throw new HttpError(409, "订阅正在同步");
  busy.add(id);
  try { return await fn(); } finally { busy.delete(id); }
}

async function bounded<T>(signal: AbortSignal, work: Promise<T>) {
  signal.throwIfAborted();
  let abort!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work, deadline]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function sendWrite(app: App, user: string, item: string, writeId: string, direct: boolean) {
  const state = providerState(app, user, item);
  if (!state?.write || state.write.id !== writeId) throw new HttpError(409, "回写请求已变化");
  const { target, write, external } = state;
  if (!target.enabled || (direct && (target.mode !== "direct" || write.state !== "ready"))) throw new HttpError(409, "订阅或授权已变化");
  if (write.state === "conflict" || write.revision !== external.revision) throw new HttpError(409, "外部版本已变化");
  const entry = providerFor(target.provider, target.space_id);
  targetFor(app, user, target.id);
  const setStatus = entry.def.setStatus;
  if (!setStatus || localStatus(entry.def, write.status) !== getItem(app, item).status) throw new HttpError(409, "状态或提供者能力已变化");
  const { ctx } = boundContext(app, target, entry.context(app, user, target.space_id, AbortSignal.timeout(30_000)), true);
  try {
    const result = await bounded(ctx.signal, setStatus({ ...ctx, idempotencyKey: write.id }, { key: external.key, status: write.status, expectedRevision: write.revision }));
    if (result.status !== write.status) throw new HttpError(409, "外部返回的状态与请求不一致");
    tx(app.db, () => {
      run(app.db, "update item_provider_links set snapshot=? where item_id=?", JSON.stringify({ ...external, ...result, revision: result.revision }), item);
      run(app.db, "delete from item_provider_writes where id=?", write.id);
      if (write.ask_id) lapseAsk(app, write.ask_id, "这次回写已完成");
      addItemEvent(app, item, "provider", `已回写 ${external.url}（${result.status}）`, "host");
    });
  } catch (e) {
    const message = (e as Error).message;
    const code = (e as { status?: number }).status;
    run(app.db, "update item_provider_writes set state=?,error=? where id=?", code === 409 || code === 412 ? "conflict" : "failed", message, write.id);
    addItemEvent(app, item, "provider", `回写暂停：${message}`, "host");
    throw e;
  }
}

export async function decideProviderWrite(app: App, user: string, item: string, writeId: string, confirm: boolean) {
  const state = providerState(app, user, item);
  if (!state?.write || state.write.id !== writeId) throw new HttpError(409, "回写请求已变化");
  targetFor(app, user, state.target.id);
  return withTarget(state.target, async () => {
    if (confirm) await sendWrite(app, user, item, writeId, false);
    else {
      run(app.db, "delete from item_provider_writes where id=?", writeId);
      if (state.write?.ask_id) lapseAsk(app, state.write.ask_id, "已放弃这次回写");
      addItemEvent(app, item, "provider", "已放弃这次回写", "user");
    }
    return { ok: true };
  });
}

export function syncTarget(app: App, user: string, id: string) {
  const t = targetFor(app, user, id);
  return withTarget(t, async () => {
    if (!t.enabled) throw new HttpError(409, "订阅已暂停");
    const entry = providerFor(t.provider, t.space_id);
    const { ctx, subjects } = boundContext(app, t, entry.context(app, user, t.space_id, AbortSignal.timeout(30_000)), false);
    let cursor = t.cursor;
    try {
      for (let page = 0; page < 10; page++) {
        const result = pageSchema.parse(await bounded(ctx.signal, entry.def.pull(ctx, { target: t.target, cursor: cursor ?? undefined })));
        ctx.signal.throwIfAborted();
        const current = targetFor(app, user, id);
        if (!current.enabled || current.import_mode !== t.import_mode || current.cursor !== cursor || itemProviders.get(t.provider) !== entry) throw new HttpError(409, "订阅或提供者已变化");
        if (!result.done && (!result.cursor || cursor === result.cursor)) throw new Error("分页游标没有推进");
        tx(app.db, () => {
          t.subjects = JSON.stringify(subjects, Object.keys(subjects).sort());
          run(app.db, "update item_provider_targets set subjects=? where id=?", t.subjects, id);
          for (const ext of result.items) applyExternal(app, t, entry.def, ext);
          cursor = result.cursor ?? cursor;
          run(app.db, "update item_provider_targets set cursor=?,error=null where id=?", cursor, id);
        });
        if (result.done) break;
      }
      const ready = all<Write>(app.db, `select w.* from item_provider_writes w join item_provider_links l on l.item_id=w.item_id
        where l.target_id=? and w.state='ready'`, id);
      for (const w of ready) await sendWrite(app, user, w.item_id, w.id, true);
    } catch (e) {
      run(app.db, "update item_provider_targets set error=? where id=?", (e as Error).message, id);
      throw e;
    }
    return { cursor };
  });
}

export async function syncItemProviders(app: App) {
  for (const t of all<Target>(app.db, "select * from item_provider_targets where enabled=1")) {
    if (busy.has(lockKey(t))) continue;
    try { await syncTarget(app, t.user_id, t.id); }
    catch (e) { run(app.db, "update item_provider_targets set error=? where id=?", (e as Error).message, t.id); }
  }
}

registerAskHandler("item-provider-write", async (app, ask, ctx) => {
  await decideProviderWrite(app, ask.userId, String(ctx.item), String(ctx.writeId), ask.choice === 0);
}, (_app, ask, _ctx, by) => {
  if (ask.userId !== by) throw new HttpError(403, "只能由订阅人确认回写");
});
