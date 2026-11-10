import type { ElementContext, PageContext } from "./element-context";
import { type PickDraftSegment, type PickRecord, refLabel } from "./pick";

// 把拾取篮的输入框内容和引用到的记录整理成发给 omem 的一段 Markdown：
// 正文在前（引用写成 [#3 标题]），后面逐条列出页面、截图位置、元素的位置 / 属性 / 文本 / 精简 HTML / 样式 / 间距。
// 截图用 {{image:<key>}} 占位，由 omem 换成图片原件（服务端 sources/clips.ts）。

type ClipRecord = Pick<PickRecord, "id" | "seq" | "kind" | "title" | "note" | "pageUrl" | "pageTitle" | "imageSize" | "elements" | "spacings" | "notice"> & {
  pageContext?: PageContext;
};

export interface ClipDraft {
  title: string;
  text: string;
  /** 正文里第一个页面（作为来源） */
  pageUrl: string;
  /** 要随行的截图：key 对应 text 里的 {{image:key}} */
  images: Array<{ key: string; recordId: string; title: string }>;
}

/** 正文：段落原样，引用换成 [#编号 标题]；删掉的记录写明。 */
function bodyText(segments: PickDraftSegment[], byId: Map<string, ClipRecord>, referenced: ClipRecord[]): string {
  return segments
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const record = byId.get(segment.id);
      if (!record) return "[已删除的记录]";
      if (!referenced.includes(record)) referenced.push(record);
      return `[${refLabel(record)}]`;
    })
    .join("")
    .trim();
}

function contextLines(context: ElementContext, indent: string): string[] {
  const lines = [`${indent}- 位置：\`${context.path}\``];
  if (context.heading) lines.push(`${indent}- 所在区块：${context.heading}`);
  const attributes = Object.entries(context.attributes).filter(([key]) => key !== "id");
  if (attributes.length) lines.push(`${indent}- 属性：${attributes.map(([key, value]) => `\`${key}="${value}"\``).join(" ")}`);
  if (context.text.value) lines.push(`${indent}- 文字${context.text.truncated ? `（共 ${context.text.total} 字，已截断）` : ""}：${context.text.value}`);
  if (context.children.count) {
    lines.push(`${indent}- 子元素：${context.children.count} 个直接子元素、共 ${context.children.descendants}${context.children.descendants >= 5000 ? "+" : ""} 个后代${context.children.summary ? `（${context.children.summary}）` : ""}`);
  }
  if (context.html) lines.push(`${indent}- HTML（精简）：`, "", "```html", context.html, "```", "");
  return lines;
}

function pageLines(record: ClipRecord): string[] {
  const page = record.pageContext;
  const lines = [`- 页面：${record.pageTitle || "（无标题）"}（${record.pageUrl}）`];
  if (!page) return lines;
  if (page.description) lines.push(`- 页面描述：${page.description}`);
  lines.push(`- 视口：${page.viewport.width}×${page.viewport.height}，DPR ${page.devicePixelRatio}，滚动到 ${page.scroll.y}px${page.lang ? `，语言 ${page.lang}` : ""}`);
  if (page.selection) lines.push(`- 当时选中的文字：${page.selection}`);
  return lines;
}

function recordSection(record: ClipRecord, key: string): string {
  const lines = [`### ${refLabel(record)}`, ...pageLines(record)];
  if (record.note.trim()) lines.push(`- 说明：${record.note.trim()}`);
  if (record.notice) lines.push(`- 截图说明：${record.notice}`);
  lines.push("", `{{image:${key}}}`, "");
  record.elements.forEach((element, index) => {
    lines.push(`- ${index === 0 ? "主元素" : `次元素 ${index}`}：\`${element.selector}\` ${Math.round(element.rect.width)}×${Math.round(element.rect.height)}`);
    if (element.context) lines.push(...contextLines(element.context, "  "));
    else if (element.text) lines.push(`  - 文本：${element.text}`);
    for (const group of index === 0 ? element.styles : []) {
      lines.push(`  - 样式 · ${group.title}：${group.items.map((item) => `${item.label} ${item.value}`).join("；")}`);
    }
  });
  for (const spacing of record.spacings) {
    lines.push(`- 间距：主元素到 \`${record.elements[spacing.to]?.selector ?? spacing.to}\` ${spacing.label}`);
  }
  return lines.join("\n");
}

/**
 * 输入框没写字、只引用了记录时，标题和正文用记录拼出来；什么都没有时返回 null。
 * 记录按在正文里出现的顺序列出；截图 key 用编号（r3），同一条只带一次。
 */
export function buildClip(segments: PickDraftSegment[], records: ClipRecord[]): ClipDraft | null {
  const byId = new Map(records.map((record) => [record.id, record]));
  const referenced: ClipRecord[] = [];
  const body = bodyText(segments, byId, referenced);
  if (!body && !referenced.length) return null;
  const images = referenced.map((record) => ({ key: `r${record.seq}`, recordId: record.id, title: refLabel(record) }));
  const sections = referenced.map((record, index) => recordSection(record, images[index].key));
  const text = [body, ...(sections.length ? ["---", "## 引用的记录", ...sections] : [])].filter(Boolean).join("\n\n");
  const firstLine = body.split("\n")[0].replace(/\[#\d+ [^\]]*\]/g, "").trim();
  const title = (firstLine || (referenced[0] ? `${referenced[0].pageTitle || "网页"}：${referenced[0].title}` : "网页拾取")).slice(0, 60);
  return { title, text, pageUrl: referenced[0]?.pageUrl ?? "", images };
}
