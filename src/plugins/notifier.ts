import { DELIVERY_LEASE_MS, DELIVERY_TIMEOUT_MS, retryFailure } from "./delivery-policy.ts";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { activeUser, canWrite, findUser, getUser, identitiesOf, identityOwner, larkOpenIdOf } from "../core/users.ts";
import { HttpError, json, now, untilAbort, webLink } from "../core/util.ts";
import { addNotificationSink, deliveryPlan, withDeferredPush, markPushed, notify, type Notification } from "../core/notify.ts";
import { answerAsk, getAsk, type Ask } from "../agents/asks.ts";
import { larkBotInfo } from "../channels/lark-send.ts";
import { askUrgency } from "../agents/ask-urgency.ts";
import { staleDays } from "../agents/ask-expiry.ts";
import { saveConfig, type outletSettings } from "../core/config.ts";
import { audit, isOwner } from "../auth/permissions.ts";
import { requireAskAccess } from "../auth/routes.ts";
import { notifiers } from "./process-hooks.ts";
import type { OutletIdentity, OutNotification, Notifier } from "./types.ts";

type Op = "notification" | "ask" | "retract" | "test";
type Delivery = { seq: number; outlet: string; object_id: string; user_id: string; op: Op; state: string; dedup: string; urgency: OutNotification["urgency"]; ref: string | null; attempts: number };
const rank = { silent: -1, later: 0, normal: 1, urgent: 2 };
const settings = (app: App, user: string) => app.config.notify.outlets[user] ?? [];
const kindOf = (a: Ask) => a.handler ? "handler:" + a.handler : a.kind;
const ordinary = (kind: string) => kind === "question" || kind === "suggestion";
type OutletSetting = z.infer<typeof outletSettings>[number];
function permittedAskKinds(app: App, userId: string) {
  const owner = isOwner(app, userId);
  const grants = app.config.notify.outletAskGrants[userId];
  return (outlet: string, kind: string) => owner || ordinary(kind) || !!grants?.[outlet]?.includes(kind);
}
function allowsAsk(app: App, ask: Ask, setting?: OutletSetting) {
  const kind = kindOf(ask);
  return !!setting?.askKinds.includes(kind) && permittedAskKinds(app, ask.userId)(setting.id, kind);
}
const recipient = (app: App, id: string) => ({ id, identities: identitiesOf(app, id).map(i => ({ provider: i.channel, subject: i.external_id })) });
const resolution = z.object({ ok: z.boolean(), hint: z.string().max(500).optional() });
const receipt = z.object({ ref: z.string().min(1).max(500).optional() });

const deliverySignal = (lifetime: AbortSignal) => AbortSignal.any([lifetime, AbortSignal.timeout(DELIVERY_TIMEOUT_MS)]);

async function reach(def: Notifier, user: ReturnType<typeof recipient>, signal: AbortSignal) {
  return def.resolve ? resolution.parse(await def.resolve(structuredClone(user), signal)) : { ok: true };
}
/** Handler-free questions age out after the same staleDays window used by sweepStaleAsks. */
function expiry(app: App, a: Ask) {
  const deadline = one<{ at: string | null; grant: number | null }>(app.db, "select json_extract(context,'$.expiresAt') at, json_extract(context,'$.operationGrant.expiresAt') as 'grant' from asks where id=?", a.id);
  return deadline?.at ?? (deadline?.grant ? new Date(deadline.grant).toISOString() : null) ?? (!a.handler && staleDays(app) ? new Date(Date.parse(a.createdAt) + staleDays(app) * 86400000).toISOString() : null);
}
const live = (ask: Ask, deadline: string | null) => ask.status === "pending" && (!deadline || deadline > now());

function enqueue(app: App, outlet: string, id: string, user: string, op: Op, dedup: string, ref: string | null = null, urgency: OutNotification["urgency"] = "normal", state = "pending") {
  if (op === "notification" && dedup !== id) {
    run(app.db, "update outlet_deliveries set state='skipped' where outlet=? and dedup=? and state='deferred'", outlet, dedup);
  }
  run(app.db, "insert into outlet_deliveries(outlet,object_id,user_id,op,dedup,due,ref,urgency,state) values(?,?,?,?,?,?,?,?,?) on conflict(outlet,object_id,op) do nothing",
    outlet, id, user, op, dedup, Date.now(), ref, urgency, state);
}

