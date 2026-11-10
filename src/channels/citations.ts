import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { json } from "../core/util.ts";
import { prepareShare, type ShareRef } from "../core/shares.ts";

/**
 * Citations in messages that leave omem (Feishu, Telegram, QQ). Other apps cannot open omem's own
 * references (`src:` `mem:` `msg:` `[[页面]]`), so on the way out each one becomes something that
 * opens, or disappears:
 *
 * - a document whose original is on the web or in Feishu → that link;
 * - a Feishu chat line or a message that came from Feishu → the chat opened at that message
 *   (lark-cli's message_position; the chat alone when the position is unknown, unless it is the
 *   chat the message goes to: that is where the reader already is, so a share instead);
 * - anything else (code, working files, memories, pages, messages in omem) → a read-only share
 *   link holding a copy of just the cited parts (core/shares.ts), when `webUrl` is set;
 * - nothing to link to → no reference text at all.
 *
 * A citation that is part of the sentence (`见[《差旅报销制度》](src:…)第 3 条`) keeps its words
 * and links them. One that trails a sentence (`…已通过。[日志摘录](src:…)`) is shown as a small
 * numbered link ((1) (2)…) instead of its label, so paragraphs do not end in a row of titles.
 */

export type CiteOptions = {
  /** The run whose answer this is: shares copy only what it could read, and record it. */
  runId?: string | null;
  /** The chat the message goes to, recorded on the share (飞书 · 群名). */
  chatId?: string;
};

