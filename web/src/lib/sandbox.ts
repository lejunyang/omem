/**
 * The owner's runs in a sandbox on this machine, and the one switch for 完全访问 (`GET` / `PUT
 * /api/security/sandbox`, src/agents/own-run.ts `sandboxStatus`, docs/v2/agent-accounts.md “本人的运行进沙箱”).
 * The server answers with the saved settings (paths already expanded), whether this machine can isolate a
 * run, and what an example run would be allowed to write. Pure: the card hands over what the server said.
 */
export type SandboxMode = "off" | "prefer" | "require";
export type FullAccessMode = "per-role" | "sandboxed" | "all";
export type SandboxStatus = {
  mode: SandboxMode;
  writable: string[];
  hidden: string[];
  fullAccess: FullAccessMode;
  support: { ok: boolean; bwrap?: string; version?: string; reason?: string };
  /** Each local backend profile and the directories (and files) it keeps its state in. */
  backends: { id: string; state: string[] }[];
  defaults: { exampleBackend?: string; writable: string[]; hidden: string[] };
  visibility?: string;
  warning?: string;
};
export type SandboxSettings = { mode: SandboxMode; writable: string[]; hidden: string[]; fullAccess: FullAccessMode };

export const MODES: { value: SandboxMode; label: string; hint: string }[] = [
  { value: "off", label: "关", hint: "运行照原样在这台机器上跑，不进沙箱" },
  { value: "prefer", label: "能用就用", hint: "这台能隔离就进沙箱；不能时在运行开头写明原因，照原样跑" },
  { value: "require", label: "不能用就不启动", hint: "这台隔离不了时，本机的运行直接不启动" },
];
export const FULL_ACCESS: { value: FullAccessMode; label: string; hint: string }[] = [
  { value: "per-role", label: "按角色", hint: "规则、Agent 档案、内置角色和访客各开各的，和以前一样" },
  { value: "sandboxed", label: "进了沙箱的都开", hint: "进了沙箱的运行关掉后端自己的沙箱和审批，边界由上面的沙箱守；只读的角色仍然只读" },
  { value: "all", label: "全部开", hint: "不管进没进沙箱都关掉后端的沙箱和审批；只读的角色和访客除外" },
];

/** What `PUT /api/security/sandbox` takes: the whole setting, and `confirmAll` whenever the result is 全部开. */
export function sandboxBody(s: SandboxSettings, change: Partial<SandboxSettings> = {}) {
  const next = { mode: s.mode, writable: [...s.writable], hidden: [...s.hidden], fullAccess: s.fullAccess, ...change };
  return next.fullAccess === "all" ? { ...next, confirmAll: true } : next;
}

/**
 * The home directory the server's paths are under, read from them (the server does not say it):
 * `/home/<name>`, `/Users/<name>` or `/root`, the one most of the paths share.
 */
export function homeOf(paths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const m = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/.exec(p);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
/** A path under the home directory as `~/…`. */
export function tilde(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/**
 * One line of the default writable list in the owner's words. The example run's own folders under the
 * data directory are named by what they are (every run gets its own); the rest are paths.
 */
export function defaultLabel(path: string, data: string | null, home: string | null): { text: string; path?: string } {
  if (path === "/tmp") return { text: "/tmp", path: "每次运行各自一份，用完就清掉" };
  if (data && path.startsWith(data + "/")) {
    const rest = path.slice(data.length + 1);
    if (/^workspaces\/example(\/|$)/.test(rest)) return { text: "这次运行的工作目录", path: "可写的角色才可写" };
    if (/^runs\/example\/scratch$/.test(rest)) return { text: "这次运行的临时目录", path: "OMEM_RUN_DIR" };
    if (/^artifacts\/inbox\/example$/.test(rest)) return { text: "这次运行的产物目录", path: "OMEM_ARTIFACTS" };
  }
  return { text: tilde(path, home) };
}

/**
 * The default writable list split in two: what every run may write (caches, its own folders), and the
 * backends' state directories, which go in their own fold by backend.
 */
export function splitDefaults(s: Pick<SandboxStatus, "defaults" | "backends" | "writable">) {
  const state = new Set(s.backends.flatMap((b) => b.state));
  const own = new Set(s.writable);
  return {
    common: s.defaults.writable.filter((p) => !state.has(p) && !own.has(p)),
    backends: s.backends.filter((b) => b.state.length),
  };
}

/**
 * A directory typed into one of the two lists, checked the way the server will before it is sent:
 * absolute or `~/`, not empty, not already there, at most 32 and 1024 characters. The server checks the
 * rest (that it exists, that it is not the home or data directory) and its answer shows under the line.
 */
export function checkPath(raw: string, list: string[], home: string | null): { value: string } | { error: string } {
  const value = raw.trim().replace(/(.)\/+$/, "$1");
  if (!value) return { error: "先写一个目录" };
  if (!(value === "~" || value.startsWith("~/") || value.startsWith("/"))) return { error: "写绝对路径，或 ~/ 开头的路径" };
  if (value.length > 1024) return { error: "路径太长（最多 1024 个字符）" };
  const expanded = home && (value === "~" || value.startsWith("~/")) ? home + value.slice(1) : value;
  if (list.some((p) => p === value || p === expanded)) return { error: "已经在清单里" };
  if (list.length >= 32) return { error: "最多 32 个" };
  return { value };
}

/** The sentence about 进了沙箱的都开 when nothing goes into the sandbox. */
export function fullAccessNote(s: Pick<SandboxStatus, "mode" | "fullAccess" | "support">): string {
  if (s.fullAccess !== "sandboxed") return "";
  if (s.mode === "off") return "现在没有运行会进沙箱，这一档等于按角色。";
  if (!s.support.ok) return "这台机器隔离不了，没有运行会进沙箱，这一档在这台等于按角色。";
  return "";
}
