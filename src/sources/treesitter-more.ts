import type { CodeOutline, CodeRef, CodeSymbol } from "./code.ts";
import { childOf, descendants, docStart, endLine, field, GRAMMAR_OF_EXT, kids, line, parseTree, signature, typeName, type Node } from "./treesitter.ts";

/**
 * Outlines for the remaining tree-sitter-wasms languages: C / C++ / Objective-C,
 * C#, PHP, Ruby, Scala, Dart, Lua, Zig, Elixir, OCaml, ReScript, Solidity,
 * Bash and Emacs Lisp. Each language is a small spec: which nodes declare
 * something (and where their members and body are), which nodes are calls,
 * and which are imports. The output has the same shape as the other parsers:
 * symbols with qualified names, imports with bindings and calls with an
 * optional qualifier ("self" for this/self receivers).
 */
type Call = { name: string; qualifier?: string };
type Import = { spec: string; local?: string; names?: { local: string; imported: string }[] };
type Decl = {
  kind: string;
  name: string | null;
  /** Full qualified name when the declaration carries its own path (C++ `A::b`, Elixir `App.Server`). */
  qname?: string;
  /** Child declarations (classes, modules, namespaces). */
  members?: Node[];
  /** Where calls are collected from (functions); defaults to none for containers. */
  body?: Node | null;
  /** Extent when it spans siblings (Dart signature + body). */
  start?: Node;
  end?: Node;
  exported?: boolean;
};
type Spec = {
  decl(n: Node, parent: string | undefined): Decl | null;
  /** Node types whose children are walked as if at the same level. */
  transparent?: string[];
  /** Node types that contain declarations and must not be entered when collecting a body's calls. */
  stop?: string[];
  callTypes: string[];
  call(n: Node): Call | null;
  imports?(n: Node): Import[] | null;
  /** Words meaning "this object". */
  self?: string[];
  /** Collect calls in top-level statements (scripts). */
  topLevelCalls?: boolean;
};

// ---- helpers ------------------------------------------------------------------

