/**
 * Build each built-in plugin's page (plugins/<id>/web/index.html) into web/dist/plugins/<id>/, where
 * the server serves it at /plugins/<id>/ (docs/v2/plugins.md), and the SDK for pages written as plain
 * HTML (data-directory plugins): /plugins/_sdk/omem.js and omem.css. Runs after the main web build,
 * which empties web/dist. In development the Vite dev server serves all of these from source with
 * HMR instead (web/vite-plugin-pages.ts); this is only for the build.
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vue from "@vitejs/plugin-vue";
import { build } from "vite";
import { repoRoot as root, sdkAlias } from "../web/vite-plugin-pages.ts";

const ids = readdirSync(join(root, "plugins"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, "plugins", e.name, "web", "index.html")))
  .map((e) => e.name);

for (const id of ids) {
  await build({
    configFile: false,
    root: join(root, "plugins", id, "web"),
    base: "./",
    plugins: [vue()],
    resolve: { alias: sdkAlias },
    build: { outDir: join(root, "web", "dist", "plugins", id), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  });
}
// The SDK as one module, and omem's styles (tokens, .btn, .input, .card…).
const sdk = join(root, "web", "dist", "plugins", "_sdk");
await build({
  configFile: false,
  root,
  build: { outDir: sdk, emptyOutDir: true, lib: { entry: join(root, "packages", "plugin-sdk", "client.ts"), formats: ["es"], fileName: () => "omem.js" } },
});
copyFileSync(join(root, "web", "src", "styles.css"), join(sdk, "omem.css"));
console.log(`插件页面：${ids.join("、") || "（无）"}；SDK：/plugins/_sdk/omem.js、omem.css`);
