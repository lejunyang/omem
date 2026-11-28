/**
 * Commands the owner registers himself (`GET` / `PUT /api/security/protected-commands`, src/core/protected-commands.ts,
 * docs/v2/command-gate.md): inside the sandbox their login directories are hidden, and a call runs in the executor
 * with this identity's own login. Pure: the form's text in, the list the server takes out; the server checks the rest.
 */
export type ProtectedCommand = { name: string; state: string[]; loginEnv: string[] };
export type CommandDraft = { name: string; state: string; loginEnv: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const words = (text: string) => text.split(/[\s,，、]+/).map((w) => w.trim()).filter(Boolean);

export const draftOf = (c?: ProtectedCommand): CommandDraft =>
  ({ name: c?.name ?? "", state: (c?.state ?? []).map((p) => "~/" + p).join("\n"), loginEnv: (c?.loginEnv ?? []).join(", ") });

/**
 * The form as one entry, checked the way the server will check its shape: a command name, login directories
 * relative to the home directory (`~/` is taken off), variable names only. `others` are the other entries, so a
 * name is registered once. Whether a variable is one that carries a login, the server decides.
 */
export function parseCommand(d: CommandDraft, others: ProtectedCommand[]): { command: ProtectedCommand } | { error: string } {
  const name = d.name.trim();
  if (!NAME.test(name)) return { error: "命令名只写程序名，例如 sample-cli（字母、数字、点、横线、下划线）" };
  if (others.some((c) => c.name === name)) return { error: `${name} 已经登记过` };
  const state: string[] = [];
  for (const raw of words(d.state)) {
    const path = raw.replace(/^~\/?/, "").replace(/\/+$/, "");
    if (!path || path.startsWith("/") || /[:\\]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
      return { error: `登录目录写主目录下的路径，例如 ~/.config/sample：${raw}` };
    if (!state.includes(path)) state.push(path);
  }
  const loginEnv: string[] = [];
  for (const key of words(d.loginEnv)) {
    if (!VARIABLE.test(key)) return { error: `变量只写名字，例如 SAMPLE_TOKEN：${key}` };
    if (/^OMEM_/i.test(key)) return { error: `${key} 是 omem 自己的变量` };
    if (!loginEnv.includes(key)) loginEnv.push(key);
  }
  if (state.length > 32 || loginEnv.length > 32) return { error: "登录目录和变量各最多 32 个" };
  return { command: { name, state, loginEnv } };
}

/** One entry in words: where its login lives. */
export function commandSummary(c: ProtectedCommand): string {
  const parts = [
    c.state.length ? `登录目录 ${c.state.map((p) => "~/" + p).join("、")}` : "",
    c.loginEnv.length ? `变量 ${c.loginEnv.join("、")}` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "没有登录目录和变量（只经执行器跑）";
}
