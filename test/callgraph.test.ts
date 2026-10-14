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
  it("resolves TS calls through imports, aliases, re-exports, defaults, namespaces and this", async () => {
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
    await syncDirectorySpace(app, "r");
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
    await syncDirectorySpace(app, "py");
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

  it("resolves Go calls across a package and through imported packages", async () => {
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
    await syncDirectorySpace(app, "go");
    const e = edges(app, "go");
    expect(e).toContain("server/server.go#Server.Run -> internal/store/db.go#Open");
    expect(e).toContain("server/server.go#Server.Run -> server/helper.go#Server.helper");
    expect(e).toContain("server/server.go#Server.Run -> server/helper.go#newThing");
    const sym = all<{ qname: string; kind: string }>(app.db, "select qname, kind from symbols where space_id = 'go' order by qname");
    expect(sym).toContainEqual({ qname: "DB.Close", kind: "method" });
    expect(sym).toContainEqual({ qname: "Server", kind: "struct" });
  });

  it("resolves Rust calls through use paths, modules and impl blocks", async () => {
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
    await syncDirectorySpace(app, "rs");
    const e = edges(app, "rs");
    expect(e).toContain("src/server.rs#Server.run -> src/store/mod.rs#open");
    expect(e).toContain("src/server.rs#Server.run -> src/store/mod.rs#Db.connect");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#inner.deep");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#Server.helper");
    expect(e).toContain("src/server.rs#Server.run -> src/server.rs#Server.make");
    expect(e).toContain("src/store/mod.rs#open -> src/store/mod.rs#Db.connect");
    expect(e.filter((x) => x.endsWith("#open"))).toHaveLength(2); // `op()` and `store::open()`
  });

  it("resolves Java and Kotlin calls across packages, implicit this and static imports", async () => {
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
    await syncDirectorySpace(app, "jvm");
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

  it("resolves Swift calls across the module, extensions and initializers", async () => {
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
    await syncDirectorySpace(app, "sw");
    const e = edges(app, "sw");
    const S = "Sources/App";
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Server.swift#Server.helper`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Server+Log.swift#Server.log`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Store.swift#Store.make`);
    expect(e).toContain(`${S}/Server.swift#Server.run -> ${S}/Store.swift#Worker`);
    const doc = all<{ line_start: number }>(app.db, "select line_start from symbols where space_id = 'sw' and qname = 'Server'");
    expect(doc[0].line_start).toBe(4);
  });

  it("parses and resolves C/C++/ObjC, C#, PHP, Ruby, Scala, Dart, Lua, Zig, Elixir, OCaml, ReScript, Solidity, Bash and Elisp", async () => {
    const app = testApp();
    const root = repo({
      // C: header + implementation, static helper, struct typedef
      "c/store.h": "#ifndef STORE_H\n#define STORE_H\nint db_open(int x);\n#endif\n",
      "c/store.c": '#include "store.h"\nstatic int check(int x) { return x; }\nint db_open(int x) { return check(x); }\n',
      "c/main.c": '#include "store.h"\nint main(void) { return db_open(1); }\n',
      // C++: class declared in a header, method defined out of line in a namespace
      "cpp/server.hpp": "namespace app {\nclass Server {\n public:\n  void run();\n  void helper() {}\n};\n}\n",
      "cpp/server.cpp": '#include "server.hpp"\nnamespace app {\nvoid Server::run() { helper(); this->helper(); util::fmt(); }\n}\nnamespace util { void fmt() {} }\n',
      "objc/Server.m": '#import "Store.h"\n@implementation Server\n- (void)run { [self helper]; }\n- (void)helper {}\n@end\n',
      // C#
      "cs/Db.cs": "namespace App.Store { public static class Db { public static void Open() {} } }\n",
      "cs/Server.cs": "using App.Store;\nnamespace App.Server {\n  public class Server {\n    public void Run() { Helper(); Db.Open(); new Worker(); }\n    private void Helper() {}\n  }\n  class Worker {}\n}\n",
      // PHP
      "php/Store/Db.php": "<?php\nnamespace App\\Store;\nclass Db { public static function open() {} }\n",
      "php/Server.php": "<?php\nnamespace App;\nuse App\\Store\\Db;\nclass Server {\n  public function run() { $this->helper(); Db::open(); self::make(); }\n  private function helper() {}\n  public static function make() {}\n}\n",
      // Ruby
      "rb/store/db.rb": "module Store\n  class Db\n    def self.open; end\n  end\nend\n",
      "rb/server.rb": 'require_relative "store/db"\nclass Server\n  def run\n    self.helper\n    Store::Db.open\n    top(1)\n  end\n  def helper; end\nend\ndef top(x) = x\n',
      // Scala
      "scala/Db.scala": "package app.store\nobject Db { def open(): Unit = () }\n",
      "scala/Server.scala": "package app.server\nimport app.store.Db\nclass Server {\n  def run(): Unit = { helper(); Db.open() }\n  private def helper(): Unit = ()\n}\n",
      // Dart
      "dart/lib/util.dart": "String fmt(String s) => s;\n",
      "dart/lib/server.dart": "import 'util.dart' as u;\nclass Server {\n  void run() { helper(); u.fmt('x'); }\n  void helper() {}\n}\n",
      // Lua
      "lua/store/db.lua": "local M = {}\nfunction M.open() return 1 end\nreturn M\n",
      "lua/main.lua": 'local db = require("store.db")\nlocal function helper() end\nfunction run() helper(); db.open() end\n',
      // Zig
      "zig/store.zig": "pub fn open() void {}\n",
      "zig/main.zig": 'const store = @import("store.zig");\nconst Server = struct {\n    fn run(self: *Server) void { self.helper(); store.open(); }\n    fn helper(self: *Server) void { _ = self; }\n};\n',
      // Elixir
      "ex/lib/app/store/db.ex": "defmodule App.Store.Db do\n  def open, do: :ok\nend\n",
      "ex/lib/app/server.ex": "defmodule App.Server do\n  alias App.Store.Db\n  def run(x) do\n    helper(x)\n    Db.open()\n  end\n  defp helper(x), do: x\nend\n",
      // OCaml / ReScript: module = file
      "ml/store.ml": "let open_ () = ()\n",
      "ml/main.ml": "let helper x = x\nlet run () = helper 1; Store.open_ ()\n",
      "res/Util.res": "let fmt = s => s\n",
      "res/Main.res": "let helper = x => x\nlet run = () => { helper(1); Util.fmt(\"x\") }\n",
      // Solidity
      "sol/Lib.sol": "library Lib { function twice(uint x) internal pure returns (uint) { return x * 2; } }\n",
      "sol/Server.sol": 'import "./Lib.sol";\ncontract Server {\n  function run() public { helper(); Lib.twice(1); }\n  function helper() internal {}\n}\n',
      // Bash / Elisp
      "sh/lib.sh": "lib_open() { :; }\n",
      "sh/main.sh": "source ./lib.sh\nrun() {\n  lib_open\n}\nrun\n",
      "el/store.el": "(defun store-open () t)\n(provide 'store)\n",
      "el/app.el": "(require 'store)\n(defun app-helper (x) x)\n(defun app-run () (app-helper 1) (store-open))\n",
    });
    createSpace(app, { id: "poly", name: "poly", kind: "repo", rootPath: root });
    await syncDirectorySpace(app, "poly");
    const e = edges(app, "poly");
    const want = [
      "c/main.c#main -> c/store.c#db_open",
      "c/store.c#db_open -> c/store.c#check",
      "cpp/server.cpp#app.Server.run -> cpp/server.hpp#app.Server.helper",
      "cpp/server.cpp#app.Server.run -> cpp/server.cpp#util.fmt",
      "objc/Server.m#Server.run -> objc/Server.m#Server.helper",
      "cs/Server.cs#App.Server.Server.Run -> cs/Server.cs#App.Server.Server.Helper",
      "cs/Server.cs#App.Server.Server.Run -> cs/Db.cs#App.Store.Db.Open",
      "cs/Server.cs#App.Server.Server.Run -> cs/Server.cs#App.Server.Worker",
      "php/Server.php#Server.run -> php/Server.php#Server.helper",
      "php/Server.php#Server.run -> php/Store/Db.php#Db.open",
      "php/Server.php#Server.run -> php/Server.php#Server.make",
      "rb/server.rb#Server.run -> rb/server.rb#Server.helper",
      "rb/server.rb#Server.run -> rb/store/db.rb#Store.Db.open",
      "rb/server.rb#Server.run -> rb/server.rb#top",
      "scala/Server.scala#Server.run -> scala/Server.scala#Server.helper",
      "scala/Server.scala#Server.run -> scala/Db.scala#Db.open",
      "dart/lib/server.dart#Server.run -> dart/lib/server.dart#Server.helper",
      "dart/lib/server.dart#Server.run -> dart/lib/util.dart#fmt",
      "lua/main.lua#run -> lua/main.lua#helper",
      "lua/main.lua#run -> lua/store/db.lua#M.open",
      "zig/main.zig#Server.run -> zig/main.zig#Server.helper",
      "zig/main.zig#Server.run -> zig/store.zig#open",
      "ex/lib/app/server.ex#App.Server.run -> ex/lib/app/server.ex#App.Server.helper",
      "ex/lib/app/server.ex#App.Server.run -> ex/lib/app/store/db.ex#App.Store.Db.open",
      "ml/main.ml#run -> ml/main.ml#helper",
      "ml/main.ml#run -> ml/store.ml#open_",
      "res/Main.res#run -> res/Main.res#helper",
      "res/Main.res#run -> res/Util.res#fmt",
      "sol/Server.sol#Server.run -> sol/Server.sol#Server.helper",
      "sol/Server.sol#Server.run -> sol/Lib.sol#Lib.twice",
      "sh/main.sh#run -> sh/lib.sh#lib_open",
      "el/app.el#app-run -> el/app.el#app-helper",
      "el/app.el#app-run -> el/store.el#store-open",
    ];
    expect(want.filter((w) => !e.includes(w))).toEqual([]);
    const kinds = all<{ qname: string; kind: string }>(app.db, "select qname, kind from symbols where space_id = 'poly'");
    expect(kinds).toContainEqual({ qname: "app.Server", kind: "class" });
    expect(kinds).toContainEqual({ qname: "App.Store.Db", kind: "module" });
    expect(kinds).toContainEqual({ qname: "Server.run", kind: "method" });
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
