import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";
import type { Config } from "../core/config.ts";
import { stripCommandLogin, installRoot, type SandboxNetwork, type WorkspaceMounts } from "./sandbox.ts";

type Settings = Config["agents"]["ownSandbox"];
export const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

// Resolve existing parents too: a directory added later must not turn an alias into a broad grant.
export function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  // A Windows drive path (a member's account folder on a Windows host) splits by its own rules; the sandbox's POSIX paths keep posix's.
  const p = process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(path) ? win32 : posix;
  const parent = p.dirname(path);
  return parent === path ? path : p.join(canonical(parent), p.basename(path));
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
  return { ...settings, writable: paths(settings.writable, true), hidden: paths(settings.hidden, false),
    ...(settings.loginPaths && { loginPaths: paths(settings.loginPaths, false) }) };
}

// Standard logins with an unambiguous CLI owner. Other commands can declare their state through a plugin.
const sshLogin = [".ssh"];
export const standardCommandLogins: ReadonlyMap<string, readonly string[]> = new Map([
  ["ssh", sshLogin], ["scp", sshLogin], ["sftp", sshLogin],
  ["gh", [".config/gh"]], ["glab", [".config/glab-cli"]],
  ["aws", [".aws"]], ["az", [".azure"]], ["gcloud", [".config/gcloud"]], ["kubectl", [".kube"]],
  ["docker", [".docker/config.json"]],
  ["lark-cli", [".lark-cli", ".local/share/lark-cli"]],
]);
export const gitLoginPaths = [".ssh", ".gitconfig", ".config/git/config", ".git-credentials", ".config/git/credentials", ".netrc", ".config/gh"];
export const defaultLoginPaths = [...new Set([
  ...gitLoginPaths, ...[...standardCommandLogins.values()].flat(), ".gnupg", ".authinfo",
  ".config/google-chrome", ".config/chromium", ".config/microsoft-edge", ".mozilla/firefox", ".config/mozilla/firefox",
  ".terraform.d/credentials.tfrc.json", ".npmrc", ".pypirc",
])].map(path => "~/" + path).concat(["/run/docker.sock", "/run/podman/podman.sock", "/run/systemd/private", "/run/dbus/system_bus_socket"]);

export type OwnMountConfig = {
  dataView?: ReturnType<typeof import("./sandbox-data.ts").sandboxData>;
  homeStore?: import("./sandbox-home.ts").HomeStore; onSandboxStatus?: (message: string) => void;
  data: string; home: string; state: string[]; stateFiles?: string[]; writable: string[]; hidden: string[];
  isolatedNetwork?: boolean; network?: SandboxNetwork; masked?: string[]; runtime: string[]; secretEnv: string[]; readOnly: boolean; snapshot?: string; runDir?: string; artifactDir?: string;
};
type Program = { file: string; prefix: string[] };
export type OwnSandbox = OwnMountConfig & { guarded?: string; plan: ReturnType<typeof ownMounts> };

/** Inputs are host-selected canonical paths. Extra hidden directories take precedence over every grant. */
export function ownMounts(box: OwnMountConfig, cwd: string, workspace?: WorkspaceMounts, artifacts?: string, program?: Program | null): WorkspaceMounts & { hide: string[]; masked?: string[]; work: WorkspaceMounts } {
  const hide = [box.data, ...box.hidden, "/tmp"];
  const ro = [...(workspace?.ro ?? [])];
  const workRw = [...box.writable];
  if (box.runDir) workRw.push(box.runDir);
  if (artifacts && canonical(artifacts) === box.artifactDir) workRw.push(box.artifactDir);
  if (workspace) workRw.push(...workspace.rw);
  if (!workspace || box.snapshot && under(cwd, box.snapshot)) {
    const dest = box.readOnly && !(box.snapshot && under(cwd, box.snapshot)) ? ro : workRw;
    if (cwd !== box.data) dest.push(cwd);
  }
  const state = [...box.state, ...(box.stateFiles ?? [])];
  const rw = [...state, ...workRw];
  const roots = [...ro, ...workRw].filter(path => ![box.data, box.home, "/tmp"].some(dir => under(dir, path)));
  const protectedPaths = [...box.hidden, ...(box.masked ?? [])];
  const visible = (path: string) => !protectedPaths.some(h => under(path, h));
  const executable = program && canonical(program.file);
  const runtime = [...box.runtime, ...(program && executable ? [program.file, executable, installRoot(executable), ...program.prefix.filter(isAbsolute)] : [])];
  if (box.isolatedNetwork && runtime.some(path => [box.home, box.data, "/tmp"].some(dir => under(dir, path))))
    throw new Error("后端运行目录过宽，不能挂入出网隔离沙箱");
  ro.push(...(box.isolatedNetwork ? runtime.map(canonical) : runtime.filter(path => [box.data, "/tmp"].some(root => path !== root && under(path, root)) || rw.some(dir => under(path, dir)))));
  // /tmp itself is private tmpfs, including when it is the working directory.
  const bindable = (path: string) => path !== "/tmp" && visible(path);
  const readOnly = ro.filter(bindable);
  const writable = [...new Set(rw)].filter(p => bindable(p) && !readOnly.some(r => under(p, r)));
  const links = (workspace?.links ?? []).filter(link => visible(link.path) && visible(link.target));
  const pointers = workspace?.pointers?.filter(pointer => visible(pointer.path));
  const workRoots = roots.filter(path => bindable(path) && !state.some(dir => under(path, dir)));
  const shared = (path: string) => workRoots.some(root => under(path, root)) && !state.some(dir => under(path, dir));
  const sharedRo = [...readOnly.filter(shared), ...workRoots.filter(path => readOnly.some(root => under(path, root)))];
  const work = { rw: writable.filter(shared), ro: [...new Set(sharedRo)], links, pointers };
  return { hide, masked: box.masked, ro: readOnly, rw: writable, work, pointers,
    links: box.isolatedNetwork && homedir() !== box.home ? [...links, { path: homedir(), target: box.home }] : links };
}

export function ownSandboxEnv(base: NodeJS.ProcessEnv, run: NodeJS.ProcessEnv, secretEnv: string[]) {
  const out = { ...base };
  for (const key of Object.keys(out)) if (/^OMEM_/i.test(key)) delete out[key];
  Object.assign(out, run);
  const runKeys = ["OMEM_TOKEN", "OMEM_URL", "OMEM_ARTIFACTS", "OMEM_RUN_DIR", "OMEM_COMMAND_GATE", "OMEM_DESKTOP_TOOLS", "OMEM_BROWSER_PROFILES", "OMEM_BROWSER_PROXY"];
  for (const key of Object.keys(out)) if (secretEnv.includes(key) || (/^OMEM_/i.test(key) && !runKeys.includes(key))) delete out[key];
  stripCommandLogin(out, run);
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
export function runAccess(mode: Config["agents"]["fullAccess"], run: {
  owner: boolean; guest?: boolean; box?: Pick<OwnSandbox, "readOnly">; allowWrites: boolean; legacyFull?: boolean;
}) {
  const force = (mode === "sandboxed" && !!run.box && (run.owner || run.guest)) ||
    (mode === "all" && run.owner && run.allowWrites && !run.box?.readOnly && !run.guest);
  // Doubao historically granted always_allow to writable roles, independent of the per-role full switch.
  const doubaoPermission = run.allowWrites || force ? "always_allow" : "ask_risky";
  return { fullAccess: !!run.legacyFull || !!force, doubaoPermission,
    acpWritable: !run.box?.readOnly && (run.allowWrites || !!run.legacyFull) } as const;
}
