import { describe, expect, it } from "vitest";
import { normalizeConnections, normalizeOmemUrl, type OmemConnection, originPattern, resolveEndpoint } from "./connections";
import {
  clipText,
  cssPath,
  type ElementLike,
  htmlSnippet,
  isGeneratedClass,
  type NodeLike,
  pickAttributes,
  summarizeChildren
} from "./element-context";
import { buildClip } from "./pick-clip";

// ---------- 假 DOM：只实现 element-context 用到的接口 ----------
type FakeElement = ElementLike & { childNodes: NodeLike[]; children: FakeElement[] };
function el(tag: string, attrs: Record<string, string> = {}, kids: Array<FakeElement | string> = []): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    classList: (attrs.class ?? "").split(/\s+/).filter(Boolean),
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    parentElement: null,
    children: [],
    childNodes: [],
    getAttribute: (name) => attrs[name] ?? null,
    get textContent() {
      return node.childNodes.map((child) => child.textContent ?? "").join("");
    }
  };
  for (const kid of kids) {
    if (typeof kid === "string") node.childNodes.push({ nodeType: 3, textContent: kid, childNodes: [] });
    else {
      kid.parentElement = node;
      node.children.push(kid);
      node.childNodes.push(kid);
    }
  }
  return node;
}

describe("元素上下文", () => {
  it("clipText 合并空白，超长时留头尾并注明省略多少", () => {
    expect(clipText("  a \n b  ")).toEqual({ value: "a b", total: 3, truncated: false });
    const long = clipText("x".repeat(1000), 100);
    expect(long.truncated).toBe(true);
    expect(long.total).toBe(1000);
    expect(long.value).toContain("省略 905 字");
    expect(long.value.length).toBeLessThan(140);
  });

  it("认出构建工具生成的类名", () => {
    for (const name of ["css-1x2y3z", "sc-AbCdE", "_3Fx9kQ", "Button__root__a1B2c", "btn-9f8e7d6c"]) expect(isGeneratedClass(name)).toBe(true);
    for (const name of ["btn", "btn-primary", "card", "h2", "col12", "mt-4"]) expect(isGeneratedClass(name)).toBe(false);
  });

  it("cssPath 用 id、稳定类名和同类序号，遇到 id 停下", () => {
    const submit = el("button", { class: "btn css-a1b2c3 btn-primary" }, ["提交"]);
    const cancel = el("button", { class: "btn" }, ["取消"]);
    const actions = el("div", { class: "actions" }, [cancel, submit]);
    const card = el("section", { id: "refund-card" }, [actions]);
    el("main", {}, [card]);
    expect(cssPath(submit)).toBe("section#refund-card > div.actions > button.btn.btn-primary:nth-of-type(2)");
    // 自己有 id 也往上带几层，看得出在哪一块
    const own = el("a", { id: "help" });
    el("div", { class: "tips" }, [own]);
    const wrap = el("aside", { id: "side" }, [own.parentElement as FakeElement]);
    el("body", {}, [wrap]);
    expect(cssPath(own)).toBe("aside#side > div.tips > a#help");
    const tested = el("span", { "data-testid": "amount" });
    el("div", {}, [tested]);
    expect(cssPath(tested)).toBe('div > span[data-testid="amount"]');
  });

  it("cssPath 太深时只留最近几层", () => {
    let leaf = el("span");
    let node = leaf;
    for (let i = 0; i < 12; i += 1) node = el("div", { class: `l${i}` }, [node]);
    expect(cssPath(leaf, 3).startsWith("… > ")).toBe(true);
    expect(cssPath(leaf, 3).split(" > ")).toHaveLength(4);
    leaf = node;
  });

  it("pickAttributes 留 data-* / aria-*，丢事件处理器和密码，截断长值", () => {
    const attrs = pickAttributes(
      [
        { name: "class", value: "a b" },
        { name: "data-order-id", value: "20261110" },
        { name: "aria-label", value: "提交" },
        { name: "onclick", value: "pay()" },
        { name: "style", value: "color:red" },
        { name: "data-auth-token", value: "secret" },
        { name: "src", value: `data:image/png;base64,${"A".repeat(500)}` },
        { name: "title", value: "t".repeat(300) }
      ],
      "button"
    );
    expect(Object.keys(attrs)).toEqual(["class", "data-order-id", "aria-label", "src", "title"]);
    expect(attrs.src).toMatch(/^data:image\/png;base64,…（\d+ 字）$/);
    expect(attrs.title).toMatch(/…（300 字）$/);
    expect(pickAttributes([{ name: "type", value: "password" }, { name: "value", value: "hunter2" }], "input")).toEqual({ type: "password" });
    expect(pickAttributes([{ name: "value", value: "小王" }], "input")).toEqual({ value: "小王" });
  });

  it("summarizeChildren 按标签和类名计数", () => {
    const list = el("ul", {}, [...Array.from({ length: 24 }, () => el("li", { class: "item css-x9y8z7" })), el("li", { class: "more" })]);
    expect(summarizeChildren(list.children)).toBe("li.item ×24、li.more ×1");
  });

  it("htmlSnippet 只展开几层、每层几个子节点，去掉 script，svg 只留开头", () => {
    const rows = Array.from({ length: 10 }, (_, i) => el("li", { class: "row", "data-id": String(i) }, [`第 ${i} 行`, el("span", {}, [el("b", {}, ["深层"])])]));
    const root = el("div", { class: "list", onclick: "x()" }, [el("script", {}, ["alert(1)"]), el("svg", { class: "icon" }, [el("path", { d: "M0 0L10 10" })]), el("ul", {}, rows)]);
    const html = htmlSnippet(root, { depth: 2, width: 3 });
    expect(html).toContain('<div class="list">');
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain('<svg class="icon">…</svg>');
    expect(html).toContain("还有 7 个子节点");
    expect(html).toContain("<!-- 1 个子元素 -->");
    expect(htmlSnippet(el("p", {}, ["x".repeat(5000)]), { maxLength: 200 }).length).toBeLessThan(260);
  });
});

