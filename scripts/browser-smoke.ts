// Real Vue + API + SQLite test. Fixture Agent is used only to make UI assertions deterministic.
import { chromium, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../apps/server/src/app.js";
import { Store } from "../apps/server/src/store.js";
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
const ownerProvenance = { collectorId: "browser-fixture", actorId: "owner", actorType: "owner" as const, actorVerifiedBy: "authenticated-test", sourceUri: null, eventId: null, eventAt: "2026-09-29T00:00:00Z", timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" as const };
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
        body: input.kind === "claim" ? { statement: input.title, attribution: "authenticated owner evidence", valid_from: null, valid_to: null } : {
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
      await page.getByRole("button", { name: "学习流程", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "学习流程" }),
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
      await expect(detail).toContainText("task");
      await expect(detail).toContainText("查看原证据 1");
      await expect(detail).toContainText("pending");
      await detail.getByRole("button", { name: "关闭全部" }).click();
    },
  );
  const [a, b] = revision.fragments;
  store.link(a!.id, b!.id);
  store.link(b!.id, a!.id);
  await check("recursive evidence, cycle and return focus", async () => {
    await page
      .locator(".source-link")
      .filter({ hasText: "发布前的回滚验证" })
      .click();
    await page.getByRole("button", { name: "查看引用" }).first().click();
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
    await page.getByRole("button", { name: "需求与待办", exact: true }).click();
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
  await check("daily assistant uses the persistent conversation API without a selected fragment", async () => {
    await page.getByRole("button", { name: "日常助理", exact: true }).click();
    await page.getByLabel("发给日常助理").fill("今天有什么需要跟进的事项？");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(page.getByText("日常消息已读取；当前没有需要变更的事项。", { exact: true })).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "知识阅读", exact: true }).click();
    await page.getByRole("button", { name: "日常助理", exact: true }).click();
    await expect(page.getByText("今天有什么需要跟进的事项？", { exact: true })).toBeVisible();
  });
  await check("daily follow-up controls: waiting, snooze, cancel and narrow layout", async () => {
    await page.getByRole("button", { name: "需求与待办", exact: true }).click();
    await page.getByLabel("事项", { exact: true }).fill("等待评审回复");
    await page.getByRole("button", { name: "记录待办" }).click();
    const panel = page.locator(".om-panel").filter({ has: page.getByRole("heading", { name: "等待评审回复", exact: true }) });
    await panel.getByRole("button", { name: "跟进设置" }).click();
    await panel.getByLabel("等待对象或结果").fill("张三的评审回复");
    await panel.getByLabel("下次跟进时间").fill("2030-10-02T09:00");
    await panel.getByRole("button", { name: "记录等待", exact: true }).click();
    await expect(panel.getByText("等待回复", { exact: true })).toBeVisible();
    await expect(panel).toContainText("等待：张三的评审回复");
    await panel.getByRole("button", { name: "跟进设置" }).click();
    await panel.getByLabel("下次跟进时间").fill("2030-10-03T10:00");
    await panel.getByRole("button", { name: "稍后提醒", exact: true }).click();
    await expect(panel).toContainText("已暂缓提醒至");
    expect(await page.locator("body").innerText()).not.toMatch(/"taskId"|"requestId"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    for (const width of [1440,768,390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: join(out, `daily-${width}.png`) });
    }
    await panel.getByRole("button", { name: "跟进设置" }).click();
    await panel.getByRole("button", { name: "取消事项", exact: true }).click();
    await expect(panel.getByText("已取消", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
  });
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
        const baseline = store.capture({ source: "manual", externalId: `decision-baseline-${index}`, title: `原事项：${title}`, provenance: ownerProvenance, parts: [{ type: "text", text: `原事项：${title}` }], context: {} });
        const applied = await evaluateTask({ revision: baseline.revision, proposalId: `baseline-proposal-${index}`, title: `原事项：${title}`, kind: "claim", jobId: baseline.job!.id });
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
        Boolean(store.db.prepare("SELECT 1 FROM memories m JOIN memory_revisions r ON m.head_revision_id=r.id WHERE json_extract(r.body,'$.statement')=?").get(pending[2]!.title)),
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
      await page.getByRole("button", { name: "取消本次接入" }).click();
      await expect(page.getByRole("heading", { name: "已取消" })).toBeVisible();
      await page.getByRole("button", { name: "重新配置" }).click();

      await page.getByRole("button", { name: "直接导入凭据" }).click();
      await expect(
        page.getByText("从 botmux 复用", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "导入并核验" }).click();
      await expect(
        page.getByText("等待 owner 配对", { exact: true }),
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
      await expect(page.getByText(/候选 owner/)).toBeVisible();
      await page.getByRole("button", { name: "确认这是我并启用" }).click();
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
    await page.getByRole("button", { name: "查看引用" }).first().click();
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
    await page.getByRole("button", { name: "查看引用" }).first().click();
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
      await page
        .getByRole("button", { name: /查看引用/ })
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
      await page.getByRole("button", { name: "学习流程", exact: true }).click();
      await expect(
        page.getByText("Configured model is unavailable"),
      ).toBeVisible();
      await expect(page.getByText("处理失败", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "通知中心", exact: true }).click();
      const failedDelivery = page
        .locator(".om-panel")
        .filter({ hasText: "提交发布前回滚验证报告" });
      await failedDelivery.getByRole("button", { name: "查看详情" }).click();
      await expect(page.locator("dialog[open]")).toContainText("failed");
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
        page.locator(".source-link").filter({ hasText: "发布前的回滚验证" }),
      ).toBeVisible();
      await page.unroute("**/api/jobs");

      await app.close();
      built = await buildApp(appConfig, { lark });
      app = built.app;
      store = built.store;
      base = await app.listen({ port: 0, host: "127.0.0.1" });
      await page.goto(base);
      await expect(
        page.locator(".source-link").filter({ hasText: "发布前的回滚验证" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "需求与待办", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "提交发布前回滚验证报告" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "补充回滚验证记录" }),
      ).toBeVisible();
    },
  );
  expect(errors).toEqual([]);
  writeFileSync(
    resolve("docs/implementation/browser-verification.json"),
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
