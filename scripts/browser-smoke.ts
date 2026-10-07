// Real Vue + API + SQLite test. Fixture Agent is used only to make UI assertions deterministic.
import { chromium, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { Store } from "../apps/server/src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../apps/server/src/knowledge/repository.js";
import { requirementBrief } from "../apps/server/src/knowledge/requirements.js";
import { LarkOnboardingService } from "../apps/server/src/integrations/lark/onboarding.js";
import { EncryptedSecretStore } from "../apps/server/src/integrations/lark/secret-store.js";
import type {
  LarkCapabilityProbe,
  LarkRegistrationAdapter,
  LarkRegistrationRequest,
} from "../apps/server/src/integrations/lark/registration.js";
import type { ExistingLarkAppProvider } from "../apps/server/src/integrations/lark/existing-apps.js";
import { profileSchema } from "../packages/contracts/src/index.js";
const dir = mkdtempSync(join(tmpdir(), "omem-browser-"));
class BrowserRegistration implements LarkRegistrationAdapter {
  register(request: LarkRegistrationRequest) {
    const url = new URL("https://accounts.feishu.cn/open-apis/authen/v1/index");
    if (request.appId) url.searchParams.set("clientID", request.appId);
    if (request.createOnly) url.searchParams.set("createOnly", "true");
    url.searchParams.set("device_code", "browser-fixture");
    request.onQrCode({ url: url.toString(), expiresInSeconds: 600 });
    return new Promise<never>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => {
        const error = new Error("aborted") as Error & { code: string };
        error.code = "ABORT_ERR";
        reject(error);
      }),
    );
  }
}
const ownerProvenance = {
  collectorId: "browser-fixture",
  actorId: "owner",
  actorType: "owner" as const,
  actorVerifiedBy: "authenticated-test",
  sourceUri: null,
  eventId: null,
  eventAt: "2026-09-29T00:00:00Z",
  timezone: "Asia/Shanghai",
  quoted: false,
  forwarded: false,
  producerKind: "original" as const,
};
const larkAppId = "cli_browserfixture";
const existingApps: ExistingLarkAppProvider = {
  list: () => [
    {
      appId: larkAppId,
      name: "Browser botmux fixture",
      tenantBrand: "feishu",
      source: "botmux",
    },
  ],
  credentials: (appId) => {
    if (appId !== larkAppId) throw Error("BOTMUX_APP_NOT_FOUND");
    return {
      clientId: appId,
      clientSecret: "browser-fixture-secret-never-exposed",
      userInfo: { tenantBrand: "feishu" },
    };
  },
};
const capabilityProbe: LarkCapabilityProbe = {
  probe: async () => ({
    actual: {
      scopes: ["im:message:send_as_bot"],
      events: ["im.message.receive_v1"],
      callbacks: ["card.action.trigger"],
      botOpenId: "ou_browser_bot",
    },
    missing: [],
  }),
};
const larkStore = new Store(dir);
const lark = new LarkOnboardingService(
  larkStore.db,
  new EncryptedSecretStore(join(dir, "browser-secrets"), randomBytes(32)),
  new BrowserRegistration(),
  capabilityProbe,
  () => new Date(),
  existingApps,
);
const appConfig = {
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
};
let built = await buildApp(appConfig, { lark });
let app = built.app;
let store = built.store;
let base = await app.listen({ port: 0, host: "127.0.0.1" });
async function botCli(...args: string[]) {
  const result = await promisify(execFile)(process.execPath, [
    resolve("apps/server/src/cli.ts"),
    "--url",
    base,
    "--json",
    "bot",
    ...args,
  ]);
  return JSON.parse(result.stdout);
}
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
async function evaluateTask(input: {
  revision: ReturnType<Store["revision"]> extends infer T
    ? NonNullable<T>
    : never;
  proposalId: string;
  title: string;
  jobId: string;
  uncertainties?: string[];
  targetId?: string;
  kind?: "task" | "claim";
}) {
  const fragment = input.revision.fragments[0]!;
  const text = fragment.text;
  const response = await app.inject({
    method: "POST",
    url: "/api/proposals/evaluate",
    payload: {
      proposal: {
        schema_version: 1,
        proposal_id: input.proposalId,
        kind: input.kind ?? "task",
        operation: input.targetId ? "supersede" : "create",
        ...(input.targetId ? { target_id: input.targetId } : {}),
        scope: {
          workspace_id: "personal",
          project_id: "browser-acceptance",
          subject_id: "owner",
        },
        body:
          input.kind === "claim"
            ? {
                statement: input.title,
                attribution: "authenticated owner evidence",
                valid_from: null,
                valid_to: null,
              }
            : {
                title: input.title,
                owner_id: "owner",
                due_at: null,
                due_expression: null,
                next_step: "核对原始材料",
              },
        evidence: [
          {
            fragment_revision_id: fragment.id,
            source_revision_id: input.revision.id,
            exact_quote: text,
            selector: {
              start: 0,
              end: Array.from(text).length,
              unit: "unicode_codepoint",
            },
          },
        ],
        uncertainties: input.uncertainties || [],
        reason: `从固定原文形成：${input.title}`,
        expected_versions: input.targetId ? { [input.targetId]: 1 } : {},
        origin: {
          job_id: input.jobId,
          role_bundle: "extractor@1",
          producer_kind: "derived",
        },
      },
      assessment: {
        semantic_verdict: "supported",
        reviewer_version: "browser-reviewer@1",
        role_version: "verifier@1",
        reason_code: "browser_fixed_evidence",
        details:
          "Deterministic assessment input for browser product-flow assertions.",
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    policy: string;
    proposalDigest: string;
    decisionId?: string;
    receipt?: { entityId: string };
  };
}
const out = resolve(".repo-review/runtime/browser/screenshots");
mkdirSync(out, { recursive: true });
try {
  await page.goto(base);
  await check(
    "first-use Agent setup negotiates each model, persists roles and applies without restart",
    async () => {
      await page
        .getByRole("button", { name: "设置 Agent 与模型", exact: true })
        .click();
      await expect(
        page.getByLabel("主助手模型", { exact: true }),
      ).toBeEnabled();
      await page.getByLabel("主助手模型", { exact: true }).selectOption("beta");
      await expect(
        page
          .getByLabel("主助手思考强度", { exact: true })
          .locator('option[value="high"]'),
      ).toHaveCount(1);
      await page
        .getByLabel("主助手思考强度", { exact: true })
        .selectOption("high");
      await page
        .getByRole("button", { name: "检查所选模型调用", exact: true })
        .click();
      await expect(
        page.getByText("ACP 已连接 · 所选模型实际调用通过", { exact: true }),
      ).toBeVisible();
      await page.getByLabel("为不同工作分别设置 Agent、模型与思考强度").check();
      await page.getByLabel("编码模型", { exact: true }).selectOption("alpha");
      await expect(
        page
          .getByLabel("编码思考强度", { exact: true })
          .locator('option[value="high"]'),
      ).toHaveCount(0);
      await expect(
        page.getByLabel("编码思考强度", { exact: true }),
      ).toHaveValue("low");
      await page
        .getByRole("button", { name: "保存并用于新任务", exact: true })
        .click();
      await expect(
        page.getByText(/已保存 Agent 设置，新任务开始使用/),
      ).toBeVisible();
      const settings = await (
        await fetch(base + "/api/agents/settings")
      ).json();
      expect(settings.roles.assistant.model).toBe("beta");
      expect(settings.roles.assistant.effort).toBe("high");
      expect(settings.roles.coding.model).toBe("alpha");
      expect(settings.roles.coding.effort).toBe("low");
      expect(settings.learningEnabled).toBe(false);
      expect(
        appConfig.profiles.find((p) => p.id === "omem-assistant")?.model,
      ).toBe("beta");
      await page.reload();
      await expect(page.getByLabel("主助手模型", { exact: true })).toHaveValue(
        "beta",
      );
      await expect(page.getByLabel("编码模型", { exact: true })).toHaveValue(
        "alpha",
      );
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(out, `agent-settings-${width}.png`),
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "日常助理", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "设置 Agent 与模型", exact: true }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "知识库", exact: true }).click();
    },
  );
  await check("empty real workspace and material capture", async () => {
    await expect(
      page.getByRole("heading", { name: "知识从你的材料开始" }),
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
  await check(
    "reading-first library and two-step article composer",
    async () => {
      await page.getByRole("button", { name: "知识库", exact: true }).click();
      const trigger = page.getByRole("button", {
        name: "整理文章",
        exact: true,
      });
      await expect(page.locator(".library-overview form")).toHaveCount(0);
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: "整理成文章",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "下一步", exact: true }),
      ).toBeDisabled();
      await dialog.getByLabel("筛选整理材料").fill("发布前的回滚验证");
      const row = dialog
        .locator(".material-option")
        .filter({ hasText: "发布前的回滚验证" });
      await expect(row).toHaveCount(1);
      await row.click();
      await expect(row.getByRole("checkbox")).toBeChecked();
      const layout = await row.evaluate((el) => {
        const box = el.querySelector("input")!.getBoundingClientRect(),
          title = el.querySelector("strong")!.getBoundingClientRect();
        return {
          direction: getComputedStyle(el).flexDirection,
          aligned:
            Math.abs(
              box.top + box.height / 2 - (title.top + title.height / 2),
            ) < 4,
        };
      });
      expect(layout).toEqual({ direction: "row", aligned: true });
      await dialog.getByRole("button", { name: "下一步", exact: true }).click();
      await dialog
        .getByLabel("文章主题", { exact: true })
        .fill("发布前如何验证回滚");
      await dialog
        .getByLabel("想弄懂什么", { exact: true })
        .fill("解释镜像和配置如何一起回滚，方便我发布前检查。");
      await dialog.getByRole("button", { name: "上一步", exact: true }).click();
      await expect(row.getByRole("checkbox")).toBeChecked();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        dialog.getByRole("button", { name: "下一步", exact: true }),
      ).toBeInViewport();
      expect(await dialog.evaluate((el) => el.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: join(out, "article-materials-mobile.png"),
      });
      await dialog.getByRole("button", { name: "下一步", exact: true }).click();
      await expect(dialog.getByLabel("文章主题", { exact: true })).toHaveValue(
        "发布前如何验证回滚",
      );
      // Inspect the submitted scope without running a generative model in this UI fixture.
      let submitted: any;
      await page.route("**/api/knowledge/pages", async (route) => {
        submitted = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: "{}",
        });
      });
      await dialog
        .getByRole("button", { name: "开始整理", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      expect(submitted.revisionIds).toEqual([
        store.revision(store.list()[0]!.id)!.id,
      ]);
      expect(submitted.brief.goal).toContain("镜像和配置");
      await expect(trigger).toBeFocused();
      await page.unroute("**/api/knowledge/pages");
      await trigger.click();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await check(
    "search loading, empty, failure and superseded requests",
    async () => {
      const input = page.getByRole("textbox", {
        name: "搜索材料",
        exact: true,
      });
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/search?*", async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q");
        if (q === "delayed") {
          await gate;
          await route
            .fulfill({
              status: 200,
              contentType: "application/json",
              body: "[]",
            })
            .catch(() => {});
        } else if (q === "failed")
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "临时不可用" }),
          });
        else await route.continue();
      });
      await input.fill("delayed");
      await expect(
        page.getByText("正在搜索相关材料…", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "未找到相关内容" }),
      ).toHaveCount(0);
      await input.fill("回滚");
      release!();
      await expect(
        page
          .locator(".page .om-panel")
          .filter({ hasText: "发布前的回滚验证" })
          .first(),
      ).toBeVisible();
      await expect(
        page.getByText("正在搜索相关材料…", { exact: true }),
      ).toHaveCount(0);
      await input.fill("no-result-unique-zzz");
      await expect(
        page.getByRole("heading", { name: "未找到相关内容" }),
      ).toBeVisible();
      await input.fill("failed");
      await expect(page.getByText(/搜索失败：.*临时不可用/)).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "未找到相关内容" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "日常助理", exact: true }).click();
      await expect(page.getByText(/搜索失败：/)).toHaveCount(0);
      await page.unroute("**/api/search?*");
      await page.getByRole("button", { name: "原始材料", exact: true }).click();
    },
  );
  const first = store.list()[0]!.id as string;
  const revision = store.revision(first)!;
  await check(
    "A-U01 real job, applied proposal, notification and evidence flow",
    async () => {
      const job = store.jobs
        .list()
        .find((candidate) =>
          candidate.inputRefs.some(
            (ref) =>
              typeof ref === "object" &&
              ref !== null &&
              (ref as { revisionId?: string }).revisionId === revision.id,
          ),
        )!;
      const evaluated = await evaluateTask({
        revision,
        proposalId: "browser-auto-proposal",
        title: "提交发布前回滚验证报告",
        jobId: job.id,
      });
      expect(evaluated.policy).toBe("auto_apply");
      const lease = store.jobs.claimNext({
        workerId: "browser-worker",
        fingerprint: {
          model: "browser-fixture",
          effort: "low",
          promptHash: "browser-prompt",
          skillHash: "browser-skill",
          toolHash: "browser-tools",
        },
      })!;
      store.jobs.markRunning(lease.id, lease.leaseToken);
      store.jobs.succeed({
        jobId: lease.id,
        leaseToken: lease.leaseToken,
        resultRef: "browser-auto-proposal",
        usage: { inputTokens: 12, outputTokens: 8 },
      });
      await page.reload();
      await page.getByRole("button", { name: "材料处理", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "材料处理" }),
      ).toBeVisible();
      await expect(page.getByText("处理完成", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "提交发布前回滚验证报告" }),
      ).toBeVisible();
      await expect(page.getByText("已生效", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: /查看原证据 1/ }).click();
      await expect(page.locator("dialog[open]")).toContainText(
        "发布前验证回滚步骤，保留结果。",
      );
      await page
        .locator("dialog[open]")
        .getByRole("button", { name: "关闭全部" })
        .click();

      await page.getByRole("button", { name: "通知中心", exact: true }).click();
      const applied = page
        .locator(".om-panel")
        .filter({ hasText: "提交发布前回滚验证报告" });
      await applied.getByRole("button", { name: "查看详情" }).click();
      const detail = page.locator("dialog[open]");
      await expect(detail).toContainText("事项");
      await expect(detail).toContainText("查看原证据 1");
      await expect(detail).toContainText("等待发送");
      await detail.getByRole("button", { name: "关闭全部" }).click();
    },
  );
  const [a, b] = revision.fragments;
  store.link(a!.id, b!.id);
  store.link(b!.id, a!.id);
  await check("recursive evidence, cycle and return focus", async () => {
    await page.getByRole("button", { name: "原始材料", exact: true }).click();
    await page
      .locator(".source-link")
      .filter({ hasText: "发布前的回滚验证" })
      .click();
    await page.getByText("选择原文提问或查看来源", { exact: true }).click();
    await page.getByRole("button", { name: "打开这段原文" }).first().click();
    const d = page.locator("dialog[open]");
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
    await page.getByRole("button", { name: "事项与待办", exact: true }).click();
    await page.getByLabel("事项", { exact: true }).fill("补充回滚验证记录");
    await page.getByLabel("到期时间").fill("2020-01-01T09:00");
    await page.getByRole("button", { name: "记录待办" }).click();
    await expect(
      page.getByRole("heading", { name: "补充回滚验证记录" }),
    ).toBeVisible();
    const taskPanel = page
      .locator(".om-panel")
      .filter({ hasText: "补充回滚验证记录" });
    await taskPanel.getByRole("button", { name: "标为完成" }).click();
    await expect(
      taskPanel.getByRole("button", { name: "重新打开" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "通知中心", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "新增待办：补充回滚验证记录" }),
    ).toBeVisible();
  });
  await check(
    "daily assistant submits through native MCP and persists its conversation",
    async () => {
      await page.getByRole("button", { name: "日常助理", exact: true }).click();
      await page.getByLabel("发给日常助理").fill("今天有什么需要跟进的事项？");
      const turnResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/assistant\/conversations\/[^/]+\/turns$/.test(
            new URL(response.url()).pathname,
          ),
      );
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(
        page.getByText("日常消息已读取；当前没有需要变更的事项。", {
          exact: true,
        }),
      ).toBeVisible({ timeout: 20000 });
      const result = await (await turnResponse).json();
      expect(result.degraded).toBe(false);
      expect(result.turn.inputMessageRefs.status).toBe("done");
      expect(result.createdTaskIds).toEqual([]);
      const research = result.turn.toolActions.find(
        (action: { tool: string }) => action.tool === "research",
      );
      expect(research.trace.tools).toContain("submit_result");
      expect(research.trace.model).toBe("beta"); // The new main-assistant selection is active without restarting.
      expect(research.trace.effort).toBe("high"); // Protocol fixture, not native model quality acceptance.
      await page.getByRole("button", { name: "原始材料", exact: true }).click();
      await page.getByRole("button", { name: "日常助理", exact: true }).click();
      await expect(
        page.getByText("今天有什么需要跟进的事项？", { exact: true }),
      ).toBeVisible();
    },
  );
  await check(
    "requirement attention reads persisted scope and composes without losing the user's draft",
    async () => {
      // Rendering fixture only; assistant:work verifies real autonomous follow/coding.
      store.capture(
        {
          source: "manual",
          externalId: "ui-follow",
          title: "退款验收",
          parts: [{ type: "text", text: "本期先完成退款查询，页面尚未排期。" }],
          context: {},
        },
        { learning: false, notify: false },
      );
      const key = "requirement:browser-attention";
      built.work.pages.repository.savePlan(
        {
          ...requirementBrief({ key, title: "退款查询", goal: "跟进接口验收" }),
          materialKeys: ["manual:ui-follow"],
          attention: {
            focus: ["接口验收"],
            ignore: ["页面"],
            notifications: "important",
            instruction: "只关注接口，暂不关注页面",
          },
        },
        true,
      );
      built.work.pages.maintenance.setEnabled(key, false);
      const followResponse = await page.request.get(base + "/api/work");
      expect(followResponse.status(), await followResponse.text()).toBe(200);
      await page.getByRole("button", { name: "刷新状态", exact: true }).click();
      await expect(page.locator(".work-panel .follow-card h3")).toHaveText(
        "退款查询",
      );
      await page
        .locator(".work-panel")
        .getByText("关注点与我的反馈", { exact: true })
        .click();
      await expect(page.locator(".work-panel")).toContainText(
        "重点关注：接口验收",
      );
      await expect(page.locator(".work-panel")).toContainText("暂不关注：页面");
      await page.getByLabel("发给日常助理").fill("这是我还没发出的补充。");
      await page
        .getByRole("button", { name: "调整关注点", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByLabel("重点关注（每行一项）")).toHaveValue(
        "接口验收",
      );
      await page.getByLabel("暂不关注（每行一项）").fill("重复提醒");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByLabel("发给日常助理")).toHaveValue(
        "这是我还没发出的补充。",
      );
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.locator(".work-panel").scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(out, `requirement-attention-${width}.png`),
        });
      }
      await page.getByLabel("发给日常助理").fill("");
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await check(
    "daily follow-up controls: waiting, snooze, cancel and narrow layout",
    async () => {
      await page
        .getByRole("button", { name: "事项与待办", exact: true })
        .click();
      await page.getByLabel("事项", { exact: true }).fill("等待评审回复");
      await page.getByRole("button", { name: "记录待办" }).click();
      const panel = page.locator(".om-panel").filter({
        has: page.getByRole("heading", { name: "等待评审回复", exact: true }),
      });
      await panel.getByRole("button", { name: "跟进设置" }).click();
      await panel.getByLabel("等待对象或结果").fill("张三的评审回复");
      await panel.getByLabel("下次跟进时间").fill("2030-10-02T09:00");
      await panel
        .getByRole("button", { name: "记录等待", exact: true })
        .click();
      await expect(panel.getByText("等待回复", { exact: true })).toBeVisible();
      await expect(panel).toContainText("等待：张三的评审回复");
      await panel.getByRole("button", { name: "跟进设置" }).click();
      await panel.getByLabel("下次跟进时间").fill("2030-10-03T10:00");
      await panel
        .getByRole("button", { name: "稍后提醒", exact: true })
        .click();
      await expect(panel).toContainText("已暂缓提醒至");
      expect(await page.locator("body").innerText()).not.toMatch(
        /"taskId"|"requestId"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(panel).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        await page.screenshot({ path: join(out, `daily-${width}.png`) });
      }
      await panel.getByRole("button", { name: "跟进设置" }).click();
      await panel
        .getByRole("button", { name: "取消事项", exact: true })
        .click();
      await expect(panel.getByText("已取消", { exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 900 });
    },
  );
  await check(
    "A-U02 decision diff, evidence, receipts and stale state",
    async () => {
      const pending: {
        title: string;
        proposalId: string;
        decisionId: string;
        digest: string;
        externalId: string;
      }[] = [];
      for (const [index, title] of [
        "补充支付方案背景",
        "拒绝未经确认的排期",
        "批准明确的复核事项",
        "过期来源上的旧提案",
      ].entries()) {
        // Current policy asks for decisions on conflicting active commitments;
        // forwarded unknown-owner statements are retained as source, not cards.
        const baseline = store.capture({
          source: "manual",
          externalId: `decision-baseline-${index}`,
          title: `原事项：${title}`,
          provenance: ownerProvenance,
          parts: [{ type: "text", text: `原事项：${title}` }],
          context: {},
        });
        const applied = await evaluateTask({
          revision: baseline.revision,
          proposalId: `baseline-proposal-${index}`,
          title: `原事项：${title}`,
          kind: "claim",
          jobId: baseline.job!.id,
        });
        expect(applied.policy).toBe("auto_apply");
        const externalId = `decision-source-${index}`;
        const captured = store.capture({
          source: "manual",
          externalId,
          title,
          parts: [{ type: "text", text: `变更内容：${title}` }],
          provenance: ownerProvenance,
          context: {},
        });
        const result = await evaluateTask({
          revision: captured.revision,
          proposalId: `browser-decision-proposal-${index}`,
          title,
          jobId: captured.job!.id,
          targetId: applied.receipt!.entityId,
          kind: "claim",
        });
        expect(result.policy).toBe("awaiting_decision");
        pending.push({
          title,
          proposalId: `browser-decision-proposal-${index}`,
          decisionId: result.decisionId!,
          digest: result.proposalDigest,
          externalId,
        });
      }
      store.capture({
        source: "manual",
        externalId: pending[3]!.externalId,
        title: "过期来源上的新版本",
        parts: [{ type: "text", text: "来源已经更新，旧提案不能继续批准。" }],
        context: {},
      });
      await page.reload();
      await page.getByRole("button", { name: "待判断", exact: true }).click();

      const contextPanel = page.locator(".om-panel").filter({
        has: page.getByRole("heading", { name: pending[0]!.title }),
      });
      await expect(contextPanel).toContainText("查看具体变化");
      await expect(contextPanel).toContainText("依据 1");
      await contextPanel
        .getByRole("button", { name: "补充背景", exact: true })
        .click();
      await expect(contextPanel).toContainText("已要求补充背景");
      await expect(contextPanel).toContainText("处理回执");
      await expect(
        contextPanel.getByRole("button", { name: "确认并应用" }),
      ).toHaveCount(0);

      const rejectPanel = page.locator(".om-panel").filter({
        has: page.getByRole("heading", { name: pending[1]!.title }),
      });
      await rejectPanel
        .getByRole("button", { name: "拒绝", exact: true })
        .click();
      await expect(rejectPanel).toContainText("已拒绝");

      const approvePanel = page.locator(".om-panel").filter({
        has: page.getByRole("heading", { name: pending[2]!.title }),
      });
      await approvePanel
        .getByRole("button", { name: "确认并应用", exact: true })
        .click();
      await expect(approvePanel).toContainText("已确认");
      expect(
        Boolean(
          store.db
            .prepare(
              "SELECT 1 FROM memories m JOIN memory_revisions r ON m.head_revision_id=r.id WHERE json_extract(r.body,'$.statement')=?",
            )
            .get(pending[2]!.title),
        ),
      ).toBe(true);

      const stalePanel = page.locator(".om-panel").filter({
        has: page.getByRole("heading", { name: pending[3]!.title }),
      });
      await stalePanel
        .getByRole("button", { name: "确认并应用", exact: true })
        .click();
      await expect(stalePanel).toContainText("来源已变化，旧判断失效");
      await expect(stalePanel).toContainText("这个判断不能再提交");
    },
  );
  await check(
    "A-U03 QR, direct authorization link, reusable app and pairing",
    async () => {
      await page
        .getByRole("button", { name: "飞书机器人", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "飞书机器人" }),
      ).toBeVisible();
      await expect(page.getByLabel("App ID")).toHaveValue(larkAppId);
      const created = await botCli("create");
      expect(created.setupUrl).toContain(`onboarding=${created.id}`);
      expect(
        (await botCli("pending")).some((item: any) => item.id === created.id),
      ).toBe(true);
      expect((await botCli("cancel", created.id)).status).toBe("cancelled");
      const authorized = await botCli("authorize", larkAppId);
      expect(authorized.requestedAppId).toBe(larkAppId);
      await botCli("cancel", authorized.id);
      await page.getByRole("button", { name: "生成更新授权" }).click();
      await expect(page.getByText("等待授权", { exact: true })).toBeVisible();
      await expect(page.locator(".qr-box canvas")).toBeVisible();
      const authorization = page.getByRole("link", {
        name: "打开飞书授权页面",
      });
      await expect(authorization).toHaveAttribute(
        "href",
        new RegExp(`clientID=${larkAppId}`),
      );
      await expect(authorization).toHaveAttribute("target", "_blank");
      const authorizationId = new URLSearchParams(
        new URL(page.url()).hash.split("?")[1],
      ).get("onboarding");
      expect(authorizationId).toBeTruthy();
      await page.reload();
      await expect(authorization).toHaveAttribute(
        "href",
        new RegExp(`clientID=${larkAppId}`),
      );
      expect(
        new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get(
          "onboarding",
        ),
      ).toBe(authorizationId);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator(".authorization-grid").scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(out, `lark-authorization-${width}.png`),
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "取消本次接入" }).click();
      await expect(page.getByRole("heading", { name: "已取消" })).toBeVisible();
      await page.getByRole("button", { name: "重新配置" }).click();

      await page.getByRole("button", { name: "直接导入凭据" }).click();
      await expect(
        page.getByText("从 botmux 复用", { exact: true }),
      ).toBeVisible();
      const importFile = join(dir, "bot-connect.json");
      const requested = (
        await app.inject("/api/integrations/lark/default-config")
      ).json();
      writeFileSync(
        importFile,
        JSON.stringify({
          appId: larkAppId,
          source: "botmux",
          config: requested,
        }),
        { mode: 0o600 },
      );
      const imported = await botCli("connect", importFile);
      await page.goto(imported.setupUrl);
      await expect(
        page.getByText("等待本人配对", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "生成配对码" }).click();
      const code = (await page.locator(".pairing-code").textContent())!.trim();
      expect(code.length).toBeGreaterThan(20);
      const paired = lark.receivePairing({
        appId: larkAppId,
        code,
        senderOpenId: "ou_browserowner",
        chatId: "oc_browser_owner",
        chatType: "p2p",
      });
      expect(paired.senderOpenId).toBe("ou_browserowner");
      await page.getByRole("button", { name: "刷新状态" }).click();
      await expect(page.getByText(/候选 本人身份/)).toBeVisible();
      const pairingUrl = page.url();
      await page.reload();
      await expect(page.getByText(/候选 本人身份/)).toContainText(
        "ou_browserowner",
      );
      expect(page.url()).toBe(pairingUrl);
      await expect(page.locator(".pairing-code")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "确认这是我并启用" }),
      ).toBeVisible();
      expect((await botCli("show", imported.id)).pairing.candidateOpenId).toBe(
        "ou_browserowner",
      );
      expect(
        (await botCli("confirm", imported.id, "--owner", "ou_browserowner"))
          .status,
      ).toBe("active");
      await page.getByRole("button", { name: "刷新状态" }).click();
      await expect(page.getByText("机器人连接已启用")).toBeVisible();
      await expect(
        page.getByText("加入群聊后会自动读取该群消息"),
      ).toBeVisible();
      expect(await page.locator("body").textContent()).not.toContain(
        "browser-fixture-secret-never-exposed",
      );
      expect(
        JSON.stringify(
          (await app.inject("/api/integrations/lark/status")).json(),
        ),
      ).not.toContain("browser-fixture-secret-never-exposed");
    },
  );
  await check("page reload and desktop rendering", async () => {
    await page.getByRole("button", { name: "原始材料", exact: true }).click();
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
  await check("A-U04 768px layout and keyboard focus", async () => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByText("选择原文提问或查看来源", { exact: true }).click();
    await page.getByRole("button", { name: "打开这段原文" }).first().click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
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
    await page.getByText("选择原文提问或查看来源", { exact: true }).click();
    await page.getByRole("button", { name: "打开这段原文" }).first().click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    expect(
      await page
        .locator("dialog[open]")
        .evaluate(
          (el) => Math.abs(el.getBoundingClientRect().width - innerWidth) < 2,
        ),
    ).toBe(true);
    await page.keyboard.press("Tab");
    expect(
      await page
        .locator("dialog[open]")
        .evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
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
      await page.getByText("选择原文提问或查看来源", { exact: true }).click();
      await page
        .getByRole("button", { name: /打开这段原文/ })
        .first()
        .click();
      const d = page.locator("dialog[open]");
      for (let i = 0; i < 99; i++)
        await d.locator(".edge button").first().click();
      await expect(d).toContainText("第 100 层");
      await expect(d.locator("blockquote")).toHaveCount(1);
      await d.getByRole("button", { name: "关闭全部" }).click();
    },
  );
  await check(
    "A-U05 offline, model, delivery failure and restart truthfulness",
    async () => {
      const failedJob = store.jobs.enqueue({
        kind: "browser_model_unavailable",
        inputRefs: [{ revisionId: revision.id }],
        roleVersion: "extractor@1",
        policyVersion: "memory-policy@1",
        cause: "browser_failure",
      }).job;
      store.db
        .prepare(
          `UPDATE jobs SET state='failed',error_kind='config',
           last_error='Configured model is unavailable',finished_at=?,updated_at=?
         WHERE id=?`,
        )
        .run(new Date().toISOString(), new Date().toISOString(), failedJob.id);
      const applicationNotice = store.db
        .prepare(
          "SELECT change_id FROM notifications WHERE title LIKE ? ORDER BY rowid DESC LIMIT 1",
        )
        .get("%提交发布前回滚验证报告%") as { change_id: string };
      store.db
        .prepare(
          `UPDATE delivery_intents SET state='failed',attempt_count=3,
           error_kind='permanent',last_error='Notification channel unavailable',
           updated_at=? WHERE change_id=?`,
        )
        .run(new Date().toISOString(), applicationNotice.change_id);

      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.reload();
      await page.getByRole("button", { name: "材料处理", exact: true }).click();
      await expect(
        page.getByText("Configured model is unavailable"),
      ).toBeVisible();
      await expect(page.getByText("处理失败", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "通知中心", exact: true }).click();
      const failedDelivery = page
        .locator(".om-panel")
        .filter({ hasText: "提交发布前回滚验证报告" });
      await failedDelivery.getByRole("button", { name: "查看详情" }).click();
      await expect(page.locator("dialog[open]")).toContainText("发送失败");
      await expect(page.locator("dialog[open]")).toContainText(
        "Notification channel unavailable",
      );
      await page
        .locator("dialog[open]")
        .getByRole("button", { name: "关闭全部" })
        .click();

      await page.route("**/api/jobs", (route) => route.abort());
      await new Promise((resolve) => setTimeout(resolve, 2800));
      await expect(page.getByRole("alert")).toContainText("Failed to fetch");
      await expect(
        page.getByRole("button", { name: "原始材料", exact: true }),
      ).toBeVisible();
      await page.unroute("**/api/jobs");

      await app.close();
      built = await buildApp(appConfig, { lark });
      app = built.app;
      store = built.store;
      base = await app.listen({ port: 0, host: "127.0.0.1" });
      await page.goto(base);
      await expect(
        page.getByRole("button", { name: "原始材料", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "事项与待办", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "提交发布前回滚验证报告" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "补充回滚验证记录" }),
      ).toBeVisible();
    },
  );
  await check(
    "Markdown tables and Mermaid diagrams render through the real reader",
    async () => {
      store.capture({
        source: "manual",
        externalId: "rich-document",
        title: "结构化阅读验收",
        context: {},
        parts: [
          {
            type: "text",
            text: "# 阅读流程\n\n| 阶段 | 说明 |\n| --- | --- |\n| 捕获 | 保存原文 |\n\n```mermaid\nflowchart LR\n  A[捕获] --> B[阅读]\n```\n\n<script>window.__unsafeDiagram = true</script>",
          },
        ],
      });
      await page.getByRole("button", { name: "原始材料", exact: true }).click();
      await page.getByLabel("查找原始材料").fill("结构化阅读验收");
      await page
        .locator(".source-link")
        .filter({ hasText: "结构化阅读验收" })
        .click();
      await expect(page.locator(".reader .md-body table")).toContainText(
        "保存原文",
      );
      await expect(page.locator(".reader .om-diagram svg")).toBeVisible({
        timeout: 30000,
      });
      await expect(page.locator(".reader .om-diagram svg")).toContainText(
        "捕获",
      );
      await expect(page.locator(".reader .om-diagram svg")).toContainText(
        "阅读",
      );
      await expect(
        page.locator(".reader .om-diagram foreignObject"),
      ).toHaveCount(0);
      await expect(page.locator(".reader script")).toHaveCount(0);
    },
  );
  await check(
    "shared disclosures keep content and separate folder navigation from expansion",
    async () => {
      await page.goto(base + "/#/design");
      const heading = page.getByRole("button", {
        name: "展开阅读补充说明",
        exact: true,
      });
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      const input = page.getByPlaceholder("收起后再展开，内容保持");
      await expect(input).not.toBeVisible();
      await heading.focus();
      await page.keyboard.press("Enter");
      await expect(input).toBeVisible();
      await input.fill("保留草稿");
      await heading.click();
      await expect(input).not.toBeVisible();
      await heading.click();
      await expect(input).toHaveValue("保留草稿");
      const folder = page.getByRole("button", { name: /^分类目录\s*2 篇$/ });
      const arrow = page.getByRole("button", {
        name: "展开分类目录",
        exact: true,
      });
      await folder.click();
      await expect(arrow).toHaveAttribute("aria-expanded", "false");
      await arrow.click();
      await expect(
        page.getByText("分类标题与箭头分别执行导航和展开操作。", {
          exact: true,
        }),
      ).toBeVisible();
      const targetId = await heading.getAttribute("aria-controls");
      await expect(page.locator(`[id="${targetId}"]`)).toBeVisible();
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await heading
          .locator("svg")
          .evaluate((el) => getComputedStyle(el).transitionDuration),
      ).toBe("0s");
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await heading.scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({ path: join(out, `disclosure-${width}.png`) });
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
    },
  );
  await check(
    "article maintenance settings persist through the real API",
    async () => {
      // Host-rendering fixture only; live-page-maintenance.ts verifies actual AI updates.
      const repository = new KnowledgeRepository(store),
        material = repository.materials()[0]!;
      const plan = {
        key: "browser-maintenance",
        title: "文章更新设置验收",
        order: 0,
        kind: "reference" as const,
        reader: "界面验收",
        goal: "验证已选材料的更新设置",
        scenario: "打开和关闭持续维护",
        questions: ["如何开启更新？"],
        entryPaths: [],
        materialKeys: [material.key],
        topicPath: ["界面验收"],
      };
      repository.savePlan(plan, true);
      repository.publish({
        version: 1,
        reading: plan,
        publication: { role: "reference" },
        document: bindKnowledgeQuotes(
          {
            key: plan.key,
            title: plan.title,
            summary: "用于检查文章更新控件的固定界面数据。",
            category: "界面验收",
            topicPath: plan.topicPath,
            sections: [
              {
                key: "source",
                title: "所选材料",
                body: "下方设置跟踪这份材料的后续版本。[[source]]",
              },
            ],
            citations: [
              {
                key: "source",
                label: material.title,
                reason: "所选原文",
                relation: "background",
                quote: "",
                target: {
                  kind: "material",
                  key: material.key,
                  startLine: 1,
                  endLine: 1,
                },
              },
            ],
            questions: [],
          },
          new Map([[material.key, material]]),
        ),
        dependencies: [
          { kind: "material", key: material.key, digest: material.digest },
        ],
        generation: {
          model: "browser-fixture",
          effort: null,
          at: new Date().toISOString(),
          trace: {},
        },
        review: {
          model: "browser-fixture",
          at: new Date().toISOString(),
          verdict: "accepted",
          trace: {},
        },
      });
      await page.goto(base + "#/knowledge/" + plan.key);
      const panel = page.getByRole("region", { name: "文章更新方式" });
      const toggle = panel.getByRole("checkbox", {
        name: "随所选材料自动更新",
      });
      await toggle.check();
      await expect
        .poll(() =>
          Number(
            store.db
              .prepare(
                "SELECT enabled FROM knowledge_page_maintenance WHERE document_key=?",
              )
              .get(plan.key)?.enabled,
          ),
        )
        .toBe(1);
      await page.reload();
      await expect(toggle).toBeChecked();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await panel.scrollIntoViewIfNeeded();
        expect(
          await panel
            .locator("label")
            .evaluate((el) => getComputedStyle(el).flexDirection),
        ).toBe("row");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(out, `article-maintenance-${width}.png`),
        });
      }
      await toggle.uncheck();
      await expect
        .poll(() =>
          Number(
            store.db
              .prepare(
                "SELECT enabled FROM knowledge_page_maintenance WHERE document_key=?",
              )
              .get(plan.key)?.enabled,
          ),
        )
        .toBe(0);
      expect(
        store.jobs
          .list()
          .filter((job) => job.kind === "knowledge:maintain-page"),
      ).toHaveLength(0);
    },
  );
  await check(
    "project capture and article scope use persisted memberships",
    async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(base + "#/capture");
      await page
        .getByRole("button", { name: "新建项目或主题", exact: true })
        .click();
      await page.getByLabel("名称", { exact: true }).fill("阅读小组界面验收");
      await page.getByLabel("范围说明", { exact: true }).fill("报名与场地安排");
      await page
        .getByRole("button", { name: "创建并选中", exact: true })
        .click();
      await expect
        .poll(
          () =>
            store.contexts.list().find((c) => c.name === "阅读小组界面验收")
              ?.id,
        )
        .toBeTruthy();
      await expect(
        page.getByRole("checkbox", { name: /阅读小组界面验收/ }),
      ).toBeChecked();
      await page.getByLabel("材料标题", { exact: true }).fill("小组场地补充");
      await page
        .getByLabel("材料正文", { exact: true })
        .fill("周五在东侧阅读室集合。小周负责签到。");
      await page
        .getByRole("button", { name: "保存材料与证据", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "小组场地补充", exact: true }),
      ).toBeVisible();
      const source = store.list().find((s) => s.title === "小组场地补充")!;
      const contextId = store.contexts
        .list()
        .find((c) => c.name === "阅读小组界面验收")!.id;
      expect(store.contexts.forSource(source.sourceId)).toEqual([contextId]);
      await page
        .getByRole("button", { name: "所属项目与主题", exact: true })
        .click();
      await expect(
        page.getByRole("checkbox", { name: /阅读小组界面验收/ }),
      ).toBeChecked();
      await page.getByRole("button", { name: "保存归属", exact: true }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "归属已保存" }),
      ).toBeVisible();
      await page.goto(base + "#/knowledge/browser-maintenance");
      await page
        .getByRole("button", { name: "调整材料与目标", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "调整材料与目标",
        exact: true,
      });
      await dialog.getByRole("checkbox", { name: /阅读小组界面验收/ }).check();
      await expect(dialog.locator(".material-options")).toContainText(
        "小组场地补充",
      );
      const linked = dialog
        .locator(".material-option")
        .filter({ hasText: "小组场地补充" });
      await expect(linked.getByRole("checkbox")).toBeChecked();
      await expect(linked.getByRole("checkbox")).toBeDisabled();
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(out, `project-contexts-${width}.png`),
        });
      }
      await dialog.getByRole("button", { name: "下一步", exact: true }).click();
      await dialog
        .getByRole("button", { name: "保存并重新整理", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      expect(
        new KnowledgeRepository(store)
          .pages()
          .find((p) => p.key === "browser-maintenance")?.plan?.contextIds,
      ).toEqual([contextId]);
    },
  );
  expect(errors).toEqual([]);
  writeFileSync(
    resolve(".repo-review/runtime/browser/verification.json"),
    JSON.stringify(
      {
        date: new Date().toISOString().slice(0, 10),
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
  larkStore.close();
  rmSync(dir, { recursive: true, force: true });
}
