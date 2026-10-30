import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { pluginPagesDev, repoRoot, sdkAlias } from "./vite-plugin-pages";

const api = `http://127.0.0.1:${process.env.OMEM_PORT ?? 4317}`;
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue(), pluginPagesDev()],
  resolve: { alias: sdkAlias },
  server: {
    port: Number(process.env.OMEM_WEB_PORT ?? 5173),
    // Built-in plugin pages are served from source (pluginPagesDev); the rest of /plugins goes to the API.
    fs: { allow: [repoRoot] },
    proxy: { "/api": { target: api, changeOrigin: false, ws: true }, "/mcp": api, "/ide": { target: api, ws: true }, "/plugins": api },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
