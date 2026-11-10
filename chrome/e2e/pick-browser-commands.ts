import type { BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";

// 不用 CDP 的默认模式与「拾取」的 e2e：真实扩展、真实页面、真实截图。
// e2e 的 manifest 带 <all_urls>（scripts/run-e2e.mjs），相当于用户已授权所有站点。

export interface NoCdpScenarioResult {
  mode: string;
  attachedAfterPanelCalls: number;
  observerMode: string;
  controlsCdpDisabled: boolean;
  registered: string[];
  fetchText: string;
  xhrText: string;
  mockedStatus: boolean;
}

export interface PickScenarioResult {
  records: Array<{ seq: number; kind: string; title: string; spacings: string[]; width: number; height: number; elementCount: number }>;
  basketCards: number;
  chipText: string;
  draftIsArray: boolean;
  draftRefCount: number;
  attachedAfter: number;
}

type CommandContext = { context: BrowserContext };

async function extensionPage(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  return page;
}

async function tabIdFor(page: Page, url: string): Promise<number> {
  return page.evaluate(async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id ?? -1, url);
}

async function status(page: Page): Promise<{ mode: string; attachedTabs: number[] }> {
  return page.evaluate(() => chrome.runtime.sendMessage({ type: "advanced-network:get-cdp-status" }));
}

const runNoCdpScenario: BrowserCommand<[string], NoCdpScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as CommandContext;
  const ext = await extensionPage(context);
  const page = await context.newPage();
  try {
    await ext.evaluate(() =>
      chrome.storage.local.set({
        "advancedNetwork.cdpMode": "off",
        "advancedNetwork.mockGroups": [{ id: "default", name: "默认组", enabled: true, pageUrlContains: "pick-fixture", createdAt: 0, updatedAt: 0 }],
        "advancedNetwork.mockRules": [
          {
            id: "hook-rule",
            groupId: "default",
            name: "页面钩子替换",
            enabled: true,
            scope: "global",
            domain: "",
            matcherQuery: "url:pick-data.json",
            method: "GET",
            url: "",
            action: "replace-body",
            responseHeaders: [],
            responseBody: '{"source":"mock"}',
            script: "",
            createdAt: 0,
            updatedAt: 0
          }
        ]
      })
    );
    const url = `${origin}/e2e/pick-fixture.html`;
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById("xhr-result")?.textContent !== "loading");
    const tabId = await tabIdFor(ext, url);
    // 面板打开时会发的几条消息：都不应该连接调试器。
    const observer = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: "advanced-network:enable-cdp-observer", tabId: id }), tabId);
    const controls = await ext.evaluate(
      (id) => chrome.runtime.sendMessage({ type: "advanced-network:set-network-controls", tabId: id, controls: { preserveLog: false, disableCache: true, throttlingProfile: "none" } }),
      tabId
    );
    await ext.evaluate((id) => chrome.runtime.sendMessage({ type: "advanced-network:sync-mock-rules", tabId: id, rules: [], groups: [] }), tabId);
    const mocked = await ext.evaluate(
      ({ id, target }) => chrome.runtime.sendMessage({ type: "advanced-network:get-mock-status", tabId: id, method: "GET", url: target }),
      { id: tabId, target: `${origin}/e2e/pick-data.json?from=fetch` }
    );
    const current = await status(ext);
    const registered = await ext.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id).sort());
    return {
      mode: current.mode,
      attachedAfterPanelCalls: current.attachedTabs.length,
      observerMode: observer?.mode ?? "",
      controlsCdpDisabled: Boolean(controls?.cdpDisabled),
      registered,
      fetchText: (await page.textContent("#result")) ?? "",
      xhrText: (await page.textContent("#xhr-result")) ?? "",
      mockedStatus: Boolean(mocked?.mocked)
    };
  } finally {
    await ext.evaluate(() => chrome.storage.local.remove(["advancedNetwork.mockRules", "advancedNetwork.mockGroups"])).catch(() => undefined);
    await page.close();
    await ext.close();
  }
};

