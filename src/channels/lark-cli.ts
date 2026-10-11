import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Run the official lark-cli (bundled npm dependency) and parse its JSON output. */
export async function larkCli(args: string[], timeoutMs = 90_000): Promise<any> {
  let script: string;
  try {
    script = createRequire(import.meta.url).resolve("@larksuite/cli/scripts/run.js");
  } catch {
    throw new Error("未安装 @larksuite/cli；请重新安装 omem 依赖");
  }
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], { timeout: timeoutMs, maxBuffer: 20_000_000, windowsHide: true });
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
