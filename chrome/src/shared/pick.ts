import { normalizeStoredList } from "./stored-list";

// 「拾取」的数据模型和纯计算：样式整理、间距测量、截图裁剪与拼接规划、导出 Markdown。
// 页面内容脚本、后台和侧栏共用，不依赖 DOM 或 chrome API，便于单元测试。

export type PickKind = "element" | "region" | "viewport" | "page";

export interface PickRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PickStyleItem {
  label: string;
  value: string;
  /** 颜色项带上色值，界面画色块。 */
  color?: string;
}

export interface PickStyleGroup {
  title: string;
  items: PickStyleItem[];
}

export interface PickElement {
  /** 给人看的简短选择器：tag#id.class1.class2 */
  selector: string;
  tag: string;
  text: string;
  /** 页面坐标（CSS px，含滚动） */
  rect: PickRect;
  styles: PickStyleGroup[];
}

export interface PickSpacing {
  /** 次元素在 elements 里的下标（主元素是 0） */
  to: number;
  label: string;
  measures: PickMeasure[];
}

export interface PickMeasure {
  axis: "x" | "y";
  /** 视口坐标的线段 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
}

export interface PickRecord {
  id: string;
  seq: number;
  kind: PickKind;
  title: string;
  note: string;
  pageUrl: string;
  pageTitle: string;
  createdAt: number;
  rect: PickRect;
  image: Blob;
  thumb: Blob;
  imageSize: { width: number; height: number };
  elements: PickElement[];
  spacings: PickSpacing[];
  /** 截图被截断、拼接有重复等情况的说明 */
  notice?: string;
}

/** 写库前的元数据（图片在后台生成）。 */
export type PickRecordInput = Omit<PickRecord, "id" | "seq" | "image" | "thumb" | "imageSize" | "createdAt" | "note">;

// ---------- 样式 ----------

/** 计算样式的一个子集：只取和 UI 走查有关的属性。 */
export const PICK_STYLE_PROPERTIES = [
  "font-family",
  "font-size",
  "line-height",
  "font-weight",
  "font-style",
  "color",
  "letter-spacing",
  "text-align",
  "text-decoration-line",
  "text-transform",
  "width",
  "height",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "background-color",
  "background-image",
  "box-shadow",
  "opacity",
  "display",
  "gap"
] as const;

export type PickComputedStyle = Partial<Record<(typeof PICK_STYLE_PROPERTIES)[number], string>>;

const TRANSPARENT = /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/i;

/** rgb()/rgba() 转十六进制；带透明度时附 8 位形式。解析不了的原样返回。 */
export function cssColorToHex(value: string): string {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(value.trim());
  if (!match) return value.trim();
  const [r, g, b] = match.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
  const hex = `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  if (match[4] === undefined) return hex.toUpperCase();
  const alpha = match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  if (alpha >= 1) return hex.toUpperCase();
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`.toUpperCase();
}

/** 四个方向的值合并成 CSS 简写：8px 8px 8px 8px → 8px；8px 16px 8px 16px → 8px 16px。 */
export function compactBox(top = "0px", right = "0px", bottom = "0px", left = "0px"): string {
  const values = [top, right, bottom, left].map(trimPx);
  if (values.every((value) => value === values[0])) return values[0];
  if (values[0] === values[2] && values[1] === values[3]) return `${values[0]} ${values[1]}`;
  if (values[1] === values[3]) return `${values[0]} ${values[1]} ${values[2]}`;
  return values.join(" ");
}

function trimPx(value: string): string {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return value;
  return `${Math.round(number * 100) / 100}px`;
}

function isZeroBox(value: string): boolean {
  return value.split(" ").every((part) => Number.parseFloat(part) === 0);
}

function firstFont(family: string): string {
  return family.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? family;
}

/**
 * 把计算样式整理成三组，只列和默认值不同、对走查有意义的项。
 * hasText：元素自己有直接文本时才显示文本组（容器的字体继承自父级，列出来是噪音）。
 */