const CITE =
  /\[([^\]\n]*)\]\(((?:src|mem|msg|wiki):[^)\s]+)\)|\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]|(?<![\w/:.#-])((?:src|mem|msg):[A-Za-z0-9_-]{6,}(?:#L\d+(?:-L?\d+)?)?)/g;
/** After these a citation trails the sentence instead of being part of it (not `)`: a link ends with it). */
const ENDS = new Set([..."。．！!？?；;）」』”】.…~～"]);
const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/;

type Entry = { seg: number; start: number; end: number; ref: string; label: string | null; trailing: boolean; url: string | null; shareable: boolean };

function normalize(ref: string): string {
  const m = /^src:([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(ref);
  if (m) return m[2] ? `src:${m[1]}#L${m[2]}${m[3] && m[3] !== m[2] ? `-L${m[3]}` : ""}` : `src:${m[1]}`;
  if (ref.startsWith("wiki:")) {
    try {
      return `wiki:${decodeURIComponent(ref.slice(5))}`;
    } catch {
      return ref;
    }
  }
  return ref.replace(/#.*$/, "");
}

/**
 * A trailing citation's mark: plain digits in brackets, the same for every number. Circled digits
 * looked alike only up to ⑩: common Chinese fonts (Microsoft YaHei, SimSun…) have ①–⑩ but not ⑪–⑳,
 * which then came from a fallback font in another size, and from 21 on they were plain `(21)`.
 */
export const citationMark = (n: number) => `(${n})`;
const chatLink = (chat: string, position?: number | null) =>
  `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chat)}${position !== null && position !== undefined ? `&position=${position}` : ""}`;

/** A source's own address outside omem (web page, Feishu document, a Feishu chat). */
export function externalUrl(uri: string): string | null {
  if (/^https?:\/\//.test(uri)) return uri;
  const chat = /^lark:(oc_[A-Za-z0-9]+)/.exec(uri);
  if (chat) return chatLink(chat[1]);
  return null;
}

/** `message`: the omem message cited (`msg:`), which keeps the Feishu position when lark_messages has no row (the bot's own chats). */
type LarkTarget = { chat: string; messageId: string | null; message?: string };

/** The Feishu message behind a reference, when there is one. */
function larkTarget(app: App, ref: string): LarkTarget | null {
  let m = /^src:([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(ref);
  if (m) {
    const s = one<{ uri: string }>(app.db, "select uri from sources where id = ?", m[1]);
    const chat = s ? /^lark:(oc_[A-Za-z0-9]+)/.exec(s.uri)?.[1] : null;
    if (!chat) return null;
    if (!m[2]) return { chat, messageId: null };
    // Lines of this copy of the chat (each person may have their own), else the first copy kept on the row.
    const row =
      one<{ message_id: string }>(app.db, "select message_id from lark_message_lines where source_id = ? and line between ? and ? order by line limit 1", m[1], Number(m[2]), Number(m[3] ?? m[2])) ??
      one<{ message_id: string }>(app.db, "select message_id from lark_messages where source_id = ? and line between ? and ? order by line limit 1", m[1], Number(m[2]), Number(m[3] ?? m[2]));
    return { chat, messageId: row?.message_id ?? null };
  }
  m = /^msg:([A-Za-z0-9_-]+)$/.exec(ref);
  if (m) {
    const r = one<{ meta: string; channel: string; external_id: string | null }>(app.db, "select m.meta, c.channel, c.external_id from messages m join conversations c on c.id = m.conversation_id where m.id = ?", m[1]);
    if (!r || !(r.channel === "lark" || r.channel.startsWith("lark:"))) return null;
    const meta = json<{ externalId?: string; larkMessageId?: string }>(r.meta, {});
    const messageId = meta.externalId ?? meta.larkMessageId ?? null;
    // Not sent to Feishu as such (a record, a card shown elsewhere): the chat alone would not show it.
    if (!messageId) return null;
    const chat = (r.external_id ?? "").split("#")[0];
    if (/^oc_/.test(chat)) return { chat, messageId, message: m[1] };
    const row = one<{ chat_id: string }>(app.db, "select chat_id from lark_messages where message_id = ?", messageId);
    return row ? { chat: row.chat_id, messageId, message: m[1] } : null;
  }
  return null;
}

function larkPosition(app: App, t: LarkTarget): number | null {
  if (!t.messageId) return null;
  const pos = one<{ position: number | null }>(app.db, "select position from lark_messages where message_id = ?", t.messageId)?.position;
  if (pos !== null && pos !== undefined) return pos;
  return t.message ? (one<{ p: number | null }>(app.db, "select json_extract(meta, '$.larkPosition') p from messages where id = ?", t.message)?.p ?? null) : null;
}

function sourceRow(app: App, id: string) {
  return one<{ uri: string }>(app.db, "select uri from sources where id = ? and deleted_at is null", canonicalSourceId(app, id));
}

function target(app: App, ref: string, chatId?: string): { url: string | null; shareable: boolean } {
  const lark = larkTarget(app, ref);
  if (lark) {
    const pos = larkPosition(app, lark);
    // The chat the answer goes to, opened at its end, is where the reader already is: a copy says more.
    if (pos !== null || lark.chat !== chatId) return { url: chatLink(lark.chat, pos), shareable: false };
    return { url: null, shareable: true };
  }
  const src = /^src:([A-Za-z0-9_-]+)/.exec(ref);
  if (src) {
    const s = sourceRow(app, src[1]);
    if (!s) return { url: null, shareable: false };
    const url = externalUrl(s.uri);
    return url ? { url, shareable: false } : { url: null, shareable: true };
  }
  return { url: null, shareable: true };
}

/** Where a reference opens outside omem without a share (a web or Feishu document, a Feishu message), or null. */
export function citationUrl(app: App, ref: string): string | null {
  return target(app, normalize(ref)).url;
}

const failedAt = { at: 0 };
/**
 * Fill in the chat positions of cited Feishu messages that were saved without one (before omem kept
 * them, or arrived through the bot): one read-only lark-cli call, at most every few minutes when
 * it fails. Without it those citations open the chat instead of the message.
 */
export async function prefetchLarkPositions(app: App, mds: string[]) {
  if (app.config.lark.capture.mode === "off" || Date.now() - failedAt.at < 10 * 60_000) return;
  const ids = new Set<string>();
  // Cited omem messages by their Feishu id: the bot's own chats have no lark_messages row to hold the position.
  const messages = new Map<string, string>();
  for (const md of mds)
    for (const m of md.matchAll(CITE)) {
      const raw = m[2] ?? m[5];
      if (!raw || !/^(src|msg):/.test(raw)) continue;
      const t = larkTarget(app, normalize(raw));
      if (t?.messageId && larkPosition(app, t) === null) {
        ids.add(t.messageId);
        if (t.message) messages.set(t.messageId, t.message);
      }
    }
  const missing = [...ids].slice(0, 50);
  if (!missing.length) return;
  try {
    const { larkCli } = await import("./lark-cli.ts");
    const v = await larkCli(["im", "+messages-mget", "--message-ids", missing.join(","), "--no-reactions", "--as", "user", "--format", "json"], 15_000);
    const { positionOf } = await import("./lark-messages.ts");
    for (const msg of (v?.data?.messages ?? v?.data?.items ?? []) as { message_id?: string; message_position?: string | number }[]) {
      const pos = positionOf(msg);
      if (!msg.message_id || pos === null) continue;
      run(app.db, "update lark_messages set position = ? where message_id = ?", pos, msg.message_id);
      const own = messages.get(msg.message_id);
      if (own) run(app.db, "update messages set meta = json_set(meta, '$.larkPosition', ?) where id = ?", pos, own);
    }
  } catch (e) {
    failedAt.at = Date.now();
    console.warn(`[omem] 读取被引用的飞书消息位置失败：${(e as Error).message}`);
  }
}

function splitCode(md: string) {
  return md.split(CODE).map((text, i) => ({ text, code: i % 2 === 1 }));
}

function isTrailing(text: string, start: number, end: number, label: string | null, prev: Entry | null): boolean {
  if (label === null) return true;
  // Right after another citation: the same kind (a row of trailing references, or of named links).
  if (prev && /^[ \t]*$/.test(text.slice(prev.end, start))) return prev.trailing;
  const before = text.slice(0, start).replace(/[ \t]+$/, "");
  // `…送审。**[依据](src:…)`: the sentence ends inside the bold.
  const last = before.replace(/(\*\*|__|~~)+$/, "").slice(-1);
  if (last && ENDS.has(last)) return true;
  // Alone at the start of a line (after a list marker): a trailing reference only when nothing but
  // other references follow it on the line; otherwise its words are the line's content.
  const lineStart = before.slice(before.lastIndexOf("\n") + 1);
  if (/^\s*(?:[-*+]|\d+[.)]|>)?\s*$/.test(lineStart)) {
    const rest = text.slice(end).split("\n")[0].replace(CITE, "");
    return /^[\s。．.，,;；]*$/.test(rest);
  }
  return false;
}

/** The first line of what was sent, as words (the share's title). */
const titleOf = (md: string) =>
  md
    .split("\n")
    .map((l) => l.replace(/\[\(\d+\)\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`|[\]]/g, "").trim())
    .find(Boolean)
    ?.slice(0, 80) ?? "";

function originOf(app: App, chatId?: string) {
  if (!chatId) return "";
  const name = one<{ title: string }>(app.db, "select title from sources where uri = ? and deleted_at is null", `lark:${chatId}`)?.title
    ?? one<{ title: string }>(app.db, "select title from conversations where external_id = ? or external_id like ? order by updated_at desc limit 1", chatId, `${chatId}#%`)?.title;
  return /^oc_/.test(chatId) ? `飞书 · ${name || chatId}` : name || chatId;
}

/** Several pieces of one message (a card's Markdown blocks): numbered together, one share. */
export function resolveCitationsNow(app: App, mds: string[], opts: CiteOptions = {}): string[] {
  const pieces = mds.map((md) => splitCode(md ?? ""));
  // Pass 1: find citations, decide trailing or inline, and where each goes.
  const perPiece: Entry[][][] = pieces.map((segs) =>
    segs.map((seg, si) => {
      if (seg.code) return [];
      const out: Entry[] = [];
      for (const m of seg.text.matchAll(CITE)) {
        const start = m.index!;
        const end = start + m[0].length;
        const raw = m[2] ?? (m[3] !== undefined ? `wiki:${m[3].trim()}` : m[5]);
        const label = m[1] !== undefined ? m[1].trim() || null : m[3] !== undefined ? (m[4] ?? m[3].split(/[:/]/).pop() ?? m[3]).trim() : null;
        const ref = normalize(raw!);
        const t = target(app, ref, opts.chatId);
        out.push({ seg: si, start, end, ref, label, trailing: isTrailing(seg.text, start, end, label, out.at(-1) ?? null), url: t.url, shareable: t.shareable });
      }
      return out;
    }),
  );
  const flat = perPiece.flat(2);
  // Everything shareable goes into one share for the message.
  const wanted: ShareRef[] = [];
  for (const e of flat) if (e.shareable && !wanted.some((w) => w.ref === e.ref)) wanted.push({ ref: e.ref, label: e.label ?? "" });
  // Only what a run sends gets a share (an answer, an agent's message); notifications and cards
  // without a run keep to direct links.
  const share = wanted.length && opts.runId ? prepareShare(app, { refs: wanted, runId: opts.runId, origin: originOf(app, opts.chatId) }) : null;
  for (const e of flat) if (e.shareable && share) e.url = share.link(e.ref);
  // Numbers for the trailing ones that open something, in reading order; the same target keeps its number.
  const marks = new Map<string, number>();
  for (const e of flat) if (e.trailing && e.url && !marks.has(e.ref)) marks.set(e.ref, marks.size + 1);
  // Pass 2: write it out.
  const out = pieces.map((segs, pi) =>
    segs
      .map((seg, si) => {
        if (seg.code) return seg.text;
        let out = "";
        let at = 0;
        for (const e of perPiece[pi][si]) {
          out += seg.text.slice(at, e.start);
          at = e.end;
          if (e.trailing) {
            if (e.url) out += `[${citationMark(marks.get(e.ref)!)}](${e.url})`;
            else out = out.replace(/[ \t]+$/, "");
          } else out += e.url ? `[${e.label}](${e.url})` : (e.label ?? "");
        }
        return out + seg.text.slice(at);
      })
      .join(""),
  ).map((md) => localPathLinks(app, md.replace(/\[([^\]]*)\]\(#\/[^)]*\)/g, "$1")));
  if (share && flat.some((e) => e.shareable && e.url)) share.save(marks, titleOf(out.join("\n")));
  return out;
}

/** The same without reading missing Feishu positions first (for code that cannot wait). */
export function resolveCitationsSync(app: App, md: string, opts: CiteOptions = {}): string {
  return resolveCitationsNow(app, [md], opts)[0];
}

/** One message's Markdown with its citations made usable outside omem (see the top of this file). */
export async function resolveCitations(app: App, md: string, opts: CiteOptions = {}): Promise<string> {
  await prefetchLarkPositions(app, [md]);
  return resolveCitationsNow(app, [md], opts)[0];
}

/** A card's Markdown blocks, numbered together; callback values and other protocol data stay intact. */
export async function resolveCardCitations(app: App, card: Record<string, unknown>, opts: CiteOptions = {}): Promise<Record<string, unknown>> {
  const texts: string[] = [];
  const isText = (node: Record<string, unknown>, key: string, child: unknown) => key === "content" && typeof child === "string" && (node.tag === "markdown" || node.tag === "lark_md");
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(node)) {
      if (isText(node, key, child)) texts.push(child as string);
      else if (key !== "value") collect(child);
    }
  };
  collect(card);
  await prefetchLarkPositions(app, texts);
  const done = resolveCitationsNow(app, texts, opts);
  let i = 0;
  const rebuild = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebuild);
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, isText(node, key, child) ? done[i++] : key === "value" ? child : rebuild(child)]));
  };
  return rebuild(card) as Record<string, unknown>;
}

/**
 * Links to files on this machine (`[下载页取数](/data/…/repo/src/a.ts#L10)`, `file://…`) open
 * nothing in a chat app. A file inside a repository space becomes `仓库 · 路径:行`, anything else
 * keeps its label and file name as plain text; real files are meant to go as attachments.
 */
export function localPathLinks(app: App, md: string) {
  const repos = all<{ name: string; root_path: string }>(app.db, "select name, root_path from spaces where root_path is not null and root_path != ''")
    .map((r) => ({ name: r.name, root: r.root_path.replace(/[\\/]+$/, "") }))
    .sort((a, b) => b.root.length - a.root.length);
  return md.replace(/\[([^\]]*)\]\(((?:file:\/\/)?(?:\/|[A-Za-z]:[\\/])[^)\s]*)\)/g, (_all, label: string, target: string) => {
    const [rawPath, frag] = target.replace(/^file:\/\//, "").split("#");
    let path = rawPath;
    try {
      path = decodeURIComponent(rawPath);
    } catch {}
    const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(frag ?? "");
    const at = lines ? `:${lines[1]}${lines[2] && lines[2] !== lines[1] ? `-${lines[2]}` : ""}` : "";
    const repo = repos.find((r) => path === r.root || path.startsWith(`${r.root}/`) || path.startsWith(`${r.root}\\`));
    const where = repo ? `${repo.name} · \`${path.slice(repo.root.length + 1)}${at}\`` : `\`${path.split(/[\\/]/).pop()}${at}\``;
    return label && !where.includes(label) ? `${label}（${where}）` : where;
  });
}
