// Real browser checks for the main interaction contract. No backend behavior is implied.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OMEM_CHROMIUM
    ? { executablePath: process.env.OMEM_CHROMIUM }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
const errors = [];
const external = [];
const checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (/^https?:/.test(r.url())) external.push(r.url());
});
const root = new URL("./", import.meta.url);
const url = new URL("./index.html", root).href;
const check = async (name, fn) => {
  await fn();
  checks.push(name);
  console.log("PASS", name);
};
const dialog = page.locator("dialog");
const openPolicy = async () => {
  await page.locator(".article .cite").first().click();
  await expect(dialog).toBeVisible();
};
const close = async () => {
  await page.getByRole("button", { name: "关闭全部引用" }).click();
  await expect(dialog).not.toBeVisible();
};
await mkdir(new URL("./screenshots/", root), { recursive: true });
try {
  await page.goto(url);
  await page.evaluate(() => localStorage.removeItem("omem-demo-v1"));
  await page.reload();
  await check("离线首页与桌面布局", async () => {
    await expect(page.locator("h1")).toHaveText(
      "发布前，为什么必须先验证回滚？",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: fileURLToPath(new URL("./screenshots/desktop.png", root)),
    });
  });
  await check("8 层业务示例下钻与末端", async () => {
    await openPolicy();
    for (const id of [
      "runbook",
      "incident",
      "trace",
      "commit",
      "test",
      "metric",
      "raw",
    ]) {
      await dialog
        .locator(".next-refs button")
        .filter({
          hasText: {
            runbook: "回滚操作手册",
            incident: "订单服务发布复盘",
            trace: "本次任务的验证轨迹",
            commit: "回滚配置的 Git 修订",
            test: "回滚一致性测试",
            metric: "健康指标观测",
            raw: "原始采样记录",
          }[id],
        })
        .click();
    }
    await expect(dialog.locator(".trace-label")).toContainText("第 8 层");
    await expect(dialog.locator(".trace-body")).toContainText("已到达末端");
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".trace-label")).toContainText("第 7 层");
    await close();
  });
  await check("循环引用保持路径且可跳回", async () => {
    await openPolicy();
    await dialog.locator(".next-refs button").first().click();
    await dialog.locator(".next-refs button").first().click();
    await dialog.getByRole("button", { name: /复盘关联发布规范/ }).click();
    await expect(dialog.locator(".loop-notice")).toContainText("第 1 层");
    await expect(dialog.locator(".trace-label")).toContainText("第 3 层");
    await dialog.getByRole("button", { name: /返回已打开的那一层/ }).click();
    await expect(dialog.locator(".trace-label")).toContainText("第 1 层");
    await close();
  });
  await check("固定历史引用与版本对比", async () => {
    await page.locator(".article .cite").filter({ hasText: "r6" }).click();
    await expect(dialog.locator(".state-banner")).toContainText("历史版本 r6");
    await dialog.getByRole("tab", { name: "版本", exact: true }).click();
    await expect(dialog.locator(".diff")).toContainText("r7");
    await dialog.getByRole("button", { name: "打开现行版本" }).click();
    await expect(dialog.locator("#trace-title")).toHaveText("发布管理规范");
    await expect(dialog.locator(".trace-label")).toContainText("第 2 层");
    await close();
  });
  await check("弹窗原位追问、范围和草稿保留", async () => {
    await openPolicy();
    await dialog.locator(".next-refs button").first().click();
    await dialog.locator(".next-refs button").first().click();
    await dialog.locator(".next-refs button").first().click();
    await dialog.getByRole("button", { name: "就这段追问" }).click();
    await dialog.getByLabel("回答范围").selectOption("当前引用路径");
    await dialog.getByLabel("追问当前片段").fill("为什么认为这次验证有效？");
    await dialog.getByRole("button", { name: "发送问题" }).click();
    await expect(dialog.locator(".message.assistant")).toBeVisible();
    await expect(dialog.locator(".answer-refs button")).toHaveCount(4);
    await dialog.getByLabel("追问当前片段").fill("这是一段未发送的草稿");
    await dialog.getByRole("button", { name: "收起追问" }).click();
    await dialog.getByRole("button", { name: "就这段追问" }).click();
    await expect(dialog.getByLabel("追问当前片段")).toHaveValue(
      "这是一段未发送的草稿",
    );
    await expect(dialog.getByLabel("回答范围")).toHaveValue("当前引用路径");
    await dialog.getByLabel("追问当前片段").fill("");
    await page.screenshot({
      path: fileURLToPath(new URL("./screenshots/trace-and-ai.png", root)),
    });
    await dialog.getByLabel("回答范围").selectOption("本段与直接依据");
    await dialog.getByLabel("追问当前片段").fill("查看直接引用");
    await dialog.getByRole("button", { name: "发送问题" }).click();
    await expect(dialog.locator(".message.assistant")).toHaveCount(2);
    await dialog.locator(".message.assistant").last().locator(".answer-refs button").last().click();
    await expect(dialog.locator("#trace-title")).toHaveText("回滚配置 · Git 修订");
    await expect(dialog.locator(".trace-label")).toContainText("第 5 层");
    await page.keyboard.press("Escape");
    await expect(dialog.locator(".message.assistant")).toHaveCount(2);
    await close();
  });
  await check("圈选原文并在原位追问", async () => {
    await openPolicy();
    await dialog.locator(".evidence-quote").evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await dialog.getByRole("button", { name: "追问选中内容" }).click();
    await expect(dialog.locator(".inline-chat .focus-card")).toContainText(
      "发布前必须确认",
    );
    await expect(dialog.getByLabel("追问当前片段")).toBeVisible();
    await close();
  });
  await check("Esc、焦点与正文滚动恢复", async () => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await openPolicy();
    await dialog.locator(".trace-body").evaluate((el) => (el.scrollTop = 140));
    const pos = await dialog
      .locator(".trace-body")
      .evaluate((el) => el.scrollTop);
    await dialog.locator(".next-refs button").first().click();
    await page.keyboard.press("Escape");
    expect(
      await dialog.locator(".trace-body").evaluate((el) => el.scrollTop),
    ).toBe(pos);
    await close();
    await expect(page.locator(".article .cite").first()).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check("100 层合成链不限制业务深度", async () => {
    await page.locator(".demo-tools summary").click();
    await page.getByRole("button", { name: "100 层长链" }).click();
    for (let i = 1; i < 100; i++)
      await dialog.getByRole("button", { name: /继续查看下一份材料/ }).click();
    await expect(dialog.locator(".trace-label")).toContainText("第 100 层");
    expect(await dialog.locator(".evidence-quote").count()).toBe(1);
    await dialog.locator(".trace-breadcrumb button").first().click();
    await expect(dialog.locator(".trace-label")).toContainText("第 1 层");
    await close();
  });
  await check("无权限、删除、定位失效的诚实状态", async () => {
    for (const [button, text] of [
      ["来源无权限", "当前无权查看"],
      ["来源已删除", "原始内容已删除"],
      ["定位待核对", "原文位置尚待核对"],
    ]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(dialog.locator(".evidence-empty")).toContainText(text);
      await expect(
        dialog.getByRole("button", { name: "就这段追问" }),
      ).toBeDisabled();
      await close();
    }
  });
  await check("搜索与无结果状态", async () => {
    await page.getByLabel("搜索知识、材料和经历").fill("配置");
    await expect(page.locator(".result-row").first()).toBeVisible();
    await page.getByLabel("搜索知识、材料和经历").fill("完全不存在的关键字");
    await expect(page.locator(".empty")).toContainText("没有找到相关示例");
    await page.getByRole("button", { name: "清空搜索" }).click();
  });
  await check("模拟同步有状态变化", async () => {
    await page.getByRole("button", { name: "材料来源", exact: true }).click();
    await page.getByRole("button", { name: "模拟同步" }).first().click();
    await expect(page.getByRole("button", { name: "同步中…" })).toBeVisible();
    await expect(page.locator(".source-row").first()).toContainText(
      "刚刚（模拟）",
    );
  });
  await check("恢复追加历史且刷新后保留", async () => {
    await page
      .locator(".main-nav button")
      .filter({ hasText: "变更与学习" })
      .click();
    await page.locator(".change-heading").first().click();
    await page.getByRole("button", { name: "恢复为变更前内容" }).click();
    await expect(page.locator(".change-card")).toHaveCount(3);
    await expect(page.locator(".change-card").nth(1)).toContainText("已恢复");
    await page.reload();
    await page
      .locator(".main-nav button")
      .filter({ hasText: "变更与学习" })
      .click();
    await expect(page.locator(".change-card")).toHaveCount(3);
    await page.getByRole("button", { name: "重置演示历史" }).click();
  });
  await check("阅读风格控件影响正文", async () => {
    await page.getByRole("button", { name: "知识阅读", exact: true }).click();
    await page.getByLabel("阅读风格").click();
    await page.locator(".twk-slider").fill("20");
    expect(
      await page
        .locator(".app")
        .evaluate((el) => el.style.getPropertyValue("--reading-size")),
    ).toBe("20px");
    await page.getByRole("button", { name: "Close tweaks" }).click();
  });
  await check("手机布局与全屏引用", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("h1")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: fileURLToPath(new URL("./screenshots/mobile.png", root)),
    });
    await openPolicy();
    expect(
      await dialog.evaluate(
        (el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2,
      ),
    ).toBe(true);
    await dialog.getByRole("button", { name: "就这段追问" }).click();
    await dialog.getByLabel("追问当前片段").fill("有哪些适用边界？");
    await dialog.getByRole("button", { name: "发送问题" }).click();
    await expect(dialog.locator(".message.assistant")).toBeVisible();
    await close();
  });
  await check("无脚本异常且零外部请求", async () => {
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
  await writeFile(
    new URL("./verification.json", root),
    JSON.stringify(
      {
        date: "2026-09-26",
        browser: browser.version(),
        checks,
        errors,
        externalRequests: external,
        scope: "Offline prototype only; no backend or model evaluation",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
