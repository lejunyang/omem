import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { resolveIdentity, userName, OWNER, getUser } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import type { RuleEvent } from "../rules/types.ts";

/**
 * Feishu document events through omem's bot (docs/v2/rules.md “文档变化”): the bot subscribes to a
 * document (`POST /drive/v1/files/:token/subscribe`) and hears of its edits, multidimensional-table
 * record and field changes; comments that @ the bot or answer it come without subscribing. Each change
 * becomes a rule event (kind `doc`) with what changed, who changed it and whom it @-mentions.
 *
 * - Edits say only that someone edited: the document is read again (a captured one through the usual
 *   import, so its source stays current without the periodic check) and compared with what was there.
 * - Bursts of edits are one change: the event waits until the document has been quiet for a while.
 * - Feishu sends edit and table events only to the document's managers: a bot that is not one gets a
 *   refusal when subscribing, kept with the subscription so the rule page can say what to do.
 */

/** The events the bot handles here (lark-bot.ts registers them, lark-setup.ts checks the app subscribes to them). */
export const DOC_EVENTS = ["drive.file.edit_v1", "drive.file.bitable_record_changed_v1", "drive.file.bitable_field_changed_v1", "drive.notice.comment_add_v1"] as const;
/** What the bot needs for them: subscribing, reading comments, and the edit event itself. */
export const DOC_SCOPES = ["docs:event:subscribe", "docs:event.document_edited:read", "docs:document.comment:read", "base:record:read", "base:field:read", "drive:drive.metadata:readonly"];

const QUIET_MS = 90_000;
const MAX_WAIT_MS = 10 * 60_000;
const SNAPSHOT_MAX = 400_000;
const TEXT_MAX = 4000;

export type DocRef = { token: string; type: string; url: string; nodeToken?: string; title?: string };
type Sub = { file_token: string; file_type: string; link: string; node_token: string | null; title: string; source_id: string | null; space_id: string | null; bot: string; status: "ok" | "failed"; error: string | null; snapshot: string | null; attempted_at: string; subscribed_at: string | null; last_event_at: string | null; polled_at: string | null; modified_ms: number | null };

const PATH = /^\/(docx|docs|doc|sheets|base|wiki|file|slides)\/([A-Za-z0-9]+)/;
const TYPE_OF: Record<string, string> = { docx: "docx", docs: "doc", doc: "doc", sheets: "sheet", base: "bitable", file: "file", slides: "slides" };

function parseLink(link: string) {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new HttpError(400, `不是文档链接：${link}`);
  }
  const m = PATH.exec(u.pathname);
  if (!m) throw new HttpError(400, `只支持飞书文档、电子表格、多维表格和知识库页面的链接：${link}`);
  return { kind: m[1], token: m[2], url: `${u.protocol}//${u.host}/${m[1]}/${m[2]}` };
}

/** A document link → the file Feishu's events name: a knowledge-base page resolves to the document under it. */
export async function docRef(app: App, link: string): Promise<DocRef> {
  const p = parseLink(link);
  if (p.kind !== "wiki") return { token: p.token, type: TYPE_OF[p.kind], url: p.url };
  const known = one<{ obj_token: string; obj_type: string; title: string }>(app.db, "select obj_token, obj_type, title from wiki_nodes where token = ? and obj_token != ''", p.token);
  if (known) return { token: known.obj_token, type: known.obj_type, url: p.url, nodeToken: p.token, title: known.title };
  const { wikiNode } = await import("./lark-wiki.ts");
  const node = await wikiNode(app, p.token);
  if (!node?.objToken) throw new HttpError(400, `读不到这个知识库页面下的文档：${link}`);
  return { token: node.objToken, type: node.objType, url: p.url, nodeToken: p.token, title: node.title };
}

