import { authUrl } from "../api";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import jsonLang from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yamlLang from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";

for (const [name, lang] of Object.entries({ bash, css, diff, go, java, javascript, json: jsonLang, markdown: markdownLang, python, rust, sql, typescript, xml, yaml: yamlLang }))
  hljs.registerLanguage(name, lang);
hljs.registerAliases(["ts", "tsx", "vue"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["sh", "shell", "zsh", "powershell", "ps1"], { languageName: "bash" });
hljs.registerAliases(["html"], { languageName: "xml" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["yml", "toml"], { languageName: "yaml" });

export function highlight(code: string, lang?: string) {
  const l = lang && hljs.getLanguage(lang) ? lang : undefined;
  try {
    return l ? hljs.highlight(code, { language: l }).value : escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

export function languageOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = { ts: "typescript", tsx: "typescript", mts: "typescript", vue: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", go: "go", rs: "rust", java: "java", kt: "java", json: "json", md: "markdown", yml: "yaml", yaml: "yaml", toml: "yaml", css: "css", scss: "css", html: "xml", xml: "xml", sh: "bash", sql: "sql" };
  return map[ext];
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0];
      // The source rides in the attribute URI-encoded: DOMPurify drops attribute values containing "-->" (every flowchart has one).
      if (language === "mermaid") return `<div class="mermaid-box" data-mermaid="${encodeURIComponent(text)}"><pre>${escapeHtml(text)}</pre></div>`;
      return `<pre><code class="hljs${language ? " language-" + escapeHtml(language) : ""}">${highlight(text, language)}</code></pre>`;
    },
    image({ href, title, text }) {
      const src = href.startsWith("omem-file:") ? `/api/files/${encodeURIComponent(href.slice(10))}` : /^https?:/i.test(href) || /^\/api\/files\/[\w.-]+$/.test(href) ? href : "";
      if (!src) return escapeHtml(text);
      const url = escapeHtml(src.startsWith("/api/") ? authUrl(src) : src);
      if (/\.(mp4|mov|webm)$/i.test(src)) return `<video src="${url}" controls preload="metadata" title="${escapeHtml(text)}"></video>`;
      return `<img src="${url}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy" />`;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const t = title ? ` title="${escapeHtml(title)}"` : "";
      let m: RegExpExecArray | null;
      if ((m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(href))) {
        const label = inner.replace(/<[^>]+>/g, "") || "原文";
        return `<a class="cite" href="#" data-cite="source" data-ref="${escapeHtml(decodeURIComponent(m[1]))}"${m[2] ? ` data-from="${m[2]}" data-to="${m[3] ?? m[2]}"` : ""}${t}>${escapeHtml(label)}</a>`;
      }
      if ((m = /^mem:(\S+)$/.exec(href))) return `<a class="cite mem" href="#" data-cite="memory" data-ref="${escapeHtml(m[1])}"${t}>${inner || "记忆"}</a>`;
      if ((m = /^msg:(\S+)$/.exec(href))) return `<a class="cite mem" href="#" data-cite="message" data-ref="${escapeHtml(m[1])}"${t}>${inner || "消息"}</a>`;
      if ((m = /^wiki:(\S+)$/.exec(href))) return `<a class="wikilink" href="#" data-wiki="${escapeHtml(decodeURIComponent(m[1]))}"${t}>${inner}</a>`;
      if (href.startsWith("omem-file:")) return `<a href="${escapeHtml(authUrl(`/api/files/${encodeURIComponent(href.slice(10))}`))}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
      // A code location, [说明](路径:起-止): opens the file (of the run when the text belongs to one, Markdown.vue).
      if ((m = /^((?:[\w.@~-]+\/)*[\w.@~-]+\.[\w]{1,8})(?::L?(\d+)(?:[-–]L?(\d+))?)?$/.exec((() => { try { return decodeURIComponent(href); } catch { return href; } })()))) return `<a class="cite doc code" href="#" data-cite="source" data-uri="${escapeHtml(m[1])}"${m[2] ? ` data-from="${m[2]}" data-to="${m[3] ?? m[2]}"` : ""}${t || ` title="${escapeHtml(m[0])}"`}>${inner || escapeHtml(m[0])}</a>`;
      const safe = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

/**
 * [[slug]] / [[space:slug|label]] → wiki: links; bare mem:/msg: refs → links. Raw HTML in originals
 * (Feishu docs) uses `src="omem-file:…"` for local files and `href="src:<id>"` for local sources.
 */
function preprocess(md: string) {
  return md
    .replace(/\b(src|href)="omem-file:([\w.-]+)"/g, (_, a: string, name: string) => `${a}="${escapeHtml(authUrl(`/api/files/${encodeURIComponent(name)}`))}"`)
    .replace(/<a\b([^>]*?)\bhref="src:([\w-]+)"/g, (_, pre: string, id: string) => `<a${pre}href="#" class="cite doc" data-cite="source" data-ref="${id}"`)
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => `[${(label ?? target.split("/").pop() ?? target).replace(/[[\]]/g, "")}](wiki:${encodeURIComponent(target.trim())})`)
    .replace(/(^|[\s（(，,])((?:mem|msg):[a-z0-9]{8,})/g, (_, pre, ref) => `${pre}[${ref.startsWith("mem") ? "记忆" : "消息"}](${ref})`);
}

export function renderMarkdown(md: string, opts: { breaks?: boolean } = {}): string {
  const html = marked.parse(preprocess(md ?? ""), { async: false, breaks: !!opts.breaks }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-cite", "data-ref", "data-uri", "data-from", "data-to", "data-wiki", "data-mermaid", "target"] });
}

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
/** Loaded once; a failed load (a chunk gone after an update, a dropped connection) is not kept, so the next try loads again. */
function loadMermaid() {
  mermaidLoader ??= import("mermaid")
    .then((m) => {
      const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
      m.default.initialize({ startOnLoad: false, theme: dark || document.documentElement.dataset.theme === "dark" ? "dark" : "neutral", securityLevel: "strict", fontFamily: "inherit" });
      return m.default;
    })
    .catch((e) => {
      mermaidLoader = null;
      throw e;
    });
  return mermaidLoader;
}

/** A diagram box's source (kept URI-encoded in data-mermaid). */
function mermaidSource(box: HTMLElement) {
  try {
    return decodeURIComponent(box.dataset.mermaid ?? "");
  } catch {
    return box.dataset.mermaid ?? "";
  }
}

/** A diagram that did not draw: says so, shows its source left-aligned, and offers another try. */
function showFailed(box: HTMLElement, reason: string) {
  box.dataset.done = "1";
  box.classList.add("failed");
  box.replaceChildren();
  const head = document.createElement("div");
  head.className = "mermaid-failed";
  const text = document.createElement("span");
  text.textContent = reason;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn ghost sm";
  retry.textContent = "重试";
  retry.addEventListener("click", () => {
    delete box.dataset.done;
    box.classList.remove("failed");
    void renderMermaid(box.parentElement ?? box, [box]);
  });
  head.append(text, retry);
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = mermaidSource(box);
  pre.append(code);
  box.append(head, pre);
}

export async function renderMermaid(root: HTMLElement, only?: HTMLElement[]) {
  const boxes = (only ?? [...root.querySelectorAll<HTMLElement>(".mermaid-box[data-mermaid]")]).filter((b) => !b.dataset.done);
  if (!boxes.length) return;
  let mermaid: Awaited<ReturnType<typeof loadMermaid>>;
  try {
    mermaid = await loadMermaid();
  } catch {
    for (const box of boxes) showFailed(box, "画图组件没有加载成功（服务更新过的话，刷新页面后再试）。下面是这张图的源码。");
    return;
  }
  for (const box of boxes) {
    box.dataset.done = "1";
    const id = `m${Math.random().toString(36).slice(2)}`;
    try {
      const { svg } = await mermaid.render(id, mermaidSource(box));
      box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["foreignObject"] });
    } catch (e) {
      // mermaid leaves its scratch element behind when a diagram fails.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
      const why = String((e as Error)?.message ?? "").split("\n")[0].replace(/[:：]\s*$/, "").slice(0, 160);
      showFailed(box, `这张图没画出来${why ? `：${why}` : ""}。下面是它的源码。`);
    }
  }
}

/** Plain `path/file.ext:12-20` references in rendered text become source citations. */
export function linkifyPaths(root: HTMLElement) {
  const re = /(?<![\w/.-])((?:[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z]{1,6}):(\d+)(?:[-–](\d+))?/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("a, pre, .mermaid-box") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      frag.append(text.slice(last, m.index));
      const a = document.createElement("a");
      a.className = "cite";
      a.href = "#";
      a.dataset.cite = "source";
      a.dataset.uri = m[1];
      a.dataset.from = m[2];
      a.dataset.to = m[3] ?? m[2];
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
