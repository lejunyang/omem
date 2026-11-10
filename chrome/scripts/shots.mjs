// 改界面后截图检查：popup、侧边栏（加载真实构建）和 DevTools 面板（e2e harness 模拟 DevTools API）。
// 用法：pnpm run build && node scripts/shots.mjs <输出目录> [--dark]
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = resolve(process.argv[2] ?? "shots");
const dark = process.argv.includes("--dark");
const extensionPath = join(root, "dist");
await mkdir(outDir, { recursive: true });

const server = await createServer({ root, configFile: false, plugins: [vue()], server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, "");
const profile = join(root, "node_modules", ".cache", `shots-${process.pid}`);
const context = await chromium.launchPersistentContext(profile, {
  // 无头模式下只有完整版 chromium（不是 headless shell）能加载扩展。
  headless: true,
  channel: "chromium",
  colorScheme: dark ? "dark" : "light",
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-first-run"]
});
const suffix = dark ? "-dark" : "";

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;

  for (const [name, path, width, height] of [
    ["popup", "popup.html", 380, 600],
    ["sidepanel", "sidepanel.html", 400, 760]
  ]) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    const response = await page.goto(`chrome-extension://${extensionId}/${path}`).catch(() => null);
    if (!response) {
      await page.close();
      continue;
    }
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `${name}${suffix}.png`), fullPage: true });
    await page.close();
  }

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${origin}/e2e/panel-network-harness.html`);
  await page.waitForTimeout(800);
  for (const [method, url, body] of [
    ["GET", "https://shop.example.com/api/orders?page=1", JSON.stringify({ data: { items: [{ id: 1, amount: 12.5 }] }, ok: true })],
    ["POST", "https://shop.example.com/api/refund/apply", JSON.stringify({ ok: false, message: "余额不足" })],
    ["GET", "https://shop.example.com/static/app.js", "console.log(1)"],
    ["GET", "https://shop.example.com/api/user/profile", JSON.stringify({ name: "小王" })]
  ]) {
    await page.evaluate(([m, u, b]) => window.__advancedNetworkHarness.emitRequest({ method: m, url: u, responseBody: b }), [method, url, body]);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, `panel${suffix}.png`) });
  const row = page.getByTestId("request-row").first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `panel-detail${suffix}.png`) });
  }
  await page.close();
} finally {
  await context.close();
  await server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
console.log(`截图已写入 ${outDir}`);
