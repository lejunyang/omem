import { extname } from "node:path";
import ts from "typescript";
import { parseTreeSitter } from "./treesitter.ts";
import { parseTreeSitterMore } from "./treesitter-more.ts";

export type CodeSymbol = {
  name: string;
  qname: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  /** First line of an attached doc comment, when present. */
  docStart?: number;
  signature: string;
  exported: boolean;
  parent?: string;
};
export type ImportBinding = { local: string; imported: string };
/**
 * import: toName is the module specifier, bindings map local names to exported names
 *   ("default", "*" for namespaces, or the export name).
 * export: re-exports (`export {a as b} from`, `export * from`) and default exports
 *   (toName "" with bindings [{local, imported: "default"}]).
 * call: toName is the called name; qualifier is the receiver for `ns.fn()` / `this.fn()`.
 */
export type CodeRef = { fromQname: string; toName: string; kind: "import" | "call" | "export"; line: number; qualifier?: string; bindings?: ImportBinding[] };
export type CodeOutline = { language: string; symbols: CodeSymbol[]; refs: CodeRef[] };

const TS_EXT: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

export function parseCode(path: string, text: string): CodeOutline {
  const ext = extname(path).toLowerCase();
  if (ext === ".vue" || ext === ".svelte") {
    const m = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(text);
    if (!m) return { language: ext.slice(1), symbols: [], refs: [] };
    const offset = text.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length - 1;
    const lang = /lang=["']tsx?["']/.test(m[0]) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const outline = parseTs(m[1], lang);
    const shift = (n: number) => n + offset;
    return {
      language: ext.slice(1),
      symbols: outline.symbols.map((s) => ({ ...s, lineStart: shift(s.lineStart), lineEnd: shift(s.lineEnd), docStart: s.docStart && shift(s.docStart) })),
      refs: outline.refs.map((r) => ({ ...r, line: shift(r.line) })),
    };
  }
  if (TS_EXT[ext] !== undefined) return { ...parseTs(text, TS_EXT[ext]), language: ext.slice(1) };
  const tree = parseTreeSitter(ext, text) ?? parseTreeSitterMore(ext, text);
  if (tree) return { ...tree, language: ext.slice(1) };
  return parseGeneric(ext.slice(1), text);
}

function parseTs(text: string, kind: ts.ScriptKind): Omit<CodeOutline, "language"> {
  const sf = ts.createSourceFile("x" + (kind === ts.ScriptKind.TSX ? ".tsx" : ".ts"), text, ts.ScriptTarget.Latest, true, kind);
  const symbols: CodeSymbol[] = [];
  const refs: CodeRef[] = [];
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const exported = (node: ts.Node) =>
    !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  const docStart = (node: ts.Node) => {
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
    const doc = ranges?.find((r) => text.slice(r.pos, r.pos + 3) === "/**" || text.slice(r.pos, r.pos + 2) === "//");
    return doc ? line(doc.pos) : undefined;
  };
  const signature = (node: ts.Node) => {
    const raw = node.getText(sf);
    const brace = raw.search(/\{|=>/);
    return (brace > 0 ? raw.slice(0, brace) : raw.split("\n")[0]).replace(/\s+/g, " ").trim().slice(0, 240);
  };
  const add = (node: ts.Node, name: string, symKind: string, parent?: string) => {
    const qname = parent ? `${parent}.${name}` : name;
    symbols.push({
      name,
      qname,
      kind: symKind,
      lineStart: line(node.getStart(sf)),
      lineEnd: line(node.getEnd()),
      docStart: docStart(node),
      signature: signature(node),
      exported: exported(node),
      parent,
    });
    // Class bodies are covered by their members; collecting at class level would
    // attribute every method's calls to the class as well.
    if (symKind !== "class") collectCalls(node, qname);
    return qname;
  };
  const collectCalls = (node: ts.Node, owner: string) => {
    const seen = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        const qualifier =
          ts.isPropertyAccessExpression(e) && (ts.isIdentifier(e.expression) || e.expression.kind === ts.SyntaxKind.ThisKeyword)
            ? e.expression.getText(sf)
            : undefined;
        const key = `${qualifier ?? ""}.${name}`;
        if (name && !seen.has(key)) {
          seen.add(key);
          refs.push({ fromQname: owner, toName: name, kind: "call", line: line(n.getStart(sf)), ...(qualifier ? { qualifier } : {}) });
        }
      }
      // Nested declarations get their own entries only at top level / class level.
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const bindings: ImportBinding[] = [];
      const clause = stmt.importClause;
      if (clause?.name) bindings.push({ local: clause.name.text, imported: "default" });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ local: nb.name.text, imported: "*" });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) bindings.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text });
      refs.push({ fromQname: "", toName: stmt.moduleSpecifier.text, kind: "import", line: line(stmt.getStart(sf)), bindings });
    } else if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      refs.push({ fromQname: "", toName: "", kind: "export", line: line(stmt.getStart(sf)), bindings: [{ local: stmt.expression.text, imported: "default" }] });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      add(stmt, stmt.name.text, "function");
      if (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        refs.push({ fromQname: "", toName: "", kind: "export", line: line(stmt.getStart(sf)), bindings: [{ local: stmt.name.text, imported: "default" }] });
    }
    else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const q = add(stmt, stmt.name.text, "class");
      if (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        refs.push({ fromQname: "", toName: "", kind: "export", line: line(stmt.getStart(sf)), bindings: [{ local: q, imported: "default" }] });
      for (const m of stmt.members) {
        const name = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : null;
        if (!name) continue;
        if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) add(m, name, "method", q);
        else if (ts.isConstructorDeclaration(m)) add(m, "constructor", "method", q);
      }
    } else if (ts.isInterfaceDeclaration(stmt)) add(stmt, stmt.name.text, "interface");
    else if (ts.isTypeAliasDeclaration(stmt)) add(stmt, stmt.name.text, "type");
    else if (ts.isEnumDeclaration(stmt)) add(stmt, stmt.name.text, "enum");
    else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) add(stmt, stmt.name.text, "namespace");
    else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const init = d.initializer;
        const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        // Only meaningful bindings become symbols: functions, objects, classes, multi-line values.
        const span = line(stmt.getEnd()) - line(stmt.getStart(sf));
        if (isFn || span >= 2 || exported(stmt)) {
          symbols.push({
            name: d.name.text,
            qname: d.name.text,
            kind: isFn ? "function" : "const",
            lineStart: line(stmt.getStart(sf)),
            lineEnd: line(stmt.getEnd()),
            docStart: docStart(stmt),
            signature: signature(stmt),
            exported: exported(stmt),
          });
          collectCalls(stmt, d.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      // `export * from "./x"` → binding "*"; `export { a as b } from "./x"` → local b re-exports imported a.
      const bindings: ImportBinding[] =
        stmt.exportClause && ts.isNamedExports(stmt.exportClause)
          ? stmt.exportClause.elements.map((el) => ({ local: el.name.text, imported: (el.propertyName ?? el.name).text }))
          : [{ local: "*", imported: "*" }];
      refs.push({ fromQname: "", toName: stmt.moduleSpecifier.text, kind: "export", line: line(stmt.getStart(sf)), bindings });
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      // `export { a as b }` of local symbols
      const bindings = stmt.exportClause.elements.map((el) => ({ local: (el.propertyName ?? el.name).text, imported: el.name.text }));
      refs.push({ fromQname: "", toName: "", kind: "export", line: line(stmt.getStart(sf)), bindings });
    } else if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) {
      // Module-level code: registrations like `def({ name: "x", handler })`, `app.get("/p", fn)`,
      // `describe("…", …)` are labelled by their callee and first string so callers stay meaningful.
      collectCalls(stmt, topLevelLabel(stmt, sf));
    }
  }
  return { symbols, refs };
}