/** Whether a rule's link names this document (its own token, or a knowledge-base page over it). */
export function linkIsDoc(app: App, link: string, token: string) {
  let p: ReturnType<typeof parseLink>;
  try {
    p = parseLink(link);
  } catch {
    return link.trim() === token;
  }
  if (p.token === token) return true;
  if (one(app.db, "select 1 from lark_doc_subscriptions where file_token = ? and (link = ? or node_token = ?)", token, p.url, p.token)) return true;
  return !!one(app.db, "select 1 from wiki_nodes where token = ? and obj_token = ?", p.token, token);
}

/** A Feishu API call as one bot; the error carries Feishu's code. */
async function botCall(ref: string, method: "GET" | "POST", url: string, opts: { data?: unknown; params?: Record<string, unknown> } = {}) {
  const { larkClientFor } = await import("./lark-send.ts");
  let r: { code?: number; msg?: string; data?: any };
  try {
    r = await larkClientFor(ref).request({ method, url, ...opts });
  } catch (e) {
    const body = (e as { response?: { data?: { code?: number; msg?: string } } }).response?.data;
    throw Object.assign(new Error(`${body?.code ?? ""} ${body?.msg ?? (e as Error).message}`.trim()), { code: body?.code });
  }
  if (r?.code) throw Object.assign(new Error(`${r.code} ${r.msg ?? ""}`.trim()), { code: r.code });
  return r?.data ?? {};
}

function explainSubscribe(e: Error & { code?: number }) {
  if (e.code === 1069603 || /forbidden|1069603/i.test(e.message))
    return "机器人不是这篇的管理者：在文档右上角「…」→「添加文档应用」把 omem 的机器人加进来并给可管理权限（编辑和多维表格的变化飞书只发给文档管理者）";
  if (e.code === 1069604) return "文档不存在或已删除";
  if (/99991672|99991679|scope|permission/i.test(e.message)) return `机器人缺少订阅云文档事件的权限（${DOC_SCOPES.join("、")}）：设置 → 渠道 → 机器人权限与事件检查`;
  return e.message;
}

/** Subscribe the bot to one document's changes and keep the outcome (also when it fails). */
export async function subscribeDoc(app: App, ref: DocRef, opts: { sourceId?: string | null; spaceId?: string | null; bot?: string; link?: string } = {}) {
  const bot = opts.bot ?? "main";
  let status: Sub["status"] = "ok";
  let error: string | null = null;
  try {
    await botCall(bot, "POST", `/open-apis/drive/v1/files/${encodeURIComponent(ref.token)}/subscribe`, { params: { file_type: ref.type } });
  } catch (e) {
    status = "failed";
    error = explainSubscribe(e as Error & { code?: number });
  }
  const at = now();
  run(
    app.db,
    `insert into lark_doc_subscriptions(file_token, file_type, link, node_token, title, source_id, space_id, bot, status, error, attempted_at, subscribed_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(file_token) do update set file_type = excluded.file_type, link = case when excluded.link != '' then excluded.link else lark_doc_subscriptions.link end,
       node_token = coalesce(excluded.node_token, lark_doc_subscriptions.node_token), title = case when excluded.title != '' then excluded.title else lark_doc_subscriptions.title end,
       source_id = coalesce(excluded.source_id, lark_doc_subscriptions.source_id), space_id = coalesce(excluded.space_id, lark_doc_subscriptions.space_id), bot = excluded.bot,
       status = excluded.status, error = excluded.error, attempted_at = excluded.attempted_at, subscribed_at = coalesce(excluded.subscribed_at, lark_doc_subscriptions.subscribed_at)`,
    ref.token,
    ref.type,
    opts.link ?? ref.url,
    ref.nodeToken ?? null,
    ref.title ?? "",
    opts.sourceId ?? null,
    opts.spaceId ?? null,
    bot,
    status,
    error,
    at,
    status === "ok" ? at : null,
  );
  return { status, error };
}

