import { reactive } from "vue";
import { get } from "../api";
/** An option of a UiSelect. */
export type SelectOption<T> = { value: T; label: string; hint?: string; group?: string };

/**
 * The owner's operation rules (src/core/config.ts `operationRuleSchema`, docs/v2/command-gate.md) as the
 * settings page shows them: types, how a rule reads in one line, and the choices of a rule's scope.
 */
export type JsonPattern = { jsonPath: string; regex: string };
export type Scope = { members?: string[]; roles?: string[]; spaces?: string[]; backends?: string[] };
export type Match =
  | { kind: "command"; executable: string; subcommand?: string[]; argv?: { index: number; regex: string }[]; argsRegex?: string }
  | { kind: "http"; source?: "agent" | "executor" | "browser"; methods?: string[]; host: string; pathRegex?: string; body?: JsonPattern }
  | { kind: "file"; operations: FileOp[]; pathRegex: string }
  | { kind: "tool"; server?: string; name: string; args?: JsonPattern[] };
export type Kind = Match["kind"];
export type FileOp = "read" | "write" | "delete" | "rename";
export type Action = "allow" | "deny" | "approve" | "log";
export type Approval = { approver?: string; waitSeconds?: number; expiresSeconds?: number; approvers?: string[]; reuse?: "once" | "window" };
export type OperationRule = {
  id: string;
  revision: number;
  enabled: boolean;
  title?: string;
  scope?: Scope;
  match: Match;
  action: Action;
  approval?: Approval;
  pack?: { name: string; version: string; ruleId: string };
  /** Only in what the server returns: what applies the rule (empty: nothing yet). */
  enforcedBy?: string[];
};
/** A rule as a pack defines it (GET /api/security/rule-packs `diff`). */
export type PackRule = Pick<OperationRule, "id" | "title" | "match" | "action" | "approval">;
export type RulePack = {
  id: string;
  source: { type: string; name: string };
  name?: string;
  version: string | null;
  ruleCount: number;
  enabled: boolean;
  installedVersion: string | null;
  scope?: Scope;
  error?: string;
  diff?: { added: PackRule[]; removed: PackRule[]; changed: { before: PackRule; after: PackRule }[]; order: { before: string[]; after: string[] } | null };
  confirmation?: string;
};

export const KINDS: { value: Kind; label: string }[] = [
  { value: "command", label: "命令" },
  { value: "http", label: "HTTP" },
  { value: "file", label: "文件" },
  { value: "tool", label: "工具" },
];
export const kindLabel = (k: Kind) => KINDS.find((x) => x.value === k)?.label ?? k;
/** Who applies a kind of rule, in the owner's words (operation-policy.ts `enforcedBy`). */
export const ENFORCED: Record<Kind, string> = {
  command: "Agent 和它的脚本经 PATH 执行命令时拦下来问，进了沙箱的运行用绝对路径调用也一样；Agent 自己来请求许可时也按它判断",
  file: "Agent 自己来请求读写文件的许可时按它判断",
  tool: "Agent 调用 omem 工具时按它判断",
  http: "Agent 用 aad 操作的浏览器里，页面的请求发出前拦下来问（要带请求闸门的 aad 版本）；不经这个浏览器发出的请求管不到",
};
export const ACTIONS: { value: Action; label: string }[] = [
  { value: "allow", label: "放行" },
  { value: "deny", label: "拒绝" },
  { value: "approve", label: "要批准" },
  { value: "log", label: "只记录" },
];
export const actionLabel = (a: Action) => ACTIONS.find((x) => x.value === a)?.label ?? a;
export const FILE_OPS: { value: FileOp; label: string }[] = [
  { value: "read", label: "读" },
  { value: "write", label: "写" },
  { value: "delete", label: "删" },
  { value: "rename", label: "改名" },
];
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** `$.a.b[0]` as the owner writes it (`a.b[0]`), and back. */
export const fieldOf = (jsonPath: string) => jsonPath.replace(/^\$\.?/, "");
export const jsonPathOf = (field: string) => {
  const f = field.trim();
  return !f ? "" : f.startsWith("$") ? f : f.startsWith("[") ? `$${f}` : `$.${f}`;
};
const bare = (re: string) => re.replace(/^\^/, "").replace(/\$$/, "");

/** What a rule matches, in one line: `acme mr create`, `POST api.example.com/v1/orders`, `写、删 ^/etc/`. */
export function matchText(m: Match): string {
  if (m.kind === "command") {
    const words = [m.executable || "（未填命令）", ...(m.subcommand ?? [])];
    if (m.argsRegex) words.push(`/${m.argsRegex}/`);
    else if (m.argv?.length) words.push("…");
    return words.join(" ");
  }
  if (m.kind === "http") {
    const methods = m.methods?.length ? `${m.methods.join("/")} ` : "";
    return `${methods}${m.host || "（未填主机）"}${m.pathRegex ? bare(m.pathRegex) : ""}${m.body ? ` · ${fieldOf(m.body.jsonPath)} ~ /${m.body.regex}/` : ""}`;
  }
  if (m.kind === "file") return `${m.operations.map((o) => FILE_OPS.find((x) => x.value === o)?.label ?? o).join("、") || "（未选操作）"} ${m.pathRegex || "（未填路径）"}`;
  const args = m.args?.length ? ` · ${m.args.map((a) => `${fieldOf(a.jsonPath)} ~ /${a.regex}/`).join("，")}` : "";
  return `${m.server && m.server !== "omem" ? `${m.server}/` : ""}${m.name || "（未选工具）"}${args}`;
}

