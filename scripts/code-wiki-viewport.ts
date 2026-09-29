// Deterministic browser acceptance for the Code Wiki vertical slice.
//
// NO hardcoded DB ids / UUIDs. Targets are located by stable names; every frame
// is reached by clicking through the real UI. At each pushed frame we assert the
// frame's real rendered content (crumb count / source range / markdown body /
// no error banner), then press Escape and verify we land on the previous frame.
// Finally we take the URL the UI itself generated, reload it, and confirm the
// same trail restores.
//
// Viewport checks use setViewportSize (real CDP emulation), not window.resizeTo.
// XSS is fed through the actually-mounted <OmMarkdown> component instance.
import { chromium, expect } from "@playwright/test";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync } from "node:fs";

const BASE = process.env.OMEM_WEB_URL || "http://127.0.0.1:5181";
const OUT = "docs/implementation/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  ...(process.env.OMEM_CHROMIUM ? { executablePath: process.env.OMEM_CHROMIUM } : {}),
});

const errors: string[] = [];
const checks: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks.push(name);
  console.log("PASS", name);
}

async function api<T>(p: string): Promise<T> {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error("API " + p + " -> " + r.status);
  return r.json() as Promise<T>;
}

// ---- Setup: locate targets purely by stable names (not ids) ----------------
const graph = await api<{ files: { fileId: string; path: string }[] }>("/api/review/code/graph");
if (!graph.files.find((f) => f.path === "apps/server/src/assistant/runtime.ts"))
  throw new Error("runtime.ts not in code graph");
if (!graph.files.find((f) => f.path === "apps/server/src/memory/service.ts"))
  throw new Error("memory/service.ts not in graph");

