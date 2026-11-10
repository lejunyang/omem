// 拾取：页面上的选取界面。ISOLATED world 内容脚本，由后台按需注入（activeTab 或站点授权）。
// 界面全部放在 Shadow DOM 里：不受页面样式影响，也不改页面样式。截图由后台做，这里只负责选取、测量和整页滚动。
import {
  describeMeasures,
  groupPickStyles,
  measureBetween,
  padRect,
  PICK_STYLE_PROPERTIES,
  type PickComputedStyle,
  type PickElement,
  type PickKind,
  type PickMeasure,
  type PickRect,
  type PickSpacing,
  planPageCapture,
  shortSelector,
  unionRect
} from "../shared/pick";
import type { PickCommitPayload, PickResponse, PickStartMode } from "../shared/pick-messages";
import { elementContext, pageContext } from "./dom-context";
import { OVERLAY_CSS } from "./pick-overlay-style";

interface PickApi {
  activate(mode: PickStartMode): void;
}

declare global {
  interface Window {
    __omemPick?: PickApi;
  }
}

if (!window.__omemPick) window.__omemPick = createPicker();

function createPicker(): PickApi {
  let active = false;
  let mode: "element" | "region" = "element";
  let hovered: Element | null = null;
  let primary: Element | null = null;
  const secondaries: Element[] = [];
  let region: PickRect | null = null;
  let dragStart: { x: number; y: number } | null = null;
  let withMarks = true;
  let busy = false;

  const host = document.createElement("omem-pick-root");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${OVERLAY_CSS}</style>
    <div class="layer marks"></div>
    <div class="layer hover"></div>
    <div class="region-catcher" hidden></div>
    <div class="toolbar" role="toolbar" aria-label="拾取">
      <div class="seg">
        <button data-mode="element" title="单击选中元素（E）">元素</button>
        <button data-mode="region" title="拖动框选区域（R）">区域</button>
        <button data-action="viewport" title="截当前可视区（V）">可视区</button>
        <button data-action="page" title="截整页（P）">整页</button>
      </div>
      <label class="check" title="截图里保留高亮和距离线"><input type="checkbox" checked data-role="marks" />标注</label>
      <span class="hint"></span>
      <button class="primary" data-action="commit" disabled title="Enter">记下</button>
      <button data-action="basket" title="打开拾取篮">拾取篮</button>
      <button class="icon" data-action="close" title="退出（Esc）" aria-label="退出">✕</button>
    </div>
    <aside class="card" hidden></aside>
    <div class="toast" hidden></div>`;
  const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const marksLayer = $<HTMLDivElement>(".marks");
  const hoverLayer = $<HTMLDivElement>(".hover");
  const catcher = $<HTMLDivElement>(".region-catcher");
  const toolbar = $<HTMLDivElement>(".toolbar");
  const card = $<HTMLElement>(".card");
  const toast = $<HTMLDivElement>(".toast");
  const hint = $<HTMLSpanElement>(".hint");
  const commitButton = $<HTMLButtonElement>('[data-action="commit"]');

  toolbar.addEventListener("click", (event) => {
    const button = (event.target as Element).closest("button");
    if (!button) return;
    if (button.dataset.mode) setMode(button.dataset.mode as "element" | "region");
    const action = button.dataset.action;
    if (action === "viewport") void commit("viewport");
    if (action === "page") void commit("page");
    if (action === "commit") void commit(mode === "region" ? "region" : "element");
    if (action === "basket") openBasket();
    if (action === "close") deactivate();
  });
  $<HTMLInputElement>('[data-role="marks"]').addEventListener("change", (event) => {
    withMarks = (event.target as HTMLInputElement).checked;
  });
  card.addEventListener("click", (event) => {
    const button = (event.target as Element).closest("button");
    if (button?.dataset.action === "remove") {
      secondaries.splice(Number(button.dataset.index), 1);
      render();
    }
    if (button?.dataset.action === "copy" && primary) void navigator.clipboard.writeText(cardText());
  });

  catcher.addEventListener("mousedown", (event) => {
    event.preventDefault();
    dragStart = { x: event.clientX, y: event.clientY };
    region = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
    render();
  });
  catcher.addEventListener("mousemove", (event) => {
    if (!dragStart) return;
    region = {
      x: Math.min(dragStart.x, event.clientX),
      y: Math.min(dragStart.y, event.clientY),
      width: Math.abs(event.clientX - dragStart.x),
      height: Math.abs(event.clientY - dragStart.y)
    };
    render();
  });
  catcher.addEventListener("mouseup", () => {
    dragStart = null;
    if (region && (region.width < 4 || region.height < 4)) region = null;
    render();
  });

  function isOurs(event: Event): boolean {
    return event.composedPath().includes(host);
  }

  // 页面事件在捕获阶段拦下：元素模式下点击只用来选取，不触发页面行为；按住 Alt 时放行，方便先展开菜单再选。
  const onMove = (event: MouseEvent) => {
    if (!active || mode !== "element" || isOurs(event) || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target !== hovered) {
      hovered = target;
      render();
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!active || mode !== "element" || isOurs(event) || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (event.shiftKey && primary && target !== primary) {
      const index = secondaries.indexOf(target);
      if (index >= 0) secondaries.splice(index, 1);
      else secondaries.push(target);
    } else {
      primary = target === primary ? null : target;
      secondaries.length = 0;
    }
    render();
  };
  const swallow = (event: Event) => {
    if (active && mode === "element" && !isOurs(event) && !(event as MouseEvent).altKey) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (!active || busy) return;
    const editing = isOurs(event) && (event.target as Element)?.tagName === "INPUT";
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (region || primary) {
        region = null;
        primary = null;
        secondaries.length = 0;
        render();
      } else {
        deactivate();
      }
      return;
    }
    if (editing || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" && canCommit()) {
      event.preventDefault();
      void commit(mode === "region" ? "region" : "element");
    }
    const key = event.key.toLowerCase();
    if (key === "e") setMode("element");
    if (key === "r") setMode("region");
    if (key === "v") void commit("viewport");
    if (key === "p") void commit("page");
  };
  const onViewportChange = () => {
    if (active) render();
  };

  function setMode(next: "element" | "region"): void {
    mode = next;
    region = null;
    hovered = null;
    render();
  }

  function activate(startMode: PickStartMode): void {
    if (!active) {
      active = true;
      document.documentElement.appendChild(host);
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("click", onClick, true);
      for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) document.addEventListener(type, swallow, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onViewportChange, true);
      window.addEventListener("resize", onViewportChange);
    }
    if (startMode === "viewport" || startMode === "page") {
      setMode("element");
      // popup 关闭、页面重新获得焦点后再截，避免截到正在消失的弹层。
      setTimeout(() => void commit(startMode), 250);
      return;
    }
    setMode(startMode);
  }

  function deactivate(): void {
    active = false;
    hovered = null;
    primary = null;
    secondaries.length = 0;
    region = null;
    host.remove();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"]) document.removeEventListener(type, swallow, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
  }

  function canCommit(): boolean {
    return mode === "region" ? Boolean(region) : Boolean(primary);
  }

  // ---------- 绘制 ----------

  function render(): void {
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>("[data-mode]")) button.classList.toggle("on", button.dataset.mode === mode);
    catcher.hidden = mode !== "region";
    commitButton.disabled = !canCommit();
    hint.textContent =
      mode === "region"
        ? region
          ? `${Math.round(region.width)} × ${Math.round(region.height)} · Enter 记下`
          : "拖动框选区域"
        : primary
          ? "Shift+单击 加次元素量间距 · Enter 记下"
          : "单击选中元素 · 按住 Alt 可操作页面";

    hoverLayer.replaceChildren();
    if (mode === "element" && hovered && hovered !== primary && !secondaries.includes(hovered)) {
      hoverLayer.append(...boxModel(hovered));
      if (primary) hoverLayer.append(...measureMarks(measureBetween(rectOf(primary), rectOf(hovered)), true));
    }

    marksLayer.replaceChildren();
    if (mode === "region" && region) {
      marksLayer.append(div("region", region), label(`${Math.round(region.width)} × ${Math.round(region.height)}`, region, "accent"));
    }
    if (mode === "element" && primary) {
      const primaryRect = rectOf(primary);
      marksLayer.append(div("primary", primaryRect), label(`${describe(primary)}  ${Math.round(primaryRect.width)}×${Math.round(primaryRect.height)}`, primaryRect, "accent"));
      secondaries.forEach((element, index) => {
        const rect = rectOf(element);
        marksLayer.append(div("secondary", rect), label(`${index + 1}`, rect, "muted"), ...measureMarks(measureBetween(primaryRect, rect), false));
      });
    }
    renderCard();
  }

  function boxModel(element: Element): HTMLElement[] {
    const rect = rectOf(element);
    const style = getComputedStyle(element);
    const n = (value: string) => Number.parseFloat(value) || 0;
    const margin = { t: n(style.marginTop), r: n(style.marginRight), b: n(style.marginBottom), l: n(style.marginLeft) };
    const padding = { t: n(style.paddingTop) + n(style.borderTopWidth), r: n(style.paddingRight) + n(style.borderRightWidth), b: n(style.paddingBottom) + n(style.borderBottomWidth), l: n(style.paddingLeft) + n(style.borderLeftWidth) };
    const outer = { x: rect.x - margin.l, y: rect.y - margin.t, width: rect.width + margin.l + margin.r, height: rect.height + margin.t + margin.b };
    const content = { x: rect.x + padding.l, y: rect.y + padding.t, width: Math.max(0, rect.width - padding.l - padding.r), height: Math.max(0, rect.height - padding.t - padding.b) };
    return [
      div("box-margin", outer),
      div("box-padding", rect),
      div("box-content", content),
      label(`${describe(element)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`, rect, "dark")
    ];
  }

  function measureMarks(measures: PickMeasure[], transient: boolean): HTMLElement[] {
    return measures.flatMap((measure) => {
      const horizontal = measure.axis === "x";
      const line = document.createElement("div");
      line.className = `measure ${horizontal ? "h" : "v"}${transient ? " transient" : ""}`;
      line.style.left = `${Math.min(measure.x1, measure.x2)}px`;
      line.style.top = `${Math.min(measure.y1, measure.y2)}px`;
      line.style[horizontal ? "width" : "height"] = `${Math.abs(horizontal ? measure.x2 - measure.x1 : measure.y2 - measure.y1)}px`;
      const tag = document.createElement("span");
      tag.className = "measure-tag";
      tag.textContent = `${measure.value}`;
      tag.style.left = `${(measure.x1 + measure.x2) / 2}px`;
      tag.style.top = `${(measure.y1 + measure.y2) / 2}px`;
      return [line, tag];
    });
  }

  function renderCard(): void {
    if (mode !== "element" || !primary) {
      card.hidden = true;
      return;
    }
    const info = elementInfo(primary);
    const rect = rectOf(primary);
    card.hidden = false;
    // 主元素在右侧时卡片放左边，免得挡住要看的东西。
    card.classList.toggle("left", rect.x + rect.width / 2 > window.innerWidth * 0.6);
    const groups = info.styles
      .map(
        (group) => `<section><h4>${esc(group.title)}</h4><dl>${group.items
          .map((item) => `<dt>${esc(item.label)}</dt><dd>${item.color ? `<i class="swatch" style="background:${esc(item.color)}"></i>` : ""}<span>${esc(item.value)}</span></dd>`)
          .join("")}</dl></section>`
      )
      .join("");
    const spacing = secondaries.length
      ? `<section><h4>间距</h4><ol class="spacing">${secondaries
          .map((element, index) => `<li><b>${index + 1}</b><code>${esc(describe(element))}</code><span>${esc(describeMeasures(measureBetween(rect, rectOf(element))))}</span><button class="icon small" data-action="remove" data-index="${index}" title="移除" aria-label="移除">✕</button></li>`)
          .join("")}</ol></section>`
      : `<p class="tip">Shift + 单击其他元素，量它们和主元素之间的距离。</p>`;
    card.innerHTML = `<header><code>${esc(info.selector)}</code><span>${Math.round(rect.width)} × ${Math.round(rect.height)}</span></header>
      ${info.text ? `<p class="text">「${esc(info.text)}」</p>` : ""}
      ${groups || `<p class="tip">没有需要关注的样式。</p>`}
      ${spacing}
      <footer><button data-action="copy">复制样式</button></footer>`;
  }

  function cardText(): string {
    if (!primary) return "";
    const info = elementInfo(primary);
    return [info.selector, ...info.styles.map((group) => `${group.title}：${group.items.map((item) => `${item.label} ${item.value}`).join("；")}`)].join("\n");
  }

  // ---------- 记下 ----------

  async function commit(kind: PickKind): Promise<void> {
    if (busy) return;
    if ((kind === "element" || kind === "region") && !canCommit()) return;
    busy = true;
    try {
      if (kind === "element" && primary) ensureVisible(primary);
      const payload = kind === "page" ? await capturePage() : collect(kind);
      if (!payload) return;
      const response = await sendCommit(payload, kind !== "page" && withMarks && kind !== "viewport");
      if (response?.ok) {
        showToast(`已记下 #${response.seq}`, true);
        primary = null;
        secondaries.length = 0;
        region = null;
        render();
      } else {
        showToast(response?.error || "截图失败", false);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), false);
    } finally {
      busy = false;
      toolbar.hidden = false;
    }
  }

  function collect(kind: PickKind): PickCommitPayload | null {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const base = { pageUrl: location.href, pageTitle: document.title, pageContext: pageContext(), viewport };
    if (kind === "viewport") {
      const clip = { x: 0, y: 0, ...viewport };
      return { ...base, kind, clip, rect: { ...clip, x: scrollX, y: scrollY }, elements: [], spacings: [] };
    }
    if (kind === "region" && region) {
      return { ...base, kind, clip: region, rect: toPage(region), elements: [], spacings: [] };
    }
    if (kind === "element" && primary) {
      const all = [primary, ...secondaries];
      // 记下时才取完整上下文（路径、属性、精简 HTML）：大元素算一次就够，卡片刷新不用每次都算。
      const elements = all.map((element) => elementInfo(element, true));
      const primaryRect = rectOf(primary);
      const spacings: PickSpacing[] = secondaries.map((element, index) => {
        const measures = measureBetween(primaryRect, rectOf(element));
        return { to: index + 1, label: describeMeasures(measures), measures };
      });
      const marks = withMarks ? [...marksLayer.children].map((node) => rectOf(node)) : [];
      const clip = padRect(unionRect([...all.map(rectOf), ...marks])!, 12, viewport);
      return { ...base, kind, clip, rect: toPage(primaryRect), elements, spacings };
    }
    return null;
  }

  async function sendCommit(payload: PickCommitPayload, keepMarks: boolean): Promise<PickResponse | undefined> {
    // 截图时只留标注（可关），工具条、卡片、悬停框都藏起来。
    toolbar.hidden = true;
    card.hidden = true;
    hoverLayer.hidden = true;
    marksLayer.hidden = !keepMarks;
    catcher.hidden = true;
    await nextPaint();
    try {
      return (await chrome.runtime.sendMessage({ type: "omem-pick:commit", payload })) as PickResponse | undefined;
    } finally {
      hoverLayer.hidden = false;
      marksLayer.hidden = false;
      render();
    }
  }

  /** 整页：CDP 开启时后台一次截完；否则逐屏滚动截取，从第二屏起藏掉 fixed / sticky 元素避免重复。 */
  async function capturePage(): Promise<PickCommitPayload | null> {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const docWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, viewport.width);
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, viewport.height);
    const plan = planPageCapture(docHeight, viewport.height, window.devicePixelRatio);
    const base: PickCommitPayload = {
      kind: "page",
      clip: { x: 0, y: 0, ...viewport },
      rect: { x: 0, y: 0, width: docWidth, height: plan.height },
      elements: [],
      spacings: [],
      pageUrl: location.href,
      pageTitle: document.title,
      pageContext: pageContext(),
      viewport,
      page: { width: docWidth, height: plan.height, truncated: plan.truncated }
    };
    const begin = (await chrome.runtime.sendMessage({ type: "omem-pick:grab-begin" })) as { ok: boolean; cdp?: boolean; error?: string } | undefined;
    if (!begin?.ok) throw new Error(begin?.error || "无法开始整页截图");
    host.style.display = "none";
    const savedX = scrollX;
    const savedY = scrollY;
    const hidden: Array<[HTMLElement, string]> = [];
    try {
      if (begin.cdp) return base;
      for (const [index, position] of plan.positions.entries()) {
        window.scrollTo(0, position);
        await nextPaint();
        await sleep(120);
        if (index === 1) hideFixedElements(hidden);
        const grabbed = (await chrome.runtime.sendMessage({ type: "omem-pick:grab", scrollY: window.scrollY })) as PickResponse | undefined;
        if (!grabbed?.ok) throw new Error(grabbed?.error || "截图失败");
      }
      return base;
    } finally {
      for (const [element, visibility] of hidden) element.style.visibility = visibility;
      window.scrollTo(savedX, savedY);
      host.style.display = "";
    }
  }

  function hideFixedElements(hidden: Array<[HTMLElement, string]>): void {
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as HTMLElement;
      const position = getComputedStyle(element).position;
      if (position === "fixed" || position === "sticky") {
        hidden.push([element, element.style.visibility]);
        element.style.visibility = "hidden";
      }
    }
  }

  function openBasket(): void {
    void chrome.runtime.sendMessage({ type: "omem-pick:open-basket" }).then((response: PickResponse | undefined) => {
      if (!response?.ok) showToast("请按 Alt+Shift+S 或在扩展菜单中打开拾取篮", false);
    });
  }

  let toastTimer = 0;
  function showToast(text: string, ok: boolean): void {
    toast.hidden = false;
    toast.className = `toast ${ok ? "ok" : "error"}`;
    toast.innerHTML = ok ? `<span>${esc(text)}</span><button data-action="basket">打开拾取篮</button>` : `<span>${esc(text)}</span>`;
    toast.querySelector("button")?.addEventListener("click", openBasket);
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
  }

  return { activate };
}

