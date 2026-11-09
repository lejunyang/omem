/// <reference types="vite/client" />

import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import vue from "@vitejs/plugin-vue";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { browserCommands } from "./e2e/browser-commands";

interface E2EImportMetaEnv extends ImportMetaEnv {
  readonly E2E_BROWSER_CHANNEL?: string;
  readonly E2E_BROWSER_EXECUTABLE_PATH?: string;
  readonly E2E_BROWSER_HEADLESS?: string;
  readonly E2E_BROWSER_USER_DATA_DIR?: string;
}

// fileURLToPath 而不是 .pathname：Windows 上 pathname 是 /E:/…，Chrome 认不出扩展目录。
const extensionPath = fileURLToPath(new URL("./dist", import.meta.url));
const rootPath = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const envFromFiles = loadEnv(mode, rootPath, "E2E_") as E2EImportMetaEnv;
  const envFromImportMeta = ((import.meta as ImportMeta & { env?: E2EImportMetaEnv }).env ?? {}) as E2EImportMetaEnv;
  const env = { ...envFromFiles, ...envFromImportMeta };
  const executablePath = env.E2E_BROWSER_EXECUTABLE_PATH || undefined;
  // e2e 默认静默运行，避免测试浏览器打断用户当前操作；需要调试时显式设置 E2E_BROWSER_HEADLESS=false。
  const headless = env.E2E_BROWSER_HEADLESS !== "false";
  // 无头模式下只有完整版 chromium 能加载扩展（默认的 headless shell 不加载，service worker 永远等不到）。
  const channel = executablePath ? undefined : env.E2E_BROWSER_CHANNEL || (headless ? "chromium" : undefined);
  // 默认使用按进程隔离的 profile，避免 MV3 service worker 复用旧扩展代码；需要复用浏览器登录态时仍可用 E2E_BROWSER_USER_DATA_DIR 显式指定。
  const userDataDir = env.E2E_BROWSER_USER_DATA_DIR || `./node_modules/.cache/advanced-network-e2e-profile-${process.pid}`;

  return {
    envPrefix: ["VITE_", "E2E_"],
    plugins: [vue()],
    optimizeDeps: { include: ["vue"] },
    test: {
      include: ["e2e/**/*.test.ts"],
      hookTimeout: 45000,
      testTimeout: 45000,
      fileParallelism: false,
      browser: {
        enabled: true,
        headless,
        commands: browserCommands,
        provider: playwright({
          persistentContext: userDataDir,
          launchOptions: {
            channel,
            executablePath,
            args: [
              `--disable-extensions-except=${extensionPath}`,
              `--load-extension=${extensionPath}`,
              "--no-default-browser-check",
              "--no-first-run"
            ]
          }
        }),
        instances: [{ browser: "chromium" }]
      }
    }
  };
});
