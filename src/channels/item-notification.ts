import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import type { Notification } from "../core/notify.ts";
import { notificationOrigins, resolveCitationsSync } from "./common.ts";
import { buildCard, uploadLark, type CardButton } from "./lark-send.ts";
import { artifactPath, artifactsByIds } from "../agents/artifacts.ts";
import { currentBot } from "../core/bot-context.ts";
import { webLink } from "../core/util.ts";
import { PROGRESS_TAIL } from "../flows/store.ts";

/** Page links (#/...) open from Feishu once the web address is configured (config.webUrl). */
function linkButton(app: App, link: string | null, text = "打开链接"): CardButton[] {
  if (!link) return [];
  try {
    const url = new URL(webLink(app, link));
    if (url.protocol === "https:" || url.protocol === "http:") return [{ text, url: url.href }];
  } catch { /* Internal routes and invalid URLs cannot be opened from Feishu. */ }
  return [];
}

/** The daily item digest: per-item buttons to reopen what closed by itself or keep what closes soon. */
export function itemDigestCard(app: App, n: Notification) {
  const title = (id: string) => {
    const t = one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? id;
    return t.length > 14 ? t.slice(0, 13) + "…" : t;
  };
  const MAX = 8;
  const reopen: CardButton[] = (n.digest?.closed ?? []).slice(0, MAX).map((id) => ({ text: `恢复 · ${title(id)}`, value: `item:reopen:${id}` }));
  const keep: CardButton[] = (n.digest?.soon ?? []).slice(0, MAX).map((id) => ({ text: `保留 · ${title(id)}`, value: `item:keep:${id}` }));
  const more = (n.digest?.closed.length ?? 0) + (n.digest?.soon.length ?? 0) - reopen.length - keep.length;
  // Candidates the assistant made on its own (items/auto.ts): one row each, 留下 or 不要.
  const candidates = (n.digest?.candidates ?? []).slice(0, 6).map((id) => [
    { text: `留下 · ${title(id)}`, value: `item:take:${id}`, style: "primary" as const },
    { text: "不要", value: `item:drop:${id}` },
  ] as CardButton[]);
  // Nightly replay's suggestions (agents/replay.ts): adopt or ignore each one.
  const effect = (id: string) => {
    const e = one<{ effect: string; target_id: string | null }>(app.db, "select effect, target_id from replay_effects where id = ?", id);
    const what = e?.effect === "level" ? "降为仅检索" : e?.effect === "rule" ? "改回一般关注" : e?.effect === "import" ? "建事项导入" : "采纳";
    const target = e?.target_id ? (e.target_id.length > 10 ? e.target_id.slice(0, 9) + "…" : e.target_id) : "";
    return [
      { text: `采纳 · ${what}${target ? ` ${target}` : ""}`, value: `replay:adopt:${id}` },
      { text: "忽略", value: `replay:ignore:${id}` },
    ] as CardButton[];
  };
  const effects = (n.digest?.effects ?? []).slice(0, 6);
  return buildCard({
    title: n.title,
    color: "grey",
    blocks: [
      { markdown: n.body || " " },
      ...(reopen.length ? [{ buttons: reopen }] : []),
      ...(keep.length ? [{ buttons: keep }] : []),
      ...(more > 0 ? [{ note: `另有 ${more} 件，在网页“事项”里处理` }] : []),
      ...candidates.map((buttons) => ({ buttons })),
      ...effects.map((id) => ({ buttons: effect(id) })),
      ...((n.digest?.effects?.length ?? 0) > effects.length ? [{ note: `另有 ${(n.digest?.effects?.length ?? 0) - effects.length} 条复盘建议，在网页“Agent”页处理` }] : []),
    ],
  });
}

/** A card's screenshot: Feishu's key for the uploaded image and what it shows. */
export type CardImage = { key: string; alt: string };
const uploaded = new Map<string, string>();
/** Upload the notification's screenshots with the bot sending it (keys are per app); one that fails is left out. */
export async function cardImages(app: App, n: Pick<Notification, "images">): Promise<CardImage[]> {
  const out: CardImage[] = [];
  for (const a of artifactsByIds(app, n.images ?? [])) {
    if (a.kind !== "image") continue;
    const cacheKey = `${currentBot()}:${a.id}`;
    try {
      let key = uploaded.get(cacheKey);
      if (!key) {
        const c = await uploadLark(artifactPath(app, a));
        if (!("image" in c)) continue;
        key = String(c.image);
        uploaded.set(cacheKey, key);
      }
      out.push({ key, alt: a.caption || a.name });
    } catch (e) {
      console.warn(`[omem] 通知卡片的截图 ${a.id} 没传上飞书：${(e as Error).message}`);
    }
  }
  return out;
}
const imageBlocks = (images: CardImage[]) => images.flatMap((i) => [{ image: i.key, alt: i.alt }, ...(i.alt ? [{ note: i.alt }] : [])]);

