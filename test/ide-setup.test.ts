import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { languagePacks, packFor, rewriteWorkbench, translateMessages, workbenchNls } from "../src/server/ide-locale.ts";
import { engineAllows, installOmemExtension, listedExtensions, readJsonc, reusableExtensions, reuseExtensions, reuseSources, seedMachineSettings, targetPlatform } from "../src/server/ide-setup.ts";

const COMMIT = "a".repeat(40);
const tmp = () => mkdtempSync(join(tmpdir(), "omem-ide-setup-"));
const write = (file: string, data: unknown) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};

/** A downloaded server build: keys per module in order, the English strings at the same positions. */
function server(root: string, commit = COMMIT) {
  const dir = join(root, "cli", "serve-web", commit);
  write(join(dir, "out", "nls.keys.json"), [["vs/a", ["copy", "paste"]], ["vs/b", ["newTerminal", "addedLater"]]]);
  write(join(dir, "out", "nls.messages.json"), ["Copy", "Paste", "New Terminal", "Added Later"]);
  return dir;
}

/** A language pack folder, listed in extensions.json unless told otherwise. */
function pack(extDir: string, version: string, contents: Record<string, Record<string, string>>, opts: { listed?: boolean; language?: string } = {}) {
  const folder = `ms-ceintl.vscode-language-pack-zh-hans-${version}`;
  write(join(extDir, folder, "package.json"), { name: "vscode-language-pack-zh-hans", publisher: "MS-CEINTL", version, engines: { vscode: `^${version.split(".").slice(0, 2).join(".")}.0` }, contributes: { localizations: [{ languageId: opts.language ?? "zh-cn", translations: [{ id: "vscode", path: "./translations/main.i18n.json" }] }] } });
  write(join(extDir, folder, "translations", "main.i18n.json"), { contents });
  if (opts.listed !== false) {
    const list = existsSync(join(extDir, "extensions.json")) ? JSON.parse(readFileSync(join(extDir, "extensions.json"), "utf8")) : [];
    list.push({ identifier: { id: "ms-ceintl.vscode-language-pack-zh-hans" }, version, relativeLocation: folder });
    write(join(extDir, "extensions.json"), list);
  }
}

const CDN = (commit: string, locale: string) => `<script type="module" src="https://www.vscode-unpkg.net/nls/${commit}/1.144.0/${locale}/nls.messages.js"></script>`;

