import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { CodeOutline, CodeRef, CodeSymbol, ImportBinding } from "./code.ts";

/**
 * Tree-sitter outlines (WebAssembly grammars from tree-sitter-wasms, no native
 * build). This file holds the runtime (lazy grammar loading), shared helpers
 * and the hand-written extractors for Go, Rust, Java, Kotlin and Swift;
 * treesitter-more.ts covers the other languages from per-language specs.
 *
 * Grammars load on demand: import paths call `ensureGrammars(paths)` before
 * parsing (each grammar is 0.2–4 MB; loading all would cost ~120 MB). Parsing
 * itself is synchronous. Without a loaded grammar, callers fall back to the
 * generic outline.
 */
export type { Node };
type Lang = "go" | "rust" | "java" | "kotlin" | "swift";

/** File extension → tree-sitter-wasms grammar name. */
export const GRAMMAR_OF_EXT: Record<string, string> = {
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".c": "cpp", // the C++ grammar parses C too, and headers are shared
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".m": "objc",
  ".mm": "objc",
  ".cs": "c_sharp",
  ".php": "php",
  ".rb": "ruby",
  ".scala": "scala",
  ".sc": "scala",
  ".dart": "dart",
  ".lua": "lua",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".ml": "ocaml",
  ".mli": "ocaml",
  ".res": "rescript",
  ".resi": "rescript",
  ".sol": "solidity",
  ".sh": "bash",
  ".bash": "bash",
  ".el": "elisp",
};
const MAIN_LANG: Record<string, Lang> = { go: "go", rust: "rust", java: "java", kotlin: "kotlin", swift: "swift" };

let initialized: Promise<void> | null = null;
const parsers = new Map<string, Parser>();
const loading = new Map<string, Promise<void>>();
const failed = new Set<string>();

const require = createRequire(import.meta.url);
function grammarDir() {
  return join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
}

/** Grammars shipped in vendor/ instead of tree-sitter-wasms (see vendor/<name>/README.md). */
const VENDORED = new Set(["lua"]);
function grammarFile(grammar: string) {
  if (VENDORED.has(grammar))
    for (const root of [join(dirname(require.resolve("tree-sitter-wasms/package.json")), "..", ".."), join(import.meta.dirname, "..", ".."), join(import.meta.dirname, "..", "..", "..")]) {
      const f = join(root, "vendor", `tree-sitter-${grammar}`, `tree-sitter-${grammar}.wasm`);
      if (existsSync(f)) return f;
    }
  return join(grammarDir(), `tree-sitter-${grammar}.wasm`);
}

async function loadGrammar(grammar: string) {
  if (parsers.has(grammar) || failed.has(grammar)) return;
  if (!loading.has(grammar))
    loading.set(
      grammar,
      (async () => {
        try {
          initialized ??= Parser.init();
          await initialized;
          const p = new Parser();
          p.setLanguage(await Language.load(grammarFile(grammar)));
          parsers.set(grammar, p);
        } catch (e) {
          failed.add(grammar);
          process.emitWarning(`tree-sitter 语法 ${grammar} 加载失败，改用通用解析：${(e as Error).message}`);
        }
      })(),
    );
  await loading.get(grammar);
}

/** Load the grammars these files need (by extension). Cheap when already loaded. */
export async function ensureGrammars(paths: Iterable<string>) {
  const want = new Set<string>();
  for (const p of paths) {
    const g = GRAMMAR_OF_EXT[extname(p).toLowerCase()];
    if (g && !parsers.has(g) && !failed.has(g)) want.add(g);
  }
  await Promise.all([...want].map(loadGrammar));
}

/** Parse with the grammar for this extension, or null when it is not loaded. */
export function parseTree<T>(ext: string, text: string, use: (root: Node, grammar: string) => T): T | null {
  const grammar = GRAMMAR_OF_EXT[ext];
  const parser = grammar && parsers.get(grammar);
  if (!parser) return null;
  const tree = parser.parse(text);
  if (!tree) return null;
  try {
    return use(tree.rootNode, grammar);
  } finally {
    tree.delete();
  }
}

type Call = { name: string; qualifier?: string };
type Ctx = {
  lang: Lang;
  text: string;
  lines: string[];
  symbols: CodeSymbol[];
  refs: CodeRef[];
};