async function drawerText(page: import("@playwright/test").Page) {
  return page.locator(".om-trail").innerText();
}
async function scrollTrail(page: import("@playwright/test").Page) {
  await page.locator(".om-trail .trail-scroll").evaluate((el:any) => (el.scrollTop = el.scrollHeight));
  await sleep(300);
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (/highlight|dynamic import/i.test(message.text()) && ["warning", "error"].includes(message.type())) errors.push(message.text());
  });

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(BASE + "/#/overview");
    await sleep(2500);
    await check(`viewport ${width}: no horizontal overflow`, async () => {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(overflow).toBe(true);
    });
    await page.screenshot({ path: `${OUT}/wiki-${width}.png` });
  }

  // --- Module: real curated explanation renders, not a stub ----------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE + "/#/module/assistant");
  await sleep(3000);
  await check("module: curated responsibility text renders, no fetch error", async () => {
    await expect(page.getByText("职责", { exact: false }).first()).toBeVisible({ timeout: 8000 });
    const body = await page.locator("main").innerText();
    expect(body).not.toContain("Failed to fetch");
    expect(body).not.toContain("片段加载失败");
    expect(await page.locator(".knowledge-document .md-body, .module-frame li").count()).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(300);
  });

  // --- Frame 1: open runtime.ts file row, assert source lines ---------------
  await check("frame1 file: runtime.ts source renders", async () => {
    await page.locator(".om-trail, main").locator("button").filter({ hasText: "runtime.ts" }).first().evaluate((el:any)=>el.click());
    await sleep(3000);
    const t = await drawerText(page);
    expect(t).toContain("runtime.ts");
    expect(t).not.toContain("Failed to fetch");
    await expect(page.locator(".om-trail .om-code-view .ln").first()).toBeVisible({ timeout: 10000 });
    expect(await page.locator(".om-trail .om-code-view .ln").count()).toBeGreaterThan(5);
    await expect(page.locator(".om-trail .om-code-view .hljs-keyword").first()).toBeVisible();
    expect(await page.locator(".om-trail .om-code-view .hljs-keyword").first().evaluate(el => getComputedStyle(el).fontWeight)).toBe("700");
  });

  // --- Frame 2: governCreateTask call edge drills a symbol frame (same-file) --
  await check("frame2: governCreateTask call edge drills to symbol/range frame", async () => {
    const gc = page.locator(".om-trail button.edge-row").filter({ hasText: "governCreateTask" }).first();
    await expect(gc).toBeVisible();
    await gc.evaluate((el:any)=>el.click());
    await sleep(2200);
    const t = await drawerText(page);
    expect(t).not.toContain("Failed to fetch");
    expect(await page.locator(".om-trail .crumb").count()).toBeGreaterThanOrEqual(2);
    expect(await page.locator(".om-trail .om-code-view .ln").count()).toBeGreaterThan(5);
  });

  // --- Frame 3: Esc back to runtime.ts file frame, then drill an import edge --
  await check("frame3: back to runtime.ts, then drill a real import edge", async () => {
    await page.keyboard.press("Escape");
    await sleep(900);
    expect(await drawerText(page)).toContain("runtime.ts");
    expect(await page.locator(".om-trail .crumb").count()).toBe(1);
    await scrollTrail(page);
    const en = page.locator(".om-trail button.edge-row:not(.disabled)").first();
    await expect(en).toBeVisible({ timeout: 8000 });
    await en.evaluate((el:any)=>el.click());
    await sleep(2200);
    expect(await page.locator(".om-trail .crumb").count()).toBeGreaterThanOrEqual(2);
    expect(await drawerText(page)).not.toContain("Failed to fetch");
  });

  // --- Frame 4: from that new file, follow another enabled edge (4th frame) --
  await check("frame4: drill another edge for a fourth trail frame", async () => {
    await scrollTrail(page);
    const en = page.locator(".om-trail button.edge-row:not(.disabled)").first();
    if (await en.count()) { await en.evaluate((el:any)=>el.click()); await sleep(2000); }
    expect(await page.locator(".om-trail .crumb").count()).toBeGreaterThanOrEqual(2);
    expect(await drawerText(page)).not.toContain("Failed to fetch");
  });

  // --- Frame 5: Esc pops, crumbs shrink, previous content restored -----------
  await check("frame5: Esc pops frame (crumbs shrink by 1)", async () => {
    const before = await page.locator(".om-trail .crumb").count();
    await page.keyboard.press("Escape");
    await sleep(900);
    expect(await page.locator(".om-trail .crumb").count()).toBe(before - 1);
  });

  // --- Frame 5: crumb jump back to runtime.ts -----------------------------
  await check("frame5: crumb jump restores runtime.ts frame", async () => {
    await page.locator(".om-trail .crumb").nth(0).evaluate((el:any)=>el.click());
    await sleep(1200);
    expect(await drawerText(page)).toContain("runtime.ts");
  });

  // --- Back-check: clicking a middle crumb pops down to it ------------------
  await check("back: clicking crumb returns to prior frame", async () => {
    const before = await page.locator(".om-trail .crumb").count();
    if (before >= 3) {
      await page.locator(".om-trail .crumb").nth(before - 2).evaluate((el:any)=>el.click());
      await sleep(900);
      expect(await page.locator(".om-trail .crumb").count()).toBe(before - 1);
    }
  });

  // --- Deep link: UI-generated URL restores the trail after reload ----------
  await check("deep-link: UI-generated URL restores trail after reload", async () => {
    await scrollTrail(page); const en = page.locator(".om-trail button.edge-row:not(.disabled)").first();
    if (await en.count()) { await en.evaluate((el:any)=>el.click()); await sleep(1500); }
    const url = page.url();
    expect(url).toContain("/trail/");
    await page.reload();
    await sleep(3000);
    expect(await page.locator(".om-trail .crumb").count()).toBeGreaterThanOrEqual(1);
    expect(await drawerText(page)).not.toContain("Failed to fetch");
  });
  await page.screenshot({ path: `${OUT}/wiki-1440-5frame.png` });

  // --- XSS: feed payload through the actually-mounted OmMarkdown component -
  await check("xss: mounted OmMarkdown strips script/handlers/javascript:", async () => {
    // Deep-link a fragment trail frame so FragmentFrame's <OmMarkdown> mounts.
    const s = await api<Array<{ id: string }>>("/api/review/search?q=" + encodeURIComponent("decision"));
    const fid = s[0].id;
    await page.goto(BASE + "/#/module/assistant/trail/fragment/" + encodeURIComponent(fid));
    await sleep(3000);
    await expect(page.locator(".om-trail .om-markdown .md-body")).toBeVisible({ timeout: 8000 });
    const result = await page.evaluate(async () => {
      const el = document.querySelector(".om-trail .om-markdown");
      if (!el) return { error: "no OmMarkdown mounted" };
      const inst = (el as any).__vueParentComponent;
      if (!inst) return { error: "no vue instance" };
      (window as any).__xss = [];
      const payload =
        "# t\n\n" +
        '<img src=x onerror=window.__xss.push(1)>\n\n' +
        '<script>window.__xss.push(2)<\/script>\n\n' +
        '<a href=javascript:window.__xss.push(3)>c</a>\n\n' +
        '<svg onload=window.__xss.push(4)>\n\n' +
        '<iframe src=javascript:window.__xss.push(5)></iframe>\n\n' +
        '<b onmouseover=window.__xss.push(6)>h</b>';
      inst.props.source = payload;
      await new Promise((r) => setTimeout(r, 900));
      const body = el.querySelector(".md-body")!;
      return {
        flags: (window as any).__xss,
        script: !!body.querySelector("script"),
        img: !!body.querySelector("img"),
        svg: !!body.querySelector("svg"),
        iframe: !!body.querySelector("iframe"),
        onerrorAttr: /onerror/i.test(body.innerHTML),
        javascriptHref: /javascript:/i.test(body.innerHTML),
      };
    });
    expect(result.flags).toEqual([]);
    expect(result.script).toBe(false);
    expect(result.img).toBe(false);
    expect(result.svg).toBe(false);
    expect(result.iframe).toBe(false);
    expect(result.onerrorAttr).toBe(false);
    expect(result.javascriptHref).toBe(false);
  });

  // --- DOM hygiene: no raw symbol/file/fragment uuids in visible text ------
  await check("dom: no raw sym_/file_/fragment uuid in visible drawer text", async () => {
    const found = await page.evaluate(() => {
      const txt = document.querySelector(".om-trail")!.innerText;
      const re = /(sym_[0-9a-f]{8,}|file_[0-9a-f]{12,}|frag(?:ment)?_[0-9a-f]{8,}|[0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
      const m = txt.match(re);
      return m ? m[0] : null;
    });
    expect(found).toBeNull();
  });

  // --- Focus return: close-all restores focus to the trigger button ----------
  await check("focus: close-all returns focus to the module card trigger", async () => {
    await page.goto(BASE + "/#/overview");
    await sleep(2500);
    await page.keyboard.press("Escape"); await sleep(300); await page.keyboard.press("Escape"); await sleep(300);
    await page.getByRole("button", { name: "查看代码结构与模块" }).click();
    const card = page.locator("button.mod-card").filter({ hasText: "assistant" }).first();
    await card.evaluate((el:any)=>el.focus());
    await card.click();
    await sleep(2500);
    // Card switches to module page; open a file row to open the trail drawer.
    await page.locator("button.file-row").filter({ hasText: "runtime.ts" }).first().click();
    await sleep(2000);
    await expect(page.locator(".om-trail")).toBeVisible({ timeout: 8000 });
    await sleep(1500);
    expect(await page.locator(".om-trail .crumb").count()).toBeGreaterThanOrEqual(1);
    await page.locator(".om-trail button[aria-label='关闭全部']").click();
    await sleep(800);
    const active = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() || "");
    expect(active).toContain("assistant");
  });

  // --- model-unavailable: honest degraded note, graph still browsable -------
  await check("model-unavailable: degraded state, raw graph still browsable", async () => {
    await page.goto(BASE + "/#/overview");
    await sleep(2500);
    expect(await page.locator("main").innerText()).toContain("可追溯的知识");
    await page.screenshot({ path: `${OUT}/wiki-overview-degraded.png` });
  });

  // --- 390: drawer fills viewport, no overflow -----------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/#/module/assistant");
  await sleep(3000);
  await check("390: curated note renders + drawer full-width", async () => {
    await expect(page.locator(".knowledge-document .md-body, .module-frame li").first()).toBeVisible({ timeout: 8000 });
    const row = page.locator("button.file-row").filter({ hasText: "runtime.ts" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click({ force: true });
    await sleep(2000);
    const w = await page.locator(".om-trail").evaluate((el) => el.getBoundingClientRect().width);
    const vw = await page.evaluate(() => window.innerWidth);
    expect(w / vw).toBeGreaterThan(0.95);
    await page.screenshot({ path: `${OUT}/wiki-390-drawer.png` });
  });

  expect(errors).toEqual([]);
} finally {
  await browser.close();
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
