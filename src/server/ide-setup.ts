import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { compareVersions } from "./ide-locale.ts";

/**
 * What omem puts into the web VS Code's server before serve-web starts (docs/v2/ide.md):
 *
 * - the repo's own VS Code extension (`vscode/`), built from source and kept at the repo's version;
 * - settings the owner already has on this machine (Remote-SSH's machine settings, else the desktop
 *   VS Code's user settings), only when the web IDE has none of its own yet;
 * - with `ide.web.reuseExtensions`, copies of the extensions Remote-SSH (or the desktop VS Code)
 *   installed on this machine that fit this platform and the server's version, each once.
 *
 * Extensions are registered the way VS Code itself records them (`extensions.json` in the extensions
 * directory), so serve-web picks them up when it starts. Nothing here touches the sources.
 */

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** JSON with comments and trailing commas (VS Code's settings.json, argv.json); null when it does not parse. */
export function readJsonc(file: string): unknown {
  try {
    // Two passes, strings left alone in both: comments out, then commas before a closing bracket.
    const pass = (text: string, other: (text: string, i: number, out: string[]) => number) => {
      const out: string[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') {
          let j = i + 1;
          while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
          out.push(text.slice(i, j + 1));
          i = j;
        } else i = other(text, i, out);
      }
      return out.join("");
    };
    const bare = pass(readFileSync(file, "utf8").replace(/^﻿/, ""), (t, i, out) => {
      if (t[i] === "/" && t[i + 1] === "/") {
        while (i < t.length && t[i] !== "\n") i++;
        out.push("\n");
      } else if (t[i] === "/" && t[i + 1] === "*") {
        const end = t.indexOf("*/", i + 2);
        return end < 0 ? t.length : end + 1;
      } else out.push(t[i]);
      return i;
    });
    return JSON.parse(
      pass(bare, (t, i, out) => {
        if (t[i] !== "," || !/^\s*[}\]]/.test(t.slice(i + 1, i + 200))) out.push(t[i]);
        return i;
      }),
    );
  } catch {
    return null;
  }
}

export const OMEM_EXTENSION = "omem.omem-vscode";

/** This platform as VS Code names target platforms (`linux-x64`, `win32-x64`, `darwin-arm64`). */
export const targetPlatform = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

/** Whether an extension's `engines.vscode` (`^1.90.0`, `>=1.80.0`, `*`) admits a server version. */
export function engineAllows(engine: string | undefined, server: string) {
  if (!engine || engine.trim() === "*") return true;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(engine);
  if (!m) return false;
  return compareVersions(server.replace(/-.*/, ""), `${m[1]}.${m[2]}.${m[3]}`) >= 0;
}

type Entry = { identifier: { id: string; uuid?: string }; version: string; location?: unknown; relativeLocation?: string; metadata?: Record<string, unknown> };

/** The entries of an extensions directory's `extensions.json` (empty when there is none). */
export function listedExtensions(extDir: string): Entry[] {
  const list = readJson(join(extDir, "extensions.json"));
  return Array.isArray(list) ? list.filter((e) => typeof e?.identifier?.id === "string" && typeof e?.version === "string") : [];
}

/** A local path as the URI path VS Code stores (`/e:/…` for a Windows drive). */
const uriPath = (p: string) => {
  const s = p.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(s) ? `/${s[0].toLowerCase()}${s.slice(1)}` : s;
};

/**
 * Replace the entries for these ids with the given ones (null: just remove), written atomically.
 * VS Code's scan caches are dropped so the next start reads the extensions again.
 */
function register(extDir: string, serverData: string, changes: Map<string, Entry | null>) {
  // No extensions.json yet: the folders already there are kept as VS Code would find them.
  const current = existsSync(join(extDir, "extensions.json"))
    ? listedExtensions(extDir)
    : readdirSync(extDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .flatMap((d) => {
          const pkg = readJson(join(extDir, d.name, "package.json"));
          return pkg?.publisher && pkg?.name && pkg?.version ? [entryFor(extDir, d.name, `${pkg.publisher}.${pkg.name}`.toLowerCase(), String(pkg.version), {})] : [];
        });
  const kept = current.filter((e) => !changes.has(e.identifier.id.toLowerCase()));
  const added = [...changes.values()].filter((e): e is Entry => !!e);
  const file = join(extDir, "extensions.json");
  writeFileSync(`${file}.omem-tmp`, JSON.stringify([...kept, ...added]));
  renameSync(`${file}.omem-tmp`, file);
  const cache = join(serverData, "data", "CachedProfilesData");
  if (existsSync(cache))
    for (const profile of readdirSync(cache)) for (const f of readdirSync(join(cache, profile))) if (/^extensions\.user/.test(f)) rmSync(join(cache, profile, f), { force: true });
}

const entryFor = (extDir: string, folder: string, id: string, version: string, metadata: Record<string, unknown>): Entry => ({
  identifier: { id },
  version,
  location: { $mid: 1, path: uriPath(join(extDir, folder)), scheme: "file" },
  relativeLocation: folder,
  metadata: { installedTimestamp: Date.now(), targetPlatform: "undefined", isApplicationScoped: false, isMachineScoped: false, updated: false, isPreReleaseVersion: false, hasPreReleaseVersion: false, private: false, ...metadata },
});

// ---- omem's own extension ---------------------------------------------------------------------

/** The repo's `vscode/` folder: next to `src/` (run from source) or two levels above `dist/src/`. */
export function findExtensionSource(from = import.meta.dirname): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++, dir = dirname(dir)) {
    const pkg = readJson(join(dir, "vscode", "package.json"));
    if (pkg?.name === "omem-vscode" && existsSync(join(dir, "vscode", "src"))) return join(dir, "vscode");
    if (dirname(dir) === dir) break;
  }
  return null;
}

