import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
const exec = promisify(execFile);
import { packageRoot as root, defaultDataDir, configPath } from "./paths.js";
import { readLoggingSettings, serviceLogPaths } from "./logging/files.js";
export async function manageService(
  action: "start" | "stop" | "restart" | "status",
) {
  if (!["start", "stop", "restart", "status"].includes(action))
    throw Error("支持 start、stop、restart、status");
  const data = defaultDataDir();
  const home = join(data, "service", "pm2");
  const name = "omem";
  const node = process.versions.bun
    ? (await exec("node", ["-p", "process.execPath"])).stdout.trim()
    : process.execPath;
  const pm2 = createRequire(import.meta.url).resolve("pm2/bin/pm2");
  const env = { ...process.env, PM2_HOME: home, PM2_SILENT: "true" };
  async function command(args: string[], cwd = root) {
    return (
      await exec(node, [pm2, ...args], {
        cwd,
        env,
        timeout: 60_000,
        maxBuffer: 2_000_000,
      })
    ).stdout;
  }
  async function daemonAlive() {
    try {
      const pid = Number(await readFile(join(home, "pm2.pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  async function managed() {
    if (!(await daemonAlive())) return null; // status must not start a daemon.
    const apps = JSON.parse(await command(["jlist"]));
    return apps.find((p: { name: string }) => p.name === name) ?? null;
  }
  async function rotation() {
    if (!(await daemonAlive())) return null;
    const apps = JSON.parse(await command(["jlist"]));
    return (
      apps.find((p: { name: string }) => p.name === "pm2-logrotate") ?? null
    );
  }
  const logSettings = readLoggingSettings();
  async function ensureRotation() {
    try {
      let module = await rotation();
      const installed = createRequire(import.meta.url).resolve("pm2-logrotate");
      if (module && module.pm2_env?.pm_exec_path !== installed) {
        await command(["delete", "pm2-logrotate"]);
        module = null;
      }
      if (!module) {
        // Only '.' takes PM2's local module path. An absolute path would call
        // npm install and could download unpinned dependencies at service start.
        const directory = dirname(
          createRequire(import.meta.url).resolve("pm2-logrotate/package.json"),
        );
        await command(["install", "."], directory);
        module = await rotation();
      }
      if (!module) throw Error("LOG_ROTATION_NOT_STARTED");
      const values = {
        max_size: `${logSettings.maxSizeMB}M`,
        retain: String(logSettings.retain),
        compress: "true",
        workerInterval: "10",
        rotateInterval: "0 0 * * *",
        rotateModule: "true",
      };
      for (const [key, value] of Object.entries(values))
        await command(["set", `pm2-logrotate:${key}`, value]);
      module = await rotation();
      // PM2 local install enables development watching; disable it for the
      // immutable package. restart --watch toggles the current watch setting.
      await command([
        "restart",
        "pm2-logrotate",
        ...(module?.pm2_env?.watch ? ["--watch"] : []),
      ]);
      if ((await rotation())?.pm2_env?.status !== "online")
        throw Error("LOG_ROTATION_NOT_ONLINE");
    } catch {
      throw Error(
        "日志轮换未能启动，本次启动或重启未完成。请检查安装包中的 pm2-logrotate 和当前个人目录的 PM2 日志，再重试 omem service start。",
      );
    }
  }
  const address = `http://${process.env.OMEM_HOST === "0.0.0.0" ? "127.0.0.1" : process.env.OMEM_HOST || "127.0.0.1"}:${process.env.OMEM_PORT || 4317}`;
  async function health(url: string) {
    try {
      const r = await fetch(url + "/api/health", {
        headers: process.env.OMEM_TOKEN
          ? { Authorization: `Bearer ${process.env.OMEM_TOKEN}` }
          : {},
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok)
        return { reachable: true, healthy: false, httpStatus: r.status };
      const body = await r.json();
      return { reachable: true, healthy: body.status === "ok", body };
    } catch {
      return { reachable: false, healthy: false };
    }
  }
  let app = await managed();
  if (action === "start" || action === "restart") {
    if (!existsSync(configPath()))
      throw Error(
        "尚未初始化配置；先运行 omem init（开发环境可用 osdk 管理的 bun 执行 apps/server/src/cli.ts init）",
      );
    const { loadConfig } = await import("./config.js");
    loadConfig();
    if (!existsSync(join(root, "dist/apps/server/src/main.js")))
      throw Error("安装包缺少服务构建产物；开发环境请先运行 osdk run build");
    if (!app && (await health(address)).reachable)
      throw Error(
        "目标地址已有服务。请先停止该实例或用 OMEM_PORT 指定另一个端口，避免重复采集。",
      );
    if (action === "start" && app?.pm2_env?.status === "online") {
      // Keep the already-running instance and its configuration.
      await ensureRotation();
    } else {
      await ensureRotation();
      await mkdir(home, { recursive: true, mode: 0o700 });
      const file = join(data, "service", "ecosystem.json");
      await writeFile(
        file,
        JSON.stringify({
          apps: [
            {
              name,
              cwd: root,
              script: join(root, "dist/apps/server/src/main.js"),
              interpreter: node,
              instances: 1,
              exec_mode: "fork",
              autorestart: true,
              watch: false,
              min_uptime: "10s",
              max_restarts: 10,
              exp_backoff_restart_delay: 1000,
              kill_timeout: 30_000,
              out_file: serviceLogPaths(data).files[0],
              error_file: serviceLogPaths(data).files[1],
              merge_logs: true,
              time: false,
              env: {
                NODE_ENV: "production",
                OMEM_DATA_DIR: data,
                OMEM_CONFIG: configPath(),
                OMEM_PORT: process.env.OMEM_PORT || "4317",
                OMEM_HOST: process.env.OMEM_HOST || "127.0.0.1",
                OMEM_LOG_LEVEL: logSettings.level,
              },
            },
          ],
        }),
        { mode: 0o600 },
      );
      await command(["startOrRestart", file, "--only", name, "--update-env"]);
    }
  } else if (action === "stop") {
    if (app) await command(["stop", name]);
    if (await rotation()) await command(["stop", "pm2-logrotate"]);
  }
  app = await managed();
  const port = app?.pm2_env?.env?.OMEM_PORT ?? app?.pm2_env?.OMEM_PORT;
  const host = app?.pm2_env?.env?.OMEM_HOST ?? app?.pm2_env?.OMEM_HOST;
  const url =
    app && port
      ? `http://${!host || host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
      : address;
  let check = await health(url);
  if (["start", "restart"].includes(action)) {
    for (let i = 0; !check.healthy && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      check = await health(url);
    }
  }
  const result = {
    manager: "pm2",
    state: app?.pm2_env?.status ?? "not_managed",
    pid: app?.pid || null,
    restarts: app?.pm2_env?.restart_time ?? 0,
    startedAt: app?.pm2_env?.pm_uptime
      ? new Date(app.pm2_env.pm_uptime).toISOString()
      : null,
    url,
    health: check,
    logs: home + "/logs",
    logLevel:
      app?.pm2_env?.env?.OMEM_LOG_LEVEL ??
      app?.pm2_env?.OMEM_LOG_LEVEL ??
      logSettings.level,
    logFiles: serviceLogPaths(data).files,
    logRotation: {
      active: (await rotation())?.pm2_env?.status === "online",
      maxSizeMB: logSettings.maxSizeMB,
      retain: logSettings.retain,
      compress: true,
    },
    bootAutoStart: false,
  };
  return result;
}
export function formatServiceStatus(
  result: Awaited<ReturnType<typeof manageService>>,
) {
  return `服务：${result.state} · PID ${result.pid ?? "—"} · 重启 ${result.restarts} 次\n接口：${result.health.healthy ? "正常" : "未通过检查"} · ${result.url}\n日志：${result.logs} · ${result.logLevel}\n轮换：${result.logRotation.active ? "运行中" : "未运行"} · ${result.logRotation.maxSizeMB} MB / 文件 · 保留 ${result.logRotation.retain} 份\n未安装系统开机自启动；电脑休眠时无法执行定时任务。`;
}