/** Go, Rust, Java, Kotlin, Swift. */
export function parseTreeSitter(ext: string, text: string): Omit<CodeOutline, "language"> | null {
  const lang = MAIN_LANG[GRAMMAR_OF_EXT[ext] ?? ""];
  if (!lang) return null;
  return parseTree(ext, text, (root) => {
    const ctx: Ctx = { lang, text, lines: text.split("\n"), symbols: [], refs: [] };
    walkDecls(ctx, kids(root), undefined);
    return { symbols: ctx.symbols, refs: ctx.refs };
  });
}

// ---- helpers ------------------------------------------------------------------

export const kids = (n: Node | null | undefined): Node[] => (n ? (n.namedChildren.filter(Boolean) as Node[]) : []);
/** Descendants of the given types in document order (web-tree-sitter's descendantsOfType mis-maps type ids once several grammars are loaded). */
export function descendants(n: Node | null | undefined, types: string | string[]): Node[] {
  const want = new Set(Array.isArray(types) ? types : [types]);
  const out: Node[] = [];
  const visit = (x: Node) => {
    for (const c of kids(x)) {
      if (want.has(c.type)) out.push(c);
      visit(c);
    }
  };
  if (n) visit(n);
  return out;
}
export const line = (n: Node) => n.startPosition.row + 1;
export const endLine = (n: Node) => n.endPosition.row + 1 - (n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row ? 1 : 0);
export const field = (n: Node, name: string) => n.childForFieldName(name);
export const childOf = (n: Node, ...types: string[]) => kids(n).find((c) => types.includes(c.type)) ?? null;

