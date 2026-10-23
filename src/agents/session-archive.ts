import type { AgentProfile } from "../core/config.ts";
import { launch, stop } from "./spawn.ts";

/** Catalog/config capability, never a provider-name branch or shell command. */
export async function archiveSession(profile: AgentProfile, sessionId: string, cwd: string, env?: Record<string, string>): Promise<void> {
  if (!profile.archiveArgs?.length) throw new Error("未配置会话归档命令");
  if (!sessionId || sessionId.startsWith("-") || sessionId.includes("\0")) throw new Error("无法归档：无效的会话标识");
  const child = launch(profile.command, [...profile.archiveArgs, sessionId], { cwd, env: { ...profile.env, ...env } });
  child.stdin.end();
  // Drain command output, but do not copy backend configuration or paths into run logs.
  child.stdout.resume();
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { stop(child); reject(new Error("会话归档超时")); }, 5000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`会话归档命令退出码 ${code}`));
    });
  });
}
