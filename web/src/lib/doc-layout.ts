/**
 * Layout of documents read from Feishu, on top of the Markdown renderer (markdown.ts): tables get
 * column widths, callouts their icon beside the text, and the other export format's table tags become
 * ordinary HTML.
 */

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A Feishu colour name (light-orange, red, …) as the callout's colour, when it is one this page draws. */
function calloutColor(name: string) {
  const c = /red|orange|yellow|green|blue|purple|gr[ae]y/.exec(name)?.[0];
  return c ? ` data-color="${c === "grey" ? "gray" : c}"` : "";
}

/**
 * Feishu's other document export (files kept in a repository): `<lark-table column-widths="…">` with
 * `<lark-tr>` / `<lark-td>` holding indented Markdown, `<quote-container>`, `<callout emoji="name">`,
 * `{align="center"}` after a line. Turned into the HTML the rest of the page knows: the table keeps its
 * column widths (sizeTables), cells are unindented (four spaces would read as code).
 */
export function docBlocks(md: string) {
  if (!/<(lark-table|quote-container|callout)\b/.test(md)) return md;
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
  const span = (a: string, name: string) => {
    const m = new RegExp(`${name}="(\\d+)"`).exec(a);
    return m ? ` ${name}="${m[1]}"` : "";
  };
  return md
    .replace(/<lark-table\b[^>]*>[\s\S]*?<\/lark-table>/g, (block) =>
      block
        .split("\n")
        .map((l) => l.trim().replace(/\s*\{align="\w+"\}$/, ""))
        .join("\n")
        .replace(/<lark-table\b[^>]*>/, (tag) => `\n\n<table data-widths="${escapeAttr(attr(tag, "column-widths"))}">\n`)
        .replace(/<lark-tr>/g, "<tr>")
        .replace(/<\/lark-tr>/g, "</tr>")
        .replace(/<lark-td\b([^>]*)>/g, (_, a: string) => `<td${span(a, "colspan")}${span(a, "rowspan")}>\n`)
        .replace(/<\/lark-td>/g, "\n</td>")
        .replace(/<\/lark-table>/, "</table>\n\n"),
    )
    .replace(/[ \t]*\{align="\w+"\}$/gm, "")
    .replace(/<quote-container>/g, "\n\n<blockquote>\n\n")
    .replace(/<\/quote-container>/g, "\n\n</blockquote>\n\n")
    .replace(/<callout\b[^>]*>/g, (tag) => `\n\n<blockquote class="doc-callout"${calloutColor(attr(tag, "background-color"))}>\n\n`)
    .replace(/<\/callout>/g, "\n\n</blockquote>\n\n")
    .replace(/<mention-user\b[^>]*\/>/g, "@同事");
}

/** How wide a piece of text sets, in em: CJK and full-width characters one each, the rest about half. */
function textEm(s: string) {
  let n = 0;
  for (const ch of s) n += /[⺀-鿿가-힯豈-﫿＀-￯]/.test(ch) ? 1 : 0.55;
  return n;
}