function topLevelLabel(stmt: ts.Statement, sf: ts.SourceFile): string {
  if (!ts.isExpressionStatement(stmt)) return "";
  let e: ts.Expression = stmt.expression;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return "";
  const callee = e.expression.getText(sf).replace(/\s+/g, "");
  if (callee.length > 40) return "";
  const first = e.arguments[0];
  let label: string | undefined;
  if (first && ts.isStringLiteralLike(first)) label = first.text;
  else if (first && ts.isObjectLiteralExpression(first))
    for (const p of first.properties)
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && /^(name|id|path|key|command)$/.test(p.name.text) && ts.isStringLiteralLike(p.initializer)) {
        label = p.initializer.text;
        break;
      }
  return label ? `${callee}(${JSON.stringify(label.slice(0, 60))})` : `${callee}()`;
}

/**
 * Language-agnostic outline for files without a bundled parser. Detects common
 * declaration keywords and ends a block at the next declaration of the same or
 * lower indentation. Good enough to give search and readers named anchors.
 */
const GENERIC = [
  /^(\s*)(?:export\s+|pub(?:\([^)]*\))?\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|abstract\s+|async\s+|override\s+|open\s+|data\s+|suspend\s+)*(def|class|func|fn|function|struct|enum|trait|impl|interface|object|module|type|record|fun)\s+([A-Za-z_][\w]*)/,
  /^(\s*)(?:public|private|protected|static|final|\s)+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws [\w, ]+)?\s*\{\s*$/,
];

