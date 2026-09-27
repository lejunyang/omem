/** Local dev for the repo-review knowledge base: the review API on 5180 and the
 * Vue dev server on 5181 with /api proxied to 5180. The shared apps/web/vite.config
 * proxies /api to the personal backend (4317), so review dev boots Vite through the
 * JS API with a configFile:false override rather than touching that existing config. */
import { spawn } from "node:child_process";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

const api = spawn(
  "npx",
  ["tsx", "watch", "apps/server/src/review/main.ts"],
  { stdio: "inherit", shell: process.platform === "win32" },
);

const vite = await createServer({
  configFile: false,
  root: "apps/web",
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: 5181,
    proxy: { "/api": "http://127.0.0.1:5180" },
  },
});
await vite.listen();

console.log("repo-review: API at http://127.0.0.1:5180");
console.log("repo-review: web at http://127.0.0.1:5181 (proxy /api -> 5180)");

const shutdown = () => {
  api.kill("SIGTERM");
  void vite.close().then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
api.on("exit", (code) => {
  if (code) shutdown();
});
