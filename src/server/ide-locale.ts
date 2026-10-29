import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The web VS Code's interface language (docs/v2/ide.md).
 *
 * VS Code's interface strings are one array indexed by position (`out/nls.messages.json`, keys in
 * `out/nls.keys.json`), different in every build. For a browser that is not in English, serve-web's
 * page loads the translated array from Microsoft's CDN (`https://www.vscode-unpkg.net/nls/<commit>/
 * <version>/<locale>/nls.messages.js`). That array has to have exactly this build's positions; when
 * it does not (seen for 1.143 and 1.144: 26,299 and 27,686 entries against the server's 24,284 and
 * 25,233, because the newest language pack is many versions older), every menu entry, command and
 * tooltip shows some other string.
 *
 * So omem never lets the page load the CDN's array. It builds one itself the way VS Code builds the
 * server's own (`resolveNLSConfiguration`): for each key of this build, the language pack's
 * translation of that key, else the English string. A pack older or newer than the server then
 * leaves the strings it does not know in English instead of shifting all the others. With no pack
 * for the language installed, the page stays in English (VS Code offers to install one; after a
 * reload it is used).
 */

export type LanguagePack = { id: string; version: string; dir: string; languages: { id: string; main: string | null }[] };

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Numeric comparison of dotted versions (`1.131.2026090407`). */
export function compareVersions(a: string, b: string) {
  const x = a.split(/[.-]/).map((n) => Number(n) || 0);
  const y = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * Language packs installed in an extensions directory: the folders `extensions.json` lists (VS Code
 * keeps removed ones on disk until it cleans up, so a folder alone does not count), or every folder
 * when there is no such file.
 */
export function languagePacks(extDir: string): LanguagePack[] {
  if (!existsSync(extDir)) return [];
  const listed = readJson(join(extDir, "extensions.json"));
  const dirs: string[] = Array.isArray(listed)
    ? listed.map((e) => e?.relativeLocation ?? (typeof e?.location?.path === "string" ? e.location.path.split("/").pop() : null)).filter((d): d is string => !!d)
    : readdirSync(extDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const out: LanguagePack[] = [];
  for (const d of dirs) {
    const dir = join(extDir, d);
    const pkg = readJson(join(dir, "package.json"));
    const locs = pkg?.contributes?.localizations as { languageId?: string; translations?: { id?: string; path?: string }[] }[] | undefined;
    if (!pkg || !Array.isArray(locs) || !locs.length) continue;
    out.push({
      id: `${pkg.publisher}.${pkg.name}`.toLowerCase(),
      version: String(pkg.version ?? "0"),
      dir,
      languages: locs.filter((l) => l.languageId).map((l) => {
        const main = l.translations?.find((t) => t.id === "vscode")?.path;
        return { id: l.languageId!.toLowerCase(), main: main ? join(dir, main) : null };
      }),
    });
  }
  return out;
}

/** The pack for a locale (`zh-cn`): the newest installed one with the interface strings for it. */
export function packFor(extDir: string, locale: string) {
  const want = locale.toLowerCase();
  const found = languagePacks(extDir)
    .flatMap((p) => p.languages.filter((l) => l.id === want && l.main && existsSync(l.main)).map((l) => ({ pack: p, main: l.main! })))
    .sort((a, b) => compareVersions(b.pack.version, a.pack.version));
  return found[0] ?? null;
}

/**
 * This build's strings translated by key from a pack's `main.i18n.json`, English where the pack has
 * no translation. Null when the build's key and message files do not agree (then nothing is safe).
 */
export function translateMessages(serverDir: string, mainI18n: string): { messages: string[]; translated: number } | null {
  const keys = readJson(join(serverDir, "out", "nls.keys.json")) as [string, string[]][] | null;
  const english = readJson(join(serverDir, "out", "nls.messages.json")) as string[] | null;
  const pack = readJson(mainI18n)?.contents as Record<string, Record<string, string>> | undefined;
  if (!Array.isArray(keys) || !Array.isArray(english) || !pack) return null;
  const messages: string[] = [];
  let translated = 0;
  for (const [module, names] of keys)
    for (const name of names) {
      const t = pack[module]?.[name];
      if (typeof t === "string" && t) translated++;
      messages.push(typeof t === "string" && t ? t : english[messages.length]);
    }
  return messages.length === english.length ? { messages, translated } : null;
}

const COMMIT = /^[0-9a-f]{40}$/;
const LOCALE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/;

/**
 * The translated strings as the script the page loads (`globalThis._VSCODE_NLS_MESSAGES = …`), built
 * once per server build, language and pack version under `<ideRoot>/nls`. Null: stay in English.
 */
export function workbenchNls(ideRoot: string, commit: string, locale: string): { file: string; pack: string; translated: number; total: number } | null {
  locale = locale.toLowerCase();
  if (!COMMIT.test(commit) || !LOCALE.test(locale) || locale === "en" || locale.startsWith("en-")) return null;
  const serverDir = join(ideRoot, "cli", "serve-web", commit);
  const found = packFor(join(ideRoot, "server", "extensions"), locale);
  if (!found || !existsSync(serverDir)) return null;
  const dir = join(ideRoot, "nls", commit);
  const file = join(dir, `${locale}-${found.pack.id}-${found.pack.version}.js`);
  const meta = `${file}.json`;
  const known = readJson(meta) as { translated: number; total: number } | null;
  if (known && existsSync(file)) return { file, pack: `${found.pack.id}@${found.pack.version}`, ...known };
  const built = translateMessages(serverDir, found.main);
  if (!built) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, `globalThis._VSCODE_NLS_MESSAGES=${JSON.stringify(built.messages)};globalThis._VSCODE_NLS_LANGUAGE=${JSON.stringify(locale)};\n`);
  renameSync(`${file}.tmp`, file);
  const stats = { translated: built.translated, total: built.messages.length };
  writeFileSync(meta, JSON.stringify(stats));
  return { file, pack: `${found.pack.id}@${found.pack.version}`, ...stats };
}

/** Where the page asks for the strings omem built: under /ide, so the same session check applies. */
export const nlsPath = (base: string, commit: string, locale: string) => `${base}/_omem/nls/${commit}/${encodeURIComponent(locale)}.js`;
export const NLS_ROUTE = /^\/_omem\/nls\/([0-9a-f]{40})\/([A-Za-z0-9-]+)\.js$/;

/**
 * serve-web's workbench page with the CDN's translated strings swapped for omem's (`resolve` builds
 * them; null leaves the page in English). The built-in English script before it stays as it is.
 */
export function rewriteWorkbench(html: string, base: string, resolve: (commit: string, locale: string) => boolean) {
  return html.replace(/<script type="module" src="(https:\/\/[^"]+\/([0-9a-f]{40})\/[^/"]+\/([^/"]+)\/nls\.messages\.js)"><\/script>/g, (_all, _url, commit: string, locale: string) => {
    const lang = decodeURIComponent(locale).toLowerCase();
    return resolve(commit, lang) ? `<script type="module" src="${nlsPath(base, commit, lang)}"></script>` : "<!-- omem: no language pack for this build, English -->";
  });
}