function parseGeneric(language: string, text: string): CodeOutline {
  const lines = text.split("\n");
  const found: { line: number; indent: number; kind: string; name: string }[] = [];
  lines.forEach((l, i) => {
    const a = GENERIC[0].exec(l);
    if (a) return void found.push({ line: i + 1, indent: a[1].length, kind: a[2], name: a[3] });
    const b = GENERIC[1].exec(l);
    if (b) found.push({ line: i + 1, indent: b[1].length, kind: "method", name: b[2] });
  });
  const symbols: CodeSymbol[] = [];
  const stack: { indent: number; qname: string }[] = [];
  found.forEach((f, idx) => {
    let end = lines.length;
    for (let k = idx + 1; k < found.length; k++)
      if (found[k].indent <= f.indent) {
        end = found[k].line - 1;
        break;
      }
    while (end > f.line && !lines[end - 1].trim()) end--;
    while (stack.length && stack[stack.length - 1].indent >= f.indent) stack.pop();
    const parent = stack[stack.length - 1]?.qname;
    const qname = parent ? `${parent}.${f.name}` : f.name;
    let doc = f.line;
    while (doc > 1 && /^\s*(#|\/\/|\*|\/\*|""")/.test(lines[doc - 2])) doc--;
    symbols.push({
      name: f.name,
      qname,
      kind: f.kind,
      lineStart: f.line,
      lineEnd: end,
      docStart: doc < f.line ? doc : undefined,
      signature: lines[f.line - 1].trim().slice(0, 240),
      exported: !/^\s*(private|fileprivate)\b/.test(lines[f.line - 1]) && !f.name.startsWith("_"),
      parent,
    });
    stack.push({ indent: f.indent, qname });
  });
  const refs: CodeRef[] = language === "py" ? pythonRefs(lines, symbols) : [];
  if (language !== "py")
    lines.forEach((l, i) => {
      const m = /^\s*(?:import|from|use|require|#include)\s+["<]?([\w./@:-]+)/.exec(l);
      if (m) refs.push({ fromQname: "", toName: m[1], kind: "import", line: i + 1 });
    });
  return { language, symbols, refs };
}

const PY_NOT_CALLS = new Set(["if", "elif", "while", "for", "return", "print", "and", "or", "not", "in", "is", "lambda", "with", "assert", "yield", "await", "del", "except", "raise", "def", "class", "super", "len", "isinstance", "str", "int", "float", "list", "dict", "set", "tuple", "range", "enumerate", "zip", "open", "getattr", "setattr", "hasattr", "type", "bool", "sorted", "min", "max", "sum", "any", "all", "map", "filter", "repr", "iter", "next"]);

/**
 * Python imports with bindings (`from .a import b as c`, `import x.y as z`) and
 * calls attributed to the innermost enclosing function, with `obj.` qualifiers.
 */
function pythonRefs(lines: string[], symbols: CodeSymbol[]): CodeRef[] {
  const refs: CodeRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const from = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(l);
    if (from) {
      let names = from[2];
      // Parenthesised multi-line import lists.
      if (names.trim().startsWith("(") && !names.includes(")")) {
        for (let k = i + 1; k < lines.length; k++) {
          names += " " + lines[k];
          if (lines[k].includes(")")) break;
        }
      }
      const bindings = names
        .replace(/[()]/g, "")
        .replace(/#.*$/gm, "")
        .split(",")
        .map((p) => p.trim().split(/\s+as\s+/))
        .filter((p) => /^\w+$/.test(p[0]))
        .map((p) => ({ local: (p[1] ?? p[0]).trim(), imported: p[0] === "*" ? "*" : p[0] }));
      refs.push({ fromQname: "", toName: from[1], kind: "import", line: i + 1, bindings });
      continue;
    }
    const imp = /^\s*import\s+(.+)$/.exec(l);
    if (imp) {
      for (const part of imp[1].split(",")) {
        const [mod, alias] = part.trim().split(/\s+as\s+/);
        if (!/^[\w.]+$/.test(mod ?? "")) continue;
        // `import a.b` binds `a`; only an alias binds the full module.
        refs.push({ fromQname: "", toName: mod, kind: "import", line: i + 1, bindings: [{ local: alias?.trim() ?? mod, imported: "*" }] });
      }
    }
  }
  const owners = symbols.filter((s) => s.kind !== "class");
  const ownerAt = (line: number) => {
    let best: CodeSymbol | undefined;
    for (const s of owners) if (s.lineStart <= line && s.lineEnd >= line && (!best || s.lineStart >= best.lineStart)) best = s;
    return best;
  };
  const seen = new Set<string>();
  lines.forEach((raw, i) => {
    const l = raw.replace(/#.*$/, "").replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
    if (/^\s*(def|class|from|import)\b/.test(l)) return;
    const owner = ownerAt(i + 1);
    if (!owner) return;
    for (const m of l.matchAll(/(?:\b([A-Za-z_]\w*)\s*\.\s*)?\b([A-Za-z_]\w*)\s*\(/g)) {
      const qualifier = m[1];
      const name = m[2];
      if (!qualifier && PY_NOT_CALLS.has(name)) continue;
      // Only simple receivers: `x.fn(` where x itself is not the tail of a longer chain.
      if (qualifier && m.index! > 0 && l[m.index! - 1] === ".") continue;
      const key = `${owner.qname}|${qualifier ?? ""}.${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ fromQname: owner.qname, toName: name, kind: "call", line: i + 1, ...(qualifier ? { qualifier } : {}) });
    }
  });
  return refs;
}
