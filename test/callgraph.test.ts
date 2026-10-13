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

  it("resolves Go calls across a package and through imported packages", () => {
    const app = testApp();
    const root = repo({
      "go.mod": "module example.com/app\n",
      "internal/store/db.go": "package store\n\ntype DB struct{}\n\nfunc Open() *DB { return &DB{} }\n\nfunc (d *DB) Close() error { return nil }\n",
      "server/server.go": [
        "package server",
        "",
        "import (",
        '\t"fmt"',
        '\tst "example.com/app/internal/store"',
        ")",
        "",
        "// Server serves.",
        "type Server struct{ db *st.DB }",
        "",
        "func (s *Server) Run() error {",
        "\tfmt.Println(\"run\")",
        "\ts.db = st.Open()",
        "\ts.helper()",
        "\treturn newThing()",
        "}",
      ].join("\n"),
      "server/helper.go": "package server\n\nfunc (s *Server) helper() {}\n\nfunc newThing() error { return nil }\n",
    });
    createSpace(app, { id: "go", name: "go", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "go");
    const e = edges(app, "go");
    expect(e).toContain("server/server.go#Server.Run -> internal/store/db.go#Open");
    expect(e).toContain("server/server.go#Server.Run -> server/helper.go#Server.helper");
    expect(e).toContain("server/server.go#Server.Run -> server/helper.go#newThing");
    const sym = all<{ qname: string; kind: string }>(app.db, "select qname, kind from symbols where space_id = 'go' order by qname");
    expect(sym).toContainEqual({ qname: "DB.Close", kind: "method" });
    expect(sym).toContainEqual({ qname: "Server", kind: "struct" });
  });

  it("resolves Rust calls through use paths, modules and impl blocks", () => {
    const app = testApp();
    const root = repo({
      "src/lib.rs": "pub mod store;\npub mod server;\n",
      "src/store/mod.rs": "pub struct Db;\nimpl Db {\n    pub fn connect() -> Db { Db }\n}\npub fn open() -> Db { Db::connect() }\n",
      "src/server.rs": [
        "use crate::store::{self, open as op, Db};",
        "mod inner { pub fn deep() {} }",
        "pub struct Server;",
        "impl Server {",
        "    pub fn run(&self) {",
        "        op();",
        "        store::open();",
        "        Db::connect();",
        "        inner::deep();",
        "        self.helper();",
        "        Self::make();",
        "    }",
        "    fn helper(&self) {}",
        "    fn make() {}",
        "}",
      ].join("\n"),
    });
    createSpace(app, { id: "rs", name: "rs", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "rs");
    const e = edges(app, "rs");
    expect(e).toContain("src/server.rs#Server.run -> src/store/mod.rs#open");
    expect(e).toContain("src/server.rs#Server.run -> src/store/mod.rs#Db.connect");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#inner.deep");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#Server.helper");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#Server.make");
    expect(e).toContain("src/store/mod.rs#open -> src/store/mod.rs#Db.connect");
    expect(e.filter((x) => x.endsWith("#open"))).toHaveLength(2); // `op()` and `store::open()`
  });

  it("resolves Java and Kotlin calls across packages, implicit this and static imports", () => {
    const app = testApp();
    const root = repo({
      "src/main/java/com/ex/store/Db.java": "package com.ex.store;\n\npublic class Db {\n  public static Db open() { return new Db(); }\n  public void close() {}\n}\n",
      "src/main/java/com/ex/util/Strings.java": "package com.ex.util;\n\npublic final class Strings {\n  public static String upper(String s) { return s; }\n}\n",
      "src/main/java/com/ex/app/Server.java": [
        "package com.ex.app;",
        "",
        "import com.ex.store.Db;",
        "import static com.ex.util.Strings.upper;",
        "",
        "public class Server {",
        "  public void run() {",
        "    Db db = Db.open();",
        "    helper();",
        "    upper(\"a\");",
        "    new Worker().start();",
        "    Util.shared();",
        "  }",
        "  private void helper() {}",
        "}",
      ].join("\n"),
      "src/main/java/com/ex/app/Worker.java": "package com.ex.app;\n\nclass Worker { void start() {} }\n",
      "src/main/java/com/ex/app/Util.kt": "package com.ex.app\n\nobject Util {\n    fun shared() = 1\n}\n",
      "src/main/kotlin/com/ex/app/Main.kt": [
        "package com.ex.app",
        "",
        "import com.ex.store.Db",
        "import com.ex.util.Strings.upper as up",
        "",
        "class Main {",
        "    fun go() {",
        "        Db.open()",
        "        up(\"x\")",
        "        helper()",
        "    }",
        "    private fun helper() {}",
        "    companion object { fun create() = Main() }",
        "}",
        "fun top() { Main.create().go() }",
      ].join("\n"),
    });
    createSpace(app, { id: "jvm", name: "jvm", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "jvm");
    const e = edges(app, "jvm");
    const J = "src/main/java/com/ex";
    expect(e).toContain(`${J}/app/Server.java#Server.run -> ${J}/store/Db.java#Db.open`);
    expect(e).toContain(`${J}/app/Server.java#Server.run -> ${J}/app/Server.java#Server.helper`);
    expect(e).toContain(`${J}/app/Server.java#Server.run -> ${J}/util/Strings.java#Strings.upper`);
    expect(e).toContain(`${J}/app/Server.java#Server.run -> ${J}/app/Worker.java#Worker`);
    expect(e).toContain(`${J}/app/Server.java#Server.run -> ${J}/app/Util.kt#Util.shared`);
    const K = "src/main/kotlin/com/ex/app/Main.kt";
    expect(e).toContain(`${K}#Main.go -> ${J}/store/Db.java#Db.open`);
    expect(e).toContain(`${K}#Main.go -> ${J}/util/Strings.java#Strings.upper`);
    expect(e).toContain(`${K}#Main.go -> ${K}#Main.helper`);
    expect(e).toContain(`${K}#top -> ${K}#Main.create`);
  });

  it("resolves Swift calls across the module, extensions and initializers", () => {
    const app = testApp();
    const root = repo({
      "Sources/App/Server.swift": [
        "import Foundation",
        "",
        "/// Serves requests.",
        "public final class Server {",
        "    init() {}",
        "    public func run() {",
        "        helper()",
        "        self.log()",
        "        Store.shared.save()",
        "        let w = Worker()",
        "        Store.make()",
        "    }",
        "    private func helper() {}",
        "}",
      ].join("\n"),
      "Sources/App/Server+Log.swift": "extension Server {\n    func log() {}\n}\n",
      "Sources/App/Store.swift": "struct Store {\n    static let shared = Store()\n    static func make() -> Store { Store() }\n    func save() {}\n}\nstruct Worker {}\n",
    });
    createSpace(app, { id: "sw", name: "sw", kind: "repo", rootPath: root });
    syncDirectorySpace(app, "sw");
    const e = edges(app, "sw");
    const S = "Sources/App";
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Server.swift#Server.helper`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Server+Log.swift#Server.log`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Store.swift#Store.make`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Store.swift#Worker`);
    const doc = all<{ line_start: number }>(app.db, "select line_start from symbols where space_id = 'sw' and qname = 'Server'");
    expect(doc[0].line_start).toBe(4);
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
