import type { App } from "../core/app.ts";
import { webLink } from "../core/util.ts";
import type { Ask } from "../agents/asks.ts";
import type { Item } from "../items/store.ts";

export type StageCard = {
  title: string;
  itemTitle: string;
  flowUrl: string;
  discussUrl: string;
  sections: { label: string; text: string }[];
  textAction: string;
};

export const stageCardLabels = { resume: "让助手接着做", handled: "我已处理，继续", hold: "先不处理", text: "按这句话处理", discuss: "在对话里讨论" };

export function stageCard(app: App, item: Item, stage: { id: string; name: string }, kind: string,
  parts: { current?: string; problem: string; plan?: string; evidence?: string; textAction?: string }): StageCard {
  const status = kind === "owner-turn" ? "到你了" : kind === "blocked" ? "卡住了" : kind === "gate" || kind === "when" ? "等你确认开始" : kind === "done" ? "等你确认做完" : "需要你";
  const title = `「${stage.name}」${status}`;
  return { title, itemTitle: item.title, flowUrl: webLink(app, `#/items/${item.id}/flow?stage=${encodeURIComponent(stage.id)}`),
    discussUrl: webLink(app, `#/ask?${new URLSearchParams({ space: item.spaceId, draft: `关于事项「${item.title}」（${item.id}）流程里的${title}\n\n` })}`),
    sections: [["现在", parts.current], [kind === "owner-turn" ? "这一段要做什么" : kind === "blocked" ? "卡点" : "要你定的事", parts.problem], ["建议的做法", parts.plan], ["依据", parts.evidence]]
      .flatMap(([label, text]) => text?.trim() ? [{ label: label!, text }] : []),
    textAction: parts.textAction ?? stageCardLabels.text };
}

export function stageCardText(card: StageCard) {
  return [`**${card.title}**`, `事项：${card.itemTitle}　[事项流程页](${card.flowUrl})`,
    ...card.sections.map(({ label, text }) => `**${label}**\n${text}`)].join("\n\n");
}

export function flowEvidenceLinks(app: App, itemId: string, evidence: string[]) {
  return [...new Set(evidence.map(ref => /^(src|msg):/.test(ref) ? `[看原文](${ref})` : ref.startsWith("object:") ? `[看事项上的对象](${webLink(app, `#/work/${itemId}`)})` : ref.startsWith("design:") ? `[看方案](${webLink(app, `#/designs/${ref.slice(7)}`)})` : `[看运行](${webLink(app, `#/runs/${ref.replace(/^(run:|code-work:)/, "")}`)})`))].join("　");
}

export function stageCardActions(ask: Ask) {
  return { options: ask.options.map(({ label }, choice) => ({ label, choice })), textAction: ask.allowText ? ask.stageCard?.textAction : undefined };
}

export function appendCardEvidence(card: StageCard, text: string): StageCard {
  const evidence = card.sections.find(section => section.label === "依据");
  return { ...card, sections: [...card.sections.filter(section => section !== evidence), { label: "依据", text: [evidence?.text, text].filter(Boolean).join("\n\n") }] };
}
