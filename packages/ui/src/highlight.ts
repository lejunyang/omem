import hljs from "highlight.js/lib/core";

// Literal imports let Vite resolve every chunk in development and production.
const loaders = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  json: () => import("highlight.js/lib/languages/json"),
  ini: () => import("highlight.js/lib/languages/ini"),
  bash: () => import("highlight.js/lib/languages/bash"),
};
const aliases: Record<string, keyof typeof loaders> = {
  ts: "typescript", tsx: "typescript", typescript: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", javascript: "javascript",
  vue: "xml", html: "xml", xml: "xml", css: "css",
  md: "markdown", markdown: "markdown", json: "json", toml: "ini", ini: "ini", sh: "bash", bash: "bash",
};

export function escapeCode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function highlightCode(code: string, language: string): Promise<string> {
  const lang = aliases[language.toLowerCase()];
  if (!lang) return escapeCode(code);
  const required: (keyof typeof loaders)[] = lang === "xml" ? ["xml", "javascript", "css"] : [lang];
  await Promise.all(required.map(async (name) => {
    if (!hljs.getLanguage(name)) hljs.registerLanguage(name, (await loaders[name]()).default);
  }));
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

/** Preserve multiline lexer state while making each numbered row valid HTML.
 * Input is exclusively highlight.js output (escaped text and generated spans). */
export function highlightedLines(html: string): string[] {
  const stack: string[] = [];
  const lines = [""];
  for (const token of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (token === "\n") {
      lines[lines.length - 1] += "</span>".repeat(stack.length);
      lines.push(stack.join(""));
    } else {
      lines[lines.length - 1] += token;
      if (token.startsWith("<span")) stack.push(token);
      else if (token === "</span>") stack.pop();
    }
  }
  return lines;
}
