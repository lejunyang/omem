import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { larkCardMarkdown, larkMarkdown } from "../src/channels/lark-markdown.ts";
import { buildCard, decidedBlocks, resultSummary, sendLark, setLarkClient, shortTime } from "../src/channels/lark-send.ts";
import { resolveCitationsNow } from "../src/channels/citations.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

/** How a CommonMark parser reads it: the bold spans, or none. */
const bolds = (md: string) => [...marked.parseInline(md, { async: false }).matchAll(/<strong>(.*?)<\/strong>/g)].map((m) => m[1]);

describe("bold that Feishu renders", () => {
  // Shapes taken from real answers whose asterisks showed (contents made up).
  const broken: [string, string, string][] = [
    ["**建议：**先准备提纲，再约小王。", "**建议**：先准备提纲，再约小王。", "建议"],
    ["1. **与你有关的内容：**没有记录到点名。", "1. **与你有关的内容**：没有记录到点名。", "与你有关的内容"],
    ["最后定的是：**先等线下方案，走不通再回滚。**小王提出。", "最后定的是：**先等线下方案，走不通再回滚**。小王提出。", "先等线下方案，走不通再回滚"],
    ["查了 **11 月 7 日 16:00—11 月 10 日 16:00（北京时间）**的日志", "查了 **11 月 7 日 16:00—11 月 10 日 16:00（北京时间）** 的日志", "11 月 7 日 16:00—11 月 10 日 16:00（北京时间）"],
    ["如**「退款说明」**所示", "如 **「退款说明」** 所示", "「退款说明」"],
    ["结论是** 已恢复 **，不用处理", "结论是**已恢复**，不用处理", "已恢复"],
    ["改在**`refund.ts`**里", "改在 **`refund.ts`** 里", "<code>refund.ts</code>"],
  ];
  it("rewrites a bold CommonMark would not close or open, and then it parses as bold", () => {
    for (const [before, after, bold] of broken) {
      expect(bolds(before)).toEqual([]);
      expect(larkMarkdown(before)).toBe(after);
      expect(bolds(after)).toEqual([bold]);
    }
  });

  it("leaves bold that already renders, code, and lone asterisks alone", () => {
    const fine = [
      "本条判为**脚本探测的噪音，现已恢复**。",
      "**结论：** 已恢复",
      "- **迁移节奏：**\n  下周一开始",
      "错误率 **0.151%**，昨日为 0。",
      "看 `**建议：**先` 这段代码",
      "```\n**建议：**先\n```",
      "* 列表项 *强调* ***三个***",
      "未闭合的 **建议：开头",
    ];
    for (const md of fine) expect(larkMarkdown(md)).toBe(md);
  });

  it("is stable when applied twice and keeps several bolds on one line apart", () => {
    const md = "**原因：**配置没同步；**处理：**已回滚（见 **「发布记录」**）。";
    const once = larkMarkdown(md);
    expect(once).toBe("**原因**：配置没同步；**处理**：已回滚（见 **「发布记录」**）。");
    expect(larkMarkdown(once)).toBe(once);
    expect(bolds(once)).toEqual(["原因", "处理", "「发布记录」"]);
  });

  it("every card the bot sends or updates goes out with its Markdown fixed, protocol values untouched", async () => {
    const sent: any[] = [];
    setLarkClient({
      im: {
        message: {
          create: async (req: any) => (sent.push(req.data), { code: 0, data: { message_id: "om_1" } }),
          reply: async (req: any) => (sent.push(req.data), { code: 0, data: { message_id: "om_2" } }),
          patch: async (req: any) => (sent.push(req.data), { code: 0, data: {} }),
        },
      },
    });
    try {
      await sendLark({ chatId: "oc_x" }, { markdown: "**建议：**先查日志" });
      const card = { schema: "2.0", body: { elements: [{ tag: "markdown", content: "**结论：**已恢复" }, { tag: "button", behaviors: [{ type: "callback", value: { action: "**建议：**x" } }] }] } };
      await sendLark({ replyTo: "om_0" }, { card });
      const { updateLarkCard } = await import("../src/channels/lark-send.ts");
      await updateLarkCard("om_1", buildCard({ blocks: [{ fold: { title: "详情", markdown: "**原因：**超时" } }] }));
      const contents = sent.map((d) => d.content);
      expect(contents[0]).toContain("**建议**：先查日志");
      expect(contents[1]).toContain("**结论**：已恢复");
      expect(contents[1]).toContain('"action":"**建议：**x"');
      expect(contents[2]).toContain("**原因**：超时");
      // The caller's card object is not changed.
      expect(card.body.elements[0].content).toBe("**结论：**已恢复");
    } finally {
      setLarkClient(null);
    }
  });

  it("larkCardMarkdown touches only markdown elements", () => {
    const card = { body: { elements: [{ tag: "plain_text", content: "**a：**b" }, { tag: "markdown", content: "**a：**b" }] } };
    expect(larkCardMarkdown(card).body.elements.map((e) => e.content)).toEqual(["**a：**b", "**a**：b"]);
  });
});

describe("citation marks", () => {
  it("are the same plain digits for every number, past ⑩ and ⑳ too", () => {
    const app = testApp();
    try {
      const docs = Array.from({ length: 22 }, (_, i) => upsertSource(app, { spaceId: "personal", kind: "doc", uri: `https://tenant.larkoffice.com/docx/Doc${i + 1}`, title: `文档 ${i + 1}`, text: "内容" }));
      const md = docs.map((d, i) => `第 ${i + 1} 条。[依据](src:${d.id}#L1)`).join("\n");
      const out = resolveCitationsNow(app, [md])[0].split("\n");
      out.forEach((line, i) => expect(line).toBe(`第 ${i + 1} 条。[(${i + 1})](https://tenant.larkoffice.com/docx/Doc${i + 1})`));
      expect(out.join("")).not.toMatch(/[①-⑳]/);
    } finally {
      app.db.close();
    }
  });
});

describe("decided cards", () => {
  it("a tool's output becomes one line and a closed fold, failures in red", () => {
    expect(resultSummary("已执行（sheets +cells-set，表格《项目 A 排期》）：\n{ \"revision\": 14 }\n写后读一次核对。")).toEqual({
      ok: true,
      summary: "已执行（sheets +cells-set，表格《项目 A 排期》）",
      rest: "{ \"revision\": 14 }\n写后读一次核对。",
    });
    expect(resultSummary("失败：飞书 CLI 调用失败，请检查登录和网络")).toMatchObject({ ok: false, summary: "飞书 CLI 调用失败，请检查登录和网络", rest: "" });
    const blocks = decidedBlocks({ verdict: "批准", by: "本人", at: "2026-11-10T02:49:46.768Z", timeZone: "Asia/Shanghai", result: "已执行（x）：\n{\"a\":1}" });
    expect(blocks).toEqual([
      { note: "本人 · 11-10 10&#58;49　批准" },
      { markdown: "<font color='green'>完成</font>　已执行（x）" },
      { fold: { title: "完整输出", markdown: "```\n{\"a\":1}\n```" } },
    ]);
    expect(shortTime("2026-11-10T16:30:00Z", "Asia/Shanghai")).toBe("11-11 00:30");
  });
});