export function startNotifierOutlets(app: App) {
  const remove = addNotificationSink((n, source, originalUrgency) => {
    if (source !== app || n.askId) return;
    for (const s of settings(app, n.userId)) {
      if (notifiers.has(s.id) && rank[originalUrgency] >= rank[s.minUrgency]) {
        const deferred = deliveryPlan(app, { ...n, outlet: "plugin" }).when === "later";
        enqueue(app, s.id, n.id, n.userId, "notification", n.dedupKey ?? n.id, null, originalUrgency, deferred ? "deferred" : "pending");
      }
    }
  });
  const show = (a: Ask) => {
    const enabled = settings(app, a.userId).filter(s => notifiers.get(s.id)?.def.ask && allowsAsk(app, a, s));
    if (!enabled.length) return;
    const urgency = askUrgency(app, a);
    for (const s of enabled) {
      if (rank[urgency] >= rank[s.minUrgency]) enqueue(app, s.id, a.id, a.userId, "ask", a.id, null, urgency);
    }
  };
  const close = (a: Ask) => {
    for (const row of all<Delivery>(app.db, "select * from outlet_deliveries where object_id=? and op='ask' and ref is not null", a.id))
      enqueue(app, row.outlet, a.id, a.userId, "retract", a.id, row.ref);
  };
  app.events.on("outlet-ask", show);
  app.events.on("outlet-close", close);
  app.events.once("close", () => {
    remove();
    app.events.off("outlet-ask", show);
    app.events.off("outlet-close", close);
  });
}

function readNotification(app: App, id: string) {
  const r = one<{ item_title: string | null; item_space: string | null; at: string; title: string; body: string; link: string | null; read_at: string | null; context: string }>(app.db,
     `select n.at,n.title,n.body,n.link,n.read_at,n.context,i.title item_title,i.space_id item_space from notifications n
      left join items i on i.id=json_extract(n.context,'$.entityId') and i.user_id=n.user_id where n.id=?`, id);
  return r && { ...json<Partial<Notification>>(r.context, {}), ...r };
}
function larkReachable(app: App, userId: string) {
  if (!larkBotInfo("main")) return false;
  return userId === "owner" ? !!(app.config.lark.ownerOpenId || one(app.db, "select 1 from kv where key='lark_owner_chat' and value!=''")) : !!larkOpenIdOf(app, userId);
}

