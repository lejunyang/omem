/**
 * Finds what sticks out on a page (used by scripts/screens.ts and scripts/doc-screens.ts). The page itself
 * clips its sides, so comparing the document's scrollWidth with its width misses an element that runs past
 * its own card. Three kinds, each with a selector path and how many pixels:
 *
 * - 超出视口: a visible element whose right edge, after the clipping of its ancestors, is past the viewport.
 * - 伸出: text or a child box reaching past the right edge of a box whose `overflow-x` is visible.
 * - 被裁掉: text (or a box with text) cut off on the right by an ancestor with `overflow: hidden` / `clip`,
 *   unless that is a deliberate one-line ellipsis (`text-overflow: ellipsis`).
 *
 * Inside a container meant to scroll sideways nothing counts: an authored `overflow-x: auto | scroll`, a
 * `pre`, a table's wrapper, form fields. A box that only scrolls vertically (`overflow-y: auto`, which the
 * browser also computes as `overflow-x: auto`) is not one: text running past it is reported. An element
 * (or its ancestor) with `data-overflow-ok` is left out. A hover background made wider with a negative margin
 * is reported (it widens the column); reach past the text with `box-shadow` instead (omem-design).
 */
import type { Page } from "playwright";

export type OverflowIssue = { kind: "超出视口" | "伸出" | "被裁掉"; path: string; px: number; text: string };