/** The documents a rule lists (trigger.docs), subscribed when it is saved; one line each for the rule page. */
export async function subscribeRuleDocs(app: App, links: string[], spaceId?: string | null) {
  const out: { link: string; title: string; ok: boolean; error?: string }[] = [];
  for (const link of links) {
    try {
      const ref = await docRef(app, link);
      const r = await subscribeDoc(app, ref, { link: ref.url, spaceId: spaceId ?? null });
      // A document no source keeps: its text now, so the first edit (by event or by the scheduled check)
      // can already say what changed.
      if (["docx", "doc"].includes(ref.type) && !sourceFor(app, ref.token) && !one(app.db, "select 1 from lark_doc_subscriptions where file_token = ? and snapshot is not null", ref.token)) {
        const { readLarkDocument } = await import("./lark-docs.ts");
        const d = await readLarkDocument(ref.url).catch(() => null);
        if (d) run(app.db, "update lark_doc_subscriptions set snapshot = ?, title = case when ? != '' then ? else title end where file_token = ?", d.markdown.slice(0, SNAPSHOT_MAX), d.title, d.title, ref.token);
      }
      const title = ref.title || one<{ title: string }>(app.db, "select title from lark_doc_subscriptions where file_token = ?", ref.token)?.title || "";
      out.push({ link, title, ok: r.status === "ok", ...(r.error ? { error: r.error } : {}) });
    } catch (e) {
      out.push({ link, title: "", ok: false, error: (e as Error).message });
    }
  }
  return out;
}

/** How the subscriptions stand (the rule page, the bot check). */
export function docSubscriptions(app: App, links?: string[]) {
  const rows = all<Sub>(app.db, "select * from lark_doc_subscriptions order by attempted_at desc limit 500");
  const pick = links?.length ? rows.filter((r) => links.some((l) => linkIsDoc(app, l, r.file_token))) : rows;
  return pick.map((r) => ({ token: r.file_token, type: r.file_type, link: r.link, title: r.title, status: r.status, error: r.error, subscribedAt: r.subscribed_at, lastEventAt: r.last_event_at, sourceId: r.source_id }));
}

/**
 * Captured Feishu documents the bot has not tried yet, a batch at a time (the daily document check):
 * the ones it may subscribe to get their changes by event, and the periodic check leaves them.
 * A failed one is tried again after three days (the owner may have added the bot to it since), after
 * the ones never tried.
 */
export async function subscribeCapturedDocs(app: App, limit = 50) {
  const retryAfter = new Date(Date.now() - 3 * 86400_000).toISOString();
  const rows = all<{ id: string; space_id: string; uri: string; meta: string }>(
    app.db,
    `select s.id, s.space_id, s.uri, s.meta from sources s
     where s.kind = 'doc' and s.deleted_at is null and json_extract(s.meta, '$.via') = 'lark-cli'
       and not exists (select 1 from lark_doc_subscriptions d where d.source_id = s.id and (d.status = 'ok' or d.attempted_at > ?))
     order by exists (select 1 from lark_doc_subscriptions d where d.source_id = s.id), s.updated_at desc limit ?`,
    retryAfter,
    limit,
  );
  let ok = 0;
  for (const r of rows) {
    const m = json<{ url?: string; documentId?: string }>(r.meta, {});
    try {
      const p = parseLink(m.url ?? r.uri);
      // A captured knowledge-base page keeps the document id it read; no need to ask the wiki again.
      const ref: DocRef = m.documentId ? { token: m.documentId, type: "docx", url: p.url, ...(p.kind === "wiki" ? { nodeToken: p.token } : {}) } : await docRef(app, p.url);
      if ((await subscribeDoc(app, ref, { sourceId: r.id, spaceId: r.space_id })).status === "ok") ok++;
    } catch {
      /* Not a link the bot can subscribe to: left for the periodic check. */
    }
  }
  return { tried: rows.length, subscribed: ok };
}