/** The width a cell asks for: short text on one line; long text a few lines' worth, growing slowly. */
function cellEm(cell: HTMLTableCellElement) {
  const lines = (cell.innerText || cell.textContent || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const longest = Math.max(0, ...lines.map(textEm));
  const all = lines.reduce((n, l) => n + textEm(l), 0);
  let w = longest <= 14 ? longest : Math.min(30, 14 + Math.sqrt(longest - 14) * 1.6);
  // A lot of text overall: wide enough to read as paragraphs.
  if (all > 80) w = Math.max(w, Math.min(30, 12 + Math.sqrt(all) * 1.2));
  if (cell.querySelector("img, video, pre, .mermaid-box")) w = Math.max(w, 16);
  return Math.max(3.5, w) + 1.6;
}

/**
 * Give each table column a width from what it holds. Feishu's Markdown export carries no column
 * widths, and Chinese text may break after any character, so left to the browser a table with a few
 * columns of prose gets columns two or three characters wide. A table wider than the text column
 * scrolls sideways inside its own box; widths that came with the document (`data-widths`, `<col width>`)
 * are used as they are.
 */
export function sizeTables(root: HTMLElement) {
  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    if (table.dataset.sized || table.parentElement?.closest("table")) continue;
    table.dataset.sized = "1";
    const rows = [...table.rows];
    const n = Math.max(0, ...rows.map((r) => [...r.cells].reduce((a, c) => a + c.colSpan, 0)));
    if (!n) continue;
    const given = (table.dataset.widths ?? "").split(",").map(Number).filter((x) => x > 0);
    const cols = [...table.querySelectorAll<HTMLTableColElement>(":scope > colgroup > col")].map((c) => parseFloat(c.getAttribute("width") ?? c.style.width ?? ""));
    let widths: string[];
    let sum: string;
    if (given.length === n || (cols.length === n && cols.every((x) => x > 0))) {
      const px = given.length === n ? given : cols;
      widths = px.map((x) => `${Math.round(x)}px`);
      sum = `${Math.round(px.reduce((a, b) => a + b, 0))}px`;
    } else {
      const em = new Array<number>(n).fill(0);
      const spans: { at: number; span: number; em: number }[] = [];
      // A cell spanning rows takes its column in the rows below.
      const taken = new Array<number>(n).fill(0);
      for (const r of rows) {
        let i = 0;
        for (const c of r.cells) {
          while (i < n && taken[i] > 0) i++;
          if (i >= n) break;
          if (c.colSpan === 1) em[i] = Math.max(em[i], cellEm(c));
          else spans.push({ at: i, span: c.colSpan, em: cellEm(c) });
          for (let k = 0; k < c.colSpan && i + k < n; k++) taken[i + k] = Math.max(taken[i + k], c.rowSpan);
          i += c.colSpan;
        }
        for (let k = 0; k < n; k++) if (taken[k] > 0) taken[k]--;
      }
      for (let i = 0; i < n; i++) if (!em[i]) em[i] = 6;
      // A cell across several columns that needs more than they have: they share the difference.
      for (const s of spans) {
        const have = em.slice(s.at, s.at + s.span).reduce((a, b) => a + b, 0);
        if (s.em > have) for (let k = s.at; k < s.at + s.span && k < n; k++) em[k] += (s.em - have) / s.span;
      }
      // Wider than the page: long columns give way down to a readable line (about ten characters)
      // before the table starts to scroll sideways.
      const fontPx = parseFloat(getComputedStyle(table).fontSize) || 14;
      const avail = (table.parentElement?.clientWidth ?? 0) / fontPx;
      const total = em.reduce((a, b) => a + b, 0);
      if (avail > 0 && total > avail) {
        const min = em.map((x) => Math.min(x, 11.6));
        const least = min.reduce((a, b) => a + b, 0);
        const spare = Math.max(0, avail - least);
        for (let i = 0; i < n; i++) em[i] = min[i] + (total > least ? ((em[i] - min[i]) * spare) / (total - least) : 0);
      }
      widths = em.map((x) => `${x.toFixed(1)}em`);
      sum = `${em.reduce((a, b) => a + b, 0).toFixed(1)}em`;
    }
    table.querySelector(":scope > colgroup")?.remove();
    const group = document.createElement("colgroup");
    for (const w of widths) {
      const col = document.createElement("col");
      col.style.width = w;
      group.append(col);
    }
    table.prepend(group);
    table.classList.add("sized");
    table.style.width = `max(100%, ${sum})`;
    if (!table.parentElement?.classList.contains("table-wrap")) {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.append(table);
    }
  }
}

/**
 * A Feishu callout (`blockquote.doc-callout`): its emoji stands at the left, the text beside it.
 * Documents store the emoji as the first characters of the block (src/channels/lark-docs.ts).
 */
export function layoutCallouts(root: HTMLElement) {
  for (const box of root.querySelectorAll<HTMLElement>("blockquote.doc-callout")) {
    if (box.dataset.done) continue;
    box.dataset.done = "1";
    let first: Node | null = box.firstChild;
    while (first && first.nodeType === Node.TEXT_NODE && !first.textContent?.trim()) first = first.nextSibling;
    // On its own before the paragraphs, or at the start of the first paragraph.
    const holder = first?.nodeType === Node.ELEMENT_NODE && (first as HTMLElement).tagName === "P" ? (first as HTMLElement).firstChild : first;
    const m = holder?.nodeType === Node.TEXT_NODE ? /^\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u.exec(holder.textContent ?? "") : null;
    const body = document.createElement("div");
    body.className = "doc-callout-body";
    if (m && holder) {
      holder.textContent = (holder.textContent ?? "").slice(m[0].length);
      const icon = document.createElement("span");
      icon.className = "doc-callout-icon";
      icon.textContent = m[1];
      body.append(...box.childNodes);
      box.append(icon, body);
    } else {
      body.append(...box.childNodes);
      box.append(body);
    }
  }
}
