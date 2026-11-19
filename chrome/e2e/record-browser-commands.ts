import type { BrowserContext, Page } from "playwright";
import type { BrowserCommand } from "vitest/node";

// 「录制」的 e2e：真实扩展、真实页面。e2e 的 manifest 带 <all_urls>（scripts/run-e2e.mjs），相当于本人已授权所有网站。
// 走一遍：开始 → 填三个输入框（一个是密码、一个是验证码）→ 点按钮（发一个带令牌的 POST）→ 加标记 → 点链接换页 → 停止，
// 读后台写进 IndexedDB 的步骤和请求，再在侧栏里删掉一步。

export interface RecordScenarioResult {
  started: boolean;
  steps: Array<{ kind: string; action: string; label: string; value: string | null; protected: boolean; screenshot: boolean; url: string }>;
  grant: { method: string; url: string; type: string; status: number | null; requestBody: string; authorization: string } | null;
  images: number;
  leaked: boolean;
  sideSteps: number;
  sideStepsAfterDelete: number;
  badge: string;
  badgeAfterStop: string;
}

type CommandContext = { context: BrowserContext };

async function extensionPage(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
  return page;
}

/** 读录制库的一个表（读完马上关连接，免得挡住后台）。 */
function readStore(ext: Page, name: string): Promise<unknown[]> {
  return ext.evaluate(
    (store) =>
      new Promise<unknown[]>((resolve) => {
        const request = indexedDB.open("omem-record");
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            return resolve([]);
          }
          const all = db.transaction(store).objectStore(store).getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result as unknown[]);
          };
        };
        request.onerror = () => resolve([]);
      }),
    name
  );
}

const runRecordScenario: BrowserCommand<[string], RecordScenarioResult> = async (commandContext, origin) => {
  const { context } = commandContext as unknown as CommandContext;
  const ext = await extensionPage(context);
  const page = await context.newPage();
  const side = await context.newPage();
  try {
    const url = `${origin}/e2e/record-fixture.html`;
    await page.goto(url);
    const tabId = await ext.evaluate(async (target) => (await chrome.tabs.query({})).find((tab) => tab.url === target)?.id ?? -1, url);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "omem-record:discard" }));
    const started = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: "omem-record:start", goal: "给商户开通退款权限", tabId: id }), tabId);
    const badge = await ext.evaluate(() => chrome.action.getBadgeText({}));

    await page.bringToFront();
    await page.fill("#merchant", "B-1001");
    await page.fill("#password", "hunter2");
    await page.fill("#sms", "Q7X9Z2");
    await page.click("#grant");
    await page.waitForFunction(() => document.getElementById("result")?.textContent !== "");
    await page.waitForTimeout(1500);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "omem-record:mark", note: "这里看的是可退金额", element: null }));
    await page.bringToFront();
    await page.waitForTimeout(1200);
    await page.click("#next");
    await page.waitForURL(/step=2/);
    await page.waitForTimeout(1800);
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "omem-record:stop" }));
    const badgeAfterStop = await ext.evaluate(() => chrome.action.getBadgeText({}));

    type Step = { at: number; kind: string; screenshot?: string; action: { kind: string; label?: string; value?: string | null; protected?: boolean; url?: string } };
    type Req = { method: string; url: string; type: string; status?: number | null; requestBody?: string; requestHeaders?: Record<string, string> };
    const steps = ((await readStore(ext, "steps")) as Step[]).sort((a, b) => a.at - b.at);
    const requests = (await readStore(ext, "requests")) as Req[];
    const images = (await readStore(ext, "images")).length;
    const grant = requests.find((r) => r.method === "POST" && r.url.includes("pick-data.json")) ?? null;

    // 侧栏：录制页列出步骤，点两次 ✕ 删掉第一步
    await side.goto(ext.url().replace("popup.html", "sidepanel.html"));
    await side.getByTestId("side-tab-record").click();
    await side.locator(".rec-step").first().waitFor();
    const sideSteps = await side.locator(".rec-step").count();
    await side.locator(".rec-step-delete").first().click();
    await side.locator(".rec-step-delete").first().click();
    await side.waitForTimeout(800);
    const sideStepsAfterDelete = await side.locator(".rec-step").count();

    return {
      started: Boolean(started?.ok),
      steps: steps.map((s) => ({ kind: s.kind, action: s.action.kind, label: s.action.label ?? "", value: s.action.value ?? null, protected: !!s.action.protected, screenshot: !!s.screenshot, url: s.action.url ?? "" })),
      grant: grant && { method: grant.method, url: grant.url, type: grant.type, status: grant.status ?? null, requestBody: grant.requestBody ?? "", authorization: grant.requestHeaders?.authorization ?? grant.requestHeaders?.Authorization ?? "" },
      images,
      leaked: /hunter2|Q7X9Z2|abc-secret/.test(JSON.stringify([steps, requests])),
      sideSteps,
      sideStepsAfterDelete,
      badge,
      badgeAfterStop
    };
  } finally {
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: "omem-record:discard" })).catch(() => undefined);
    await side.close();
    await page.close();
    await ext.close();
  }
};

export const recordBrowserCommands = { runRecordScenario };
