/** Reading context and a scoring window have different boundaries. Keep a
 * complete admitted unit when it fits; a long unit is an explicit partial read.
 * Never infer important conditions from keywords or reconstruct source text. */
export function readingExcerpt(
  text: string,
  anchor = 0,
  maxCharacters = 6_000,
) {
  if (text.length <= maxCharacters)
    return { text, start: 0, end: text.length, complete: true };
  anchor = Math.max(0, Math.min(anchor, text.length - 1));
  let start = Math.min(
    Math.max(0, anchor - Math.floor(maxCharacters / 3)),
    text.length - maxCharacters,
  );
  let end = start + maxCharacters;
  // Preserve continuous whole lines around the match whenever they fit. A
  // single oversized line still has to be bounded and is marked partial.
  const firstLine = text.indexOf("\n", Math.max(0, start - 1)) + 1;
  if (start && firstLine > start && firstLine <= anchor) start = firstLine;
  const lastLine = text.lastIndexOf("\n", end);
  if (lastLine > anchor && lastLine > start) end = lastLine;
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff)
    start++;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff)
    end--;
  return { text: text.slice(start, end), start, end, complete: false };
}
