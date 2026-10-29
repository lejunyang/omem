import { receive, type Inbound } from "../agents/inbox.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { refExcerpt } from "../items/evidence.ts";
import { citationUrl, resolveCitations } from "./citations.ts";

/**
 * Shared path for chat channels (Feishu, Telegram, QQ via OneBot…): the
 * owner's message enters the inbox (commands, threads, merging) and the answer
 * comes back as plain Markdown with internal citations made openable or left out
 * (citations.ts: other apps cannot open omem's own references). Returns null when the message was
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
  // The turn that was running when it came took the message (steer.ts) and answers it.
  if (done.status === "cancelled" && getRun(app, r.runId).output.steeredInto) {
    await hooks.onMerged?.();
    return null;
  }
  const answer = done.status === "done" ? String((getRun(app, r.runId).output as { answer?: string }).answer ?? "") : done.status === "cancelled" ? "（已停止）" : `处理失败：${done.error ?? done.status}`;
  const note = r.started === "renewed" ? "（距上次对话较久，已开始新会话并带上之前的摘要；/resume 可回到原会话）\n\n" : "";
  return note + (await resolveCitations(app, answer, { runId: r.runId, chatId: input.chatId }));
}

export { citationUrl, externalUrl, localPathLinks, resolveCardCitations, resolveCitations, resolveCitationsSync } from "./citations.ts";

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

/**
 * Where a notification's evidence came from, as lines a reader can judge without opening them:
 * one link per final URL (several refs into the same chat share it), labelled with the source
 * title, followed by short excerpts of the cited lines. Sources without an external URL keep
 * their excerpt as plain text.
 */
export function notificationOrigins(app: App, refs: string[]) {
  const groups = new Map<string, { url: string | null; title: string; excerpts: string[] }>();
  for (const ref of refs) {
    if (!/^(src|mem|msg):/.test(ref)) continue;
    const ex = refExcerpt(app, ref);
    if (!ex) continue;
    const url = /^(src|msg):/.test(ref) ? citationUrl(app, ref) : null;
    // Lines of one chat share an entry (opening at the first one cited).
    const key = url?.replace(/&position=\d+$/, "") ?? ref.replace(/#.*$/, "");
    const g = groups.get(key) ?? { url, title: ex.title, excerpts: [] };
    if (ex.text && !g.excerpts.includes(ex.text)) g.excerpts.push(ex.text);
    groups.set(key, g);
  }
  const safe = (t: string) => t.replace(/[[\]]/g, (c) => (c === "[" ? "【" : "】")).replace(/[*_`<>]/g, "");
  return [...groups.values()]
    .slice(0, 5)
    .map((g) => {
      const head = g.url ? `[${safe(g.title)}](${g.url})` : safe(g.title);
      const quotes = g.excerpts.slice(0, 3).map((e) => `「${safe(e)}」`).join(" ");
      return `- ${head}${quotes ? `：${quotes}` : ""}${g.excerpts.length > 3 ? ` 等 ${g.excerpts.length} 处` : ""}`;
    })
    .join("\n");
}
