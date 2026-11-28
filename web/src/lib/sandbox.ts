/**
 * The owner's runs in a sandbox on this machine, and the one switch for 完全访问 (`GET` / `PUT
 * /api/security/sandbox`, src/agents/own-run.ts `sandboxStatus`, docs/v2/agent-accounts.md “本人的运行进沙箱”).
 * The server answers with the saved settings (paths already expanded), whether this machine can isolate a
 * run, and what an example run would be allowed to write. Pure: the card hands over what the server said.
 */
export type SandboxMode = "off" | "prefer" | "require";
export type FullAccessMode = "per-role" | "sandboxed" | "all";
export type FullAccessGrants = { roles: { id: string; name: string }[]; profiles: { id: string; name: string }[]; rules: { id: string; name: string }[] };
export type SandboxStatus = {
  mode: SandboxMode;
  /** The server's home directory, already resolved: paths under it are shown as `~/…`. */
  home?: string;
  /** What has 完全访问 switched on by itself (a built-in role, an Agent 档案, a rule). */
  fullAccessGrants?: FullAccessGrants;
  writable: string[];
  hidden: string[];
  fullAccess: FullAccessMode;
  support: { ok: boolean; bwrap?: string; version?: string; reason?: string };
  /** Each local backend profile and the directories (and files) it keeps its state in. */
  backends: { id: string; state: string[] }[];
  /**
   * `hidden`: the data directory first, then the command state the trusted credential plugins declare.
   * `loginPaths`: the built-in list of login files and browser profiles hidden from the Agent.
   */
  defaults: { exampleBackend?: string; writable: string[]; hidden: string[]; loginPaths?: string[] };
  /** The owner's own list of login paths, replacing the built-in one (`[]`: none). */
  loginPaths?: string[];
  /** Only these run kinds go in (empty or absent: all); `excludeKinds` wins. */
  includeKinds?: string[];
  excludeKinds?: string[];
  visibility?: string;
  warning?: string;
  /** Whether this machine can give runs a copy-on-write HOME (src/agents/sandbox-home.ts); when not, HOME is read-only. */
  overlay?: { ok: boolean; reason?: string };
  /** Each identity's HOME layer (`owner` or a member's id) and its size; cleared with `DELETE /api/security/sandbox/layers/:identity`. */
  layers?: { identity: string; bytes: number }[];
};
export type SandboxSettings = { mode: SandboxMode; writable: string[]; hidden: string[]; fullAccess: FullAccessMode; includeKinds?: string[]; excludeKinds?: string[] };

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
 * What has 完全访问 switched on by itself under 按角色, each linked to where it is changed: built-in
 * roles and Agent 档案 on the Agent page, rules on the rules page.
 */
export function grantLinks(g: FullAccessGrants | undefined): { kind: string; id: string; name: string; title: string; to: { path: string; query: Record<string, string> } }[] {
  if (!g) return [];
  return [
    // A built-in role is known by its name (the Agent page lists it so); what the server sends as its name is what it does.
    ...g.roles.map((r) => ({ kind: "内置角色", id: r.id, name: r.id, title: r.name, to: { path: "/agents", query: { role: r.id } } })),
    ...g.profiles.map((p) => ({ kind: "Agent 档案", ...p, title: p.id, to: { path: "/agents", query: { name: p.id } } })),
    ...g.rules.map((r) => ({ kind: "规则", ...r, title: r.name, to: { path: "/rules", query: { id: r.id } } })),
  ];
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
  if (path === "/tmp") return { text: "/tmp", path: "按这件事保留：同一会话、交办或事项的各轮共用一份，久不用就清掉" };
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

/** A line of the default hidden list in the owner's words: the data directory, or a plugin command's login. */
export const hiddenLabel = (path: string, data: string | null) => (path === data ? "omem 的数据目录" : "插件命令的登录");

/** The run kinds to pick from: those the page has a name for, then any saved kind it has none for. */
export function kindOptions(labels: Record<string, string>, saved: string[]): { value: string; label: string; hint?: string }[] {
  const named = Object.entries(labels).map(([value, label]) => ({ value, label, hint: value }));
  return [...named, ...saved.filter((k) => !Object.hasOwn(labels, k)).map((k) => ({ value: k, label: k }))];
}

/** A size in the units people read (1.5 MB). */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** The HOME layers, largest first, each named for the person it belongs to (the owner as 你). */
export function layerRows(layers: SandboxStatus["layers"], names: Record<string, string>): { identity: string; name: string; size: string }[] {
  return [...(layers ?? [])].sort((a, b) => b.bytes - a.bytes).map((l) => ({
    identity: l.identity, name: l.identity === "owner" ? "你" : names[l.identity] ?? l.identity, size: fmtBytes(l.bytes),
  }));
}