// ---------- 工具函数 ----------

function rectOf(element: Element): PickRect {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function toPage(rect: PickRect): PickRect {
  return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
}

function describe(element: Element): string {
  return shortSelector(element.tagName, element.id, [...element.classList]);
}

function ownText(element: Element): string {
  let text = "";
  for (const node of element.childNodes) if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function elementInfo(element: Element, withContext = false): PickElement {
  const computed = getComputedStyle(element);
  const style: PickComputedStyle = {};
  for (const property of PICK_STYLE_PROPERTIES) style[property] = computed.getPropertyValue(property);
  const text = ownText(element) || (["INPUT", "TEXTAREA"].includes(element.tagName) ? ((element as HTMLInputElement).value || (element as HTMLInputElement).placeholder) : "");
  const rect = rectOf(element);
  return {
    selector: describe(element),
    tag: element.tagName.toLowerCase(),
    text: text.slice(0, 120),
    rect: toPage(rect),
    styles: groupPickStyles(style, Boolean(text)),
    ...(withContext ? { context: elementContext(element) } : {})
  };
}

function ensureVisible(element: Element): void {
  const rect = element.getBoundingClientRect();
  if (rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
    element.scrollIntoView({ block: "center", inline: "center" });
  }
}

function div(className: string, rect: PickRect): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  node.style.left = `${rect.x}px`;
  node.style.top = `${rect.y}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
  return node;
}

function label(text: string, rect: PickRect, tone: "accent" | "muted" | "dark"): HTMLSpanElement {
  const node = document.createElement("span");
  node.className = `label ${tone}`;
  node.textContent = text;
  // 默认贴在元素上方，放不下时放到下方。
  const above = rect.y > 24;
  node.style.left = `${Math.max(4, Math.min(rect.x, window.innerWidth - 220))}px`;
  node.style.top = above ? `${rect.y - 22}px` : `${Math.min(window.innerHeight - 22, rect.y + rect.height + 4)}px`;
  return node;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
