import { commandMounts, sandboxGate } from "./command-mounts.ts";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, opendirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Starting an agent for one user's own account (docs/v2/agent-accounts.md): inside bubblewrap,
 * with the user's account folder as HOME. The system and the programs are visible read-only; the
 * service's own HOME, omem's data folder and /tmp are replaced by empty ones, so the agent (and every
 * command it runs) sees neither the owner's logins nor another user's account folder. Read-only again
 * inside them: the agent's install, the Node runtime, omem's code (the stdio MCP bridge) and its
 * `bin` (the `omem` shim and the command gate). Writable: the account folder, the run's working folder
 * and the run's artifacts folder. Network-isolated runs reach the proxy through a Unix socket.
 *
 * Linux only, and only with a bubblewrap that can start (unprivileged user namespaces allowed):
 * `sandboxSupport` checks once. Everywhere else members keep borrowing the owner's backends.
 */

export type SandboxSupport = { ok: boolean; bwrap?: string; version?: string; reason?: string };

/** What a run for one user's own account carries on its profile (accounts.ts sets it in prepareRun). */
export type SandboxAccount = {
  guarded?: string;
  privateTmp?: string;
  /** In a borrowed HOME, bind only shared state and create the other required directories privately. */
  borrowed?: { state: string[]; dirs: string[] };
  masked?: string[];
  network?: SandboxNetwork;
  userId: string;
  /** The account backend (catalog id): codex, claude, traex, doubao-cli. */
  backend: string;
  /** The user's account folder: HOME inside the sandbox. */
  home: string;
  /** The catalog's `account.env` expanded, plus the token when the user pasted one. */
  env: Record<string, string>;
  /** Folders replaced by empty ones (omem's data folder; the service's HOME and /tmp are added at launch). */
  hide: string[];
  /** Folders visible read-only even inside the hidden ones (catalog mounts, omem's code and bin). */
  ro: string[];
};

/** The user's own account a profile runs with (set by accounts.ts withAccount), if any. */
export function accountOf(p: object | null | undefined): SandboxAccount | undefined {
  return (p as { ownAccount?: SandboxAccount } | null | undefined)?.ownAccount;
}

/** What tells sessions of different accounts apart in keys: "" for the machine's own login, `acct:<user>` otherwise. */
export function accountTag(p: object | null | undefined): string {
  const a = accountOf(p);
  return a ? `acct:${a.userId}` : "";
}

let cached: SandboxSupport | undefined;

/** Whether this machine can run agents for users' own accounts; checked once per process. */
export function sandboxSupport(): SandboxSupport {
  return (cached ??= detectSandbox());
}

/** Tests: pretend the check came out this way (undefined: check again). */
export function setSandboxSupportForTests(v: SandboxSupport | undefined) {
  cached = v;
  networkSupport = undefined;
}

