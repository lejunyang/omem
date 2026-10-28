import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import type { Notification } from "../core/notify.ts";
import { notificationOrigins, resolveCitations } from "./common.ts";
import { buildCard, type CardButton } from "./lark-send.ts";
import { webLink } from "../core/util.ts";

/** Page links (#/...) open from Feishu once the web address is configured (config.webUrl). */
function linkButton(app: App, link: string | null): CardButton[] {
  if (!link) return [];
  try {
    const url = new URL(webLink(app, link));
    if (url.protocol === "https:" || url.protocol === "http:") return [{ text: "打开链接", url: url.href }];
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
  return buildCard({
    title: n.title,
    color: "grey",
    blocks: [
      { markdown: n.body || " " },
      ...(reopen.length ? [{ buttons: reopen }] : []),
      ...(keep.length ? [{ buttons: keep }] : []),
      ...(more > 0 ? [{ note: `另有 ${more} 件，在网页“事项”里处理` }] : []),
    ],
  });
}

export function notificationCard(app: App, n: Notification) {
  if (n.digest) return itemDigestCard(app, n);
  if (n.entity === "item" && n.entityId) return itemNotificationCard(app, n);
  const buttons = linkButton(app, n.link);
  return buildCard({
    title: n.title,
    blocks: [
      { markdown: resolveCitations(app, n.body) || " " },
      ...(buttons.length ? [{ buttons }] : []),
    ],
  });
}

export function itemNotificationCard(app: App, n: Notification) {
  // Details can contain older citations too; only this notification's evidence becomes links.
  const scopedBody = n.body.replace(/\[([^\]]*)\]\(((?:src|mem|msg):[^)]+)\)/g, (all, label: string, ref: string) => (n.sourceRefs ?? []).includes(ref) ? all : label);
  // Share the final URL set across the body and origin block; keep repeated labels as text.
  const urls = new Set<string>();
  const uniqueLinks = (markdown: string) => markdown.replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, (link, label: string, url: string) => {
    if (urls.has(url)) return label;
    urls.add(url);
    return link;
  });
  const body = uniqueLinks(resolveCitations(app, scopedBody));
  const links = uniqueLinks(notificationOrigins(app, n.sourceRefs ?? []));
  const origin = links ? `**来源**\n${links}` : "";
  return buildCard({
    title: n.title,
    color: "blue",
    blocks: [
      { markdown: body || " " },
      ...(origin ? [{ markdown: origin }] : []),
      {
        buttons: [
          { text: "已处理", value: `item:done:${n.entityId}`, style: "primary" },
          { text: "忽略", value: `item:cancel:${n.entityId}` },
          ...linkButton(app, n.link).filter((b) => !urls.has(b.url!)),
          ...((n.actions ?? []).map((a) => ({ text: a.label, value: `item:act:${n.entityId}:${a.action}`, ...(a.style ? { style: a.style } : {}) }))),
        ],
      },
    ],
  });
}
