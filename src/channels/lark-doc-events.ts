import { createHash } from "node:crypto";
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
      // A spreadsheet's rows now: its first change can already be compared row by row.
      if (ref.type === "sheet" && !one(app.db, "select 1 from lark_doc_subscriptions where file_token = ? and snapshot is not null", ref.token))
        await keepSheetCopy(app, ref.token).catch((e) => console.warn(`[omem] 读表格内容失败 ${link}：${(e as Error).message}`));
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
      await flush(app, s.file_token, { type: s.file_type, bot: s.bot, editors: new Set(), names: name ? [name] : [], polledIds: m.modifier ? [m.modifier] : [], records: new Map(), fields: [], first: Date.now(), polled: true }).catch((e) =>
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

/**
 * One record of a multidimensional table, as changed within a burst: Feishu may send a record several
 * times while someone types (and several records in one event); each record becomes its own rule event.
 * `before` keeps the first value seen in the burst, `after` the last; `heard` is when it was first heard.
 */
type RecordChange = { tableId: string; recordId: string; action: "added" | "edited" | "deleted"; before: Map<string, CellValue>; after: Map<string, CellValue>; editors: Set<string>; heard: number; revision?: number };
/** A cell as the event gives it: the raw value, and the names of people when Feishu adds them. */
export type CellValue = { value: unknown; users?: string[] };

/** `names`: editors already known by name (a scheduled check); `polled`: found by that check, not an event. */
type Pending = { type: string; bot: string; editors: Set<string>; names?: string[]; polledIds?: string[]; records: Map<string, RecordChange>; fields: string[]; first: number; polled?: boolean; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();

/** One event from the bot's connection (lark-bot.ts). */
export function onDocEvent(app: App, bot: string, type: string, data: any) {
  if (type === "drive.notice.comment_add_v1") return void onComment(app, bot, data).catch((e) => console.warn(`[omem] 处理文档评论失败：${(e as Error).message}`));
  const token = String(data?.file_token ?? "");
  if (!token) return;
  run(app.db, "update lark_doc_subscriptions set last_event_at = ? where file_token = ?", now(), token);
  const p: Pending = pending.get(token) ?? { type: String(data.file_type ?? "docx"), bot, editors: new Set<string>(), records: new Map(), fields: [], first: Date.now() };
  const operators: string[] = [];
  for (const id of [...((data.operator_id_list as EventId[] | undefined) ?? []), data.operator_id as EventId | undefined]) {
    const o = openIdOf(id);
    if (o) operators.push(o);
  }
  // A record's editor is who changed that record, not everyone who touched the table in the burst.
  if (type === "drive.file.bitable_record_changed_v1") addRecords(p, data, operators);
  else for (const o of operators) p.editors.add(o);
  if (type === "drive.file.bitable_field_changed_v1") {
    p.fields.push(...fieldLines(data));
    // The table's fields changed: read its field names again next time.
    fieldSchemas.delete(`${token}:${data.table_id ?? ""}`);
  }
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

const ACTION: Record<string, RecordChange["action"]> = { record_added: "added", record_deleted: "deleted", record_edited: "edited" };
type RawCell = { field_id: string; field_value: unknown; field_identity_value?: { users?: { name?: string; en_name?: string }[] } };
const cells = (list: RawCell[] | undefined) =>
  new Map(
    (list ?? []).map((f) => {
      const users = (f.field_identity_value?.users ?? []).map((u) => u.name || u.en_name || "").filter(Boolean);
      return [f.field_id, { value: f.field_value, ...(users.length ? { users } : {}) }] as const;
    }),
  );

/** The records of one record-changed event, merged with what the burst already has for each. */
function addRecords(p: Pending, data: any, operators: string[]) {
  const tableId = String(data.table_id ?? "");
  const revision = Number(data.revision) || undefined;
  for (const a of (data.action_list ?? []) as { record_id?: string; action?: string; before_value?: RawCell[]; after_value?: RawCell[] }[]) {
    const recordId = String(a.record_id ?? "");
    const action = ACTION[a.action ?? ""] ?? "edited";
    const key = `${tableId}:${recordId}`;
    const was = p.records.get(key);
    if (!was) {
      p.records.set(key, { tableId, recordId, action, before: cells(a.before_value), after: cells(a.after_value), editors: new Set(operators), heard: Date.now(), revision });
      continue;
    }
    // Added and then edited in the same burst is still a new record; deleted at any point is gone.
    if (action === "deleted") was.action = "deleted";
    for (const [k, v] of cells(a.before_value)) if (!was.before.has(k)) was.before.set(k, v);
    for (const [k, v] of cells(a.after_value)) was.after.set(k, v);
    for (const o of operators) was.editors.add(o);
    if (revision && (!was.revision || revision > was.revision)) was.revision = revision;
  }
}

/**
 * A spreadsheet changed: compare its rows with the last copy and make one event per new or changed row
 * (`doc:<token>:<sheet>:<hash of the row>`: the same row text fires once). The first time there is no
 * copy yet, so this one becomes the copy and nothing fires; so does a sheet whose header row changed.
 * A change that leaves every row as it was (formatting, say) fires nothing. null: unreadable.
 */
async function sheetRowEvents(app: App, token: string, p: Pending, sub: Sub, source: SourceRow | undefined, ownerId: (id: string) => boolean): Promise<RuleEvent[] | null> {
  const before = json<SheetsCopy | null>(sub.snapshot ?? "null", null);
  const after = await keepSheetCopy(app, token);
  if (!before?.sheets) return [];
  const editors = [...(await Promise.all([...p.editors].map((id) => personOf(app, p.bot, id)))), ...(p.names ?? []).map((name) => ({ name, email: null }))];
  const ids = [...p.editors, ...(p.polledIds ?? [])];
  const byOwner = ids.length ? ids.every(ownerId) : undefined;
  const doc: NonNullable<RuleEvent["doc"]> = { token, type: p.type, title: source?.title ?? sub.title ?? "", url: sub.link || (source ? json<{ url?: string }>(source.meta, {}).url ?? source.uri : ""), ...(source ? { location: locationOf(source.meta), space: source.space_id, sourceId: source.id } : sub.space_id ? { space: sub.space_id } : {}) };
  const out: RuleEvent[] = [];
  for (const [id, now_] of Object.entries(after.sheets)) {
    const was = before.sheets[id];
    if (!was || was.header !== now_.header) continue;
    for (const c of rowChanges(was.rows, now_.rows)) {
      const notes = [now_.more ? `（这个工作表只比对了前 ${now_.rows.length} 行）` : "", p.polled ? "（定时检查发现的改动：机器人订阅不了这篇）" : ""].filter(Boolean).join("");
      out.push({
        key: `doc:${token}:${id}:${createHash("sha1").update(c.text).digest("hex").slice(0, 16)}`,
        kind: "doc",
        at: now(),
        doc,
        change: {
          kind: "edit",
          text: truncate(`${c.action === "added" ? "新增" : "改动"}「${now_.title}」第 ${c.row} 行：${c.text}${notes}`, TEXT_MAX),
          added: c.text,
          action: c.action,
          row: c.row,
          sheet: now_.title,
          ...(editors[0] ? { editor: editors.map((x) => x.name).join("、"), editorEmail: editors[0].email } : {}),
          ...(p.editors.size ? { editorId: [...p.editors][0] } : {}),
          mentions: [],
          mentionsOwner: false,
          mentionsBot: false,
          heardAt: new Date(p.first).toISOString(),
          ...(byOwner === undefined ? {} : { byOwner }),
        },
        via: "doc",
        bot: p.bot,
      });
    }
  }
  return out;
}

// ---- table fields: names, and values as a person reads them ---------------------------------------------

/** A field of a multidimensional table: its name, type (Feishu's number) and the options of a choice field. */
type FieldInfo = { name: string; type: number; options: Map<string, string> };
const FIELD_TTL_MS = 3600_000;
const fieldSchemas = new Map<string, { at: number; fields: Map<string, FieldInfo> | null }>();
/** Tests: forget the field tables read so far. */
export function clearFieldSchemasForTests() {
  fieldSchemas.clear();
}

/**
 * The fields of one table, read as the bot once and kept an hour (or until the table's fields change):
 * record events name fields by id only. Unreadable (no permission, say): null, and the ids stay.
 */
async function tableFields(bot: string, appToken: string, tableId: string): Promise<Map<string, FieldInfo> | null> {
  const key = `${appToken}:${tableId}`;
  const c = fieldSchemas.get(key);
  if (c && Date.now() - c.at < FIELD_TTL_MS) return c.fields;
  let fields: Map<string, FieldInfo> | null = new Map();
  try {
    let pageToken: string | undefined;
    for (let i = 0; i < 10; i++) {
      const d = await botCall(bot, "GET", `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`, { params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } });
      for (const f of (d.items ?? []) as { field_id?: string; field_name?: string; type?: number; property?: { options?: { id?: string; name?: string }[] } | null }[]) {
        if (!f.field_id) continue;
        const options = new Map((f.property?.options ?? []).filter((o) => o.id).map((o) => [o.id!, o.name ?? o.id!] as const));
        fields.set(f.field_id, { name: f.field_name || f.field_id, type: Number(f.type) || 0, options });
      }
      if (!d.has_more || !d.page_token) break;
      pageToken = d.page_token;
    }
  } catch {
    fields = null;
  }
  fieldSchemas.set(key, { at: Date.now(), fields });
  return fields;
}

/** Feishu's field types whose numbers are times: date, created time, modified time. */
const TIME_TYPES = new Set([5, 1001, 1002]);
/** Values often come as JSON in a string. */
const parsed = (raw: unknown) => {
  if (typeof raw !== "string") return raw;
  if (!/^\s*[[{"]/.test(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * A cell as a person reads it: text, numbers, single and multiple choices (option names when the
 * table's fields were read), people, dates, links, attachments. Anything else stays short JSON.
 */
export function cellText(cell: CellValue | undefined, f?: FieldInfo, timeZone?: string): string {
  if (!cell) return "（空）";
  if (cell.users?.length) return truncate(cell.users.join("、"), 200);
  const v = parsed(cell.value);
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "（空）";
  const show = (x: unknown): string => {
    if (typeof x === "string") return f && TIME_TYPES.has(f.type) && /^\d{9,}$/.test(x) ? timeText(Number(x), timeZone) : (f?.options.get(x) ?? x);
    if (typeof x === "number") return f && TIME_TYPES.has(f.type) ? timeText(x, timeZone) : String(x);
    if (typeof x === "boolean") return x ? "是" : "否";
    if (!x || typeof x !== "object") return JSON.stringify(x ?? "");
    const o = x as Record<string, any>;
    if (typeof o.link === "string") return o.text && o.text !== o.link ? `${o.text}（${o.link}）` : o.link;
    if (typeof o.text === "string") return o.text;
    if (typeof o.name === "string" && o.name) return o.name;
    if (typeof o.en_name === "string" && o.en_name) return o.en_name;
    const ids = o.link_record_ids ?? o.record_ids;
    if (Array.isArray(ids)) return ids.join("、");
    if (Array.isArray(o.users)) return o.users.map((u: any) => u?.name || u?.en_name || u?.id || "").filter(Boolean).join("、");
    return JSON.stringify(o);
  };
  if (!Array.isArray(v)) return truncate(show(v), 200);
  // Rich text comes as segments (text, @, link) read in a row; choices, people and files as a list.
  const segments = v.every((x) => !!x && typeof x === "object" && typeof (x as any).type === "string" && ("text" in (x as any) || "link" in (x as any)));
  return truncate(v.map(show).join(segments ? "" : "、"), 200);
}

function timeText(n: number, timeZone?: string) {
  const ms = n < 1e12 ? n * 1000 : n;
  try {
    const s = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
    return s.endsWith(" 00:00") ? s.slice(0, -6) : s;
  } catch {
    return new Date(ms).toISOString();
  }
}

const ACTION_LABEL: Record<RecordChange["action"], string> = { added: "新增记录", edited: "修改记录", deleted: "删除记录" };
/** What one record's change says: which fields went from what to what, by name where the table was read. */
async function recordText(app: App, bot: string, token: string, r: RecordChange) {
  const fields = r.tableId ? await tableFields(bot, token, r.tableId) : null;
  const tz = app.config.timezone;
  const same = (a?: CellValue, b?: CellValue) => JSON.stringify(a?.value) === JSON.stringify(b?.value) && JSON.stringify(a?.users) === JSON.stringify(b?.users);
  const changes = [...new Set([...r.before.keys(), ...r.after.keys()])]
    .filter((k) => !same(r.before.get(k), r.after.get(k)))
    .map((k) => {
      const f = fields?.get(k);
      const name = f?.name ?? k;
      if (r.action === "added") return `${name}：${cellText(r.after.get(k), f, tz)}`;
      if (r.action === "deleted") return `${name}：${cellText(r.before.get(k), f, tz)}`;
      return `${name}：${cellText(r.before.get(k), f, tz)} → ${cellText(r.after.get(k), f, tz)}`;
    });
  return `${ACTION_LABEL[r.action]} ${r.recordId}${r.tableId ? `（表 ${r.tableId}）` : ""}${changes.length ? `：${changes.join("；")}` : ""}`;
}
// ---- spreadsheets: rows compared with the last copy --------------------------------------------------------

/**
 * A spreadsheet's edit event only says someone edited it. Its worksheets are kept with the subscription
 * (`snapshot`, JSON) as one line per row — “column: value；…” with the header row's names, blank rows
 * kept empty so a line's place is its row — and compared line by line (lineDiff, as for documents).
 * Big sheets keep their first rows only, within these limits; the rest is not compared.
 */
const SHEET_ROWS_MAX = 2000;
const SHEETS_MAX = 20;
const ROW_CHARS_MAX = 1000;
type SheetCopy = { title: string; header: string; rows: string[]; more?: boolean };
type SheetsCopy = { sheets: Record<string, SheetCopy> };

/** One data row as text: the header's names for its cells, empty cells left out; a blank row is "". */
export function rowText(header: string[], row: string[]) {
  const width = Math.max(header.length, row.length);
  const parts: string[] = [];
  for (let i = 0; i < width; i++) {
    const v = (row[i] ?? "").replace(/\s+/g, " ").trim();
    if (!v) continue;
    const h = (header[i] ?? "").replace(/\s+/g, " ").trim() || `第 ${i + 1} 列`;
    parts.push(`${h}：${v}`);
  }
  return truncate(parts.join("；"), ROW_CHARS_MAX);
}

/** All worksheets of a spreadsheet as rows, read with the owner's lark-cli like a document is. */
async function readSheets(token: string): Promise<SheetsCopy> {
  const { larkCli } = await import("./lark-cli.ts");
  const { csvRows, sheetCsv } = await import("./lark-docs.ts");
  const v = await larkCli(["api", "GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(token)}/sheets/query`, "--as", "user"], 30_000);
  const list = ((v?.data ?? v)?.sheets ?? []) as { sheet_id?: string; title?: string; resource_type?: string }[];
  const out: SheetsCopy = { sheets: {} };
  let budget = SNAPSHOT_MAX;
  for (const s of list.filter((x) => x.sheet_id && (!x.resource_type || x.resource_type === "sheet")).slice(0, SHEETS_MAX)) {
    const all = csvRows(await sheetCsv(token, s.sheet_id!), true);
    const header = all[0] ?? [];
    const rows: string[] = [];
    let more = all.length - 1 > SHEET_ROWS_MAX;
    for (const r of all.slice(1, SHEET_ROWS_MAX + 1)) {
      const line = rowText(header, r);
      if (budget - line.length < 0) {
        more = true;
        break;
      }
      budget -= line.length + 4;
      rows.push(line);
    }
    out.sheets[s.sheet_id!] = { title: s.title ?? s.sheet_id!, header: header.join("	"), rows, ...(more ? { more } : {}) };
  }
  return out;
}

/** Keep a spreadsheet's rows as the copy the next edit is compared with. */
async function keepSheetCopy(app: App, token: string) {
  const copy = await readSheets(token);
  run(app.db, "update lark_doc_subscriptions set snapshot = ? where file_token = ?", JSON.stringify(copy), token);
  return copy;
}

/**
 * The rows that differ from the last copy: a line the last copy did not have. One whose row held other
 * text that is gone now is `edited`; otherwise (inserted, or moved into a blank row) `added`.
 */
export function rowChanges(before: string[], after: string[]) {
  const { added, removed } = lineDiff(before.join("\n"), after.join("\n"));
  const count = (list: string[]) => list.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
  const fresh = count(added);
  const gone = count(removed);
  const out: { row: number; text: string; action: "added" | "edited" }[] = [];
  after.forEach((line, i) => {
    const t = line.trim();
    if (!t || !(fresh.get(t) ?? 0)) return;
    fresh.set(t, fresh.get(t)! - 1);
    const was = before[i]?.trim();
    const edited = !!was && was !== t && (gone.get(was) ?? 0) > 0;
    if (edited) gone.set(was, gone.get(was)! - 1);
    // Row 1 is the header: data row i is row i + 2.
    out.push({ row: i + 2, text: t, action: edited ? "edited" : "added" });
  });
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
    if (u.name) {
      const email = u.enterprise_email || u.email || null;
      // Kept as someone the main bot knows by this id, so an agent can @ the editor (lark_send mentions).
      if (bot === "main") {
        const { rememberPerson } = await import("./lark-people.ts");
        rememberPerson(app, { name: String(u.name), email, botOpenId: openId, userId: u.user_id ? String(u.user_id) : null });
      }
      return { name: String(u.name), email };
    }
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

/**
 * A burst of changes to one document is over: read what changed and hand it to the rules. A
 * multidimensional table's records go one event each (`doc:<token>:<table>:<record>:<action>`, an edit
 * also keyed by its revision or burst so a later edit fires again; an added record fires once), field
 * changes as one more; any other document is one event for the burst.
 */
async function flush(app: App, token: string, p: Pending): Promise<RuleEvent[]> {
  const sub = one<Sub>(app.db, "select * from lark_doc_subscriptions where file_token = ?", token);
  const source = sourceFor(app, token, sub);
  const owner = await whoIsOwner(app);
  const ownerId = (id: string) => owner.ids.has(id) || resolveIdentity(app, "lark", id) === OWNER;
  const { dispatchRuleEvent } = await import("../rules/engine.ts");
  if (p.records.size || p.fields.length) {
    const doc: NonNullable<RuleEvent["doc"]> = { token, type: p.type, title: source?.title ?? sub?.title ?? "", url: sub?.link || (source ? json<{ url?: string }>(source.meta, {}).url ?? source.uri : ""), ...(source ? { location: locationOf(source.meta), space: source.space_id, sourceId: source.id } : sub?.space_id ? { space: sub.space_id } : {}) };
    const events: RuleEvent[] = [];
    for (const r of p.records.values()) {
      const editors = await Promise.all([...r.editors].map((id) => personOf(app, p.bot, id)));
      events.push({
        key: `doc:${token}:${r.tableId}:${r.recordId}:${r.action}${r.action === "edited" ? `:${r.revision ?? r.heard}` : ""}`,
        kind: "doc",
        at: now(),
        doc,
        change: {
          kind: "record",
          text: truncate(await recordText(app, p.bot, token, r), TEXT_MAX),
          recordId: r.recordId,
          tableId: r.tableId,
          action: r.action,
          ...(editors[0] ? { editor: editors[0].name, editorEmail: editors[0].email } : {}),
          mentions: [],
          mentionsOwner: false,
          mentionsBot: false,
          heardAt: new Date(r.heard).toISOString(),
          ...(r.editors.size ? { editorId: [...r.editors][0], byOwner: [...r.editors].every(ownerId) } : {}),
        },
        via: "doc",
        bot: p.bot,
      });
    }
    if (p.fields.length) {
      const editors = await Promise.all([...p.editors].map((id) => personOf(app, p.bot, id)));
      events.push({
        key: `doc:${token}:fields:${p.first}`,
        kind: "doc",
        at: now(),
        doc,
        change: { kind: "field", text: truncate(p.fields.join("\n"), TEXT_MAX), ...(editors[0] ? { editor: editors.map((x) => x.name).join("、"), editorEmail: editors[0].email } : {}), mentions: [], mentionsOwner: false, mentionsBot: false, heardAt: new Date(p.first).toISOString(), ...(p.editors.size ? { editorId: [...p.editors][0], byOwner: [...p.editors].every(ownerId) } : {}) },
        via: "doc",
        bot: p.bot,
      });
    }
    for (const e of events) await dispatchRuleEvent(app, e);
    return events;
  }
  if (p.type === "sheet" && sub) {
    const rows = await sheetRowEvents(app, token, p, sub, source, ownerId).catch((err) => {
      console.warn(`[omem] 读表格内容失败 ${sub.title || token}：${(err as Error).message}`);
      return null;
    });
    if (rows) {
      for (const e of rows) await dispatchRuleEvent(app, e);
      return rows;
    }
  }
  let title = source?.title ?? sub?.title ?? "";
  const url = sub?.link || (source ? json<{ url?: string }>(source.meta, {}).url ?? source.uri : "");
  let added: string[] = [];
  let removed: string[] = [];
  if (["docx", "doc", "wiki"].includes(p.type)) {
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
  const bots = botNames(app);
  const tags = mentionsIn(added.join("\n"));
  const mentionNames = await Promise.all(tags.map(async (t) => t.name ?? (t.id ? (await personOf(app, p.bot, t.id)).name : "")));
  const text =
    [added.length ? `新增：\n${added.join("\n")}` : "", removed.length ? `删掉：\n${removed.join("\n")}` : ""].filter(Boolean).join("\n\n") ||
    // Spreadsheets and tables are not read here, captured or not: only that they changed is known.
    (["sheet", "bitable"].includes(p.type) ? "（表格有改动，不比对单元格内容）" :
    source || sub?.snapshot ? "（格式或图片等改动，文字没有变化）" : sub?.link && ["docx", "doc"].includes(p.type) ? "（内容有改动；之前没有这篇的内容，从下一次改动起能说出改了什么）" : "（内容有改动；这篇没有存在 omem 里，读不到具体改了什么）");
  const e: RuleEvent = {
    key: `doc:${token}:${Date.now()}`,
    kind: "doc",
    at: now(),
    doc: { token, type: p.type, title, url, ...(source ? { location: locationOf(source.meta), space: source.space_id, sourceId: source.id } : sub?.space_id ? { space: sub.space_id } : {}) },
    change: {
      kind: "edit",
      text: truncate(p.polled ? `${text}\n（定时检查发现的改动：机器人订阅不了这篇）` : text, TEXT_MAX),
      ...(added.length ? { added: truncate(added.join("\n"), TEXT_MAX) } : {}),
      ...(editors[0] ? { editor: editors.map((x) => x.name).join("、"), editorEmail: editors[0].email } : {}),
      mentions: [...new Set(mentionNames.filter(Boolean))],
      mentionsOwner: tags.some((t) => (t.id && owner.ids.has(t.id)) || (!!t.name && t.name === owner.name)),
      mentionsBot: tags.some((t) => (t.id && bots.has(t.id)) || (!!t.name && bots.has(t.name))),
      heardAt: new Date(p.first).toISOString(),
      ...(p.editors.size ? { editorId: [...p.editors][0] } : {}),
      ...(p.editors.size || p.polledIds?.length ? { byOwner: [...p.editors, ...(p.polledIds ?? [])].every(ownerId) } : {}),
    },
    via: "doc",
    bot: p.bot,
  };
  await dispatchRuleEvent(app, e);
  return [e];
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
      ...(author ? { editor: author.name, editorEmail: author.email, editorId: from, byOwner: owner.ids.has(from) || resolveIdentity(app, "lark", from) === OWNER } : {}),
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
