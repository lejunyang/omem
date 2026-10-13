import { posix } from "node:path";
import type { App } from "../core/app.ts";
import { all, tx } from "../core/db.ts";
import type { ImportBinding } from "./code.ts";

/**
 * Resolve calls and imports to the symbol they actually reach by following the
 * file's import bindings (relative paths, index files, `.js`→`.ts`, simple
 * `@/` aliases, Python dotted and relative modules), re-exports, default
 * exports, `this.`/`self.` methods and namespace qualifiers. Whatever cannot
 * be followed (packages, dynamic dispatch) keeps only its name.
 */
type RefRow = { rowid: number; source_id: string; from_qname: string; to_name: string; kind: string; qualifier: string | null; bindings: string | null };
type Target = { sourceId: string; qname: string } | { sourceId: string; module: true };

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".d.ts"];
const PY = /\.py$/;

export function resolveCodeRefs(app: App, spaceId: string): { resolved: number; total: number } {
  const files = all<{ id: string; uri: string }>(app.db, "select id, uri from sources where space_id = ? and kind = 'code' and deleted_at is null", spaceId);
  const byUri = new Map(files.map((f) => [f.uri, f.id]));
  const uriOf = new Map(files.map((f) => [f.id, f.uri]));
  const syms = new Map<string, Map<string, string>>(); // source → qname → kind
  for (const s of all<{ source_id: string; qname: string; kind: string }>(app.db, "select source_id, qname, kind from symbols where space_id = ?", spaceId)) {
    if (!syms.has(s.source_id)) syms.set(s.source_id, new Map());
    syms.get(s.source_id)!.set(s.qname, s.kind);
  }
  const refs = all<RefRow>(app.db, "select rowid, source_id, from_qname, to_name, kind, qualifier, bindings from code_refs where space_id = ?", spaceId);
  const bySource = new Map<string, RefRow[]>();
  for (const r of refs) {
    if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
    bySource.get(r.source_id)!.push(r);
  }

  // Python absolute imports may be rooted anywhere (src/, package dir): index by path suffix.
  const pySuffix = new Map<string, string>();
  for (const f of files) {
    if (!PY.test(f.uri)) continue;
    const parts = f.uri.replace(PY, "").split("/");
    if (parts[parts.length - 1] === "__init__") parts.pop();
    for (let k = 0; k < parts.length; k++) {
      const key = parts.slice(k).join(".");
      const prev = pySuffix.get(key);
      if (!prev || (uriOf.get(prev)?.length ?? 0) > f.uri.length) pySuffix.set(key, f.id);
    }
  }

  const moduleCache = new Map<string, string | null>();
  const resolveModule = (fromId: string, spec: string): string | null => {
    const fromUri = uriOf.get(fromId)!;
    const key = `${fromId}|${spec}`;
    if (moduleCache.has(key)) return moduleCache.get(key)!;
    let out: string | null = null;
    if (PY.test(fromUri)) {
      const dots = /^\.*/.exec(spec)![0].length;
      const rest = spec.slice(dots).replace(/\./g, "/");
      if (dots) {
        let dir = posix.dirname(fromUri);
        for (let k = 1; k < dots; k++) dir = posix.dirname(dir);
        const base = rest ? posix.join(dir, rest) : dir;
        out = byUri.get(`${base}.py`) ?? byUri.get(`${base}/__init__.py`) ?? null;
      } else out = pySuffix.get(spec) ?? null;
    } else {
      const bases: string[] = [];
      if (spec.startsWith(".")) bases.push(posix.normalize(posix.join(posix.dirname(fromUri), spec)));
      else if (/^[@~]\//.test(spec)) bases.push(`src/${spec.slice(2)}`, spec.slice(2));
      for (const base of bases) {
        const stem = base.replace(/\.(m|c)?jsx?$/, "");
        const candidates = [base, ...TS_EXTS.map((e) => stem + e), ...TS_EXTS.map((e) => `${base}/index${e}`)];
        out = candidates.map((c) => byUri.get(c)).find(Boolean) ?? null;
        if (out) break;
      }
    }
    moduleCache.set(key, out);
    return out;
  };

  const parse = (r: RefRow): ImportBinding[] => (r.bindings ? (JSON.parse(r.bindings) as ImportBinding[]) : []);

  /** What a local name in a file refers to: a symbol defined there, or an import. */
  const resolveLocal = (sourceId: string, local: string, depth: number): Target | null => {
    if (syms.get(sourceId)?.has(local)) return { sourceId, qname: local };
    for (const r of bySource.get(sourceId) ?? []) {
      if (r.kind !== "import") continue;
      const b = parse(r).find((x) => x.local === local);
      if (!b) continue;
      const mod = resolveModule(sourceId, r.to_name);
      if (!mod) return null;
      if (b.imported === "*") return { sourceId: mod, module: true };
      const t = resolveExport(mod, b.imported, depth + 1);
      if (t) return t;
      // Python `from pkg import submodule`
      if (PY.test(uriOf.get(sourceId)!)) {
        const sub = resolveModule(sourceId, r.to_name.endsWith(".") ? r.to_name + b.imported : `${r.to_name}.${b.imported}`);
        if (sub) return { sourceId: sub, module: true };
      }
      return null;
    }
    return null;
  };

  /** Follow an exported name of a module through default exports, re-exports and `export *`. */
  const resolveExport = (sourceId: string, name: string, depth: number): Target | null => {
    if (depth > 5) return null;
    const own = bySource.get(sourceId) ?? [];
    for (const r of own) {
      if (r.kind !== "export") continue;
      for (const b of parse(r)) {
        if (!r.to_name && b.imported === name) return resolveLocal(sourceId, b.local, depth);
        if (r.to_name && b.local === name && b.imported !== "*") {
          const mod = resolveModule(sourceId, r.to_name);
          return mod ? resolveExport(mod, b.imported, depth + 1) : null;
        }
      }
    }
    if (name !== "default") {
      if (syms.get(sourceId)?.has(name)) return { sourceId, qname: name };
      // Names a module imports are importable from it too (Python __init__, TS `import x; export { x }` handled above).
      if (PY.test(uriOf.get(sourceId)!)) {
        const t = resolveLocal(sourceId, name, depth + 1);
        if (t) return t;
      }
      for (const r of own) {
        if (r.kind === "export" && r.to_name && parse(r).some((b) => b.local === "*")) {
          const mod = resolveModule(sourceId, r.to_name);
          const t = mod && resolveExport(mod, name, depth + 1);
          if (t) return t;
        }
      }
    }
    return null;
  };

  const member = (t: Target | null, name: string): Target | null => {
    if (!t) return null;
    if ("module" in t) return resolveExport(t.sourceId, name, 1);
    const kind = syms.get(t.sourceId)?.get(t.qname);
    if (kind === "class" && syms.get(t.sourceId)?.has(`${t.qname}.${name}`)) return { sourceId: t.sourceId, qname: `${t.qname}.${name}` };
    return null;
  };

  const updates: [string | null, string | null, number][] = [];
  let resolved = 0;
  let total = 0;
  for (const r of refs) {
    let t: Target | null = null;
    if (r.kind === "import" || (r.kind === "export" && r.to_name)) {
      const mod = resolveModule(r.source_id, r.to_name);
      t = mod ? { sourceId: mod, module: true } : null;
    } else if (r.kind === "call") {
      total++;
      const q = r.qualifier;
      if (q === "this" || q === "self" || q === "cls") {
        const cls = r.from_qname.includes(".") ? r.from_qname.slice(0, r.from_qname.lastIndexOf(".")) : "";
        t = cls && syms.get(r.source_id)?.has(`${cls}.${r.to_name}`) ? { sourceId: r.source_id, qname: `${cls}.${r.to_name}` } : null;
      } else if (q) t = member(resolveLocal(r.source_id, q, 0), r.to_name);
      else {
        t = resolveLocal(r.source_id, r.to_name, 0);
        if (t && "module" in t) t = null;
      }
      if (t) resolved++;
    }
    updates.push([t?.sourceId ?? null, t && !("module" in t) ? t.qname : null, r.rowid]);
  }
  tx(app.db, () => {
    const st = app.db.prepare("update code_refs set to_source_id = ?, to_qname = ? where rowid = ?");
    for (const u of updates) st.run(...u);
  });
  return { resolved, total };
}

export type SymbolRelations = {
  callers: { sourceId: string; uri: string; fromQname: string; line: number }[];
  callees: { sourceId: string | null; uri: string | null; qname: string | null; name: string; line: number }[];
};

/** Resolved callers and all callees of one symbol, for the source viewer. */
export function symbolRelations(app: App, sourceId: string, qname: string): SymbolRelations {
  const callers = all<{ sourceId: string; uri: string; fromQname: string; line: number }>(
    app.db,
    `select r.source_id as sourceId, s.uri, r.from_qname as fromQname, r.line from code_refs r join sources s on s.id = r.source_id
     where r.to_source_id = ? and r.to_qname = ? and r.kind = 'call' and s.deleted_at is null order by s.uri, r.line limit 200`,
    sourceId,
    qname,
  );
  const callees = all<{ sourceId: string | null; uri: string | null; qname: string | null; name: string; qualifier: string | null; line: number }>(
    app.db,
    `select r.to_source_id as sourceId, t.uri, r.to_qname as qname, r.to_name as name, r.qualifier, r.line from code_refs r left join sources t on t.id = r.to_source_id
     where r.source_id = ? and r.from_qname = ? and r.kind = 'call' order by (r.to_qname is null), r.line`,
    sourceId,
    qname,
  ).map((c) => ({ sourceId: c.sourceId, uri: c.uri, qname: c.qname, name: c.qualifier ? `${c.qualifier}.${c.name}` : c.name, line: c.line }));
  return { callers, callees };
}
