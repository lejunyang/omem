/**
 * Credentials on the account page, the members page and 设置 → 安全 (src/agents/credentials.ts,
 * docs/v2/credentials.md): one authorization that supplies several AI backends and command-line tools,
 * one hold per person and kind, lent to whom its holder says. Pure: the pages pass in what the server
 * answered and the time.
 */
export type CredentialState = "unknown" | "none" | "ok" | "expiring" | "expired" | "logging-in";
export type SharingScope = "self" | "members" | "all";
export type Sharing = { scope: SharingScope; members: string[] };
/** `credentials.lending`: lend as each holder says, ask the holder each time, or not at all. */
export type Lending = "auto" | "confirm" | "off";
/** `agents.accountsDefault`: a member's run on a backend they have not logged in to. */
export type AccountsDefault = "owner" | "own" | "own-or-other";

/** One kind as `GET /api/credentials` lists it for the caller (`viewOf`). */
export type Credential = {
  kind: string;
  plugin: string;
  name: string;
  describe: string;
  required: boolean;
  state: CredentialState;
  user?: string;
  /** Milliseconds since the epoch. */
  expiresAt?: number;
  checkedAt?: string;
  error?: string;
  sharing: Sharing;
  /** Backend ids and command names it supplies. */
  backends: string[];
  commands: string[];
  /** Whether it can be logged in to here (a member on a machine with the sandbox). */
  login: boolean;
  /** The owner's: the login already on this machine. */
  machine: boolean;
  url?: string;
  code?: string;
  reason?: string;
  missingInstall: string[];
  /** How the administrator lends (not sent by the first phase's server: then nothing is said about it). */
  lending?: Lending;
};
/** One person's holds as `GET /api/credentials/all` lists them (the owner's overview). */
export type HolderRow = { userId: string; name: string; credentials: Omit<Credential, "url" | "code">[] };
export type CredentialOverview = { kinds: { kind: string; name: string }[]; people: HolderRow[]; limit: number };

export const STATE_LABEL: Record<CredentialState, string> = { unknown: "状态未知", none: "没登录", ok: "有效", expiring: "快到期", expired: "过期", "logging-in": "登录中" };
export function stateLabel(c: Pick<Credential, "machine" | "state">) {
  return c.machine && c.state === "none" ? "没登录（已停止出借）" : STATE_LABEL[c.state];
}
/** The status colour: valid is ok, soon to end is warn, ended is danger, a login going on is accent. */
export function stateTone(s: CredentialState): "ok" | "warn" | "danger" | "accent" | "muted" {
  return s === "ok" ? "ok" : s === "expiring" ? "warn" : s === "expired" ? "danger" : s === "logging-in" ? "accent" : "muted";
}

/** “3 天” / “5 小时” / “12 分钟”: how far a moment is from now, rounded. */
export function span(ms: number) {
  const a = Math.abs(ms) / 1000;
  if (a < 60) return "1 分钟";
  return a < 3600 ? `${Math.round(a / 60)} 分钟` : a < 86400 ? `${Math.round(a / 3600)} 小时` : `${Math.round(a / 86400)} 天`;
}
/** When it ends, as one says it: “2 天后到期”, “3 小时前过期”; nothing when it has no end or no login. */
export function expiryText(c: { state: CredentialState; expiresAt?: number }, now = Date.now()): string {
  if (c.expiresAt === undefined || c.state === "unknown" || c.state === "none" || c.state === "logging-in") return "";
  const left = c.expiresAt - now;
  return left > 0 ? `${span(left)}后到期` : `${span(left)}前过期`;
}

