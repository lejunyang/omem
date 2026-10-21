import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The server runs as ES modules under plain Node, where `require` does not exist; vitest provides it,
 * so a stray `require(...)` passes the tests and fails in production (it once broke the coding
 * handoff). Modules that need it make their own with createRequire.
 */
describe("ES modules", () => {
  it("never call require() without createRequire", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(dir, e.name));
      }
    };
    walk("src");
    const bad = files.filter((f) => {
      const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
      return /(?<![\w.])require\(/.test(code) && !/createRequire/.test(code);
    });
    expect(bad).toEqual([]);
  });
});