const filesUnder = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)])).sort() : [];

/** A digest of what the installed copy is built from: the manifest, readme, media and sources. */
export function extensionDigest(source: string) {
  const h = createHash("sha256").update("omem-vscode-1");
  for (const f of [join(source, "package.json"), join(source, "README.md"), ...filesUnder(join(source, "media")), ...filesUnder(join(source, "src"))])
    if (existsSync(f)) h.update(relative(source, f).replace(/\\/g, "/")).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** TypeScript compiles a file to what `tsc -p vscode` would emit (CommonJS), without type checking. */
export type Transpile = (code: string, fileName: string) => string;

export async function typescriptTranspiler(): Promise<Transpile | null> {
  try {
    const ts = ((await import("typescript")) as any).default ?? (await import("typescript"));
    return (code, fileName) => ts.transpileModule(code, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, sourceMap: false } }).outputText;
  } catch {
    return null;
  }
}

export type ExtensionInstall = { status: "installed" | "current" | "unavailable"; version?: string; digest?: string; reason?: string };

/**
 * Install or refresh omem's extension in the web IDE's extensions directory: a folder
 * `omem.omem-vscode-<version>` with the manifest, readme, media and the compiled sources, stamped
 * with the digest of what it came from. The same digest already there: nothing to do. Without the
 * TypeScript compiler, a built `vscode/out` is used as it is.
 */
export function installOmemExtension(opts: { source: string | null; extDir: string; serverData: string; transpile: Transpile | null }): ExtensionInstall {
  const { source, extDir, serverData, transpile } = opts;
  if (!source) return { status: "unavailable", reason: "找不到仓库里的 vscode/ 插件源码" };
  const pkg = readJson(join(source, "package.json"));
  const version = String(pkg?.version ?? "0.0.0");
  const digest = extensionDigest(source);
  const folder = `${OMEM_EXTENSION}-${version}`;
  const target = join(extDir, folder);
  const listed = listedExtensions(extDir).some((e) => e.identifier.id.toLowerCase() === OMEM_EXTENSION && e.version === version);
  if (listed && readJson(join(target, ".omem-source.json"))?.digest === digest && existsSync(join(target, "out", "extension.js"))) return { status: "current", version, digest };

  const built = existsSync(join(source, "out", "extension.js"));
  if (!transpile && !built) return { status: "unavailable", version, reason: "没有 TypeScript 编译器，vscode/out 也没构建（pnpm install && pnpm --filter omem-vscode run build）" };
  mkdirSync(extDir, { recursive: true });
  const staging = join(extDir, `.${folder}.omem-staging`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "out"), { recursive: true });
  copyFileSync(join(source, "package.json"), join(staging, "package.json"));
  if (existsSync(join(source, "README.md"))) copyFileSync(join(source, "README.md"), join(staging, "README.md"));
  if (existsSync(join(source, "media"))) cpSync(join(source, "media"), join(staging, "media"), { recursive: true });
  if (transpile)
    for (const f of filesUnder(join(source, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
      const out = join(staging, "out", relative(join(source, "src"), f)).replace(/\.ts$/, ".js");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, transpile(readFileSync(f, "utf8"), f));
    }
  else for (const f of filesUnder(join(source, "out")).filter((f) => f.endsWith(".js"))) {
    const out = join(staging, "out", relative(join(source, "out"), f));
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(f, out);
  }
  writeFileSync(join(staging, ".omem-source.json"), JSON.stringify({ digest, builtAt: new Date().toISOString(), from: transpile ? "src" : "out" }));
  // Older versions of it go; this one replaces whatever was in its folder.
  for (const d of readdirSync(extDir)) if (d.toLowerCase().startsWith(`${OMEM_EXTENSION}-`)) rmSync(join(extDir, d), { recursive: true, force: true });
  renameSync(staging, target);
  register(extDir, serverData, new Map([[OMEM_EXTENSION, entryFor(extDir, folder, OMEM_EXTENSION, version, { source: "vsix", pinned: true })]]));
  return { status: "installed", version, digest };
}

// ---- configuration the owner already has on this machine --------------------------------------

/** The desktop VS Code's user folder on this platform. */
export function desktopUserDir(home = homedir(), platform = process.platform, env = process.env) {
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Code", "User");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User");
}

