/**
 * Whether an original reads as a document (Markdown, Feishu docs with their HTML blocks, web pages,
 * notes) rather than as text with line numbers (code, logs). Chats have their own view.
 */
/**
 * Whether the flat list should fetch its next page. Only the paged list loads more: the catalog tree
 * loads folder by folder and a repository gets every path at once, so scrolling them to the bottom
 * must not page through `/api/sources` (that list is not even shown, and the “加载中” row it adds
 * at the bottom moves the scroll position and triggers it again). A page that came back empty ends
 * the list even when the total says there is more (rows hidden from this viewer, or deleted meanwhile).
 */
export function shouldLoadMore(s: { paged: boolean; loading: boolean; loaded: number; total: number; exhausted?: boolean; distance: number; threshold?: number }) {
  if (!s.paged || s.loading || s.exhausted) return false;
  if (s.loaded >= s.total) return false;
  return s.distance < (s.threshold ?? 500);
}

export function readsAsDocument(s: { kind: string; uri: string }) {
  return /\.(md|markdown|mdx)$/i.test(s.uri) || ["note", "web", "doc", "image", "conversation", "work"].includes(s.kind);
}