/** The choices of a rule's scope, read once for the page. */
export const scopeChoices = reactive({
  members: [] as SelectOption<string>[],
  roles: [] as SelectOption<string>[],
  spaces: [] as SelectOption<string>[],
  approvers: [] as SelectOption<string>[],
  tools: [] as SelectOption<string>[],
  platform: "",
  loaded: false,
});
let loading: Promise<void> | null = null;
export function loadScopeChoices() {
  loading ??= (async () => {
    const [users, roles, specs, spaces, legacy, options] = await Promise.all([
      get<{ id: string; name: string }[]>("/api/users").catch(() => []),
      get<{ name: string; description?: string }[]>("/api/roles").catch(() => []),
      get<{ name: string; description?: string }[]>("/api/agents").catch(() => []),
      get<{ id: string; name: string }[]>("/api/spaces").catch(() => []),
      get<{ approvers: { value: string; label: string }[]; platform: string }>("/api/security/command-rules").catch(() => ({ approvers: [], platform: "" })),
      get<{ tools: { name: string; description: string }[] }>("/api/profile-options").catch(() => ({ tools: [] })),
    ]);
    scopeChoices.members = users.map((u) => ({ value: u.id, label: u.id === "owner" ? `本人（${u.name}）` : u.name, hint: u.id === "owner" ? undefined : u.id }));
    scopeChoices.roles = [
      ...specs.map((s) => ({ value: s.name, label: s.name, hint: "档案", group: "Agent 档案" })),
      ...roles.map((r) => ({ value: r.name, label: r.name, hint: "内置角色", group: "内置角色" })),
    ];
    scopeChoices.spaces = spaces.map((s) => ({ value: s.id, label: s.name, hint: s.id }));
    scopeChoices.approvers = legacy.approvers;
    scopeChoices.platform = legacy.platform;
    scopeChoices.tools = options.tools.map((t) => ({ value: t.name, label: t.name, hint: t.description }));
    scopeChoices.loaded = true;
  })();
  return loading;
}

const SCOPE_PARTS: { key: keyof Scope; unit: string }[] = [
  { key: "members", unit: "个成员" },
  { key: "roles", unit: "个角色或档案" },
  { key: "spaces", unit: "个空间" },
  { key: "backends", unit: "个后端" },
];
/** "所有人", or "2 个成员 · 1 个空间"; `names` for the hover. */
export function scopeText(s: Scope | undefined, backends: SelectOption<string>[] = []): { short: string; full: string } {
  const parts = SCOPE_PARTS.filter((p) => s?.[p.key]?.length);
  if (!parts.length) return { short: "所有人", full: "对所有成员、角色、空间和后端生效" };
  const label = (key: keyof Scope, v: string) =>
    (key === "backends" ? backends : key === "members" ? scopeChoices.members : key === "roles" ? scopeChoices.roles : scopeChoices.spaces).find((o) => o.value === v)?.label ?? v;
  return {
    short: parts.map((p) => `${s![p.key]!.length} ${p.unit}`).join(" · "),
    full: parts.map((p) => `${p.unit.slice(1)}：${s![p.key]!.map((v) => label(p.key, v)).join("、")}`).join("\n"),
  };
}

/** A scope without the empty lists (an empty list would match nobody); undefined when it is everyone. */
export function cleanScope(s: Scope | undefined): Scope | undefined {
  if (!s) return undefined;
  const out: Scope = {};
  for (const { key } of SCOPE_PARTS) if (s[key]?.length) out[key] = [...s[key]!];
  return Object.keys(out).length ? out : undefined;
}

/** How a PUT error (`rules.2.match.argsRegex: 无效的正则表达式`) reads beside the rule it is about. */
const FIELD_NAMES: Record<string, string> = {
  executable: "命令名",
  subcommand: "子命令",
  argv: "按位置的参数",
  argsRegex: "整串参数的正则",
  host: "主机",
  methods: "方法",
  pathRegex: "路径正则",
  body: "请求体字段",
  jsonPath: "字段",
  regex: "正则",
  operations: "操作",
  name: "工具",
  args: "参数字段",
  approval: "批准",
  approver: "谁来批",
  waitSeconds: "等多久",
  title: "说明",
};
const FIELD_RULES: Record<string, string> = {
  executable: "只能是可执行文件名（字母、数字、. _ + -），不带路径",
  host: "只能是主机名，可以用 *.example.com",
  jsonPath: "写字段名，如 target 或 items[0].id",
};
export function rowErrors(message: string): { index: number; text: string }[] | null {
  const out: { index: number; text: string }[] = [];
  for (const part of message.split("; ")) {
    const m = /^rules\.(\d+)\.?([\w.]*): (.*)$/.exec(part);
    if (!m) return null;
    const path = m[2].split(".").filter((p) => !/^\d+$/.test(p));
    const last = path[path.length - 1] ?? "";
    const name = FIELD_NAMES[last] ?? "";
    const rule = FIELD_RULES[last];
    const text = rule && !/[一-鿿]/.test(m[3]) ? rule : m[3];
    out.push({ index: Number(m[1]), text: name ? `${name}：${text}` : text });
  }
  return out;
}
