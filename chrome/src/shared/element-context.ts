// 拾取时记下的元素信息（发给 omem 用）：位置、属性、文本、精简后的 HTML、子元素概况。
// 元素可能很大（整个列表、整页容器），所以每一项都有上限：文本留头尾、HTML 只展开几层、子元素按种类计数。
// 这里的函数只依赖一个很小的节点接口，单元测试可以用普通对象代替 DOM。

export interface ElementContext {
  /** 能在 DevTools 里 document.querySelector 回去的路径；太深时只留最近几层 */
  path: string;
  /** id、class、data-*、aria-*、role 等有用的属性；值过长截断，密码框不记值 */
  attributes: Record<string, string>;
  /** 可访问名：aria-label、alt、title 或文本开头 */
  name: string;
  text: ClippedText;
  /** 精简后的 outerHTML */
  html: string;
  children: { count: number; descendants: number; summary: string };
  /** 元素前面最近的标题，帮助判断它在页面哪一块 */
  heading: string;
}

export interface ClippedText {
  value: string;
  /** 原文总字数 */
  total: number;
  truncated: boolean;
}

export interface PageContext {
  url: string;
  title: string;
  description: string;
  lang: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  userAgent: string;
  /** 拾取时页面上选中的文字 */
  selection: string;
}

/** 最小节点接口：DOM 的 Element / Text 都满足。 */
export interface NodeLike {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
}
export interface ElementLike extends NodeLike {
  tagName: string;
  id: string;
  classList: ArrayLike<string>;
  attributes: ArrayLike<{ name: string; value: string }>;
  parentElement: ElementLike | null;
  children: ArrayLike<ElementLike>;
  getAttribute(name: string): string | null;
}

const ELEMENT = 1;
const TEXT = 3;

/** 空白合并；超长时留开头 3/4、结尾 1/5，中间注明省略了多少。 */
export function clipText(input: string, max = 400): ClippedText {
  const value = input.replace(/\s+/g, " ").trim();
  const total = value.length;
  if (total <= max) return { value, total, truncated: false };
  const head = Math.floor(max * 0.75);
  const tail = Math.floor(max * 0.2);
  return { value: `${value.slice(0, head)} …（省略 ${total - head - tail} 字）… ${value.slice(total - tail)}`, total, truncated: true };
}

/** css-1x2y3z、sc-AbCdE、_3Fx9k 这类构建工具生成的类名：每次构建都会变，放进路径里没用。 */
export function isGeneratedClass(name: string): boolean {
  if (/^(css|sc|jsx|emotion|styled|chakra)-/i.test(name)) return true;
  if (/^_?[a-zA-Z0-9]{5,}$/.test(name) && /\d/.test(name) && /[a-zA-Z]/.test(name) && (name.match(/\d/g)?.length ?? 0) >= 2 && !/^[a-z]+\d{1,2}$/.test(name)) return true;
  return /__[a-zA-Z0-9]{5,}$/.test(name) || /^[a-z]+-[a-f0-9]{6,}$/i.test(name);
}

const cssEscape = (value: string) => value.replace(/([^\w-])/g, "\\$1");

/** 一层的选择器：标签 + id 或最多两个稳定的类名 + 同类兄弟中的序号。 */
function step(element: ElementLike): string {
  const tag = element.tagName.toLowerCase();
  if (element.id && !isGeneratedClass(element.id)) return `${tag}#${cssEscape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId) return `${tag}[data-testid="${testId.replace(/"/g, '\\"')}"]`;
  const classes = Array.from(element.classList).filter((name) => !isGeneratedClass(name)).slice(0, 2);
  let selector = tag + classes.map((name) => `.${cssEscape(name)}`).join("");
  const parent = element.parentElement;
  if (parent) {
    const same = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    if (same.length > 1) selector += `:nth-of-type(${same.indexOf(element) + 1})`;
  }
  return selector;
}

/**
 * 从元素往上到有 id 的祖先或 body；最多 maxDepth 层，更深的用 “… >” 表示省略。
 * 元素自己有 id 时也继续往上走：选择器已经唯一，多带几层是为了看出它在页面哪一块。
 */
export function cssPath(element: ElementLike, maxDepth = 7): string {
  const steps: string[] = [];
  let current: ElementLike | null = element;
  let truncated = false;
  while (current && !["HTML", "BODY"].includes(current.tagName.toUpperCase())) {
    if (steps.length >= maxDepth) {
      truncated = true;
      break;
    }
    const part = step(current);
    steps.unshift(part);
    if (steps.length > 1 && part.includes("#") && !part.includes(":nth")) break;
    current = current.parentElement;
  }
  return `${truncated ? "… > " : ""}${steps.join(" > ")}`;
}

const KEPT_ATTRIBUTES = new Set(["id", "class", "role", "name", "type", "href", "src", "alt", "title", "placeholder", "for", "value", "tabindex", "disabled", "checked", "target", "rel", "action", "method"]);

