import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { json } from "../core/util.ts";
import { importFile, keepOriginal } from "../sources/import.ts";
import { findSourceByUri, sourceText, upsertSource, type UpsertResult } from "../sources/store.ts";
import { larkCli } from "./lark-cli.ts";
import { cliIdsIn, learnCliPeople, peopleByCliIds } from "./lark-people.ts";

/**
 * Feishu messages as structured rows (`lark_messages`) next to the chat source text.
 *
 * The chat source stays one line per message — that is what search, citations
 * (`src:<id>#L12`) and agents read. The rows keep what a line cannot: the raw
 * rendered content with its line breaks, which message it replies to, the
 * images and files it carries, reactions, and who sent it. The web renders a
 * chat from them, and the line format gains a short quote of the replied-to
 * message so agents see the context too.
 */
export type LarkResource = { message_id?: string; key: string; type?: string; local_path?: string; size_bytes?: number; error?: boolean };
export type LarkMessage = {
  message_id: string;
  chat_id?: string;
  chat_name?: string;
  msg_type: string;
  content: unknown;
  raw_content?: string;
  create_time: string;
  sender?: { id?: string; id_type?: string; sender_type?: string; name?: string };
  deleted?: boolean;
  thread_id?: string;
  /** lark-cli's quoted-reply target (a message id); the raw API calls it `parent_id`. */
  reply_to?: string;
  parent_id?: string;
  upper_message_id?: string;
  root_id?: string;
  mentions?: { id?: string | { open_id?: string }; name?: string }[];
  thread_replies?: LarkMessage[];
  resources?: LarkResource[];
  reactions?: unknown;
  thread_has_more?: boolean;
  /** Set on replies that came nested under their thread host. */
  nested?: boolean;
  /** Set on a thread host whose replies all came nested with it. */
  expanded?: boolean;
};

export const timeMs = (t: string) => (/^\d+$/.test(t) ? Number(t) : Date.parse(t));
export const fmtTime = (t: string | number) => {
  const ms = typeof t === "number" ? t : timeMs(t);
  return Number.isNaN(ms) ? String(t) : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
};

/** lark-cli renders content as readable text (Markdown with a few tags); older JSON bodies are still handled. */
export function messageText(m: Pick<LarkMessage, "content" | "msg_type">): string {
  const c = m.content;
  if (typeof c === "string") {
    if (!/^\s*\{/.test(c)) return c;
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed?.text === "string") return parsed.text;
      if (parsed?.file_name) return `[文件] ${parsed.file_name}`;
      if (parsed?.image_key) return `![Image](${parsed.image_key})`;
      if (parsed?.title || parsed?.content)
        return [parsed.title, ...(Array.isArray(parsed.content) ? parsed.content : []).map((line: { text?: string; href?: string }[]) => (Array.isArray(line) ? line.map((n) => n.text ?? n.href ?? "").join("") : "")).filter(Boolean)]
          .filter(Boolean)
          .join("\n");
    } catch {}
    return c;
  }
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    return JSON.stringify(c);
  }
  return `[${m.msg_type}]`;
}

/** Replies auto-expanded under their thread host become messages of their own, once each. */
export function flattenReplies(messages: LarkMessage[]): LarkMessage[] {
  const out = new Map<string, LarkMessage>();
  for (const m of messages) {
    const { thread_replies, ...host } = m;
    if (!out.has(host.message_id)) out.set(host.message_id, { ...host, expanded: Array.isArray(thread_replies) && !m.thread_has_more });
    for (const r of thread_replies ?? []) if (!out.has(r.message_id)) out.set(r.message_id, { ...r, thread_id: r.thread_id ?? m.thread_id, nested: true });
  }
  return [...out.values()];
}