function onPath(name: string, env: NodeJS.ProcessEnv) {
  for (const d of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const f = join(d, name);
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}

type Exec = (file: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
const exec: Exec = (file, args) => {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** The probe bubblewrap must pass: a new user and PID namespace over a read-only root. */
export const PROBE_ARGS = ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--", "/bin/true"];

export function detectSandbox(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, run: Exec = exec): SandboxSupport {
  if (platform !== "linux") return { ok: false, reason: `沙箱只支持 Linux（这台是${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform}）` };
  const bwrap = env.OMEM_BWRAP || onPath("bwrap", env);
  if (!bwrap) return { ok: false, reason: "没有安装 bubblewrap（bwrap）：用系统的包管理器安装，或 osdk pkg apply" };
  const v = run(bwrap, ["--version"]);
  const version = v.stdout.trim().replace(/^bubblewrap\s*/i, "") || undefined;
  const p = run(bwrap, PROBE_ARGS);
  if (p.status !== 0) {
    const why = (p.error?.message ?? p.stderr.trim()).slice(0, 200) || `退出码 ${p.status}`;
    return { ok: false, bwrap, version, reason: `bubblewrap 起不来（多半是系统没有允许非特权用户命名空间）：${why}` };
  }
  const help = run(bwrap, ["--help"]);
  if (!["--bind-fd", "--ro-bind-fd"].every(flag => (help.stdout + help.stderr).includes(flag)))
    return { ok: false, bwrap, version, reason: "bubblewrap 缺少按文件描述符挂载的能力，需要 --bind-fd 和 --ro-bind-fd" };
  return { ok: true, bwrap, version };
}

const depth = (p: string) => p.split("/").filter(Boolean).length;
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

export type SandboxPlan = {
  privateTmp?: string;
  minimalRoot?: boolean;
  commandMounts?: string[];
  masked?: string[];
  network?: SandboxNetwork;
  /** Empty directories created in the sandbox with mode 0700. */
  privateDirs?: string[];
  /** Replaced by empty folders (tmpfs). */
  hide: string[];
  ro: string[];
  rw: string[];
  /** Host-assigned pool links to recreate inside the private run directory. */
  links?: { path: string; target: string }[];
  pointers?: { source: string; path: string }[];
  cwd: string;
  command: string;
  args: string[];
};

export type WorkspaceMounts = Pick<SandboxPlan, "ro" | "rw" | "links" | "pointers" | "privateTmp">;

/**
 * bubblewrap's arguments for a plan. Pure. Mounts go from the shallowest path to the deepest, so a
 * folder inside a hidden one comes back on top of it and a hidden folder inside a read-only one
 * (omem's data folder inside its checkout) stays hidden; at the same path writable wins. /tmp is
 * always private.
 */
export function bwrapArgs(plan: SandboxPlan, snapshotSources?: Set<string>): string[] {
  const rank = { dir: 0, tmpfs: 1, ro: 2, rw: 3 } as const;
  const ops = new Map<string, { path: string; kind: keyof typeof rank }>();
  const add = (path: string, kind: keyof typeof rank) => {
    const p = posix.normalize(path).replace(/\/+$/, "") || "/";
    if (p === "/" || !p.startsWith("/")) return;
    const old = ops.get(p);
    if (!old || rank[kind] > rank[old.kind]) ops.set(p, { path: p, kind });
  };
  for (const p of plan.privateDirs ?? []) add(p, "dir");
  for (const p of [...plan.hide, "/tmp"]) add(p, "tmpfs");
  for (const p of plan.ro) add(p, "ro");
  for (const p of plan.rw) add(p, "rw");
  // Project the existing names in a read-only parent. Newly created host logins stay
  // outside the run, and no mountpoint has to be created in the real HOME.
  const credentials = [...new Set(plan.masked)].filter(path => !plan.masked?.some(parent => parent !== path && inside(path, parent)));
  const snapshots = new Map<string, "ro" | "rw">();
  const snapshotLinks: string[] = [];
  for (const path of credentials) {
    let parent = dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    const mount = [...ops.values()].filter(op => inside(parent, op.path)).sort((a, b) => b.path.length - a.path.length)[0];
    if (mount ? mount.kind !== "ro" && mount.kind !== "rw" : plan.network || plan.minimalRoot) continue;
    if (parent === "/") throw new Error("根目录下的隐藏登录路径需要已存在的父目录");
    snapshots.set(parent, mount?.kind === "rw" ? "rw" : "ro");
  }
  for (const [parent, access] of [...snapshots].sort(([a], [b]) => depth(a) - depth(b))) {
    ops.set(parent, { path: parent, kind: "tmpfs" });
    const dir = opendirSync(parent);
    try {
      let count = 0;
      for (let entry; (entry = dir.readSync());) {
        if (++count > 4096) throw new Error("登录路径父目录条目过多，请指定专用的登录目录");
        const path = join(parent, entry.name);
        if (ops.has(path) || credentials.includes(path)) continue;
        if (entry.isSymbolicLink()) snapshotLinks.push("--symlink", readlinkSync(path), path);
        else { add(path, access); snapshotSources?.add(path); }
      }
    } finally { dir.closeSync(); }
  }
  const sorted = [...ops.values()].sort((a, b) => depth(a.path) - depth(b.path) || rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
  const mounts = sorted.flatMap(({ kind, path }) => {
    if (kind === "dir") return ["--perms", "0700", "--dir", path];
    if (kind === "tmpfs" && path === "/tmp" && plan.privateTmp) return ["--bind", plan.privateTmp, path];
    if (kind === "tmpfs") return ["--tmpfs", path];
    return [kind === "ro" ? "--ro-bind-try" : "--bind", path, path];
  });
  const links = (plan.links ?? []).flatMap(({ path, target }) => ["--symlink", target, path]);
  const pointers = (plan.pointers ?? []).flatMap(p => ["--ro-bind", p.source, p.path]);
  // Apply credential masks last, including inside writable caches or a mounted account HOME.
  const masks = credentials.flatMap(path => {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return [];
    return stat.isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path];
  });
  const n = plan.network;
  const ca = n?.bundle ? ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO"]
    .flatMap(key => ["--setenv", key, "/tmp/omem-ca.pem"]) : [];
  const relay = n ? [process.execPath, fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./egress-relay.ts" : "./egress-relay.js", import.meta.url)), String(n.callbackPort ?? 0)] : [];
  // A read-only host root still exposes live filesystem sockets. Networked runs start with
  // the runtime directories and explicit run mounts, leaving host service sockets outside.
  const root = n || plan.minimalRoot ? ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].flatMap(p => ["--ro-bind-try", p, p]) : ["--ro-bind", "/", "/"];
  return ["--die-with-parent", "--unshare-pid", "--unshare-user", ...root, "--proc", "/proc", "--dev", "/dev", ...mounts, ...pointers, ...links, ...snapshotLinks, ...masks, ...(plan.commandMounts ?? []),
    ...[...snapshots].flatMap(([p, access]) => access === "ro" ? ["--remount-ro", p] : []),
    ...(n ? ["--unshare-net", "--tmpfs", "/run", ...(n.secrets && existsSync(n.secrets) ? ["--tmpfs", n.secrets] : []), "--ro-bind", n.socket, "/tmp/omem-egress.sock", ...(n.bundle ? ["--ro-bind", n.bundle, "/tmp/omem-ca.pem"] : [])] : []),
    ...ca, "--chdir", plan.cwd, "--", ...relay, plan.command, ...plan.args];
}

export function egressRequested(config: import("../core/config.ts").Config, profile: object, own = false) {
  const mode = config.security.egress.mode;
  if (own) return mode === "all-sandboxed";
  return !!accountOf(profile) && mode !== "off" && (mode === "all-sandboxed" || config.agents.accountIsolation === "require");
}

export type SandboxNetwork = { socket: string; secrets?: string; callbackPort?: number; bundle?: string };
let networkSupport: SandboxSupport | undefined;
export function egressSupport(): SandboxSupport {
  const s = sandboxSupport();
  if (!s.ok || !s.bwrap) return s;
  if (networkSupport) return networkSupport;
  const probe = exec(s.bwrap, ["--unshare-net", ...PROBE_ARGS]);
  return networkSupport = probe.status === 0 ? s : { ok: false, reason: "出网隔离不可用：" + (probe.error?.message ?? probe.stderr.trim()).slice(0, 200) };
}

// Backend API keys and the per-run tool token are needed by the backend itself.
const backendLogin = /^(?:OPENAI|ANTHROPIC|CLAUDE|CODEX|TRAE|DOUBAO|GEMINI)_|^OMEM_TOKEN$/i;
const commandLogin = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY|API_KEY)(?:_|$)|^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|SSH_ASKPASS|GIT_ASKPASS|GIT_CONFIG_.+|GH_.+|GITHUB_.+|GITLAB_.+|GLAB_.+|DOCKER_AUTH_CONFIG|AWS_.+|AZURE_.+|CLOUDSDK_.+|GOOGLE_APPLICATION_CREDENTIALS|KUBECONFIG)$/i;

export const commandCredentialVariable = (key: string) => !backendLogin.test(key) && commandLogin.test(key);

export { sandboxGate };

export function stripCommandLogin(env: NodeJS.ProcessEnv, run: NodeJS.ProcessEnv) {
  for (const key of Object.keys(env)) if (commandCredentialVariable(key)) delete env[key];
  const gate = run.OMEM_COMMAND_GATE;
  if (sandboxGate(gate) && run.GIT_ASKPASS === join(dirname(gate), "git-askpass")) env.GIT_ASKPASS = run.GIT_ASKPASS;
}

/** Variables of the service that do not go into a user's sandbox: credentials, and paths into what is hidden. */
const SECRET = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)|^(?:ANTHROPIC|OPENAI|CLAUDE|CODEX|TRAE|TRAECLI|DOUBAO|GEMINI|GOOGLE|AWS|AZURE|GITHUB|GH|GITLAB|NPM|OMEM|SSH)_/i;

