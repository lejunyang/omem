import { escapeHtml } from "./markdown";

/** One chat message for display, from structured rows or parsed from a chat source line. */
export type ChatMsg = {
  id: string;
  line: number | null;
  time: string;
  threadId: string | null;
  parentId: string | null;
  sender: string;
  senderKind: string;
  msgType: string;
  content: string;
  resources: Record<string, { type: string; url?: string; name?: string; sourceId?: string }>;
  reactions: { emoji?: string; emoji_type?: string; count?: number }[] | unknown[];
  /** Parsed lines only: the quote the line carries ("↩ 回复 X「…」"). */
  quote?: { sender: string; text: string } | null;
  /** People @-mentioned, with their email when known (to tell who is who). */
  mentions?: { name: string; email: string | null }[];
};

const LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: · 话题 (\S+))?\] (.+?)(?: ↩ 回复 (.+?)「(.*?)」)?: (.*?)((?: → src:[\w-]+)*) \(((?:om_|msg_)?[\w-]+)\)$/;

/**
 * Chat sources captured before messages were stored structured: one line per message,
 * "[time · 话题 t] sender（本人）↩ 回复 X「…」: text ⏎ more (om_id)". Lines that do not
 * match (other channels, notes) become system rows so nothing is hidden.
 */
export function parseChatLines(text: string): ChatMsg[] {
  return text.split("\n").map((raw, i) => {
    const m = LINE.exec(raw);
    if (!m) return { id: `line-${i + 1}`, line: i + 1, time: "", threadId: null, parentId: null, sender: "", senderKind: "system", msgType: "system", content: raw, resources: {}, reactions: [] };
    const [, time, thread, who, qSender, qText, body, files, id] = m;
    const kind = /（本人）$/.test(who) ? "owner" : /（机器人）$/.test(who) ? "app" : "user";
    const resources: ChatMsg["resources"] = {};
    for (const f of files.matchAll(/src:([\w-]+)/g)) resources[`src:${f[1]}`] = { type: "file", sourceId: f[1] };
    return {
      id,
      line: i + 1,
      time: time.replace(" ", "T") + ":00Z",
      threadId: thread ?? null,
      parentId: null,
      sender: who.replace(/（(本人|机器人)）$/, ""),
      senderKind: kind,
      msgType: "text",
      content: body.replace(/ ⏎ /g, "\n").replace(/ ⏎$/, ""),
      resources,
      reactions: [],
      quote: qSender ? { sender: qSender, text: qText } : null,
    };
  });
}

const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

/**
 * lark-cli renders message content as Markdown plus a few tags. Turn it into Markdown/HTML
 * the shared renderer (marked + DOMPurify) understands: mentions, images (downloaded ones
 * point at the stored file), files, audio/video, cards, shared calendars, folders.
 */
export function larkToMarkdown(content: string, resources: ChatMsg["resources"], mentions: ChatMsg["mentions"] = []): string {
  let s = content;
  // @名字 → the name plus the email, so same-named people can be told apart.
  for (const p of mentions) {
    if (!p.email || !p.name) continue;
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`@${esc}(?![\\w(])`, "g"), `<span class="at" title="${escapeHtml(p.email)}">@${escapeHtml(p.name)}<span class="at-email">${escapeHtml(p.email)}</span></span>`);
  }
  s = s.replace(/<at [^>]*?(?:user_id|id)="([^"]*)"[^>]*>([^<]*)<\/at>/g, (_, id, name) => `<span class="at">@${escapeHtml(name || (id === "all" ? "所有人" : id))}</span>`);
  s = s.replace(/!\[([^\]]*)\]\(((?:img|file)_[\w-]+)\)/g, (_, alt, key) => (resources[key]?.url ? `![${alt || "图片"}](${resources[key].url})` : `<span class="res">[图片]</span>`));
  s = s.replace(/<card title="([^"]*)">\n?([\s\S]*?)(?:<\/card>|$)/g, (_, title, body) => `<div class="lark-card"><div class="lark-card-title">${escapeHtml(title)}</div>\n\n${body.trim()}\n\n</div>\n`);
  s = s.replace(/<card>\n?([\s\S]*?)(?:<\/card>|$)/g, (_, body) => `<div class="lark-card">\n\n${body.trim()}\n\n</div>\n`);
  s = s.replace(/<folder ([^>]*?)\/?>(?:[\s\S]*?<\/folder>)?/g, (tag) => `<span class="res">📁 ${escapeHtml(attr(tag, "name") || "文件夹")}</span>`);
  s = s.replace(/<(file|video|audio|media) ([^>]*?)\/?>/g, (_, kind: string, rest: string) => {
    const key = attr(rest, "key");
    const name = attr(rest, "name") || resources[key]?.name;
    const label = kind === "audio" ? `🎙 语音${attr(rest, "duration") ? " " + attr(rest, "duration") : ""}` : kind === "video" || kind === "media" ? `🎬 ${escapeHtml(name || "视频")}` : `📎 ${escapeHtml(name || "文件")}`;
    const url = resources[key]?.url;
    return url ? `<a class="res" href="${url}" target="_blank">${label}</a>` : `<span class="res">${label}</span>`;
  });
  s = s.replace(/<calendar_share [^>]*>/g, '<span class="res">📅 日程分享</span>');
  s = s.replace(/<share_chat [^>]*>/g, '<span class="res">💬 群名片</span>');
  s = s.replace(/<share_user [^>]*>/g, '<span class="res">👤 个人名片</span>');
  s = s.replace(/\[Sticker\]/g, '<span class="res">[表情包]</span>');
  return s;
}

/** Stable color per sender, from the accent palette. */
export function senderHue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 360;
  return h;
}
