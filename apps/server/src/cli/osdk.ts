import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const osdkInstallHelp =
  "请先按 https://github.com/lejunyang/one-sdk 安装 osdk，确认 osdk --version 可用后重跑本次 omem setup。npm 安装与普通启动不会下载模型。";

export async function probeOsdk(cwd?: string) {
  try {
    const { stdout } = await exec("osdk", ["--version"], {
      cwd,
      timeout: 10_000,
      windowsHide: true,
    });
    return {
      available: true,
      version: stdout.trim(),
      installHelp: osdkInstallHelp,
    };
  } catch (error) {
    const reason = error as NodeJS.ErrnoException & { stderr?: string };
    return {
      available: false,
      error:
        reason.code === "ENOENT"
          ? "找不到 osdk 命令。"
          : `osdk 无法运行：${reason.stderr?.trim() || reason.message}`,
      installHelp: osdkInstallHelp,
    };
  }
}

export async function requireOsdk(cwd?: string) {
  const status = await probeOsdk(cwd);
  if (!status.available) throw Error(`${status.error}\n${status.installHelp}`);
  return status.version!;
}

/** Run explicit setup with progress visible; inference and startup never call it. */
export async function runSetupCommand(
  command: string,
  args: string[],
  cwd: string,
) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["inherit", process.stderr, process.stderr],
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) =>
      reject(Error(`无法启动 ${command}：${error.message}`)),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          Error(
            signal
              ? `${command} 被 ${signal} 中断。`
              : `${command} 退出码为 ${code ?? "未知"}。`,
          ),
        );
    });
  });
}