describe("连接", () => {
  const local: OmemConnection = { id: "a", name: "本机", kind: "local", url: "http://127.0.0.1:4317", token: "om_local", createdAt: 1 };
  const peer: OmemConnection = { id: "b", name: "服务器", kind: "peer", url: "", token: "", via: "a", peer: "server-1", createdAt: 2 };

  it("地址只留 origin，没写协议时补 http", () => {
    expect(normalizeOmemUrl("192.168.1.20:4317/#/ask")).toBe("http://192.168.1.20:4317");
    expect(normalizeOmemUrl("https://omem.example.com/wiki/x")).toBe("https://omem.example.com");
    expect(() => normalizeOmemUrl("ftp://x")).toThrow();
    expect(originPattern("http://127.0.0.1:4317")).toBe("http://127.0.0.1/*");
  });

  it("设备连接用中转连接的地址和令牌", () => {
    expect(resolveEndpoint(peer, [local, peer])).toEqual({ base: "http://127.0.0.1:4317/api/peers/server-1", web: null, token: "om_local", origin: "http://127.0.0.1:4317" });
    expect(resolveEndpoint(local, [local])).toMatchObject({ base: "http://127.0.0.1:4317", web: "http://127.0.0.1:4317", token: "om_local" });
    expect(() => resolveEndpoint(peer, [peer])).toThrow("已被删除");
  });

  it("normalizeConnections 兼容数字键对象，丢掉坏数据", () => {
    expect(normalizeConnections({ 0: local, 1: peer, 2: { id: "x", name: "坏", kind: "peer" }, 3: { id: "y", kind: "remote" } }).map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("发给 omem 的内容", () => {
  const record = {
    id: "r1",
    seq: 3,
    kind: "element" as const,
    title: "按钮 button#submit",
    note: "颜色偏浅",
    pageUrl: "https://shop.example.com/refund",
    pageTitle: "退款申请",
    imageSize: { width: 200, height: 80 },
    pageContext: { url: "https://shop.example.com/refund", title: "退款申请", description: "示例商城", lang: "zh-CN", viewport: { width: 1280, height: 800 }, devicePixelRatio: 2, scroll: { x: 0, y: 120 }, userAgent: "UA", selection: "" },
    elements: [
      {
        selector: "button#submit",
        tag: "button",
        text: "提交申请",
        rect: { x: 0, y: 0, width: 90, height: 36 },
        styles: [{ title: "文本", items: [{ label: "颜色", value: "#FFFFFF" }] }],
        context: {
          path: "section#refund-card > div.actions > button#submit",
          attributes: { id: "submit", class: "btn btn-primary", "data-track": "refund_submit" },
          name: "提交申请",
          text: { value: "提交申请", total: 4, truncated: false },
          html: '<button id="submit" class="btn btn-primary">\n  提交申请\n</button>',
          children: { count: 0, descendants: 0, summary: "" },
          heading: "申请退款"
        }
      }
    ],
    spacings: []
  };

  it("正文在前、引用换成编号，后面列页面、截图占位和元素上下文", () => {
    const clip = buildClip([{ type: "text", text: "提交按钮颜色不对 " }, { type: "ref", id: "r1" }], [record])!;
    expect(clip.title).toBe("提交按钮颜色不对");
    expect(clip.pageUrl).toBe("https://shop.example.com/refund");
    expect(clip.images).toEqual([{ key: "r3", recordId: "r1", title: "#3 按钮 button#submit" }]);
    expect(clip.text.startsWith("提交按钮颜色不对 [#3 按钮 button#submit]")).toBe(true);
    for (const part of ["## 引用的记录", "{{image:r3}}", "- 页面：退款申请（https://shop.example.com/refund）", "滚动到 120px", "- 位置：`section#refund-card > div.actions > button#submit`", "所在区块：申请退款", '`data-track="refund_submit"`', "```html", "- 说明：颜色偏浅", "样式 · 文本：颜色 #FFFFFF"]) {
      expect(clip.text).toContain(part);
    }
  });

  it("只引用记录、没写字时用记录做标题；什么都没有返回 null", () => {
    expect(buildClip([{ type: "ref", id: "r1" }], [record])!.title).toBe("退款申请：按钮 button#submit");
    expect(buildClip([{ type: "text", text: "  " }], [record])).toBeNull();
  });
});
