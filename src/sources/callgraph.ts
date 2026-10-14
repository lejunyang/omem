import { posix } from "node:path";
import type { App } from "../core/app.ts";
import { all, tx } from "../core/db.ts";
import type { ImportBinding } from "./code.ts";
import { sourceText } from "./store.ts";

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
/** Languages whose names resolve by package / module rather than by file imports. Java and Kotlin share one namespace. */
const PKG_LANG: Record<string, "go" | "rust" | "jvm" | "swift"> = { ".go": "go", ".rs": "rust", ".java": "jvm", ".kt": "jvm", ".kts": "jvm", ".swift": "swift" };
const pkgLang = (uri: string) => PKG_LANG[posix.extname(uri).toLowerCase()];
/** Languages resolved by name with imports as hints (see nameResolver). Extensions of one family see each other. */
const NAME_FAMILY: Record<string, string> = Object.fromEntries(
  Object.entries({
    c: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm"],
    cs: [".cs"],
    php: [".php"],
    ruby: [".rb"],
    scala: [".scala", ".sc"],
    dart: [".dart"],
    lua: [".lua"],
    zig: [".zig"],
    elixir: [".ex", ".exs"],
    ocaml: [".ml", ".mli"],
    rescript: [".res", ".resi"],
    solidity: [".sol"],
    bash: [".sh", ".bash"],
    elisp: [".el"],
  }).flatMap(([fam, exts]) => exts.map((e) => [e, fam])),
);
const nameFamily = (uri: string) => NAME_FAMILY[posix.extname(uri).toLowerCase()];

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

  const pkg = packageResolver(files, syms, bySource, parse, (id) => sourceText(app, id));
  const byName = nameResolver(files, syms, bySource, parse);

  const updates: [string | null, string | null, number][] = [];
  let resolved = 0;
  let total = 0;
  for (const r of refs) {
    let t: Target | null = null;
    const lang = pkgLang(uriOf.get(r.source_id)!);
    const family = lang ? undefined : nameFamily(uriOf.get(r.source_id)!);
    if (family) {
      if (r.kind === "call") {
        total++;
        t = byName.call(r);
        if (t) resolved++;
      } else if (r.kind === "import") {
        const f = byName.importFiles(r.source_id, r.to_name);
        t = f.length === 1 ? { sourceId: f[0], module: true } : null;
      }
    } else if (lang) {
      if (r.kind === "call") {
        total++;
        t = pkg.call(r);
        if (t) resolved++;
      } else if (r.kind === "import") t = pkg.importTarget(r);
    } else if (r.kind === "import" || (r.kind === "export" && r.to_name)) {
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

/**
 * Go, Rust, Java/Kotlin and Swift: names are visible by package or module, not
 * per file. A call resolves when exactly one definition fits, searching in
 * order: the enclosing type (implicit this/self), the same file, the
 * explicitly imported module or type, then the same package (directory) — for
 * Swift the whole module (all Swift files of the space).
 */
function packageResolver(
  files: { id: string; uri: string }[],
  syms: Map<string, Map<string, string>>,
  bySource: Map<string, RefRow[]>,
  parse: (r: RefRow) => ImportBinding[],
  readText: (id: string) => string,
) {
  const uriOf = new Map(files.map((f) => [f.id, f.uri]));
  // Rust workspace crates: `use other_crate::x` → <crate dir>/src/lib.rs (name from Cargo.toml).
  const crates = new Map<string, string>();
  for (const f of files) {
    if (posix.basename(f.uri) !== "Cargo.toml") continue;
    const m = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(readText(f.id));
    if (m) crates.set(m[1].replace(/-/g, "_"), posix.join(posix.dirname(f.uri), "src"));
  }
  const byDir = new Map<string, string[]>(); // `${lang}|${dir}` → files
  const byLang = new Map<string, string[]>();
  for (const f of files) {
    const lang = pkgLang(f.uri);
    if (!lang) continue;
    const key = `${lang}|${posix.dirname(f.uri)}`;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(f.id);
    if (!byLang.has(lang)) byLang.set(lang, []);
    byLang.get(lang)!.push(f.id);
  }
  const idOfUri = new Map(files.map((f) => [f.uri, f.id]));
  const dirsCache = new Map<string, string[]>();
  const dirsOf = (lang: string) => {
    if (!dirsCache.has(lang)) dirsCache.set(lang, [...byDir.keys()].filter((k) => k.startsWith(lang + "|")).map((k) => k.slice(lang.length + 1)));
    return dirsCache.get(lang)!;
  };
  const pkgCache = new Map<string, string[]>();
  const has = (id: string, qname: string) => !!syms.get(id)?.has(qname);
  /** The single file among `ids` defining qname (null when none or ambiguous). */
  const unique = (ids: string[], qname: string): Target | null => {
    const hits = ids.filter((id) => has(id, qname));
    return hits.length === 1 ? { sourceId: hits[0], qname } : null;
  };
  /** JVM package of a directory: the path below the last java/ or kotlin/ source root. */
  const jvmPackage = (dir: string) => /(?:^|\/)(?:java|kotlin)\/(.+)$/.exec(dir)?.[1] ?? dir;
  const jvmByPackage = new Map<string, string[]>();
  for (const id of byLang.get("jvm") ?? []) {
    const key = jvmPackage(posix.dirname(uriOf.get(id)!));
    if (!jvmByPackage.has(key)) jvmByPackage.set(key, []);
    jvmByPackage.get(key)!.push(id);
  }
  const samePackage = (id: string) => {
    const uri = uriOf.get(id)!;
    const lang = pkgLang(uri)!;
    if (lang === "swift") return byLang.get(lang) ?? [];
    if (lang === "jvm") return jvmByPackage.get(jvmPackage(posix.dirname(uri))) ?? [];
    return byDir.get(`${lang}|${posix.dirname(uri)}`) ?? [];
  };

  /** Directory (files) that a dotted package or Go import path names: the longest matching path suffix wins. */
  const packageFiles = (lang: string, path: string): string[] => {
    const key = `${lang}|${path}`;
    if (!pkgCache.has(key)) pkgCache.set(key, packageFilesUncached(lang, path));
    return pkgCache.get(key)!;
  };
  const packageFilesUncached = (lang: string, path: string): string[] => {
    const want = path.split(/[./]/).filter(Boolean);
    let best: string[] = [];
    let bestLen = 0;
    for (const dir of dirsOf(lang)) {
      const have = dir.split("/");
      let n = 0;
      while (n < want.length && n < have.length && want[want.length - 1 - n] === have[have.length - 1 - n]) n++;
      if (!n) continue;
      // The same package can live in several roots (src/main/java and src/test/java): equal matches add up.
      if (n > bestLen) [best, bestLen] = [[...byDir.get(`${lang}|${dir}`)!], n];
      else if (n === bestLen) best.push(...byDir.get(`${lang}|${dir}`)!);
    }
    return best;
  };

  /** Rust module path (`crate::a::b`, `self::x`, `super::y`, `a::b`) → the file implementing it. */
  const rustModuleFile = (fromId: string, path: string): string | null => {
    const fromUri = uriOf.get(fromId)!;
    const segs = path.split("::").filter(Boolean);
    const isRoot = (u: string) => /(^|\/)(lib|main|mod)\.rs$/.test(u);
    let dir = isRoot(fromUri) ? posix.dirname(fromUri) : posix.join(posix.dirname(fromUri), posix.basename(fromUri, ".rs"));
    if (segs[0] === "crate") {
      // crate root: nearest ancestor holding lib.rs or main.rs
      let d = posix.dirname(fromUri);
      while (d !== "." && d !== "/" && !idOfUri.has(posix.join(d, "lib.rs")) && !idOfUri.has(posix.join(d, "main.rs"))) d = posix.dirname(d);
      dir = d;
      segs.shift();
    } else if (segs[0] === "self") segs.shift();
    else if (crates.has(segs[0])) {
      dir = crates.get(segs.shift()!)!;
      if (!segs.length) return idOfUri.get(posix.join(dir, "lib.rs")) ?? null;
    }
    while (segs[0] === "super") {
      dir = posix.dirname(dir);
      segs.shift();
    }
    if (!segs.length) return null;
    const rel = posix.join(dir, ...segs);
    const byUri = (u: string) => idOfUri.get(posix.normalize(u)) ?? null;
    return byUri(`${rel}.rs`) ?? byUri(`${rel}/mod.rs`);
  };

  /** A name brought in by an import of this file: the definition it names, or a module/package. */
  const imported = (fromId: string, local: string, depth = 0): { files: string[]; qname?: string } | null => {
    const lang = pkgLang(uriOf.get(fromId)!)!;
    for (const r of bySource.get(fromId) ?? []) {
      if (r.kind !== "import") continue;
      const b = parse(r).find((x) => x.local === local);
      if (!b) continue;
      if (lang === "go") return { files: packageFiles("go", r.to_name) };
      if (lang === "swift") return { files: byLang.get("swift") ?? [] };
      if (lang === "rust") {
        const mod = rustModuleFile(fromId, r.to_name);
        if (b.imported === "*") return mod ? { files: [mod] } : null;
        const sub = rustModuleFile(fromId, `${r.to_name}::${b.imported}`);
        if (sub) return { files: [sub] };
        if (!mod) return null;
        // `pub use` re-exports: follow the module's own import of that name.
        if (!has(mod, b.imported) && depth < 4) return imported(mod, b.imported, depth + 1) ?? { files: [mod], qname: b.imported };
        return { files: [mod], qname: b.imported };
      }
      // jvm: `import a.b.C` (class), `import a.b.C.m` (static member), `import a.b.f` (Kotlin top-level fun)
      const inPkg = packageFiles("jvm", r.to_name);
      if (inPkg.some((id) => has(id, b.imported))) return { files: inPkg, qname: b.imported };
      const cls = r.to_name.split(".").pop()!;
      const outer = packageFiles("jvm", r.to_name.split(".").slice(0, -1).join("."));
      if (outer.some((id) => has(id, `${cls}.${b.imported}`))) return { files: outer, qname: `${cls}.${b.imported}` };
      return { files: byLang.get("jvm") ?? [], qname: b.imported };
    }
    return null;
  };
  const wildcardPackages = (fromId: string) =>
    (bySource.get(fromId) ?? []).filter((r) => r.kind === "import" && parse(r).some((b) => b.local === "*")).flatMap((r) => packageFiles("jvm", r.to_name));

  /** Where a type name visible in this file is defined. */
  const typeTarget = (fromId: string, name: string): { files: string[]; qname: string } | null => {
    if (has(fromId, name)) return { files: [fromId], qname: name };
    const imp = imported(fromId, name);
    if (imp?.qname) return { files: imp.files, qname: imp.qname };
    const pk = samePackage(fromId);
    if (pk.some((id) => has(id, name))) return { files: pk, qname: name };
    return null;
  };

  const call = (r: RefRow): Target | null => {
    const from = r.source_id;
    const lang = pkgLang(uriOf.get(from)!)!;
    const n = r.to_name;
    const q = r.qualifier;
    const owner = r.from_qname;
    const enclosing: string[] = [];
    for (let parts = owner.split(".").slice(0, -1); parts.length; parts.pop()) enclosing.push(parts.join("."));
    if (q === "self" || q === "this") {
      for (const cls of enclosing) {
        const t = unique([from], `${cls}.${n}`) ?? unique(samePackage(from), `${cls}.${n}`);
        if (t) return t;
      }
      return null;
    }
    if (!q) {
      if (lang !== "go" && lang !== "rust")
        for (const cls of enclosing) {
          const t = unique([from], `${cls}.${n}`) ?? (lang === "swift" ? unique(samePackage(from), `${cls}.${n}`) : null);
          if (t) return t;
        }
      if (has(from, n)) return { sourceId: from, qname: n };
      const imp = imported(from, n);
      if (imp) return unique(imp.files, imp.qname ?? n);
      if (lang === "rust") {
        // Rust needs a `use` for anything outside the file; `use path::*` brings a module's items.
        const globs = (bySource.get(from) ?? []).filter((x) => x.kind === "import" && parse(x).some((b) => b.local === "*")).map((x) => rustModuleFile(from, x.to_name)).filter((x): x is string => !!x);
        return unique(globs, n);
      }
      return unique(samePackage(from), n) ?? (lang === "jvm" ? unique(wildcardPackages(from), n) : null);
    }
    // Qualified: Rust paths and modules, an imported package, or a type with a static / associated member.
    if (lang === "rust") {
      if (has(from, `${q}.${n}`)) return { sourceId: from, qname: `${q}.${n}` }; // inline `mod` or impl in this file
      const head = q.split("::")[0];
      const imp = q.includes("::") ? null : imported(from, head);
      if (imp && !imp.qname) return unique(imp.files, n);
      if (imp?.qname) return unique(imp.files, `${imp.qname}.${n}`);
      const mod = rustModuleFile(from, q);
      if (mod) return unique([mod], n);
      const [m, last] = [q.slice(0, q.lastIndexOf("::")), q.slice(q.lastIndexOf("::") + 2)];
      const mf = m ? rustModuleFile(from, m) : null;
      return mf ? unique([mf], `${last}.${n}`) : null;
    }
    const imp = imported(from, q);
    if (imp && !imp.qname) return unique(imp.files, n); // Go package / Swift module
    const type = imp?.qname ? { files: imp.files, qname: imp.qname } : typeTarget(from, q);
    return type ? unique(type.files, `${type.qname}.${n}`) : null;
  };

  const importTarget = (r: RefRow): Target | null => {
    const lang = pkgLang(uriOf.get(r.source_id)!)!;
    if (lang === "rust") {
      const f = rustModuleFile(r.source_id, r.to_name);
      return f ? { sourceId: f, module: true } : null;
    }
    if (lang === "jvm") {
      const b = parse(r)[0];
      const t = b && b.imported !== "*" ? unique(packageFiles("jvm", r.to_name), b.imported) : null;
      return t;
    }
    return null;
  };

  return { call, importTarget };
}

/**
 * C/C++/Objective-C, C#, PHP, Ruby, Scala, Dart, Lua, Zig, Elixir, OCaml,
 * ReScript, Solidity, Bash, Emacs Lisp: these share one namespace per project
 * in practice (linker, autoloader, require, module = file), so a call
 * resolves by name when exactly one definition fits. Imports narrow the
 * search first: `import x as u` + `u.f()`, `require "a/b"`, `#include "b.h"`
 * (and its b.c / b.cpp), `open Store` (OCaml/ReScript module = file).
 * Order: enclosing type (this/self and implicit), same file, imported files,
 * `Type.member`, then a unique free definition anywhere in the family.
 */
function nameResolver(files: { id: string; uri: string }[], syms: Map<string, Map<string, string>>, bySource: Map<string, RefRow[]>, parse: (r: RefRow) => ImportBinding[]) {
  const uriOf = new Map(files.map((f) => [f.id, f.uri]));
  const lastSeg = (q: string) => q.slice(q.lastIndexOf(".") + 1);
  const parentOf = (q: string) => (q.includes(".") ? q.slice(0, q.lastIndexOf(".")) : "");
  type Hit = { sourceId: string; qname: string };
  const famFiles = new Map<string, string[]>();
  const free = new Map<string, Hit[]>(); // `${fam}|${name}`
  const member = new Map<string, Hit[]>(); // `${fam}|${Type}.${name}`
  const exact = new Map<string, Hit[]>(); // `${fam}|${qname}`
  const push = (m: Map<string, Hit[]>, k: string, h: Hit) => (m.get(k) ?? m.set(k, []).get(k)!).push(h);
  for (const f of files) {
    const fam = nameFamily(f.uri);
    if (!fam) continue;
    (famFiles.get(fam) ?? famFiles.set(fam, []).get(fam)!).push(f.id);
    const table = syms.get(f.id);
    if (!table) continue;
    for (const [qname] of table) {
      const parent = parentOf(qname);
      const parentKind = parent ? table.get(parent) : undefined;
      if (!parent || parentKind === "namespace") push(free, `${fam}|${lastSeg(qname)}`, { sourceId: f.id, qname });
      if (parent) push(member, `${fam}|${lastSeg(parent)}.${lastSeg(qname)}`, { sourceId: f.id, qname });
      push(exact, `${fam}|${qname}`, { sourceId: f.id, qname });
    }
  }
  const one = (hits: Hit[] | undefined): Target | null => {
    if (!hits?.length) return null;
    const uniq = new Map(hits.map((h) => [`${h.sourceId}|${h.qname}`, h]));
    return uniq.size === 1 ? [...uniq.values()][0] : null;
  };
  /** Any symbol named `name` (or `Type.name`) in these files. */
  /** Callable without a receiver: top level, or inside a namespace / module (not a class member). */
  const freeIn = (id: string, qname: string) => {
    const parent = parentOf(qname);
    if (!parent) return true;
    const kind = syms.get(id)?.get(parent);
    // Lua module tables (`M.f`) have no symbol of their own.
    return kind === "namespace" || kind === "module" || (kind === undefined && nameFamily(uriOf.get(id)!) === "lua");
  };
  /** C++ / C# namespaces need qualification or an enclosing namespace: `fmt::printf` is not `printf`. */
  const visibleFrom = (fam: string, fromQname: string, hit: Hit) => {
    if (fam !== "c" && fam !== "cs") return true;
    const ns = parentOf(hit.qname);
    return !ns || fromQname === ns || fromQname.startsWith(`${ns}.`);
  };
  const inFiles = (ids: string[], name: string, freeFrom?: { fam: string; from: string }): Target | null => {
    const hits: Hit[] = [];
    for (const id of ids)
      for (const [q] of syms.get(id) ?? [])
        if ((q === name || lastSeg(q) === name) && (!freeFrom || (freeIn(id, q) && visibleFrom(freeFrom.fam, freeFrom.from, { sourceId: id, qname: q })))) hits.push({ sourceId: id, qname: q });
    return one(hits);
  };

  const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
  const stem = (uri: string) => uri.replace(/\.[^./]+$/, "");
  const fileCache = new Map<string, string[]>();
  /** Files an import spec names: a relative or suffix path, or a dotted / `::` / `\` module path. */
  const importFiles = (fromId: string, spec: string): string[] => {
    const fromUri = uriOf.get(fromId)!;
    const fam = nameFamily(fromUri)!;
    const key = `${fromId}|${spec}`;
    if (fileCache.has(key)) return fileCache.get(key)!;
    const pool = famFiles.get(fam) ?? [];
    const s = spec.replace(/^package:[^/]+\//, "").replace(/^\.\//, "");
    let out: string[] = [];
    const hasExt = posix.extname(s).toLowerCase() in NAME_FAMILY;
    if (hasExt || s.includes("/")) {
      const rel = posix.normalize(posix.join(posix.dirname(fromUri), s));
      const withExt = (u: string) => (hasExt ? [u] : [u, ...[".rb", ".lua", ".sh", ".el", ".php", ".dart"].map((e) => u + e)]);
      out = pool.filter((id) => withExt(rel).includes(uriOf.get(id)!));
      if (!out.length) out = pool.filter((id) => withExt(s).some((c) => uriOf.get(id) === c || uriOf.get(id)!.endsWith(`/${c}`)));
    } else {
      const want = norm(s.replace(/::|\\|\./g, "/"));
      out = pool.filter((id) => {
        const st = norm(stem(uriOf.get(id)!));
        return st === want || st.endsWith(`/${want}`);
      });
    }
    // A C/C++ header brings its implementation file along.
    if (fam === "c")
      for (const id of [...out]) {
        const st = stem(uriOf.get(id)!);
        for (const other of pool) if (other !== id && stem(uriOf.get(other)!) === st) out.push(other);
      }
    fileCache.set(key, out);
    return out;
  };

  const call = (r: RefRow): Target | null => {
    const from = r.source_id;
    const fam = nameFamily(uriOf.get(from)!)!;
    const n = r.to_name;
    const q = r.qualifier;
    const enclosing: string[] = [];
    for (let parts = r.from_qname.split(".").slice(0, -1); parts.length; parts.pop()) enclosing.push(parts.join("."));
    const imports = (bySource.get(from) ?? []).filter((x) => x.kind === "import");
    if (q === "self") {
      for (const cls of enclosing) {
        if (syms.get(from)?.has(`${cls}.${n}`)) return { sourceId: from, qname: `${cls}.${n}` };
        const t = one(exact.get(`${fam}|${cls}.${n}`)) ?? one(member.get(`${fam}|${lastSeg(cls)}.${n}`));
        if (t) return t;
      }
      return null;
    }
    if (!q) {
      for (const cls of enclosing) if (syms.get(from)?.has(`${cls}.${n}`)) return { sourceId: from, qname: `${cls}.${n}` };
      // Implicit this across files: C++ out-of-line definitions, reopened Ruby classes, partial classes.
      for (const cls of enclosing) {
        const t = one(exact.get(`${fam}|${cls}.${n}`)) ?? one(member.get(`${fam}|${lastSeg(cls)}.${n}`));
        if (t) return t;
      }
      const scope = { fam, from: r.from_qname };
      const local = inFiles([from], n, scope);
      if (local) return local;
      for (const imp of imports) {
        const b = parse(imp).find((x) => x.local === n);
        if (b) return inFiles(importFiles(from, imp.to_name), b.imported === "*" ? n : b.imported, scope) ?? one(free.get(`${fam}|${b.imported}`));
      }
      // Imports that bring names into scope (#include, require, open, import without `as`); aliases do not.
      const viaImports = imports.flatMap((imp) => (parse(imp).every((b) => b.local === "*") ? importFiles(from, imp.to_name) : []));
      return (viaImports.length ? inFiles(viaImports, n, scope) : null) ?? one(free.get(`${fam}|${n}`)?.filter((h) => visibleFrom(fam, r.from_qname, h)));
    }
    // Qualified: an import alias (`u.fmt`, `db.open`), an imported type, a module file (OCaml), or Type.member.
    for (const imp of imports) {
      const b = parse(imp).find((x) => x.local === q);
      if (!b) continue;
      if (b.imported === "*") return inFiles(importFiles(from, imp.to_name), n);
      return one(member.get(`${fam}|${b.imported}.${n}`));
    }
    const t = one(member.get(`${fam}|${q}.${n}`));
    if (t) return t;
    if (fam === "ocaml" || fam === "rescript") {
      const mod = (famFiles.get(fam) ?? []).filter((id) => norm(posix.basename(stem(uriOf.get(id)!))) === norm(q));
      return mod.length ? inFiles(mod, n) : null;
    }
    return null;
  };

  return { call, importFiles };
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
