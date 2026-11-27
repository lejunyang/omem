import type { App } from "../core/app.ts";
import { webLink } from "../core/util.ts";
import type { Ask } from "../agents/asks.ts";
import type { Item } from "../items/store.ts";
import type { AskUi, Tone, ViewComponent } from "../agents/ui-blocks.ts";

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
  parts: { current?: string; before?: string; result?: string; problem?: string; plan?: string; next?: string; evidence?: string; textAction?: string }): StageCard {
  const status = kind === "owner-turn" || kind === "owner" ? "到你了" : kind === "blocked" ? "卡住了" : kind === "gate" || kind === "when" ? "等你确认开始" : kind === "done" ? "等你确认做完" : "需要你";
  const title = `「${stage.name}」${status}`;
  return { title, itemTitle: item.title, flowUrl: webLink(app, `#/items/${item.id}/flow?stage=${encodeURIComponent(stage.id)}`),
    discussUrl: webLink(app, `#/ask?${new URLSearchParams({ space: item.spaceId, draft: `关于事项「${item.title}」（${item.id}）流程里的${title}\n\n` })}`),
    // Each label once: what a stage's carrier wrote keeps its own bold headings ("现在", "依据"), so the
    // card's labels around it say where it comes from ("前面", "结果") instead of repeating them.
    sections: [["现在", parts.current], ["前面", parts.before], ["结果", parts.result],
      [kind === "owner-turn" ? "这一段要做什么" : kind === "blocked" ? "卡点" : kind === "gate" ? "为什么问你" : "要你定的事", parts.problem],
      [kind === "blocked" ? "建议的做法" : "这一段做什么", parts.plan], ["接下来", parts.next], ["依据", parts.evidence]]
      .flatMap(([label, text]) => text?.trim() ? [{ label: label!, text }] : []),
    textAction: parts.textAction ?? stageCardLabels.text };
}

/** The section that says what is asked of the person, by the stage's state: set off as a callout. */
const ASKED = new Set(["这一段要做什么", "卡点", "为什么问你", "要你定的事"]);
const STATUS_TONE: Record<string, Tone> = { 卡住了: "danger", 到你了: "warning", 等你确认开始: "info", 等你确认做完: "success" };
/** Supporting evidence is folded once the card is long or the evidence itself is. */
const LONG = 1200;

/**
 * A stage card as the host's card layout (shared by Feishu and the web): the stage as the title, the
 * item under it, the state as a tag; what is asked set off, the evidence folded, the item's flow as a
 * button. Read off the stored card, so cards asked before this layout look the same.
 */
export function stageCardUi(card: StageCard): AskUi {
  const m = /^「(.+)」(.+)$/.exec(card.title);
  const status = m?.[2] ?? "需要你";
  const tone = STATUS_TONE[status] ?? "warning";
  const total = card.sections.reduce((n, s) => n + s.text.length, 0);
  const view: ViewComponent[] = card.sections.map(({ label, text }): ViewComponent =>
    ASKED.has(label) ? { type: "callout", tone: label === "为什么问你" || label === "这一段要做什么" ? "info" : "warning", title: label, text: text.slice(0, 2000) }
    : label === "依据" && (total > LONG || text.length > 400) ? { type: "fold", title: label, text: text.slice(0, 6000) }
    // A hard line break: the label right above its text in Feishu and on the web alike.
    : { type: "markdown", text: `**${label}**  \n${text}`.slice(0, 6000) });
  return {
    head: { title: m ? `「${m[1]}」` : card.title, subtitle: card.itemTitle, tag: { text: status, tone } },
    body: "",
    ...(view.length ? { view } : {}),
    links: [{ text: "事项流程页", url: card.flowUrl }, { text: stageCardLabels.discuss, url: card.discussUrl }].filter((l) => /^https?:/.test(l.url)),
  };
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
