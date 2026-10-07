// Live repository knowledge in the personal application. Locate by readable
// article/source names; fixed IDs are discovered only through the real API.
import { chromium, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const BASE = process.env.OMEM_WEB_URL || "http://127.0.0.1:5173";
const OUT =
  process.env.OMEM_BROWSER_OUT ||
  (process.env.OMEM_REPROCESSING_ONLY === "1"
    ? ".repo-review/runtime/browser/reprocessing"
    : ".repo-review/runtime/browser");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.OMEM_CHROMIUM
    ? { executablePath: process.env.OMEM_CHROMIUM }
    : {}),
});
const checks: string[] = [],
  errors: string[] = [];
async function api(path: string) {
  const response = await fetch(BASE + path);
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return response.json();
}
async function check(name: string, run: () => Promise<void>) {
  await run();
  checks.push(name);
  console.log("PASS", name);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  if (process.env.OMEM_REPROCESSING_ONLY === "1") {
    if (!process.env.OMEM_WEB_URL)
      throw Error(
        "Reprocessing acceptance requires an explicit isolated preview URL",
      );
    const identity = crypto.randomUUID();
    const documentName = `[界面检查] 无效 Word 原件-${identity.slice(0, 8)}.docx`;
    const materialTitle = `[界面检查] 保存原件后重新处理-${identity.slice(0, 8)}`;
    const bytes = Buffer.from(
      "Synthetic invalid DOCX for original-first browser acceptance.\n",
    );
    let imported: { import: { id: string } };
    let captured: { revision: { id: string; sourceId: string } };
    const layoutIssues: string[] = [];
    const request = async (path: string, body: unknown) => {
      const response = await fetch(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw Error(`${path}: ${response.status} ${await response.text()}`);
      return response.json();
    };
    const widths = async (name: string, container = page.locator("main")) => {
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        if (await container.count())
          await container.first().scrollIntoViewIfNeeded();
        const documentLayout = await page.evaluate(() => ({
          width: innerWidth,
          content: document.documentElement.scrollWidth,
        }));
        if (documentLayout.content > documentLayout.width)
          layoutIssues.push(
            `${name} at ${width}px: page content is ${documentLayout.content}px`,
          );
        if (await container.count()) {
          const contentLayout = await container.first().evaluate((el) => ({
            width: el.clientWidth,
            content: el.scrollWidth,
          }));
          if (contentLayout.content > contentLayout.width + 1)
            layoutIssues.push(
              `${name} at ${width}px: container ${contentLayout.width}px, content ${contentLayout.content}px`,
            );
        }
        await page.screenshot({
          path: `${OUT}/${name}-${width}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    };
    try {
      const health = await api("/api/health");
      expect(health.status).toBe("ok");
      imported = await request("/api/connectors/document", {
        name: documentName,
        externalId: "browser-invalid-document-" + identity,
        data: bytes.toString("base64"),
      });
      await expect
        .poll(
          async () =>
            (await api("/api/document-imports/" + imported.import.id)).state,
          {
            timeout: 90_000,
          },
        )
        .toBe("failed");
      captured = await request("/api/captures", {
        externalId: "browser-reprocessing-material-" + identity,
        source: "manual",
        title: materialTitle,
        parts: [
          {
            type: "text",
            text: "# 原件与重新处理\n\n这是完全合成的界面检查材料。原文保留在个人库，重新处理可以选择保留旧成果。\n\n## 本次阅读目标\n\n核对入口、选项和处理记录，不调用外部模型。",
          },
        ],
      });
      await check(
        "failed document remains downloadable through the actual input page",
        async () => {
          await page.goto(BASE + "/#/capture");
          await expect(
            page.getByRole("heading", { name: "输入材料", exact: true }),
          ).toBeVisible();
          const item = page.locator(".imports article").filter({
            has: page.getByRole("heading", {
              name: documentName,
              exact: true,
            }),
          });
          await expect(item).toContainText("解析失败，原件仍保留");
          const download = page.waitForEvent("download");
          await item
            .getByRole("button", { name: "下载保存的原件", exact: true })
            .click();
          expect((await download).suggestedFilename()).toBe(documentName);
          const original = await fetch(
            BASE + "/api/document-imports/" + imported.import.id + "/original",
          );
          expect(original.status).toBe(200);
          expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
          await item.scrollIntoViewIfNeeded();
          await widths("input-failed-document", item);
          await item
            .getByRole("button", { name: "重新处理", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "重新处理材料",
            exact: true,
          });
          await expect(
            dialog.getByRole("combobox", { name: /^处理方式/ }),
          ).toHaveValue("parse");
          await expect(dialog).toContainText("使用本机保存的文件");
          await dialog
            .getByRole("checkbox", {
              name: "删除旧成果后重新生成",
              exact: true,
            })
            .uncheck();
          await expect(dialog).toContainText("生成过程中保留旧成果");
          await widths("document-reparse-dialog", dialog);
          const submitted = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/reprocessing") &&
              response.request().method() === "POST",
          );
          await dialog
            .getByRole("button", { name: "开始处理", exact: true })
            .click();
          const record = await (await submitted).json();
          expect(record).toMatchObject({
            target: "document",
            targetId: imported.import.id,
            action: "parse",
            replace: false,
          });
          await expect
            .poll(
              async () => (await api("/api/reprocessing/" + record.id)).state,
              { timeout: 90_000 },
            )
            .toBe("failed");
          expect(
            Buffer.from(
              await (
                await fetch(
                  BASE +
                    "/api/document-imports/" +
                    imported.import.id +
                    "/original",
                )
              ).arrayBuffer(),
            ),
          ).toEqual(bytes);
        },
      );
      await check(
        "saved material offers readable processing choices and explicit replacement",
        async () => {
          await page.goto(BASE + "/#/read?revision=" + captured.revision.id);
          await expect(
            page.getByRole("heading", { name: materialTitle, exact: true }),
          ).toBeVisible();
          await page
            .getByRole("region", { name: "重新处理", exact: true })
            .getByRole("button", { name: "重新处理", exact: true })
            .click();
          const dialog = page.getByRole("dialog", {
            name: "重新处理材料",
            exact: true,
          });
          const select = dialog.getByRole("combobox", { name: /^处理方式/ });
          expect(
            await select
              .locator("option")
              .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
              ),
          ).toEqual(["describe", "understand", "delete"]);
          await select.selectOption("understand");
          await expect(dialog).toContainText(
            "使用已保存材料和当前 Agent 设置重新生成",
          );
          const replace = dialog.getByRole("checkbox", {
            name: "删除旧成果后重新生成",
            exact: true,
          });
          await expect(replace).toBeChecked();
          await replace.uncheck();
          await expect(dialog).toContainText("生成过程中保留旧成果");
          await widths("material-reprocess-dialog", dialog);
          await select.selectOption("delete");
          await expect(replace).toHaveCount(0);
          await expect(dialog).toContainText("保留原件");
          const submitted = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/reprocessing") &&
              response.request().method() === "POST",
          );
          await dialog
            .getByRole("button", { name: "删除成果", exact: true })
            .click();
          const record = await (await submitted).json();
          expect(record).toMatchObject({
            target: "source",
            targetId: captured.revision.sourceId,
            action: "delete",
          });
          await expect
            .poll(
              async () => (await api("/api/reprocessing/" + record.id)).state,
            )
            .toBe("succeeded");
          await expect(
            page.getByRole("heading", { name: materialTitle, exact: true }),
          ).toBeVisible();
          await expect(page.locator(".reader")).toContainText(
            "这是完全合成的界面检查材料",
          );
        },
      );
      await check(
        "material processing history distinguishes successful clearing from failed parsing",
        async () => {
          await page.goto(BASE + "/#/learning");
          await expect(
            page.getByRole("heading", { name: "材料处理", exact: true }),
          ).toBeVisible();
          const history = page.locator(".learning-page .history");
          await expect(
            history.locator("article").filter({
              has: page.getByRole("heading", {
                name: documentName,
                exact: true,
              }),
            }),
          ).toContainText("解析原件 · 失败");
          const completed = history.locator("article").filter({
            has: page.getByRole("heading", {
              name: materialTitle,
              exact: true,
            }),
          });
          await expect(completed).toContainText("删除成果 · 已完成");
          await expect(completed).toContainText("原件保留");
          await history.scrollIntoViewIfNeeded();
          await widths("reprocessing-history", history);
        },
      );
      expect(errors).toEqual([]);
      expect(layoutIssues).toEqual([]);
      writeFileSync(
        `${OUT}/report.json`,
        JSON.stringify(
          {
            base: BASE,
            checks,
            errors,
            layoutIssues,
            fixture: {
              documentId: imported.import.id,
              sourceId: captured.revision.sourceId,
            },
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await page.screenshot({ path: `${OUT}/failure.png`, fullPage: true });
      writeFileSync(
        `${OUT}/report.json`,
        JSON.stringify(
          {
            base: BASE,
            checks,
            errors,
            layoutIssues,
            failure: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
      throw error;
    }
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_OUTLINES_ONLY === "1") {
    const catalog = await api("/api/knowledge/articles");
    const context = catalog.contexts.find(
      (c: { name: string }) => c.name === "[演示] 学会维护工单分派",
    );
    if (!context)
      throw Error("Run the synthetic knowledge:outline-verify preview first");
    const title = "[界面检查] 知识目录（临时）";
    const input = {
      title,
      reader: "首次接手项目的开发者",
      goal: "理解工单如何分派并能修改规则",
      topicPath: ["界面演示"],
      materialKeys: [],
      contextIds: [context.id],
      pages: ["看懂一张工单", "新增分派主题", "核对状态与限制"].map(
        (title, i) => ({
          id: `ui-${i}`,
          title,
          kind: "explanation",
          reader: "首次接手项目的开发者",
          goal: title,
          scenario: "billing 与未知主题的合成示例",
          questions: [title + "要看哪些材料？"],
          entryPaths: [],
          topicPath: ["界面演示"],
          materialKeys: [],
          contextIds: [context.id],
          existingKey: null,
        }),
      ),
    };
    const response = await fetch(BASE + "/api/knowledge/outlines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw Error(await response.text());
    const draft = await response.json();
    try {
      await page.goto(BASE + "/#/knowledge");
      await expect(
        page.getByRole("button", { name: "规划知识目录", exact: true }).first(),
      ).toBeVisible({ timeout: 90000 });
      await page
        .getByRole("button", { name: "规划知识目录", exact: true })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button").filter({ hasText: title }).click();
      await page
        .getByLabel("页面标题", { exact: true })
        .fill("读懂工单与处理状态");
      await page
        .getByLabel("页面目录路径", { exact: true })
        .fill("界面演示 / 入门");
      await page.getByLabel("页面下移", { exact: true }).click();
      await expect(
        page.getByLabel("草案页面目录").locator("li").first(),
      ).toContainText("新增分派主题");
      await page
        .getByRole("button", { name: "合并重复页面", exact: true })
        .click();
      await page
        .getByLabel("合并目标页面", { exact: true })
        .selectOption("ui-1");
      await page.getByRole("button", { name: "合并页面", exact: true }).click();
      await expect(page.getByLabel("草案页面目录").locator("li")).toHaveCount(
        2,
      );
      await expect(
        page.getByLabel("页面阅读目标", { exact: true }),
      ).toHaveValue(/新增分派主题.*看懂一张工单/s);
      await page
        .getByLabel("页面目录路径", { exact: true })
        .fill("界面演示 / 修改流程");
      await page.getByRole("button", { name: "上一步", exact: true }).click();
      await page
        .getByLabel("目录分类路径", { exact: true })
        .fill("界面演示 / 系统学习");
      await page.getByLabel("目录分类路径", { exact: true }).press("Tab");
      await page
        .getByRole("button", { name: "手动编排目录", exact: true })
        .click();
      await expect(
        page.getByLabel("页面目录路径", { exact: true }),
      ).toHaveValue("界面演示 / 系统学习 / 修改流程");
      await page.getByRole("button", { name: "保存草案", exact: true }).click();
      await expect(
        page.getByText("草案已保存。确认目录后才会开始写作。", { exact: true }),
      ).toBeVisible();
      const restored = await api("/api/knowledge/outlines/" + draft.id);
      expect(restored.pages.map((p: { id: string }) => p.id)).toEqual([
        "ui-1",
        "ui-2",
      ]);
      expect(restored.pages[0].topicPath).toEqual([
        "界面演示",
        "系统学习",
        "修改流程",
      ]);
      expect(restored.pages[1].topicPath).toEqual(["界面演示", "系统学习"]);
      expect(restored.state).toBe("editing");
      checks.push(
        "rename, move, reorder, merge and persist an unconfirmed outline through the actual UI",
      );
      await page.reload();
      await page
        .getByRole("button", { name: "规划知识目录", exact: true })
        .first()
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button")
        .filter({ hasText: title })
        .click();
      await expect(
        page.getByLabel("页面目录路径", { exact: true }),
      ).toHaveValue("界面演示 / 系统学习 / 修改流程");
      checks.push(
        "restore saved directory after a full page reload without applying it",
      );
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true);
        await page.getByLabel("页面计划编辑器").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `${OUT}/outline-editor-${width}.png`,
          fullPage: true,
        });
      }
      checks.push(
        "readable outline editor at 1440/768/390 without horizontal overflow",
      );
      expect(errors).toEqual([]);
      writeFileSync(
        `${OUT}/report.json`,
        JSON.stringify({ base: BASE, checks, errors }, null, 2),
      );
    } finally {
      const saved = await api("/api/knowledge/outlines/" + draft.id);
      const deleted = await fetch(
        BASE +
          "/api/knowledge/outlines/" +
          draft.id +
          "?version=" +
          saved.version,
        { method: "DELETE" },
      );
      if (!deleted.ok)
        throw Error("Could not remove this test's temporary outline");
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "关闭全部", exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page
      .getByRole("button", { name: "规划知识目录", exact: true })
      .first()
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button")
      .filter({ hasText: "[演示] 可继续编辑的工单知识目录" })
      .click();
    await expect(page.getByLabel("页面计划编辑器")).toBeVisible();
    await page.screenshot({
      path: `${OUT}/outline-preview.png`,
      fullPage: true,
    });
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_SCHEDULES_ONLY === "1") {
    await page.goto(BASE + "/#/schedules");
    await expect(
      page.getByRole("heading", { name: "定时任务", exact: true }),
    ).toBeVisible({ timeout: 90000 });
    await expect(
      page.getByRole("heading", { name: "事项提醒检查", exact: true }),
    ).toBeVisible();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${OUT}/schedules-${width}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .locator(".task-card")
      .filter({
        has: page.getByRole("heading", { name: "每日简报", exact: true }),
      })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await expect(page.getByLabel("简报要求", { exact: true })).toBeVisible();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${OUT}/schedules-settings-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    writeFileSync(
      `${OUT}/report.json`,
      JSON.stringify(
        {
          base: BASE,
          checks: ["scheduler and settings at 1440/768/390"],
          errors,
        },
        null,
        2,
      ),
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_UI_ONLY === "1") {
    await check(
      "shared form controls at desktop, tablet and mobile widths",
      async () => {
        await page.goto(BASE + "/#/design");
        await expect(page.getByLabel("回答范围", { exact: true })).toBeVisible({
          timeout: 90000,
        });
        await page
          .getByLabel("回答范围", { exact: true })
          .selectOption("library");
        await page
          .getByRole("checkbox", { name: "随材料自动更新", exact: true })
          .uncheck();
        await page
          .getByRole("checkbox", { name: "聊天记录", exact: true })
          .check();
        await expect(
          page.locator(".form-showcase [role='status']"),
        ).toContainText("已选 2 类材料");
        await page
          .getByRole("radio", { name: "自动维护", exact: true })
          .check();
        await expect(
          page.getByRole("radio", { name: "手动整理", exact: true }),
        ).not.toBeChecked();
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator(".form-showcase").scrollIntoViewIfNeeded();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({ path: `${OUT}/forms-${width}.png` });
        }
      },
    );
    await check("daily composer is before project follow-up", async () => {
      await page.goto(BASE + "/#/daily");
      await expect(page.getByLabel("发给日常助理")).toBeVisible();
      expect(
        await page.evaluate(() => {
          const composer = document.querySelector(".daily-composer")!,
            work = document.querySelector(".work-panel")!;
          return !!(
            composer.compareDocumentPosition(work) &
            Node.DOCUMENT_POSITION_FOLLOWING
          );
        }),
      ).toBe(true);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator(".daily-composer").scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({ path: `${OUT}/daily-layout-${width}.png` });
      }
    });
    await check(
      "message collection status and conversation tools stay visible",
      async () => {
        await page.goto(BASE + "/#/messages");
        await expect(
          page.getByRole("checkbox", { name: "开启定时采集", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "读取最近活跃会话", exact: true }),
        ).toBeVisible();
        await expect(page.locator(".collection-status")).toContainText(
          /定时采集已开启|定时采集已暂停/,
          { timeout: 90000 },
        );
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator(".collection-settings").scrollIntoViewIfNeeded();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: `${OUT}/messages-layout-${width}.png`,
          });
        }
      },
    );
    await check(
      "Agent settings remain readable at all three widths",
      async () => {
        await page.goto(BASE + "/#/settings");
        await expect(
          page.getByLabel("主助手 Agent", { exact: true }),
        ).toBeVisible({ timeout: 90000 });
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator(".agent-role-list").scrollIntoViewIfNeeded();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({ path: `${OUT}/agents-layout-${width}.png` });
        }
      },
    );
    await check(
      "real knowledge summaries and material composer remain readable",
      async () => {
        await page.goto(BASE + "/#/knowledge");
        await expect(
          page.locator(".library-overview .article-list button").first(),
        ).toBeVisible({ timeout: 90000 });
        const summary = page.locator(".article-summary").first();
        await expect(summary).toBeVisible();
        expect(
          await summary.evaluate((el) => getComputedStyle(el).webkitLineClamp),
        ).toBe("2");
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator(".library-overview").scrollIntoViewIfNeeded();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({ path: `${OUT}/library-layout-${width}.png` });
          const trigger = page.getByRole("button", {
            name: "整理文章",
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: "整理成文章",
            exact: true,
          });
          await dialog.getByLabel("筛选整理材料").fill("README.md");
          await expect(
            dialog.getByText("正在读取项目与主题…", { exact: true }),
          ).not.toBeVisible({ timeout: 90000 });
          await dialog
            .locator(".material-option")
            .first()
            .getByRole("checkbox")
            .check();
          await expect(
            dialog.getByRole("button", { name: "下一步", exact: true }),
          ).toBeInViewport();
          await page.screenshot({
            path: `${OUT}/selection-layout-${width}.png`,
          });
          await dialog
            .getByRole("button", { name: "下一步", exact: true })
            .click();
          await expect(
            dialog.getByLabel("文章主题", { exact: true }),
          ).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
        }
      },
    );
    expect(errors).toEqual([]);
    writeFileSync(
      `${OUT}/ui-layout-report.json`,
      JSON.stringify({ base: BASE, checks, errors }, null, 2),
    );
    console.log(
      "PASS current personal-library UI; no settings or articles were submitted",
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_AGENT_SETUP_ONLY === "1") {
    await page.goto(BASE + "/#/settings");
    const model = page.getByLabel("主助手模型", { exact: true });
    await expect(model).toBeEnabled({ timeout: 60000 });
    expect(await model.locator("option").count()).toBeGreaterThan(2);
    await expect(
      page.getByText(/ACP 已连接 · 模型实际调用尚未检查/).first(),
    ).toBeVisible();
    const choices = await model.locator("option").evaluateAll((options) =>
      options.map((o) => ({
        value: (o as HTMLOptionElement).value,
        label: o.textContent ?? "",
      })),
    );
    const current = await model.inputValue();
    const other = choices.find((o) => o.value && o.value !== current);
    if (other) {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/agents/probe") && r.request().method() === "POST",
        { timeout: 60000 },
      );
      await model.selectOption(other.value);
      expect((await response).ok()).toBe(true);
      await expect(model).toBeEnabled({ timeout: 60000 });
      await model.selectOption(current);
      await expect(model).toBeEnabled({ timeout: 60000 });
    }
    await expect(
      page.getByText("当前已连接本地服务，未启用访问令牌，无需填写。"),
    ).toBeVisible();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${OUT}/agent-settings-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS live Agent setup with real model-dependent effort negotiation at three widths; configuration unchanged",
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_LARK_SETUP_ONLY === "1") {
    await page.goto(BASE + "/#/lark");
    await expect(
      page.getByRole("heading", { name: "飞书机器人", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/在服务机器运行 omem bot setup/)).toBeVisible();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: `${OUT}/lark-setup-${width}.png` });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "日常助理", exact: true }).click();
    await expect(page.getByText(/在服务机器运行 omem bot setup/)).toHaveCount(
      0,
    );
    expect(errors).toEqual([]);
    console.log(
      "PASS live dev onboarding guidance at three widths and page-scoped error",
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_FOLLOWUP_ONLY === "1") {
    const catalog = await api("/api/work");
    expect(
      catalog.requirements.some((r: any) => r.title.includes("[演示]")),
    ).toBe(true);
    await page.goto(BASE + "/#/daily");
    const panel = page.locator(".work-panel");
    await expect(panel.locator(".follow-card").first()).toBeVisible();
    await expect(panel).toContainText("小林");
    await panel.getByRole("button", { name: /需要你决定/ }).click();
    await expect(panel.locator(".action-list")).toHaveCount(0);
    await panel.getByRole("button", { name: /^全部/ }).click();
    const activePersonal = catalog.requirements.flatMap(
      (r: any) => r.personalTasks ?? [],
    );
    if (activePersonal.length) {
      await panel.getByRole("button", { name: /^个人待办/ }).click();
      await expect(panel.locator(".action-list")).toContainText("检查时间");
    } else {
      await expect(
        panel.getByRole("button", { name: /^个人待办/ }),
      ).toContainText("0");
    }
    await panel.getByRole("button", { name: /^全部/ }).click();
    const trigger = panel
      .getByRole("button", { name: "调整关注点", exact: true })
      .first();
    await trigger.click();
    await expect(page.getByLabel("重点关注（每行一项）")).not.toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(panel.locator(".change-plan")).toContainText(/紧急|urgent/);
    await panel
      .getByRole("button", { name: "查看代码差异", exact: true })
      .first()
      .click();
    await expect(panel.locator(".code-diff")).toContainText("urgent");
    await panel
      .getByRole("button", { name: "收起代码差异", exact: true })
      .first()
      .click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel
        .locator(".work-heading")
        .first()
        .evaluate((el) => {
          el.scrollIntoView({ block: "start" });
          let p: HTMLElement | null = el.parentElement;
          while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
          if (p) p.scrollTop -= 88;
          else window.scrollBy(0, -88);
        });
      await page.screenshot({ path: `${OUT}/followup-${width}.png` });
      await panel.locator(".change-plan").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/coding-${width}.png` });
    }
    await page.goto(BASE + "/#/messages");
    await expect(page.locator(".message").first()).toContainText("演示消息");
    const corrected = page
      .locator(".message")
      .filter({ hasText: "建议下一步加紧急优先" });
    await expect(corrected).toContainText("紧急优先已经由我确认");
    await corrected
      .getByRole("button", { name: "纠正理解", exact: true })
      .click();
    await page
      .getByRole("button", { name: "这是提议，尚未决定", exact: true })
      .click();
    await expect(page.getByLabel("正确理解应该是什么？")).toHaveValue(
      "这只是提议，还没有决定。",
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await corrected.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/understanding-${width}.png` });
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS real Sol message understanding, project follow-up, correction dialog, saved coding plan/diff and three viewports",
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_MESSAGES_ONLY === "1") {
    await page.goto(BASE + "/#/messages");
    await expect(
      page.getByRole("heading", { name: "飞书消息", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "开启定时采集" }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "读取最近活跃会话" }).click();
    await expect(page.locator(".stream").first()).toBeVisible({
      timeout: 90000,
    });
    const first = page.locator(".stream").first();
    await first.getByRole("combobox").selectOption("watch");
    await expect(first.getByRole("combobox")).toHaveValue("watch");
    await first.getByRole("combobox").selectOption("off");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已暂停");
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${OUT}/messages-${width}.png`,
        fullPage: false,
      });
    }
    expect(errors).toEqual([]);
    console.log(
      "PASS real personal-message discovery, subscriptions, paused settings and three viewports",
    );
    await browser.close();
    process.exit(0);
  }
  if (process.env.OMEM_DOCUMENT_TITLE) {
    await check(
      "imported document retains headings, table, image and original download",
      async () => {
        await page
          .getByRole("button", { name: "原始材料", exact: true })
          .click();
        await page
          .getByLabel("查找原始材料")
          .fill(process.env.OMEM_DOCUMENT_TITLE!);
        await page
          .locator(".source-link")
          .filter({ hasText: process.env.OMEM_DOCUMENT_TITLE! })
          .click();
        await expect(
          page.locator(".document-reading .md-body h2").first(),
        ).toBeVisible();
        await expect(page.locator(".document-reading table")).toBeVisible();
        await expect(page.locator(".document-reading img")).toBeVisible();
        const download = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "下载原件", exact: true })
          .click();
        expect((await download).suggestedFilename()).toBe(
          process.env.OMEM_DOCUMENT_TITLE,
        );
        for (const width of [1440, 768, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: `${OUT}/document-${width}.png`,
            fullPage: true,
          });
          await page.locator(".document-reading img").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${OUT}/document-content-${width}.png`,
            fullPage: true,
          });
        }
      },
    );
    if (process.env.OMEM_DOCUMENT_ONLY === "1") {
      expect(errors).toEqual([]);
      await browser.close();
      process.exit(0);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await check("unified app has real repository chapters", async () => {
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "知识目录" }),
    ).toBeVisible();
    const initialCatalog = await api("/api/knowledge/articles");
    const firstPage =
      initialCatalog.articles.find(
        (a: any) => a.reading && a.role === "article",
      ) ?? initialCatalog.articles[0];
    expect(firstPage).toBeTruthy();
    await page.getByLabel("查找章节", { exact: true }).fill(firstPage.title);
    await page
      .locator(".tree-title")
      .filter({ hasText: firstPage.title })
      .first()
      .click();
    await expect(page.locator(".book-content .article-body > h2")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator(".navigation")).not.toContainText("设计系统");
    expect(
      await page
        .locator(".navigation button")
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).not.toBe("0px");
    const catalog = await api("/api/knowledge/articles");
    expect(catalog.materials.some((m: any) => m.path === "README.md")).toBe(
      true,
    );
    expect(catalog.articles.length).toBeGreaterThan(0);
    await expect(
      page.getByRole("navigation", { name: "本篇目录" }),
    ).toBeVisible();
  });
  await check(
    "menu and breadcrumbs agree; Lark errors stay on its page",
    async () => {
      for (const name of [
        "飞书机器人",
        "日常助理",
        "能力与连接",
        "知识库",
        "日常助理",
        "知识库",
      ]) {
        await page
          .locator(".navigation")
          .getByRole("button", { name, exact: true })
          .click();
        await expect(page.locator(".page-bar")).toContainText(name);
        await expect(page.locator(".navigation .active")).toHaveText(name);
        if (name !== "飞书机器人")
          await expect(page.locator(".lark-page-error")).toHaveCount(0);
        await expect(page.locator(".error-banner")).toHaveCount(0);
      }
    },
  );
  await check(
    "citations open the fixed code range and expand context",
    async () => {
      const catalog = await api("/api/knowledge/articles");
      let article: any, c: any;
      for (const meta of catalog.articles) {
        const candidate = await api(
          "/api/knowledge/articles/" + encodeURIComponent(meta.key),
        );
        const citation = candidate.citations
          .filter(
            (c: any) =>
              c.actionable &&
              c.resolved?.kind === "material" &&
              /\.[cm]?[jt]sx?$/.test(c.resolved.key) &&
              c.resolved.startLine > 20,
          )
          .sort(
            (a: any, b: any) => a.resolved.startLine - b.resolved.startLine,
          )[0];
        if (citation) {
          const source = await api(
            "/api/knowledge/materials/" +
              encodeURIComponent(citation.resolved.key) +
              "?digest=" +
              citation.resolved.digest,
          );
          if (source.links?.length) {
            article = candidate;
            c = citation;
            break;
          }
        }
      }
      expect(article).toBeTruthy();
      expect(c).toBeTruthy();
      await page.getByLabel("查找章节", { exact: true }).fill(article.title);
      await page
        .locator(".tree-title")
        .filter({ hasText: article.title })
        .first()
        .click();
      const groups = await page
        .locator(
          ".book-content .md-body p, .book-content .md-body li, .book-content .md-body td",
        )
        .evaluateAll((nodes) =>
          nodes.map((n) =>
            [...n.querySelectorAll(".om-inline-citation[href]")].map((a) =>
              decodeURIComponent(a.getAttribute("href")!.split("/").pop()!),
            ),
          ),
        );
      for (const keys of groups) {
        const targets = keys.map((key) =>
          JSON.stringify(
            article.citations.find((c: any) => c.key === key).target,
          ),
        );
        expect(new Set(targets).size).toBe(targets.length);
      }
      const trigger = page
        .locator(".book-content")
        .getByRole("link", { name: c.label })
        .first();
      await trigger.click();
      const drawer = page.locator("dialog[open]");
      await expect(drawer.locator(".code-table tr")).toHaveCount(
        c.resolved.endLine - c.resolved.startLine + 1,
        { timeout: 30000 },
      );
      await expect(drawer.locator(".code-table tr").first()).toHaveAttribute(
        "data-line",
        String(c.resolved.startLine),
      );
      await drawer.getByRole("button", { name: "向上展开 20 行" }).click();
      await expect(drawer.locator(".code-table tr").first()).toHaveAttribute(
        "data-line",
        String(Math.max(1, c.resolved.startLine - 20)),
      );
      await drawer.getByRole("button", { name: "向下展开 20 行" }).click();
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await expect(drawer.locator(".code-table tr")).toHaveCount(
        c.resolved.endLine - c.resolved.startLine + 1,
        { timeout: 30000 },
      );
      // Drill into a source import instead of requiring an obsolete per-file Wiki.
      while (
        await drawer
          .getByRole("button", { name: "向上展开 20 行", exact: true })
          .count()
      )
        await drawer
          .getByRole("button", { name: "向上展开 20 行", exact: true })
          .click();
      const importLink = drawer.locator(".line-reference").first();
      await expect(importLink).toBeVisible();
      const scroller = drawer.locator(".trail-scroll");
      await importLink.scrollIntoViewIfNeeded();
      const saved = await scroller.evaluate((el) => el.scrollTop);
      await importLink.click();
      await expect(drawer.locator(".layer-chip")).toContainText("第 2 层");
      await expect(drawer.locator(".code-table tr").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(drawer.locator(".layer-chip")).toContainText("第 1 层");
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeCloseTo(saved, -1);
      await drawer.locator(".line-reference").first().click();
      expect(page.url()).toContain("/trail/");
      await page.reload();
      await expect(page.locator("dialog[open] .layer-chip")).toContainText(
        "第 2 层",
      );
      await expect(
        page.locator("dialog[open] .knowledge-source h2"),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open] .layer-chip")).toContainText(
        "第 1 层",
      );
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(
        page.locator(".book-content .om-inline-citation[href]").first(),
      ).toBeVisible();
    },
  );
  await check(
    "README reads as a document with intact code fences",
    async () => {
      await page.getByRole("button", { name: "原始材料", exact: true }).click();
      await expect(page.locator(".om-nav .source-link")).toHaveCount(0);
      await page.getByLabel("查找原始材料").fill("README.md");
      await page
        .locator(".source-link")
        .filter({ has: page.locator("span", { hasText: /^README\.md$/ }) })
        .click();
      await expect(page.locator(".reader .md-body h1")).toHaveText("omem");
      await expect(
        page.locator(".reader .md-body pre code").first(),
      ).toBeVisible();
      await expect(page.locator(".reader")).not.toContainText("片段 1");
      await page.getByRole("button", { name: "知识库", exact: true }).click();
      await page.getByLabel("查找章节", { exact: true }).fill("");
    },
  );
  await check(
    "material changes show real differences and notifications omit empty internals",
    async () => {
      await page.getByRole("button", { name: "变更历史", exact: true }).click();
      await page.getByLabel("查看范围").selectOption("capture");
      await page.getByText("查看内容差异", { exact: true }).first().click();
      await expect(
        page.locator(".change-comparison .diff-hunk").first(),
      ).toBeVisible();
      expect(
        await page
          .locator(".change-comparison .added,.change-comparison .removed")
          .count(),
      ).toBeGreaterThan(0);
      await page.screenshot({
        path: `${OUT}/changes-1440.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "材料处理", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "材料处理", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".learning-page")).not.toContainText(
        "学习任务",
      );
      await page.getByRole("button", { name: "知识库", exact: true }).click();
    },
  );
  await check(
    "Agent capabilities load automatically and local access needs no token",
    async () => {
      const response = page.waitForResponse(
        (r) => /\/profiles\/[^/]+\/probe$/.test(r.url()),
        { timeout: 60000 },
      );
      await page
        .getByRole("button", { name: "能力与连接", exact: true })
        .click();
      await expect(
        page.getByText("正在连接 Agent，读取支持的模型与思考强度…"),
      ).toBeVisible();
      expect((await response).ok()).toBe(true);
      await expect(
        page.getByText("已读取此 Agent 支持的模型与思考强度"),
      ).toBeVisible();
      await expect(
        page.getByText("当前已连接本地服务，未启用访问令牌，无需填写。"),
      ).toBeVisible();
      await page.screenshot({
        path: `${OUT}/settings-1440.png`,
        fullPage: true,
      });
      await page.getByRole("button", { name: "知识库", exact: true }).click();
    },
  );
  await check(
    "category browsing and composer at desktop, tablet and mobile widths",
    async () => {
      const catalog = await api("/api/knowledge/articles");
      const previousKey = await page.evaluate(() =>
        sessionStorage.getItem("omem-knowledge-page"),
      );
      const previous = catalog.articles.find((a: any) => a.key === previousKey);
      await page.getByLabel("查找章节", { exact: true }).fill("");
      await page.getByRole("button", { name: "返回分类", exact: true }).click();
      const classified = catalog.articles.find((a: any) => a.topicPath?.length);
      if (classified)
        for (const part of classified.topicPath) {
          await page
            .locator(
              ".topic-folder > .om-disclosure > .disclosure-heading > .disclosure-title",
            )
            .filter({ hasText: part })
            .first()
            .click();
        }
      await expect(
        page.locator(".library-overview .article-list button").first(),
      ).toBeVisible();
      await expect(page.locator(".library-overview form")).toHaveCount(0);
      await expect(page.getByText("浏览此分类", { exact: true })).toHaveCount(
        0,
      );
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const trigger = page.getByRole("button", {
          name: "整理文章",
          exact: true,
        });
        await page.screenshot({ path: `${OUT}/library-${width}.png` });
        await trigger.click();
        const dialog = page.getByRole("dialog", {
          name: "整理成文章",
          exact: true,
        });
        await dialog.getByLabel("筛选整理材料").fill("README.md");
        await expect(dialog.locator(".material-option").first()).toBeVisible();
        await dialog
          .locator(".material-option")
          .first()
          .getByRole("checkbox")
          .check();
        await expect(
          dialog.getByRole("button", { name: "下一步", exact: true }),
        ).toBeInViewport();
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `${OUT}/composer-materials-${width}.png`,
        });
        await dialog
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await expect(
          dialog.getByLabel("文章主题", { exact: true }),
        ).toBeFocused();
        await expect(
          dialog.getByRole("button", { name: "开始整理", exact: true }),
        ).toBeInViewport();
        await page.screenshot({ path: `${OUT}/composer-purpose-${width}.png` });
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (previous) {
        await page.getByRole("button", { name: /^全部文章/ }).click();
        await page.getByLabel("查找章节", { exact: true }).fill(previous.title);
        await page
          .locator(".tree-title")
          .filter({ hasText: previous.title })
          .first()
          .click();
        await expect(
          page.locator(".book-content .article-body > h2"),
        ).toBeVisible({ timeout: 30000 });
      }
    },
  );
  await check(
    "existing article editing keeps selected materials and the reader's draft",
    async () => {
      const trigger = page.getByRole("button", {
        name: "调整材料与目标",
        exact: true,
      });
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await trigger.click();
        const dialog = page.getByRole("dialog", {
          name: "调整材料与目标",
          exact: true,
        });
        expect(
          await dialog.locator(".material-option input:checked").count(),
        ).toBeGreaterThan(0);
        await dialog
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        expect(
          await dialog.getByLabel("文章主题", { exact: true }).inputValue(),
        ).not.toBe("");
        await dialog
          .getByLabel("想弄懂什么", { exact: true })
          .fill("我想了解这篇文章的材料，以及补充背景后怎样更新解释。");
        await expect(
          dialog.getByRole("button", { name: "保存并重新整理", exact: true }),
        ).toBeInViewport();
        expect(
          await dialog.evaluate((el) => el.scrollWidth <= innerWidth),
        ).toBe(true);
        await page.screenshot({ path: `${OUT}/article-edit-${width}.png` });
        await page.keyboard.press("Escape");
        await expect(trigger).toBeFocused();
        await trigger.click();
        await dialog
          .getByRole("button", { name: "下一步", exact: true })
          .click();
        await expect(
          dialog.getByLabel("想弄懂什么", { exact: true }),
        ).toHaveValue("我想了解这篇文章的材料，以及补充背景后怎样更新解释。");
        await page.keyboard.press("Escape");
      }
    },
  );
  for (const width of [1440, 768, 390])
    await check(`readable layout at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.locator(".book-content .article-body > h2"),
      ).toBeVisible();
      await expect(
        page.locator(".book-content .md-body p").first(),
      ).toBeVisible();
      await page.screenshot({
        path: `${OUT}/knowledge-${width}.png`,
        fullPage: true,
      });
      const maintenance = page.getByRole("region", { name: "文章更新方式" });
      await maintenance.scrollIntoViewIfNeeded();
      await expect(
        maintenance.getByRole("checkbox", { name: "随所选材料自动更新" }),
      ).toBeVisible();
      expect(
        await maintenance
          .locator("label")
          .evaluate((el) => getComputedStyle(el).flexDirection),
      ).toBe("row");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({ path: `${OUT}/maintenance-${width}.png` });
    });
  await check(
    "project and topic input is readable in the actual development app",
    async () => {
      await page.goto(BASE + "#/capture");
      const picker = page.getByRole("group", {
        name: "项目或主题（可选）",
        exact: true,
      });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole("status")).toHaveCount(0);
      await expect(picker.getByRole("alert")).toHaveCount(0);
      await picker
        .getByRole("button", { name: "新建项目或主题", exact: true })
        .click();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await picker.scrollIntoViewIfNeeded();
        await expect(picker.getByLabel("名称", { exact: true })).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({ path: `${OUT}/context-input-${width}.png` });
      }
      // Read-only inspection: do not leave synthetic contexts in the personal library.
    },
  );
  expect(errors).toEqual([]);
  writeFileSync(
    `${OUT}/report.json`,
    JSON.stringify({ base: BASE, checks, errors }, null, 2),
  );
} finally {
  await browser.close();
}