/**
 * The environment inside a user's sandbox. Pure. From the service's own environment: no credentials,
 * nothing pointing into a hidden folder; then what the run sets (its omem token and URL, PATH with the
 * command gate first), then HOME and the account's variables. The Node in use goes first on PATH, so
 * scripts that start with `env node` find it.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, runEnv: Record<string, string | undefined>, acct: Pick<SandboxAccount, "home" | "env">, hidden: string[], nodeBin: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.toUpperCase() === "PATH") continue;
    if (SECRET.test(k)) continue;
    if (v.startsWith("/") && hidden.some((h) => inside(v, h))) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(runEnv)) if (v !== undefined && k.toUpperCase() !== "PATH") out[k] = v;
  const path = runEnv.PATH ?? runEnv.Path ?? base.PATH ?? "";
  out.PATH = [nodeBin, ...path.split(":").filter((d) => d && d !== nodeBin)].join(":");
  out.HOME = acct.home;
  for (const [k, v] of Object.entries(acct.env)) out[k] = v;
  if (sandboxGate(runEnv.OMEM_COMMAND_GATE)) stripCommandLogin(out, runEnv);
  return out;
}

/** The folder a program is installed in: the prefix holding its node_modules (or a pnpm store), else its own folder. */
export function installRoot(file: string): string {
  const parts = file.split("/");
  const i = parts.findIndex((p) => p === "node_modules" || p === ".pnpm");
  return i > 1 ? parts.slice(0, i).join("/") : dirname(file);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** omem's own install (the folder with its package.json), for the stdio MCP bridge and the `omem` shim. */
export function omemInstallDir() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * What `launch` starts instead of the command, for a run of one user's own account: bwrap with
 * the mounts worked out from where the command really lives.
 */
export function sandboxCommand(resolved: { file: string; prefix: string[] }, args: string[], runEnv: Record<string, string | undefined>, cwd: string, acct: SandboxAccount, workspace?: WorkspaceMounts, baseEnv = process.env, snapshotSources?: Set<string>): { file: string; args: string[]; env: Record<string, string> } {
  const s = sandboxSupport();
  if (!s.ok || !s.bwrap) throw new Error(`这台机器不能按账号启动 Agent：${s.reason ?? "没有 bubblewrap"}`);
  const hide = [...new Set([...acct.hide, homedir(), "/tmp"].filter((p) => isAbsolute(p) && existsSync(p)).map(real))];
  const nodeBin = dirname(process.execPath);
  const ro = new Set(acct.ro);
  for (const p of [resolved.file, ...resolved.prefix.filter((a) => isAbsolute(a))]) {
    ro.add(dirname(p));
    ro.add(installRoot(real(p)));
  }
  ro.add(dirname(nodeBin));
  ro.add(installRoot(real(process.execPath)));
  ro.add(omemInstallDir());
  const dependencies = join(omemInstallDir(), "node_modules");
  if (acct.network && existsSync(dependencies)) ro.add(real(dependencies));
  const absolute = [...ro].filter(p => isAbsolute(p));
  const roList = acct.network ? [...new Set([...absolute, ...absolute.map(real)])] :
    absolute.map(real).filter(p => hide.some(h => inside(p, h)));
  const home = real(acct.home);
  const work = workspace?.rw ?? [real(cwd)];
  const rw = acct.borrowed ? work.filter(p => !inside(home, p) && !inside(p, home)) : [home, ...(acct.network && home !== acct.home ? [acct.home] : []), ...work];
  const privateDirs: string[] = [];
  if (acct.borrowed) {
    hide.push(home);
    for (const rel of acct.borrowed.state) {
      const path = resolve(home, rel);
      if (!existsSync(path)) continue;
      if (path === home || !inside(path, home) || realpathSync(path) !== path) throw new Error("出借状态目录越过账号目录或含符号链接");
      rw.push(path);
    }
    for (const rel of acct.borrowed.dirs) {
      const path = resolve(home, rel);
      if (!inside(path, home)) throw new Error("出借运行目录越过账号目录");
      if (path !== home && !rw.some(mount => inside(path, mount))) privateDirs.push(path);
    }
  }
  if (runEnv.OMEM_ARTIFACTS) rw.push(real(runEnv.OMEM_ARTIFACTS));
  return {
    file: s.bwrap,
    args: bwrapArgs({ privateTmp: acct.privateTmp ?? workspace?.privateTmp, commandMounts: commandMounts(runEnv.OMEM_COMMAND_GATE, runEnv.PATH), masked: [...new Set(acct.masked?.flatMap(path => [path, real(path)]))], network: acct.network, hide, privateDirs, ro: [...roList, ...(workspace?.ro ?? [])], rw, links: workspace?.links, pointers: workspace?.pointers, cwd: real(cwd), command: resolved.file, args: [...resolved.prefix, ...args] }, snapshotSources),
    env: sandboxEnv(baseEnv, runEnv, acct, hide, nodeBin),
  };
}
