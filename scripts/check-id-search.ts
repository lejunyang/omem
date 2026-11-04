/** Browser regression: node scripts/check-id-search.ts (CHROMIUM may override the browser). */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const fixture = `
import { createApp, h } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import CommandPalette from '/src/components/CommandPalette.vue';
import Runs from '/src/views/Runs.vue';
import { state } from '/src/store.ts';
import '/src/styles.css';
const view = new URL(location.href).searchParams.get('view');
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] });
await router.push('/runs');
state.space = 'personal';
createApp({ render: () => h(view === 'runs' ? Runs : CommandPalette) }).use(router).mount('#app');
if (view !== 'runs') state.palette = true;
`;
const vite = await createServer({
  configFile: "web/vite.config.ts",
  server: { port: 0, open: false },
  plugins: [{
    name: "id-search-fixture",
    resolveId: (id) => id === "/__id-search.ts" ? id : undefined,
    load: (id) => id === "/__id-search.ts" ? fixture : undefined,
    configureServer(server) {
      server.middlewares.use("/__id-search.html", async (_req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(await server.transformIndexHtml("/__id-search.html", '<div id="app"></div><script type="module" src="/__id-search.ts"></script>'));
      });
    },
  }],
});
const run = (id: string, title = `精确结果 ${id}`) => ({ id, title, kind: "ask", status: "done", input: {}, output: {}, spaceId: "personal", profileId: null, parentId: null, error: null, createdAt: "2026-01-01", startedAt: null, finishedAt: null });
const hit = (id: string) => ({ type: "memory", id, title: `相关结果 ${id}`, snippet: "关联材料", spaceId: "personal", path: "", score: 1, via: [] });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  for (const width of [1440, 390]) {
    for (const view of ["palette", "runs"]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript(() => { window.EventSource = class { onmessage = null; close() {} } as unknown as typeof EventSource; });
      const pending: { url: URL; release: (json: unknown) => void }[] = [];
      const exactRequests: string[] = [];
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        let json: unknown = [];
        if (url.pathname === "/api/lookup") {
          const id = url.searchParams.get("id")!;
          exactRequests.push(id);
          json = { hits: [{ type: "run", id, title: `精确结果 ${id}`, snippet: "ask · done", spaceId: "personal" }] };
        } else if (url.pathname === "/api/search" || (url.pathname === "/api/runs" && url.searchParams.has("q"))) {
          json = await new Promise((release) => pending.push({ url, release }));
        } else if (url.pathname === "/api/runs") {
          const id = url.searchParams.get("id");
          if (id) exactRequests.push(id);
          json = { runs: id ? [run(id)] : [], total: id ? 1 : 0 };
        }
        await route.fulfill({ json });
      });
      await page.goto(`${vite.resolvedUrls!.local[0]}__id-search.html?view=${view}`);
      const input = view === "palette" ? page.locator(".bar input") : page.getByRole("textbox", { name: "搜索运行记录" });
      const loading = view === "palette" ? page.locator(".searching") : page.locator(".list-foot");
      const fill = async (id: string) => {
        await input.fill(id);
        await page.getByText(`精确结果 ${id}`, { exact: true }).waitFor();
        await loading.filter({ hasText: "搜索中" }).waitFor();
        assert.equal(exactRequests.at(-1), id);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      };
      const take = async (query: string, offset = 0) => {
        for (let i = 0; i < 100; i++) {
          const index = pending.findIndex((r) => r.url.searchParams.get("q") === query && Number(r.url.searchParams.get("offset") ?? 0) === offset);
          if (index >= 0) return pending.splice(index, 1)[0];
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`missing text request: ${query} / ${offset}`);
      };
      await fill("r123456789");
      const old = await take("r123456789");
      await page.screenshot({ path: join(tmpdir(), `omem-id-search-${view}-${width}.png`) });
      await fill("r987654321");
      const current = await take("r987654321");
      old.release(view === "palette" ? { hits: [hit("m_old123")] } : { runs: [run("r_old123", "过期结果")], total: 1 });
      // An old completion must neither replace the current result nor clear its loading state.
      await page.waitForTimeout(80);
      assert.equal(await page.getByText(/过期结果|相关结果 m_old123/).count(), 0);
      await loading.filter({ hasText: "搜索中" }).waitFor();
      if (view === "palette") {
        current.release({ hits: [hit("m_new123")] });
        await page.getByText("相关结果 m_new123", { exact: true }).waitFor();
        assert.equal(await page.locator(".id-hit").count(), 1);
        assert.equal(await page.locator(".searching").count(), 0);
      } else {
        const related = Array.from({ length: 39 }, (_, i) => run(`r_ref${i}`, `相关运行 ${i}`));
        current.release({ runs: [...related, run("r987654321")], total: 42 });
        await loading.filter({ hasText: "搜索中" }).waitFor({ state: "hidden" });
        assert.equal(await page.locator(".run").first().innerText().then((s) => s.includes("精确结果 r987654321")), true);
        await page.locator(".items").evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event("scroll")); });
        const more = await take("r987654321", 40);
        more.release({ runs: [run("r_next40", "下一页 40"), run("r_next41", "下一页 41")], total: 42 });
        await page.getByText("共 42 条", { exact: true }).waitFor();
      }
      await page.close();
    }
  }
  console.log("ID-first results, loading, stale replies, deduplication and pagination passed at 1440/390.");
} finally { await browser?.close(); await vite.close(); }
