import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.OMEM_PORT ?? 4317}`;
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  server: {
    port: Number(process.env.OMEM_WEB_PORT ?? 5173),
    proxy: { "/api": { target: api, changeOrigin: false }, "/mcp": api },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