/** Runs in the page: plain JavaScript (no imports, no closures over this module). */
function scan(): OverflowIssue[] {
  const vw = document.documentElement.clientWidth;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const css = (el: Element) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  // Selectors that set overflow-x to auto / scroll on purpose (the computed value cannot tell it from overflow-y: auto).
  const sideways: string[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule) {
        const x = r.style.getPropertyValue("overflow-x").trim();
        if (x === "auto" || x === "scroll") sideways.push(r.selectorText);
        if (r.cssRules?.length) collect(r.cssRules);
      } else if (r instanceof CSSMediaRule) {
        if (matchMedia(r.conditionText).matches) collect(r.cssRules);
      } else if ("cssRules" in r && (r as CSSGroupingRule).cssRules) collect((r as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      collect(sheet.cssRules);
    } catch {
      // A cross-origin sheet (fonts): nothing of ours.
    }
  }
  const scrollsSideways = new Map<Element, boolean>();
  const isScroller = (el: Element) => {
    let v = scrollsSideways.get(el);
    if (v !== undefined) return v;
    const x = css(el).overflowX;
    v = false;
    if (x === "auto" || x === "scroll") {
      const tag = el.tagName;
      v = tag === "PRE" || tag === "TEXTAREA" || !!el.querySelector(":scope > table") ||
        (el as HTMLElement).style.overflowX === "auto" || (el as HTMLElement).style.overflowX === "scroll" ||
        sideways.some((sel) => {
          try {
            return el.matches(sel);
          } catch {
            return false;
          }
        });
    }
    scrollsSideways.set(el, v);
    return v;
  };
  const skipTag = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BR", "HEAD"]);
  /** Left out: hidden, inside something meant to scroll sideways, inside SVG, or marked as fine. */
  const excluded = new Map<Element, boolean>();
  const isExcluded = (el: Element): boolean => {
    let v = excluded.get(el);
    if (v !== undefined) return v;
    const s = css(el);
    v = skipTag.has(el.tagName) || s.display === "none" || s.visibility === "hidden" || el.hasAttribute("data-overflow-ok") ||
      (el instanceof SVGElement && el.tagName.toLowerCase() !== "svg");
    if (!v && el.parentElement && el.parentElement !== document.documentElement) v = isExcluded(el.parentElement) || isScroller(el.parentElement);
    excluded.set(el, v);
    return v;
  };
  const inline = (el: Element) => ["inline", "contents"].includes(css(el).display);
  /** The box text or a child is measured against: the nearest ancestor that is not inline. */
  const boxOf = (el: Element | null) => {
    while (el && el !== document.body && inline(el)) el = el.parentElement;
    return el;
  };
  const innerRight = (el: Element) => el.getBoundingClientRect().left + el.clientLeft + el.clientWidth;
  /** On the way from `el` up to `box`, a one-line ellipsis: cut off on purpose. */
  const ellipsis = (el: Element | null, box: Element) => {
    for (let e = el; e; e = e.parentElement) {
      if (css(e).textOverflow === "ellipsis") return true;
      if (e === box) break;
    }
    return false;
  };
  /** How far right anything inside `el` can be seen: the tightest clipping ancestor's inner edge. */
  const clipRight = (el: Element) => {
    let right = Infinity;
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      if (css(e).overflowX !== "visible") right = Math.min(right, innerRight(e));
    }
    return right;
  };
  const name = (el: Element) => {
    const cls = Array.from(el.classList).filter((c) => !c.startsWith("data-v")).slice(0, 2);
    let n = el.tagName.toLowerCase() + (el.id && !/\d{3,}/.test(el.id) ? `#${el.id}` : "") + cls.map((c) => `.${c}`).join("");
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName && c.className === el.className);
      if (same.length > 1) n += `:nth-of-type(${Array.from(parent.children).filter((c) => c.tagName === el.tagName).indexOf(el) + 1})`;
    }
    return n;
  };
  const path = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && parts.length < 5; e = e.parentElement) parts.unshift(name(e));
    return parts.join(" > ");
  };
  const snippet = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  const hasText = (el: Element) => !!(el.textContent ?? "").trim();
  const found = new Map<string, OverflowIssue>();
  const add = (kind: OverflowIssue["kind"], el: Element, px: number) => {
    if (px <= 1) return;
    const key = `${kind} ${path(el)}`;
    const prev = found.get(key);
    if (!prev || prev.px < px) found.set(key, { kind, path: path(el), px: Math.round(px), text: snippet(el) });
  };

  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (isExcluded(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const s = css(el);
    if (s.position === "fixed") continue;
    // (a) past the viewport, as far as it can be seen
    const seen = Math.min(r.right, clipRight(el));
    if (seen > vw + 1 && !inline(el)) add("超出视口", el, seen - vw);
    // (b)/(c) a box child past its parent's edge (in-flow children; popovers and decorations are absolute)
    if (inline(el) || s.position === "absolute") continue;
    const box = boxOf(el.parentElement);
    if (!box || box === document.body || isScroller(box) || ellipsis(box, box)) continue;
    const over = r.right - innerRight(box);
    if (over <= 1) continue;
    if (css(box).overflowX !== "visible") {
      if (hasText(el)) add("被裁掉", el, over);
    } else if (clipRight(box) < r.right - 1) {
      // Showing past its box, then cut off further up: 被裁掉 when it has text (an ellipsis up there is on purpose).
      if (hasText(el) && !ellipsis(box, document.body)) add("被裁掉", el, over);
    } else add("伸出", el, over);
  }
  // Text: a run of text past the box it is laid out in.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    const parent = n.parentElement;
    if (!parent || isExcluded(parent)) continue;
    const box = boxOf(parent);
    if (!box || box === document.body || isScroller(box)) continue;
    range.selectNodeContents(n);
    let right = -Infinity;
    for (const rect of Array.from(range.getClientRects())) if (rect.width > 0) right = Math.max(right, rect.right);
    const over = right - innerRight(box);
    if (over <= 1) continue;
    const at = parent === box ? box : parent;
    if (ellipsis(parent, document.body)) continue;
    // Past a box that lets it show: 伸出, unless a clipping ancestor further up cuts it off (被裁掉).
    if (css(box).overflowX === "visible" && clipRight(box) >= right - 1) add("伸出", at, over);
    else add("被裁掉", at, over);
  }
  return Array.from(found.values()).sort((a, b) => b.px - a.px);
}

export async function overflowIssues(page: Page): Promise<OverflowIssue[]> {
  return page.evaluate(scan);
}

/** One block per page: a heading, then one line per problem (the widest first, at most `max`). */
export function overflowReport(label: string, issues: OverflowIssue[], max = 25) {
  if (!issues.length) return `${label}：没有溢出`;
  const lines = issues.slice(0, max).map((i) => `  ${i.kind} +${i.px}px  ${i.path}${i.text ? `  「${i.text}」` : ""}`);
  if (issues.length > max) lines.push(`  ……还有 ${issues.length - max} 处`);
  return [`${label}：${issues.length} 处溢出`, ...lines].join("\n");
}

/** OVERFLOW_REPORT_ONLY=1 or --report-only: print the problems without failing. */
export const reportOnly = () => !!process.env.OVERFLOW_REPORT_ONLY || process.argv.includes("--report-only");
