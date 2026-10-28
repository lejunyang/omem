/**
 * Development entry: API server (restarts on change) + Vite dev server with HMR.
 * Uses ./.omem as the data directory unless OMEM_HOME is set.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = { ...process.env, OMEM_HOME: process.env.OMEM_HOME ?? resolve(root, ".omem"), OMEM_PORT: process.env.OMEM_PORT ?? "4317" };
const isWin = process.platform === "win32";
// npx is a .cmd on Windows and needs a shell; node itself must not go through one (its path has spaces).
const run = (cmd: string, args: string[], shell = false) => spawn(cmd, args, { cwd: root, env, stdio: "inherit", shell });

const api = run(process.execPath, ["--watch-path=src", "--watch-path=roles", "src/cli.ts", "serve", "--port", env.OMEM_PORT]);
const web = run(isWin ? "npx.cmd" : "npx", ["vite", "--config", "web/vite.config.ts"], isWin);
// Plugin pages are served by the API from web/dist/plugins (they run in an iframe of their own) and
// rebuilt here. plugins/ is not watched by the API, so editing a page does not restart a running
// tutor; after changing a plugin's server.ts, manifest or agents, restart dev.
const pages = run(process.execPath, ["scripts/build-plugins.ts", "--watch"]);
const stop = () => {
  api.kill();
  web.kill();
  pages.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
api.on("exit", (code) => code && console.error(`API 退出：${code}`));
