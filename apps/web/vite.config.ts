import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: { host: "127.0.0.1", port: Number(process.env.OMEM_WEB_PORT || 5173), strictPort: true, proxy: { "/api": `http://127.0.0.1:${process.env.OMEM_PORT || 4317}` } },
});
