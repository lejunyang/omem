import { reactive, watch } from "vue";

/**
 * What the owner gathered on a run page by selecting text (diff lines, the task, a review, a cited
 * document): numbered quotes for one question to the assistant (`ask`), or for the next round of
 * changes (`fix`). Kept per run in this browser until sent, so a reload or a detour keeps them.
 */
export type Quote = { id: string; quote: string; label: string; note?: string };
export type QuoteKind = "ask" | "fix";
type Basket = Record<QuoteKind, Quote[]>;

const KEY = "omem.quotes";
const load = (): Record<string, Basket> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const baskets = reactive<Record<string, Basket>>(load());
watch(baskets, (b) => {
  try {
    // Empty baskets are not worth keeping.
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(b).filter(([, x]) => x.ask.length || x.fix.length))));
  } catch {
    /* private mode */
  }
}, { deep: true });

export function quotesOf(runId: string, kind: QuoteKind): Quote[] {
  return baskets[runId]?.[kind] ?? [];
}

export function addQuote(runId: string, kind: QuoteKind, q: Omit<Quote, "id">) {
  baskets[runId] ??= { ask: [], fix: [] };
  const list = baskets[runId][kind];
  // The same passage twice is one quote.
  if (list.some((x) => x.quote === q.quote && x.label === q.label)) return list.length;
  list.push({ ...q, id: Math.random().toString(36).slice(2, 10) });
  return list.length;
}

export function removeQuote(runId: string, kind: QuoteKind, id: string) {
  const b = baskets[runId];
  if (b) b[kind] = b[kind].filter((x) => x.id !== id);
}

export function clearQuotes(runId: string, kind: QuoteKind) {
  if (baskets[runId]) baskets[runId][kind] = [];
}

const fence = (s: string) => `${"```"}\n${s.replace(/```/g, "ˋˋˋ")}\n${"```"}`;

/** Quotes as numbered Markdown, each fenced so code keeps its lines; a fix quote carries what to change. */
export function quotesText(list: Quote[], heading: string) {
  if (!list.length) return "";
  return [heading, ...list.map((q, i) => `[${i + 1}] ${q.label}：\n\n${fence(q.quote)}${q.note?.trim() ? `\n\n要求：${q.note.trim()}` : ""}`)].join("\n\n");
}

/**
 * The rest of the next round's request on a run page: the owner's own text and the review the
 * rounds get from now on. One draft per run, shared by the 概览 fix box and the 修改点 drawer, kept
 * in this browser until the fix starts — switching tabs or reloading does not lose it.
 */
/** `rotate`: "" keeps the tier's setting, "on" / "off" overrides it (another model each round). */
export type FixDraft = { text: string; tier: string; split: boolean; rotate?: "" | "on" | "off"; ai: { agent?: string; model?: string; effort?: string } };
const DRAFT_KEY = "omem.fixDrafts";
const loadDrafts = (): Record<string, FixDraft> => {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const drafts = reactive<Record<string, FixDraft>>(loadDrafts());
watch(drafts, (d) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(Object.fromEntries(Object.entries(d).filter(([, x]) => x.text.trim() || x.tier || !x.split || x.rotate || x.ai.agent))));
  } catch {
    /* private mode */
  }
}, { deep: true });

export function fixDraft(runId: string): FixDraft {
  drafts[runId] ??= { text: "", tier: "", split: true, rotate: "", ai: {} };
  return drafts[runId];
}

export function clearFixDraft(runId: string) {
  delete drafts[runId];
}

/** The draft's review choice as the fix request sends it (nothing when left as it was). */
export function draftReview(d: FixDraft) {
  const review = { ...(d.tier ? { tier: d.tier } : {}), ...(!d.split ? { split: false } : {}), ...(d.rotate ? { rotate: d.rotate === "on" } : {}) };
  return {
    ...(Object.keys(review).length ? { review } : {}),
    ...(d.ai.agent ? { reviewAi: { profile: d.ai.agent, ...(d.ai.model ? { model: d.ai.model } : {}), ...(d.ai.effort ? { effort: d.ai.effort } : {}) } } : {}),
  };
}