/** Subscribe again to what was refused (the bot may have been made a manager since); the newest first. */
export async function retryFailedSubscriptions(app: App, limit = 100) {
  const rows = all<Sub>(app.db, "select * from lark_doc_subscriptions where status = 'failed' order by attempted_at desc limit ?", limit);
  let ok = 0;
  for (const r of rows) {
    const res = await subscribeDoc(app, { token: r.file_token, type: r.file_type, url: r.link, ...(r.node_token ? { nodeToken: r.node_token } : {}), title: r.title }, { sourceId: r.source_id, spaceId: r.space_id, bot: r.bot });
    if (res.status === "ok") ok++;
  }
  return { tried: rows.length, subscribed: ok };
}

const subOfLink = (app: App, link: string) => {
  let p: ReturnType<typeof parseLink>;
  try {
    p = parseLink(link);
  } catch {
    return undefined;
  }
  return one<Sub>(app.db, "select * from lark_doc_subscriptions where link = ? or node_token = ? or file_token = ? limit 1", p.url, p.token, p.token);
};

let polling = false;
/**
 * The documents enabled rules list that the bot cannot hear about by event (not their manager, or no
 * document event has arrived at all): every `pollMinutes` (default 30) the owner's read-only login asks
 * Feishu for their last edit time, and an edit since the last look is read and handed to the rules like
 * an event. The first look only notes the time. Called every minute (main.ts); returns how many changed.
 */
export async function pollRuleDocs(app: App) {
  if (polling) return 0;
  polling = true;
  try {
    const { listRules } = await import("../rules/store.ts");
    const rules = listRules(app, { enabledOnly: true }).filter((r) => r.trigger.event === "doc" && r.trigger.docs?.length);
    if (!rules.length) return 0;
    const byEvent = docEventsArrive(app);
    const due = new Map<string, Sub>();
    for (const r of rules) {
      for (const link of r.trigger.docs!) {
        // A rule saved without its permission check (by the assistant, say) is subscribed here first.
        if (!subOfLink(app, link)) await subscribeRuleDocs(app, [link], r.spaceId);
        const sub = subOfLink(app, link);
        if (!sub || (sub.status === "ok" && byEvent)) continue;
        if (sub.polled_at && Date.now() - Date.parse(sub.polled_at) < (r.trigger.pollMinutes ?? 30) * 60_000) continue;
        due.set(sub.file_token, sub);
      }
    }
    if (!due.size) return 0;
    const { docMetas } = await import("./lark-docs.ts");
    const metas = await docMetas([...due.values()].map((s) => ({ token: s.file_token, type: s.file_type })));
    let changed = 0;
    for (const s of due.values()) {
      const m = metas.get(s.file_token);
      run(app.db, "update lark_doc_subscriptions set polled_at = ?, modified_ms = coalesce(?, modified_ms) where file_token = ?", now(), m?.modifiedMs ?? null, s.file_token);
      if (!m || s.modified_ms === null || m.modifiedMs <= s.modified_ms) continue;
      changed++;
      // The editor is an open_id of the owner's lark-cli app: a name only when capture has seen them.
      const name = m.modifier ? one<{ name: string }>(app.db, "select name from lark_people where cli_open_id = ? and name != ''", m.modifier)?.name : undefined;
      await flush(app, s.file_token, { type: s.file_type, bot: s.bot, editors: new Set(), names: name ? [name] : [], records: [], fields: [], first: Date.now(), polled: true }).catch((e) =>
        console.warn(`[omem] 处理定时检查到的文档改动失败 ${s.title || s.file_token}：${(e as Error).message}`),
      );
    }
    return changed;
  } finally {
    polling = false;
  }
}

/** Whether document events reach omem at all: one arrived in the last month (the app subscribes to them). */
export function docEventsArrive(app: App) {
  return !!one(app.db, "select 1 from lark_doc_subscriptions where last_event_at > ?", new Date(Date.now() - 30 * 86400_000).toISOString());
}

