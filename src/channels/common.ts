import { receive, type Inbound } from "../agents/inbox.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";

/**
 * Shared path for chat channels (Feishu, Telegram, QQ via OneBot…): the
 * owner's message enters the inbox (commands, threads, merging) and the answer
 * comes back as plain Markdown with internal citation links reduced to their
 * labels (other apps cannot open them). Returns null when the message was
 * merged into a turn whose answer another call is already waiting for.
 */
export async function answerFromChannel(
  app: App,
  input: Inbound & { channel: string; chatId: string },
  hooks: { onStart?: (runId: string) => void | Promise<void>; onMerged?: () => void | Promise<void>; onCard?: (card: Record<string, unknown>) => void | Promise<void> } = {},
): Promise<string | null> {
  const r = await receive(app, input);
  if (r.card) await hooks.onCard?.(r.card);
  if (r.reply !== null && r.reply !== "[card]") return r.reply;
  if (r.card && r.reply === "[card]") return null;
  if (r.merged || !r.runId) {
    await hooks.onMerged?.();
    return null;
  }
  await hooks.onStart?.(r.runId);
  const done = await waitForRun(app, r.runId);
  const answer = done.status === "done" ? String((getRun(app, r.runId).output as { answer?: string }).answer ?? "") : done.status === "cancelled" ? "（已停止）" : `处理失败：${done.error ?? done.status}`;
  const note = r.started === "renewed" ? "（距上次对话较久，已开始新会话并带上之前的摘要；/resume 可回到原会话）\n\n" : "";
  return note + resolveCitations(app, answer);
}

/**
 * Make citations usable outside omem: a source whose original is a web/Feishu
 * document becomes a real link; a Feishu chat source opens that chat; anything
 * else (memories, messages, wiki pages, omem-internal #/ routes) becomes plain
 * text, because other apps cannot open it.
 */
export function resolveCitations(app: App, md: string) {
  const withSources = md.replace(/\[([^\]]*)\]\(src:([A-Za-z0-9_]+)(?:#[^)]*)?\)/g, (_all, label: string, id: string) => {
    const s = one<{ uri: string }>(app.db, "select uri from sources where id = ?", id);
    const url = s ? externalUrl(s.uri) : null;
    return url ? `[${label}](${url})` : label;
  });
  return plainCitations(withSources).replace(/\[([^\]]*)\]\(#\/[^)]*\)/g, "$1");
}

function externalUrl(uri: string): string | null {
  if (/^https?:\/\//.test(uri)) return uri;
  const chat = /^lark:(oc_[A-Za-z0-9]+)/.exec(uri);
  if (chat) return `https://applink.feishu.cn/client/chat/open?openChatId=${chat[1]}`;
  return null;
}

export function plainCitations(md: string) {
  return md
    .replace(/\[([^\]]*)\]\((?:src|mem|msg|wiki):[^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1");
}

/** Split long replies for channels with message size limits. */
export function chunkMessage(text: string, max: number) {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
