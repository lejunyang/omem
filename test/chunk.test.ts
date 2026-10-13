import { describe, expect, it } from "vitest";
import { chunkMarkdown, chunkSource } from "../src/sources/chunk.ts";
import { parseCode } from "../src/sources/code.ts";

describe("chunkMarkdown", () => {
  it("keeps heading paths and exact line ranges", () => {
    const md = "# Title\nintro\n\n## A\na1\n\n### A.1\ndeep\n## B\nb1\n```\n# not a heading\n```\n";
    const chunks = chunkMarkdown(md, "doc");
    const paths = chunks.map((c) => c.path);
    expect(paths).toEqual(["Title", "Title / A", "Title / A / A.1", "Title / B"]);
    const b = chunks.find((c) => c.path === "Title / B")!;
    expect(md.split("\n").slice(b.lineStart - 1, b.lineEnd).join("\n")).toBe(b.text);
    expect(b.text).toContain("# not a heading");
  });
  it("splits long sections into windows that cover every line", () => {
    const body = Array.from({ length: 300 }, (_, i) => (i % 10 === 9 ? "" : `line ${i} ${"x".repeat(40)}`)).join("\n");
    const chunks = chunkMarkdown(`# Big\n${body}`, "big");
    expect(chunks.length).toBeGreaterThan(3);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].lineStart).toBe(chunks[i - 1].lineEnd + 1);
  });
});

describe("parseCode", () => {
  it("finds TypeScript declarations, members, calls and imports", () => {
    const src = `import { x } from "./x";\n/** doc */\nexport function foo(a: number) {\n  return bar(a) + x.baz();\n}\nclass K {\n  run() { foo(1); }\n}\nexport const handler = async () => { await foo(2) };\n`;
    const o = parseCode("a.ts", src);
    expect(o.symbols.map((s) => s.qname)).toEqual(["foo", "K", "K.run", "handler"]);
    const foo = o.symbols[0];
    expect([foo.docStart, foo.lineStart, foo.lineEnd, foo.exported]).toEqual([2, 3, 5, true]);
    expect(o.refs).toContainEqual({ fromQname: "", toName: "./x", kind: "import", line: 1, bindings: [{ local: "x", imported: "x" }] });
    expect(o.refs.filter((r) => r.fromQname === "foo").map((r) => r.toName)).toEqual(["bar", "baz"]);
    expect(o.refs.some((r) => r.fromQname === "K.run" && r.toName === "foo")).toBe(true);
  });
  it("outlines Python with the generic parser", () => {
    const o = parseCode("m.py", "import os\n\nclass A:\n    def f(self):\n        pass\n\n    def g(self):\n        return 1\n\ndef top():\n    pass\n");
    expect(o.symbols.map((s) => `${s.qname}:${s.lineStart}-${s.lineEnd}`)).toEqual(["A:3-8", "A.f:4-5", "A.g:7-8", "top:10-11"]);
  });
  it("chunks code by symbol and keeps leftovers as file windows", () => {
    const { chunks } = chunkSource("code", "a.ts", "a.ts", `import a from "a";\n\nexport function one() {\n  return 1;\n}\n`);
    expect(chunks.map((c) => [c.kind, c.lineStart, c.lineEnd])).toEqual([
      ["file", 1, 2],
      ["symbol", 3, 5],
    ]);
  });
});