export function groupPickStyles(style: PickComputedStyle, hasText: boolean): PickStyleGroup[] {
  const groups: PickStyleGroup[] = [];
  const text: PickStyleItem[] = [];
  if (hasText) {
    if (style["font-family"]) text.push({ label: "字体", value: firstFont(style["font-family"]) });
    const size = style["font-size"] ? trimPx(style["font-size"]) : "";
    const lineHeight = style["line-height"] && style["line-height"] !== "normal" ? trimPx(style["line-height"]) : "normal";
    if (size) text.push({ label: "字号 / 行高", value: `${size} / ${lineHeight}` });
    if (style["font-weight"]) text.push({ label: "字重", value: style["font-weight"] });
    if (style.color) text.push({ label: "颜色", value: cssColorToHex(style.color), color: style.color });
    if (style["font-style"] && style["font-style"] !== "normal") text.push({ label: "字形", value: style["font-style"] });
    if (style["letter-spacing"] && style["letter-spacing"] !== "normal") text.push({ label: "字间距", value: trimPx(style["letter-spacing"]) });
    if (style["text-align"] && !["start", "left"].includes(style["text-align"])) text.push({ label: "对齐", value: style["text-align"] });
    if (style["text-decoration-line"] && style["text-decoration-line"] !== "none") text.push({ label: "装饰", value: style["text-decoration-line"] });
    if (style["text-transform"] && style["text-transform"] !== "none") text.push({ label: "大小写", value: style["text-transform"] });
  }
  if (text.length) groups.push({ title: "文本", items: text });

  const box: PickStyleItem[] = [];
  if (style.width && style.height) box.push({ label: "尺寸", value: `${trimPx(style.width).replace("px", "")} × ${trimPx(style.height)}` });
  const padding = compactBox(style["padding-top"], style["padding-right"], style["padding-bottom"], style["padding-left"]);
  if (!isZeroBox(padding)) box.push({ label: "内边距", value: padding });
  const margin = compactBox(style["margin-top"], style["margin-right"], style["margin-bottom"], style["margin-left"]);
  if (!isZeroBox(margin)) box.push({ label: "外边距", value: margin });
  const borderWidth = compactBox(style["border-top-width"], style["border-right-width"], style["border-bottom-width"], style["border-left-width"]);
  if (!isZeroBox(borderWidth) && style["border-top-style"] !== "none") {
    const color = style["border-top-color"] ?? "";
    box.push({ label: "边框", value: `${borderWidth} ${style["border-top-style"] ?? "solid"} ${cssColorToHex(color)}`.trim(), color: color || undefined });
  }
  const radius = compactBox(
    style["border-top-left-radius"],
    style["border-top-right-radius"],
    style["border-bottom-right-radius"],
    style["border-bottom-left-radius"]
  );
  if (!isZeroBox(radius)) box.push({ label: "圆角", value: radius });
  if (style.gap && style.gap !== "normal" && Number.parseFloat(style.gap) > 0) box.push({ label: "间隙", value: trimPx(style.gap) });
  if (box.length) groups.push({ title: "盒子", items: box });

  const fill: PickStyleItem[] = [];
  if (style["background-color"] && !TRANSPARENT.test(style["background-color"])) {
    fill.push({ label: "背景色", value: cssColorToHex(style["background-color"]), color: style["background-color"] });
  }
  if (style["background-image"] && style["background-image"] !== "none") {
    fill.push({ label: "背景图", value: shorten(style["background-image"], 120) });
  }
  if (style["box-shadow"] && style["box-shadow"] !== "none") fill.push({ label: "阴影", value: style["box-shadow"] });
  if (style.opacity && Number(style.opacity) < 1) fill.push({ label: "透明度", value: style.opacity });
  if (fill.length) groups.push({ title: "背景与效果", items: fill });
  return groups;
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** tag#id.class1.class2，类名最多两个，太长的截断。 */
export function shortSelector(tag: string, id: string, classNames: string[]): string {
  const name = tag.toLowerCase();
  if (id) return `${name}#${id}`;
  const classes = classNames.filter((item) => item && !/^[\d-]/.test(item)).slice(0, 2);
  return shorten(`${name}${classes.map((item) => `.${item}`).join("")}`, 60);
}

const TAG_LABELS: Record<string, string> = {
  a: "链接",
  button: "按钮",
  img: "图片",
  input: "输入框",
  textarea: "输入框",
  select: "下拉框",
  svg: "图标",
  h1: "标题",
  h2: "标题",
  h3: "标题",
  h4: "标题",
  p: "段落",
  span: "文本",
  label: "文本",
  li: "列表项",
  ul: "列表",
  ol: "列表",
  table: "表格",
  nav: "导航",
  header: "页头",
  footer: "页脚",
  form: "表单"
};

export function pickTitle(kind: PickKind, rect: PickRect, element?: Pick<PickElement, "tag" | "selector">): string {
  const size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  if (kind === "element" && element) return `${TAG_LABELS[element.tag.toLowerCase()] ?? "元素"} ${element.selector}`;
  if (kind === "region") return `区域 ${size}`;
  if (kind === "viewport") return `可视区 ${size}`;
  return `整页 ${size}`;
}

// ---------- 间距 ----------

/**
 * 主元素 a 和另一元素 b 之间的距离（视口坐标）。
 * 分开时量两者之间的水平 / 垂直间隙；一个包含另一个时量四边的内距；部分重叠时量对齐边之差。
 */
export function measureBetween(a: PickRect, b: PickRect): PickMeasure[] {
  const ar = a.x + a.width;
  const ab = a.y + a.height;
  const br = b.x + b.width;
  const bb = b.y + b.height;
  const measures: PickMeasure[] = [];
  const midY = (Math.max(a.y, b.y) + Math.min(ab, bb)) / 2;
  const midX = (Math.max(a.x, b.x) + Math.min(ar, br)) / 2;
  const overlapY = Math.min(ab, bb) > Math.max(a.y, b.y);
  const overlapX = Math.min(ar, br) > Math.max(a.x, b.x);
  const cy = overlapY ? midY : a.y + a.height / 2;
  const cx = overlapX ? midX : a.x + a.width / 2;

  const contains = (outer: PickRect, inner: PickRect) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

  if (contains(b, a) || contains(a, b)) {
    const [outer, inner] = contains(b, a) ? [b, a] : [a, b];
    const icx = inner.x + inner.width / 2;
    const icy = inner.y + inner.height / 2;
    const push = (axis: "x" | "y", x1: number, y1: number, x2: number, y2: number) => {
      const value = round(axis === "x" ? x2 - x1 : y2 - y1);
      if (value > 0) measures.push({ axis, x1, y1, x2, y2, value });
    };
    push("y", icx, outer.y, icx, inner.y);
    push("x", inner.x + inner.width, icy, outer.x + outer.width, icy);
    push("y", icx, inner.y + inner.height, icx, outer.y + outer.height);
    push("x", outer.x, icy, inner.x, icy);
    return measures;
  }

  if (b.x >= ar) measures.push({ axis: "x", x1: ar, y1: cy, x2: b.x, y2: cy, value: round(b.x - ar) });
  else if (br <= a.x) measures.push({ axis: "x", x1: br, y1: cy, x2: a.x, y2: cy, value: round(a.x - br) });
  if (b.y >= ab) measures.push({ axis: "y", x1: cx, y1: ab, x2: cx, y2: b.y, value: round(b.y - ab) });
  else if (bb <= a.y) measures.push({ axis: "y", x1: cx, y1: bb, x2: cx, y2: a.y, value: round(a.y - bb) });

  if (!measures.length) {
    // 部分重叠：量左边、上边的错位，帮助发现「差 1px 没对齐」。
    if (a.x !== b.x) measures.push({ axis: "x", x1: Math.min(a.x, b.x), y1: cy, x2: Math.max(a.x, b.x), y2: cy, value: round(Math.abs(a.x - b.x)) });
    if (a.y !== b.y) measures.push({ axis: "y", x1: cx, y1: Math.min(a.y, b.y), x2: cx, y2: Math.max(a.y, b.y), value: round(Math.abs(a.y - b.y)) });
  }
  return measures;
}

export function describeMeasures(measures: PickMeasure[]): string {
  if (!measures.length) return "对齐";
  return measures.map((item) => `${item.axis === "x" ? "水平" : "垂直"} ${item.value}px`).join("，");
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------- 截图 ----------

/** 视口矩形按设备像素比换算成截图里的像素区域，并夹在图片范围内。 */
export function cropBox(rect: PickRect, scale: number, imageWidth: number, imageHeight: number): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.max(0, Math.floor(rect.x * scale));
  const sy = Math.max(0, Math.floor(rect.y * scale));
  const ex = Math.min(imageWidth, Math.ceil((rect.x + rect.width) * scale));
  const ey = Math.min(imageHeight, Math.ceil((rect.y + rect.height) * scale));
  return { sx, sy, sw: Math.max(1, ex - sx), sh: Math.max(1, ey - sy) };
}

/** 截图带一圈留白，让元素周围的上下文也在图里；不超出视口。 */
export function padRect(rect: PickRect, padding: number, viewport: { width: number; height: number }): PickRect {
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  return {
    x,
    y,
    width: Math.min(viewport.width, rect.x + rect.width + padding) - x,
    height: Math.min(viewport.height, rect.y + rect.height + padding) - y
  };
}

export function unionRect(rects: PickRect[]): PickRect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Canvas 单边上限。整页截图超过时截到上限并在记录里说明。 */
export const MAX_CANVAS_SIDE = 16384;

/**
 * 整页逐屏截图的滚动位置：从 0 开始每次一屏，最后一屏贴底（和上一屏重叠的部分直接覆盖）。
 * 高度按 maxPixels / scale 截断。
 */
export function planPageCapture(
  documentHeight: number,
  viewportHeight: number,
  scale: number,
  maxPixels = MAX_CANVAS_SIDE
): { positions: number[]; height: number; truncated: boolean } {
  const limit = Math.floor(maxPixels / Math.max(scale, 0.1));
  const height = Math.max(1, Math.min(documentHeight, limit));
  const truncated = documentHeight > limit;
  const positions: number[] = [];
  if (height <= viewportHeight) return { positions: [0], height, truncated };
  for (let y = 0; y + viewportHeight < height; y += viewportHeight) positions.push(y);
  positions.push(height - viewportHeight);
  return { positions, height, truncated };
}

// ---------- 侧栏输入框 ----------

export type PickDraftSegment = { type: "text"; text: string } | { type: "ref"; id: string };

export const PICK_DRAFT_STORAGE_KEY = "omem.pick.draft";

export function normalizeDraft(value: unknown): PickDraftSegment[] {
  // chrome.storage 里的数组可能以 {"0": …} 的数字键对象出现，统一走 normalizeStoredList。
  return normalizeStoredList(value).flatMap((item): PickDraftSegment[] => {
    if (item && typeof item === "object") {
      const segment = item as Record<string, unknown>;
      if (segment.type === "text" && typeof segment.text === "string") return [{ type: "text", text: segment.text }];
      if (segment.type === "ref" && typeof segment.id === "string") return [{ type: "ref", id: segment.id }];
    }
    return [];
  });
}

export function refLabel(record: Pick<PickRecord, "seq" | "title">): string {
  return `#${record.seq} ${record.title}`;
}

type ExportRecord = Pick<PickRecord, "id" | "seq" | "kind" | "title" | "note" | "pageUrl" | "pageTitle" | "imageSize" | "elements" | "spacings" | "notice">;

/**
 * 输入框内容 + 引用到的记录整理成 Markdown：正文里的引用写成 [#3 标题]，后面逐条列出页面、元素样式和间距。
 * 图片不内嵌，只注明编号和尺寸（发给 omem 时图片作为附件随行）。
 */
export function draftToMarkdown(segments: PickDraftSegment[], records: ExportRecord[]): string {
  const byId = new Map(records.map((record) => [record.id, record]));
  const referenced: ExportRecord[] = [];
  const body = segments
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const record = byId.get(segment.id);
      if (!record) return "[已删除的记录]";
      if (!referenced.includes(record)) referenced.push(record);
      return `[${refLabel(record)}]`;
    })
    .join("")
    .trim();
  if (!referenced.length) return body;
  const sections = referenced.map((record) => recordToMarkdown(record));
  return [body, "---", ...sections].filter(Boolean).join("\n\n");
}

export function recordToMarkdown(record: ExportRecord): string {
  const lines = [`### ${refLabel(record)}`, `- 页面：${record.pageTitle || record.pageUrl}（${record.pageUrl}）`, `- 截图：#${record.seq}，${record.imageSize.width}×${record.imageSize.height}`];
  if (record.notice) lines.push(`- 注意：${record.notice}`);
  if (record.note.trim()) lines.push(`- 说明：${record.note.trim()}`);
  record.elements.forEach((element, index) => {
    lines.push(`- ${index === 0 ? "元素" : `次元素 ${index}`}：\`${element.selector}\` ${Math.round(element.rect.width)}×${Math.round(element.rect.height)}${element.text ? `，文字「${shorten(element.text, 40)}」` : ""}`);
    for (const group of element.styles) {
      lines.push(`  - ${group.title}：${group.items.map((item) => `${item.label} ${item.value}`).join("；")}`);
    }
  });
  for (const spacing of record.spacings) {
    const target = record.elements[spacing.to];
    lines.push(`- 间距：到 \`${target?.selector ?? spacing.to}\` ${spacing.label}`);
  }
  return lines.join("\n");
}
