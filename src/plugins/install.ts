import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { killPid } from "../core/procs.ts";
import { HttpError, now, sha256 } from "../core/util.ts";
import { readLinks } from "./links.ts";
import { builtinPluginsDir, dataPluginsDir, manifestSchema, type PluginManifest } from "./registry.ts";

/**
 * Installing someone else's plugin (docs/v2/plugins.md, “第三方插件”) into the data directory's
 * plugins/<id>: an npm package (`npm:name@version`, or a bare name) or a GitHub repository at a tag or
 * commit (`github:owner/repo#ref`; a ref is required, a branch would change under the trust). Nothing
 * of it runs here: no install scripts, dependencies installed with --ignore-scripts; its code waits for
 * the owner's trust like any plugin with code. Where it came from is kept in .omem-install.json.
 */
export type InstallSource = { kind: "local"; dir: string } | { kind: "npm"; spec: string } | { kind: "github"; owner: string; repo: string; ref: string };
export type InstallInfo = { source: string; version: string; installedAt: string };
const INFO = ".omem-install.json";

export function parseSource(spec: string): InstallSource {
  const s = spec.trim();
  if (existsSync(s) && lstatSync(s).isDirectory()) return { kind: "local", dir: resolve(s) };
  const gh = /^(?:github:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#|\/tree\/|@)([\w./-]+)$/.exec(s);
  if (gh) return { kind: "github", owner: gh[1], repo: gh[2], ref: gh[3] };
  if (/^(github:|https:\/\/github\.com\/)/.test(s)) throw new HttpError(400, "GitHub 来源要带 tag 或提交：github:owner/repo#v1.0.0");
  const npm = s.replace(/^npm:/, "");
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i.test(npm)) throw new HttpError(400, `看不懂的来源：${spec}（npm:包名@版本 或 github:owner/repo#tag）`);
  return { kind: "npm", spec: npm };
}
export const sourceText = (s: InstallSource) => (s.kind === "local" ? s.dir : s.kind === "npm" ? `npm:${s.spec}` : `github:${s.owner}/${s.repo}#${s.ref}`);

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
  if (src.kind === "local") {
    const dest = join(work, "local");
    // Local packages are independent copies; links (including directory junctions) are refused.
    const copy = (from: string, to: string) => {
      if (lstatSync(from).isSymbolicLink()) throw new HttpError(400, "本地插件不能含符号链接");
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from, { withFileTypes: true })) {
        if (e.isSymbolicLink()) throw new HttpError(400, "本地插件不能含符号链接");
        if (e.isDirectory()) copy(join(from, e.name), join(to, e.name));
        else if (e.isFile()) cpSync(join(from, e.name), join(to, e.name));
      }
    };
    copy(src.dir, dest);
    return dest;
  }
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

/** A recursive removal may only affect one direct child of the live plugin directory. */
function checkedTarget(app: App, id: string) {
  const root = resolve(dataPluginsDir(app)), target = resolve(root, id);
  if (dirname(target) !== root || !/^[a-z][a-z0-9]{1,23}$/.test(id)) throw new HttpError(400, "插件目录不合法");
  if (existsSync(target)) {
    const rel = relative(realpathSync(root), realpathSync(target));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || lstatSync(target).isSymbolicLink()) throw new HttpError(400, "插件目录不能是符号链接或指向 plugins/ 之外");
  }
  return target;
}

// ---------------------------------------------------------------- building from source

type Package = { version?: string; scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
/**
 * A package from source (docs/v2/flows.md §8, “安装”): a `build` script, and a file its manifest points at
 * that is not there yet — `server` (dist/server.js) or a service's script. `commands` are exactly what will
 * run, `scripts` what `npm run build` runs of the package's own; `key` stands for both, so a confirmation
 * covers what was shown and nothing else.
 */
export type BuildPlan = { id: string; source: string; missing: string[]; commands: string[]; scripts: Record<string, string>; key: string };
/** Thrown by installPlugin when a package needs building and the owner has not confirmed this plan. */
export class BuildNeeded extends HttpError {
  readonly plan: BuildPlan;
  constructor(plan: BuildPlan) {
    super(409, `插件 ${plan.id} 要先从源码构建：${plan.commands.join("；")}。确认后才运行`);
    this.plan = plan;
  }
}
const BUILD_MINUTES = 10;
const SCRIPT_FILE = /^(?![\\/])(?!.*\.\.)[\w./-]+\.(m?js|cjs|ts)$/;

function readPackage(dir: string): { pkg: Package; raw: string } {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return { pkg: {}, raw: "" };
  const raw = readFileSync(file, "utf8");
  try {
    return { pkg: JSON.parse(raw) as Package, raw };
  } catch {
    throw new HttpError(400, "包里的 package.json 不是合法的 JSON");
  }
}

export function buildPlan(dir: string, manifest: PluginManifest, source: string): { plan: BuildPlan; steps: string[][] } | null {
  const { pkg, raw } = readPackage(dir);
  const build = pkg.scripts?.build;
  if (typeof build !== "string" || !build.trim()) return null;
  const entries = [manifest.server, ...manifest.services.map((s) => s.args.find((a) => SCRIPT_FILE.test(a)))].filter((x): x is string => !!x);
  const missing = [...new Set(entries)].filter((f) => !existsSync(join(dir, f)));
  if (!missing.length) return null;
  const deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0 && !existsSync(join(dir, "node_modules"));
  // Dependencies go in without their install scripts; the build is the package's own script, shown below.
  const install = existsSync(join(dir, "package-lock.json")) ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] : ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
  const steps = [...(deps ? [["npm", ...install]] : []), ["npm", "run", "build"]];
  const scripts: Record<string, string> = {};
  for (const k of ["prebuild", "build", "postbuild"]) if (typeof pkg.scripts?.[k] === "string") scripts[k] = pkg.scripts[k] as string;
  const commands = steps.map((s) => s.join(" "));
  return { plan: { id: manifest.id, source, missing, commands, scripts, key: sha256(JSON.stringify({ id: manifest.id, source, commands, raw })).slice(0, 32) }, steps };
}