/** First line of the comment / attribute block directly above a declaration (comments may sit in a sibling's subtree). */
/** Comment / attribute / annotation lines in any supported language. */
const DOC_LINE = /^\s*(\/\/|\/\*|\*|#\[|@(?!end\b|interface\b|implementation\b|protocol\b)[A-Za-z]|#(?!include|import|!)|--|;|\(\*|\{-|%|\/\/\/)/;
export function docStart(ctx: { lines: string[] }, n: Node): number | undefined {
  const lines = ctx.lines;
  let k = line(n) - 1; // 1-based line above
  let first: number | undefined;
  while (k >= 1 && DOC_LINE.test(lines[k - 1])) {
    first = k;
    k--;
  }
  return first;
}

export function signature(n: Node) {
  const raw = n.text;
  const brace = raw.search(/\{|\s=\s/);
  return (brace > 0 ? raw.slice(0, brace) : raw.split("\n")[0]).replace(/\s+/g, " ").trim().slice(0, 240);
}

function exported(ctx: Ctx, n: Node, name: string): boolean {
  switch (ctx.lang) {
    case "go":
      return /^[A-Z]/.test(name);
    case "rust":
      return kids(n).some((c) => c.type === "visibility_modifier");
    case "java":
      return !/\bprivate\b/.test(childOf(n, "modifiers")?.text ?? "");
    case "kotlin":
    case "swift":
      return !/\b(private|fileprivate|internal)\b/.test(childOf(n, "modifiers")?.text ?? "");
  }
}

function addSymbol(ctx: Ctx, n: Node, rawName: string, kind: string, parent?: string, callsFrom?: Node | null, receiver?: string) {
  const name = rawName.replace(/`/g, ""); // Kotlin / Swift backtick identifiers
  const qname = parent ? `${parent}.${name}` : name;
  ctx.symbols.push({ name, qname, kind, lineStart: line(n), lineEnd: endLine(n), docStart: docStart(ctx, n), signature: signature(n), exported: exported(ctx, n, name), parent });
  if (callsFrom) collectCalls(ctx, callsFrom, qname, receiver);
  return qname;
}

/** Strip generics / pointers / paths from a type node: `*Server`, `Server<T>`, `crate::a::Server` → `Server`. */
export function typeName(n: Node | null): string | null {
  if (!n) return null;
  const t = n.text.replace(/<[\s\S]*>/g, "").replace(/[*&\s]|\bmut\b/g, "");
  const parts = t.split(/::|\./);
  return parts[parts.length - 1] || null;
}

// ---- declarations -------------------------------------------------------------

const FUNCTION_LIKE = new Set([
  "function_declaration",
  "method_declaration",
  "function_item",
  "constructor_declaration",
  "init_declaration",
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "object_declaration",
  "impl_item",
  "trait_item",
  "mod_item",
  "struct_item",
  "enum_item",
]);

function walkDecls(ctx: Ctx, nodes: Node[], parent: string | undefined) {
  for (const n of nodes) decl(ctx, n, parent);
}

function decl(ctx: Ctx, n: Node, parent: string | undefined) {
  const { lang } = ctx;
  switch (n.type) {
    // ---- imports
    case "import_declaration":
      if (lang === "go") {
        for (const spec of descendants(n, "import_spec")) goImport(ctx, spec);
      } else if (lang === "java") javaImport(ctx, n);
      else if (lang === "swift") {
        const id = childOf(n, "identifier");
        if (id) ctx.refs.push({ fromQname: "", toName: id.text, kind: "import", line: line(n), bindings: [{ local: id.text, imported: "*" }] });
      }
      return;
    case "import_list":
      return walkDecls(ctx, kids(n), parent);
    case "import_header":
      return kotlinImport(ctx, n);
    case "use_declaration":
      return rustUse(ctx, n);

    // ---- Go
    case "function_declaration":
      if (lang === "go") return void addSymbol(ctx, n, field(n, "name")!.text, "function", undefined, field(n, "body"));
      break; // Kotlin / Swift handled below
    case "method_declaration":
      if (lang === "go") {
        const recv = kids(field(n, "receiver"))[0];
        const recvType = typeName(recv ? field(recv, "type") : null);
        const recvName = recv ? field(recv, "name")?.text : undefined;
        return void addSymbol(ctx, n, field(n, "name")!.text, "method", recvType ?? undefined, field(n, "body"), recvName);
      }
      return void addSymbol(ctx, n, field(n, "name")!.text, "method", parent, field(n, "body")); // Java
    case "type_declaration":
      for (const spec of kids(n).filter((c) => c.type === "type_spec" || c.type === "type_alias")) {
        const name = field(spec, "name")?.text;
        if (!name) continue;
        const t = field(spec, "type");
        const kind = t?.type === "struct_type" ? "struct" : t?.type === "interface_type" ? "interface" : "type";
        const q = addSymbol(ctx, kids(n).length === 1 ? n : spec, name, kind);
        if (t?.type === "interface_type")
          for (const m of kids(t).filter((c) => c.type === "method_spec" || c.type === "method_elem")) {
            const mn = field(m, "name")?.text;
            if (mn) addSymbol(ctx, m, mn, "method", q);
          }
      }
      return;

    // ---- Rust
    case "function_item":
    case "function_signature_item":
      return void addSymbol(ctx, n, field(n, "name")!.text, parent ? "method" : "function", parent, field(n, "body"));
    case "struct_item":
    case "enum_item":
    case "union_item":
    case "type_item":
      return void addSymbol(ctx, n, field(n, "name")!.text, n.type.replace("_item", ""), parent);
    case "trait_item": {
      const q = addSymbol(ctx, n, field(n, "name")!.text, "trait", parent);
      return walkDecls(ctx, kids(field(n, "body")), q);
    }
    case "impl_item": {
      const t = typeName(field(n, "type"));
      if (!t) return;
      const q = parent ? `${parent}.${t}` : t;
      return walkDecls(ctx, kids(field(n, "body")), q);
    }
    case "mod_item": {
      const body = field(n, "body");
      if (!body) return; // `mod x;` declares a file module
      const q = addSymbol(ctx, n, field(n, "name")!.text, "module", parent);
      return walkDecls(ctx, kids(body), q);
    }
    case "macro_definition":
      return void addSymbol(ctx, n, field(n, "name")!.text, "macro", parent);

    // ---- Java
    case "class_declaration":
      if (lang === "java") return javaType(ctx, n, "class", parent);
      break;
    case "interface_declaration":
    case "enum_declaration":
    case "record_declaration":
    case "annotation_type_declaration":
      return javaType(ctx, n, n.type.replace("_declaration", "").replace("annotation_type", "annotation"), parent);
    case "constructor_declaration":
      return void addSymbol(ctx, n, "constructor", "method", parent, field(n, "body"));
    case "enum_body_declarations":
    case "class_body":
    case "enum_class_body":
    case "protocol_body":
    case "declaration_list":
      return walkDecls(ctx, kids(n), parent);
  }

  // ---- Kotlin
  if (lang === "kotlin") {
    if (n.type === "class_declaration" || n.type === "object_declaration") {
      const name = childOf(n, "type_identifier")?.text;
      if (!name) return;
      const kw = n.children.find((c) => !!c && !c.isNamed && /^(class|interface|object)$/.test(c!.type))?.type ?? "class";
      const kind = childOf(n, "enum_class_body") ? "enum" : kw;
      const q = addSymbol(ctx, n, name, kind, parent);
      return walkDecls(ctx, kids(childOf(n, "class_body", "enum_class_body")), q);
    }
    if (n.type === "companion_object") return walkDecls(ctx, kids(childOf(n, "class_body")), parent);
    if (n.type === "function_declaration") {
      const name = childOf(n, "simple_identifier")?.text;
      if (name) addSymbol(ctx, n, name, parent ? "method" : "function", parent, childOf(n, "function_body"));
      return;
    }
    if (n.type === "secondary_constructor") return void addSymbol(ctx, n, "constructor", "method", parent, n);
    if (n.type === "anonymous_initializer") return collectCalls(ctx, n, parent ?? "");
    return;
  }

  // ---- Swift
  if (lang === "swift") {
    if (n.type === "class_declaration") {
      const name = typeName(field(n, "name"));
      if (!name) return;
      const kw = field(n, "declaration_kind")?.text ?? n.children.find((c) => !!c && !c.isNamed)?.type ?? "class";
      const q = parent ? `${parent}.${name}` : name;
      // An extension adds members to a type that may be declared elsewhere: no new symbol.
      if (kw !== "extension") addSymbol(ctx, n, name, kw, parent);
      return walkDecls(ctx, kids(field(n, "body")), q);
    }
    if (n.type === "protocol_declaration") {
      const q = addSymbol(ctx, n, field(n, "name")!.text, "protocol", parent);
      return walkDecls(ctx, kids(field(n, "body")), q);
    }
    if (n.type === "function_declaration" || n.type === "protocol_function_declaration") {
      const name = field(n, "name")?.text;
      if (name) addSymbol(ctx, n, name, parent ? "method" : "function", parent, field(n, "body"));
      return;
    }
    if (n.type === "init_declaration") return void addSymbol(ctx, n, "init", "method", parent, field(n, "body"));
    if (n.type === "statements" || n.type === "top_level_code") return collectCalls(ctx, n, "");
  }
}

function javaType(ctx: Ctx, n: Node, kind: string, parent?: string) {
  const name = field(n, "name")?.text;
  if (!name) return;
  const q = addSymbol(ctx, n, name, kind, parent);
  walkDecls(ctx, kids(field(n, "body")), q);
}

// ---- imports ------------------------------------------------------------------

function goImport(ctx: Ctx, spec: Node) {
  const path = field(spec, "path")?.text.replace(/^["`]|["`]$/g, "");
  if (!path) return;
  const alias = field(spec, "name")?.text;
  if (alias === "_") return;
  const local = alias && alias !== "." ? alias : path.split("/").pop()!.replace(/^go-|-go$|\.v\d+$/g, "");
  ctx.refs.push({ fromQname: "", toName: path, kind: "import", line: line(spec), bindings: [{ local: alias === "." ? "*" : local, imported: "*" }] });
}

function javaImport(ctx: Ctx, n: Node) {
  const id = childOf(n, "scoped_identifier", "identifier");
  if (!id) return;
  const full = id.text;
  if (childOf(n, "asterisk")) return void ctx.refs.push({ fromQname: "", toName: full, kind: "import", line: line(n), bindings: [{ local: "*", imported: "*" }] });
  const dot = full.lastIndexOf(".");
  const last = full.slice(dot + 1);
  ctx.refs.push({ fromQname: "", toName: full.slice(0, dot), kind: "import", line: line(n), bindings: [{ local: last, imported: last }] });
}

function kotlinImport(ctx: Ctx, n: Node) {
  const id = childOf(n, "identifier");
  if (!id) return;
  const full = kids(id).map((c) => c.text).join(".");
  if (/\.\*/.test(n.text)) return void ctx.refs.push({ fromQname: "", toName: full, kind: "import", line: line(n), bindings: [{ local: "*", imported: "*" }] });
  const alias = kids(childOf(n, "import_alias"))[0]?.text;
  const dot = full.lastIndexOf(".");
  const last = full.slice(dot + 1);
  ctx.refs.push({ fromQname: "", toName: full.slice(0, dot), kind: "import", line: line(n), bindings: [{ local: alias ?? last, imported: last }] });
}

/** `use a::b::{c, d as e, f::*}` → one import per module path with its bindings. */
function rustUse(ctx: Ctx, n: Node) {
  const byModule = new Map<string, ImportBinding[]>();
  const add = (mod: string, b: ImportBinding) => {
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod)!.push(b);
  };
  const split = (path: string) => {
    const i = path.lastIndexOf("::");
    return i < 0 ? ["", path] : [path.slice(0, i), path.slice(i + 2)];
  };
  const join2 = (a: string, b: string) => (a && b ? `${a}::${b}` : a || b);
  const visit = (node: Node | null, prefix: string) => {
    if (!node) return;
    switch (node.type) {
      case "identifier":
      case "scoped_identifier":
      case "self":
      case "crate":
      case "super": {
        const [mod, last] = split(join2(prefix, node.text));
        // `use a::b::{self}` binds the module b itself.
        if (last === "self") add(mod, { local: split(mod)[1], imported: "*" });
        else add(mod, { local: last, imported: last });
        return;
      }
      case "use_as_clause": {
        const [mod, last] = split(join2(prefix, field(node, "path")!.text));
        add(mod, { local: field(node, "alias")!.text, imported: last });
        return;
      }
      case "use_wildcard":
        add(join2(prefix, kids(node)[0]?.text ?? ""), { local: "*", imported: "*" });
        return;
      case "scoped_use_list":
        for (const c of kids(field(node, "list"))) visit(c, join2(prefix, field(node, "path")?.text ?? ""));
        return;
      case "use_list":
        for (const c of kids(node)) visit(c, prefix);
        return;
    }
  };
  visit(field(n, "argument"), "");
  for (const [mod, bindings] of byModule) ctx.refs.push({ fromQname: "", toName: mod, kind: "import", line: line(n), bindings });
}

// ---- calls --------------------------------------------------------------------

function callOf(ctx: Ctx, n: Node): Call | null {
  const simple = (t: Node | null) => (t && ["identifier", "simple_identifier", "type_identifier", "field_identifier"].includes(t.type) ? t.text.replace(/`/g, "") : undefined);
  const receiver = (t: Node | null) => {
    if (!t) return undefined;
    if (["self", "this", "self_expression", "this_expression"].includes(t.type)) return ctx.lang === "java" || ctx.lang === "kotlin" ? "this" : "self";
    return simple(t);
  };
  switch (ctx.lang) {
    case "go": {
      if (n.type !== "call_expression") return null;
      const f = field(n, "function")!;
      if (f.type === "identifier") return { name: f.text };
      if (f.type === "selector_expression") return { name: field(f, "field")!.text, qualifier: receiver(field(f, "operand")) };
      return null;
    }
    case "rust": {
      if (n.type !== "call_expression") return null;
      let f = field(n, "function")!;
      if (f.type === "generic_function") f = field(f, "function")!;
      if (f.type === "identifier") return { name: f.text };
      if (f.type === "field_expression") return { name: field(f, "field")!.text, qualifier: receiver(field(f, "value")) };
      if (f.type === "scoped_identifier") {
        const path = field(f, "path")?.text.replace(/<[\s\S]*>/g, "");
        return { name: field(f, "name")!.text, qualifier: path && path !== "Self" ? path : "self" };
      }
      return null;
    }
    case "java": {
      if (n.type === "method_invocation") return { name: field(n, "name")!.text, qualifier: receiver(field(n, "object")) };
      if (n.type === "object_creation_expression") {
        const t = typeName(field(n, "type"));
        return t ? { name: t } : null;
      }
      return null;
    }
    case "kotlin":
    case "swift": {
      if (n.type !== "call_expression") return null;
      const f = kids(n)[0];
      if (!f) return null;
      if (f.type === "simple_identifier") return { name: f.text.replace(/`/g, "") };
      if (f.type === "navigation_expression") {
        const suffix = kids(f).find((c) => c.type === "navigation_suffix");
        const name = kids(suffix).find((c) => c.type === "simple_identifier")?.text.replace(/`/g, "");
        return name ? { name, qualifier: receiver(kids(f)[0]) } : null;
      }
      return null;
    }
  }
}

const NESTED_STOP = FUNCTION_LIKE;
const CALL_TYPES = new Set(["call_expression", "method_invocation", "object_creation_expression"]);

function collectCalls(ctx: Ctx, root: Node, owner: string, receiverName?: string) {
  const seen = new Set<string>();
  const visit = (n: Node) => {
    const c = CALL_TYPES.has(n.type) ? callOf(ctx, n) : null;
    if (c) {
      let qualifier = c.qualifier;
      if (receiverName && qualifier === receiverName) qualifier = "self";
      const key = `${qualifier ?? ""}.${c.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        ctx.refs.push({ fromQname: owner, toName: c.name, kind: "call", line: line(n), ...(qualifier ? { qualifier } : {}) });
      }
    }
    for (const ch of kids(n)) if (!(NESTED_STOP.has(ch.type) && ch !== root)) visit(ch);
  };
  visit(root);
}
