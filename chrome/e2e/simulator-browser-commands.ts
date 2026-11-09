import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import type { BrowserContext } from "playwright";
import type { BrowserCommand } from "vitest/node";

export interface SimulatorScenarioResult {
  width: number; height: number; dpr: number; touchPoints: number; coarse: boolean;
  userAgentMobile: boolean; centered: boolean; typed: string; touchEvents: number;
  landscapeWidth: number; landscapeHeight: number; disabledTouchPoints: number;
  originalUnchanged: boolean; cspPreserved: boolean; navigationWorked: boolean;
  narrowFits: boolean;
  dragScrolled: boolean; touchIsSynthetic: boolean; disabledTouchEvents: number; initialDpr: number;
}

// 本地服务器返回真实 CSP/XFO，避免 route.fulfill 绕过浏览器网络行为造成“假通过”。
const runSimulatorScenario: BrowserCommand<[], SimulatorScenarioResult> = async (commandContext) => {
  const context = (commandContext as unknown as { context: BrowserContext }).context;
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end("window.initialDpr=devicePixelRatio; window.touchEvents=0; document.addEventListener('touchstart',(event)=>{window.touchEvents++;window.lastTouchTrusted=event.isTrusted}); document.querySelector('button').onclick=()=>document.querySelector('output').textContent='已点击';");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "frame-ancestors 'none'; script-src 'self'; style-src 'unsafe-inline'");
    response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f5f6fa;font:16px system-ui;color:#243247}header{background:#233650;color:white;padding:28px 24px}main{padding:24px}h1{font-size:25px}article{padding:20px;background:white;border-radius:14px;margin:20px 0}input,button{padding:12px;border:1px solid #d1d9e3;border-radius:8px;max-width:100%;box-sizing:border-box}button{background:#3965db;color:white;margin:12px 0}footer{margin-top:900px}</style><header>NETWORK LAB</header><main><h1>让每个尺寸都刚刚好。</h1><p>真实网页 · 响应式布局</p><article><label>试试键盘输入 <input aria-label="测试输入" placeholder="输入任意文字"></label><button>测试点击与触摸</button><output></output></article><a href="/next">下一页</a><p id="path">${request.url === "/next" ? "下一页已到达" : "第一页"}</p><footer>滚动到这里</footer></main><script>window.inlineScriptRan=true</script><script src="/app.js"></script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const original = await context.newPage();
  const page = await context.newPage();
  const errors: string[] = [];
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("requestfailed", (request) => logs.push(`${request.url()} ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => errors.push(error.message));
  // 这个场景验证 CDP 路径（UA 子 session、只去掉 frame-ancestors）；不用 CDP 的模拟器另有场景。
  await worker.evaluate(() => chrome.storage.local.set({ "advancedNetwork.cdpMode": "on" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await original.goto(url);
    const before = await original.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints }));
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`chrome-extension://${extensionId}/simulator.html?${new URLSearchParams({ url, profile: "iphone-15" })}`);
    await page.getByTestId("simulator-frame").waitFor();
    const frame = page.frameLocator('[data-testid="simulator-frame"]');
    await frame.getByRole("button", { name: "测试点击与触摸" }).waitFor({ timeout: 10000 });
    const metrics = await page.frames().find((item) => item.name() === "advanced-network-device-frame")!.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints, coarse: matchMedia("(pointer: coarse)").matches, userAgentMobile: navigator.userAgent.includes("iPhone"), cspPreserved: !(window as unknown as { inlineScriptRan?: boolean }).inlineScriptRan }));
    const box = await page.getByTestId("simulator-frame").boundingBox();
    const stage = await page.locator(".simulator-stage").boundingBox();
    const centered = !!box && !!stage && Math.abs(box.x + box.width / 2 - stage.x - stage.width / 2) < 2;
    await frame.getByLabel("测试输入").fill("手机测试 Mobile");
    const typed = await frame.getByLabel("测试输入").inputValue();
    // 使用真实鼠标路径，缩放后的 iframe 坐标按屏幕矩形换算。
    const tap = async (selector: string) => {
      const host = await page.getByTestId("simulator-frame").boundingBox();
      const child = await frame.locator(selector).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, height: innerHeight };
      });
      await page.mouse.click(host!.x + child.x * host!.width / child.width, host!.y + child.y * host!.height / child.height);
    };
    await tap("button");
    await frame.locator("output").filter({ hasText: "已点击" }).waitFor({ timeout: 8000 });
    const touchEvents = await page.frames().find((item) => item.name() === "advanced-network-device-frame")!.evaluate(() => (window as unknown as { touchEvents: number }).touchEvents);
    await mkdir("e2e/__screenshots__", { recursive: true });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (await page.locator(".simulator-header").count() !== 1) throw new Error("Simulator shell mounted twice");
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/simulator-desktop.png" });
    const businessFrame = () => page.frames().find((item) => item.name() === "advanced-network-device-frame")!;
    const initialDpr = await businessFrame().evaluate(() => (window as unknown as { initialDpr: number }).initialDpr);
    const touchIsSynthetic = await businessFrame().evaluate(() => (window as unknown as { lastTouchTrusted: boolean }).lastTouchTrusted === false);
    const host = await page.getByTestId("simulator-frame").boundingBox();
    await page.mouse.move(host!.x + host!.width / 2, host!.y + host!.height * .8);
    await page.mouse.down();
    await page.mouse.move(host!.x + host!.width / 2, host!.y + host!.height * .5, { steps: 8 });
    await page.mouse.up();
    const dragScrolled = await businessFrame().evaluate(() => scrollY > 100);
    await businessFrame().evaluate(() => scrollTo(0, 0));
    await tap("a");
    await frame.locator("#path").filter({ hasText: "下一页已到达" }).waitFor();
    await page.getByTestId("simulator-touch").uncheck();
    await page.getByTestId("simulator-landscape").click();
    await page.getByTestId("simulator-apply").click();
    await frame.getByLabel("测试输入").waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid="simulator-apply"]')?.hasAttribute("disabled"));
    // 等待重建的 frame 完成加载后再取值。
    const landscape = await frame.locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints }));
    await tap("button");
    const disabledTouchEvents = await businessFrame().evaluate(() => (window as unknown as { touchEvents: number }).touchEvents);
    const after = await original.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints }));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 640, height: 800 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const narrowFrame = await page.getByTestId("simulator-frame").boundingBox();
    const narrowStage = await page.locator(".simulator-stage").boundingBox();
    const narrowFits = !!narrowFrame && !!narrowStage && narrowFrame.x >= narrowStage.x && narrowFrame.x + narrowFrame.width <= narrowStage.x + narrowStage.width + 1;
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/simulator-dark-narrow.png" });
    if (errors.length) throw new Error(errors.join("\n"));
    return { ...metrics, centered, typed, touchEvents, narrowFits, dragScrolled, touchIsSynthetic, disabledTouchEvents, initialDpr, landscapeWidth: landscape.width, landscapeHeight: landscape.height, disabledTouchPoints: landscape.touch, originalUnchanged: JSON.stringify(before) === JSON.stringify(after), navigationWorked: true };
  } catch (error) {
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/simulator-failure.png" });
    throw new Error(`${String(error)}\n${logs.join("\n")}\nFrames: ${page.frames().map((frame) => frame.url()).join(", ")}`);
  } finally {
    // 恢复默认。service worker 中途可能被回收，旧句柄上的 evaluate 会一直挂着，所以用扩展页面并限时。
    const reset = await context.newPage();
    await Promise.race([
      reset
        .goto(`chrome-extension://${extensionId}/popup.html`)
        .then(() => reset.evaluate(() => chrome.storage.local.set({ "advancedNetwork.cdpMode": "off" }))),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]).catch(() => undefined);
    await reset.close();
    await page.close(); await original.close();
    // 浏览器里可能还留着 keep-alive 连接，close() 会一直等；先断开所有连接。
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};
// 面板用既有 DevTools API harness 验证布局；popup 加载实际构建产物，页面异常直接失败。
const runUiLayoutScenario: BrowserCommand<[string], { panelFits: boolean; popupFits: boolean }> = async (commandContext, origin) => {
  const context = (commandContext as unknown as { context: BrowserContext }).context;
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`${origin}/e2e/panel-network-harness.html`);
    await page.getByTestId("panel-tab-network").waitFor();
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/panel-network.png" });
    await page.setViewportSize({ width: 560, height: 700 });
    await page.getByTestId("panel-tab-device-emulation").click();
    const panelFits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/panel-device-narrow.png" });
    const worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).host;
    await page.setViewportSize({ width: 760, height: 600 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.getByTestId("popup-tab-device-emulation").click();
    const popupFits = await page.evaluate(() => document.querySelector(".popup-app")!.getBoundingClientRect().height <= 600);
    await page.waitForTimeout(200);
    await page.screenshot({ scale: "css", path: "e2e/__screenshots__/popup-device.png" });
    if (errors.length) throw new Error(errors.join("\n"));
    return { panelFits, popupFits };
  } finally { await page.close(); }
};
export const simulatorBrowserCommands = { runSimulatorScenario, runUiLayoutScenario };
