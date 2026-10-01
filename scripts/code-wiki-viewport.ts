// Live repository knowledge in the personal application. Locate by readable
// article/source names; fixed IDs are discovered only through the real API.
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const BASE = process.env.OMEM_WEB_URL || "http://127.0.0.1:5173";
const OUT = ".repo-review/runtime/browser";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.OMEM_CHROMIUM ? { executablePath: process.env.OMEM_CHROMIUM } : {}) });
const checks: string[] = [], errors: string[] = [];
async function api(path: string) { const response = await fetch(BASE + path); if (!response.ok) throw Error(`${path}: ${response.status}`); return response.json(); }
async function check(name: string, run: () => Promise<void>) { await run(); checks.push(name); console.log("PASS", name); }
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE);
  await check("unified app has real repository chapters", async () => {
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "知识目录" })).toBeVisible();
    await expect(page.locator(".book-content .article-body > h2")).toBeVisible({ timeout: 30000 });
    const catalog = await api("/api/knowledge/articles");
    expect(catalog.materials.some((m: any) => m.path === "README.md")).toBe(true);
    expect(catalog.articles.filter((a: any) => a.key.startsWith("topic:")).length).toBeGreaterThan(4);
    await expect(page.getByRole("navigation", { name: "本篇目录" })).toBeVisible();
  });
  await check("menu and breadcrumbs agree; Lark errors stay on its page", async () => {
    for (const name of ["飞书机器人", "日常助理", "能力与连接", "知识库", "日常助理", "知识库"]) {
      await page.locator(".navigation").getByRole("button", { name, exact: true }).click();
      await expect(page.locator(".page-bar")).toContainText(name);
      await expect(page.locator(".navigation .active")).toHaveText(name);
      if (name !== "飞书机器人") await expect(page.locator(".lark-page-error")).toHaveCount(0);
      await expect(page.locator(".error-banner")).toHaveCount(0);
    }
  });
  await check("citations open the fixed code range and expand context", async () => {
    const catalog = await api("/api/knowledge/articles");
    const meta = catalog.articles.find((a: any) => a.key === "omem:apps/server/src/agent-runtime/gateway.ts");
    expect(meta).toBeTruthy();
    await page.getByLabel("查找章节", { exact: true }).fill("apps/server/src/agent-runtime/gateway.ts");
    await page.getByRole("button", { name: meta.title, exact: true }).click();
    const article = await api("/api/knowledge/articles/" + encodeURIComponent(meta.key));
    const c = article.citations.find((c: any) => c.actionable && c.resolved?.kind === "material" && c.resolved.key.endsWith("gateway.ts") && c.resolved.startLine > 20);
    expect(c).toBeTruthy();
    const trigger = page.locator(".book-content").getByRole("link", { name: c.label, exact: true }).first();
    await trigger.click();
    const drawer = page.locator("dialog[open]");
    await expect(drawer.locator(".code-table tr")).toHaveCount(c.resolved.endLine - c.resolved.startLine + 1);
    await expect(drawer.locator(".code-table tr").first()).toHaveAttribute("data-line", String(c.resolved.startLine));
    await drawer.getByRole("button", { name: "向上展开 20 行" }).click();
    await expect(drawer.locator(".code-table tr").first()).toHaveAttribute("data-line", String(Math.max(1, c.resolved.startLine - 20)));
    await drawer.getByRole("button", { name: "向下展开 20 行" }).click();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await drawer.getByRole("button", {name:/阅读这份材料的知识解读/}).click();
    await expect(drawer.locator(".layer-chip")).toContainText("第 2 层");
    expect(page.url()).toContain("/trail/");
    await page.reload();
    await expect(page.locator("dialog[open] .layer-chip")).toContainText("第 2 层");
    await expect(page.locator("dialog[open] .article-body > h2")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open] .layer-chip")).toContainText("第 1 层");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(page.locator(".book-content .om-paragraph-references").first()).toBeVisible();
  });
  await check("README reads as a document with intact code fences", async () => {
    await page.getByRole("button", { name: "原始材料", exact: true }).click();
    await page.getByLabel("查找原始材料").fill("README.md");
    await page.locator(".source-link").filter({ has: page.locator("span", { hasText: /^README\.md$/ }) }).click();
    await expect(page.locator(".reader .md-body h1")).toBeVisible();
    expect(await page.locator(".reader .md-body pre code").count()).toBeGreaterThan(0);
    await expect(page.locator(".reader")).not.toContainText("片段 1");
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByLabel("查找章节", { exact: true }).fill("");
  });
  for (const width of [1440, 768, 390]) await check(`readable layout at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator(".book-content .article-body > h2")).toBeVisible();
    await expect(page.locator(".book-content .md-body p").first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/knowledge-${width}.png`, fullPage: true });
  });
  expect(errors).toEqual([]);
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ base: BASE, checks, errors }, null, 2));
} finally { await browser.close(); }
