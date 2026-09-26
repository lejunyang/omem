// Real Vue + API + SQLite test. Fixture Agent is used only to make UI assertions deterministic.
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { profileSchema } from "../packages/contracts/src/index.js";
const dir = mkdtempSync(join(tmpdir(), "omem-browser-"));
const { app, store } = await buildApp({
  dataDir: dir,
  agentCwd: join(dir, "agent"),
  host: "127.0.0.1",
  port: 0,
  token: undefined,
  captureRoots: [],
  notifications: { mode: "instant" },
  profiles: [
    profileSchema.parse({
      id: "fixture",
      name: "协议测试 Agent",
      transport: "acp",
      command: process.execPath,
      args: [resolve("apps/server/tests/fixtures/acp-agent.mjs")],
    }),
  ],
});
const base = await app.listen({ port: 0, host: "127.0.0.1" });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OMEM_CHROMIUM
    ? { executablePath: process.env.OMEM_CHROMIUM }
    : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && /TypeError|render|Unhandled/.test(m.text()))
    errors.push(m.text());
});
const checks: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks.push(name);
  console.log("PASS", name);
}
const out = resolve("docs/implementation/screenshots");
mkdirSync(out, { recursive: true });
try {
  await page.goto(base);
  await check("empty real workspace and material capture", async () => {
    await expect(
      page.getByRole("heading", { name: "让第一份材料，成为有来处的记忆" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "输入材料", exact: true })
      .first()
      .click();
    await page.getByLabel("材料标题").fill("发布前的回滚验证");
    await page
      .getByLabel("材料正文")
      .fill("发布前验证回滚步骤，保留结果。\n\n回滚时同时恢复镜像和配置。");
    await page.getByLabel("来源标识").fill("release-note");
    await page.getByRole("button", { name: "保存材料与证据" }).click();
    await expect(
      page.getByRole("heading", { name: "发布前的回滚验证" }),
    ).toBeVisible();
    expect(store.list()).toHaveLength(1);
  });
  const first = store.list()[0]!.id as string;
  const revision = store.revision(first)!;
  const [a, b] = revision.fragments;
  store.link(a!.id, b!.id);
  store.link(b!.id, a!.id);
  await check("recursive evidence, cycle and return focus", async () => {
    await page.getByRole("button", { name: "查看引用" }).first().click();
    const d = page.locator("dialog");
    await expect(d).toBeVisible();
    await d.locator(".edge button").first().click();
    await expect(d).toContainText("第 2 层");
    await d.locator(".edge button").first().click();
    await expect(d.locator(".notice")).toContainText("已在第 1 层");
    await d.getByRole("button", { name: "回到该层" }).click();
    await expect(d).toContainText("第 1 层");
    await d.getByRole("button", { name: "就这段追问" }).click();
    await d.getByLabel("问题", { exact: true }).fill("这里要求做什么？");
    await d.getByRole("button", { name: "发送问题" }).click();
    await expect(d.getByText("回答已保存", { exact: true })).toBeVisible({
      timeout: 10000,
    });
    await page.screenshot({ path: join(out, "evidence.png") });
    await d.getByRole("button", { name: "关闭全部" }).click();
    await expect(d).not.toBeVisible();
  });
  await check("version update and immutable prior revision", async () => {
    store.capture({
      source: "manual",
      externalId: "release-note",
      title: "发布前的回滚验证",
      parts: [{ type: "text", text: "新版本：发布前同时验证配置和镜像。" }],
      context: {},
    });
    await page.reload();
    await page
      .locator(".source-link")
      .filter({ hasText: "发布前的回滚验证" })
      .click();
    await expect(page.locator(".reader")).toContainText("新版本");
    await page.getByText("版本历史 · 2").click();
    await page.getByRole("button", { name: "v1", exact: true }).click();
    await expect(page.locator(".reader")).toContainText(
      "发布前验证回滚步骤，保留结果。",
    );
    await expect(page.locator(".reader")).toContainText("历史版本");
  });
  await check("task creation and persistent change notifications", async () => {
    await page.getByRole("button", { name: "需求与待办", exact: true }).click();
    await page.getByLabel("事项", { exact: true }).fill("补充回滚验证记录");
    await page.getByLabel("到期时间").fill("2020-01-01T09:00");
    await page.getByRole("button", { name: "记录待办" }).click();
    await expect(
      page.getByRole("heading", { name: "补充回滚验证记录" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "标为完成" }).click();
    await expect(page.getByRole("button", { name: "重新打开" })).toBeVisible();
    await page.getByRole("button", { name: "通知中心", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "新增待办：补充回滚验证记录" }),
    ).toBeVisible();
  });
  await check("page reload and desktop rendering", async () => {
    await page.reload();
    await expect(
      page.locator(".source-link").filter({ hasText: "发布前的回滚验证" }),
    ).toBeVisible();
    await page
      .locator(".source-link")
      .filter({ hasText: "发布前的回滚验证" })
      .click();
    await page.screenshot({ path: join(out, "desktop.png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
  await check("390px mobile viewport and full-screen dialog", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: join(out, "mobile.png") });
    await page.getByRole("button", { name: "查看引用" }).first().click();
    await expect(page.locator("dialog")).toBeVisible();
    expect(
      await page
        .locator("dialog")
        .evaluate(
          (el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2,
        ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog")).not.toBeVisible();
  });
  await check(
    "100 persisted evidence nodes and bounded current rendering",
    async () => {
      const chain = store.capture({
        source: "manual",
        externalId: "long-chain",
        title: "100 层引用验收",
        parts: [
          {
            type: "text",
            text: Array.from({ length: 100 }, (_, i) => "证据 " + (i + 1)).join(
              "\n\n",
            ),
          },
        ],
        context: {},
      }).revision;
      for (let i = 0; i < 99; i++)
        store.link(chain.fragments[i]!.id, chain.fragments[i + 1]!.id);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
      await page
        .locator(".source-link")
        .filter({ hasText: "100 层引用验收" })
        .click();
      await page
        .getByRole("button", { name: /查看引用/ })
        .first()
        .click();
      const d = page.locator("dialog");
      for (let i = 0; i < 99; i++)
        await d.locator(".edge button").first().click();
      await expect(d).toContainText("第 100 层");
      await expect(d.locator("blockquote")).toHaveCount(1);
      await d.getByRole("button", { name: "关闭全部" }).click();
    },
  );
  expect(errors).toEqual([]);
  writeFileSync(
    resolve("docs/implementation/browser-verification.json"),
    JSON.stringify(
      {
        date: "2026-09-26",
        browser: browser.version(),
        checks,
        errors,
        agent: "deterministic ACP protocol fixture",
        backend: "real Fastify + SQLite",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
