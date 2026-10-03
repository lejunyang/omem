/** Deterministic, offline TS/Vue parser. Zero model beyond the already-declared
 * @vue/compiler-sfc:
 *  - TypeScript Compiler AST (single-file, no Program, no cross-file type
 *    resolution; calls are name-level and marked candidate),
 *  - @vue/compiler-sfc for .vue blocks,
 *  - conservative regex for Fastify routes and it/test cases.
 *
 * Everything returned carries 1-based line / 0-based column ranges so the store
 * can bind each symbol to its immutable review fragment.
 */
import * as ts from "typescript";
import { parse as parseVue } from "@vue/compiler-sfc";
import type {
  CodeRange,
  CodeSymbolKind,
} from "../../../../packages/contracts/src/index.js";

export type ParsedSymbol = {
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  rangeStart: CodeRange;
  rangeEnd: CodeRange;
  exported: boolean;
  signature: string | null;
};

export type ParsedImport = {
  specifier: string;
  rangeStart: CodeRange;
  bindings?: { local: string; imported: string }[];
};

export type ParsedCall = {
  callerQName: string;
  callee: string;
  rangeStart: CodeRange;
  expression?: string;
  receiver?: string;
  kind?: "call" | "construct";
  context?: {
    kind: string;
    text: string;
    rangeStart: CodeRange;
    rangeEnd: CodeRange;
  }[];
};

export type ParsedRoute = {
  method: string;
  path: string;
  rangeStart: CodeRange;
};

export type ParsedTest = {
  name: string;
  rangeStart: CodeRange;
};

export type ParsedFile = {
  language: string;
  componentName: string | null;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  routes: ParsedRoute[];
  tests: ParsedTest[];
  templateComponents: string[];
};

function posOf(sf: ts.SourceFile, node: ts.Node): CodeRange {
  const { line, character } = sf.getLineAndCharacterOfPosition(
    node.getStart(sf),
  );
  return { line: line + 1, col: character };
}
function endOf(sf: ts.SourceFile, node: ts.Node): CodeRange {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getEnd());
  return { line: line + 1, col: character };
}

function isExported(mods: ts.NodeArray<ts.ModifierLike> | undefined): boolean {
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const text = node.getText(sf).split("\n")[0] ?? "";
  return text.length > 120 ? text.slice(0, 120) + "..." : text;
}