describe("web VS Code interface language", () => {
  it("translates this build's strings by key, English where the pack has none, never by position", () => {
    const root = tmp();
    const dir = server(root);
    // An older pack: it has no `addedLater`, and its own order differs from the build's.
    write(join(root, "main.i18n.json"), { contents: { "vs/b": { newTerminal: "新建终端" }, "vs/a": { paste: "粘贴", copy: "复制" } } });
    expect(translateMessages(dir, join(root, "main.i18n.json"))).toEqual({ messages: ["复制", "粘贴", "新建终端", "Added Later"], translated: 3 });
    // Keys and messages of different lengths: nothing is safe.
    write(join(dir, "out", "nls.messages.json"), ["Copy", "Paste", "New Terminal"]);
    expect(translateMessages(dir, join(root, "main.i18n.json"))).toBeNull();
  });

  it("uses the newest installed pack for the language, rebuilds when it changes, and stays English otherwise", () => {
    const root = tmp();
    server(root);
    const ext = join(root, "server", "extensions");
    pack(ext, "1.130.2026072017", { "vs/a": { copy: "旧复制" } });
    pack(ext, "1.131.2026090407", { "vs/a": { copy: "复制" } });
    // A folder VS Code no longer lists (uninstalled, not yet cleaned up) does not count.
    pack(ext, "1.132.2026100101", { "vs/a": { copy: "不该用" } }, { listed: false });
    expect(languagePacks(ext).map((p) => p.version).sort()).toEqual(["1.130.2026072017", "1.131.2026090407"]);
    expect(packFor(ext, "zh-CN")?.pack.version).toBe("1.131.2026090407");

    const built = workbenchNls(root, COMMIT, "zh-cn")!;
    expect(built).toMatchObject({ pack: "ms-ceintl.vscode-language-pack-zh-hans@1.131.2026090407", translated: 1, total: 4 });
    const script = readFileSync(built.file, "utf8");
    expect(script).toContain('globalThis._VSCODE_NLS_MESSAGES=["复制","Paste","New Terminal","Added Later"]');
    expect(script).toContain('globalThis._VSCODE_NLS_LANGUAGE="zh-cn"');

    pack(ext, "1.133.2026110101", { "vs/a": { copy: "复制", paste: "粘贴" } });
    expect(workbenchNls(root, COMMIT, "zh-cn")).toMatchObject({ pack: "ms-ceintl.vscode-language-pack-zh-hans@1.133.2026110101", translated: 2 });

    expect(workbenchNls(root, COMMIT, "en")).toBeNull();
    expect(workbenchNls(root, COMMIT, "ja")).toBeNull();
    expect(workbenchNls(root, "b".repeat(40), "zh-cn")).toBeNull();
    expect(workbenchNls(root, "../../etc", "zh-cn")).toBeNull();
  });

  it("points the page at omem's strings instead of the CDN's, or leaves it in English", () => {
    const page = `<script type="module" src="/ide/stable-x/static/out/nls.messages.js"></script>\n${CDN(COMMIT, "zh-cn")}\n<script type="module" src="/ide/stable-x/static/out/vs/code/browser/workbench/workbench.js"></script>`;
    const seen: string[] = [];
    const swapped = rewriteWorkbench(page, "/ide", (commit, locale) => (seen.push(`${commit}/${locale}`), true));
    expect(seen).toEqual([`${COMMIT}/zh-cn`]);
    expect(swapped).toContain(`<script type="module" src="/ide/_omem/nls/${COMMIT}/zh-cn.js"></script>`);
    expect(swapped).not.toContain("vscode-unpkg.net");
    // The built-in English strings stay first; the workbench after.
    expect(swapped).toContain("/static/out/nls.messages.js");
    expect(swapped).toContain("workbench.js");
    const english = rewriteWorkbench(page, "/ide", () => false);
    expect(english).not.toContain("vscode-unpkg.net");
    expect(english).not.toContain("/_omem/nls/");
    // An English page has no such script and comes back unchanged.
    expect(rewriteWorkbench('<script type="module" src=""></script>', "/ide", () => true)).toBe('<script type="module" src=""></script>');
  });
});

