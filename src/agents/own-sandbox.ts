import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import type { Config } from "../core/config.ts";
import type { SandboxSupport, WorkspaceMounts } from "./sandbox.ts";

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

export type OwnSandbox = {
  data: string; home: string; state: string[]; writable: string[]; hidden: string[];
  runtime: string[]; secretEnv: string[]; readOnly: boolean; snapshot?: string;
};

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
export function ownMounts(box: OwnSandbox, cwd: string, workspace?: WorkspaceMounts, artifacts?: string): WorkspaceMounts & { hide: string[] } {
  const hide = [box.data, ...box.hidden, "/tmp"];
  const ro = [...box.runtime, ...(workspace?.ro ?? [])];
  const rw = [...box.state, ...box.writable];
  if (artifacts) rw.push(artifacts);
  if (workspace) rw.push(...workspace.rw);
  if (!workspace || box.snapshot && under(cwd, box.snapshot)) {
    const dest = box.readOnly && !(box.snapshot && under(cwd, box.snapshot)) ? ro : rw;
    dest.push(cwd);
  }
  const visible = (path: string) => !box.hidden.some(h => under(path, h));
  const protectedDirs = ro.filter(path => !rw.includes(path) || box.readOnly);
  return { hide, ro: protectedDirs.filter(visible), rw: [...new Set(rw)].filter(p => visible(p) && !protectedDirs.some(r => under(p, r))),
    links: workspace?.links, pointers: workspace?.pointers };
}

export function ownSandboxEnv(base: NodeJS.ProcessEnv, run: NodeJS.ProcessEnv, secretEnv: string[]) {
  const out = { ...base };
  for (const key of Object.keys(out)) if (/^OMEM_/i.test(key)) delete out[key];
  Object.assign(out, run);
  const runKeys = ["OMEM_TOKEN", "OMEM_URL", "OMEM_ARTIFACTS", "OMEM_COMMAND_GATE", "OMEM_DESKTOP_TOOLS", "OMEM_BROWSER_PROFILES"];
  for (const key of Object.keys(out)) if (secretEnv.includes(key) || (/^OMEM_/i.test(key) && !runKeys.includes(key))) delete out[key];
  out.TMPDIR = "/tmp";
  return out;
}

export function shortPath(path: string, home = homedir()) {
  return under(path, home) ? "~" + path.slice(home.length) : path;
}
