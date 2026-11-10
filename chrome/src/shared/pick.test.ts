import { describe, expect, it } from "vitest";
import {
  compactBox,
  cropBox,
  cssColorToHex,
  describeMeasures,
  draftToMarkdown,
  groupPickStyles,
  measureBetween,
  normalizeDraft,
  padRect,
  pickTitle,
  planPageCapture,
  shortSelector,
  unionRect
} from "./pick";

describe("cssColorToHex", () => {
  it("把 rgb / rgba 转成十六进制，带透明度时用 8 位", () => {
    expect(cssColorToHex("rgb(31, 35, 40)")).toBe("#1F2328");
    expect(cssColorToHex("rgba(47, 91, 211, 0.5)")).toBe("#2F5BD380");
    expect(cssColorToHex("rgb(47 91 211 / 50%)")).toBe("#2F5BD380");
    expect(cssColorToHex("rgba(0, 0, 0, 1)")).toBe("#000000");
  });

  it("解析不了的颜色原样返回", () => {
    expect(cssColorToHex("color(display-p3 1 0 0)")).toBe("color(display-p3 1 0 0)");
  });
});

describe("compactBox", () => {
  it("按 CSS 简写规则合并四个方向", () => {
    expect(compactBox("8px", "8px", "8px", "8px")).toBe("8px");
    expect(compactBox("8px", "16px", "8px", "16px")).toBe("8px 16px");
    expect(compactBox("4px", "16px", "8px", "16px")).toBe("4px 16px 8px");
    expect(compactBox("1px", "2px", "3px", "4px")).toBe("1px 2px 3px 4px");
    expect(compactBox("0.3333px", "0px", "0px", "0px")).toBe("0.33px 0px 0px");
  });
});

describe("groupPickStyles", () => {
  const base = {
    "font-family": '"PingFang SC", sans-serif',
    "font-size": "14px",
    "line-height": "22px",
    "font-weight": "500",
    color: "rgb(31, 35, 40)",
    "letter-spacing": "normal",
    "text-align": "start",
    width: "120px",
    height: "40px",
    "padding-top": "8px",
    "padding-right": "16px",
    "padding-bottom": "8px",
    "padding-left": "16px",
    "margin-top": "0px",
    "margin-right": "0px",
    "margin-bottom": "0px",
    "margin-left": "0px",
    "border-top-width": "1px",
    "border-right-width": "1px",
    "border-bottom-width": "1px",
    "border-left-width": "1px",
    "border-top-style": "solid",
    "border-top-color": "rgb(228, 225, 218)",
    "border-top-left-radius": "6px",
    "border-top-right-radius": "6px",
    "border-bottom-right-radius": "6px",
    "border-bottom-left-radius": "6px",
    "background-color": "rgba(0, 0, 0, 0)",
    "background-image": "none",
    "box-shadow": "none",
    opacity: "1"
  };

  it("只列和默认值不同的项", () => {
    const groups = groupPickStyles(base, true);
    expect(groups.map((group) => group.title)).toEqual(["文本", "盒子"]);
    const text = groups[0].items;
    expect(text).toContainEqual({ label: "字体", value: "PingFang SC" });
    expect(text).toContainEqual({ label: "字号 / 行高", value: "14px / 22px" });
    expect(text.find((item) => item.label === "颜色")).toMatchObject({ value: "#1F2328", color: "rgb(31, 35, 40)" });
    expect(text.some((item) => item.label === "字间距" || item.label === "对齐")).toBe(false);
    const box = groups[1].items;
    expect(box).toContainEqual({ label: "尺寸", value: "120 × 40px" });
    expect(box).toContainEqual({ label: "内边距", value: "8px 16px" });
    expect(box.some((item) => item.label === "外边距")).toBe(false);
    expect(box.find((item) => item.label === "边框")?.value).toBe("1px solid #E4E1DA");
    expect(box).toContainEqual({ label: "圆角", value: "6px" });
  });

  it("没有直接文本的元素不显示文本组；有背景和阴影时显示效果组", () => {
    const groups = groupPickStyles({ ...base, "background-color": "rgb(255, 255, 255)", "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px", opacity: "0.8" }, false);
    expect(groups.map((group) => group.title)).toEqual(["盒子", "背景与效果"]);
    expect(groups[1].items.map((item) => item.label)).toEqual(["背景色", "阴影", "透明度"]);
  });
});

describe("measureBetween", () => {
  const a = { x: 0, y: 0, width: 100, height: 40 };

  it("左右分开时量水平间隙", () => {
    const measures = measureBetween(a, { x: 112, y: 10, width: 50, height: 20 });
    expect(measures).toEqual([{ axis: "x", x1: 100, y1: 20, x2: 112, y2: 20, value: 12 }]);
    expect(describeMeasures(measures)).toBe("水平 12px");
  });

  it("上下分开时量垂直间隙", () => {
    const measures = measureBetween(a, { x: 20, y: 56, width: 40, height: 20 });
    expect(measures).toEqual([{ axis: "y", x1: 40, y1: 40, x2: 40, y2: 56, value: 16 }]);
  });

  it("对角分开时两个方向都量", () => {
    const measures = measureBetween(a, { x: 110, y: 50, width: 10, height: 10 });
    expect(measures.map((item) => [item.axis, item.value])).toEqual([
      ["x", 10],
      ["y", 10]
    ]);
  });

  it("包含关系时量四边内距", () => {
    const outer = { x: 0, y: 0, width: 200, height: 100 };
    const inner = { x: 16, y: 12, width: 168, height: 76 };
    expect(measureBetween(inner, outer).map((item) => item.value)).toEqual([12, 16, 12, 16]);
    expect(measureBetween(outer, inner).map((item) => item.value)).toEqual([12, 16, 12, 16]);
  });

  it("部分重叠时量对齐边的错位", () => {
    const measures = measureBetween(a, { x: 1, y: 0, width: 100, height: 40 });
    expect(measures).toEqual([{ axis: "x", x1: 0, y1: 20, x2: 1, y2: 20, value: 1 }]);
  });
});

