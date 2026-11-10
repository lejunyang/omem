import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
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

const runOmemSendScenario: BrowserCommand<[string], OmemSendScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as { context: BrowserContext };
  const omem = await startOmem();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const side = await context.newPage();
  const page = await context.newPage();
  try {
    // 1. 连接：侧栏里添加本机连接，确认页点「允许」
    await side.setViewportSize({ width: 420, height: 900 });
    await side.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await clearPickBasket(side);
    await side.reload();
    await side.getByTestId("omem-connection").click();
    await side.getByPlaceholder("http://127.0.0.1:4317").fill(omem.url);
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

    // 2. 在页面上记一条元素
    const fixture = `${origin}/e2e/pick-fixture.html`;
    await page.goto(fixture);
    const tabId = await side.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id ?? -1, fixture);
    await side.evaluate((id) => chrome.runtime.sendMessage({ type: "omem-pick:start", mode: "element", tabId: id }), tabId);
    await page.bringToFront();
    await page.click("#submit");
    await page.keyboard.press("Enter");
    await waitRecords(side, 1);
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");

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

export const omemBrowserCommands = { runOmemSendScenario };