/** Captured documents whose changes come by event: the periodic update check leaves them (lark-docs.ts). */
export function subscribedSourceIds(app: App) {
  return new Set(all<{ source_id: string }>(app.db, "select source_id from lark_doc_subscriptions where status = 'ok' and source_id is not null").map((r) => r.source_id));
}

// ---- events -----------------------------------------------------------------------------------------

type EventId = string | { open_id?: string; union_id?: string; user_id?: string };
const openIdOf = (id: EventId | undefined) => (typeof id === "string" ? id : id?.open_id) || "";

/** `names`: editors already known by name (a scheduled check); `polled`: found by that check, not an event. */
type Pending = { type: string; bot: string; editors: Set<string>; names?: string[]; records: string[]; fields: string[]; first: number; polled?: boolean; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();

/** One event from the bot's connection (lark-bot.ts). */
export function onDocEvent(app: App, bot: string, type: string, data: any) {
  if (type === "drive.notice.comment_add_v1") return void onComment(app, bot, data).catch((e) => console.warn(`[omem] 处理文档评论失败：${(e as Error).message}`));
  const token = String(data?.file_token ?? "");
  if (!token) return;
  run(app.db, "update lark_doc_subscriptions set last_event_at = ? where file_token = ?", now(), token);
  const p = pending.get(token) ?? { type: String(data.file_type ?? "docx"), bot, editors: new Set<string>(), records: [], fields: [], first: Date.now() };
  for (const id of [...((data.operator_id_list as EventId[] | undefined) ?? []), data.operator_id as EventId | undefined]) {
    const o = openIdOf(id);
    if (o) p.editors.add(o);
  }
  if (type === "drive.file.bitable_record_changed_v1") p.records.push(...recordLines(data));
  if (type === "drive.file.bitable_field_changed_v1") p.fields.push(...fieldLines(data));
  pending.set(token, p);
  clearTimeout(p.timer);
  // A burst of edits is one change: after it has been quiet a while, or at most this long after the first.
  const wait = Math.max(0, Math.min(QUIET_MS, p.first + MAX_WAIT_MS - Date.now()));
  p.timer = setTimeout(() => {
    pending.delete(token);
    void flush(app, token, p).catch((e) => console.warn(`[omem] 处理文档变化失败 ${token}：${(e as Error).message}`));
  }, wait);
  p.timer.unref?.();
}

/** Tests: run what is waiting now. */
export async function flushDocEventsForTests(app: App) {
  const list = [...pending.entries()];
  pending.clear();
  for (const [token, p] of list) {
    clearTimeout(p.timer);
    await flush(app, token, p);
  }
}

const value = (v: unknown) => truncate(typeof v === "string" ? v : JSON.stringify(v ?? ""), 200);
function recordLines(data: any): string[] {
  const out: string[] = [];
  for (const a of (data.action_list ?? []) as { record_id?: string; action?: string; before_value?: { field_id: string; field_value: unknown }[]; after_value?: { field_id: string; field_value: unknown }[] }[]) {
    const before = new Map((a.before_value ?? []).map((f) => [f.field_id, f.field_value]));
    const after = new Map((a.after_value ?? []).map((f) => [f.field_id, f.field_value]));
    const label = a.action === "record_added" ? "新增记录" : a.action === "record_deleted" ? "删除记录" : "修改记录";
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k)))
      .map((k) => `${k}：${before.has(k) ? value(before.get(k)) : "（空）"} → ${after.has(k) ? value(after.get(k)) : "（空）"}`);
    out.push(`${label} ${a.record_id ?? ""}${data.table_id ? `（表 ${data.table_id}）` : ""}${changes.length ? `：${changes.join("；")}` : ""}`);
  }
  return out;
}
function fieldLines(data: any): string[] {
  return ((data.action_list ?? []) as { action?: string; field_id?: string; before_value?: { name?: string }; after_value?: { name?: string } }[]).map((a) => {
    const label = a.action === "field_added" ? "新增字段" : a.action === "field_deleted" ? "删除字段" : "修改字段";
    const name = a.after_value?.name ?? a.before_value?.name ?? a.field_id ?? "";
    return `${label}「${name}」${a.before_value?.name && a.after_value?.name && a.before_value.name !== a.after_value.name ? `（原名「${a.before_value.name}」）` : ""}`;
  });
}