/**
 * 留下对定位和理解有用的属性：id、class、data-*、aria-* 等；丢掉事件处理器和 style。
 * 值超过 160 字截断，data: URI 只留类型；密码和看起来像密钥的值不记。
 */
export function pickAttributes(attributes: ArrayLike<{ name: string; value: string }>, tag: string, max = 30): Record<string, string> {
  const out: Record<string, string> = {};
  const isPassword = Array.from(attributes).some((a) => a.name === "type" && a.value.toLowerCase() === "password");
  for (const { name, value } of Array.from(attributes)) {
    const key = name.toLowerCase();
    if (Object.keys(out).length >= max) break;
    if (!(KEPT_ATTRIBUTES.has(key) || key.startsWith("data-") || key.startsWith("aria-"))) continue;
    if (key === "value" && (isPassword || tag.toLowerCase() !== "input")) continue;
    if (/token|secret|password|auth/i.test(key)) continue;
    let v = value;
    if (/^data:/i.test(v)) v = `${v.slice(0, v.indexOf(",") > 0 ? Math.min(v.indexOf(","), 40) : 30)},…（${v.length} 字）`;
    else if (v.length > 160) v = `${v.slice(0, 150)}…（${v.length} 字）`;
    out[key] = v;
  }
  return out;
}

/** 子元素按“标签.类名”计数，最多列 8 种：li.item ×24、div.footer ×1。 */
export function summarizeChildren(children: ArrayLike<ElementLike>, limit = 8): string {
  const counts = new Map<string, number>();
  for (const child of Array.from(children)) {
    const cls = Array.from(child.classList).find((name) => !isGeneratedClass(name));
    const key = `${child.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit).map(([key, n]) => `${key} ×${n}`);
  if (entries.length > limit) shown.push(`另有 ${entries.length - limit} 种`);
  return shown.join("、");
}

export function countDescendants(element: ElementLike, cap = 5000): number {
  let count = 0;
  const stack = Array.from(element.children);
  while (stack.length && count < cap) {
    const node = stack.pop()!;
    count += 1;
    stack.push(...Array.from(node.children));
  }
  return count;
}

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META"]);

/**
 * 精简的 outerHTML：只展开 depth 层，每层最多 width 个子元素，文本截到 80 字，
 * svg 只留开头标签，script/style 去掉；超过 maxLength 就停下并注明。
 */
export function htmlSnippet(element: ElementLike, opts: { depth?: number; width?: number; maxLength?: number } = {}): string {
  const depth = opts.depth ?? 3;
  const width = opts.width ?? 6;
  const maxLength = opts.maxLength ?? 3000;
  let out = "";
  let stopped = false;
  const write = (text: string) => {
    if (stopped) return;
    if (out.length + text.length > maxLength) {
      out += "\n<!-- 内容较长，后面省略 -->";
      stopped = true;
      return;
    }
    out += text;
  };
  const attrs = (el: ElementLike) =>
    Object.entries(pickAttributes(el.attributes, el.tagName, 12))
      .map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`)
      .join("");
  const visit = (node: NodeLike, level: number, indent: string) => {
    if (stopped) return;
    if (node.nodeType === TEXT) {
      const text = clipText(node.textContent ?? "", 80).value;
      if (text) write(`${indent}${text}\n`);
      return;
    }
    if (node.nodeType !== ELEMENT) return;
    const el = node as ElementLike;
    const tag = el.tagName.toLowerCase();
    if (SKIPPED_TAGS.has(el.tagName.toUpperCase())) return;
    if (tag === "svg") {
      write(`${indent}<svg${attrs(el)}>…</svg>\n`);
      return;
    }
    const kids = Array.from(el.childNodes).filter((child) => child.nodeType === ELEMENT || (child.nodeType === TEXT && (child.textContent ?? "").trim()));
    if (!kids.length) {
      write(`${indent}<${tag}${attrs(el)}></${tag}>\n`);
      return;
    }
    if (level >= depth) {
      const inner = clipText(el.textContent ?? "", 60).value;
      write(`${indent}<${tag}${attrs(el)}>${inner ? `${inner} ` : ""}<!-- ${el.children.length} 个子元素 --></${tag}>\n`);
      return;
    }
    write(`${indent}<${tag}${attrs(el)}>\n`);
    kids.slice(0, width).forEach((child) => visit(child, level + 1, `${indent}  `));
    if (kids.length > width) write(`${indent}  <!-- 还有 ${kids.length - width} 个子节点 -->\n`);
    write(`${indent}</${tag}>\n`);
  };
  visit(element, 0, "");
  return out.trimEnd();
}

/** 元素的可访问名：aria-label、alt、title，没有就取文本开头。 */
export function accessibleName(element: ElementLike): string {
  const label = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title");
  return clipText(label || element.textContent || "", 60).value;
}