/** 记录条数（打开后立即关闭连接：开着的旧版本连接会挡住后台的版本升级）。 */
async function recordCount(ext: Page): Promise<number> {
  return ext.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("omem-pick");
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("records")) {
            db.close();
            return resolve(0);
          }
          const count = db.transaction("records").objectStore("records").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
        request.onerror = () => resolve(0);
      })
  );
}

/** 等记录写进库，再等页面里的拾取界面结束这次提交（提交中按键会被忽略）。 */
async function waitForRecords(ext: Page, expected: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while ((await recordCount(ext)) < expected) {
    if (Date.now() > deadline) throw new Error(`拾取记录没有达到 ${expected} 条`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const runPickScenario: BrowserCommand<[string], PickScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as CommandContext;
  const ext = await extensionPage(context);
  const page = await context.newPage();
  const side = await context.newPage();
  try {
    await page.setViewportSize({ width: 1200, height: 760 });
    const url = `${origin}/e2e/pick-fixture.html`;
    await page.goto(url);
    const tabId = await tabIdFor(ext, url);
    await page.bringToFront();

    // 元素：主元素 + 一个次元素，Enter 记下
    const started = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: "omem-pick:start", mode: "element", tabId: id }), tabId);
    if (!started?.ok) throw new Error(`start failed: ${JSON.stringify(started)}`);
    await page.bringToFront();
    await page.click("#submit");
    await page.click("#cancel", { modifiers: ["Shift"] });
    await page.keyboard.press("Enter");
    await waitForRecords(ext, 1);

    // 区域
    await page.keyboard.press("r");
    await page.mouse.move(300, 100);
    await page.mouse.down();
    await page.mouse.move(640, 260, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press("Enter");
    await waitForRecords(ext, 2);

    // 整页（逐屏拼接）
    await page.keyboard.press("p");
    await waitForRecords(ext, 3);
    await page.keyboard.press("Escape");

    const records = await ext.evaluate(
      () =>
        new Promise<PickScenarioResult["records"]>((resolve) => {
          const request = indexedDB.open("omem-pick");
          request.onsuccess = () => {
            const all = request.result.transaction("records").objectStore("records").getAll();
            all.onsuccess = () => {
              request.result.close();
              resolve(
                (all.result as Array<{ seq: number; kind: string; title: string; spacings: Array<{ label: string }>; imageSize: { width: number; height: number }; elements: unknown[] }>)
                  .sort((a, b) => a.seq - b.seq)
                  .map((record) => ({
                    seq: record.seq,
                    kind: record.kind,
                    title: record.title,
                    spacings: record.spacings.map((spacing) => spacing.label),
                    width: record.imageSize.width,
                    height: record.imageSize.height,
                    elementCount: record.elements.length
                  }))
              );
            };
          };
        })
    );

    // 拾取篮：引用第一条进输入框
    await side.goto(ext.url().replace("popup.html", "sidepanel.html"));
    await side.locator(".record-card").first().waitFor();
    const basketCards = await side.locator(".record-card").count();
    await side.getByTestId("pick-composer").click();
    await side.keyboard.type("提交按钮和取消的间距 ");
    await side.locator(".record-card").last().locator(".record-cite").click();
    await side.waitForTimeout(600);
    const chipText = (await side.locator(".ref-chip").first().textContent()) ?? "";
    const draft = await side.evaluate(async () => (await chrome.storage.local.get("omem.pick.draft"))["omem.pick.draft"]);
    return {
      records,
      basketCards,
      chipText,
      draftIsArray: Array.isArray(draft),
      draftRefCount: Array.isArray(draft) ? draft.filter((segment: { type: string }) => segment.type === "ref").length : 0,
      attachedAfter: (await status(ext)).attachedTabs.length
    };
  } finally {
    await side.close();
    await page.close();
    await ext.close();
  }
};

export const pickBrowserCommands = { runNoCdpScenario, runPickScenario };