function walkTs(
  source: string,
  path: string,
  lineOffset: number,
): Pick<ParsedFile, "symbols" | "imports" | "calls"> {
  const sf = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const calls: ParsedCall[] = [];

  let contextName = "";
  const range = (node: ts.Node) => ({
    rangeStart: { ...posOf(sf, node), line: posOf(sf, node).line + lineOffset },
    rangeEnd: { ...endOf(sf, node), line: endOf(sf, node).line + lineOffset },
  });
  const callContext = (node: ts.Node): NonNullable<ParsedCall["context"]> => {
    const result: NonNullable<ParsedCall["context"]> = [];
    let statement = false;
    for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isFunctionLike(p)) {
        result.push({
          kind: "enclosing-operation",
          text: signatureOf(p, sf),
          ...range(p),
        });
        break;
      }
      if (
        ts.isIfStatement(p) ||
        ts.isConditionalExpression(p) ||
        (ts.isBinaryExpression(p) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(p.operatorToken.kind))
      ) {
        const condition = ts.isBinaryExpression(p)
          ? p.left
          : ts.isConditionalExpression(p)
            ? p.condition
            : p.expression;
        const branch = ts.isIfStatement(p)
          ? p.elseStatement && node.getStart(sf) >= p.elseStatement.getStart(sf)
            ? "else"
            : "then"
          : ts.isConditionalExpression(p)
            ? node.getStart(sf) >= p.whenFalse.getStart(sf)
              ? "false"
              : "true"
            : p.operatorToken.getText(sf);
        result.push({
          kind: `surrounding-condition:${branch}`,
          text: condition.getText(sf),
          ...range(condition),
        });
      } else if (!statement && ts.isStatement(p) && !ts.isBlock(p)) {
        result.push({ kind: "statement", text: p.getText(sf), ...range(p) });
        statement = true;
      }
    }
    return result;
  };
  const callerName = (node: ts.Node) => {
    const names: string[] = [];
    for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
      if (ts.isClassDeclaration(p) && p.name) names.push(p.name.text);
      else if (ts.isFunctionLike(p))
        names.push(
          p.name?.getText(sf) ??
            (ts.isVariableDeclaration(p.parent)
              ? p.parent.name.getText(sf)
              : "<callback>"),
        );
    }
    return names.reverse().join(".");
  };

  const addSymbol = (
    node: ts.Node,
    name: string,
    kind: CodeSymbolKind,
    exported: boolean,
    qualifiedName?: string,
  ) => {
    if (!name) return;
    const start = posOf(sf, node);
    const end = endOf(sf, node);
    symbols.push({
      name,
      qualifiedName:
        qualifiedName ?? (contextName ? `${contextName}.${name}` : name),
      kind,
      rangeStart: { line: start.line + lineOffset, col: start.col },
      rangeEnd: { line: end.line + lineOffset, col: end.col },
      exported,
      signature: signatureOf(node, sf),
    });
  };

  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.FunctionDeclaration: {
        const fd = node as ts.FunctionDeclaration;
        addSymbol(
          fd,
          fd.name?.text ?? "",
          "function",
          isExported(fd.modifiers),
        );
        break;
      }
      case ts.SyntaxKind.ClassDeclaration: {
        const cd = node as ts.ClassDeclaration;
        const nm = cd.name?.text ?? "";
        addSymbol(cd, nm, "class", isExported(cd.modifiers));
        for (const member of cd.members) {
          if (
            ts.isMethodDeclaration(member) &&
            member.name &&
            ts.isIdentifier(member.name)
          ) {
            addSymbol(
              member,
              member.name.text,
              "method",
              false,
              `${nm}.${member.name.text}`,
            );
          } else if (ts.isConstructorDeclaration(member)) {
            addSymbol(
              member,
              "constructor",
              "method",
              false,
              `${nm}.constructor`,
            );
          }
        }
        break;
      }
      case ts.SyntaxKind.InterfaceDeclaration: {
        const id = node as ts.InterfaceDeclaration;
        addSymbol(id, id.name.text, "interface", isExported(id.modifiers));
        break;
      }
      case ts.SyntaxKind.TypeAliasDeclaration: {
        const td = node as ts.TypeAliasDeclaration;
        addSymbol(td, td.name.text, "type", isExported(td.modifiers));
        break;
      }
      case ts.SyntaxKind.EnumDeclaration: {
        const ed = node as ts.EnumDeclaration;
        addSymbol(ed, ed.name.text, "enum", isExported(ed.modifiers));
        break;
      }
      case ts.SyntaxKind.VariableStatement: {
        const vs = node as ts.VariableStatement;
        for (const decl of vs.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const isFn =
              !!decl.initializer &&
              (ts.isArrowFunction(decl.initializer) ||
                ts.isFunctionExpression(decl.initializer));
            addSymbol(
              decl,
              decl.name.text,
              isFn ? "function" : "const",
              isExported(vs.modifiers),
            );
          }
        }
        break;
      }
      case ts.SyntaxKind.ImportDeclaration: {
        const imp = node as ts.ImportDeclaration;
        if (ts.isStringLiteral(imp.moduleSpecifier)) {
          const start = posOf(sf, node);
          imports.push({
            specifier: imp.moduleSpecifier.text,
            rangeStart: { line: start.line + lineOffset, col: start.col },
            bindings: [
              ...(imp.importClause?.name
                ? [{ local: imp.importClause.name.text, imported: "default" }]
                : []),
              ...(imp.importClause?.namedBindings &&
              ts.isNamedImports(imp.importClause.namedBindings)
                ? imp.importClause.namedBindings.elements.map((e) => ({
                    local: e.name.text,
                    imported: e.propertyName?.text ?? e.name.text,
                  }))
                : imp.importClause?.namedBindings &&
                    ts.isNamespaceImport(imp.importClause.namedBindings)
                  ? [
                      {
                        local: imp.importClause.namedBindings.name.text,
                        imported: "*",
                      },
                    ]
                  : []),
            ],
          });
        }
        break;
      }
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.NewExpression: {
        const ce = node as ts.CallExpression | ts.NewExpression;
        let callee = "";
        if (ts.isIdentifier(ce.expression)) callee = ce.expression.text;
        else if (ts.isPropertyAccessExpression(ce.expression))
          callee = ce.expression.name.text;
        if (callee && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callee)) {
          const start = posOf(sf, ce);
          calls.push({
            callerQName: callerName(ce),
            callee,
            rangeStart: { line: start.line + lineOffset, col: start.col },
            expression: ce.expression.getText(sf),
            ...(ts.isPropertyAccessExpression(ce.expression)
              ? { receiver: ce.expression.expression.getText(sf) }
              : {}),
            kind: ts.isNewExpression(ce) ? "construct" : "call",
            context: callContext(ce),
          });
        }
        break;
      }
    }
    ts.forEachChild(node, (child) => {
      if (ts.isFunctionLike(child)) {
        const previous = contextName;
        const name =
          child.name?.getText(sf) ??
          (ts.isVariableDeclaration(child.parent)
            ? child.parent.name.getText(sf)
            : "<callback>");
        contextName = previous ? `${previous}.${name}` : name;
        visit(child);
        contextName = previous;
        return;
      }
      visit(child);
    });
  };

  ts.forEachChild(sf, (n) => visit(n));
  return { symbols, imports, calls };
}

