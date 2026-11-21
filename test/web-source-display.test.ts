import { describe, expect, it } from "vitest";
import { citeRef, firstOverlap, linesLabel, recordBody, rowCells, sourceDisplay, tableRows } from "../web/src/lib/source-display.ts";

describe("a parser's display of a source (web/src/lib/source-display.ts)", () => {
  it("only reads a display that a parser wrote and the page knows", () => {
    expect(sourceDisplay({ display: { kind: "table", columns: ["a"], rowLines: [[1, 1]] } })).toBeNull();
    expect(sourceDisplay({ parser: { id: "x:y" }, display: { kind: "chart" } })).toBeNull();
    expect(sourceDisplay({ parser: { id: "x:y" }, display: { kind: "table", columns: ["a"], rowLines: [[2, 1]] } })).toBeNull();
    expect(sourceDisplay({ parser: { id: "x:y" }, display: { kind: "records", items: [{ title: "订单", lines: [1, 2] }] } }))
      .toEqual({ kind: "records", items: [{ title: "订单", lines: [1, 2] }] });
  });

  it("cuts the text into rows by their lines, wherever the loaded text starts", () => {
    const text = "# 退款单\n| 单号 | 金额 |\n|---|---|\n| R1 | 12.5 |\n| R2 | 3 |";
    const display = { kind: "table" as const, columns: ["单号", "金额"], rowLines: [[4, 4], [5, 5]] as [number, number][] };
    expect(tableRows(text, 1, display).map((r) => r.cells)).toEqual([["R1", "12.5"], ["R2", "3"]]);
    expect(tableRows("| R2 | 3 |", 5, { ...display, rowLines: [[5, 5]] })[0]).toEqual({ key: 0, lines: [5, 5], cells: ["R2", "3"] });
  });

  it("reads the usual ways a row is written", () => {
    const cols = ["单号", "原因", "金额"];
    expect(rowCells(["单号：R1", "原因：尺码不合适", "金额: 12"], cols)).toEqual(["R1", "尺码不合适", "12"]);
    expect(rowCells(["- **原因**：质量问题", "- **单号**：R2"], cols)).toEqual(["R2", "质量问题", ""]);
    expect(rowCells(["R3", "物流太慢", "8"], cols)).toEqual(["R3", "物流太慢", "8"]);
    expect(rowCells(["R4\t不想要了\t5"], cols)).toEqual(["R4", "不想要了", "5"]);
    expect(rowCells(["| a \\| b | c |"], ["x", "y"])).toEqual(["a | b", "c"]);
    expect(rowCells(["一段说明", "接着的一行"], ["说明", "备注", "其他"])).toEqual(["一段说明 接着的一行", "", ""]);
  });

  it("shows a record's text without repeating its title", () => {
    const text = "订单\n已创建\n退款\n已退回\n第二行";
    expect(recordBody(text, 1, { title: "订单", lines: [1, 2] })).toBe("已创建");
    expect(recordBody(text, 1, { title: "退款单", lines: [3, 5] })).toBe("退款\n已退回\n第二行");
    expect(recordBody(text, 1, { title: "订单", lines: [1, 1] })).toBe("订单");
  });

  it("finds the row a citation lands in and writes the citation back", () => {
    expect(firstOverlap([[1, 2], [3, 5], [6, 6]], 4, 4)).toBe(1);
    expect(firstOverlap([[1, 2]], 9, 9)).toBe(-1);
    expect(linesLabel([3, 3])).toBe("第 3 行");
    expect(linesLabel([3, 5])).toBe("第 3–5 行");
    expect(citeRef("s1", [3, 5])).toBe("src:s1#L3-L5");
  });
});
