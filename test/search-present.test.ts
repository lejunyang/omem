import { describe, expect, it } from "vitest";
import { excerpt, highlightTerms, markRanges, plainText, shortLink } from "../src/search/present.ts";

const slice = (t: string, r: [number, number][]) => r.map(([s, e]) => t.slice(s, e));

describe("plainText", () => {
  it("drops Markdown syntax and keeps the words", () => {
    const t = plainText("### 权限域表\n\n代码在[commerce_permission](https://code.example.com/a/b)库中，见**model**文件夹，`keyword` 是唯一键\n- 第一项\n- [[flows/ingest|导入流程]]\n> 引用");
    expect(t).toBe("权限域表 代码在commerce_permission库中，见model文件夹，keyword 是唯一键 第一项 导入流程 引用");
  });
  it("turns an HTML table into cells and decodes entities", () => {
    const t = plainText("<table><thead><tr><th>表名</th><th>含义</th></tr></thead><tbody><tr><td>perm&nbsp;key</td><td><b>权限点</b>&amp;角色</td></tr></tbody></table>");
    expect(t).not.toMatch(/[<>]/);
    expect(t).toContain("perm key");
    expect(t).toContain("权限点&角色");
    expect(t).toContain("表名 | 含义");
  });
  it("shortens bare addresses and removes table rules and fences", () => {
    expect(plainText("见 https://tenant.larkoffice.com/docx/AbCd123?x=1 说明")).toBe("见 tenant.larkoffice.com/… 说明");
    expect(plainText("| a | b |\n|---|---|\n| 1 | 2 |\n```js\nlet x = 1;\n```")).toBe("a | b 1 | 2 let x = 1;");
  });
});

describe("highlight", () => {
  it("marks CJK bigrams and identifiers, ignoring stop words", () => {
    expect(highlightTerms("如何 接入终端")).toEqual(expect.arrayContaining(["接入", "入终", "终端"]));
    const text = "终端接入需要先授权";
    expect(slice(text, markRanges(text, highlightTerms("接入终端")))).toEqual(["终端接入"]);
    expect(slice("Call fetchUserName now", markRanges("Call fetchUserName now", highlightTerms("fetchUserName")))).toEqual(["fetchUserName"]);
  });
  it("is case-insensitive and merges touching ranges", () => {
    expect(markRanges("Refund REFUND refundx", ["refund"])).toEqual([[0, 6], [7, 13], [14, 20]]);
    expect(markRanges("abcd", ["ab", "bc", "cd"])).toEqual([[0, 4]]);
  });
});

describe("excerpt", () => {
  const filler = "无关的内容".repeat(60);
  it("centers the window on the match and offsets the marks inside it", () => {
    const raw = `${filler}\n\n## 退款流程\n\n用户提交退款申请后，系统先校验订单状态。\n\n${filler}`;
    const e = excerpt(raw, highlightTerms("退款申请"), 120);
    expect(e.text.length).toBeLessThanOrEqual(124);
    expect(e.text.startsWith("…")).toBe(true);
    expect(e.text.endsWith("…")).toBe(true);
    expect(slice(e.text, e.marks)).toContain("退款申请");
    for (const [s, en] of e.marks) {
      expect(en).toBeLessThanOrEqual(e.text.length);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
  it("finds a match that sits far into one long table row", () => {
    const row = `<table><tr>${Array.from({ length: 40 }, (_, i) => `<td>字段${i}含义说明</td>`).join("")}<td>目标字段 invitation_id</td></tr></table>`;
    const e = excerpt(row, highlightTerms("invitation_id"), 100);
    expect(e.text).toContain("invitation_id");
    expect(slice(e.text, e.marks).join("").toLowerCase()).toContain("invitation");
  });
  it("returns the head when nothing matches, and short text whole", () => {
    expect(excerpt("很短的文字", ["不存在"]).text).toBe("很短的文字");
    expect(excerpt("x".repeat(500), ["不存在"], 50).text).toBe("x".repeat(50) + "…");
  });
});

it("shows web addresses as host and path", () => {
  expect(shortLink("https://tenant.larkoffice.com/wiki/AbCd?from=x")).toBe("tenant.larkoffice.com/wiki/AbCd");
  expect(shortLink("src/main.ts")).toBe("");
});