function extractRoutes(source: string): ParsedRoute[] {
  const re =
    /\b(?:app|fastify|server|router)\s*\.\s*(get|post|put|delete|patch|all)\s*\(\s*(['"`])([^'"`\n]+?)\2/g;
  const out: ParsedRoute[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const upto = source.slice(0, m.index);
    const line = upto.split("\n").length;
    out.push({
      method: m[1]!.toUpperCase(),
      path: m[3]!,
      rangeStart: { line, col: m.index - upto.lastIndexOf("\n") - 1 },
    });
  }
  return out;
}

function extractTests(source: string): ParsedTest[] {
  const re = /\b(?:it|test)\s*\(\s*(['"`])([^'"`\n]{1,200}?)\1/g;
  const out: ParsedTest[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const upto = source.slice(0, m.index);
    out.push({
      name: m[2]!,
      rangeStart: { line: upto.split("\n").length, col: 0 },
    });
  }
  return out;
}

function extLanguage(path: string): string {
  if (path.endsWith(".vue")) return "vue";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".toml")) return "toml";
  return "text";
}

export function parseFile(path: string, source: string): ParsedFile {
  const language = extLanguage(path);
  const base = path.split("/").pop() ?? path;

  if (language === "vue") {
    const { descriptor, errors } = parseVue(source, { filename: path });
    if (errors.length) {
      return {
        language,
        componentName: base.replace(/\.vue$/, ""),
        symbols: [],
        imports: [],
        calls: [],
        routes: [],
        tests: [],
        templateComponents: [],
      };
    }
    const script = descriptor.scriptSetup ?? descriptor.script;
    let walk: Pick<ParsedFile, "symbols" | "imports" | "calls"> = {
      symbols: [],
      imports: [],
      calls: [],
    };
    let lineOffset = 0;
    if (script?.content) {
      lineOffset = (script.loc?.start?.line ?? 1) - 1;
      walk = walkTs(script.content, path, lineOffset);
    }
    const componentName = base.replace(/\.vue$/, "");
    walk.symbols.unshift({
      name: componentName,
      qualifiedName: componentName,
      kind: "component",
      rangeStart: { line: 1, col: 0 },
      rangeEnd: { line: source.split("\n").length, col: 0 },
      exported: true,
      signature: `<script${descriptor.scriptSetup ? " setup" : ""}> + <template>`,
    });
    const tpl = descriptor.template?.content ?? "";
    const compTags = new Set<string>();
    const tagRe = /<([A-Z][A-Za-z0-9]*)\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(tpl))) compTags.add(tm[1]!);
    return {
      language,
      componentName,
      symbols: walk.symbols,
      imports: walk.imports,
      calls: walk.calls,
      routes: extractRoutes(source),
      tests: extractTests(source),
      templateComponents: [...compTags],
    };
  }

  if (language === "typescript" || language === "javascript") {
    const walk = walkTs(source, path, 0);
    return {
      language,
      componentName: null,
      symbols: walk.symbols,
      imports: walk.imports,
      calls: walk.calls,
      routes: extractRoutes(source),
      tests: extractTests(source),
      templateComponents: [],
    };
  }

  return {
    language,
    componentName: null,
    symbols: [],
    imports: [],
    calls: [],
    routes: [],
    tests: [],
    templateComponents: [],
  };
}
