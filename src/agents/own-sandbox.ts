import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix } from "node:path";
import type { Config } from "../core/config.ts";
import { installRoot, type SandboxSupport, type WorkspaceMounts } from "./sandbox.ts";

type Settings = Config["agents"]["ownSandbox"];
export const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

// Resolve existing parents too: a directory added later must not turn an alias into a broad grant.
export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = posix.dirname(path);
  return parent === path ? path : posix.join(canonical(parent), posix.basename(path));
}

export function normalizeSandbox(settings: Settings, home: string, data: string, real = canonical): Settings {
  function paths(values: string[], writable: boolean) {
    return [...new Set(values.map(value => {
      const raw = value === "~" || value.startsWith("~/") ? posix.join(home, value.slice(1)) : value;
      if (!posix.isAbsolute(raw) || /[\x00-\x1f]/.test(raw)) throw new Error("目录需要绝对路径或 ~/ 开头的路径");
      const path = real(posix.resolve(raw));
      if (path.length > 1024) throw new Error("规范化后的目录过长");
      if ([real(home), real(data), "/tmp"].some(dir => under(dir, path)) ||
          ["/proc", "/sys", "/dev"].some(dir => under(path, dir)) ||
          (writable && (under(path, real(data)) || ["/usr", "/etc", "/var", "/run", "/opt", "/bin", "/lib", "/sbin", "/boot"].includes(path))))
        throw new Error("不能配置这个沙箱目录：" + path);
      return path;
    }))];
  }
  return { mode: settings.mode, writable: paths(settings.writable, true), hidden: paths(settings.hidden, false) };
}

export const cachePaths = [
  ".cache", // XDG tool and build caches.
  ".npm", // npm's package downloads and npx installations.
  ".local/share/pnpm/store", // pnpm content-addressed package store.
];

export type OwnMountConfig = {
  data: string; home: string; state: string[]; writable: string[]; hidden: string[];
  runtime: string[]; secretEnv: string[]; readOnly: boolean; snapshot?: string; runDir?: string; artifactDir?: string;
};
type Program = { file: string; prefix: string[] };
export type OwnSandbox = OwnMountConfig & { plan: ReturnType<typeof ownMounts> };

export function selectOwnSandbox(mode: Settings["mode"], local: boolean, memberAccount: boolean, probe: () => SandboxSupport) {
  if (mode === "off" || memberAccount) return { active: false };
  if (!local) return { active: false, reason: "云端或其他设备上的运行不在这台的沙箱里" };
  const support = probe();
  if (support.ok) return { active: true };
  const reason = "这台机器不能隔离本次运行：" + support.reason;
  if (mode === "require") throw new Error(reason);
  return { active: false, reason };
}

/** Inputs are host-selected canonical paths. Extra hidden directories take precedence over every grant. */
export function ownMounts(box: OwnMountConfig, cwd: string, workspace?: WorkspaceMounts, artifacts?: string, program?: Program | null): WorkspaceMounts & { hide: string[] } {
  const hide = [box.data, ...box.hidden, "/tmp"];
  const ro = [...(workspace?.ro ?? [])];
  const rw = [...box.state, ...box.writable];
  if (box.runDir) rw.push(box.runDir);
  if (artifacts && canonical(artifacts) === box.artifactDir) rw.push(box.artifactDir);
  if (workspace) rw.push(...workspace.rw);
  if (!workspace || box.snapshot && under(cwd, box.snapshot)) {
    const dest = box.readOnly && !(box.snapshot && under(cwd, box.snapshot)) ? ro : rw;
    if (cwd !== box.data) dest.push(cwd);
  }
  const visible = (path: string) => !box.hidden.some(h => under(path, h));
  const executable = program && canonical(program.file);
  const runtime = [...box.runtime, ...(program && executable ? [program.file, executable, installRoot(executable), ...program.prefix.filter(isAbsolute)] : [])];
  ro.push(...runtime.filter(path => [box.data, "/tmp"].some(root => path !== root && under(path, root)) || rw.some(dir => under(path, dir))));
  return { hide, ro: ro.filter(visible), rw: [...new Set(rw)].filter(p => visible(p) && !ro.some(r => under(p, r))),
    links: workspace?.links?.filter(link => visible(link.path) && visible(link.target)),
    pointers: workspace?.pointers?.filter(pointer => visible(pointer.path)) };
}

export function ownSandboxEnv(base: NodeJS.ProcessEnv, run: NodeJS.ProcessEnv, secretEnv: string[]) {
  const out = { ...base };
  for (const key of Object.keys(out)) if (/^OMEM_/i.test(key)) delete out[key];
  Object.assign(out, run);
  const runKeys = ["OMEM_TOKEN", "OMEM_URL", "OMEM_ARTIFACTS", "OMEM_RUN_DIR", "OMEM_COMMAND_GATE", "OMEM_DESKTOP_TOOLS", "OMEM_BROWSER_PROFILES"];
  for (const key of Object.keys(out)) if (secretEnv.includes(key) || (/^OMEM_/i.test(key) && !runKeys.includes(key))) delete out[key];
  out.TMPDIR = "/tmp";
  return out;
}

export function shortPath(path: string, home = homedir()) {
  return under(path, home) ? "~" + path.slice(home.length) : path;
}

/**
 * Backend mode by role (P = existing per-role selection, F = full). Pairs are outside / inside
 * the machine-login sandbox. The member-account sandbox does not participate.
 *                         per-role    sandboxed    all
 * Owner, writable           P/P         P/F        F/F
 * Owner, read-only; guest   P/P         P/F        P/P
 * Member / borrowed login   P/P         P/P        P/P
 * ACP mutation permission stays at its legacy value except a read-only mount always vetoes it.
 */
export function runAccess(mode: Config["agents"]["fullAccess"], owner: boolean, guest: boolean,
  sandboxed: boolean, writes: boolean, legacyFull: boolean) {
  const force = (mode === "sandboxed" && sandboxed && (owner || guest)) ||
    (mode === "all" && owner && writes && !guest);
  return { force, fullAccess: legacyFull || force, acpWritable: sandboxed && (guest || !writes) ? false : writes || legacyFull };
}
