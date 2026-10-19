import { receive, type Inbound } from "../agents/inbox.ts";
import { getRun, waitForRun } from "../agents/runs.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { refExcerpt } from "../items/evidence.ts";

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
  return localPathLinks(app, plainCitations(withSources).replace(/\[([^\]]*)\]\(#\/[^)]*\)/g, "$1"));
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
    const resolved = ref.startsWith("src:") ? resolveCitations(app, `[x](${ref})`) : "";
    const url = /^\[x\]\((https?:\/\/.*)\)$/.exec(resolved)?.[1] ?? null;
    const key = url ?? ref.replace(/#.*$/, "");
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
