import { fmt } from "./time";
import { escapeHtml, highlight, languageOf, renderMarkdown } from "./markdown";

/**
 * What a read-only share holds (src/core/shares.ts) and how its parts are drawn: opened by anyone
 * with the link, without a token, so nothing in it may lead back into omem except the share's own
 * copied items (`#ev-<n>` in a shared review).
 */
export type ShareItem = { i: number; mark?: number; label: string } & (
  | { kind: "source"; title: string; sourceKind: string; path: string; from: number | null; to: number | null; start: number; lines: string[]; total: number; format: "code" | "markdown" | "text" }
  | { kind: "memory"; title: string; text: string; status: string; createdAt: string }
  | { kind: "message"; title: string; text: string; at: string }
  | { kind: "page"; title: string; section: string | null; markdown: string }
  | { kind: "review"; title: string; verdict: string | null; summary: string; branches: { repo: string; branch: string; base: string | null }[]; findings: ReviewFinding[]; at: string }
);
export type ReviewFinding = { n: number; severity: string; title: string; detail: string; suggestion: string; file: string | null; line: number | null; at?: number | null; decision: "fix" | "later" | "wontfix"; note: string; resolution: string | null };
export type SourceItem = Extract<ShareItem, { kind: "source" }>;
export type ReviewItem = Extract<ShareItem, { kind: "review" }>;

export const when = (iso: string | null) => (iso ? fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const KIND: Record<string, string> = { code: "代码", work: "工作文件", doc: "文档", note: "笔记", web: "网页", chat: "聊天", conversation: "对话", image: "图片" };

/** Rendered Markdown with everything that would lead back into omem made inert; `#ev-<n>` stays a link to copied item n. */
export function safe(md: string) {
  const box = document.createElement("template");
  box.innerHTML = renderMarkdown(md);
  for (const a of box.content.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = a.getAttribute("href") ?? "";
    const ev = /^#ev-(\d+)$/.exec(href);
    if (ev) {
      a.setAttribute("href", `#ev-${ev[1]}`);
      a.dataset.ev = ev[1];
      a.className = "ev";
      for (const k of ["target", "rel"]) a.removeAttribute(k);
    } else if (a.dataset.cite || a.dataset.wiki || !/^https?:/i.test(href)) {
      const span = document.createElement("span");
      span.textContent = a.textContent;
      a.replaceWith(span);
    } else a.setAttribute("rel", "noopener noreferrer");
  }
  for (const img of box.content.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")) {
    if (/^https?:/i.test(img.getAttribute("src") ?? "") && !/\/api\//.test(img.getAttribute("src") ?? "")) continue;
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = `（图片${img.getAttribute("alt") ? `：${img.getAttribute("alt")}` : ""}）`;
    img.replaceWith(span);
  }
  return box.innerHTML;
}

export function codeLines(it: SourceItem) {
  const lang = languageOf(it.path || it.title);
  return it.lines.map((l, k) => ({ n: it.start + k, html: highlight(l, lang) || "&nbsp;", hit: it.from !== null && it.start + k >= it.from && it.start + k <= (it.to ?? it.from) }));
}
export const textLines = (it: SourceItem) =>
  it.lines.map((l, k) => ({ n: it.start + k, html: escapeHtml(l) || "&nbsp;", hit: it.from !== null && it.start + k >= it.from && it.start + k <= (it.to ?? it.from) }));

export function where(it: ShareItem) {
  if (it.kind === "source") {
    const range = it.from ? `第 ${it.from}${it.to && it.to !== it.from ? `–${it.to}` : ""} 行` : "全文";
    return [KIND[it.sourceKind] ?? "原件", it.path && it.path !== it.title ? it.path : "", range].filter(Boolean).join(" · ");
  }
  if (it.kind === "memory") return `记忆 · ${when(it.createdAt)}${it.status !== "active" ? ` · ${it.status === "superseded" ? "已被更正" : "已撤回"}` : ""}`;
  if (it.kind === "message") return `对话 · ${when(it.at)}`;
  if (it.kind === "review") return `代码评审 · ${when(it.at)}`;
  return `Wiki${it.section ? ` · ${it.section}` : ""}`;
}
