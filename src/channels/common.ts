import { receive, type Inbound } from "../agents/inbox.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";

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
  hooks: { onStart?: (runId: string) => void | Promise<void>; onMerged?: () => void | Promise<void> } = {},
): Promise<string | null> {
  const r = await receive(app, input);
  if (r.reply !== null) return r.reply;
  if (r.merged || !r.runId) {
    await hooks.onMerged?.();
    return null;
  }
  await hooks.onStart?.(r.runId);
  const done = await waitForRun(app, r.runId);
  const answer = done.status === "done" ? String((getRun(app, r.runId).output as { answer?: string }).answer ?? "") : done.status === "cancelled" ? "（已停止）" : `处理失败：${done.error ?? done.status}`;
  const note = r.started === "renewed" ? "（距上次对话较久，已开始新会话并带上之前的摘要；/resume 可回到原会话）\n\n" : "";
  return note + plainCitations(answer);
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
