/** Browser regression: node scripts/check-composition.ts (CHROMIUM may override the browser). */
import assert from "node:assert/strict";
import { chromium, type Locator } from "playwright";
import { createServer } from "vite";

// Mount real controls without a server account or an Agent. Requests stay inside the browser.
const fixture = `
import { createApp, h, ref } from 'vue';
import { compositionGuard } from '/src/lib/composition.ts';
import Home from '/src/views/Home.vue';
import CodeSteer from '/src/components/CodeSteer.vue';
import DialogHost from '/src/components/DialogHost.vue';
import UiSelect from '/src/components/UiSelect.vue';
import { promptDialog } from '/src/lib/dialog.ts';
import { createRouter, createMemoryHistory } from 'vue-router';
import '/src/styles.css';
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
const app = createApp({ setup() {
  const selected = ref('a');
  const count = ref(0);
  return () => h('main', [
    h(Home),
    h(CodeSteer, { runId: 'demo', coding: true, notes: [] }),
    h('form', { onSubmit: e => { e.preventDefault(); count.value++; } }, [h('input', { 'aria-label': '表单输入' }), h('button', { type: 'submit' }, '提交')]),
    h('textarea', { 'aria-label': '快捷键输入', onKeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); count.value++; } } }),
    h('output', { id: 'count' }, String(count.value)),
    h(UiSelect, { modelValue: selected.value, 'onUpdate:modelValue': v => selected.value = v, ariaLabel: '测试选择', searchAt: 1, options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] }),
    h('button', { id: 'prompt', onClick: () => promptDialog('测试输入') }, '打开弹窗'),
    h(DialogHost),
  ]);
} });
app.use(compositionGuard).use(router).mount('#app');
window.disposeFixture = () => app.unmount();
window.shortcutCount = 0;
window.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'k') window.shortcutCount++; });
`;
const vite = await createServer({
  configFile: "web/vite.config.ts",
  server: { port: 0, open: false },
  plugins: [{
    name: "composition-fixture",
    resolveId: (id) => id === "/__composition.ts" ? id : undefined,
    load: (id) => id === "/__composition.ts" ? fixture : undefined,
    configureServer(server) {
      server.middlewares.use("/__composition.html", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await server.transformIndexHtml("/__composition.html", '<div id="app"></div><script type="module" src="/__composition.ts"></script>'));
      });
    },
  }],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const requests: { url: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url()).pathname;
    if (req.method() === "POST") requests.push({ url, body: req.postDataJSON() });
    const body = url === "/api/home" ? { decisions: [], dueSoon: [], waiting: [], runs: [], study: { total: 0, due: 0, reviewedToday: 0 }, notifications: [], recentSources: [] }
      : url === "/api/ask" ? { conversationId: "demo" }
      : url === "/api/review-settings" ? { tiers: [] }
      : url.endsWith("/notes") ? { stage: "coding" } : [];
    await route.fulfill({ json: body });
  });
  await page.goto(`${vite.resolvedUrls!.local[0]}__composition.html`);
  const home = page.locator(".askbox textarea");
  await home.waitFor();
  type KeyInit = Pick<KeyboardEventInit, "key" | "keyCode" | "isComposing" | "ctrlKey" | "metaKey">;
  const key = async (input: Locator, init: KeyInit = {}) => input.evaluate((el, init) => {
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, init);
  const start = (input: Locator) => input.dispatchEvent("compositionstart", { data: "中" });
  const end = (input: Locator) => input.dispatchEvent("compositionend", { data: "中文" });

  // Exact Enter + .prevent, a direct input handler, and native implicit form submit.
  const steer = page.getByRole("textbox", { name: "补充给编码 Agent", exact: true });
  const form = page.getByRole("textbox", { name: "表单输入", exact: true });
  for (const input of [home, steer, form]) {
    await input.fill("已有文字");
    await start(input);
    assert.equal(await key(input), false, "IME default action must stay available");
    await input.press("Enter");
    assert.equal(requests.length, 0, "composition must not send requests");
    assert.equal(await page.locator("#count").textContent(), "0");
    await end(input);
    assert.equal(await key(input, { isComposing: true }), false);
    // Safari: compositionend precedes the confirmation keydown, keyCode is still 229.
    assert.equal(await key(input, { keyCode: 229 }), false);
    assert.equal(requests.length, 0);
  }
  await home.fill("中文问题");
  await home.press("Shift+Enter");
  assert.match(await home.inputValue(), /\n/);
  assert.equal(requests.length, 0);
  await home.fill("中文问题");
  await start(home);
  await home.evaluate((el) => {
    (el as HTMLTextAreaElement).value = "中文问题补充";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: "补充", isComposing: true }));
  });
  assert.equal(await key(home), false);
  assert.equal(requests.length, 0, "do not send the previous v-model value before composition commits");
  await end(home);
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST"), home.press("Enter")]);
  assert.equal(requests.filter((r) => r.url === "/api/ask").length, 1);
  assert.equal((requests[0].body as { text: string }).text, "中文问题补充");
  await steer.fill("补充中文要求");
  await Promise.all([page.waitForResponse((r) => r.url().endsWith("/notes") && r.request().method() === "POST"), steer.press("Enter")]);
  assert.equal(requests.filter((r) => r.url.endsWith("/notes")).length, 1);
  await form.press("Enter");
  assert.equal(await page.locator("#count").textContent(), "1");

  const shortcut = page.getByRole("textbox", { name: "快捷键输入", exact: true });
  for (const modifier of ["ctrlKey", "metaKey"]) {
    await start(shortcut);
    assert.equal(await key(shortcut, { [modifier]: true }), false);
    await end(shortcut);
    assert.equal(await key(shortcut, { [modifier]: true }), true);
  }
  assert.equal(await page.locator("#count").textContent(), "3");
  await start(shortcut);
  await key(shortcut, { key: "k", ctrlKey: true });
  assert.equal(await page.evaluate("window.shortcutCount"), 0);
  await end(shortcut);
  await key(shortcut, { key: "k", ctrlKey: true });
  assert.equal(await page.evaluate("window.shortcutCount"), 1);

  // Teleported select: candidate navigation must not select, move or dismiss the list.
  await page.getByRole("combobox").click();
  const filter = page.getByRole("textbox", { name: "筛选测试选择", exact: true });
  await start(filter);
  const active = await page.getByRole("combobox").getAttribute("aria-activedescendant");
  for (const k of ["ArrowDown", " ", "Enter", "Escape"]) assert.equal(await key(filter, { key: k }), false);
  assert.equal(await page.getByRole("listbox").count(), 1);
  assert.equal(await page.getByRole("combobox").getAttribute("aria-activedescendant"), active);
  await end(filter);
  await filter.press("Escape");
  assert.equal(await page.getByRole("listbox").count(), 0);

  // Teleported prompt: confirming/cancelling IME candidates must leave the dialog open.
  await page.locator("#prompt").click();
  const prompt = page.getByRole("alertdialog").getByRole("textbox");
  await start(prompt);
  for (const k of ["Enter", "Escape"]) assert.equal(await key(prompt, { key: k }), false);
  assert.equal(await page.getByRole("alertdialog").count(), 1);
  await end(prompt);
  await prompt.fill("中文名称");
  await prompt.press("Enter");
  assert.equal(await page.getByRole("alertdialog").count(), 0);

  // Blur recovers from a cancelled composition with no compositionend.
  await start(shortcut);
  await shortcut.dispatchEvent("blur");
  assert.equal(await key(shortcut, { ctrlKey: true }), true);
  await page.evaluate("window.disposeFixture()");
  await page.evaluate(() => {
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, isComposing: true, bubbles: true }));
  });
  assert.equal(await page.evaluate("window.shortcutCount"), 2, "unmount removes the guard");
  console.log("Composition browser regression passed (Enter, modifiers, forms, dialogs, select, shortcuts, blur, cleanup).");
} finally {
  await browser?.close();
  await vite.close();
}
