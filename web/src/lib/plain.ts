/** Text helpers with no DOM: what a short piece of an agent's Markdown reads as outside a page. */

/** Block marks at a line's start: a short text keeps its words, not its headings, quotes and bullets. */
export function unblock(md: string): string {
  return (md ?? "")
    .trim()
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+(?=\S)/gm, "· ")
    .replace(/\n{2,}/g, "\n");
}

/** The first line of a text as plain words (a list row's title): no marks, no reference ids. */
export function plainLine(md: string, max = 120): string {
  const line = unblock(md).split("\n").find((l) => l.trim()) ?? "";
  const plain = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => label ?? target.split("/").pop() ?? target)
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s*[（(]?\b(?:src|mem|msg):[\w.-]+(?:#L\d+(?:-L?\d+)?)?[）)]?/g, "")
    .replace(/^·\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
