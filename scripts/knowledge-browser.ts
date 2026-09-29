// Real Vue/API/SQLite navigation checks with explicit fixture knowledge. No LLM.
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../apps/server/src/store.js";
import { runReviewSync } from "../apps/server/src/review/sync.js";
import { runCodeSync } from "../apps/server/src/code/sync.js";
import { buildReviewApp } from "../apps/server/src/review/app.js";
import { createReviewKnowledgeRepository } from "../apps/server/src/review/materials.js";
import { bindKnowledgeQuotes } from "../apps/server/src/knowledge/repository.js";
import type { KnowledgeDocument, KnowledgeArtifact } from "../packages/contracts/src/knowledge.js";

const root = mkdtempSync(join(tmpdir(), "knowledge-browser-"));
mkdirSync(join(root, "apps/server/src"), { recursive: true });
writeFileSync(join(root, "apps/server/src/a.ts"), 'import { b } from "./b.js";\nexport function a() { return b(); }\n');
writeFileSync(join(root, "apps/server/src/b.ts"), 'import { c } from "./c.js";\nexport function b() { return c(); }\n');
writeFileSync(join(root, "apps/server/src/c.ts"), 'export function c() { return 42; }\n');
const store = new Store(join(root, ".repo-review/runtime/data"));
await runReviewSync(store, root); await runCodeSync(store, root);
const repository = createReviewKnowledgeRepository(store);
const materials = new Map(repository.materials().map(m => [m.key, m]));
function publish(key: string, title: string, target: string, kind: "material" | "article", label: string, long = false) {
  const document: KnowledgeDocument = { key, title, summary: "用于验证真实内联引用阅读行为的 fixture 内容。", category: key.startsWith("topic:") ? "overview" : "implementation",
    sections: [{ key: "behavior", title: "职责与关联", body: `${long ? "这段解释保留阅读位置。\n\n".repeat(30) : "正文解释当前职责。"}相关依据就在这段文字旁。[[next]]` }],
    citations: [{ key: "next", label, reason: "这份引用解释了当前段落所依赖的具体行为。", relation: "explains", target: { kind, key: target, ...(kind === "material" ? { startLine: 1, endLine: 1 } : { section: "behavior" }) }, quote: "" }], questions: [] };
  if (key.endsWith("/a.ts")) {
    document.sections[0]!.body += "\n\n也可以核对实现原文。[[source]]";
    document.citations.push({ key: "source", label: "A 的实现", reason: "源文件显示了真实 import。", relation: "supports", target: { kind: "material", key, startLine: 1, endLine: 1 }, quote: "" });
    document.questions.push({ question: "A 的责任人是谁？", why: "固定材料没有说明责任人。", nextStep: "向维护者确认责任归属。", blocking: false, citationKeys: ["source"] });
  }
  bindKnowledgeQuotes(document, materials);
  const dependencies: KnowledgeArtifact["dependencies"] = document.citations.map(c => ({ kind: c.target.kind, key: c.target.key, digest: c.target.kind === "material" ? materials.get(c.target.key)!.digest : repository.get(c.target.key)!.revision }));
  return repository.publish({ version: 1, document, dependencies, generation: { model: "fixture-writer", effort: null, at: "2026-01-01T00:00:00Z", trace: {} }, review: { model: "fixture-reviewer", at: "2026-01-01T00:00:01Z", trace: {}, verdict: "accepted" } });
}
const a = "omem:apps/server/src/a.ts", b = "omem:apps/server/src/b.ts", c = "omem:apps/server/src/c.ts";
publish(c, "模块 C", c, "material", "C 的实现");
publish(b, "模块 B", c, "article", "模块 C 的说明");
publish(a, "模块 A", b, "article", "模块 B 的说明", true);
publish("topic:architecture", "架构说明", a, "article", "模块 A 的说明");
publish("topic:overview", "知识总览", "topic:architecture", "article", "架构说明");
const { app } = await buildReviewApp({ store, repoRoot: root, webDistDir: resolve("apps/web/dist") });
const base = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/#/overview");
  const entry = page.locator(".knowledge-home > .knowledge-document").getByRole("link", { name: "架构说明 ↗", exact: true });
  await entry.click();
  await expect(page.locator(".om-trail .citation-reason")).toContainText("当前段落");
  for (const label of ["模块 A 的说明", "模块 B 的说明", "模块 C 的说明", "C 的实现"]) {
    await page.locator(".om-trail").getByRole("link", { name: label + " ↗", exact: true }).click();
  }
  await expect(page.locator(".om-trail .crumb")).toHaveCount(5);
  await expect(page.locator(".om-trail .om-code-view")).toContainText("return");
  await page.keyboard.press("Escape");
  await expect(page.locator(".om-trail .crumb")).toHaveCount(4);
  const url = page.url(); await page.reload();
  await expect(page.locator(".om-trail .crumb")).toHaveCount(4);
  await expect(page.locator(".om-trail").getByRole("link", { name: "C 的实现 ↗", exact: true })).toBeVisible();
  expect(url).toContain("/trail/");
  await page.locator(".om-trail button[aria-label='关闭全部']").click();
  await entry.click();
  await page.locator(".om-trail button[aria-label='关闭全部']").click();
  await expect(entry).toBeFocused();
  console.log("PASS inline narrative -> chapter -> three modules -> fixed code; reasons, Esc, deep link and focus");

  await page.locator(".knowledge-card").filter({ hasText: "模块 A" }).first().click();
  await page.locator(".om-trail").getByRole("link", { name: "A 的实现 ↗", exact: true }).click();
  await page.locator(".om-trail .line-reference").filter({ hasText: "b.ts" }).click();
  await expect(page.locator(".om-trail .knowledge-document h2")).toHaveText("模块 B");
  console.log("PASS import reference opens the target module's knowledge");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  console.log("PASS 1440/768/390 without horizontal overflow");
  await page.locator(".om-trail button[aria-label='关闭全部']").click();
  const questions = page.locator(".knowledge-home > .knowledge-questions");
  await questions.locator("summary").click();
  await questions.getByRole("button", { name: "加入待办", exact: true }).click();
  await expect(questions).toContainText("已加入待办");
  expect(store.tasks()).toHaveLength(1);
  console.log("PASS unresolved knowledge becomes an explicit user-created task");
  expect(errors).toEqual([]);
} finally { await browser.close(); await app.close(); rmSync(root, { recursive: true, force: true }); }
