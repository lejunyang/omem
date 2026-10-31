import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { findingMarkdown } from "../web/src/lib/findingText.ts";

const detail = [
  "**现在的实现**",
  "- 退款单列表只读第一条记录的状态 [列表](apps/shop/refund.ts:12-18)",
  "- 详情页另读一次 [详情](apps/shop/detail.ts:40)",
  "**触发条件**",
  "- 一笔订单有两次部分退款。",
  "**问题**：列表显示“已退款”，详情显示“退款中”。",
].join("\n");

const html = (md: string) => new Marked({ gfm: true }).parse(md, { async: false, breaks: true }) as string;

describe("findingMarkdown", () => {
  it("a section label right under a list is taken into the last list item without it", () => {
    expect(html(detail)).toMatch(/<li>[^<]*<a [^>]*>详情<\/a><br><strong>触发条件<\/strong><\/li>/);
  });

  it("puts each section label on its own block", () => {
    const out = findingMarkdown(detail);
    expect(out).toBe([
      "**现在的实现**",
      "",
      "- 退款单列表只读第一条记录的状态 [列表](apps/shop/refund.ts:12-18)",
      "- 详情页另读一次 [详情](apps/shop/detail.ts:40)",
      "",
      "**触发条件**",
      "",
      "- 一笔订单有两次部分退款。",
      "",
      "**问题**：列表显示“已退款”，详情显示“退款中”。",
    ].join("\n"));
    const h = html(out);
    for (const label of ["现在的实现", "触发条件"]) expect(h).toContain(`<p><strong>${label}</strong></p>`);
    expect(h).toContain("<p><strong>问题</strong>：列表显示");
    expect(h).not.toMatch(/<li>(?:(?!<\/li>)[^])*<strong>/);
  });

  it("keeps text that is already separated, and leaves code and inline bold alone", () => {
    const ok = "**现在的实现**\n\n- 一点\n\n**问题**：\n\n- 另一点";
    expect(findingMarkdown(ok)).toBe(ok);
    const code = "```md\n- a\n**不是标题**\n```";
    expect(findingMarkdown(code)).toBe(code);
    const inline = "- 一点\n**加粗** 后面还有字\n**示例商城** 和 **退款**";
    expect(findingMarkdown(inline)).toBe(inline);
    expect(findingMarkdown("- 一点\r\n**问题：**\r\n- 另一点")).toBe("- 一点\n\n**问题：**\n\n- 另一点");
    expect(findingMarkdown("")).toBe("");
  });
});