/** Who a bot-side open_id is: a user of omem, someone seen in Feishu, or what the contacts API says. */
async function personOf(app: App, bot: string, openId: string): Promise<{ name: string; email: string | null }> {
  const known = resolveIdentity(app, "lark", openId);
  if (known) return { name: userName(app, known), email: getUser(app, known).email ?? null };
  const seen = one<{ name: string; email: string | null }>(app.db, "select name, email from lark_people where bot_open_id = ? and name != ''", openId);
  if (seen) return seen;
  try {
    const d = await botCall(bot, "GET", `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, { params: { user_id_type: "open_id" } });
    const u = d.user ?? {};
    if (u.name) return { name: String(u.name), email: u.enterprise_email || u.email || null };
  } catch {
    /* The name stays unknown; the id stands in. */
  }
  return { name: openId, email: null };
}

/** Lines in one text and not the other (as many times as they are added), for what an edit changed. */
export function lineDiff(before: string, after: string) {
  const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const count = (list: string[]) => list.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const a = count(lines(before));
  const b = count(lines(after));
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of lines(after)) if ((a.get(l) ?? 0) > 0) a.set(l, a.get(l)! - 1); else added.push(l);
  for (const l of lines(before)) if ((b.get(l) ?? 0) > 0) b.set(l, b.get(l)! - 1); else removed.push(l);
  return { added, removed };
}

/**
 * The people an @ in document markdown names: lark-cli writes them as `<mention-user id="…" …>`
 * (with the name as an attribute or inside the tag); omem's own copies as `<at id="…">name</at>`.
 */
export function mentionsIn(text: string) {
  const out: { id?: string; name?: string }[] = [];
  const re = /<(mention-user|at)\b([^>]*?)(?:\/>|>([^<]*)<\/\1>|>)/g;
  for (const m of text.matchAll(re)) {
    const attr = (k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(m[2])?.[1];
    const id = attr("id") ?? attr("user_id") ?? attr("open_id");
    const name = attr("name") ?? m[3]?.trim();
    if (id || name) out.push({ ...(id ? { id } : {}), ...(name ? { name } : {}) });
  }
  return out;
}

async function whoIsOwner(app: App) {
  const { ownerOpenId } = await import("./lark-personal.ts");
  const { larkOwnerOpenId } = await import("./lark-send.ts");
  const ids = new Set([await ownerOpenId().catch(() => undefined), larkOwnerOpenId(app, "main")].filter((x): x is string => !!x));
  return { ids, name: getUser(app, OWNER).name };
}
function botNames(app: App) {
  return new Set([one<{ value: string }>(app.db, "select value from kv where key = 'lark_bot_name'")?.value, one<{ value: string }>(app.db, "select value from kv where key = 'lark_bot_open_id'")?.value].filter((x): x is string => !!x));
}

type SourceRow = { id: string; space_id: string; uri: string; title: string; text: string; meta: string };

/** The omem copy of a document, when one is captured. */
function sourceFor(app: App, token: string, sub?: Sub) {
  if (sub?.source_id) {
    const s = one<SourceRow>(app.db, "select id, space_id, uri, title, text, meta from sources where id = ? and deleted_at is null", sub.source_id);
    if (s) return s;
  }
  return one<SourceRow>(
    app.db,
    "select id, space_id, uri, title, text, meta from sources where kind = 'doc' and deleted_at is null and (json_extract(meta, '$.documentId') = ? or uri like ?) order by updated_at desc limit 1",
    token,
    `%/${token}`,
  );
}

function locationOf(meta: string) {
  const m = json<{ wikiPath?: string; wikiSpaceName?: string }>(meta, {});
  return m.wikiPath ?? m.wikiSpaceName ?? undefined;
}

/** A burst of changes to one document is over: read what changed and hand it to the rules. */
async function flush(app: App, token: string, p: Pending) {
  const sub = one<Sub>(app.db, "select * from lark_doc_subscriptions where file_token = ?", token);
  const source = sourceFor(app, token, sub);
  const kind = p.records.length ? "record" : p.fields.length ? "field" : "edit";
  let title = source?.title ?? sub?.title ?? "";
  const url = sub?.link || (source ? json<{ url?: string }>(source.meta, {}).url ?? source.uri : "");
  let added: string[] = [];
  let removed: string[] = [];
  if (kind === "edit" && ["docx", "doc", "wiki"].includes(p.type)) {
    if (source) {
      // The captured copy is read again (what the periodic check would have done) and compared.
      const before = source.text;
      const { importLarkDocument } = await import("./lark-docs.ts");
      const r = await importLarkDocument(app, source.space_id, json<{ url?: string }>(source.meta, {}).url ?? source.uri);
      const after = one<SourceRow>(app.db, "select id, space_id, uri, title, text, meta from sources where id = ?", r.id);
      title = after?.title ?? title;
      ({ added, removed } = lineDiff(before, after?.text ?? before));
      if (r.status !== "unchanged" || r.related.length) {
        const { scheduleIngest } = await import("../agents/jobs.ts");
        scheduleIngest(app, source.space_id, [...new Set([r.id, ...r.related])], "飞书文档有改动");
      }
    } else if (sub?.link) {
      // A document only a rule watches: its last text is kept with the subscription.
      const { readLarkDocument } = await import("./lark-docs.ts");
      const d = await readLarkDocument(sub.link);
      title = d.title || title;
      ({ added, removed } = sub.snapshot === null ? { added: [], removed: [] } : lineDiff(sub.snapshot, d.markdown));
      run(app.db, "update lark_doc_subscriptions set snapshot = ?, title = ? where file_token = ?", d.markdown.slice(0, SNAPSHOT_MAX), title, token);
    }
  }
  const editors = [...(await Promise.all([...p.editors].map((id) => personOf(app, p.bot, id)))), ...(p.names ?? []).map((name) => ({ name, email: null }))];
  const owner = await whoIsOwner(app);
  const bots = botNames(app);
  const tags = mentionsIn(added.join("\n"));
  const mentionNames = await Promise.all(tags.map(async (t) => t.name ?? (t.id ? (await personOf(app, p.bot, t.id)).name : "")));
  const text =
    kind === "record" ? p.records.join("\n") :
    kind === "field" ? p.fields.join("\n") :
    [added.length ? `新增：\n${added.join("\n")}` : "", removed.length ? `删掉：\n${removed.join("\n")}` : ""].filter(Boolean).join("\n\n") ||
    (source || sub?.snapshot ? "（格式或图片等改动，文字没有变化）" : sub?.link && ["docx", "doc"].includes(p.type) ? "（内容有改动；之前没有这篇的内容，从下一次改动起能说出改了什么）" : "（内容有改动；这篇没有存在 omem 里，读不到具体改了什么）");
  const e: RuleEvent = {
    key: `doc:${token}:${Date.now()}`,
    kind: "doc",
    at: now(),
    doc: { token, type: p.type, title, url, ...(source ? { location: locationOf(source.meta), space: source.space_id, sourceId: source.id } : sub?.space_id ? { space: sub.space_id } : {}) },
    change: {
      kind,
      text: truncate(p.polled ? `${text}\n（定时检查发现的改动：机器人订阅不了这篇）` : text, TEXT_MAX),
      ...(added.length ? { added: truncate(added.join("\n"), TEXT_MAX) } : {}),
      ...(editors[0] ? { editor: editors.map((x) => x.name).join("、"), editorEmail: editors[0].email } : {}),
      mentions: [...new Set(mentionNames.filter(Boolean))],
      mentionsOwner: tags.some((t) => (t.id && owner.ids.has(t.id)) || (!!t.name && t.name === owner.name)),
      mentionsBot: tags.some((t) => (t.id && bots.has(t.id)) || (!!t.name && bots.has(t.name))),
    },
    via: "doc",
    bot: p.bot,
  };
  const { dispatchRuleEvent } = await import("../rules/engine.ts");
  await dispatchRuleEvent(app, e);
  return e;
}

/**
 * A comment or reply that reached the bot (someone @-mentioned it, or answered it): read the comment and
 * hand it to the rules. No subscription is needed for these; the app must subscribe to the event.
 */
async function onComment(app: App, bot: string, data: any) {
  const meta = data?.notice_meta ?? {};
  const token = String(meta.file_token ?? "");
  const type = String(meta.file_type ?? "docx");
  const commentId = String(data?.comment_id ?? "");
  if (!token || !commentId) return;
  const from = openIdOf(meta.from_user_id);
  const { larkBotInfo } = await import("./lark-send.ts");
  if (from && from === larkBotInfo(bot)?.openId) return;
  let text = "";
  const mentioned: string[] = [];
  try {
    const d = await botCall(bot, "GET", `/open-apis/drive/v1/files/${encodeURIComponent(token)}/comments/${encodeURIComponent(commentId)}`, { params: { file_type: type, user_id_type: "open_id" } });
    const replies = (d.reply_list?.replies ?? []) as { reply_id?: string; content?: { elements?: any[] } }[];
    const reply = replies.find((r) => r.reply_id === data.reply_id) ?? replies.at(-1);
    for (const el of reply?.content?.elements ?? []) {
      if (el.type === "text_run") text += el.text_run?.text ?? "";
      else if (el.type === "docs_link") text += el.docs_link?.url ?? "";
      else if (el.type === "person" && el.person?.user_id) {
        mentioned.push(el.person.user_id);
        text += `@${(await personOf(app, bot, el.person.user_id)).name}`;
      }
    }
    if (d.quote) text = `${text}\n（评论的原文：${truncate(String(d.quote), 300)}）`;
  } catch (e) {
    text = `（读不到评论内容：${(e as Error).message}）`;
  }
  let title = one<{ title: string }>(app.db, "select title from lark_doc_subscriptions where file_token = ?", token)?.title ?? "";
  let url = "";
  try {
    const m = await botCall(bot, "POST", "/open-apis/drive/v1/metas/batch_query", { data: { request_docs: [{ doc_token: token, doc_type: type }], with_url: true } });
    const meta0 = m.metas?.[0];
    title = meta0?.title ?? title;
    url = meta0?.url ?? "";
  } catch {
    /* Title and link stay unknown: the comment still counts. */
  }
  const source = sourceFor(app, token);
  const author = from ? await personOf(app, bot, from) : null;
  const owner = await whoIsOwner(app);
  const names = await Promise.all(mentioned.map(async (id) => (await personOf(app, bot, id)).name));
  const e: RuleEvent = {
    key: `doc-comment:${commentId}:${data.reply_id ?? ""}`,
    kind: "doc",
    at: now(),
    doc: { token, type, title: title || source?.title || "", url: url || (source ? json<{ url?: string }>(source.meta, {}).url ?? source.uri : ""), ...(source ? { location: locationOf(source.meta), space: source.space_id, sourceId: source.id } : {}) },
    change: {
      kind: "comment",
      text: truncate(text.trim(), TEXT_MAX),
      ...(author ? { editor: author.name, editorEmail: author.email } : {}),
      mentions: [...new Set(names)],
      mentionsOwner: mentioned.some((id) => owner.ids.has(id)),
      mentionsBot: !!data.is_mentioned,
      commentId,
    },
    via: "doc",
    bot,
  };
  const { dispatchRuleEvent } = await import("../rules/engine.ts");
  await dispatchRuleEvent(app, e);
}
