import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { callTool } from "../src/agents/tools.ts";
import { all } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { syncDirectorySpace } from "../src/sources/import.ts";
import { testApp } from "./helpers.ts";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "omem-cg-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const edges = (app: ReturnType<typeof testApp>, space: string) =>
  all<{ from: string; from_qname: string; to: string; to_qname: string }>(
    app.db,
    `select s.uri as "from", r.from_qname, t.uri as "to", r.to_qname from code_refs r join sources s on s.id = r.source_id join sources t on t.id = r.to_source_id
     where r.space_id = ? and r.kind = 'call' and r.to_qname is not null`,
    space,
  ).map((e) => `${e.from}#${e.from_qname} -> ${e.to}#${e.to_qname}`);

describe("call graph", () => {
  it("resolves TS calls through imports, aliases, re-exports, defaults, namespaces and this", () => {
    const app = testApp();
    const root = repo({
      "src/util/format.ts": "export function format(x: string) { return x.trim(); }\nexport function other() {}\n",
      "src/util/index.ts": 'export * from "./format.ts";\nexport { other as renamed } from "./format.ts";\n',
      "src/store.ts": "export default class Store {\n  save() { this.write(); }\n  write() {}\n}\n",
      "src/other/format.ts": "export function format() { return 1; }\n",
      "src/main.ts": [
        'import { format as fmt, renamed } from "./util/index.js";',
        'import Store from "./store";',
        'import * as other from "./other/format.ts";',
        'import { readFileSync } from "node:fs";',
        "export function main() {",
        "  fmt(' a ');",
        "  renamed();",
        "  new Store().save();",
        "  other.format();",
        "  readFileSync('x');",
        "  helper();",
        "}",
        "function helper() {}",
      ].join("\n"),
    });
    createSpace(app, { id: "r", name: "r", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "r");
    const e = edges(app, "r");
    expect(e).toContain("src/main.ts#main -> src/util/format.ts#format");
    expect(e).toContain("src/main.ts#main -> src/util/format.ts#other");
    expect(e).toContain("src/main.ts#main -> src/store.ts#Store");
    expect(e).toContain("src/main.ts#main -> src/other/format.ts#format");
    expect(e).toContain("src/main.ts#main -> src/main.ts#helper");
    expect(e).toContain("src/store.ts#Store.save -> src/store.ts#Store.write");
    // the same-named function in another file is not confused with the imported one
    expect(e.filter((x) => x.endsWith("#format"))).toHaveLength(2);
  });

  it("resolves Python absolute, relative and package imports", async () => {
    const app = testApp();
    const root = repo({
      "pkg/__init__.py": "from .core import run as start\n",
      "pkg/core.py": "def run():\n    return helper()\n\ndef helper():\n    return 1\n\nclass Engine:\n    def go(self):\n        return self.step()\n\n    def step(self):\n        return 2\n",
      "pkg/util/text.py": "def clean(s):\n    return s.strip()\n",
      "app.py": "from pkg import start\nfrom pkg.core import Engine\nimport pkg.util.text as text\n\ndef main():\n    start()\n    Engine().go()\n    text.clean(' x ')\n",
    });
    createSpace(app, { id: "py", name: "py", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "py");
    const e = edges(app, "py");
    expect(e).toContain("app.py#main -> pkg/core.py#run");
    expect(e).toContain("app.py#main -> pkg/core.py#Engine");
    expect(e).toContain("app.py#main -> pkg/util/text.py#clean");
    expect(e).toContain("pkg/core.py#run -> pkg/core.py#helper");
    expect(e).toContain("pkg/core.py#Engine.go -> pkg/core.py#Engine.step");

    const ctx = { app, runId: null, spaceId: "py", spaces: null, tools: null, actor: "agent" as const };
    const text = (await callTool(ctx, "find_symbol", { name: "run", space: "py" })).text;
    expect(text).toMatch(/被调用（已解析 1）/);
    expect(text).toMatch(/app\.py:\d+ 在 main 中/);
    expect(text).toMatch(/pkg\/core\.py#?|helper @ pkg\/core\.py/);
  });
});

describe("scan", () => {
  it("lists every matching line across sources, with dates and memories", async () => {
    const app = testApp();
    const { importText } = await import("../src/sources/import.ts");
    const { upsertSource } = await import("../src/sources/store.ts");
    for (let i = 1; i <= 30; i++)
      upsertSource(app, { spaceId: "personal", kind: "chat", uri: `s${i}.md`, title: `s${i}`, text: `hello\nI went to the gym today (${i})\nbye`, meta: { date: `2026-01-${String(i).padStart(2, "0")}` } });
    importText(app, "personal", { title: "x", text: "Yoga class on Monday" });
    const ctx = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const };
    const all30 = (await callTool(ctx, "scan", { terms: ["GYM", "yoga"] })).text;
    expect(all30).toMatch(/31 个原件共 31 行命中/);
    const ranged = (await callTool(ctx, "scan", { terms: ["gym"], since: "2026-01-10", until: "2026-01-19" })).text;
    expect(ranged).toMatch(/10 个原件共 10 行命中/);
  });
});
