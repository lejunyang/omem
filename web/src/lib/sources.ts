/**
 * Whether an original reads as a document (Markdown, Feishu docs with their HTML blocks, web pages,
 * notes) rather than as text with line numbers (code, logs). Chats have their own view.
 */
export function readsAsDocument(s: { kind: string; uri: string }) {
  return /\.(md|markdown|mdx)$/i.test(s.uri) || ["note", "web", "doc", "image", "conversation", "work"].includes(s.kind);
}