export function notificationCard(app: App, n: Notification, images: CardImage[] = []) {
  if (n.digest) return itemDigestCard(app, n);
  if (n.entity === "item" && n.entityId) return itemNotificationCard(app, n, images);
  const buttons = linkButton(app, n.link);
  return buildCard({
    title: n.title,
    ...(n.tone ? { color: n.tone === "warning" ? "orange" : "green" } : {}),
    blocks: [
      { markdown: resolveCitationsSync(app, n.body) || " " },
      ...imageBlocks(images),
      ...(buttons.length ? [{ buttons }] : []),
    ],
  });
}

/** Paragraphs of a markdown body; a code block with blank lines in it stays one paragraph. */
function paragraphs(markdown: string): string[] {
  const out: string[] = [];
  for (const p of markdown.trim().split(/\n\s*\n/)) {
    const open = out.length && ((out.at(-1)!.match(/```/g) ?? []).length % 2 === 1);
    if (open) out[out.length - 1] += `\n\n${p}`;
    else if (p.trim()) out.push(p);
  }
  return out;
}

/** Shown open on a progress card; what a stage said past this goes into a closed fold, never cut. */
const FLOW_OPEN = 900;

/**
 * An item's flow progress (flows/store.ts progress): what happened in bold, what the stage said (the
 * long part folded), then where the flow stands and what comes next, always open. Its only button
 * opens the flow page: 已处理 / 忽略 would close or drop the whole item, not answer this card.
 */
export function flowProgressCard(app: App, n: Notification, images: CardImage[] = []) {
  const ps = paragraphs(resolveCitationsSync(app, n.body));
  const tailAt = ps.findIndex((p, i) => i > 0 && p.startsWith(PROGRESS_TAIL[0]));
  const head = ps[0] ?? n.title, middle = ps.slice(1, tailAt < 0 ? undefined : tailAt), tail = tailAt < 0 ? [] : ps.slice(tailAt);
  const open: string[] = [], folded: string[] = [];
  for (const p of middle) (!folded.length && open.join("\n\n").length + p.length <= FLOW_OPEN ? open : folded).push(p);
  // Nothing fits: the first paragraph still shows, cut at a line, and the whole goes into the fold.
  const cut = !open.length && folded.length > 0;
  if (cut) open.push(folded[0].split("\n").reduce((a, l) => a.length + l.length > FLOW_OPEN ? a : a ? `${a}\n${l}` : l, "") || folded[0].slice(0, FLOW_OPEN) + "…");
  return buildCard({
    title: n.title,
    color: n.tone === "warning" ? "orange" : n.tone === "done" ? "green" : "blue",
    blocks: [
      { markdown: [head, ...open].join("\n\n") },
      ...(folded.length ? [{ fold: { title: cut ? "展开全文" : "更多情况", markdown: folded.join("\n\n") } }] : []),
      ...imageBlocks(images),
      ...(tail.length ? [{ markdown: tail.join("\n\n") }] : []),
      ...((b) => b.length ? [{ buttons: b.map((x) => ({ ...x, style: "primary" as const })) }] : [])(linkButton(app, n.link, "打开流程页")),
    ],
  });
}

export function itemNotificationCard(app: App, n: Notification, images: CardImage[] = []) {
  if (n.view === "flow") return flowProgressCard(app, n, images);
  // Details can contain older citations too; only this notification's evidence becomes links.
  const scopedBody = n.body.replace(/\[([^\]]*)\]\(((?:src|mem|msg):[^)]+)\)/g, (all, label: string, ref: string) => (n.sourceRefs ?? []).includes(ref) ? all : label);
  // Share the final URL set across the body and origin block; keep repeated labels as text.
  const urls = new Set<string>();
  const uniqueLinks = (markdown: string) => markdown.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (link, label: string, url: string) => {
    if (urls.has(url)) return label;
    urls.add(url);
    return link;
  });
  const body = uniqueLinks(resolveCitationsSync(app, scopedBody));
  const links = uniqueLinks(notificationOrigins(app, n.sourceRefs ?? []));
  const origin = links ? `**来源**\n${links}` : "";
  return buildCard({
    title: n.title,
    color: "blue",
    blocks: [
      { markdown: body || " " },
      ...imageBlocks(images),
      ...(origin ? [{ markdown: origin }] : []),
      {
        buttons: [
          // Closing or cancelling the item fits a nudge to finish it, not a suggestion or an update about it.
          ...(n.plain ? [] : [{ text: "已处理", value: `item:done:${n.entityId}`, style: "primary" as const }, { text: "忽略", value: `item:cancel:${n.entityId}` }]),
          ...linkButton(app, n.link).filter((b) => !urls.has(b.url!)),
        ],
      },
    ],
  });
}
