/**
 * A review finding's detail or suggestion, made ready for Markdown. Reviewers write sections as a
 * bold label on its own line (`**触发条件**`), often right under the previous section's list with no
 * blank line; Markdown then takes the label as a lazy continuation of the last list item, so that
 * heading shows indented inside the list while the others sit flush left. Here a line that is only a
 * bold label (optionally followed by ：/:) gets a blank line before and after it, and a line that
 * starts with one followed by text (`**问题**：……`) a blank line before it, so each starts a new block.
 * Fenced code is left alone.
 */
export function findingMarkdown(text: string): string {
  if (!text?.includes("**")) return text ?? "";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence = "";
  const gap = () => out.length > 0 && out[out.length - 1].trim() !== "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = "";
      out.push(line);
      continue;
    }
    const m = fence ? null : /^\*\*([^*\n]+)\*\*[ \t]*([：:])?[ \t]*(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const rest = m[3].trim();
    if (!rest) {
      if (gap()) out.push("");
      out.push(line);
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") out.push("");
    } else if (m[2] || /[：:]$/.test(m[1].trim())) {
      if (gap()) out.push("");
      out.push(line);
    } else out.push(line);
  }
  return out.join("\n");
}
