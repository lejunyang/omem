/**
 * Build each plugin's page (plugins/<id>/web/index.html) into web/dist/plugins/<id>/, where the
 * server serves it at /plugins/<id>/ (docs/v2/plugins.md). Runs after the main web build, which
 * empties web/dist. `--watch` keeps rebuilding (scripts/dev.ts uses it).
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const ids = readdirSync(join(root, "plugins"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, "plugins", e.name, "web", "index.html")))
  .map((e) => e.name);

for (const id of ids) {
  await build({
    configFile: false,
    root: join(root, "plugins", id, "web"),
    base: "./",
    plugins: [vue()],
    logLevel: watch ? "warn" : "info",
    build: { outDir: join(root, "web", "dist", "plugins", id), emptyOutDir: true, chunkSizeWarningLimit: 1500, ...(watch ? { watch: {} } : {}) },
  });
}
// omem's styles (tokens, .btn, .input, .card…) for those pages: /plugins/_sdk/omem.css.
const copyStyles = () => copyFileSync(join(root, "web", "src", "styles.css"), join(root, "web", "dist", "plugins", "_sdk", "omem.css"));
// The SDK as one module for pages written as plain HTML (plugins in the data directory): /plugins/_sdk/omem.js.
await build({
  configFile: false,
  root,
  logLevel: watch ? "warn" : "info",
  build: {
    outDir: join(root, "web", "dist", "plugins", "_sdk"),
    emptyOutDir: true,
    lib: { entry: join(root, "plugins", "sdk", "client.ts"), formats: ["es"], fileName: () => "omem.js" },
    ...(watch ? { watch: {} } : {}),
  },
  plugins: [{ name: "omem-css", writeBundle: copyStyles }],
});
if (!watch) console.log(`插件页面：${ids.join("、") || "（无）"}；SDK：/plugins/_sdk/omem.js、omem.css`);