export const isApp = (m: LarkMessage) => m.sender?.sender_type === "app" || m.sender?.id_type === "app_id" || /^cli_/.test(m.sender?.id ?? "");
export const mentionIds = (m: LarkMessage) => (m.mentions ?? []).map((x) => (typeof x.id === "string" ? x.id : (x.id?.open_id ?? ""))).filter(Boolean);
export const parentOf = (m: LarkMessage) => {
  const p = m.reply_to || m.parent_id || m.upper_message_id || "";
  // In a topic every reply's parent is the root; that is the thread, not a quote.
  return p && p !== m.root_id ? p : p && !m.thread_id ? p : "";
};
function senderKind(m: LarkMessage, owner?: string) {
  if (m.msg_type === "system") return "system";
  if (owner && m.sender?.id === owner) return "owner";
  return isApp(m) ? "app" : "user";
}
const oneLine = (s: string) => s.replace(/\r?\n/g, " ⏎ ");
/** `@名字(ou_…)` as lark-cli renders mentions in cards → `@名字`: the id is lark-cli's own, useless elsewhere. */
export const withoutOpenIds = (s: string) => s.replace(MENTION_WITH_ID, "@$1");
/** `@名字(ou_…)`; names may have spaces and brackets ("@Deng Zhou (周灯)(ou_…)"). */
export const MENTION_WITH_ID = /@([^@\n]{1,60}?)\((ou_[0-9a-f]{32})\)/g;
const plain = (s: string) =>
  s
    .replace(/<at [^>]*>([^<]*)<\/at>/g, "@$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/<card title="([^"]*)">/g, "[卡片] $1 ")
    .replace(/<\/?[a-z_]+[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

type Quoted = { sender: string; text: string };

/** One line of the chat source: time, topic, sender, quote, text, resources, message id. */
export function formatLine(m: LarkMessage, opts: { owner?: string; quoted?: Quoted | null; resources?: Record<string, ResourceRef> }) {
  const who = `${m.sender?.name ?? m.sender?.id ?? (m.msg_type === "system" ? "系统" : "?")}${opts.owner && m.sender?.id === opts.owner ? "（本人）" : isApp(m) ? "（机器人）" : ""}`;
  const quote = opts.quoted ? ` ↩ 回复 ${opts.quoted.sender}「${plain(withoutOpenIds(opts.quoted.text)).slice(0, 40)}」` : "";
  const files = Object.values(opts.resources ?? {})
    .filter((r) => r.sourceId)
    .map((r) => ` → src:${r.sourceId}`)
    .join("");
  return `[${fmtTime(m.create_time)}${m.thread_id ? ` · 话题 ${m.thread_id}` : ""}] ${who}${quote}: ${oneLine(withoutOpenIds(messageText(m)))}${files} (${m.message_id})`;
}

// ---- resources -------------------------------------------------------------------

export type ResourceRef = { type: string; sourceId?: string; file?: string; name?: string };

const MAGIC: [string, number[]][] = [
  [".png", [0x89, 0x50, 0x4e, 0x47]],
  [".jpg", [0xff, 0xd8, 0xff]],
  [".gif", [0x47, 0x49, 0x46, 0x38]],
  [".webp", [0x52, 0x49, 0x46, 0x46]],
  [".pdf", [0x25, 0x50, 0x44, 0x46]],
];
/** Downloaded resources often have no extension; give images and PDFs one so they import. */
export function withExtension(path: string) {
  if (extname(path)) return path;
  const head = readFileSync(path).subarray(0, 8);
  const ext = MAGIC.find(([, sig]) => sig.every((b, i) => head[i] === b))?.[0];
  if (!ext) return path;
  renameSync(path, path + ext);
  return path + ext;
}

/**
 * Downloaded resources (lark-cli `--download-resources`, files under `cwd`): kept as originals.
 * When the batch will be understood by the ingest role they also become sources, so the agent
 * can look at them; otherwise they are only files the chat view shows.
 */
export async function keepResources(app: App, spaceId: string, chatId: string, messages: LarkMessage[], cwd: string, asSources: boolean, strict = false) {
  const byMessage = new Map<string, Record<string, ResourceRef>>();
  for (const m of messages) {
    for (const r of m.resources ?? []) {
      if (r.error || !r.local_path || !r.key) { if (strict) throw new Error(`附件下载未完成（${m.message_id}）`); continue; }
      const path = existsSync(r.local_path) ? r.local_path : join(cwd, r.local_path);
      if (!existsSync(path)) { if (strict) throw new Error(`附件文件缺失（${m.message_id}）`); continue; }
      const refs = byMessage.get(m.message_id) ?? {};
      try {
        const file = withExtension(path);
        const name = new RegExp(`<(?:file|video|audio) key="${r.key.replace(/[^\w-]/g, "")}"[^>]*?name="([^"]*)"`).exec(messageText(m))?.[1];
        const ref: ResourceRef = { type: r.type ?? "file", name };
        if (asSources) {
          const imported = await importFile(app, spaceId, file, `lark:${chatId}/${name ?? basename(file)}`);
          if (imported) ref.sourceId = imported.id;
        }
        ref.file = keepOriginal(app, file);
        refs[r.key] = ref;
      } catch (e) {
        if (strict) throw e;
        console.warn(`[omem] 保存飞书附件失败（${m.message_id}/${r.key}）：${(e as Error).message}`);
      }
      byMessage.set(m.message_id, refs);
    }
  }
  return byMessage;
}

// ---- storage ------------------------------------------------------------------------

/**
 * Lines a chat source already has for these messages: id → line number. The bot appends group
 * messages as they arrive and the owner's capture reads the same chat later, so each side skips what
 * the other wrote. Both write at the end, so only the tail is searched.
 */
export function linesWritten(app: App, spaceId: string, uri: string, ids: string[]) {
  const out = new Map<string, number>();
  const src = ids.length ? findSourceByUri(app, spaceId, uri) : undefined;
  if (!src || src.deletedAt) return out;
  const text = sourceText(app, src.id);
  const from = Math.max(0, text.length - 200_000);
  for (const id of ids) {
    const at = text.indexOf(`(${id})`, from);
    if (at >= 0) out.set(id, text.slice(0, at).split("\n").length);
  }
  return out;
}

type Row = {
  message_id: string;
  chat_id: string;
  thread_id: string | null;
  parent_id: string | null;
  sender_id: string | null;
  sender_name: string;
  sender_kind: string;
  msg_type: string;
  content: string;
  create_ms: number;
  source_id: string | null;
  line: number | null;
  archive: string | null;
  resources: string;
  reactions: string;
  mentions: string;
};

export function storeMessages(
  app: App,
  chatId: string,
  messages: LarkMessage[],
  opts: { owner?: string; sourceId?: string | null; firstLine?: number; lines?: Map<string, number>; archive?: string | null; resources?: Map<string, Record<string, ResourceRef>> },
) {
  tx(app.db, () => {
    messages.forEach((m, i) =>
      run(
        app.db,
        `insert into lark_messages(message_id,chat_id,thread_id,parent_id,sender_id,sender_name,sender_kind,msg_type,content,create_ms,source_id,line,archive,resources,reactions,mentions,raw_content)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         on conflict(message_id) do update set thread_id = coalesce(excluded.thread_id, lark_messages.thread_id), parent_id = coalesce(excluded.parent_id, lark_messages.parent_id),
           content = excluded.content,
           sender_name = case when excluded.sender_name != '' then excluded.sender_name else lark_messages.sender_name end,
           source_id = coalesce(excluded.source_id, lark_messages.source_id), line = coalesce(excluded.line, lark_messages.line),
           archive = coalesce(excluded.archive, lark_messages.archive), resources = json_patch(lark_messages.resources, excluded.resources),
           reactions = excluded.reactions, mentions = case when excluded.mentions != '[]' then excluded.mentions else lark_messages.mentions end, raw_content = coalesce(excluded.raw_content, lark_messages.raw_content)`,
        m.message_id,
        m.chat_id ?? chatId,
        m.thread_id ?? null,
        parentOf(m) || null,
        m.sender?.id ?? null,
        m.sender?.name ?? "",
        senderKind(m, opts.owner),
        m.msg_type,
        messageText(m),
        timeMs(m.create_time),
        opts.sourceId ?? null,
        opts.lines?.get(m.message_id) ?? (opts.firstLine !== undefined ? opts.firstLine + i : null),
        opts.archive ?? null,
        JSON.stringify(opts.resources?.get(m.message_id) ?? {}),
        JSON.stringify(Array.isArray(m.reactions) ? m.reactions : ((m.reactions as { counts?: unknown })?.counts ?? [])),
        JSON.stringify((m.mentions ?? []).map((x) => ({ id: typeof x.id === "string" ? x.id : (x.id?.open_id ?? ""), name: x.name ?? "" })).filter((x) => x.id)),
        m.raw_content ?? (typeof m.content === "object" ? JSON.stringify(m.content) : typeof m.content === "string" && /^\s*[{[]/.test(m.content) ? m.content : null),
      ),
    );
  });
}

/** Names and emails of the people in these messages (senders and @-mentions), for display and for the bot to @ them. */
export async function learnPeople(app: App, messages: LarkMessage[]) {
  const ids = messages.flatMap((m) => cliIdsIn(messageText(m), [isApp(m) ? undefined : m.sender?.id, ...mentionIds(m)]));
  await learnCliPeople(app, ids).catch((e) => console.warn(`[omem] 记录飞书联系人失败：${(e as Error).message}`));
}

/**
 * Once: chat sources captured before ids were dropped from chat lines lose their `(ou_…)` after @names
 * (same lines, so citations keep pointing at the same place), and the people in stored messages get
 * names and emails.
 */
export async function cleanUpLarkIds(app: App) {
  if (one(app.db, "select 1 from kv where key = 'lark_open_ids_cleaned_v2'")) return;
  for (const s of all<{ id: string; space_id: string; kind: string; uri: string; title: string; text: string; meta: string }>(
    app.db,
    "select id, space_id, kind, uri, title, text, meta from sources where kind = 'chat' and deleted_at is null and text like '%(ou_%'",
  )) {
    const text = withoutOpenIds(s.text);
    if (text !== s.text) upsertSource(app, { spaceId: s.space_id, kind: "chat", uri: s.uri, title: s.title, text, meta: json(s.meta, {}) });
  }
  const rows = all<{ content: string; mentions: string; sender_id: string | null; sender_kind: string }>(app.db, "select content, mentions, sender_id, sender_kind from lark_messages");
  const ids = rows.flatMap((r) => cliIdsIn(r.content, [r.sender_kind === "app" ? undefined : (r.sender_id ?? undefined), ...json<{ id: string }[]>(r.mentions, []).map((x) => x.id)]));
  await learnCliPeople(app, ids).catch(() => {});
  run(app.db, "insert into kv(key,value) values('lark_open_ids_cleaned_v2', ?) on conflict(key) do update set value = excluded.value", new Date().toISOString());
}

/** Quoted (replied-to) messages: from what is stored, else fetched once and stored as context. */
export async function quotedMessages(app: App, chatId: string, messages: LarkMessage[], owner?: string): Promise<Map<string, Quoted>> {
  const out = new Map<string, Quoted>();
  const inBatch = new Map(messages.map((m) => [m.message_id, m]));
  const missing: string[] = [];
  for (const m of messages) {
    const p = parentOf(m);
    if (!p || out.has(p)) continue;
    const local = inBatch.get(p);
    if (local) {
      out.set(p, { sender: local.sender?.name ?? "?", text: messageText(local) });
      continue;
    }
    const row = one<{ sender_name: string; content: string }>(app.db, "select sender_name, content from lark_messages where message_id = ?", p);
    if (row) out.set(p, { sender: row.sender_name || "?", text: row.content });
    else missing.push(p);
  }
  for (let i = 0; i < missing.length; i += 50) {
    try {
      const v = await larkCli(["im", "+messages-mget", "--message-ids", missing.slice(i, i + 50).join(","), "--no-reactions", "--as", "user", "--format", "json"]);
      const got = flattenReplies((v.data?.messages ?? []) as LarkMessage[]).filter((m) => missing.includes(m.message_id));
      storeMessages(app, chatId, got, { owner });
      for (const m of got) out.set(m.message_id, { sender: m.sender?.name ?? "?", text: messageText(m) });
    } catch (e) {
      console.warn(`[omem] 读取被引用的飞书消息失败：${(e as Error).message}`);
    }
  }
  return out;
}

// ---- history archives ----------------------------------------------------------------

export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

// ---- reading back (web) --------------------------------------------------------------

export type ChatMessageView = {
  id: string;
  line: number | null;
  time: string;
  threadId: string | null;
  parentId: string | null;
  sender: string;
  senderKind: string;
  msgType: string;
  content: string;
  resources: Record<string, ResourceRef & { url?: string }>;
  reactions: unknown[];
  /** People @-mentioned: name and email (ids stay on the server). */
  mentions: { name: string; email: string | null }[];
};

const toView = (r: Row): ChatMessageView => ({
  id: r.message_id,
  line: r.line,
  time: new Date(r.create_ms).toISOString(),
  threadId: r.thread_id,
  parentId: r.parent_id,
  sender: r.sender_name,
  senderKind: r.sender_kind,
  msgType: r.msg_type,
  content: r.content,
  resources: Object.fromEntries(Object.entries(json<Record<string, ResourceRef>>(r.resources, {})).map(([k, v]) => [k, { ...v, url: v.file ? `/api/files/${v.file}` : undefined }])),
  reactions: json(r.reactions, []),
  mentions: [],
});

/** Structured messages of a chat source (empty for sources captured before rows were kept) and the messages they quote. */
export function sourceMessages(app: App, sourceId: string) {
  const rows = all<Row>(app.db, "select * from lark_messages where source_id = ? order by create_ms, line", sourceId);
  const parents = new Set(rows.map((r) => r.parent_id).filter((p): p is string => !!p));
  const have = new Set(rows.map((r) => r.message_id));
  const quoted: Record<string, ChatMessageView & { sourceId: string | null }> = {};
  for (const p of parents) {
    if (have.has(p)) continue;
    const r = one<Row>(app.db, "select * from lark_messages where message_id = ?", p);
    if (r) quoted[p] = { ...toView(r), sourceId: r.source_id };
  }
  const views = rows.map(toView);
  // Mentions: the stored list (text messages) and `@名字(ou_…)` inside cards, resolved to name + email.
  const idsOf = (r: Row) => cliIdsIn(r.content, json<{ id: string }[]>(r.mentions, []).map((x) => x.id));
  const people = peopleByCliIds(app, [...new Set(rows.flatMap(idsOf))]);
  rows.forEach((r, i) => {
    const seen = new Map<string, { name: string; email: string | null }>();
    // The name as written in the message, so the page can find it there.
    for (const x of json<{ id: string; name: string }[]>(r.mentions, [])) seen.set(x.id, { name: x.name || people.get(x.id)?.name || "", email: people.get(x.id)?.email ?? null });
    for (const m of r.content.matchAll(MENTION_WITH_ID)) seen.set(m[2], { name: m[1], email: people.get(m[2])?.email ?? null });
    views[i].mentions = [...seen.values()];
    views[i].content = withoutOpenIds(views[i].content);
  });
  for (const q of Object.values(quoted)) q.content = withoutOpenIds(q.content);
  return { messages: views, quoted };
}

// ---- resources on demand ---------------------------------------------------------------

/**
 * One image or file of a message, downloaded when the web first shows it. Lines captured before
 * resources were downloaded (or before rows were kept) carry only the key; the owner's lark-cli
 * reads it, the bot is the fallback for chats it is in. The stored file is remembered on the
 * message row, or in kv when there is no row.
 */
const pendingResources = new Map<string, Promise<string | null>>();
/** Keys that could not be read recently: a broken image is not fetched again on every render. */
const failedResources = new Map<string, number>();
export function messageResourceFile(app: App, messageId: string, key: string): Promise<string | null> {
  const cacheKey = `${messageId}/${key}`;
  const known = knownResourceFile(app, messageId, key);
  if (known) return Promise.resolve(known);
  if ((failedResources.get(cacheKey) ?? 0) > Date.now() - 10 * 60_000) return Promise.resolve(null);
  let p = pendingResources.get(cacheKey);
  if (!p) {
    p = downloadResource(app, messageId, key)
      .then((f) => (f ? f : (failedResources.set(cacheKey, Date.now()), null)))
      .finally(() => pendingResources.delete(cacheKey));
    pendingResources.set(cacheKey, p);
  }
  return p;
}

function knownResourceFile(app: App, messageId: string, key: string): string | null {
  const row = one<{ resources: string }>(app.db, "select resources from lark_messages where message_id = ?", messageId);
  const fromRow = row ? json<Record<string, ResourceRef>>(row.resources, {})[key]?.file : undefined;
  if (fromRow && existsSync(join(app.filesDir, fromRow))) return fromRow;
  const kv = one<{ value: string }>(app.db, "select value from kv where key = ?", `lark_res:${messageId}/${key}`)?.value;
  return kv && existsSync(join(app.filesDir, kv)) ? kv : null;
}

async function downloadResource(app: App, messageId: string, key: string): Promise<string | null> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "omem-res-"));
  try {
    let file: string | null = null;
    try {
      const v = await larkCli(["im", "+messages-mget", "--message-ids", messageId, "--download-resources", "--as", "user", "--format", "json"], 120_000, dir);
      const res = ((v.data?.messages ?? v.data?.items ?? []) as LarkMessage[]).flatMap((m) => m.resources ?? []).find((r) => r.key === key && !r.error && r.local_path);
      if (res?.local_path) {
        const path = existsSync(res.local_path) ? res.local_path : join(dir, res.local_path);
        if (existsSync(path)) file = keepOriginal(app, withExtension(path));
      }
    } catch {}
    if (!file) {
      // The bot reads resources of messages in chats it is a member of.
      const { larkClient } = await import("./lark-send.ts");
      try {
        const res = await larkClient().im.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type: key.startsWith("img_") ? "image" : "file" } });
        const target = join(dir, key.replace(/[^\w-]/g, "_"));
        await res.writeFile(target);
        file = keepOriginal(app, withExtension(target));
      } catch {}
    }
    if (!file) {
      console.warn(`[omem] 读取飞书消息资源失败：${messageId}/${key}`);
      return null;
    }
    const row = one<{ resources: string }>(app.db, "select resources from lark_messages where message_id = ?", messageId);
    if (row) {
      const refs = json<Record<string, ResourceRef>>(row.resources, {});
      refs[key] = { ...(refs[key] ?? { type: key.startsWith("img_") ? "image" : "file" }), file };
      run(app.db, "update lark_messages set resources = ? where message_id = ?", JSON.stringify(refs), messageId);
    } else run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", `lark_res:${messageId}/${key}`, file);
    return file;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- filling in what was never downloaded ------------------------------------------------

/** Image and file keys a message refers to: `![Image](img_…)`, `[Image: img_…]`, `<file key="file_…">`, `<video key=…>`. */
const RESOURCE_KEY = /(?:\]\(|\[Image: |key=")((?:img|file)_[\w-]+)/g;
const keysIn = (text: string) => [...new Set([...text.matchAll(RESOURCE_KEY)].map((m) => m[1]))];

/**
 * Images and files of captured messages that have no local copy: rows whose download failed or was
 * off, and lines of chat sources captured before rows were kept. `chatIds` limits it to those chats.
 */
export function missingResources(app: App, chatIds?: string[]) {
  const out: { messageId: string; key: string }[] = [];
  const inChats = chatIds?.length ? ` and chat_id in (${chatIds.map(() => "?").join(",")})` : "";
  const rows = all<{ message_id: string; content: string; resources: string }>(
    app.db,
    `select message_id, content, resources from lark_messages where (content like '%img_%' or content like '%file_%')${inChats}`,
    ...(chatIds ?? []),
  );
  for (const r of rows) {
    const refs = json<Record<string, ResourceRef>>(r.resources, {});
    for (const key of keysIn(r.content)) if (!refs[key]?.file && !knownResourceFile(app, r.message_id, key)) out.push({ messageId: r.message_id, key });
  }
  const uris = chatIds?.length ? ` and (${chatIds.map(() => "(uri = ? or uri like ?)").join(" or ")})` : " and uri like 'lark:oc_%'";
  const sources = all<{ text: string }>(app.db, `select text from sources where kind = 'chat' and deleted_at is null${uris}`, ...(chatIds ?? []).flatMap((c) => [`lark:${c}`, `lark:${c}@%`]));
  for (const s of sources)
    for (const line of s.text.split("\n")) {
      const id = /\((om_[\w-]+)\)\s*$/.exec(line)?.[1];
      if (!id || !/(?:img|file)_/.test(line) || one(app.db, "select 1 from lark_messages where message_id = ?", id)) continue;
      for (const key of keysIn(line)) if (!knownResourceFile(app, id, key)) out.push({ messageId: id, key });
    }
  return out;
}

type FillProgress = { chats: string[] | null; total: number; done: number; fetched: number; failed: number; startedAt: string; finishedAt?: string };
let filling: FillProgress | null = null;
let lastFill: FillProgress | null = null;

/** Download every missing image and file (see missingResources) one at a time. The owner's lark-cli reads them; the bot is the fallback for its own chats. */
export async function fillResources(app: App, chatIds?: string[], onProgress?: (p: FillProgress) => void) {
  const todo = missingResources(app, chatIds);
  const p: FillProgress = { chats: chatIds?.length ? chatIds : null, total: todo.length, done: 0, fetched: 0, failed: 0, startedAt: new Date().toISOString() };
  filling = p;
  try {
    for (const t of todo) {
      const file = await messageResourceFile(app, t.messageId, t.key).catch(() => null);
      if (file) p.fetched++;
      else p.failed++;
      p.done++;
      onProgress?.(p);
    }
  } finally {
    p.finishedAt = new Date().toISOString();
    lastFill = p;
    filling = null;
  }
  return p;
}

/** fillResources without waiting; the owner gets a notification when it is done. */
export function fillResourcesInBackground(app: App, chatIds?: string[], notifyConversationId?: string) {
  if (filling) return { started: false, reason: "上一次补拉还没结束", progress: filling };
  const total = missingResources(app, chatIds).length;
  if (!total) return { started: false, reason: "没有缺图片或附件的消息" };
  void fillResources(app, chatIds)
    .then(async (p) => {
      const { notify } = await import("../core/notify.ts");
      notify(app, { title: `飞书图片和附件补拉完成：${p.fetched}/${p.total}`, body: p.failed ? `${p.failed} 个读不到（多半是已过期、被撤回或没有权限）。` : "全部补齐。", ...(notifyConversationId ? { larkConversationId: notifyConversationId } : {}) });
    })
    .catch((e) => console.warn("[omem] 补拉飞书图片和附件失败：", (e as Error).message));
  return { started: true, total };
}

export function fillResourcesStatus() {
  return filling ? { running: true, ...filling } : lastFill ? { running: false, ...lastFill } : null;
}

/** Both identities use the same chat/message location. Replayed messages update that line. */
export function persistChatMessages(app: App, input: { chatId: string; spaceId: string; name: string; messages: LarkMessage[]; owner?: string; resources?: Map<string, Record<string, ResourceRef>>; archive?: string }) {
  type SourceRow = { id: string; space_id: string; uri: string; title: string; text: string; meta: string };
  const existing = one<SourceRow>(app.db, "select * from sources where uri=? and deleted_at is null order by captured_at limit 1", `lark:${input.chatId}`);
  const spaceId = existing?.space_id ?? input.spaceId;
  const targets = new Map<string, { source?: SourceRow; lines: string[]; positions: Map<string, number>; writes: { message: LarkMessage; line: number; resources: Record<string, ResourceRef> }[] }>();
  const validSources = new Map<string, SourceRow | undefined>();
  let sourceId: string | undefined;
  let status: UpsertResult["status"] = "unchanged";
  const inBatch = new Map(input.messages.map(m => [m.message_id, m]));
  for (const m of input.messages) {
    const row = one<{ source_id: string | null; line: number | null; resources: string }>(app.db, "select source_id,line,resources from lark_messages where chat_id=? and message_id=?", input.chatId, m.message_id);
    const resources = { ...json<Record<string, ResourceRef>>(row?.resources, {}), ...input.resources?.get(m.message_id) };
    if (row?.source_id && !validSources.has(row.source_id)) validSources.set(row.source_id, one<SourceRow>(app.db, "select * from sources where id=? and deleted_at is null", row.source_id));
    const legacy = !row?.source_id ? one<SourceRow>(app.db, "select * from sources where deleted_at is null and (uri=? or uri glob ?) and instr(text,?)>0 limit 1", `lark:${input.chatId}`, `lark:${input.chatId}@*`, `(${m.message_id})`) : undefined;
    const archive = input.archive ? one<SourceRow>(app.db, "select * from sources where deleted_at is null and uri=? limit 1", `lark:${input.chatId}@${input.archive}`) : undefined;
    const source = (row?.source_id ? validSources.get(row.source_id) : undefined) ?? legacy ?? (input.archive ? archive : existing);
    const targetKey = source?.id ?? `new:${input.archive ?? "live"}`;
    let target = targets.get(targetKey);
    if (!target) {
      const lines = source?.text ? source.text.split("\n") : [];
      const positions = new Map<string, number>();
      lines.forEach((line, i) => { const id = /\(([^()]+)\)$/.exec(line)?.[1]; if (id && !positions.has(id)) positions.set(id, i); });
      target = { source, lines, positions, writes: [] };
      targets.set(targetKey, target);
    }
    // Text-only legacy messages (or a previous failed structured write) reuse their old line.
    const index = target.positions.get(m.message_id) ?? target.lines.length;
    const parent = parentOf(m);
    const batchParent = inBatch.get(parent);
    const quote = batchParent ? { sender_name: batchParent.sender?.name ?? "?", content: messageText(batchParent) } : parent ? one<{ sender_name: string; content: string }>(app.db, "select sender_name,content from lark_messages where message_id=? and chat_id=?", parent, input.chatId) : undefined;
    target.lines[index] = formatLine(m, { owner: input.owner, resources, quoted: quote ? { sender: quote.sender_name, text: quote.content } : null });
    target.positions.set(m.message_id, index);
    target.writes.push({ message: m, line: index + 1, resources });
  }
  for (const target of targets.values()) {
    const source = target.source;
    const r = upsertSource(app, { spaceId: source?.space_id ?? spaceId, uri: source?.uri ?? `lark:${input.chatId}${input.archive ? `@${input.archive}` : ""}`, title: source?.title ?? (input.archive ? `${input.name}（${input.archive} 历史）` : input.name), kind: "chat", text: target.lines.join("\n"), meta: source ? json(source.meta, {}) : { chatId: input.chatId, ...(input.archive ? { history: true, month: input.archive, via: "lark-cli" } : {}) } });
    sourceId = r.id;
    if (r.status !== "unchanged") status = status === "created" ? status : r.status;
    // The source is written first: on failure the next call recovers each message id from its text.
    for (const w of target.writes) storeMessages(app, input.chatId, [w.message], { owner: input.owner, sourceId, firstLine: w.line, archive: source?.uri.includes("@") ? source.uri.split("@").pop() : source ? undefined : input.archive, resources: new Map([[w.message.message_id, w.resources]]) });
  }
  return { id: sourceId, spaceId, status };
}
