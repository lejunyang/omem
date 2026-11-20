import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import { ACTIVE_CONNECTION_STORAGE_KEY, CONNECTIONS_STORAGE_KEY } from "../src/shared/connections";
import { clearPickBasket } from "./pick-browser-commands";

// 拾取篮 → omem：起一个真实的 omem（仓库源码，临时数据目录），在侧栏里连接它（真实确认页点「允许」），
// 记一条元素，存为原件、再问 omem，回到 omem 的接口核对内容。需要先构建 omem 的网页（web/dist）。

export interface OmemSendScenarioResult {
  connected: boolean;
  userName: string;
  sourceText: string;
  sourceTitle: string;
  imageSourceKind: string;
  askText: string;
  conversationLink: boolean;
}

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startOmem(): Promise<{ url: string; stop: () => void; child: ChildProcess }> {
  const home = mkdtempSync(join(tmpdir(), "omem-chrome-e2e-"));
  const port = await freePort();
  const child = spawn(process.execPath, [join(repoRoot, "src/cli.ts"), "serve", "--port", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, OMEM_HOME: home, OMEM_PORT: String(port) },
    stdio: "ignore"
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`omem 启动失败（退出码 ${child.exitCode}）`);
    const ok = await fetch(`${url}/api/me`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return {
    url,
    child,
    stop: () => {
      child.kill();
      setTimeout(() => rmSync(home, { recursive: true, force: true }), 1000);
    }
  };
}

async function waitRecords(ext: Page, expected: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const count = await ext.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const request = indexedDB.open("omem-pick");
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("records")) {
              db.close();
              return resolve(0);
            }
            const c = db.transaction("records").objectStore("records").count();
            c.onsuccess = () => {
              db.close();
              resolve(c.result);
            };
          };
          request.onerror = () => resolve(0);
        })
    );
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("拾取记录没有写进去");
}

/** 打开侧栏、清空拾取篮，添加本机连接，确认页点「允许」，等到连上；返回侧栏里显示的用户名。 */
async function connectSidepanel(context: BrowserContext, side: Page, extensionId: string, url: string): Promise<string> {
  await side.setViewportSize({ width: 420, height: 900 });
  await side.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await clearPickBasket(side);
  // 同一次运行里的几个用例共用一个扩展 profile：先删掉上一个用例连过的 omem（它已经停了）。
  await side.evaluate((keys) => chrome.storage.local.remove(keys), [CONNECTIONS_STORAGE_KEY, ACTIVE_CONNECTION_STORAGE_KEY]);
  await side.reload();
  await side.getByTestId("omem-connection").click();
  await side.getByPlaceholder("http://127.0.0.1:4317").fill(url);
  await side.screenshot({ path: "e2e/__screenshots__/omem-connections.png" });
  const confirmPage = context.waitForEvent("page");
  await side.getByRole("button", { name: "连接并登录" }).click();
  const confirm = await confirmPage;
  await confirm.getByRole("button", { name: "允许" }).click();
  await confirm.getByText("已允许").waitFor();
  await confirm.screenshot({ path: "e2e/__screenshots__/omem-confirm.png" });
  await side.locator(".omem-dot.is-ok").waitFor({ timeout: 15_000 });
  const userName = (await side.locator(".omem-chip small").textContent()) ?? "";
  await confirm.close();
  return userName;
}

/** 在测试页上用「元素」拾取记一条 #submit（拾取篮里有 expected 条为止）。 */
async function pickSubmit(side: Page, page: Page, origin: string, expected: number): Promise<void> {
  const fixture = `${origin}/e2e/pick-fixture.html`;
  await page.goto(fixture);
  const tabId = await side.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? -1, fixture);
  await side.evaluate((id) => chrome.runtime.sendMessage({ type: "omem-pick:start", mode: "element", tabId: id }), tabId);
  await page.bringToFront();
  await page.click("#submit");
  await page.keyboard.press("Enter");
  await waitRecords(side, expected);
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
}

const runOmemSendScenario: BrowserCommand<[string], OmemSendScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as { context: BrowserContext };
  const omem = await startOmem();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const side = await context.newPage();
  const page = await context.newPage();
  try {
    // 1. 连接：侧栏里添加本机连接，确认页点「允许」
    const userName = await connectSidepanel(context, side, extensionId, omem.url);

    // 2. 在页面上记一条元素
    await pickSubmit(side, page, origin, 1);

    // 3. 写描述、引用，存为原件
    await side.bringToFront();
    await side.locator(".record-card").first().waitFor();
    await side.getByTestId("pick-composer").click();
    await side.keyboard.type("退款按钮的埋点要核对 ");
    await side.locator(".record-cite").first().click();
    await side.getByTestId("pick-save-source").click();
    await side.locator(".send-result.is-done").waitFor({ timeout: 20_000 });
    const sourceLink = (await side.locator(".send-result a").getAttribute("href")) ?? "";
    const sourceId = decodeURIComponent(sourceLink.split("/sources/")[1] ?? "");
    const source = (await (await fetch(`${omem.url}/api/sources/${encodeURIComponent(sourceId)}`)).json()) as { source?: { title: string }; title?: string; text?: string; lines?: string[] };
    const sourceText = source.text ?? (source.lines ?? []).join("\n");
    const imageId = /src:([\w-]+)/.exec(sourceText)?.[1] ?? "";
    const image = (await (await fetch(`${omem.url}/api/sources/${encodeURIComponent(imageId)}`)).json()) as { source?: { kind: string }; kind?: string };

    // 4. 再问 omem（新对话）
    await side.getByTestId("pick-ask").click();
    await side.locator(".send-result.is-done").waitFor({ timeout: 20_000 });
    const askLink = (await side.locator(".send-result a").first().getAttribute("href")) ?? "";
    const conversationId = decodeURIComponent(askLink.split("/ask/")[1] ?? "");
    await side.waitForTimeout(300);
    await side.screenshot({ path: "e2e/__screenshots__/omem-send-done.png" });
    const conversation = (await (await fetch(`${omem.url}/api/conversations/${encodeURIComponent(conversationId)}`)).json()) as { messages: Array<{ role: string; text: string }> };
    return {
      connected: true,
      userName,
      sourceText,
      sourceTitle: source.source?.title ?? source.title ?? "",
      imageSourceKind: image.source?.kind ?? image.kind ?? "",
      askText: conversation.messages.find((message) => message.role === "user")?.text ?? "",
      conversationLink: askLink.includes(`${omem.url}/#/ask/`)
    };
  } catch (error) {
    // 失败时留一张侧栏截图，并带上发送结果的文字，方便看是连接、截图还是发送出了问题。
    await side.screenshot({ path: "e2e/__screenshots__/omem-send-failure.png" }).catch(() => undefined);
    const shown = await side.locator(".send-result, .send-hint, .form-error").allTextContents().catch(() => []);
    throw new Error(`${(error as Error).message}
侧栏：${shown.join(" | ")}`);
  } finally {
    await page.close();
    await side.close();
    omem.stop();
  }
};

