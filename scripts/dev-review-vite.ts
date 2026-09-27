/** Vite child for `dev:review`. Spawned by scripts/dev-review.ts as a direct node
 * process so the orchestrator can terminate the whole tree with
 * `taskkill /PID <pid> /T /F` on Windows instead of relying on SIGTERM delivery
 * to a cmd/npx wrapper.
 *
 * It deliberately does NOT read apps/web/vite.config.ts (that config proxies
 * /api to the personal backend on 4317). configFile:false supplies the review
 * proxy (to 5180) and strictPort here; the shared vite.config.ts stays untouched.
 *
 * Ports are taken from REVIEW_WEB_PORT / REVIEW_API_PORT so the integration
 * test can run the orchestrator on ephemeral ports. */
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";

const webPort = Number(process.env.REVIEW_WEB_PORT || 5181);
const apiPort = Number(process.env.REVIEW_API_PORT || 5180);

const vite = await createServer({
  configFile: false,
  root: "apps/web",
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    // Never silently fall back to another port: if 5181 (or the configured
    // REVIEW_WEB_PORT) is busy, Vite exits non-zero and the orchestrator
    // propagates that code instead of printing a URL we are not serving on.
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});

await vite.listen();
const localUrls = (vite.resolvedUrls?.local ?? []).join(", ") || `http://127.0.0.1:${webPort}`;
console.log(`repo-review: vite listening on ${localUrls}`);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void vite.close().then(() => process.exit(0));
  });
