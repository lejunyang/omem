/** An Agent's tool call as a short label: omem's own tools in words, others as they are. */
export function prettyTool(t: string) {
  return t
    .replace(/^mcp__omem__/, "")
    .replace(/^omem[._]/, "")
    .replace(/^(search|read_source|source_outline|find_symbol|recall|read_page|list_pages|list_items|list_sources)\b/, (m) => ({ search: "检索", read_source: "读原件", source_outline: "看结构", find_symbol: "找符号", recall: "查记忆", read_page: "读页面", list_pages: "列页面", list_items: "查事项", list_sources: "列原件" })[m] ?? m);
}
