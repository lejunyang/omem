import { extname } from "node:path";
import ts from "typescript";

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
export type CodeRef = { fromQname: string; toName: string; kind: "import" | "call"; line: number };
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
    collectCalls(node, qname);
    return qname;
  };
  const collectCalls = (node: ts.Node, owner: string) => {
    const seen = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const e = n.expression;
        const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
        if (name && !seen.has(name)) {
          seen.add(name);
          refs.push({ fromQname: owner, toName: name, kind: "call", line: line(n.getStart(sf)) });
        }
      }
      // Nested declarations get their own entries only at top level / class level.
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(node, visit);
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      refs.push({ fromQname: "", toName: stmt.moduleSpecifier.text, kind: "import", line: line(stmt.getStart(sf)) });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) add(stmt, stmt.name.text, "function");
    else if (ts.isClassDeclaration(stmt) && stmt.name) {
      const q = add(stmt, stmt.name.text, "class");
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
      refs.push({ fromQname: "", toName: stmt.moduleSpecifier.text, kind: "import", line: line(stmt.getStart(sf)) });
    }
  }
  return { symbols, refs };
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
  const refs: CodeRef[] = [];
  lines.forEach((l, i) => {
    const m = /^\s*(?:import|from|use|require|#include)\s+["<]?([\w./@:-]+)/.exec(l);
    if (m) refs.push({ fromQname: "", toName: m[1], kind: "import", line: i + 1 });
  });
  return { language, symbols, refs };
}
