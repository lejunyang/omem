import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/**
 * `omem service start|stop|restart|status|logs`: keep the omem server running
 * in the background with the PM2 bundled in omem's dependencies. PM2 runs in
 * its own home under the data directory (`<home>/service/pm2`), so it does
 * not touch a PM2 the user may run for other things. Restarts on crash with
 * backoff, rotates logs with pm2-logrotate. No boot autostart is installed.
 */
export type ServiceAction = "start" | "stop" | "restart" | "status";
const NAME = "omem";

/** The entry PM2 runs: the built CLI when present, else the TypeScript source (Node strips types). */
function entry() {
  for (const c of [resolve(here, "../cli.js"), resolve(here, "../../dist/src/cli.js"), resolve(here, "../cli.ts")]) if (existsSync(c)) return c;
  throw new Error("找不到 omem 的入口（dist/src/cli.js 或 src/cli.ts）");
}

export async function manageService(home: string, action: ServiceAction) {
  const pm2Home = join(home, "service", "pm2");
  const logs = join(home, "service", "logs");
  const pm2 = require.resolve("pm2/bin/pm2");
  const env = { ...process.env, PM2_HOME: pm2Home, PM2_SILENT: "true" };
  const command = async (args: string[], cwd?: string) => (await exec(process.execPath, [pm2, ...args], { cwd, env, timeout: 60_000, maxBuffer: 5_000_000 })).stdout;
  const daemonAlive = async () => {
    try {
      const pid = Number(await readFile(join(pm2Home, "pm2.pid"), "utf8"));
      process.kill(pid, 0);
      return pid > 0;
    } catch {
      return false;
    }
  };
  type Proc = { name: string; pid?: number; pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number; watch?: boolean; pm_exec_path?: string } };
  const list = async (): Promise<Proc[]> => ((await daemonAlive()) ? JSON.parse(await command(["jlist"])) : []);
  const find = async (name: string) => (await list()).find((p) => p.name === name) ?? null;

  const config = loadConfig(home);
  const url = `http://127.0.0.1:${config.port}`;
  const health = async () => {
    try {
      const r = await fetch(`${url}/api/settings`, { signal: AbortSignal.timeout(2500), headers: config.token ? { authorization: `Bearer ${config.token}` } : {} });
      if (!r.ok) return { reachable: true, healthy: false };
      const body = (await r.json()) as { home?: string };
      return { reachable: true, healthy: !body.home || resolve(body.home) === resolve(home) };
    } catch {
      return { reachable: false, healthy: false };
    }
  };

  const ensureRotation = async () => {
    const installed = require.resolve("pm2-logrotate");
    let mod = await find("pm2-logrotate");
    if (mod && mod.pm2_env?.pm_exec_path !== installed) {
      await command(["delete", "pm2-logrotate"]);
      mod = null;
    }
    if (!mod) {
      // `install .` from the package directory installs the bundled copy; a path argument would run npm install.
      await command(["install", "."], dirname(require.resolve("pm2-logrotate/package.json")));
      for (const [k, v] of Object.entries({ max_size: "20M", retain: "7", compress: "true", rotateInterval: "0 0 * * *" })) await command(["set", `pm2-logrotate:${k}`, v]);
      mod = await find("pm2-logrotate");
      // A local install turns on watching; this is an installed package, turn it off.
      if (mod?.pm2_env?.watch) await command(["restart", "pm2-logrotate", "--watch"]);
    }
  };

  let app = await find(NAME);
  if (action === "start" || action === "restart") {
    if (action === "start" && app?.pm2_env?.status === "online") {
      // Already running: keep it.
    } else {
      if (!app && (await health()).reachable) throw new Error(`${url} 上已经有一个 omem 在运行（不是这个后台服务启动的）。先停掉它，或在配置里换端口。`);
      await mkdir(logs, { recursive: true, mode: 0o700 });
      await mkdir(pm2Home, { recursive: true, mode: 0o700 });
      const file = join(home, "service", "ecosystem.json");
      await writeFile(
        file,
        JSON.stringify(
          {
            apps: [
              {
                name: NAME,
                script: entry(),
                args: ["--home", home, "serve"],
                interpreter: process.execPath,
                cwd: home,
                exec_mode: "fork",
                instances: 1,
                autorestart: true,
                watch: false,
                min_uptime: "10s",
                max_restarts: 10,
                exp_backoff_restart_delay: 1000,
                kill_timeout: 30_000,
                out_file: join(logs, "omem.out.log"),
                error_file: join(logs, "omem.err.log"),
                merge_logs: true,
                time: true,
                // Agents, uv, llama-server… are found through the PATH of whoever started the service.
                env: { NODE_ENV: "production", OMEM_HOME: home, PATH: process.env.PATH ?? "" },
              },
            ],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await command(["startOrRestart", file, "--only", NAME, "--update-env"]);
      try {
        await ensureRotation();
      } catch (e) {
        console.error(`日志轮换没有启动（${(e as Error).message.split("\n")[0]}），服务照常运行。`);
      }
    }
  } else if (action === "stop") {
    if (app) await command(["stop", NAME]);
    if (await find("pm2-logrotate")) await command(["stop", "pm2-logrotate"]);
    await command(["kill"]).catch(() => {});
  }
  let h = await health();
  if (action === "start" || action === "restart") for (let i = 0; !h.healthy && i < 40; i++) await new Promise((r) => setTimeout(r, 500)), (h = await health());
  app = await find(NAME);
  return {
    state: app?.pm2_env?.status ?? "stopped",
    pid: app?.pid || null,
    restarts: app?.pm2_env?.restart_time ?? 0,
    since: app?.pm2_env?.pm_uptime ? new Date(app.pm2_env.pm_uptime).toISOString() : null,
    url,
    healthy: h.healthy,
    logs: [join(logs, "omem.out.log"), join(logs, "omem.err.log")],
  };
}

export function formatService(s: Awaited<ReturnType<typeof manageService>>) {
  return [
    `服务：${s.state}${s.pid ? ` · PID ${s.pid}` : ""}${s.restarts ? ` · 重启过 ${s.restarts} 次` : ""}${s.since ? ` · 启动于 ${s.since.slice(0, 19).replace("T", " ")}` : ""}`,
    `网页：${s.url}（${s.healthy ? "正常" : "无响应"}）`,
    `日志：${s.logs.join("  ")}`,
    "后台服务由 omem 自带的 PM2 管理，崩溃会自动重启；没有设置开机自启，电脑重启后运行 omem service start。",
  ].join("\n");
}