const last = (s: string) => s.split(/::|\.|\\|\//).filter(Boolean).pop() ?? s;
const unquote = (s: string) => s.replace(/^["'`<]|["'`>]$/g, "");
const simpleTypes = new Set(["identifier", "field_identifier", "type_identifier", "constant", "name", "simple_identifier", "property_identifier", "value_identifier", "value_name", "symbol", "word"]);
function receiver(n: Node | null, self: string[]): string | undefined {
  if (!n) return undefined;
  const t = n.text.replace(/^\$/, "");
  if (self.includes(t) || /^(this|self)(_expression)?$/.test(n.type)) return "self";
  if (simpleTypes.has(n.type) || n.type === "variable_name") return t;
  if (/qualified|scope_resolution|scoped_identifier|namespace_name|module_path|alias/.test(n.type)) return last(n.text);
  return undefined;
}
const privateText = (s: string | undefined) => /\b(private|fileprivate|internal)\b/.test(s ?? "");

// ---- C / C++ / Objective-C ----------------------------------------------------

function cDeclarator(n: Node): { name: string; scope: string[] } | null {
  let d: Node | null = field(n, "declarator");
  while (d && !["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name", "type_identifier"].includes(d.type))
    d = field(d, "declarator") ?? childOf(d, "identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name");
  if (!d) return null;
  if (d.type === "qualified_identifier") {
    const parts = d.text.replace(/<[^<>]*>/g, "").split("::").map((p) => p.trim()).filter(Boolean);
    return { name: parts.pop()!, scope: parts };
  }
  return { name: d.text, scope: [] };
}

const C_CONTAINERS: Record<string, string> = { class_specifier: "class", struct_specifier: "struct", union_specifier: "union" };
const cSpec: Spec = {
  decl(n) {
    switch (n.type) {
      case "function_definition": {
        const d = cDeclarator(n);
        if (!d) return null;
        const isStatic = kids(n).some((c) => c.type === "storage_class_specifier" && c.text === "static");
        return { kind: d.scope.length ? "method" : "function", name: d.name, qname: d.scope.length ? [...d.scope, d.name].join(".") : undefined, body: field(n, "body"), exported: !isStatic };
      }
      case "class_specifier":
      case "struct_specifier":
      case "union_specifier": {
        const body = field(n, "body");
        const name = field(n, "name")?.text;
        if (!body || !name) return null;
        return { kind: C_CONTAINERS[n.type], name: last(name), members: kids(body) };
      }
      case "enum_specifier":
        return field(n, "body") && field(n, "name") ? { kind: "enum", name: field(n, "name")!.text } : null;
      case "namespace_definition":
        return { kind: "namespace", name: field(n, "name")?.text ?? null, members: kids(field(n, "body")) };
      case "type_definition": {
        const name = kids(n).filter((c) => c.type === "type_identifier").pop()?.text ?? null;
        const inner = field(n, "type");
        // `typedef struct {…} Name;` is the struct itself.
        if (inner && C_CONTAINERS[inner.type] && field(inner, "body")) return { kind: C_CONTAINERS[inner.type], name, members: kids(field(inner, "body")) };
        return { kind: "type", name };
      }
      case "preproc_function_def":
        return { kind: "macro", name: field(n, "name")?.text ?? null };
      // Objective-C
      case "class_implementation":
      case "category_implementation":
        return { kind: "class", name: childOf(n, "identifier")?.text ?? null, members: kids(n).flatMap((c) => (c.type === "implementation_definition" ? kids(c) : [])) };
      case "method_definition":
        return { kind: "method", name: kids(n).filter((c) => c.type === "identifier" || c.type === "keyword_declarator").map((c) => (c.type === "identifier" ? c.text : (childOf(c, "identifier")?.text ?? ""))).join(":") || null, body: childOf(n, "compound_statement") };
    }
    return null;
  },
  transparent: ["template_declaration", "linkage_specification", "declaration_list", "preproc_ifdef", "preproc_if", "preproc_else", "preproc_elif", "export_declaration"],
  stop: ["function_definition", "class_specifier", "struct_specifier", "lambda_expression"],
  callTypes: ["call_expression", "message_expression", "new_expression"],
  call(n) {
    if (n.type === "message_expression") return { name: field(n, "method")?.text ?? "", qualifier: receiver(field(n, "receiver"), ["self"]) };
    if (n.type === "new_expression") {
      const t = typeName(field(n, "type"));
      return t ? { name: t } : null;
    }
    let f = field(n, "function");
    if (f?.type === "template_function") f = field(f, "name");
    if (!f) return null;
    if (f.type === "identifier") return { name: f.text };
    if (f.type === "field_expression") return { name: field(f, "field")?.text ?? "", qualifier: receiver(field(f, "argument"), ["this"]) };
    if (f.type === "qualified_identifier") {
      const parts = f.text.replace(/<[^<>]*>/g, "").split("::").filter(Boolean);
      const name = parts.pop()!;
      return { name, qualifier: parts.length ? parts[parts.length - 1] : undefined };
    }
    return null;
  },
  imports(n) {
    if (n.type !== "preproc_include") return null;
    const p = field(n, "path");
    return p ? [{ spec: unquote(p.text) }] : [];
  },
  self: ["this", "self"],
};

// ---- C# -----------------------------------------------------------------------

const csSpec: Spec = {
  decl(n) {
    const mods = kids(n).filter((c) => c.type === "modifier").map((c) => c.text).join(" ");
    const name = field(n, "name")?.text ?? null;
    switch (n.type) {
      case "namespace_declaration":
        return { kind: "namespace", name, members: kids(field(n, "body")) };
      case "file_scoped_namespace_declaration":
        return { kind: "namespace", name, members: kids(n).filter((c) => c !== field(n, "name")) };
      case "class_declaration":
      case "struct_declaration":
      case "interface_declaration":
      case "record_declaration":
      case "record_struct_declaration":
        return { kind: n.type.replace(/_declaration$/, "").replace("record_struct", "record"), name, members: kids(field(n, "body")), exported: !privateText(mods) };
      case "enum_declaration":
        return { kind: "enum", name, exported: !privateText(mods) };
      case "method_declaration":
      case "operator_declaration":
        return { kind: "method", name, body: field(n, "body"), exported: !privateText(mods) };
      case "constructor_declaration":
        return { kind: "method", name: "constructor", body: field(n, "body"), exported: !privateText(mods) };
    }
    return null;
  },
  transparent: ["declaration_list"],
  stop: ["class_declaration", "struct_declaration", "local_function_statement"],
  callTypes: ["invocation_expression", "object_creation_expression"],
  call(n) {
    if (n.type === "object_creation_expression") {
      const t = typeName(field(n, "type"));
      return t ? { name: t } : null;
    }
    const f = field(n, "function");
    if (!f) return null;
    const nameOf = (x: Node | null) => (x?.type === "generic_name" ? (childOf(x, "identifier")?.text ?? null) : (x?.text ?? null));
    if (f.type === "identifier" || f.type === "generic_name") return { name: nameOf(f)! };
    if (f.type === "member_access_expression") return { name: nameOf(field(f, "name")) ?? "", qualifier: receiver(field(f, "expression"), ["this", "base"]) };
    return null;
  },
  imports(n) {
    if (n.type !== "using_directive") return null;
    const target = kids(n).filter((c) => c.type === "qualified_name" || c.type === "identifier").pop();
    return target ? [{ spec: target.text }] : [];
  },
  self: ["this", "base"],
};

// ---- PHP ----------------------------------------------------------------------

const phpSpec: Spec = {
  decl(n) {
    const name = field(n, "name")?.text ?? null;
    const vis = childOf(n, "visibility_modifier")?.text;
    switch (n.type) {
      case "class_declaration":
      case "interface_declaration":
      case "trait_declaration":
      case "enum_declaration":
        return { kind: n.type.replace("_declaration", ""), name, members: kids(field(n, "body")) };
      case "method_declaration":
        return { kind: "method", name, body: field(n, "body"), exported: !privateText(vis) };
      case "function_definition":
        return { kind: "function", name, body: field(n, "body") };
    }
    return null;
  },
  transparent: ["namespace_definition", "compound_statement", "declaration_list"],
  stop: ["class_declaration", "function_definition", "anonymous_function_creation_expression", "arrow_function"],
  callTypes: ["function_call_expression", "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression", "object_creation_expression"],
  call(n) {
    const name = (x: Node | null) => (x ? last(x.text) : "");
    switch (n.type) {
      case "function_call_expression":
        return { name: name(field(n, "function")) };
      case "member_call_expression":
      case "nullsafe_member_call_expression":
        return { name: name(field(n, "name")), qualifier: receiver(field(n, "object"), ["this"]) };
      case "scoped_call_expression": {
        const scope = field(n, "scope");
        const q = scope && /^(self|static|parent)$/.test(scope.text) ? "self" : scope ? last(scope.text) : undefined;
        return { name: name(field(n, "name")), qualifier: q };
      }
      case "object_creation_expression": {
        const t = childOf(n, "name", "qualified_name");
        return t ? { name: last(t.text) } : null;
      }
    }
    return null;
  },
  imports(n) {
    if (n.type !== "namespace_use_declaration") return null;
    return descendants(n, "namespace_use_clause").flatMap((c) => {
      const target = childOf(c, "qualified_name", "name");
      if (!target) return [];
      const alias = childOf(c, "namespace_aliasing_clause")?.text.replace(/^as\s+/i, "");
      const lastName = last(target.text);
      const spec = target.text.replace(/^\\/, "");
      return [{ spec: spec.slice(0, Math.max(0, spec.lastIndexOf("\\"))), names: [{ local: alias ?? lastName, imported: lastName }] }];
    });
  },
  self: ["this"],
  topLevelCalls: true,
};

// ---- Ruby ---------------------------------------------------------------------

const RUBY_NOT_CALLS = new Set(["require", "require_relative", "load", "include", "extend", "prepend", "attr_accessor", "attr_reader", "attr_writer", "private", "protected", "public", "module_function", "raise", "puts", "p", "lambda", "proc", "loop"]);
const rubySpec: Spec = {
  decl(n, parent) {
    switch (n.type) {
      case "module":
      case "class":
        return { kind: n.type, name: field(n, "name") ? last(field(n, "name")!.text) : null, members: kids(field(n, "body") ?? childOf(n, "body_statement")) };
      case "method":
        return { kind: parent ? "method" : "function", name: field(n, "name")?.text ?? null, body: n };
      case "singleton_method":
        return { kind: "method", name: field(n, "name")?.text ?? null, body: n };
    }
    return null;
  },
  transparent: ["body_statement", "begin_block"],
  stop: ["method", "singleton_method", "class", "module"],
  callTypes: ["call"],
  call(n) {
    const m = field(n, "method")?.text;
    if (!m) return null;
    const recv = field(n, "receiver");
    if (!recv && (RUBY_NOT_CALLS.has(m) || m === "new")) return null;
    if (m === "new" && recv) return { name: last(recv.text) }; // Foo.new → Foo
    return { name: m, qualifier: receiver(recv, ["self"]) };
  },
  imports(n) {
    if (n.type !== "call" || field(n, "receiver")) return null;
    const m = field(n, "method")?.text;
    if (m !== "require" && m !== "require_relative" && m !== "load") return null;
    const arg = kids(field(n, "arguments"))[0];
    return arg ? [{ spec: unquote(arg.text) }] : [];
  },
  self: ["self"],
  topLevelCalls: true,
};

// ---- Scala --------------------------------------------------------------------

const scalaSpec: Spec = {
  decl(n) {
    const name = field(n, "name")?.text ?? null;
    const mods = childOf(n, "modifiers")?.text;
    switch (n.type) {
      case "class_definition":
      case "object_definition":
      case "trait_definition":
      case "enum_definition":
        return { kind: n.type.replace("_definition", ""), name, members: kids(field(n, "body")), exported: !privateText(mods) };
      case "function_definition":
      case "function_declaration":
        return { kind: "function", name, body: field(n, "body"), exported: !privateText(mods) };
    }
    return null;
  },
  transparent: ["template_body", "package_clause"],
  stop: ["class_definition", "object_definition", "trait_definition", "function_definition"],
  callTypes: ["call_expression", "instance_expression"],
  call(n) {
    if (n.type === "instance_expression") {
      const t = childOf(n, "type_identifier", "generic_type");
      return t ? { name: typeName(t)! } : null;
    }
    let f = field(n, "function");
    if (f?.type === "generic_function") f = field(f, "function");
    if (!f) return null;
    if (f.type === "identifier") return { name: f.text };
    if (f.type === "field_expression") return { name: field(f, "field")?.text ?? "", qualifier: receiver(field(f, "value"), ["this"]) };
    return null;
  },
  imports(n) {
    if (n.type !== "import_declaration") return null;
    const path = field(n, "path")?.text;
    if (!path) return [];
    const sel = childOf(n, "import_selectors");
    if (!sel) return [{ spec: path.slice(0, Math.max(0, path.lastIndexOf("."))), names: [{ local: last(path), imported: last(path) }] }];
    const names = kids(sel).flatMap((c) =>
      c.type === "identifier" ? [{ local: c.text, imported: c.text }] : c.type === "renamed_identifier" ? [{ local: field(c, "alias")?.text ?? "", imported: field(c, "name")?.text ?? "" }] : [],
    );
    return [{ spec: path, names }];
  },
  self: ["this"],
};

// ---- Dart ---------------------------------------------------------------------

function dartSignatureName(n: Node): string | null {
  const sig = n.type.endsWith("_signature") ? n : kids(n).find((c) => c.type.endsWith("_signature"));
  if (!sig) return null;
  const inner = sig.type === "method_signature" ? (kids(sig).find((c) => c.type.endsWith("_signature")) ?? sig) : sig;
  return field(inner, "name")?.text ?? childOf(inner, "identifier")?.text ?? null;
}
const dartSpec: Spec = {
  decl(n, parent) {
    switch (n.type) {
      case "class_definition":
      case "enum_declaration":
      case "extension_declaration":
        return { kind: n.type === "class_definition" ? "class" : n.type.replace("_declaration", ""), name: field(n, "name")?.text ?? null, members: kids(field(n, "body")) };
      case "mixin_declaration":
        return { kind: "mixin", name: childOf(n, "identifier")?.text ?? null, members: kids(childOf(n, "class_body")) };
      case "method_signature":
      case "function_signature":
      case "declaration": {
        const name = dartSignatureName(n);
        if (!name) return null;
        const next = n.nextNamedSibling;
        const body = next?.type === "function_body" ? next : null;
        return { kind: parent ? "method" : "function", name, body, end: body ?? n, exported: !name.startsWith("_") };
      }
    }
    return null;
  },
  transparent: ["class_body"],
  stop: ["class_definition", "function_expression"],
  callTypes: ["selector"],
  call(n) {
    // Calls are flat sequences: `a` `.b` `(args)`: the argument selector closes the call.
    if (!childOf(n, "argument_part")) return null;
    const prev = n.previousNamedSibling;
    if (!prev) return null;
    if (prev.type === "identifier") return { name: prev.text };
    const member = prev.type === "selector" ? childOf(prev, "unconditional_assignable_selector", "conditional_assignable_selector") : null;
    const name = member && childOf(member, "identifier")?.text;
    if (!name) return null;
    const recv = prev.previousNamedSibling;
    return { name, qualifier: recv && (recv.type === "identifier" || recv.type === "this") ? receiver(recv, ["this"]) : undefined };
  },
  imports(n) {
    if (n.type !== "import_or_export") return null;
    const spec = descendants(n, "uri")[0];
    if (!spec) return [];
    const alias = descendants(n, "import_specification")[0];
    const as = alias ? kids(alias).find((c) => c.type === "identifier")?.text : undefined;
    return [{ spec: unquote(spec.text), local: as }];
  },
  self: ["this"],
};

// ---- Lua ----------------------------------------------------------------------

const luaSpec: Spec = {
  decl(n) {
    if (n.type === "function_definition_statement" || n.type === "function_declaration") {
      const nm = field(n, "name");
      if (!nm) return null;
      if (nm.type === "identifier") return { kind: "function", name: nm.text, body: field(n, "body") };
      const table = field(nm, "table")?.text;
      const member = (field(nm, "field") ?? field(nm, "method"))?.text;
      if (!member) return null;
      return { kind: "function", name: member, qname: table ? `${table}.${member}` : member, body: field(n, "body") };
    }
    if (n.type === "local_function_definition_statement") return { kind: "function", name: field(n, "name")?.text ?? null, body: field(n, "body"), exported: false };
    return null;
  },
  stop: ["function_definition_statement", "local_function_definition_statement"],
  callTypes: ["call", "function_call"],
  call(n) {
    const f = field(n, "function") ?? field(n, "name");
    if (!f) return null;
    if (f.type === "identifier") return { name: f.text };
    const nm = field(f, "name");
    if (nm && !field(f, "table")) return { name: nm.text };
    const member = (field(f, "field") ?? field(f, "method"))?.text;
    return member ? { name: member, qualifier: receiver(field(f, "table"), ["self"]) } : null;
  },
  imports(n) {
    if (n.type !== "variable_declaration" && n.type !== "local_variable_declaration") return null;
    const call = descendants(n, ["function_call", "call"])[0];
    const fn = call && (field(call, "name") ?? field(call, "function"));
    if (!call || !fn || fn.text !== "require") return null;
    const arg = descendants(call, ["string_content", "string"])[0];
    const local = descendants(n, "identifier")[0]?.text;
    return arg ? [{ spec: unquote(arg.text), local }] : [];
  },
  self: ["self"],
  topLevelCalls: true,
};

// ---- Zig ----------------------------------------------------------------------

const ZIG_CONTAINERS = ["struct_declaration", "enum_declaration", "union_declaration", "opaque_declaration"];
const zigSpec: Spec = {
  decl(n) {
    if (n.type === "function_declaration") return { kind: "function", name: field(n, "name")?.text ?? null, body: field(n, "body"), exported: /^\s*(pub|export)\b/.test(n.text) };
    if (n.type === "variable_declaration") {
      const container = kids(n).find((c) => ZIG_CONTAINERS.includes(c.type));
      if (!container) return null;
      return { kind: container.type.replace("_declaration", ""), name: childOf(n, "identifier")?.text ?? null, members: kids(container), exported: /^\s*pub\b/.test(n.text) };
    }
    return null;
  },
  stop: ["function_declaration"],
  callTypes: ["call_expression"],
  call(n) {
    const f = field(n, "function");
    if (!f) return null;
    if (f.type === "identifier") return { name: f.text };
    if (f.type === "field_expression") return { name: field(f, "member")?.text ?? "", qualifier: receiver(field(f, "object"), ["self"]) };
    return null;
  },
  imports(n) {
    if (n.type !== "variable_declaration") return null;
    const b = kids(n).find((c) => c.type === "builtin_function");
    if (!b || childOf(b, "builtin_identifier")?.text !== "@import") return null;
    const s = descendants(b, "string_content")[0];
    return s ? [{ spec: s.text, local: childOf(n, "identifier")?.text }] : [];
  },
  self: ["self"],
};

// ---- Elixir -------------------------------------------------------------------

const EX_DEFS = new Set(["def", "defp", "defmacro", "defmacrop", "defdelegate", "defguard", "defguardp"]);
const EX_MODULES = new Set(["defmodule", "defprotocol", "defimpl"]);
const EX_NOT_CALLS = new Set([...EX_DEFS, ...EX_MODULES, "alias", "import", "require", "use", "if", "unless", "case", "cond", "with", "for", "fn", "quote", "unquote", "raise", "receive", "try", "doc", "moduledoc", "spec", "type", "callback", "impl", "describe", "test"]);
const exTarget = (n: Node) => (n.type === "call" ? field(n, "target") : null);
const elixirSpec: Spec = {
  decl(n) {
    const t = exTarget(n)?.text;
    if (!t) return null;
    const args = childOf(n, "arguments");
    if (EX_MODULES.has(t)) {
      const name = args ? kids(args)[0]?.text : null;
      return name ? { kind: "module", name: last(name), qname: name, members: kids(childOf(n, "do_block")) } : null;
    }
    if (EX_DEFS.has(t)) {
      let head = args ? kids(args)[0] : null;
      if (head?.type === "binary_operator") head = field(head, "left"); // def f(x) when guard
      const name = head?.type === "call" ? exTarget(head)?.text : head?.type === "identifier" ? head.text : null;
      return { kind: t.startsWith("defmacro") ? "macro" : "function", name: name ?? null, body: childOf(n, "do_block") ?? (args && childOf(args, "keywords")), exported: !t.endsWith("p") };
    }
    return null;
  },
  transparent: ["do_block"],
  stop: [],
  callTypes: ["call"],
  call(n) {
    const t = exTarget(n);
    if (!t) return null;
    if (t.type === "identifier") return EX_NOT_CALLS.has(t.text) ? null : { name: t.text };
    if (t.type === "dot") {
      const right = field(t, "right")?.text;
      const left = field(t, "left");
      return right ? { name: right, qualifier: left ? last(left.text) : undefined } : null;
    }
    return null;
  },
  imports(n) {
    const t = exTarget(n)?.text;
    if (t !== "alias" && t !== "import" && t !== "require" && t !== "use") return null;
    const arg = kids(childOf(n, "arguments"))[0];
    if (!arg) return [];
    const as = descendants(n, "keyword").find((k) => k.text.startsWith("as:"))?.nextNamedSibling?.text;
    return [{ spec: arg.text, local: t === "alias" ? (as ?? last(arg.text)) : undefined }];
  },
};

// ---- OCaml / ReScript -----------------------------------------------------------

const ocamlSpec: Spec = {
  decl(n) {
    switch (n.type) {
      case "value_definition": {
        const b = childOf(n, "let_binding");
        const name = b && field(b, "pattern")?.type === "value_name" ? field(b, "pattern")!.text : null;
        const isFn = !!b && kids(b).some((c) => c.type === "parameter");
        return { kind: isFn ? "function" : "value", name, body: b && field(b, "body") };
      }
      case "module_definition": {
        const b = childOf(n, "module_binding");
        return { kind: "module", name: (b && field(b, "name")?.text) ?? null, members: kids(b && field(b, "body")) };
      }
      case "type_definition": {
        const b = childOf(n, "type_binding");
        return { kind: "type", name: (b && field(b, "name")?.text) ?? null };
      }
    }
    return null;
  },
  transparent: ["structure"],
  stop: ["value_definition", "module_definition"],
  callTypes: ["application_expression"],
  call(n) {
    const f = field(n, "function");
    if (f?.type !== "value_path") return null;
    const name = childOf(f, "value_name")?.text;
    const mod = childOf(f, "module_path");
    return name ? { name, qualifier: mod ? last(mod.text) : undefined } : null;
  },
  imports(n) {
    if (n.type !== "open_module") return null;
    const m = childOf(n, "module_path");
    return m ? [{ spec: m.text, local: "*" }] : [];
  },
};

const rescriptSpec: Spec = {
  decl(n) {
    switch (n.type) {
      case "let_declaration": {
        const b = childOf(n, "let_binding");
        const pattern = b && field(b, "pattern");
        const body = b && field(b, "body");
        return { kind: body?.type === "function" ? "function" : "value", name: pattern?.type === "value_identifier" ? pattern.text : null, body };
      }
      case "module_declaration": {
        const b = childOf(n, "module_binding");
        return { kind: "module", name: (b && field(b, "name")?.text) ?? null, members: kids(b && field(b, "definition")) };
      }
      case "type_declaration": {
        const b = childOf(n, "type_binding");
        return { kind: "type", name: (b && field(b, "name")?.text) ?? null };
      }
    }
    return null;
  },
  transparent: ["block"],
  stop: ["let_declaration", "module_declaration"],
  callTypes: ["call_expression"],
  call(n) {
    const f = field(n, "function");
    if (!f) return null;
    if (f.type === "value_identifier") return { name: f.text };
    if (f.type === "value_identifier_path") {
      const name = childOf(f, "value_identifier")?.text;
      const mods = kids(f).filter((c) => c.type === "module_identifier");
      return name ? { name, qualifier: mods.length ? mods[mods.length - 1].text : undefined } : null;
    }
    return null;
  },
  imports(n) {
    if (n.type !== "open_statement") return null;
    const m = childOf(n, "module_identifier", "module_identifier_path");
    return m ? [{ spec: m.text, local: "*" }] : [];
  },
};

// ---- Solidity -----------------------------------------------------------------

const solSpec: Spec = {
  decl(n) {
    const name = field(n, "name")?.text ?? null;
    const vis = childOf(n, "visibility")?.text;
    switch (n.type) {
      case "contract_declaration":
      case "interface_declaration":
      case "library_declaration":
        return { kind: n.type.replace("_declaration", ""), name, members: kids(field(n, "body")) };
      case "function_definition":
        return { kind: "function", name, body: field(n, "body"), exported: !privateText(vis) };
      case "constructor_definition":
        return { kind: "function", name: "constructor", body: field(n, "body") };
      case "modifier_definition":
        return { kind: "modifier", name, body: field(n, "body") };
      case "event_definition":
      case "struct_declaration":
      case "enum_declaration":
      case "error_declaration":
        return { kind: n.type.replace(/_(definition|declaration)$/, ""), name };
    }
    return null;
  },
  stop: ["function_definition", "modifier_definition"],
  callTypes: ["call_expression"],
  call(n) {
    const f = field(n, "function");
    if (!f) return null;
    if (f.type === "identifier") return { name: f.text };
    if (f.type === "member_expression") return { name: field(f, "property")?.text ?? "", qualifier: receiver(field(f, "object"), ["this", "super"]) };
    return null;
  },
  imports(n) {
    if (n.type !== "import_directive") return null;
    const s = field(n, "source");
    return s ? [{ spec: unquote(s.text) }] : [];
  },
  self: ["this", "super"],
};

// ---- Bash / Emacs Lisp ----------------------------------------------------------

const bashSpec: Spec = {
  decl(n) {
    return n.type === "function_definition" ? { kind: "function", name: field(n, "name")?.text ?? null, body: field(n, "body") } : null;
  },
  stop: ["function_definition"],
  callTypes: ["command"],
  call(n) {
    const name = field(n, "name")?.text;
    return name && !/^(source|\.|echo|printf|cd|export|local|read|test|\[)$/.test(name) ? { name } : null;
  },
  imports(n) {
    if (n.type !== "command" || !/^(source|\.)$/.test(field(n, "name")?.text ?? "")) return null;
    const arg = field(n, "argument");
    return arg ? [{ spec: unquote(arg.text) }] : [];
  },
  topLevelCalls: true,
};

const ELISP_FORMS = new Set(["let", "let*", "if", "when", "unless", "progn", "setq", "setq-local", "cond", "and", "or", "not", "lambda", "quote", "function", "while", "dolist", "dotimes", "defvar", "defcustom", "defconst", "interactive", "save-excursion", "with-current-buffer", "condition-case", "catch", "throw", "require", "provide", "list", "car", "cdr", "cons", "concat", "format", "message", "funcall", "apply", "eq", "equal"]);
const elispSpec: Spec = {
  decl(n) {
    if (n.type === "function_definition" || n.type === "macro_definition")
      return { kind: n.type === "macro_definition" ? "macro" : "function", name: field(n, "name")?.text ?? null, body: n, exported: !/--/.test(field(n, "name")?.text ?? "") };
    return null;
  },
  stop: ["function_definition", "macro_definition"],
  callTypes: ["list"],
  call(n) {
    const p = n.parent;
    if (p && (p.type === "function_definition" || p.type === "macro_definition") && field(p, "parameters")?.id === n.id) return null;
    const head = kids(n)[0];
    return head?.type === "symbol" && !ELISP_FORMS.has(head.text) ? { name: head.text } : null;
  },
  imports(n) {
    if (n.type !== "list" || kids(n)[0]?.text !== "require") return null;
    const q = kids(n)[1];
    return q ? [{ spec: q.text.replace(/^'/, "") }] : [];
  },
};

const SPECS: Record<string, Spec> = {
  cpp: cSpec,
  objc: cSpec,
  c_sharp: csSpec,
  php: phpSpec,
  ruby: rubySpec,
  scala: scalaSpec,
  dart: dartSpec,
  lua: luaSpec,
  zig: zigSpec,
  elixir: elixirSpec,
  ocaml: ocamlSpec,
  rescript: rescriptSpec,
  solidity: solSpec,
  bash: bashSpec,
  elisp: elispSpec,
};

// ---- walker -------------------------------------------------------------------

export function parseTreeSitterMore(ext: string, text: string): Omit<CodeOutline, "language"> | null {
  const spec = SPECS[GRAMMAR_OF_EXT[ext] ?? ""];
  if (!spec) return null;
  return parseTree(ext, text, (root) => {
    const symbols: CodeSymbol[] = [];
    const refs: CodeRef[] = [];
    const ctx = { lines: text.split("\n") };
    const transparent = new Set(spec.transparent ?? []);
    const stop = new Set(spec.stop ?? []);
    const callTypes = new Set(spec.callTypes);
    const self = spec.self ?? [];

    const collectCalls = (body: Node, owner: string) => {
      const seen = new Set<string>();
      const visit = (n: Node) => {
        if (callTypes.has(n.type)) {
          const c = spec.call(n);
          if (c?.name) {
            const qualifier = c.qualifier && self.includes(c.qualifier) ? "self" : c.qualifier;
            const key = `${qualifier ?? ""}.${c.name}`;
            if (!seen.has(key)) {
              seen.add(key);
              refs.push({ fromQname: owner, toName: c.name, kind: "call", line: line(n), ...(qualifier ? { qualifier } : {}) });
            }
          }
        }
        for (const ch of kids(n)) if (!(stop.has(ch.type) && ch !== body)) visit(ch);
      };
      visit(body);
    };

    const CONTAINER_KINDS = /^(class|struct|union|interface|record|trait|object|enum|module|mixin|extension|contract|library)$/;
    const walk = (nodes: Node[], parent: string | undefined, parentKind?: string) => {
      for (const n of nodes) {
        const imps = spec.imports?.(n);
        if (imps) {
          for (const i of imps)
            refs.push({
              fromQname: "",
              toName: i.spec,
              kind: "import",
              line: line(n),
              bindings: i.names ?? (i.local ? [{ local: i.local, imported: "*" }] : []),
            });
          continue;
        }
        const d = spec.decl(n, parent);
        if (d) {
          if (!d.name) continue;
          const name = d.name;
          const qname = d.qname ? (parent ? `${parent}.${d.qname}` : d.qname) : parent ? `${parent}.${name}` : name;
          const start = d.start ?? n;
          const end = d.end ?? n;
          const symbolParent = qname.includes(".") ? qname.slice(0, qname.lastIndexOf(".")) : undefined;
          symbols.push({
            name,
            qname,
            kind: d.kind === "function" && parentKind && CONTAINER_KINDS.test(parentKind) && parentKind !== "module" ? "method" : d.kind,
            lineStart: line(start),
            lineEnd: endLine(end),
            docStart: docStart(ctx, start),
            signature: signature(start),
            exported: d.exported ?? !name.startsWith("_"),
            parent: symbolParent,
          });
          if (d.members) walk(d.members, qname, d.kind);
          if (d.body) collectCalls(d.body, qname);
          continue;
        }
        if (transparent.has(n.type)) walk(kids(n), parent, parentKind);
        else if (!parent && spec.topLevelCalls) collectCalls(n, "");
      }
    };
    walk(kids(root), undefined);
    return { symbols, refs };
  });
}