export type ReuseSource = { kind: "remote-ssh" | "desktop"; settings: string; extensions: string };

/** Where VS Code already keeps the owner's configuration on this machine, preferred first. */
export function reuseSources(home = homedir(), platform = process.platform, env = process.env): ReuseSource[] {
  return [
    ...[".vscode-server", ".vscode-server-insiders"].map((d) => ({ kind: "remote-ssh" as const, settings: join(home, d, "data", "Machine", "settings.json"), extensions: join(home, d, "extensions") })),
    { kind: "desktop" as const, settings: join(desktopUserDir(home, platform, env), "settings.json"), extensions: join(home, ".vscode", "extensions") },
  ];
}

/**
 * The web IDE's machine settings (`data/Machine/settings.json`, the "Remote" tab of its settings,
 * applied on the server for everything that is not application-wide): taken from the first source
 * that has settings, only when the web IDE has none yet. The omem extension's own settings are left
 * out: they say how that VS Code reaches omem, while in the web IDE the omem serving it answers.
 * The copy records where it came from.
 */
export function seedMachineSettings(serverData: string, sources: ReuseSource[]): { from: string; keys: number } | null {
  const target = join(serverData, "data", "Machine", "settings.json");
  if (existsSync(target)) return null;
  for (const s of sources) {
    const all = existsSync(s.settings) ? readJsonc(s.settings) : null;
    if (!all || typeof all !== "object" || Array.isArray(all)) continue;
    const kept = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("omem.")));
    if (!Object.keys(kept).length) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(kept, null, 2)}\n`);
    writeFileSync(join(dirname(target), ".omem-seeded.json"), JSON.stringify({ from: s.settings, keys: Object.keys(kept).length, at: new Date().toISOString() }));
    return { from: s.settings, keys: Object.keys(kept).length };
  }
  return null;
}

export type ReusableExtension = { id: string; version: string; dir: string; folder: string; platform: string; engine: string | null; fits: boolean; why?: string; entry: Entry };

/** The extensions a source directory lists, and whether each fits this platform and server version. */
export function reusableExtensions(extDir: string, serverVersion: string | null, platform = targetPlatform()): ReusableExtension[] {
  return listedExtensions(extDir).map((e) => {
    const folder = e.relativeLocation ?? (e.location as { path?: string } | undefined)?.path?.split("/").pop() ?? `${e.identifier.id}-${e.version}`;
    const dir = join(extDir, folder);
    const pkg = readJson(join(dir, "package.json"));
    const target = String(e.metadata?.targetPlatform ?? "undefined");
    const engine = (pkg?.engines?.vscode as string | undefined) ?? null;
    const id = e.identifier.id.toLowerCase();
    let why: string | undefined;
    if (!pkg) why = "目录不在了";
    else if (!["undefined", "universal", platform].includes(target)) why = `平台是 ${target}`;
    else if (!serverVersion) why = "还不知道服务端版本";
    else if (!engineAllows(engine ?? undefined, serverVersion)) why = `要求 VS Code ${engine}`;
    else if (id === OMEM_EXTENSION) why = "omem 自己装";
    return { id, version: e.version, dir, folder, platform: target, engine, fits: !why, why, entry: e };
  });
}

/**
 * Copy the extensions from the sources that fit and are not in the web IDE yet. Each id is taken
 * once (`ide/reused-extensions.json`): one the owner uninstalled in the web IDE stays uninstalled.
 */
export function reuseExtensions(opts: { extDir: string; serverData: string; record: string; sources: ReuseSource[]; serverVersion: string | null }) {
  const { extDir, serverData, record, sources, serverVersion } = opts;
  const done = new Set<string>((readJson(record) as string[] | null) ?? []);
  const have = new Set(listedExtensions(extDir).map((e) => e.identifier.id.toLowerCase()));
  const changes = new Map<string, Entry>();
  for (const s of sources)
    for (const x of reusableExtensions(s.extensions, serverVersion)) {
      if (!x.fits || have.has(x.id) || done.has(x.id) || changes.has(x.id)) continue;
      mkdirSync(extDir, { recursive: true });
      const staging = join(extDir, `.${x.folder}.omem-staging`);
      rmSync(staging, { recursive: true, force: true });
      try {
        cpSync(x.dir, staging, { recursive: true, dereference: true });
        rmSync(join(extDir, x.folder), { recursive: true, force: true });
        renameSync(staging, join(extDir, x.folder));
      } catch {
        rmSync(staging, { recursive: true, force: true });
        continue;
      }
      changes.set(x.id, { ...entryFor(extDir, x.folder, x.entry.identifier.id, x.version, {}), identifier: x.entry.identifier, metadata: { ...(x.entry.metadata ?? {}), installedTimestamp: Date.now() } });
      done.add(x.id);
    }
  if (changes.size) register(extDir, serverData, changes);
  if (changes.size || !existsSync(record)) writeFileSync(record, JSON.stringify([...done].sort()));
  return [...changes.values()].map((e) => `${e.identifier.id}@${e.version}`);
}
