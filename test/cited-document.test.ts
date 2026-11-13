import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { citedDocumentParts } from "../web/src/lib/cited-document.ts";

describe("document citations", () => {
  it("keeps all table rows rendered when a citation starts at row seven", () => {
    const table = ["| 编号 | 建议 |", "| --- | --- |", ...Array.from({ length: 29 }, (_, i) => `| ${i + 1} | 保留 |`)];
    const text = ["# 确认表", "", ...table, "", "表后说明。"].join("\n");
    const parts = citedDocumentParts(text, 130, 140, 162);
    expect(parts.before + parts.cited + parts.after).toBe(text);
    expect(parts.cited).toContain(table[0]);
    expect(parts.cited).toContain("| 29 | 保留 |");
    const html = Object.values(parts).map((p) => marked.parse(p)).join("");
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html.match(/<tr>/g)).toHaveLength(30);
    expect(parts.after).toContain("表后说明");
  });

  it.each([
    ["```ts\nconst a = 1;\nconst b = 2;\n```", "const b = 2"],
    ["- 第一步\n  - 细节\n- 第二步", "第二步"],
    ["> 第一行\n> 第二行", "第二行"],
  ])("keeps the surrounding Markdown block for %s", (block, expected) => {
    const text = `前文。\n\n${block}\n\n后文。`;
    const parts = citedDocumentParts(text, 1, 4, 4);
    expect(parts.cited).toContain(block);
    expect(marked.parse(parts.cited)).toContain(expected);
    expect(parts.before + parts.cited + parts.after).toBe(text);
  });

  it("takes a whole Feishu callout or column grid when the citation falls inside it", () => {
    const callout = '<blockquote class="doc-callout">\n\n💡 提示第一行\n第二行\n\n</blockquote>';
    const grid = '<div class="doc-grid">\n\n<div class="doc-col">\n\n左栏\n\n</div>\n\n<div class="doc-col">\n\n右栏\n\n</div>\n\n</div>';
    const text = ["# 标题", "", '<blockquote><p>单行引用</p></blockquote>', "", callout, "", "中间段落。", "", grid, "", "结尾。"].join("\n");
    const at = (needle: string) => text.slice(0, text.indexOf(needle)).split("\n").length;
    // Inside the callout: the whole callout, nothing split off on either side.
    let parts = citedDocumentParts(text, 1, at("第二行"));
    expect(parts.cited).toContain('<blockquote class="doc-callout">');
    expect(parts.cited).toContain("</blockquote>");
    expect(parts.before).not.toContain("doc-callout");
    expect(parts.after).not.toContain("</blockquote>");
    expect(parts.before + parts.cited + parts.after).toBe(text);
    // Inside one column: the grid with both columns.
    parts = citedDocumentParts(text, 1, at("右栏"));
    expect(parts.cited.match(/doc-col/g)).toHaveLength(2);
    expect(parts.after.trim()).toBe("结尾。");
    // A one-line quote at the top, as a citation of lines 1–4 opens it.
    parts = citedDocumentParts(text, 1, 1, 4);
    expect(parts.cited).toContain("单行引用");
    expect(parts.after).toContain("doc-callout");
    // A window that starts inside a container still cuts after its close.
    const tail = text.slice(text.indexOf("第二行"));
    parts = citedDocumentParts(tail, at("第二行"), at("中间段落"));
    expect(parts.before + parts.cited + parts.after).toBe(tail);
    expect(parts.cited).toContain("中间段落");
  });

  it("leaves uncited and out-of-window text intact", () => {
    const text = "正文。\n\n后文。";
    expect(citedDocumentParts(text, 30)).toEqual({ before: text, cited: "", after: "" });
    expect(citedDocumentParts(text, 30, 1, 2)).toEqual({ before: "", cited: "", after: text });
  });
});
