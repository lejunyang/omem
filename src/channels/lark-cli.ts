import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const exec = promisify(execFile);

let override: ((args: string[], cwd?: string) => Promise<any>) | null = null;
/** Tests: answer lark-cli calls without the CLI. */
export function setLarkCliForTests(fn: ((args: string[], cwd?: string) => Promise<any>) | null) {
  override = fn;
}

function larkCliScript() {
  try {
    return createRequire(import.meta.url).resolve("@larksuite/cli/scripts/run.js");
  } catch {
    throw new Error("未安装 @larksuite/cli；请重新安装 omem 依赖");
  }
}

/** Run lark-cli in the terminal (device-flow login): its prompts and QR code go straight to the user. */
export function larkCliInteractive(args: string[]) {
  if (override) return 0;
  return spawnSync(process.execPath, [larkCliScript(), ...args], { stdio: "inherit", windowsHide: true }).status ?? 1;
}

/** lark-cli's plain-text output (e.g. an ASCII QR code), or null on failure. */
export function larkCliText(args: string[]): string | null {
  if (override) return null;
  const r = spawnSync(process.execPath, [larkCliScript(), ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  return r.status === 0 ? r.stdout : null;
}

/** Run lark-cli with a secret on stdin (never on the command line), output to the terminal. */
export function larkCliWithInput(args: string[], stdin: string) {
  if (override) return 0;
  return spawnSync(process.execPath, [larkCliScript(), ...args], { input: stdin, stdio: ["pipe", "inherit", "inherit"], windowsHide: true }).status ?? 1;
}

/** Run the official lark-cli (bundled npm dependency) and parse its JSON output. */
export async function larkCli(args: string[], timeoutMs = 90_000, cwd?: string): Promise<any> {
  if (override) { const result = await override(args, cwd); assertLarkResult(result); return result; }
  const script = larkCliScript();
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], { timeout: timeoutMs, maxBuffer: 50_000_000, windowsHide: true, cwd });
    const value = JSON.parse(stdout);
    assertLarkResult(value);
    return value;
  } catch (e) {
    const raw = `${(e as { stderr?: string }).stderr ?? ""}${(e as { stdout?: string }).stdout ?? ""}`;
    if (e instanceof Error && !e.message.includes("Command failed")) throw new Error(e.message.slice(0, 300));
    // A failing command still prints its JSON error ({ ok: false, error: { type, message, hint } }); keep what it says.
    let detail = "";
    let hint = "";
    let missing: string[] = [];
    for (const output of [(e as { stderr?: string }).stderr, (e as { stdout?: string }).stdout]) {
      try {
        const match = /\{[\s\S]*\}/.exec(output ?? "")?.[0];
        if (!match) continue;
        const value = JSON.parse(match);
        const v = value.error ?? value;
        detail = [v.type, v.subtype, v.code ?? value.code, v.message ?? v.msg ?? value.msg, v.log_id ?? value.log_id].filter(Boolean).join(" ");
        hint = v.hint ? String(v.hint) : "";
        if (Array.isArray(v.missing_scopes)) missing = v.missing_scopes.filter((x: unknown): x is string => typeof x === "string");
        if (detail) break;
      } catch {}
    }
    // The user token lacks a scope: callers can ask the owner to grant it (lark-auth.ts).
    if (missing.length) throw new LarkScopeError(missing, `飞书 CLI：缺少权限 ${missing.join(" 或 ")}`);
    // A missing permission (scope) is not a missing login, even though both say "unauthorized".
    if (!/scope|permission/i.test(detail) && /keychain|unauthori[sz]ed|not.*logged|auth.*login|token.*expired|credential/i.test(detail || raw))
      throw new Error("飞书登录不可用：请在运行 omem 的电脑上执行 lark-cli auth login 后重试");
    throw new Error(detail ? `飞书 CLI：${redactLarkError(detail).slice(0, 300)}${hint ? `（${redactLarkError(hint).slice(0, 200)}）` : ""}` : "飞书 CLI 调用失败，请检查登录和网络");
  }
}

/** lark-cli said which scopes the call needs (any one of `scopes`). */
export class LarkScopeError extends Error {
  scopes: string[];
  constructor(scopes: string[], message: string) {
    super(message);
    this.scopes = scopes;
  }
}

/** Do not treat a bare API error (exit 0) as successful membership/capture. */
export function assertLarkResult(value: any) {
  if (value?.ok === false || (typeof value?.code === "number" && value.code !== 0)) {
    const error = value.error ?? value;
    if (Array.isArray(error.missing_scopes) && error.missing_scopes.length) throw new LarkScopeError(error.missing_scopes, `飞书 CLI：缺少权限 ${error.missing_scopes.join(" 或 ")}`);
    const message = redactLarkError(String(error.message ?? error.msg ?? value.msg ?? "飞书请求失败"));
    throw new Error([error.code ?? value.code, message.slice(0, 200), error.log_id ?? error.logId].filter(Boolean).join(" "));
  }
}

function redactLarkError(message: string) {
  return message.replace(/(Bearer\s+|(?:[\w-]*(?:token|secret|cookie))["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, "$1[已隐藏]");
}