async function send(app: App, row: Delivery, def: Notifier, signal: AbortSignal) {
  const { outlet, op, object_id: id, user_id: userId } = row;
  signal.throwIfAborted();
  if (op === "retract") {
    if (!def.retract) return;
    await def.retract(row.ref!, signal);
    return { ref: row.ref! };
  }
  const setting = settings(app, userId).find(s => s.id === outlet);
  if ((!setting && op !== "test") || !activeUser(findUser(app, userId))) return;
  const ask = op === "ask" ? getAsk(app, id) : undefined;
  const n = ask ? undefined : readNotification(app, id);
  const urgency = op === "test" ? "urgent" : row.urgency;
  if (setting && rank[urgency] < rank[setting.minUrgency]) return;
  const expiresAt = ask ? expiry(app, ask) : null;
  if (ask && (!def.ask || !allowsAsk(app, ask, setting) || !live(ask, expiresAt))) return;
  if (!ask && (!n || n.read_at || n.quiet)) return;
  const previous = n?.replaces ? one<{ref: string | null}>(app.db,
    "select ref from outlet_deliveries where outlet=? and dedup=? and state='sent' and seq<? order by seq desc limit 1", outlet, row.dedup, row.seq) : undefined;
  if (!previous) {
    if (row.state === "deferred" && n && (n.pushed || Date.now() - Date.parse(n.at) >= 86400000)) return;
    const plan = deliveryPlan(app, { outlet: "plugin", urgency, scheduled: n?.scheduled });
    if (plan.when === "later") return { due: Date.parse(plan.at!) };
  }
  const user = recipient(app, userId);
  const resolved = await reach(def, user, signal);
  if (!resolved.ok) throw new Error(resolved.hint ?? "出口无法送达此人");
  signal.throwIfAborted();
  const current = settings(app, userId).find(s => s.id === outlet);
  if (op !== "test" && (!current || rank[urgency] < rank[current.minUrgency] || (ask && !allowsAsk(app, ask, current)))) return;
  if (!activeUser(findUser(app, userId))) return;
  const currentIdentities = recipient(app, userId).identities;
  if (user.identities.some(i => !currentIdentities.some(bound => bound.provider === i.provider && bound.subject === i.subject))) throw new Error("接收人的绑定身份已变化");
  const content: OutNotification = { user: structuredClone(user), title: ask ? "有问题等你回答" : n!.title, body: ask?.question ?? n!.body,
    link: ask ? webLink(app, "#/ui/" + id) : n?.link ? webLink(app, n.link) : null, urgency, dedupKey: row.dedup };
  if (n?.entityId && n.item_title && n.item_space && canWrite(app, userId, n.item_space)) {
    content.about = { title: n.item_title, link: webLink(app, "#/items/" + encodeURIComponent(n.entityId)) };
  }
  if (ask) {
    if (!live(getAsk(app, id), expiresAt)) return;
    const result = receipt.parse(await def.ask!({ ...content, kind: kindOf(ask), options: ask.options.map(({label}) => ({label})),
      requiresApproval: ask.kind === "approval", allowText: ask.allowText, fields: ask.ui?.fields ?? [], expiresAt: expiresAt ?? null }, signal));
    return { ref: result.ref, identities: user.identities };
  }
  let ref = previous?.ref;
  if (previous) {
    if (!ref || !def.update) return;
    await def.update(ref, content, signal);
  } else ref = receipt.parse(await def.deliver(content, signal)).ref;
  signal.throwIfAborted();
  markPushed(app, id, outlet, ref);
  return { ref };
}
async function attempt(app: App, row: Delivery) {
  const lease = Date.now() + DELIVERY_LEASE_MS;
  if (!run(app.db, "update outlet_deliveries set state='pending',due=? where seq=? and state in ('pending','deferred') and due<=?", lease, row.seq, Date.now()).changes) return;
  try {
    const entry = notifiers.get(row.outlet);
    if (!entry) {
      // Keep the leased retract pending if the outlet unloaded after the queue was read.
      if (row.op !== "retract") run(app.db, "update outlet_deliveries set state='skipped' where seq=?", row.seq);
      return;
    }
    const signal = deliverySignal(entry.lifetime);
    const result = await untilAbort(signal, () => send(app, row, entry.def, signal));
    if (result?.due) {
      run(app.db, "update outlet_deliveries set state='deferred',due=? where seq=?", result.due, row.seq);
      return;
    }
    run(app.db, "update outlet_deliveries set state=?,updated=?,error=null,ref=coalesce(?,ref),identities=? where seq=?",
      result ? "sent" : "skipped", result ? now() : null, result?.ref ?? null, JSON.stringify(result?.identities ?? []), row.seq);
    if (row.op === "ask" && result?.ref && getAsk(app, row.object_id).status !== "pending")
      enqueue(app, row.outlet, row.object_id, row.user_id, "retract", row.dedup, result.ref);
  } catch (error) {
    if (row.op === "retract" && !notifiers.has(row.outlet)) return;
    const failure = retryFailure(row.attempts, error);
    run(app.db, "update outlet_deliveries set state=?,attempts=?,due=?,updated=?,error=? where seq=?",
      failure.state === "pending" ? row.state : failure.state, failure.attempts, failure.due, now(), failure.error, row.seq);
  }
}

export async function drainOutlets(app: App) {
  const rows = all<Delivery>(app.db, `select d.* from outlet_deliveries d where state in ('pending','deferred') and due<=?
    and (op!='retract' or outlet in (select value from json_each(?)))
    and not exists(select 1 from outlet_deliveries p where p.outlet=d.outlet and p.dedup=d.dedup and p.state in ('pending','deferred') and p.seq<d.seq)
    order by due limit 32`, Date.now(), JSON.stringify([...notifiers.keys()]));
  await Promise.all(rows.map(row => row.op === "notification" && row.state === "deferred"
    ? withDeferredPush(app, [row.object_id], () => attempt(app, row))
    : attempt(app, row)));
}

const answer = z.object({
  notifier: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), ref: z.string().min(1).max(500),
  user: z.object({ provider: z.string(), subject: z.string() }), choice: z.number().int().nonnegative().optional(),
  approved: z.boolean().optional(), text: z.string().max(20000).optional(), values: z.record(z.string(), z.unknown()).optional(),
}).strict();
export async function answerFromOutlet(app: App, plugin: string, input: unknown) {
  const a = answer.parse(input);
  const outlet = plugin + ":" + a.notifier;
  const userId = identityOwner(app, a.user.provider, a.user.subject);
  if (!userId || !activeUser(findUser(app, userId)) || !notifiers.get(outlet)?.def.ask) throw new HttpError(403, "出口或身份未获授权");
  const row = one<{ object_id: string; identities: string }>(app.db,
    "select object_id,identities from outlet_deliveries where outlet=? and ref=? and user_id=? and op='ask' and state='sent'", outlet, a.ref, userId);
  if (!row || !json<OutletIdentity[]>(row.identities, []).some(i => i.provider === a.user.provider && i.subject === a.user.subject))
    throw new HttpError(403, "没有向这个身份投递该提问");
  const ask = getAsk(app, row.object_id);
  if (!live(ask, expiry(app, ask))) throw new HttpError(409, "提问已结束或过期");
  if (ask.userId !== userId || !allowsAsk(app, ask, settings(app, userId).find(s => s.id === outlet))) throw new HttpError(403, "这个出口未获准回答此类提问");
  requireAskAccess(app, userId, ask.id);
  if (ask.kind === "approval" && a.approved === undefined) throw new HttpError(400, "审批需要明确批准或拒绝");
  await answerAsk(app, ask.id, { by: userId, choice: a.choice, value: a.values, text: a.text, approved: a.approved });
  audit(app, userId, "notify.answer", ask.id, { outlet });
}

