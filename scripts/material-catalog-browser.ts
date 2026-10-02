/** Real dev UI/API verification. No intercepted requests and no invented model output.
 * Run only against an explicitly isolated development data directory. */
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.env.OMEM_WEB_URL;
if (!base) throw Error("Set OMEM_WEB_URL to an isolated osdk run dev instance");
const out =
  process.env.OMEM_BROWSER_OUT ??
  ".repo-review/runtime/browser/material-catalog";
mkdirSync(out, { recursive: true });
async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw Error(JSON.stringify(value));
  return value;
}
const source = {
  source: "manual",
  externalId: "catalog-browser-example",
  title: "材料用途界面验收：配送约定",
  context: {},
  parts: [
    {
      type: "text",
      text: "# 配送受理\n\n事件编号保存在受理账本，再次收到相同编号只读取结果。\n\n# 包装\n\n包装箱使用可回收材料。",
    },
  ],
};
const captured = await api("/captures", source),
  original = captured.revision;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OMEM_CHROMIUM
    ? { executablePath: process.env.OMEM_CHROMIUM }
    : {}),
});
const errors: string[] = [],
  checks: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base!);
  await page
    .locator(".navigation")
    .getByRole("button", { name: "原始材料", exact: true })
    .click();
  await page.getByLabel("查找原始材料").fill(source.title);
  await page.locator(".source-link").filter({ hasText: source.title }).click();
  await page
    .locator(".reader .material-description")
    .getByRole("button", { name: "材料用途与适用范围", exact: true })
    .click();
  const form = page.locator(".reader .material-description");
  await form.getByRole("button", { name: /填写说明|修正说明/ }).click();
  await form.getByLabel("主要用途").selectOption("reference");
  await form.getByLabel("适用状态").selectOption("unknown");
  await form
    .getByLabel("这份材料说明什么")
    .fill("说明重复通知如何受理，另有包装材料要求。");
  await form.getByLabel("主题（用逗号分隔）").fill("配送，受理");
  await form.getByLabel("适用对象或场景").fill("配送通知受理");
  await form
    .getByLabel("分类和状态的依据")
    .fill("原文说明重复编号只读原结果；未提供生效日期。");
  if ((await form.locator("fieldset").count()) === 0)
    await form.getByRole("button", { name: "添加概念入口" }).click();
  const concept = form.locator("fieldset").first();
  await concept.getByLabel("说明", { exact: true }).fill("幂等受理");
  await concept.getByLabel("常用别称").fill("包裹投递去重");
  await concept.getByLabel("原文开始行").fill("3");
  await concept.getByLabel("原文结束行").fill("3");
  await form.getByRole("button", { name: "保存修正" }).click();
  await expect(form).toContainText("已人工修正");
  const saved = (await api("/material-descriptions/" + original.id)).record;
  expect(saved.description.role).toBe("reference");
  expect(saved.description.concepts[0].startLine).toBe(3);
  expect((await api("/revisions/" + original.id)).parts).toEqual(
    original.parts,
  );
  checks.push("UI correction persisted without changing original text");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await form.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: out + `/description-${width}.png`,
      fullPage: true,
    });
    await form.getByRole("button", { name: "修正说明" }).click();
    await page.screenshot({
      path: out + `/editor-${width}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await form.getByRole("button", { name: "取消", exact: true }).click();
  }
  checks.push("description and editor have no page overflow at 1440/768/390");
  await page.setViewportSize({ width: 1440, height: 1000 });
  const search = page.getByPlaceholder("搜索材料与经历…");
  await search.fill("包裹投递去重");
  await page.getByLabel("筛选命中材料").selectOption("reference");
  await expect(
    page.locator(".page .om-panel").filter({ hasText: source.title }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(".page .om-panel").filter({ hasText: source.title }),
  ).toContainText("受理账本");
  await page.screenshot({
    path: out + "/filtered-search-1440.png",
    fullPage: true,
  });
  await page.getByLabel("筛选命中材料").selectOption("plan");
  await expect(
    page.locator(".page .om-panel").filter({ hasText: source.title }),
  ).toHaveCount(0);
  checks.push(
    "actual search finds the annotated passage and respects role filtering",
  );
  expect(errors).toEqual([]);
  writeFileSync(
    out + "/report.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base,
        mode: "real-dev-api-no-model-call",
        revisionId: original.id,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser.close();
}
