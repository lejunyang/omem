import { taskFlag } from "./task-args.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const action = process.argv[2] ?? "status";
if (!["start", "stop", "restart", "status"].includes(action))
  throw Error("支持 start、stop、restart、status");
const data = resolve(process.env.OMEM_DATA_DIR || join(root, ".omem"));
const home = join(data, "service", "pm2");
const name = "omem";
const node = (await exec("node", ["-p", "process.execPath"])).stdout.trim();
const pm2 = createRequire(import.meta.url).resolve("pm2/bin/pm2");
const env = { ...process.env, PM2_HOME: home, PM2_SILENT: "true" };
async function command(args: string[]) {
  return (
    await exec(node, [pm2, ...args], {
      cwd: root,
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
const address =
  process.env.OMEM_URL ||
  `http://${process.env.OMEM_HOST === "0.0.0.0" ? "127.0.0.1" : process.env.OMEM_HOST || "127.0.0.1"}:${process.env.OMEM_PORT || 4317}`;
async function health(url: string) {
  try {
    const r = await fetch(url + "/api/health", {
      headers: process.env.OMEM_TOKEN
        ? { Authorization: `Bearer ${process.env.OMEM_TOKEN}` }
        : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return { reachable: true, healthy: false, httpStatus: r.status };
    const body = await r.json();
    return { reachable: true, healthy: body.status === "ok", body };
  } catch {
    return { reachable: false, healthy: false };
  }
}
let app = await managed();
if (action === "start" || action === "restart") {
  if (!existsSync(join(root, "dist/apps/server/src/main.js")))
    throw Error("请先运行 osdk run build");
  if (!app && (await health(address)).reachable)
    throw Error(
      "目标地址已有服务。请先停止该实例或用 OMEM_PORT 指定另一个端口，避免重复采集。",
    );
  if (action === "start" && app?.pm2_env?.status === "online") {
    console.log("服务已由 PM2 托管，保留当前配置。");
  } else {
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
            time: true,
            env: {
              NODE_ENV: "production",
              OMEM_DATA_DIR: data,
              OMEM_CONFIG: resolve(
                process.env.OMEM_CONFIG || join(root, "omem.local.json"),
              ),
              OMEM_PORT: process.env.OMEM_PORT || "4317",
              OMEM_HOST: process.env.OMEM_HOST || "127.0.0.1",
            },
          },
        ],
      }),
      { mode: 0o600 },
    );
    await command(["startOrRestart", file, "--only", name, "--update-env"]);
  }
} else if (action === "stop" && app) await command(["stop", name]);
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
  bootAutoStart: false,
};
if (taskFlag("json")) console.log(JSON.stringify(result, null, 2));
else {
  console.log(
    `服务：${result.state} · PID ${result.pid ?? "—"} · 重启 ${result.restarts} 次`,
  );
  console.log(
    `接口：${check.healthy ? "正常" : check.reachable ? "可连接但未通过检查" : "未连接"} · ${url}`,
  );
  if (check.body?.personalLark)
    console.log(`飞书采集：${JSON.stringify(check.body.personalLark)}`);
  console.log(
    `日志：${result.logs}\n未安装系统开机自启动；电脑休眠时无法执行定时任务。`,
  );
}
if (action !== "stop" && (!app || result.state !== "online" || !check.healthy))
  process.exitCode = 1;