/** What a build sees of omem's environment: not its secrets (like a plugin's services). */
function buildEnv() {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/secret|token|password|api_?key|^OMEM_/i.test(k)) env[k] = v;
  return env;
}
const tail = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-12).join("\n");
  } catch {
    return "";
  }
};

/**
 * Run a confirmed build: each command in its own process, in the unpacked package's directory, without
 * omem's secrets, all of them within BUILD_MINUTES; the output goes to <data>/logs/plugin-builds/<id>.log.
 */
async function runBuild(app: App, plan: BuildPlan, steps: string[][], dir: string) {
  const logDir = join(app.home, "logs", "plugin-builds");
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${plan.id}.log`);
  writeFileSync(log, `# ${now()} ${plan.source}\n# ${plan.commands.join("\n# ")}\n`);
  const deadline = Date.now() + BUILD_MINUTES * 60_000;
  for (const [cmd, ...args] of steps) {
    appendFileSync(log, `\n$ ${[cmd, ...args].join(" ")}\n`);
    await new Promise<void>((done, fail) => {
      // npm is a .cmd shim on Windows and needs a shell: one command line of the fixed words above.
      const opts = { cwd: dir, env: buildEnv(), windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[] };
      const child = win && cmd === "npm" ? spawn([cmd, ...args].join(" "), { ...opts, shell: true }) : spawn(cmd, args, opts);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        if (child.pid) killPid(child.pid);
      }, Math.max(1000, deadline - Date.now()));
      const write = (d: Buffer) => appendFileSync(log, d);
      child.stdout?.on("data", write);
      child.stderr?.on("data", write);
      child.on("error", (e) => {
        clearTimeout(timer);
        fail(new HttpError(400, `${cmd} 启动失败：${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && !late) return done();
        fail(new HttpError(400, `${[cmd, ...args].join(" ")} ${late ? `超过 ${BUILD_MINUTES} 分钟，已停止` : `失败（退出码 ${code}）`}：${tail(log).slice(-800)}\n完整输出在 ${log}`));
      });
    });
  }
  return log;
}

/**
 * Install or update: unpack, check the manifest, refuse an id a built-in plugin or a hand-made one in the
 * data directory already has, build it when it comes as source (only a plan the owner confirmed:
 * `opts.build` is its key; otherwise BuildNeeded with the plan, and nothing of the package runs), put the
 * dependencies in without scripts, then swap the directory in. Returns the plugin's id; loading it (and
 * asking for trust) is the caller's.
 */
export async function installPlugin(app: App, spec: string, opts: { build?: string } = {}): Promise<{ id: string; dir: string; version: string; replaced: boolean; buildLog?: string }> {
  const src = parseSource(spec);
  const work = mkdtempSync(join(tmpdir(), "omem-plugin-"));
  try {
    const dir = await fetchInto(src, work);
    if (!existsSync(join(dir, "plugin.yaml"))) throw new HttpError(400, "包里没有 plugin.yaml：不是 omem 插件");
    const manifest = manifestSchema.parse(YAML.parse(readFileSync(join(dir, "plugin.yaml"), "utf8")));
    if (existsSync(join(builtinPluginsDir(), manifest.id))) throw new HttpError(409, `插件 id ${manifest.id} 和内置插件重名`);
    if (readLinks(app)[manifest.id]) throw new HttpError(409, `插件 ${manifest.id} 链接着开发目录（${readLinks(app)[manifest.id].dir}）：先 omem plugin unlink ${manifest.id}`);
    const target = checkedTarget(app, manifest.id);
    const replaced = existsSync(target);
    if (replaced && !installInfo(target)) throw new HttpError(409, `数据目录里已经有你自己放的插件 ${manifest.id}，不覆盖`);
    const built = buildPlan(dir, manifest, sourceText(src));
    if (built && opts.build !== built.plan.key) throw new BuildNeeded(built.plan);
    const buildLog = built ? await runBuild(app, built.plan, built.steps, dir) : undefined;
    if (built) {
      const still = built.plan.missing.filter((f) => !existsSync(join(dir, f)));
      if (still.length) throw new HttpError(400, `构建完了，${still.join("、")} 还是没有：看 ${buildLog}`);
    }
    const { pkg } = readPackage(dir);
    if (pkg.dependencies && Object.keys(pkg.dependencies).length && !existsSync(join(dir, "node_modules")))
      sh("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], dir);
    const version = String(pkg.version ?? (manifest as { version?: string }).version ?? (src.kind === "github" ? src.ref : ""));
    writeFileSync(join(dir, INFO), JSON.stringify({ source: sourceText(src), version, installedAt: now() } satisfies InstallInfo, null, 2));
    if (replaced) rmSync(target, { recursive: true, force: true });
    cpSync(dir, target, { recursive: true });
    return { id: manifest.id, dir: target, version, replaced, ...(buildLog ? { buildLog } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Remove an installed plugin's directory (only one this installer put there). */
export function removeInstalled(app: App, id: string) {
  const dir = checkedTarget(app, id);
  if (!installInfo(dir)) throw new HttpError(400, `插件 ${id} 不是装进来的，不删除；要删就自己删 ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}