describe("what omem puts into the web VS Code", () => {
  const source = () => {
    const dir = join(tmp(), "vscode");
    write(join(dir, "package.json"), { name: "omem-vscode", publisher: "omem", version: "0.1.0", main: "./out/extension.js" });
    write(join(dir, "README.md"), "# omem");
    write(join(dir, "media", "omem.svg"), "<svg/>");
    write(join(dir, "src", "extension.ts"), "export const a: number = 1;");
    write(join(dir, "src", "sub", "api.ts"), "export const b = 2;");
    return dir;
  };
  const transpile = (code: string) => `// compiled\n${code.replace(": number", "")}`;

  it("installs omem's extension, keeps others' entries, and refreshes only when its sources change", () => {
    const src = source();
    const data = tmp();
    const ext = join(data, "extensions");
    write(join(ext, "extensions.json"), [{ identifier: { id: "someone.other" }, version: "1.0.0", relativeLocation: "someone.other-1.0.0" }]);
    write(join(data, "data", "CachedProfilesData", "__default__profile__", "extensions.user.zh-cn.cache"), "{}");
    write(join(data, "data", "CachedProfilesData", "__default__profile__", "extensions.builtin.cache"), "{}");

    const first = installOmemExtension({ source: src, extDir: ext, serverData: data, transpile });
    expect(first).toMatchObject({ status: "installed", version: "0.1.0" });
    const folder = join(ext, "omem.omem-vscode-0.1.0");
    expect(readFileSync(join(folder, "out", "extension.js"), "utf8")).toBe("// compiled\nexport const a = 1;");
    expect(existsSync(join(folder, "out", "sub", "api.js"))).toBe(true);
    expect(existsSync(join(folder, "media", "omem.svg"))).toBe(true);
    const listed = listedExtensions(ext);
    expect(listed.map((e) => e.identifier.id)).toEqual(["someone.other", "omem.omem-vscode"]);
    expect(listed[1]).toMatchObject({ version: "0.1.0", relativeLocation: "omem.omem-vscode-0.1.0", location: { scheme: "file" } });
    // VS Code's scan cache of user extensions goes; the built-in one stays.
    expect(readdirSync(join(data, "data", "CachedProfilesData", "__default__profile__"))).toEqual(["extensions.builtin.cache"]);

    expect(installOmemExtension({ source: src, extDir: ext, serverData: data, transpile }).status).toBe("current");
    write(join(src, "src", "extension.ts"), "export const a = 3;");
    expect(installOmemExtension({ source: src, extDir: ext, serverData: data, transpile }).status).toBe("installed");
    expect(readFileSync(join(folder, "out", "extension.js"), "utf8")).toContain("a = 3");
    // A new version replaces the old folder and entry.
    write(join(src, "package.json"), { name: "omem-vscode", publisher: "omem", version: "0.2.0", main: "./out/extension.js" });
    expect(installOmemExtension({ source: src, extDir: ext, serverData: data, transpile }).version).toBe("0.2.0");
    expect(readdirSync(ext).filter((d) => d.startsWith("omem."))).toEqual(["omem.omem-vscode-0.2.0"]);
    expect(listedExtensions(ext).map((e) => `${e.identifier.id}@${e.version}`)).toEqual(["someone.other@1.0.0", "omem.omem-vscode@0.2.0"]);

    expect(installOmemExtension({ source: null, extDir: ext, serverData: data, transpile }).status).toBe("unavailable");
    // No compiler: a built out/ is used as it is; without one there is nothing to install.
    const bare = source();
    expect(installOmemExtension({ source: bare, extDir: join(tmp(), "e"), serverData: data, transpile: null }).status).toBe("unavailable");
    write(join(bare, "out", "extension.js"), "exports.built = true;");
    const fromOut = join(tmp(), "e");
    expect(installOmemExtension({ source: bare, extDir: fromOut, serverData: data, transpile: null }).status).toBe("installed");
    expect(readFileSync(join(fromOut, "omem.omem-vscode-0.1.0", "out", "extension.js"), "utf8")).toBe("exports.built = true;");

    // No extensions.json yet: the extensions already in the folder stay listed next to omem's.
    const fresh = join(tmp(), "e");
    pack(fresh, "1.131.0", {}, { listed: false });
    installOmemExtension({ source: src, extDir: fresh, serverData: data, transpile });
    expect(listedExtensions(fresh).map((e) => `${e.identifier.id}@${e.version}`)).toEqual(["ms-ceintl.vscode-language-pack-zh-hans@1.131.0", "omem.omem-vscode@0.2.0"]);
    expect(packFor(fresh, "zh-cn")?.pack.version).toBe("1.131.0");
  });

  it("seeds machine settings once from the first source that has some, without the omem extension's own", () => {
    const home = tmp();
    const sources = reuseSources(home, "linux", {});
    expect(sources.map((s) => s.kind)).toEqual(["remote-ssh", "remote-ssh", "desktop"]);
    expect(sources[2].settings).toBe(join(home, ".config", "Code", "User", "settings.json"));
    write(sources[2].settings, '{ "editor.fontSize": 15 }');
    write(sources[0].settings, '{\n  // from Remote-SSH\n  "terminal.integrated.defaultProfile.linux": "bash",\n  "omem.connection": "peer",\n  "omem.peer": "box",\n  "files.exclude": { "**/x": true, },\n}\n');
    const data = tmp();
    expect(seedMachineSettings(data, sources)).toEqual({ from: sources[0].settings, keys: 2 });
    const target = join(data, "data", "Machine", "settings.json");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ "terminal.integrated.defaultProfile.linux": "bash", "files.exclude": { "**/x": true } });
    // Its own settings exist now: never overwritten.
    write(target, '{ "mine": 1 }');
    expect(seedMachineSettings(data, sources)).toBeNull();
    expect(readFileSync(target, "utf8")).toBe('{ "mine": 1 }');
    // Nothing anywhere: nothing written.
    expect(seedMachineSettings(tmp(), reuseSources(tmp(), "linux", {}))).toBeNull();
    expect(reuseSources(home, "win32", { APPDATA: join(home, "Roaming") })[2].settings).toBe(join(home, "Roaming", "Code", "User", "settings.json"));
    expect(readJsonc(sources[0].settings)).toMatchObject({ "omem.peer": "box" });
  });

  it("reuses fitting extensions from this machine once, never over the web IDE's own", () => {
    expect(engineAllows("^1.90.0", "1.144.0")).toBe(true);
    expect(engineAllows(">=1.145.0", "1.144.0")).toBe(false);
    expect(engineAllows("*", "1.0.0")).toBe(true);
    expect(engineAllows(undefined, "1.0.0")).toBe(true);
    expect(engineAllows("latest", "1.0.0")).toBe(false);

    const home = tmp();
    const [remote] = reuseSources(home, "linux", {});
    const add = (id: string, version: string, engine: string, platform = "undefined") => {
      const folder = `${id}-${version}${platform === "undefined" ? "" : `-${platform}`}`;
      write(join(remote.extensions, folder, "package.json"), { name: id.split(".")[1], publisher: id.split(".")[0], version, engines: { vscode: engine } });
      const list = existsSync(join(remote.extensions, "extensions.json")) ? JSON.parse(readFileSync(join(remote.extensions, "extensions.json"), "utf8")) : [];
      list.push({ identifier: { id, uuid: `uuid-${id}` }, version, relativeLocation: folder, metadata: { targetPlatform: platform, source: "gallery" } });
      write(join(remote.extensions, "extensions.json"), list);
    };
    const here = targetPlatform();
    add("pub.fits", "1.0.0", "^1.80.0");
    add("pub.native", "2.0.0", "^1.80.0", here);
    add("pub.elsewhere", "1.0.0", "^1.80.0", here === "linux-arm64" ? "win32-x64" : "linux-arm64");
    add("pub.toonew", "1.0.0", "^1.200.0");
    add("pub.mine", "1.0.0", "^1.80.0");
    add("omem.omem-vscode", "0.0.1", "^1.80.0");

    const listing = Object.fromEntries(reusableExtensions(remote.extensions, "1.144.0").map((x) => [x.id, x.why ?? "ok"]));
    expect(listing).toMatchObject({ "pub.fits": "ok", "pub.native": "ok", "pub.toonew": "要求 VS Code ^1.200.0", "omem.omem-vscode": "omem 自己装" });
    expect(listing["pub.elsewhere"]).toMatch(/^平台是 /);
    expect(reusableExtensions(remote.extensions, null).every((x) => !x.fits)).toBe(true);

    const data = tmp();
    const ext = join(data, "extensions");
    write(join(ext, "extensions.json"), [{ identifier: { id: "pub.mine" }, version: "9.0.0", relativeLocation: "pub.mine-9.0.0" }]);
    const record = join(data, "reused.json");
    const opts = { extDir: ext, serverData: data, record, sources: [remote], serverVersion: "1.144.0" };
    expect(reuseExtensions(opts).sort()).toEqual(["pub.fits@1.0.0", "pub.native@2.0.0"]);
    expect(existsSync(join(ext, "pub.fits-1.0.0", "package.json"))).toBe(true);
    const entries = listedExtensions(ext);
    expect(entries.map((e) => `${e.identifier.id}@${e.version}`).sort()).toEqual(["pub.fits@1.0.0", "pub.mine@9.0.0", "pub.native@2.0.0"]);
    expect(entries.find((e) => e.identifier.id === "pub.fits")).toMatchObject({ identifier: { uuid: "uuid-pub.fits" }, relativeLocation: "pub.fits-1.0.0", metadata: { source: "gallery" } });

    // Uninstalled in the web IDE afterwards: not brought back.
    write(join(ext, "extensions.json"), entries.filter((e) => e.identifier.id !== "pub.fits"));
    expect(reuseExtensions(opts)).toEqual([]);
    expect(listedExtensions(ext).some((e) => e.identifier.id === "pub.fits")).toBe(false);
  });
});

describe("rewritten page and CDN shape", () => {
  it("only matches the CDN's per-build script, any locale", () => {
    const out = rewriteWorkbench(`${CDN(COMMIT, "zh-tw")}${CDN("b".repeat(40), "ja")}`, "/ide", (_c, l) => l === "zh-tw");
    expect(out).toContain(`/ide/_omem/nls/${COMMIT}/zh-tw.js`);
    expect(out).not.toContain("/ja.js");
  });
});
