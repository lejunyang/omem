import { expect, it } from "vitest";
import { highlightCode, highlightedLines } from "./highlight";

it("highlights TypeScript and preserves multiline comments in numbered rows", async () => {
  const lines = highlightedLines(await highlightCode("/* start\ncontinued */\nexport const value = 1;", "ts"));
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain('<span class="hljs-comment">continued */</span>');
  expect(lines[2]).toContain('class="hljs-keyword"');
});

it("escapes markup for known and unknown languages", async () => {
  for (const language of ["ts", "unknown"]) {
    const html = await highlightCode('<img src=x onerror="alert(1)">', language);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
  }
});
