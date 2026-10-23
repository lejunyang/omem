import type { App } from "../core/app.ts";
import type { Notification } from "../core/notify.ts";
import { notificationOrigins, resolveCitations } from "./common.ts";
import { buildCard, type CardButton } from "./lark-send.ts";

function linkButton(link: string | null): CardButton[] {
  if (!link) return [];
  try {
    const url = new URL(link);
    if (url.protocol === "https:" || url.protocol === "http:") return [{ text: "打开链接", url: url.href }];
  } catch { /* Internal routes and invalid URLs cannot be opened from Feishu. */ }
  return [];
}

export function notificationCard(app: App, n: Notification) {
  if (n.entity === "item" && n.entityId) return itemNotificationCard(app, n);
  const buttons = linkButton(n.link);
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
          ...linkButton(n.link).filter((b) => !urls.has(b.url!)),
          ...((n.actions ?? []).map((a) => ({ text: a.label, value: `item:act:${n.entityId}:${a.action}`, ...(a.style ? { style: a.style } : {}) }))),
        ],
      },
    ],
  });
}