describe("截图计算", () => {
  it("cropBox 按缩放比换算并夹在图片范围内", () => {
    expect(cropBox({ x: 10.2, y: 20.6, width: 50, height: 30 }, 2, 1000, 800)).toEqual({ sx: 20, sy: 41, sw: 101, sh: 61 });
    expect(cropBox({ x: -10, y: 790, width: 50, height: 30 }, 1, 1000, 800)).toEqual({ sx: 0, sy: 790, sw: 40, sh: 10 });
  });

  it("padRect 加留白但不超出视口", () => {
    expect(padRect({ x: 4, y: 100, width: 50, height: 50 }, 16, { width: 60, height: 800 })).toEqual({ x: 0, y: 84, width: 60, height: 82 });
  });

  it("unionRect 取外包矩形", () => {
    expect(unionRect([{ x: 0, y: 10, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }])).toEqual({ x: 0, y: 0, width: 25, height: 20 });
    expect(unionRect([])).toBeNull();
  });

  it("planPageCapture 逐屏滚动，最后一屏贴底", () => {
    expect(planPageCapture(500, 800, 2)).toEqual({ positions: [0], height: 500, truncated: false });
    expect(planPageCapture(2000, 800, 1)).toEqual({ positions: [0, 800, 1200], height: 2000, truncated: false });
    expect(planPageCapture(1600, 800, 1)).toEqual({ positions: [0, 800], height: 1600, truncated: false });
  });

  it("planPageCapture 超过画布上限时截断", () => {
    const plan = planPageCapture(20000, 1000, 2, 16384);
    expect(plan.height).toBe(8192);
    expect(plan.truncated).toBe(true);
    expect(plan.positions.at(-1)).toBe(7192);
  });
});

describe("标题与选择器", () => {
  it("shortSelector 优先 id，最多两个类名", () => {
    expect(shortSelector("BUTTON", "", ["btn", "btn-primary", "large"])).toBe("button.btn.btn-primary");
    expect(shortSelector("DIV", "app", ["x"])).toBe("div#app");
    expect(shortSelector("SPAN", "", ["-hidden", "1col", "ok"])).toBe("span.ok");
  });

  it("pickTitle 按类型生成", () => {
    const rect = { x: 0, y: 0, width: 320.4, height: 180 };
    expect(pickTitle("element", rect, { tag: "button", selector: "button.submit" })).toBe("按钮 button.submit");
    expect(pickTitle("region", rect)).toBe("区域 320×180");
    expect(pickTitle("page", rect)).toBe("整页 320×180");
  });
});

describe("草稿导出", () => {
  const record = {
    id: "r1",
    seq: 3,
    kind: "element" as const,
    title: "按钮 button.submit",
    note: "颜色比设计稿浅",
    pageUrl: "https://shop.example.com/refund",
    pageTitle: "退款申请",
    imageSize: { width: 300, height: 120 },
    elements: [
      {
        selector: "button.submit",
        tag: "button",
        text: "提交",
        rect: { x: 0, y: 0, width: 120, height: 40 },
        styles: [{ title: "文本", items: [{ label: "颜色", value: "#1F2328" }] }]
      },
      { selector: "span.icon", tag: "span", text: "", rect: { x: 0, y: 0, width: 16, height: 16 }, styles: [] }
    ],
    spacings: [{ to: 1, label: "水平 8px", measures: [] }]
  };

  it("引用写成 [#编号 标题]，后面列出记录详情", () => {
    const markdown = draftToMarkdown(
      [
        { type: "text", text: "退款页的 " },
        { type: "ref", id: "r1" },
        { type: "text", text: " 和图标距离不对" },
        { type: "ref", id: "gone" }
      ],
      [record]
    );
    expect(markdown).toContain("退款页的 [#3 按钮 button.submit] 和图标距离不对[已删除的记录]");
    expect(markdown).toContain("### #3 按钮 button.submit");
    expect(markdown).toContain("- 说明：颜色比设计稿浅");
    expect(markdown).toContain("  - 文本：颜色 #1F2328");
    expect(markdown).toContain("- 间距：到 `span.icon` 水平 8px");
  });

  it("没有引用时只输出正文", () => {
    expect(draftToMarkdown([{ type: "text", text: " 只是文字 " }], [record])).toBe("只是文字");
  });

  it("normalizeDraft 丢掉坏数据", () => {
    expect(normalizeDraft([{ type: "text", text: "a" }, { type: "ref", id: 1 }, null, { type: "ref", id: "x" }])).toEqual([
      { type: "text", text: "a" },
      { type: "ref", id: "x" }
    ]);
    expect(normalizeDraft("oops")).toEqual([]);
    expect(normalizeDraft({ 0: { type: "text", text: "a" }, 1: { type: "ref", id: "x" } })).toEqual([
      { type: "text", text: "a" },
      { type: "ref", id: "x" }
    ]);
  });
});
