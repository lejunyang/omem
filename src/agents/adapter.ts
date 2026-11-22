import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { App } from "../core/app.ts";
import { adapterPackage, adapterPrefix, installedAdapter } from "../core/peer-inspect.ts";
import { HttpError } from "../core/util.ts";
import { forgetAvailability } from "./availability.ts";
import { catalogEntry } from "./catalog.ts";
import { probeProfile, saveProbe } from "./probe.ts";
import { listAgentProfiles } from "./runner.ts";
import { commandExists } from "./spawn.ts";

/**
 * The npm package behind a catalog ACP backend (codex-acp, claude-agent-acp…): which version is
 * installed, which is the newest, installing it and upgrading it in place. Shared by settings → AI and
 * the `agent-upgrade` peer command. Only a package the catalog names, never an arbitrary one.
 *
 * Installing and upgrading run as a job in the background: a global npm install of an adapter that
 * ships a native program can take many minutes on a slow mirror, longer than a page waits for one
 * request. The page asks for the job's state (`GET /api/agents/:id/adapter`), so a refresh finds it
 * still running instead of offering to start a second one. Jobs run one at a time (they write into the
 * same global prefix), and a job stays running until its process has really exited.
 *
 * With osdk and Node on this machine, a new install goes through `osdk use -g npm:<package>` (osdk's
 * managed global prefix, recorded in its user lock); so does an upgrade of a copy osdk manages. A copy
 * npm put somewhere else is upgraded by npm into the prefix it is in, so the copy in use changes.
 */

const run = promisify(execFile);
const isWin = process.platform === "win32";
const npmView = (args: string[], cwd: string, timeout: number) =>
  // npm is a .cmd shim on Windows: it needs a shell there (the arguments are checked, never free text).
  run("npm", args, { cwd, timeout, maxBuffer: 20_000_000, shell: isWin });

const registry = async () => {
  const { publicNpmRegistry } = await import("../core/peer-exec.ts");
  return publicNpmRegistry((await import("../setup.ts")).packageRoot());
};

/** A catalog backend with an npm package, whatever its install state. */
function npmBackend(app: App, id: string) {
  const entry = catalogEntry(id);
  const profile = listAgentProfiles(app).find((p) => p.id === id);
  if (!entry?.npm || !profile || profile.command !== entry.command) throw new HttpError(400, `${id} 不是目录里带 npm 包的后端`);
  return { entry, profile, npmName: entry.npm };
}

function installed(app: App, id: string) {
  const { entry, profile, npmName } = npmBackend(app, id);
  const pkg = adapterPackage(profile);
  if (pkg?.via !== "installed" || pkg.name !== npmName) throw new HttpError(400, `${id} 的适配器不是全局安装的 ${npmName}，不在这里升级`);
  return { entry, profile, pkg, npmName };
}

/** Whether a backend has an npm adapter here at all (settings shows the block only then). */
export function hasAdapter(app: App, id: string) {
  try {
    installed(app, id);
    return true;
  } catch {
    return false;
  }
}

/** A catalog backend with an npm package whose command is not found here: settings offers to install it. */
export function canInstall(app: App, id: string) {
  try {
    const { entry } = npmBackend(app, id);
    return !commandExists(entry.command);
  } catch {
    return false;
  }
}

const newer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

// ---- osdk

const osdkReady = () => commandExists("osdk") && commandExists("node");

