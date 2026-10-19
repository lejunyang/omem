import type { App } from "../core/app.ts";
import type { Notification } from "../core/notify.ts";
import { notificationOrigins, resolveCitations } from "./common.ts";
import { buildCard } from "./lark-send.ts";

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
          ...((n.actions ?? []).map((a) => ({ text: a.label, value: `item:act:${n.entityId}:${a.action}`, ...(a.style ? { style: a.style } : {}) }))),
        ],
      },
    ],
  });
}