export async function listOutlets(app: App, userId: string) {
  const user = recipient(app, userId);
  const permitted = permittedAskKinds(app, userId);
  const plugins = await Promise.all([...notifiers].map(async ([id, e]) => {
    const signal = deliverySignal(e.lifetime);
    const reachable = await untilAbort(signal, () => reach(e.def, user, signal)).catch(err => ({ ok: false, hint: String(err).slice(0,500) }));
    const history = one<{updated: string; error: string | null}>(app.db,
      "select updated,error from outlet_deliveries where user_id=? and outlet=? and updated is not null order by updated desc limit 1", userId, id);
    const saved = settings(app, userId).find(s => s.id === id);
    const setting = saved ? { ...saved, askKinds: saved.askKinds.filter(kind => permitted(id, kind)) } : null;
    return { id, name: e.def.name, plugin: e.plugin, builtin: false, supportsAsk: !!e.def.ask, reachable,
      setting, lastDelivery: history?.updated ?? null, lastError: history?.error ?? null };
  }));
  const lark = larkReachable(app, userId);
  return [...["web","lark"].map(id => ({ id, name: id === "web" ? "网页" : "飞书", plugin: null, builtin: true, supportsAsk: true,
    reachable: { ok: id === "web" || lark }, setting: null, lastDelivery: one<{at:string}>(app.db,
      "select json_extract(context,'$.pushed.at') at from notifications where user_id=? and json_extract(context,'$.pushed.channel')=? order by json_extract(context,'$.pushed.at') desc limit 1", userId, id)?.at ?? null })), ...plugins];
}

export function setOutlets(app: App, requester: string, body: { userId?: string; outlets: z.infer<typeof outletSettings> }) {
  const userId = body.userId ?? requester;
  if (userId !== requester && !isOwner(app, requester)) throw new HttpError(403, "只能设置自己的通知出口");
  getUser(app, userId);
  const saved = settings(app, userId);
  if (body.outlets.some(s => !notifiers.has(s.id) && !saved.some(old => old.id === s.id))) throw new HttpError(400, "没有这个通知出口");
  const outlets = { ...app.config.notify.outlets, [userId]: body.outlets };
  let outletAskGrants = app.config.notify.outletAskGrants;
  if (isOwner(app, requester)) {
    const grants = Object.fromEntries(body.outlets.map(s => [s.id, s.askKinds.filter(kind => !ordinary(kind))]));
    outletAskGrants = { ...outletAskGrants, [userId]: grants };
  } else {
    const permitted = permittedAskKinds(app, userId);
    if (body.outlets.some(s => s.askKinds.some(kind => !permitted(s.id, kind)))) throw new HttpError(403, "此类提问需要本人为这个出口授权");
  }
  const next = { ...app.config, notify: { ...app.config.notify, outlets, outletAskGrants } };
  saveConfig(next, app.home);
  app.config.notify = next.notify;
  return { outlets: body.outlets };
}

export async function testOutlet(app: App, outlet: string, userId: string) {
  if (!notifiers.has(outlet)) throw new HttpError(404, "没有这个插件出口");
  const n = notify(app, { userId, title: "测试通知", body: "这条通知用来测试你的出口。", urgency: "urgent" }, { push: false });
  enqueue(app, outlet, n.id, userId, "test", n.id);
  const row = one<Delivery>(app.db, "select * from outlet_deliveries where outlet=? and object_id=? and op='test'", outlet, n.id)!;
  await attempt(app, row);
  const result = one<{error:string|null}>(app.db, "select error from outlet_deliveries where seq=?", row.seq);
  if (result?.error) throw new HttpError(502, result.error);
  return { id: n.id };
}
