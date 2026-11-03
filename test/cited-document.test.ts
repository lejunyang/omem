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

  it("leaves uncited and out-of-window text intact", () => {
    const text = "正文。\n\n后文。";
    expect(citedDocumentParts(text, 30)).toEqual({ before: text, cited: "", after: "" });
    expect(citedDocumentParts(text, 30, 1, 2)).toEqual({ before: "", cited: "", after: text });
  });
});
