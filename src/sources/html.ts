/**
 * HTML from a platform (a Confluence page, a mail, an exported document) as Markdown: headings,
 * paragraphs, lists, links, tables and code kept; scripts, styles and markup dropped. Not a full
 * converter: enough for text to read and search.
 */
const ENTITIES: Record<string, string> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const inline = (s: string) => decode(s.replace(/<[^>]+>/g, "")).replace(/[ \t\r\n]+/g, " ").trim();

export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t: string) => `\n\n\`\`\`\n${decode(t.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, t: string) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1]).replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return `\n\n${[line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${inline(t)}\n\n`);
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => {
    const text = inline(t);
    return text && href && !href.startsWith("#") && text !== href ? `[${text}](${decode(href)})` : text || decode(href);
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => (inline(t) ? `**${inline(t)}**` : ""));
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${inline(t)}\``);
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t: string) => `\n\n${inline(t.replace(/<(p|div|br)[^>]*>/gi, " "))
    .split(/\n/)
    .map((l) => `> ${l}`)
    .join("\n")}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div|section|article|ul|ol|tr|header|footer|main)[^>]*>/gi, "\n\n");
  s = decode(s.replace(/<[^>]+>/g, ""));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/^ (?=\S)/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
