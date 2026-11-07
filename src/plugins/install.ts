import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { HttpError, now } from "../core/util.ts";
import { builtinPluginsDir, dataPluginsDir, manifestSchema } from "./registry.ts";

/**
 * Installing someone else's plugin (docs/v2/plugins.md, “第三方插件”) into the data directory's
 * plugins/<id>: an npm package (`npm:name@version`, or a bare name) or a GitHub repository at a tag or
 * commit (`github:owner/repo#ref`; a ref is required, a branch would change under the trust). Nothing
 * of it runs here: no install scripts, dependencies installed with --ignore-scripts; its code waits for
 * the owner's trust like any plugin with code. Where it came from is kept in .omem-install.json.
 */
export type InstallSource = { kind: "npm"; spec: string } | { kind: "github"; owner: string; repo: string; ref: string };
export type InstallInfo = { source: string; version: string; installedAt: string };
const INFO = ".omem-install.json";

export function parseSource(spec: string): InstallSource {
  const s = spec.trim();
  const gh = /^(?:github:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#|\/tree\/|@)([\w./-]+)$/.exec(s);
  if (gh) return { kind: "github", owner: gh[1], repo: gh[2], ref: gh[3] };
  if (/^(github:|https:\/\/github\.com\/)/.test(s)) throw new HttpError(400, "GitHub 来源要带 tag 或提交：github:owner/repo#v1.0.0");
  const npm = s.replace(/^npm:/, "");
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i.test(npm)) throw new HttpError(400, `看不懂的来源：${spec}（npm:包名@版本 或 github:owner/repo#tag）`);
  return { kind: "npm", spec: npm };
}
export const sourceText = (s: InstallSource) => (s.kind === "npm" ? `npm:${s.spec}` : `github:${s.owner}/${s.repo}#${s.ref}`);

const win = process.platform === "win32";
function sh(cmd: string, args: string[], cwd: string) {
  // npm is a .cmd shim on Windows and needs a shell; the arguments are checked above.
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: win && cmd === "npm", timeout: 5 * 60_000 });
  if (r.status !== 0) throw new HttpError(400, `${cmd} ${args[0]} 失败：${(r.stderr || r.stdout || r.error?.message || "").trim().slice(-500)}`);
  return r.stdout;
}

let fetcher: typeof fetch = (...a) => fetch(...a);
/** Tests: answer the download without the network. */
export function setInstallFetchForTests(fn: typeof fetch | null) {
  fetcher = fn ?? ((...a) => fetch(...a));
}

/** Download and unpack into a fresh directory; returns the directory holding plugin.yaml. */
async function fetchInto(src: InstallSource, work: string) {
  const tgz = join(work, "pkg.tgz");
  if (src.kind === "npm") {
    const out = sh("npm", ["pack", src.spec, "--ignore-scripts", "--json", "--pack-destination", work], work);
    const name = (JSON.parse(out) as { filename: string }[])[0]?.filename;
    if (!name) throw new HttpError(400, `npm pack 没有给出文件：${src.spec}`);
    renameSync(join(work, name.replace(/^@[^/]+\//, "").replace(/\//g, "-")), tgz);
  } else {
    const res = await fetcher(`https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/${encodeURIComponent(src.ref)}`);
    if (!res.ok) throw new HttpError(400, `下载 ${src.owner}/${src.repo}#${src.ref} 失败：HTTP ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }
  // Relative to the work directory: GNU tar takes a drive letter (C:…) for a remote host.
  sh("tar", ["-xzf", "pkg.tgz"], work);
  // npm packs under package/, GitHub under <repo>-<ref>/: the one directory that was unpacked.
  const top = readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (top.length !== 1) throw new HttpError(400, "包里的目录结构不对：应该只有一个顶层目录");
  return join(work, top[0].name);
}

export function installInfo(dir: string): InstallInfo | null {
  try {
    return JSON.parse(readFileSync(join(dir, INFO), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Install or update: unpack, check the manifest, refuse an id a built-in plugin or a hand-made one in the
 * data directory already has, put the dependencies in without scripts, then swap the directory in.
 * Returns the plugin's id; loading it (and asking for trust) is the caller's.
 */
export async function installPlugin(app: App, spec: string): Promise<{ id: string; dir: string; version: string; replaced: boolean }> {
  const src = parseSource(spec);
  const work = mkdtempSync(join(tmpdir(), "omem-plugin-"));
  try {
    const dir = await fetchInto(src, work);
    if (!existsSync(join(dir, "plugin.yaml"))) throw new HttpError(400, "包里没有 plugin.yaml：不是 omem 插件");
    const manifest = manifestSchema.parse(YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")));
    if (existsSync(join(builtinPluginsDir(), manifest.id))) throw new HttpError(409, `插件 id ${manifest.id} 和内置插件重名`);
    const target = join(dataPluginsDir(app), manifest.id);
    const replaced = existsSync(target);
    if (replaced && !installInfo(target)) throw new HttpError(409, `数据目录里已经有你自己放的插件 ${manifest.id}，不覆盖`);
    const pkg = existsSync(join(dir, "package.json")) ? (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string; dependencies?: Record<string, string> }) : {};
    if (pkg.dependencies && Object.keys(pkg.dependencies).length && !existsSync(join(dir, "node_modules")))
      sh("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], dir);
    const version = String(pkg.version ?? (manifest as { version?: string }).version ?? (src.kind === "github" ? src.ref : ""));
    writeFileSync(join(dir, INFO), JSON.stringify({ source: sourceText(src), version, installedAt: now() } satisfies InstallInfo, null, 2));
    if (replaced) rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true });
    return { id: manifest.id, dir: target, version, replaced };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Remove an installed plugin's directory (only one this installer put there). */
export function removeInstalled(app: App, id: string) {
  const dir = join(dataPluginsDir(app), id);
  if (!installInfo(dir)) throw new HttpError(400, `插件 ${id} 不是装进来的，不删除；要删就自己删 ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