/** Where osdk keeps a global npm package it manages (`osdk where -g`), or null when it does not manage it. */
function osdkWhere(npmName: string): string | null {
  if (!commandExists("osdk")) return null;
  const r = spawnSync("osdk", ["where", "-g", `npm:${npmName}`], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  const dir = r.status === 0 ? r.stdout.trim().split(/\r?\n/).at(-1)?.trim() : "";
  if (!dir || !existsSync(dir)) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/** Whether the copy in use is the one osdk manages, so an upgrade through osdk replaces it. */
function osdkManages(profile: { command: string; args: string[] }, npmName: string) {
  if (!osdkReady()) return false;
  const where = osdkWhere(npmName);
  const dir = installedAdapter(profile)?.dir;
  if (!where || !dir) return false;
  let inUse: string;
  try {
    inUse = realpathSync(dir);
  } catch {
    return false;
  }
  const norm = (p: string) => (isWin ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
  const prefix = adapterPrefix(profile);
  return norm(inUse).startsWith(norm(where)) || norm(where).startsWith(norm(inUse)) || (!!prefix && norm(where).startsWith(norm(prefix)));
}

// ---- jobs

export type AdapterJob = {
  id: string;
  package: string;
  action: "install" | "upgrade";
  /** `download`: a program from the ACP registry (agents/registry-update.ts); `npx` / `uvx`: a registry package run through them. */
  via: "osdk" | "npm" | "download" | "npx" | "uvx";
  /** The command line, for the page to show (no secrets in it: package, prefix, registry). */
  command: string;
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  ok?: boolean;
  before: string | null;
  after?: string | null;
  /** The last lines the installer printed. */
  output: string;
  /** What went wrong, or what to do next, in a sentence. */
  message?: string;
  probe?: Awaited<ReturnType<typeof probeProfile>>;
};

const jobs = new Map<string, AdapterJob>();
const done = new Map<string, Promise<AdapterJob>>();
let queue: Promise<unknown> = Promise.resolve();
/** Long enough for a native program on a slow mirror; a job past it is stopped (its whole process group). */
const JOB_TIMEOUT_MS = 45 * 60_000;

export function adapterJob(id: string): AdapterJob | null {
  return jobs.get(id) ?? null;
}

/** Forget finished jobs and availability (tests). */
export function resetAdapterJobsForTests() {
  jobs.clear();
  done.clear();
  queue = Promise.resolve();
}

function tail(text: string, lines = 30) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n").slice(-6000);
}

/** Run one installer process, keeping the tail of what it prints on the job as it goes. */
function runInstaller(job: AdapterJob, file: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(file, args, { cwd, shell: isWin && file === "npm", windowsHide: true, detached: !isWin, stdio: ["ignore", "pipe", "pipe"] });
    const take = (b: Buffer) => {
      out = (out + b.toString("utf8")).slice(-20_000);
      job.output = tail(out);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (!isWin && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      job.message = `超过 ${JOB_TIMEOUT_MS / 60_000} 分钟没装完，已停止`;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 30_000).unref();
    }, JOB_TIMEOUT_MS);
    timer.unref();
    child.on("error", (e) => {
      take(Buffer.from(String(e.message)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function startJob(app: App, id: string, action: AdapterJob["action"], plan: { file: string; args: string[]; via: AdapterJob["via"]; before: string | null; npmName: string }, finish: (job: AdapterJob, code: number) => Promise<void>) {
  return startTask(id, action, { package: plan.npmName, via: plan.via, command: [plan.file, ...plan.args].join(" "), before: plan.before }, async (job) => {
    const code = await runInstaller(job, plan.file, plan.args, app.home);
    forgetAvailability();
    await finish(job, code);
  });
}

/**
 * Start a job for a backend: one at a time across all backends, refused while this one already has a
 * running job. `work` sets `ok` (and `after`, `message`); a throw ends it as failed.
 */
export function startTask(id: string, action: AdapterJob["action"], meta: Pick<AdapterJob, "package" | "via" | "command" | "before">, work: (job: AdapterJob) => Promise<void>) {
  const running = jobs.get(id);
  if (running?.running) throw new HttpError(409, `${id} 正在${running.action === "install" ? "安装" : "升级"}`);
  const job: AdapterJob = { id, action, ...meta, startedAt: new Date().toISOString(), running: true, output: "" };
  jobs.set(id, job);
  const p = queue.then(async () => {
    try {
      await work(job);
    } catch (e) {
      job.ok = false;
      job.message = (e as Error).message;
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
    return job;
  });
  queue = p.catch(() => {});
  done.set(id, p);
  return job;
}

/** Wait for a backend's current job (the peer command answers with the result). */
export function waitForAdapterJob(id: string): Promise<AdapterJob | null> {
  return done.get(id) ?? Promise.resolve(null);
}

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

export type AdapterStatus = {
  id: string; package: string; version: string | null; prefix: string | null; latest: string | null; latestError?: string; upgradable: boolean; registry: string | null;
  via: "osdk" | "npm"; job: AdapterJob | null;
};

/** The installed version and npm's newest (asked from the public registry in osdk.toml). */
export async function adapterStatus(app: App, id: string): Promise<AdapterStatus> {
  const { profile, pkg, npmName } = installed(app, id);
  const reg = await registry();
  let latest: string | null = null, latestError: string | undefined;
  try {
    const r = await npmView(["view", npmName, "version", ...(reg ? [`--registry=${reg}`] : [])], app.home, 30_000);
    latest = r.stdout.trim().split("\n").at(-1)?.trim() || null;
  } catch (e) {
    latestError = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-2).join(" ").slice(0, 300);
  }
  return {
    id, package: npmName, version: pkg.version, prefix: adapterPrefix(profile), latest, ...(latestError ? { latestError } : {}),
    upgradable: !!(latest && pkg.version && newer(latest, pkg.version)), registry: reg,
    via: osdkManages(profile, npmName) ? "osdk" : "npm", job: adapterJob(id),
  };
}

/** After an install or upgrade: what is there now, and a fresh probe when the version changed. */
async function settle(app: App, id: string, job: AdapterJob, code: number, want: string | undefined) {
  const profile = listAgentProfiles(app).find((p) => p.id === id);
  const found = profile ? adapterPackage(profile) : null;
  job.after = found?.via === "installed" ? found.version : null;
  const there = !!profile && commandExists(profile.command);
  job.ok = code === 0 && there && (want ? job.after === want : true);
  if (!there) {
    job.message = code === 0
      ? `装完了，但 omem 的 PATH 里找不到命令 ${profile?.command ?? id}：把装到的 bin 目录加进 omem 服务的 PATH 后重启`
      : job.action === "install"
        ? `${job.message ? job.message + "；" : ""}没装上：${lastLine(job.output) || `安装命令退出码 ${code}`}`
        : `${job.message ? job.message + "；" : ""}装到一半出错，命令 ${profile?.command ?? id} 现在找不到了：可以在“其他支持的 Agent”里重新安装`;
  } else if (!job.ok && !job.message) job.message = code === 0 ? `装完以后版本是 ${job.after ?? "未知"}，不是 ${want}` : `安装命令退出码 ${code}`;
  // osdk on Windows: every command it puts on PATH is a link to one program, and while any of them runs
  // (a long `omem peer open`, say) it cannot add a new one.
  if (!job.ok && job.via === "osdk" && /syncing shim[\s\S]*os error 32/i.test(job.output)) {
    job.message = "osdk 加不了新命令：有别的 osdk 命令正在运行（Windows 上它们共用一个程序文件，比如开着的 omem peer open）。停掉它们后再装，或在终端里用 npm i -g 装";
  }
  if (job.ok && profile && job.after !== job.before) {
    job.probe = await probeProfile(profile, app);
    if (!job.probe.error) saveProbe(app, id, job.probe);
  }
}

/**
 * Upgrade in the background to `version` or the newest. Through osdk when osdk manages the copy in use;
 * otherwise `npm i -g <package>@<version|latest>` into the prefix the command is found in (omem's own npm
 * may have another global prefix, and then the copy in use would stay old), from the public registry.
 * An exact version also lifts a minimum-release-age policy for this install only.
 */
export async function upgradeAdapter(app: App, id: string, version?: string) {
  const { profile, pkg, npmName } = installed(app, id);
  if (version !== undefined && !VERSION.test(version)) throw new HttpError(400, "version 要写成 1.2.3");
  let plan: Parameters<typeof startJob>[3];
  if (osdkManages(profile, npmName)) {
    plan = { file: "osdk", args: ["--yes", "use", "-g", `npm:${npmName}@${version ? `=${version}` : "latest"}`], via: "osdk", before: pkg.version, npmName };
  } else {
    const reg = await registry();
    const prefix = adapterPrefix(profile);
    const pin = version ? ["--min-release-age=0", `--before=${new Date().toISOString()}`] : [];
    plan = { file: "npm", args: ["i", "-g", `${npmName}@${version ?? "latest"}`, ...(prefix ? [`--prefix=${prefix}`] : []), ...(reg ? [`--registry=${reg}`] : []), ...pin], via: "npm", before: pkg.version, npmName };
  }
  return startJob(app, id, "upgrade", plan, (job, code) => settle(app, id, job, code, version));
}

/**
 * Install a catalog backend's npm package that is not here (or whose command went missing). With osdk
 * and Node: `osdk use -g npm:<package>@latest`; otherwise `npm i -g` from the public registry.
 */
export async function installAdapter(app: App, id: string) {
  const { entry, npmName } = npmBackend(app, id);
  if (commandExists(entry.command)) throw new HttpError(409, `${entry.command} 已经装好了`);
  const useOsdk = osdkReady();
  if (!useOsdk && !commandExists("npm")) throw new HttpError(400, "这台机器上没有 npm，也没有 osdk：先装 Node.js");
  const reg = await registry();
  const npmArgs = ["i", "-g", `${npmName}@latest`, ...(reg ? [`--registry=${reg}`] : [])];
  const osdkArgs = ["--yes", "use", "-g", `npm:${npmName}@latest`];
  const first = useOsdk ? { file: "osdk", args: osdkArgs } : { file: "npm", args: npmArgs };
  return startTask(id, "install", { package: npmName, via: useOsdk ? "osdk" : "npm", command: [first.file, ...first.args].join(" "), before: null }, async (job) => {
    let code = await runInstaller(job, first.file, first.args, app.home);
    forgetAvailability();
    // osdk refuses some machines outright (a private registry in ~/.npmrc it cannot isolate from, a shim in use on
    // Windows): nothing was installed, so npm from the public registry is tried in the same job.
    if (useOsdk && code !== 0 && !commandExists(entry.command) && commandExists("npm")) {
      const refused = lastLine(job.output);
      job.output = `${job.output}\nosdk 没装上，改用 npm：npm ${npmArgs.join(" ")}`;
      job.via = "npm";
      job.command = ["npm", ...npmArgs].join(" ");
      const before = job.output;
      code = await runInstaller(job, "npm", npmArgs, app.home);
      job.output = `${before}\n${job.output}`.slice(-6000);
      forgetAvailability();
      if (code !== 0) job.message = `osdk 没装上（${refused}），npm 也没装上`;
    }
    await settle(app, id, job, code, undefined);
  });
}

const lastLine = (text: string) => text.trim().split(/\r?\n/).at(-1)?.trim().slice(0, 300) ?? "";
