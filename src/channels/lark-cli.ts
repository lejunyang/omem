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
  if (override) return override(args, cwd);
  const script = larkCliScript();
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], { timeout: timeoutMs, maxBuffer: 50_000_000, windowsHide: true, cwd });
    const value = JSON.parse(stdout);
    if (value.ok === false) throw new Error(value.error?.message || "飞书读取失败");
    return value;
  } catch (e) {
    const raw = `${(e as { stderr?: string }).stderr ?? ""}${(e as { stdout?: string }).stdout ?? ""}`;
    if (/keychain|unauthori[sz]ed|not.*logged|auth.*login|token.*expired|credential/i.test(raw))
      throw new Error("飞书登录不可用：请在运行 omem 的电脑上执行 lark-cli auth login 后重试");
    throw new Error(e instanceof Error && !e.message.includes("Command failed") ? e.message.slice(0, 300) : "飞书 CLI 调用失败，请检查登录和网络");
  }
}