/** The element id of a kind's row on the account page (a kind is `<plugin>:<id>`). */
export const credAnchor = (kind: string) => `cred-${kind.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** A required one that is not logged in (the warm “必做” mark: something for this person to do). */
export function needsAction(c: Pick<Credential, "required" | "state" | "machine">) {
  return c.required && !c.machine && (c.state === "none" || c.state === "expired");
}

export const SCOPE_LABEL: Record<SharingScope, string> = { self: "只给自己", members: "指定成员", all: "所有成员" };
/** Who may borrow it, in words: “只给自己”, “所有成员”, “小王、小李”. */
export function sharingText(s: Sharing, name: (id: string) => string = (id) => id): string {
  if (s.scope !== "members") return SCOPE_LABEL[s.scope];
  return s.members.length ? s.members.map(name).join("、") : "还没选人";
}
/** The same as a line in the owner's overview: “不借出”, “借给所有成员”, “借给 小王、小李”. */
export function lentTo(s: Sharing, name: (id: string) => string = (id) => id): string {
  if (s.scope === "self") return "不借出";
  if (s.scope === "all") return "借给所有成员";
  return s.members.length ? `借给 ${sharingText(s, name)}` : "指定成员，还没选人";
}
/** The request body of `PUT /api/credentials/:kind/sharing`: members only with that scope, each once. */
export function sharingBody(scope: SharingScope, members: string[] = []): Sharing {
  return { scope, members: scope === "members" ? [...new Set(members)] : [] };
}
/** What saving it says. */
export function sharingSaved(s: Sharing, name: (id: string) => string = (id) => id) {
  if (s.scope === "self") return "已保存：只给你自己用";
  if (s.scope === "all") return "已保存：所有成员都能借";
  return s.members.length ? `已保存：${sharingText(s, name)}能借` : "已保存：还没选人，现在谁也借不到";
}

/** What it covers, by name: the backends' names where they are known, the commands as they are. */
export function coverage(c: Pick<Credential, "backends" | "commands">, backendName: (id: string) => string = (id) => id) {
  return { backends: c.backends.map(backendName), commands: c.commands, count: c.backends.length + c.commands.length };
}

/**
 * The credential that supplies a backend on “我的 AI 账号”: the one it says logged it in (`method` is the
 * kind), else one covering it that is logged in or was (its files are the credential's, so the backend
 * cannot be logged out of alone). Null: the backend's own login, logged out of as before.
 */
export function suppliedBy<C extends Pick<Credential, "kind" | "backends" | "state">>(b: { id: string; method?: string }, list: C[]): C | null {
  return list.find((c) => c.kind === b.method) ?? list.find((c) => c.backends.includes(b.id) && c.state !== "none" && c.state !== "unknown") ?? null;
}

/**
 * Whether a login going on can be stopped from the page: stopping it is `DELETE`, which also logs out of
 * a login there was before (a re-authorization), so only a first login is offered 取消.
 */
export function canCancel(c: Pick<Credential, "state" | "user" | "expiresAt">) {
  return c.state === "logging-in" && !c.user && c.expiresAt === undefined;
}

/** The kinds whose login finished between two reads, and how. */
export function settled(before: Pick<Credential, "kind" | "state">[], after: Pick<Credential, "kind" | "state" | "name" | "error">[]) {
  const was = new Map(before.map((c) => [c.kind, c.state]));
  return after.filter((c) => was.get(c.kind) === "logging-in" && c.state !== "logging-in").map((c) => ({ kind: c.kind, name: c.name, ok: c.state === "ok" || c.state === "expiring", error: c.error }));
}

/** The people one can lend to: active persons other than oneself and the owner, by name. */
export function lendCandidates(users: { id: string; name: string; role: string; status?: string; disabledAt?: string | null }[], self: string) {
  return users
    .filter((u) => u.id !== self && u.role !== "owner" && !u.disabledAt && (u.status ?? "active") === "active")
    .map((u) => ({ value: u.id, label: u.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh"));
}

/** What the lending mode means for a holder looking at their own (empty when the server does not say). */
export function lendingNote(l?: Lending) {
  return l === "off" ? "管理员关了出借" : l === "confirm" ? "别人要用时会先问你" : "";
}
export const LENDING: { value: Lending; label: string; hint: string }[] = [
  { value: "auto", label: "直接借", hint: "按各人的出借设置直接借，不再问" },
  { value: "confirm", label: "先问持有人", hint: "只读命令通过权限预检后，持有人可在十分钟内同意这一次或这次任务。AI 后端只用自己的登录" },
  { value: "off", label: "不借", hint: "只用自己的；没有就提示去登录或申请权限" },
];
export const ACCOUNTS_DEFAULT: { value: AccountsDefault; label: string; hint: string }[] = [
  { value: "owner", label: "可以借", hint: "成员自己没登录时，按上面的出借方式借别人的登录" },
  { value: "own", label: "必须自己登录", hint: "成员自己没登录时，这个后端用不了，提示他去登录" },
  { value: "own-or-other", label: "换别的后端", hint: "成员自己没登录时，换一个他登录过的后端，都没有才失败" },
];

/**
 * The owner's overview as lines, a person's first line carrying the name: filtered by a name typed in,
 * the people with something wrong (expired, soon to end) first, then by name.
 */
export function overviewLines(o: CredentialOverview, query = "") {
  const q = query.trim().toLowerCase();
  const rank = (p: HolderRow) => (p.credentials.some((c) => c.state === "expired") ? 0 : p.credentials.some((c) => c.state === "expiring") ? 1 : 2);
  return o.people
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.userId.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || Number(b.userId === "owner") - Number(a.userId === "owner") || a.name.localeCompare(b.name, "zh"))
    .flatMap((p) => p.credentials.map((c, i) => ({ key: `${p.userId}|${c.kind}`, person: p, first: i === 0, c })));
}
