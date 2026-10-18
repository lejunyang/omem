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
      if (language === "mermaid") return `<div class="mermaid-box" data-mermaid="${escapeHtml(text)}"><pre>${escapeHtml(text)}</pre></div>`;
      return `<pre><code class="hljs${language ? " language-" + escapeHtml(language) : ""}">${highlight(text, language)}</code></pre>`;
    },
    image({ href, title, text }) {
      const src = href.startsWith("omem-file:") ? `/api/files/${encodeURIComponent(href.slice(10))}` : /^https?:/i.test(href) || /^\/api\/files\/[\w.-]+$/.test(href) ? href : "";
      return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy" />` : escapeHtml(text);
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
      const safe = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
  },
});

/** [[slug]] / [[space:slug|label]] → wiki: links; bare mem:/msg: refs → links. */
function preprocess(md: string) {
  return md
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => `[${(label ?? target.split("/").pop() ?? target).replace(/[[\]]/g, "")}](wiki:${encodeURIComponent(target.trim())})`)
    .replace(/(^|[\s（(，,])((?:mem|msg):[a-z0-9]{8,})/g, (_, pre, ref) => `${pre}[${ref.startsWith("mem") ? "记忆" : "消息"}](${ref})`);
}

export function renderMarkdown(md: string, opts: { breaks?: boolean } = {}): string {
  const html = marked.parse(preprocess(md ?? ""), { async: false, breaks: !!opts.breaks }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-cite", "data-ref", "data-from", "data-to", "data-wiki", "data-mermaid", "target"] });
}

let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
export async function renderMermaid(root: HTMLElement) {
  const boxes = [...root.querySelectorAll<HTMLElement>(".mermaid-box[data-mermaid]")].filter((b) => !b.dataset.done);
  if (!boxes.length) return;
  mermaidLoader ??= import("mermaid").then((m) => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";
    m.default.initialize({ startOnLoad: false, theme: dark || document.documentElement.dataset.theme === "dark" ? "dark" : "neutral", securityLevel: "strict", fontFamily: "inherit" });
    return m.default;
  });
  const mermaid = await mermaidLoader;
  for (const box of boxes) {
    box.dataset.done = "1";
    try {
      const { svg } = await mermaid.render(`m${Math.random().toString(36).slice(2)}`, box.dataset.mermaid!);
      box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["foreignObject"] });
    } catch {
      box.classList.add("failed");
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
