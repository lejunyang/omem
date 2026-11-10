// 在页面里取元素和页面的上下文（拾取「记下」时调用一次，之后元素可能已经不在了）。
import {
  accessibleName,
  clipText,
  countDescendants,
  cssPath,
  type ElementContext,
  type ElementLike,
  htmlSnippet,
  type PageContext,
  pickAttributes,
  summarizeChildren
} from "../shared/element-context";

/** 元素前面最近的 h1–h4：先看前面的兄弟，再往上找祖先的前面的兄弟，最多看 300 个节点。 */
function nearestHeading(element: Element): string {
  let current: Element | null = element;
  let steps = 0;
  while (current && steps < 300) {
    let sibling = current.previousElementSibling;
    while (sibling && steps < 300) {
      steps += 1;
      const heading = /^H[1-4]$/.test(sibling.tagName) ? sibling : sibling.querySelector("h1, h2, h3, h4");
      if (heading?.textContent?.trim()) return clipText(heading.textContent, 80).value;
      sibling = sibling.previousElementSibling;
    }
    current = current.parentElement;
    if (current && /^H[1-4]$/.test(current.tagName)) return clipText(current.textContent ?? "", 80).value;
  }
  return clipText(document.querySelector("h1")?.textContent ?? "", 80).value;
}

export function elementContext(element: Element): ElementContext {
  const like = element as unknown as ElementLike;
  // innerText 按渲染结果取（不含隐藏内容和样式文本），比 textContent 更接近人看到的。
  const text = element instanceof HTMLElement ? element.innerText : element.textContent ?? "";
  return {
    path: cssPath(like),
    attributes: pickAttributes(element.attributes as unknown as ArrayLike<{ name: string; value: string }>, element.tagName),
    name: accessibleName(like),
    text: clipText(text ?? "", 600),
    html: htmlSnippet(like),
    children: { count: element.children.length, descendants: countDescendants(like), summary: summarizeChildren(like.children) },
    heading: nearestHeading(element)
  };
}

export function pageContext(): PageContext {
  return {
    url: location.href,
    title: document.title,
    description: clipText(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "", 200).value,
    lang: document.documentElement.lang || navigator.language,
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
    userAgent: navigator.userAgent,
    selection: clipText(getSelection()?.toString() ?? "", 400).value
  };
}
