import { ask } from "../agents/jobs.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";

/**
 * Shared path for chat channels (Feishu, Telegram, QQ via OneBot…): the
 * owner's message becomes an assistant turn in a per-chat conversation, and
 * the answer comes back as plain Markdown with internal citation links
 * reduced to their labels (other apps cannot open them).
 */
export async function answerFromChannel(app: App, input: { channel: string; chatId: string; text: string; spaceId?: string }) {
  const { runId } = ask(app, { text: input.text, spaceId: input.spaceId ?? "personal", channel: input.channel, externalId: input.chatId });
  const r = await waitForRun(app, runId);
  const answer = r.status === "done" ? String((getRun(app, runId).output as { answer?: string }).answer ?? "") : `处理失败：${r.error ?? r.status}`;
  return plainCitations(answer);
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