export interface OmemDemoScenarioResult {
  bannerGoal: string;
  pickButtons: string[];
  pickNote: string;
  pickMessage: string;
  elapsed: string;
  stopChoices: string[];
  ended: string;
  organizeMessage: string;
  currentAfterStop: unknown;
}

/**
 * 演示：侧栏顶部开始一次演示 → 横幅出现 → 拾取篮只剩「记进演示」→ 记进去的拾取是演示对话里的一条消息（不起一轮）
 * → 结束演示选「整理成技能」→ 对话里多一条整理的消息，演示不再进行。
 */
const runOmemDemoScenario: BrowserCommand<[string], OmemDemoScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as { context: BrowserContext };
  const omem = await startOmem();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const side = await context.newPage();
  const page = await context.newPage();
  try {
    await connectSidepanel(context, side, extensionId, omem.url);
    await side.getByTestId("demo-open").click();
    await side.getByTestId("demo-goal").fill("退款按钮点了没反应时怎么查");
    await side.screenshot({ path: "e2e/__screenshots__/demo-start.png" });
    await side.getByTestId("demo-start").click();
    await side.locator(".demo-bar.is-live").waitFor({ timeout: 15_000 });
    const bannerGoal = (await side.locator(".demo-goal").textContent()) ?? "";

    await pickSubmit(side, page, origin, 1);
    await side.bringToFront();
    await side.locator(".record-card").first().waitFor();
    await side.getByTestId("pick-composer").click();
    await side.keyboard.type("就是这个按钮，点了没有请求 ");
    await side.locator(".record-cite").first().click();
    const pickButtons = (await side.locator("footer.composer .composer-actions button.button-primary").allTextContents()).map((t) => t.trim());
    await side.getByTestId("pick-demo").click();
    await side.locator(".send-result.is-done").waitFor({ timeout: 20_000 });
    const pickNote = (await side.locator(".send-result.is-done span").first().textContent()) ?? "";
    await side.screenshot({ path: "e2e/__screenshots__/demo-live.png" });

    const listed = (await (await fetch(`${omem.url}/api/demos`)).json()) as { current: { id: string } | null };
    const demoId = listed.current?.id ?? "";
    const messages = async () =>
      ((await (await fetch(`${omem.url}/api/conversations/${encodeURIComponent(demoId)}`)).json()) as { messages: Array<{ role: string; text: string }> }).messages;
    const pickMessage = (await messages()).find((m) => m.text.startsWith("我指给你看"))?.text ?? "";

    // 计时在走（每秒更新）
    await side.waitForTimeout(2200);
    const elapsed = (await side.getByTestId("demo-elapsed").textContent()) ?? "";
    await side.getByTestId("demo-stop").click();
    const stopChoices = (await side.locator(".demo-actions button[data-testid^='demo-stop-']").allTextContents()).map((t) => t.trim());
    await side.screenshot({ path: "e2e/__screenshots__/demo-stop.png" });
    await side.getByTestId("demo-stop-skill").click();
    await side.getByTestId("demo-ended").waitFor({ timeout: 20_000 });
    const ended = ((await side.getByTestId("demo-ended").textContent()) ?? "").split(/\s+/).join(" ").trim();
    const organizeMessage = (await messages()).find((m) => m.text.startsWith("我演示完了"))?.text ?? "";
    const after = (await (await fetch(`${omem.url}/api/demos`)).json()) as { current: unknown };
    return { bannerGoal, pickButtons, pickNote, pickMessage, elapsed, stopChoices, ended, organizeMessage, currentAfterStop: after.current };
  } catch (error) {
    await side.screenshot({ path: "e2e/__screenshots__/demo-failure.png" }).catch(() => undefined);
    const shown = await side.locator(".send-result, .send-hint, .demo-bar").allTextContents().catch(() => []);
    throw new Error(`${(error as Error).message}
侧栏：${shown.join(" | ")}`);
  } finally {
    await page.close();
    await side.close();
    omem.stop();
  }
};

export const omemBrowserCommands = { runOmemSendScenario, runOmemDemoScenario };
