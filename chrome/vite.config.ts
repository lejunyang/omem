import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  root: "src",
  publicDir: "../public",
  build: {
    emptyOutDir: true,
    outDir: "../dist",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        devtools: resolve(__dirname, "src/devtools.html"),
        mockOffscreen: resolve(__dirname, "src/mock-offscreen.html"),
        mockSandbox: resolve(__dirname, "src/mock-sandbox.html"),
        panel: resolve(__dirname, "src/panel.html"),
        popup: resolve(__dirname, "src/popup.html"),
        sidepanel: resolve(__dirname, "src/sidepanel.html"),
        simulator: resolve(__dirname, "src/simulator.html"),
        testPage: resolve(__dirname, "src/test-page.html")
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]"
      }
    }
  }
});
