/**
 * Feature screenshots for the docs site and README:
 *
 *   pnpm run build && node scripts/doc-screens.ts [outDir]
 *
 * Seeds a throwaway data directory with a fictional project (示例商城 · 退款改造: a requirement, a
 * technical plan, a group chat, code, a Wiki page, memories, items, a reviewed delegation, a rule),
 * serves the built web on it and captures each feature at 1440×900 (light). Nothing real is shown,
 * so the images can be published. When a page changes, run it again; the file names stay the same.
 * Uses the installed Edge or Chrome (CHROMIUM=path to override). With `--serve` it only serves the
 * demo data and prints the address, to look around by hand; `--only=name,name` captures just those.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { createAsk } from "../src/agents/asks.ts";
import { savePage } from "../src/agents/ui-pages.ts";
import { findAgentSpec } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createSession, pluginContext } from "../src/plugins/blocks.ts";
import { forgetPlugin, getPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { embedders, itemProviders, notifiers, rerankers, retrievers } from "../src/plugins/process-hooks.ts";
import { linkPlugin } from "../src/plugins/links.ts";
import { checkHookSecret, createHookSecret } from "../src/plugins/hooks.ts";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { invite, savePeers } from "../src/core/peers.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { registerFormats } from "../src/plugins/formats.ts";
import type { PluginManifest } from "../src/plugins/registry.ts";
import { applyAttempt, type Attempt } from "../plugins/english/learner.ts";
import { recordReview } from "../src/agents/review.ts";
import { addRunEvent, createRun, setRunOutput } from "../src/agents/runs.ts";
import { App } from "../src/core/app.ts";
import { networkPolicySchema } from "../src/core/config.ts";
import { registerCredential, setCredentialSharing, startCredentialLogin } from "../src/agents/credentials.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { closeVault } from "../src/auth/vault.ts";
import { all, one, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace, ensurePersonalSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { addItemEvent, upsertItem } from "../src/items/store.ts";
import { addMaterials } from "../src/items/materials.ts";
import type { ChangeType } from "../src/items/changes.ts";
import { createLine } from "../src/items/lines.ts";
import { attachBrief, sendToday } from "../src/items/today.ts";
import { itemContext, saveContext } from "../src/channels/listen.ts";
import { setParent } from "../src/items/parent.ts";
import { parseFlow } from "../src/flows/definitions.ts";
import { proposeFlow, startFlow } from "../src/flows/engine.ts";
import { saveGateChecks } from "../src/flows/plugin-gates.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { changeStage } from "../src/flows/store.ts";
import { createDesign, getDesign, setConcernState, submitRevision } from "../src/designs/store.ts";
import { recordReqStatus, saveReqs } from "../src/items/requirements.ts";
import { recordTests } from "../src/items/req-tests.ts";
import { remember } from "../src/memory/store.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { resolveCitationsNow } from "../src/channels/citations.ts";
import { recordFiring, saveRule } from "../src/rules/store.ts";
import { saveProbe } from "../src/rules/probes.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { addSourceNote, setAttention, setNodeLevel } from "../src/sources/attention.ts";
import { recordWikiNodes } from "../src/channels/lark-wiki.ts";
import { writePage } from "../src/wiki/store.ts";
import { defineMetric, recordPoints } from "../src/data/metrics.ts";
import { snapshotOmemUsage } from "../src/data/omem-usage.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { overflowIssues, overflowReport } from "./overflow-check.ts";

const serveOnly = process.argv.includes("--serve");
// --only=a,b: capture just these (the others keep their files).
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const out = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "site/public/screens");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "omem-screens-"));
const app = App.open(home);
ensurePersonalSpace(app);
setLarkCliForTests(async () => ({}));

// ---- a small repository with a delegation's change in a worktree --------------------------------
const repo = join(home, "shop");
mkdirSync(repo);
const sh = (cwd: string, ...args: string[]) => {
  const r = git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
sh(repo, "init", "-q", "-b", "main");
sh(repo, "config", "user.name", "Demo"); sh(repo, "config", "user.email", "demo@example.com"); sh(repo, "config", "core.autocrlf", "false");
const REFUND_BEFORE = `// 退款金额：按订单所有行计算
function refundAmount(order) {
  return order.lines.reduce((sum, line) => sum + line.paid, 0);
}

module.exports = { refundAmount };
`;
const REFUND_AFTER = `// 退款只算已发货的行；订单优惠按各行实付比例分摊，尾差归最后一行
function toCents(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    throw new RangeError("金额必须是非负有限数字");
  }
  return Math.round(amount * 100);
}

function refundLineAmounts(order) {
  const paid = order.lines.filter((line) => line.shipped === true).map((line) => toCents(line.paid));
  if (paid.length === 0) return [];
  const total = paid.reduce((sum, amount) => sum + amount, 0);
  const discount = toCents(order.couponDiscount ?? 0);
  let remaining = discount;
  return paid.map((amount, index) => {
    const share = index === paid.length - 1 ? remaining : Math.floor((discount * amount) / total);
    remaining -= share;
    return amount - share;
  });
}

function refundAmount(order) {
  const cents = refundLineAmounts(order).reduce((sum, amount) => sum + amount, 0);
  return cents / 100;
}

module.exports = { refundAmount, refundLineAmounts, toCents };
`;
writeFileSync(join(repo, "refund.js"), REFUND_BEFORE);
writeFileSync(join(repo, "test.js"), `const assert = require("assert");\nconst { refundAmount } = require("./refund");\nassert.equal(refundAmount({ lines: [{ paid: 10 }] }), 10);\n`);
writeFileSync(join(repo, "README.md"), "# 示例商城\n\n订单、退款与优惠。\n");
sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "init");
const base = sh(repo, "rev-parse", "HEAD");

const shop = createSpace(app, { id: "shop", name: "示例商城", kind: "repo", rootPath: repo, description: "订单、退款与优惠" });

// ---- materials ---------------------------------------------------------------------------------
const prd = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/退款改造需求.md", title: "退款改造需求（PRD）", text: [
  "# 退款改造需求",
  "",
  "## 背景",
  "部分发货的订单退款时，系统按整单金额退，导致多退。",
  "",
  "## 规则",
  "1. 退款只计算已发货的行；未发货的行走取消流程，不在这里退。",
  "2. 订单级优惠（优惠券、满减）按各行实付金额比例分摊到行。",
  "3. 分摊的尾差（分）归最后一行，保证各行之和等于优惠总额。",
  "4. 金额最多两位小数，超出精度直接报错，不四舍五入。",
  "",
  "## 验收",
  "- 两行已发货、一行未发货，优惠 10 元：只退两行，分摊之和为 10 元。",
  "- 输入 12.345：报错。",
].join("\n") }).id;
const tech = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/退款技术方案.md", title: "退款改造技术方案", text: [
  "# 退款改造技术方案",
  "",
  "金额统一换算成分（整数）计算，避免浮点误差。",
  "分摊顺序按订单行原始顺序，最后一行承担尾差。",
  "接口 refundAmount 保持签名不变，新增 refundLineAmounts 返回每行可退金额。",
  "上线前回放上月 2000 笔部分发货退款，对比新旧结果。",
].join("\n") }).id;
const chat = upsertSource(app, { spaceId: "shop", kind: "chat", uri: "lark:oc_demo_refund", title: "退款改造讨论群", text: [
  "[10-21 14:02] 小王：部分发货的单子，客户申请退款，系统退了整单的钱",
  "[10-21 14:05] 小李：优惠券怎么算？按行分还是整单扣？",
  "[10-21 14:09] 产品 阿青：按各行实付比例分摊，尾差放最后一行",
  "[10-21 14:12] 小王：未发货的那几行呢",
  "[10-21 14:13] 产品 阿青：未发货的走取消，不在退款里算",
  "[10-22 10:30] 小李：上次满减分摊出过负数，这次加个测试",
].join("\n") }).id;
const code = upsertSource(app, { spaceId: "shop", kind: "code", uri: "refund.js", title: "refund.js", text: REFUND_AFTER }).id;
const confirmationTable = upsertSource(app, { spaceId: "shop", kind: "work", uri: "work/refund-confirmation", title: "退款改造确认表", text: [
  "# 退款改造确认表", "", "| 编号 | 验收项 | 建议 |", "| --- | --- | --- |",
  ...Array.from({ length: 29 }, (_, i) => `| ${i + 1} | ${["部分发货退款", "运费分摊", "优惠尾差", "退款失败重试"][i % 4]} · 场景 ${i + 1} | 按方案验证 |`),
  "", "逐项确认后再进入验收。",
].join("\n") }).id;
writePage(app, "shop", "refund/confirmation", { meta: { title: "退款验收确认", kind: "reference" }, body: `剩余场景见[第 7—29 项确认表](src:${confirmationTable}#L11-L33)。\n` }, { actor: "wiki-writer" });
upsertSource(app, { spaceId: "personal", kind: "note", uri: "note:weekly", title: "本周计划", text: "- 周四前上线退款改造\n- 周五和小王对一下发货状态的接口\n" });
upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/优惠券规则.md", title: "优惠券规则", text: "# 优惠券规则\n\n满减券按订单实付金额计算门槛。\n" });

// ---- a project space browsed as a catalog: a knowledge base, linked docs, chats, a site, a meeting ----
createSpace(app, { id: "refund", name: "退款改造", kind: "project", description: "退款改造项目的需求、讨论与会议" });
const LARK = "https://tenant.larkoffice.com";
const kbNode = (token: string, title: string, parent?: string, hasChild = false) => ({ spaceId: "kb_demo", nodeToken: token, objToken: `obj_${token}`, objType: "docx", nodeType: "origin", parentNodeToken: parent, title, hasChild });
recordWikiNodes(app, [kbNode("wn_root", "交易中台"), kbNode("wn_refund", "退款改造", "wn_root", true), kbNode("wn_prd", "退款改造需求", "wn_refund"), kbNode("wn_tech", "退款技术方案", "wn_refund"),
  kbNode("wn_review", "上线复盘", "wn_refund"), kbNode("wn_old", "2025 年退款方案（归档）", "wn_root")], { spaceName: "项目 A 知识库" });
const kbDoc = (token: string, title: string, text: string) => upsertSource(app, { spaceId: "refund", kind: "doc", uri: `${LARK}/wiki/${token}`, title, text,
  meta: { via: "lark-cli", url: `${LARK}/wiki/${token}`, wikiSpaceId: "kb_demo", wikiNodeToken: token, documentId: `obj_${token}` } }).id;
const kbPrd = kbDoc("wn_prd", "退款改造需求", "# 退款改造需求\n\n部分发货只退已发货的行。\n订单级优惠按实付比例分摊，尾差归最后一行。\n");
kbDoc("wn_tech", "退款技术方案", "# 退款技术方案\n\n金额按分计算，超出两位小数报错。\n");
const kbOld = kbDoc("wn_old", "2025 年退款方案（归档）", "# 2025 年退款方案\n\n退款按订单总额计算。\n");
upsertSource(app, { spaceId: "refund", kind: "doc", uri: `${LARK}/docx/dx_api`, title: "退款接口说明", text: "# 退款接口\n\nPOST /refunds\n", meta: { via: "lark-cli", url: `${LARK}/docx/dx_api`, parentUrl: `${LARK}/wiki/wn_prd` } });
upsertSource(app, { spaceId: "refund", kind: "doc", uri: `${LARK}/docx/dx_week`, title: "退款改造周报", text: "# 周报\n\n本周完成分摊规则。\n", meta: { via: "lark-cli", url: `${LARK}/docx/dx_week` } });
for (const m of ["2026-09", "2026-08"]) upsertSource(app, { spaceId: "refund", kind: "chat", uri: `lark:oc_demo_team@${m}`, title: `退款改造讨论群（${m} 历史）`, text: `[${m}-03 10:00] 小王: 发货状态接口改好了`, meta: { chatId: "oc_demo_team", chatKind: "group", month: m, history: true } });
upsertSource(app, { spaceId: "refund", kind: "chat", uri: "lark:oc_demo_team", title: "退款改造讨论群", text: "[10-21 10:02] 阿青: 尾差归最后一行\n[10-21 10:05] 小王: 收到", meta: { chatId: "oc_demo_team", chatMode: "group" } });
upsertSource(app, { spaceId: "refund", kind: "image", uri: "lark:oc_demo_team/img_demo.png", title: "img_demo.png", text: "截图：退款明细" });
upsertSource(app, { spaceId: "refund", kind: "chat", uri: "lark:oc_demo_alert", title: "订单告警通知", text: "[10-29 03:00] 机器人: 退款接口 P99 超过 800ms", meta: { chatId: "oc_demo_alert", chatMode: "group" } });
upsertSource(app, { spaceId: "refund", kind: "chat", uri: "lark:oc_demo_dm", title: "与 小王 的私聊", text: "[10-22 15:00] 小王: 接口今天能联调", meta: { chatId: "oc_demo_dm", chatMode: "p2p" } });
upsertSource(app, { spaceId: "refund", kind: "web", uri: "https://example.com/payments/refund-rounding", title: "退款金额的尾差处理", text: "尾差归最后一行是常见做法。", meta: { url: "https://example.com/payments/refund-rounding" } });
upsertSource(app, { spaceId: "refund", kind: "meeting", uri: "lark:minutes:demo_weekly", title: "妙记：退款改造周会", text: "阿青：周四上线。", meta: { date: "2026-10-23" } });
// A repository under the project: a folder of its catalog tree on the sources page.
mkdirSync(join(home, "refund-web"));
createSpace(app, { id: "refund-web", name: "退款前端", kind: "repo", rootPath: join(home, "refund-web"), parentId: "refund" });
for (const uri of ["src/pages/RefundApply.vue", "src/pages/RefundRecords.vue", "src/api/refund.ts"]) upsertSource(app, { spaceId: "refund-web", kind: "code", uri, title: uri, text: `// ${uri}\nexport default {};\n` });
setNodeLevel(app, "refund", "chat:oc_demo_alert", "ignore", "owner", { reason: "机器人通知" });
setNodeLevel(app, "refund", "wn:wn_old", "reference", "agent", { reason: "已被 2026 年的方案取代" });
setAttention(app, [kbPrd], "focus", "owner");
addSourceNote(app, { sourceId: kbOld, lineStart: 3, lineEnd: 3, kind: "outdated", note: "现在按已发货的行计算", ref: `src:${kbPrd}#L3-L3`, by: "agent" });

// ---- Wiki: one page drawing on several kinds of material ----------------------------------------
writePage(app, "shop", "refund/amount", {
  meta: { title: "退款金额怎么算", summary: "部分发货、优惠分摊和尾差的规则，以及它们在代码里的位置", kind: "concept", tags: ["退款"] },
  body: [
    "部分发货的订单申请退款时，**只退已发货的行**，未发货的行走取消流程（[需求第 7 行](src:" + prd + "#L7-L7)；产品在讨论群里也确认过：[未发货的走取消](src:" + chat + "#L5-L5)）。",
    "",
    "## 优惠怎么分",
    "",
    "订单级优惠按**各行实付金额的比例**分摊到行，分摊的尾差归最后一行，保证各行之和等于优惠总额（[需求第 8–9 行](src:" + prd + "#L8-L9)、[技术方案](src:" + tech + "#L4-L4)）。代码在 `refundLineAmounts` 里先把金额换成分再算（[refund.js 第 10–21 行](src:" + code + "#L10-L21)）。",
    "",
    "> 讨论里提过满减分摊出现过负数（[群聊](src:" + chat + "#L6-L6)），所以分摊结果为负时应当报错而不是退负数。",
    "",
    "## 精度",
    "",
    "金额最多两位小数，超出精度直接报错（[需求第 10 行](src:" + prd + "#L10-L10)），实现见 `toCents`（[refund.js 第 2–7 行](src:" + code + "#L2-L7)）。",
    "",
    "## 相关",
    "",
    "- [[refund/release]]：上线和回放对比的步骤",
  ].join("\n"),
}, { actor: "wiki-writer" });
writePage(app, "shop", "refund/release", { meta: { title: "退款改造上线步骤", kind: "howto" }, body: "上线前回放上月部分发货退款，对比新旧结果（[技术方案](src:" + tech + "#L6-L6)）。\n" }, { actor: "wiki-writer" });

// A nested folder tree (refund/cases/…), a folder with its own index page, a home page, and a page
// whose cited document changed after it was written (the "originals changed" notice).
const coupon = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/优惠券叠加规则.md", title: "优惠券叠加规则", text: "# 优惠券叠加规则\n\n同一订单最多叠加两张券。\n" }).id;
writePage(app, "shop", "index", { meta: { title: "示例商城 Wiki", summary: "退款改造相关的规则、流程和排查案例", kind: "index" }, body: "从 [[refund/index|退款改造]] 开始读；线上问题先看 [[refund/cases/partial-shipment-over-refund|排查案例]]。\n" }, { actor: "wiki-writer" });
writePage(app, "shop", "overview", { meta: { title: "项目概览", summary: "示例商城的模块和阅读路线", kind: "guide" }, body: "示例商城分订单、支付、退款三个模块；退款改造见 [[refund/amount]]。\n" }, { actor: "wiki-writer" });
writePage(app, "shop", "refund/index", { meta: { title: "退款改造", summary: "规则、上线和排查案例", kind: "index" }, body: "退款改造的规则在 [[refund/amount]]，上线步骤在 [[refund/release]]，历史问题按 [[refund/cases/partial-shipment-over-refund|案例]] 查。\n" }, { actor: "wiki-writer" });
writePage(app, "shop", "refund/cases/partial-shipment-over-refund", { meta: { title: "部分发货多退了钱", summary: "旧算法按整单金额退款，部分发货的订单会多退", kind: "case" }, body: "现象：部分发货的订单退款金额大于已发货金额。原因见 [[refund/amount]]（[群聊](src:" + chat + "#L1-L1)）。\n" }, { actor: "wiki-writer" });
writePage(app, "shop", "refund/cases/coupon-negative", { meta: { title: "满减分摊出现负数", summary: "尾差处理不当会让某一行分摊成负数", kind: "case" }, body: "满减分摊时最后一行承担尾差，优惠大于实付时会出现负数（[群聊](src:" + chat + "#L6-L6)）。\n" }, { actor: "wiki-writer" });
writePage(app, "shop", "ops/coupon-stacking", { meta: { title: "优惠券叠加限制", summary: "同一订单最多叠加几张券", kind: "reference" }, body: "同一订单最多叠加两张券（[规则文档](src:" + coupon + "#L3-L3)）。\n" }, { actor: "wiki-writer" });
upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/优惠券叠加规则.md", title: "优惠券叠加规则", text: "# 优惠券叠加规则\n\n同一订单最多叠加三张券，其中满减券最多一张。\n" });
upsertSource(app, { spaceId: "shop", kind: "doc", uri: "https://tenant.larkoffice.com/docx/DemoRefundPlan", title: "退款改造排期与分工（飞书文档）", meta: { wikiSpaceName: "示例商城", wikiPath: "项目文档 / 退款改造" }, text: [
  "# 排期与分工",
  "",
  "详细方案见[技术方案](https://tenant.larkoffice.com/docx/DemoTech?from=wiki)，**尾差分摊**的实现由小王负责。",
  "",
  "<table><thead><tr><th>阶段</th><th>负责人</th><th>说明</th></tr></thead><tbody>",
  "<tr><td>开发</td><td>小王</td><td>实现&nbsp;<b>分摊</b>与尾差处理，补单元测试</td></tr>",
  "<tr><td>回放</td><td>小李</td><td>回放上月 2000 笔部分发货退款并对比</td></tr>",
  "</tbody></table>",
].join("\n") });

// ---- memories and items -----------------------------------------------------------------------
const mem = [
  { kind: "decision", subject: "退款分摊", content: "订单级优惠按各行实付比例分摊，尾差归最后一行（产品阿青 10-21 确认）", sourceRefs: [`src:${chat}#L3-L3`], folder: "退款改造/规则" },
  { kind: "decision", subject: "未发货的行", content: "未发货的行走取消流程，不在退款里计算", sourceRefs: [`src:${chat}#L5-L5`], folder: "退款改造/规则" },
  { kind: "fact", subject: "金额精度", content: "退款金额最多两位小数，超出精度报错，不四舍五入", sourceRefs: [`src:${prd}#L10-L10`], folder: "退款改造/规则" },
  { kind: "person", subject: "小王", content: "小王负责退款接口和发货状态对接", sourceRefs: [`src:${chat}#L1-L1`], folder: "人物" },
  { kind: "preference", subject: "评审", content: "评审退款相关改动时先看金额精度和尾差处理", sourceRefs: [], folder: "工作习惯" },
] as const;
for (const m of mem) remember(app, { spaceId: m.kind === "preference" ? "personal" : "shop", kind: m.kind as never, subject: m.subject, content: m.content, sourceRefs: [...m.sourceRefs], folder: m.folder, createdBy: "agent" });
const item = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "退款改造周四上线", detail: "部分发货只退已发货行，优惠按比例分摊；上线前回放上月数据", priority: 1, sourceRefs: [`src:${prd}#L1-L14`] }, "agent");
const requirementPages = saveReqs(app, [
  { op: "add", key: "root", kind: "system", title: "示例商城" },
  { op: "add", key: "apply", parent: "$root", kind: "page", title: "退款申请页", body: "选择订单明细，按已发货行计算可退款金额。" },
  { op: "add", key: "records", parent: "$root", kind: "page", title: "退款记录页", body: "按申请时间查看退款进度与处理结果。" },
], { by: "user", label: "本人" }, { defaultSpace: "shop", canWrite: () => {}, canRead: () => {} }).keys;
addItemEvent(app, item.id, "note", "技术方案定稿：金额换算成分计算，尾差归最后一行", "agent", [`src:${tech}#L3-L4`]);
addItemEvent(app, item.id, "note", "交办编码完成第 1 轮，评审要求修改尾差和负数分摊", "agent");
upsertItem(app, undefined, { spaceId: "shop", kind: "waiting", title: "等小李确认满减券的分摊口径", waitingOn: "小李", priority: 2, sourceRefs: [`src:${chat}#L2-L2`] }, "agent");
upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "周五和小王对发货状态接口", priority: 2 }, "agent");

// ---- a question answered with sources ---------------------------------------------------------
const t = createThread(app, { channel: "web", spaceId: "shop", title: "退款金额现在怎么算？", userId: "owner" });
addMessage(app, t.id, "user", "部分发货的订单，退款金额现在怎么算？优惠券怎么处理？依据在哪？");
addMessage(app, t.id, "assistant", [
  "现在的规则（10-21 定的）：",
  "",
  "1. **只退已发货的行**，未发货的行走取消流程（[需求](src:" + prd + "#L7-L7)，[群聊确认](src:" + chat + "#L5-L5)）。",
  "2. **优惠按各行实付比例分摊**，尾差归最后一行（[需求](src:" + prd + "#L8-L9)，[阿青的回复](src:" + chat + "#L3-L3)）。",
  "3. 金额最多两位小数，超出直接报错（[需求](src:" + prd + "#L10-L10)）。",
  "",
  "代码里对应 `refundLineAmounts`（[refund.js 第 10–21 行](src:" + code + "#L10-L21)）。另外小李提过满减分摊出过负数（[群聊](src:" + chat + "#L6-L6)），这次的评审也把它列为要改的问题。",
].join("\n"));

// ---- a delegation with a multi-check review ---------------------------------------------------
const r = createRun(app, { kind: "code", spaceId: "shop", title: "退款按已发货行分摊订单优惠", input: { task: "按《退款改造需求》实现：只退已发货的行，订单优惠按实付比例分摊，尾差归最后一行，金额超两位小数报错；补测试。", repos: ["shop"], itemId: item.id } });
const wtPath = join(app.runsDir, r.id, "work", "shop");
mkdirSync(join(app.runsDir, r.id, "patches"), { recursive: true });
sh(repo, "worktree", "add", "-q", "-b", `omem/${r.id}`, wtPath, base);
writeFileSync(join(wtPath, "refund.js"), REFUND_AFTER);
writeFileSync(join(wtPath, "test.js"), `const assert = require("assert");\nconst { refundAmount, refundLineAmounts } = require("./refund");\n\n// 只退已发货的行\nassert.equal(refundAmount({ lines: [{ paid: 30, shipped: true }, { paid: 20, shipped: false }] }), 30);\n// 优惠按比例分摊，尾差归最后一行\nassert.deepEqual(refundLineAmounts({ couponDiscount: 10, lines: [{ paid: 30, shipped: true }, { paid: 20, shipped: true }, { paid: 10, shipped: true }] }), [2500, 1667, 833]);\n// 超过两位小数报错\nassert.throws(() => refundAmount({ lines: [{ paid: 12.345, shipped: true }] }));\n`);
writeFileSync(join(wtPath, "README.md"), "# 示例商城\n\n订单、退款与优惠。\n\n## 退款\n\n只退已发货的行；订单优惠按各行实付比例分摊，尾差归最后一行。\n");
sh(wtPath, "add", "-A");
const patch = git(wtPath, ["diff", "--cached", "--no-color", "HEAD"]).stdout;
writeFileSync(join(app.runsDir, r.id, "patches", "shop.patch"), patch);
const stat = sh(wtPath, "diff", "--cached", "--stat", "HEAD");
const checks = ["reviewer", "review-business", "review-arch", "review-history", "review-style"];
const points = [
  { id: "M1", title: "退款金额计算", status: "partial", requirement: "退款金额的计算规则（[需求](src:" + prd + "#L7-L10)）", implementation: "refund.js：先过滤、再分摊、按分计算", refs: [`src:${prd}#L7-L10`], locations: [] },
  { id: "M2", title: "验收与说明", status: "done", requirement: "验收用例和对外说明", implementation: "", refs: [], locations: [] },
  { id: "C1", parent: "M1", title: "只退已发货的行", status: "done", requirement: "退款只计算已发货的行；未发货的行走取消流程（[需求](src:" + prd + "#L7-L7)）", implementation: "refundLineAmounts 先按 shipped 过滤", refs: [`src:${prd}#L7-L7`], locations: [{ file: "refund.js", start: 10, end: 11 }] },
  { id: "C2", parent: "M1", title: "优惠按实付比例分摊", status: "done", requirement: "订单级优惠按各行实付金额比例分摊（[需求](src:" + prd + "#L8-L8)）", implementation: "按 amount / total 计算每行份额", refs: [`src:${prd}#L8-L8`], locations: [{ file: "refund.js", start: 13, end: 20 }] },
  { id: "C3", parent: "M1", title: "尾差归最后一行", status: "partial", requirement: "分摊的尾差归最后一行（[需求](src:" + prd + "#L9-L9)）", implementation: "最后一行取剩余额；分摊结果为负时没有处理", refs: [`src:${prd}#L9-L9`], locations: [{ file: "refund.js", start: 16, end: 19 }] },
  { id: "C4", parent: "M1", title: "金额精度两位小数", status: "partial", requirement: "超出精度直接报错，不四舍五入（[需求](src:" + prd + "#L10-L10)）", implementation: "toCents 用 Math.round，12.345 不会报错", refs: [`src:${prd}#L10-L10`], locations: [{ file: "refund.js", start: 2, end: 7 }] },
  { id: "C5", parent: "M2", title: "补测试与说明", status: "done", requirement: "验收用例（[需求](src:" + prd + "#L12-L14)）", implementation: "test.js 覆盖三条验收", refs: [], locations: [{ file: "test.js", start: 4, end: 9 }, { file: "README.md", start: 5, end: 7 }] },
];
setRunOutput(app, r.id, {
  worktrees: [{ space: "shop", path: wtPath, branch: `omem/${r.id}`, base, start: base, targetBranch: "main" }],
  repos: [{ space: "shop", diffStat: stat, diffBytes: patch.length, check: { command: "node test.js", code: 0, output: "3 个断言全部通过", ms: 412 } }],
  diffStat: stat,
  check: { command: "node test.js", code: 0, output: "3 个断言全部通过", ms: 412 },
  coderSummary: "已实现：只退已发货的行，优惠按实付比例分摊、尾差归最后一行；金额换算成分计算。test.js 覆盖需求里的三条验收，`node test.js` 通过。",
  coderAI: { profile: "codex", model: "gpt-6.1-sol", effort: "low" },
  reviewPlan: { tier: "full", tierName: "完整", checks, maxRounds: 3, reasons: ["按改动指标落在「完整」档（42 行、3 个文件、1 个仓库）", "改动涉及金额计算"], metrics: {}, lead: true },
  changePoints: { round: 1, points },
  verdict: "changes-requested",
  reviewStage: "done",
  reviewLead: { round: 1, verdict: "revise", by: "lead", summary: "规则主体实现正确；金额精度用了四舍五入，和需求“超出精度报错”不一致，分摊为负时没有保护，这两处要改。", changeRequest: "1. refund.js:2 toCents 对超过两位小数的金额报错，不要 Math.round\n2. refund.js:16 分摊结果为负时报错（满减分摊出过负数）", rerun: ["reviewer", "review-business"] },
});
const ai = { profile: "codex", model: "gpt-6.1-sol", effort: "low" };
const findings: Record<string, { severity: "blocker" | "major" | "minor" | "nit"; file?: string; line?: number; title: string; detail?: string; suggestion?: string; evidence?: string[] }[]> = {
  reviewer: [{ severity: "major", file: "refund.js", line: 6, title: "超过两位小数的金额被四舍五入而不是报错", detail: "toCents 用 Math.round，12.345 会变成 1235 分，需求要求直接报错。", suggestion: "比较 amount*100 是否为整数，不是就抛 RangeError", evidence: [`src:${prd}#L10-L10`] }],
  "review-business": [
    { severity: "major", file: "refund.js", line: 17, title: "满减分摊可能得到负的可退金额", detail: "某行实付小于分到的优惠时 amount - share 为负，讨论群里出现过这种情况。", suggestion: "分摊结果为负时报错，或把超出部分顺延到下一行", evidence: [`src:${chat}#L6-L6`] },
    { severity: "minor", title: "未发货的行没有提示走取消流程", detail: "全部未发货时返回空数组，调用方无法区分“没有可退”和“应走取消”。", evidence: [`src:${prd}#L7-L7`] },
  ],
  "review-arch": [],
  "review-history": [{ severity: "minor", file: "test.js", line: 7, title: "以前的满减负数问题没有回归测试", evidence: [`src:${chat}#L6-L6`] }],
  "review-style": [{ severity: "nit", file: "refund.js", line: 1, title: "注释可以写成函数说明" }],
};
for (const c of checks) {
  const list = findings[c];
  recordReview(app, { codeRunId: r.id, round: 1, check: c, tier: "full", verdict: list.some((f) => f.severity === "major") ? "changes_requested" : "approved", summary: list.length ? `发现 ${list.length} 个问题。${c === "review-business" ? "已对照需求逐条核对，规则 1、2 实现一致。" : ""}` : "没有发现问题。模块边界清楚，接口签名保持不变。", findings: list.map((f) => ({ detail: "", suggestion: "", evidence: [], confidence: "high", ...f })) as never, ai, ...(c === "review-business" ? { changePoints: points as never } : {}) });
}
// review-lead accepted the two serious ones.
for (const f of all<{ id: number; severity: string }>(app.db, "select f.id, f.severity from review_findings f join reviews r on r.id = f.review_id where r.code_run_id = ?", r.id))
  run(app.db, "update review_findings set state = ? where id = ?", f.severity === "major" ? "accepted" : f.severity === "nit" ? "rejected" : "open", f.id);
// What each check did, for the 活动 tab.
const tools: Record<string, string[]> = {
  reviewer: ["读原件 docs/退款改造需求.md", "find_symbol refundLineAmounts", "node test.js"],
  "review-business": ["读原件 docs/退款改造需求.md", "读原件 退款改造讨论群", "submit_change_points"],
  "review-arch": ["search 退款 接口", "读原件 refund.js"],
  "review-history": ["recall 满减 负数", "读原件 退款改造讨论群"],
  "review-style": ["读原件 AGENTS.md"],
};
// The coder first, then the review. The 上下文 card: how each agent got its instructions and the context its model calls carried (made-up figures).
const demoParts = (role: number, lessons: number) => ({ common: role > 800 ? 1950 : 1540, role, environment: 260, lessons: lessons * 40, lessonCount: lessons, skills: 60 });
const usage = (who: Record<string, string>, from: number, steps: number[]) => { let used = from; for (const s of steps) addRunEvent(app, r.id, "usage", { used: (used += s), size: 475000, ...who }); };
addRunEvent(app, r.id, "prompt", { via: "system", instructions: 3400, message: 620, parts: demoParts(910, 5), phase: "coder" });
usage({ phase: "coder" }, 33800, [1200, 4100, 2600, 5200, 3800, 900]);
addRunEvent(app, r.id, "status", { text: "独立评审中：「完整」档，功能、业务、架构、历史、规范" });
for (const c of checks) {
  tools[c].forEach((title, i) => {
    addRunEvent(app, r.id, "tool", { id: `${c}-${i}`, title, status: "completed", phase: "reviewer", check: c });
  });
  addRunEvent(app, r.id, "text", { text: findings[c].length ? `结论：需要修改。${findings[c][0].title}。` : "结论：通过。", phase: "reviewer", check: c });
}
addRunEvent(app, r.id, "tool", { id: "lead-0", title: "rule_review", status: "completed", phase: "lead" });
addRunEvent(app, r.id, "text", { text: "接受两个严重问题，驳回规范项的注释建议；下一轮只复审功能和业务。", phase: "lead" });
for (const c of checks) {
  addRunEvent(app, r.id, "prompt", { via: "system", instructions: 2900, message: 9800, parts: demoParts(c === "review-style" ? 1580 : 900, 3), phase: "reviewer", check: c });
  usage({ phase: "reviewer", check: c }, 41000, [2600, 3100, 1800]);
}
run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), r.id);

// ---- a rule -----------------------------------------------------------------------------------
const rule = saveRule(app, {
  name: "值班群 @ 我时先整理上下文",
  description: "值班群里有人 @ 我时，先读这条消息前后的讨论和相关文档，整理成问题、已知信息和建议的下一步，发给我确认后再回复。",
  enabled: true,
  trigger: { event: "message", once: "event", waitMinutes: 5, unless: ["owner-engaged", "answered"] },
  conditions: { all: [{ field: "chat.name", op: "contains", value: "值班" }, { field: "message.mentionsOwner", op: "is", value: true }] },
  judge: "code",
  actions: [{ type: "agent", spec: "assistant", task: "整理问题和下一步", reply: "draft", ownTopic: true, mergeReply: "separate" }],
} as never);

// A meeting rule with conditional confirmation; all bot and meeting data here is fictional.
app.config.lark.appId = "cli_demo_meeting";
app.config.lark.appSecretEnv = "OMEM_DEMO_UNUSED_SECRET";
run(app.db, "insert or replace into kv(key, value) values('lark_bot_name', '会议助手')");
const meetingRule = saveRule(app, {
  spaceId: "shop", name: "入会时按人数确认",
  description: "当我进入会议时，自动拉我的机器人进来，若人数大于等于 30 人，先发卡片问我，否则直接拉进来。",
  trigger: { event: "meeting" },
  actions: [{ type: "meeting-bot", confirm: { field: "meeting.participantCount", op: "gte", value: "30" } }],
});
for (const count of [29, 30]) run(app.db,
  "insert into lark_meetings(meeting_id, meeting_no, topic, status, participants, started_at, updated_at) values(?,?,?,?,?,?,?)",
  `demo-${count}`, "123456789", count === 29 ? "退款方案评审" : "商城项目同步", "seen",
  JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: `demo-${i}`, name: `参会人${i + 1}` }))), new Date().toISOString(), new Date().toISOString(),
);

// ---- a share link: what a Feishu answer cited, readable without omem ---------------------------
const investigation = upsertSource(app, { spaceId: "shop", kind: "work", uri: "work/investigations/partial-refund", title: "部分发货多退：排查记录", text: [
  "# 部分发货多退：排查记录",
  "调查时间：10-22，只读查询。",
  "",
  "## 回放结果",
  "| 订单 | 已发货行 | 旧算法退款 | 新算法退款 |",
  "| --- | --- | --- | --- |",
  "| 1001 | 2 / 3 | 300.00 | 200.00 |",
  "| 1002 | 1 / 2 | 99.90 | 49.95 |",
  "| 1003 | 3 / 3 | 120.00 | 120.00 |",
  "",
  "日志平台里这三单的查询：https://logs.example.com/search?q=refund_partial",
].join("\n") }).id;
run(app.db, "insert into runs(id, kind, space_id, status, title, created_at, user_id) values('r_share_demo', 'ask', 'shop', 'done', '部分发货为什么多退', ?, 'owner')", new Date().toISOString());
app.config.webUrl = "https://omem.example.com";
const shareAnswer = resolveCitationsNow(app, [[
  `部分发货的单子会多退，是旧算法按整单金额算的。回放了三单，两单多退，全发货的那单不受影响。[回放结果](src:${investigation}#L5-L9)`,
  `新算法只算已发货的行，金额先换成分再分摊。[实现](src:${code}#L10-L21) [需求](src:${prd}#L7-L9)`,
].join("\n\n")], { runId: "r_share_demo" })[0];
const shareToken = /#\/share\/([\w-]{43})/.exec(shareAnswer)![1];
app.config.webUrl = undefined;

// ---- an ask: the assistant needs a decision before it goes on ---------------------------------
const decide = createThread(app, { channel: "web", spaceId: "shop", title: "退款改造上线前的回放", userId: "owner" });
addMessage(app, decide.id, "user", "退款改造周四上线，上线前帮我把上月的部分发货退款回放一遍。");
addMessage(app, decide.id, "assistant", "上月部分发货的退款一共 2 134 笔，其中 37 笔用了满减券，按新的分摊方式有 3 笔会出现 0.01 元的尾差。全量回放大约要 40 分钟。");
createAsk(app, {
  runId: null, conversationId: decide.id, kind: "question",
  question: "满减券那 37 笔的分摊口径小李还没确认，回放要先用哪种口径？",
  options: [{ label: "按实付比例分摊（需求里的写法）" }, { label: "先跳过这 37 笔，等小李确认" }, { label: "两种都回放，结果对比给我" }],
});

// ---- plugins: the built-in English practice and a data-directory plugin on the default page ------
const journalDir = join(home, "plugins", "journal");
mkdirSync(join(journalDir, "agents"), { recursive: true });
writeFileSync(join(journalDir, "plugin.yaml"), [
  "id: journal", "name: 每日复盘", "description: 每天收工前回顾做了什么、卡在哪里、明天先做什么", "icon: notebook",
  "agents: [coach]", "tools: [recall, remember]", "page: { title: 每日复盘 }",
  "settings:", "  - { key: tone, label: 语气, type: select, options: [温和, 直接], default: 温和 }",
].join("\n"));
writeFileSync(join(journalDir, "agents", "coach.md"), "---\ndescription: 陪本人做每日复盘\n---\n\n每天收工前问本人今天做了什么、卡在哪里、明天先做什么，用表单收集，用图表看一周的节奏。\n");
// The example that takes part in flows (examples/plugins/stagekit: a signal, a job and a check, all on
// files in its data directory), and a plugin that only declares an AI backend (its command is fictional).
cpSync(new URL("../examples/plugins/stagekit", import.meta.url), join(home, "plugins", "stagekit"), { recursive: true });
mkdirSync(join(home, "plugins", "helperkit"), { recursive: true });
writeFileSync(join(home, "plugins", "helperkit", "plugin.yaml"), ["id: helperkit", "name: 本机助手示例", "description: 声明一个本机的 ACP 后端（演示，命令不存在）。", "backends:", "  - { id: helper, name: 本机助手, command: demo-acp, args: [serve], install: 安装 demo-acp 命令行 }"].join("\n"));
// 凭据 (examples/plugins/acmeauth): one local login that supplies a command line and an AI backend; the
// members log in to it further down. Members' own accounts need the sandbox, which the demo machine may
// not have (Windows, a Mac): their pages are shown as on a Linux machine with bubblewrap. No member's run
// is started in the demo, so nothing is actually sandboxed.
cpSync(new URL("../examples/plugins/acmeauth", import.meta.url), join(home, "plugins", "acmeauth"), { recursive: true });
setSandboxSupportForTests({ ok: true, bwrap: "bwrap" });
// 设置 → 插件: a linked plugin in development with two callbacks (one with a secret and a few deliveries, one
// still without), and a hand-made one whose code waits for trust. Both are fictional.
const eventhubDir = join(home, "dev", "eventhub");
mkdirSync(eventhubDir, { recursive: true });
writeFileSync(join(eventhubDir, "plugin.yaml"), ["id: eventhub", "name: 示例事件平台", "version: 0.3.0", "description: 示例事件平台的订阅事件推过来时马上处理，不用等轮询。", "icon: zap", "permissions: { write: true }"].join("\n"));
writeFileSync(join(eventhubDir, "server.mjs"), `export default function register(api) {
  api.tool({ name: "eventhub_events", description: "列出最近收到的事件", schema: api.z.object({}), async handler() { return "[]"; } });
  api.tool({ name: "eventhub_ack", description: "把一条事件标成已处理", write: true, schema: api.z.object({ id: api.z.string() }), async handler() { return "ok"; } });
  api.hook({ name: "updates", label: "订阅事件", ack: "first", rateLimit: { perMinute: 600, burst: 100 }, handle() {} });
  api.hook({ name: "alerts", label: "告警", handle() { return {}; } });
}
`);
await linkPlugin(app, eventhubDir);
const ticketDir = join(home, "plugins", "ticketsync");
mkdirSync(ticketDir, { recursive: true });
writeFileSync(join(ticketDir, "plugin.yaml"), ["id: ticketsync", "name: 示例工单同步", "description: 把示例工单系统里分给你的工单同步成事项。", "icon: inbox", "permissions: { write: true }"].join("\n"));
writeFileSync(join(ticketDir, "server.mjs"), "export default function register() {}\n");
await loadPlugins(app);
await trustPlugin(app, "stagekit", "isolated");
await trustPlugin(app, "helperkit", "isolated");
await trustPlugin(app, "acmeauth", "inprocess");
await trustPlugin(app, "eventhub", "inprocess");
{
  const secret = createHookSecret(app, "eventhub", "updates");
  checkHookSecret(app, "eventhub", "updates", secret);
  const at = Date.now();
  const delivery = (id: string, ago: number, status: string, extra: { error?: string; attempts?: number; durationMs?: number; key?: string } = {}) => run(app.db,
    "insert into plugin_hook_deliveries(id,plugin,name,key,received_at,status,format,attempts,duration_ms,error) values(?,?,?,?,?,?,?,?,?,?)",
    id, "eventhub", "updates", extra.key ?? null, at - ago, status, "webhook", extra.attempts ?? 1, extra.durationMs ?? null, extra.error ?? null);
  delivery("demo-d1", 3 * 3600_000, "done", { durationMs: 42, key: "evt-1001" });
  delivery("demo-d2", 2 * 3600_000, "done", { durationMs: 38, key: "evt-1002" });
  delivery("demo-d3", 2 * 3600_000 - 60_000, "duplicate", { attempts: 0, key: "evt-1002" });
  delivery("demo-d4", 40 * 60_000, "failed", { attempts: 3, durationMs: 15_020, error: "签名不对：X-Signature 和正文对不上", key: "evt-1003" });
}
// A second, optional kind from a fictional plugin: a code host's command line, logged in on a page with a
// code (a login shows its link and code for about 8 seconds, then completes).
const demoWait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
registerCredential("codehub", {
  id: "token", name: "示例代码托管", describe: "代码托管的命令行登录：查合并请求、流水线和评审意见。",
  provides: { commands: [{ name: "hub-demo", state: [".config/hub-demo"], readOnly: [{ subcommand: ["pr", "list"] }] }] },
  async login(ctx, show) {
    show({ url: "https://code.example.com/login/device", code: "DEMO-4821" });
    await demoWait(8000, ctx.signal);
    await ctx.secret.set(`demo-${ctx.userId}`);
    return { user: `${ctx.userId}@example.com`, expiresAt: Date.now() + 30 * 86400_000 };
  },
  async logout() {},
}, () => ({}), app);
const pluginTurn = async (plugin: string, agent: string, spaceId: string, title: string, runId = `r_${plugin}_demo`) => {
  const { id: conversationId } = await createSession(app, { plugin, agent, spaceId, userId: "owner", title });
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at,lane) values(?,?,?,?,?,?,?,?)", runId, "ask", spaceId, "running", title, JSON.stringify({ conversationId }), new Date().toISOString(), conversationId);
  const spec = findAgentSpec(app, agent)!;
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId, spaces: [spaceId], tools: new Set(spec.tools), actor: "agent", spec: spec.name, plugin: spec.plugin }))!;
  const done = () => run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), runId);
  return { conversationId, runId, ctx, done };
};

// Two weeks of practice, so the side panel has levels, a curve and weak points.
const english = pluginStore(app, "english", "owner", "english");
const practice: [Attempt["skill"], Attempt["level"], string][] = [
  ["vocab", "A2", "word:receipt"], ["vocab", "B1", "phrase:on-the-house"], ["grammar", "B1", "grammar:would-like"], ["listening", "B1", "phrase:medium-rare"],
  ["translation", "B1", "word:allergic"], ["reading", "B1", "word:reservation"], ["grammar", "B2", "grammar:present-perfect"], ["vocab", "B1", "phrase:split-the-bill"],
];
for (let day = 13; day >= 0; day--) {
  const count = [12, 0, 16, 20, 8, 24, 18, 0, 22, 26, 14, 30, 24, 16][13 - day];
  for (let i = 0; i < count; i++) {
    const [skill, level, point] = practice[(i + day) % practice.length];
    const correct = (i * 7 + day * 3) % 10 >= (point === "phrase:medium-rare" || point === "grammar:present-perfect" ? 6 : 3);
    const a: Attempt = { block: `demo-${day}`, item: `q${i}`, type: "choice", skill, level, points: [point], prompt: "", given: "", expected: "", score: correct ? 1 : 0.3, correct, errorTags: correct ? [] : [skill === "grammar" ? "tense" : "spelling"], feedback: "", at: new Date(Date.now() - day * 86400_000 - (count - i) * 60_000).toISOString() };
    english.put("attempts", `demo-${day}:q${i}`, a);
    applyAttempt(english, a);
  }
}
// One set handed in and commented on, then the next one open.
const tutor = await pluginTurn("english", "english-tutor", "english", "餐厅点餐");
const englishEnv = getPlugin("english").env;
addMessage(app, tutor.conversationId, "user", "来一组餐厅点餐的题，侧重听力");
await callTool(tutor.ctx, "english_quiz", { title: "餐厅点餐 · 第 3 组", items: [
  { type: "choice", prompt: "服务员说 “It's on the house.”，意思是：", options: ["这道菜要另付钱", "这道菜免费", "这道菜在楼上"], answer: 1, skill: "vocab", level: "B1", points: ["phrase:on-the-house"], explanation: "on the house = 店家请客" },
  { type: "cloze", text: "Could we ___ the bill? I'll pay for the drinks.", answer: ["split"], skill: "vocab", level: "B1", points: ["phrase:split-the-bill"] },
  { type: "dictation", audio: { text: "I'd like my steak medium rare, please." }, skill: "listening", level: "B1", points: ["phrase:medium-rare"] },
  { type: "translate", direction: "zh-en", prompt: "我对花生过敏，这道菜里有吗？", reference: "I'm allergic to peanuts. Are there any in this dish?", skill: "translation", level: "B1", points: ["word:allergic"] },
] });
const handedIn = one<{ id: string; data: string }>(app.db, "select id, data from plugin_blocks where conversation_id = ? order by created_at desc limit 1", tutor.conversationId)!;
const quizAnswers = { q1: 1, q2: "split", q3: "I like my steak medium rare please", q4: "I'm allergic to peanut. Does this dish have it?" };
const gradedQuiz = await englishEnv.def("quiz")!.grade!({ ...pluginContext(app, englishEnv, { userId: "owner", spaceId: "english", runId: null, actor: "user", conversationId: tutor.conversationId }), blockId: handedIn.id }, JSON.parse(handedIn.data), quizAnswers);
run(app.db, "update plugin_blocks set status = 'submitted', answers = ?, result = ?, submitted_at = ?, updated_at = ? where id = ?", JSON.stringify(quizAnswers), JSON.stringify(gradedQuiz.result ?? null), new Date().toISOString(), new Date().toISOString(), handedIn.id);
addMessage(app, tutor.conversationId, "user", gradedQuiz.message, null, { submission: handedIn.id });
await callTool(tutor.ctx, "english_grade", { block_id: handedIn.id, grades: [{ item_id: "q4", score: 0.8, feedback: "意思对了。peanuts 要用复数；“里面有吗”更自然的说法是 Are there any in this dish?", error_tags: ["plural"] }, { item_id: "q3", feedback: "I'd like 的 'd 很轻，听到 like 前面那一下停顿就是它" }] });
addMessage(app, tutor.conversationId, "assistant", "这组对了 3 题。听写里 **I'd like** 又听成了 I like，这是第三次了，下一组多放两道带 'd 的句子；翻译意思都对，注意 peanuts 用复数。题库里还有 18 道餐厅的题，点“下一组”就能接着做。", tutor.runId);
tutor.done();
// A speaking practice talked through (the transcript as the shell hands it in) and assessed by the tutor.
const talk = await pluginTurn("english", "english-tutor", "english", "口语 · 在咖啡店点单 · 2026/11/11", "r_english_talk");
const pageTool = (tool: string, args: unknown) => callTool({ app, runId: null, spaceId: "english", spaces: null, tools: new Set([tool]), actor: "user", userId: "owner", plugin: "english" }, tool, args);
const talkBlock = (JSON.parse((await pageTool("english_speaking_start", { session_id: talk.conversationId, scene: "在咖啡店点单", goal: "用 Could I get… / I'd like… 点单" })).text) as { blockId: string }).blockId;
const talkAnswers = {
  transcript: [
    { role: "assistant", text: "Hi there! What can I get for you today?" },
    { role: "user", text: "I want a latte, oat milk, and less ice." },
    { role: "assistant", text: "Sure, an oat milk latte. Hot or iced?" },
    { role: "user", text: "Iced. 少冰怎么说？" },
    { role: "assistant", text: "少冰 is “light ice”. So, an iced oat latte with light ice?" },
    { role: "user", text: "Yes, light ice please. And can I pay by phone?" },
    { role: "assistant", text: "Of course, just tap your phone here." },
  ],
  startedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  endedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  model: "gpt-live-1",
};
const talkData = JSON.parse(one<{ data: string }>(app.db, "select data from plugin_blocks where id = ?", talkBlock)!.data);
const talked = await englishEnv.def("speaking")!.grade!({ ...pluginContext(app, englishEnv, { userId: "owner", spaceId: "english", runId: null, actor: "user", conversationId: talk.conversationId }), blockId: talkBlock }, talkData, talkAnswers);
run(app.db, "update plugin_blocks set status = 'submitted', answers = ?, result = ?, submitted_at = ?, updated_at = ? where id = ?", JSON.stringify(talkAnswers), JSON.stringify(talked.result ?? null), new Date().toISOString(), new Date().toISOString(), talkBlock);
addMessage(app, talk.conversationId, "user", talked.message, null, { submission: talkBlock });
await callTool(talk.ctx, "english_speaking_grade", {
  block_id: talkBlock,
  level: "A2",
  scores: { fluency: 3, grammar: 3, vocab: 2, fit: 3 },
  review: [
    "**一句话结论**：能把单点完，意思都清楚；开口用 I want 显得生硬，点单的常用句型还没用上。",
    "",
    "**改一改**",
    "",
    "- I want a latte, oat milk, and less ice. → **Could I get an oat milk latte with light ice?**（点单用 Could I get… 更礼貌；“少冰”是 light ice，不说 less ice）",
    "- can I pay by phone? → **Can I pay with my phone?**（用手机付款是 pay with）",
    "",
    "**这次学到的说法**",
    "",
    "| 英文 | 中文 |",
    "| --- | --- |",
    "| light ice | 少冰 |",
    "| oat milk latte | 燕麦拿铁 |",
    "",
    "**下次练什么**：再点一次单，开口就用 Could I get…，再加一个要求（换杯型、加一份浓缩）。",
  ].join("\n"),
  points: [{ point: "phrase:light-ice", correct: false, error_tag: "word-choice" }, { point: "phrase:could-i-get", correct: false, error_tag: "word-choice" }, { point: "phrase:pay-with", correct: false, error_tag: "preposition" }],
});
addMessage(app, talk.conversationId, "assistant", "这次最该改的是开口那句：点单时用 **Could I get…**，比 I want 自然得多。再练一次时试着每句都用它开头。", talk.runId);
talk.done();

// A plugin with no page of its own: the agent asks with a form and shows a chart.
const journal = await pluginTurn("journal", "journal-coach", "personal", "10-30 复盘");
addMessage(app, journal.conversationId, "user", "今天收工了，复盘一下");
addMessage(app, journal.conversationId, "assistant", "先填一下今天的情况，我帮你排明天。下面是这周每天的专注时长：周三只有 2 小时，比计划少一半，那天下午被退款的线上问题打断了。", journal.runId);
await callTool(journal.ctx, "ask_user", { question: "今天", wait_seconds: 0, fields: [
  { id: "done", label: "做完了什么", type: "text", required: true },
  { id: "first", label: "明天先做", type: "choice", options: ["退款回放", "评审小王的分支", "写周报"] },
  { id: "energy", label: "精力", type: "scale" },
] });
await callTool(journal.ctx, "show", { components: [{ type: "chart", title: "这周每天的专注时长", unit: "小时", kind: "bar", labels: ["周一", "周二", "周三", "周四", "周五"], series: [{ name: "计划", values: [5, 5, 4, 5, 4] }, { name: "实际", values: [3.5, 4.5, 2, 4, 3] }] }] });
journal.done();

// A question with a form and a view under the reply that asked it (docs/v2/interactive-ui.md).
const rollout = createThread(app, { channel: "web", spaceId: "shop", title: "退款改造怎么上线", userId: "owner" });
addMessage(app, rollout.id, "user", "退款改造下周上线，比较一下两种上线方式，方案和规则让我一次定完。");
addMessage(app, rollout.id, "assistant", "按过去两周的退款数据比了一下，灰度影响的订单少得多。方式和三条退款规则请在下面一次定完。", "r_rollout_demo");
run(app.db, "insert into ui_views(id,run_id,conversation_id,user_id,title,components,created_at) values(?,?,?,?,?,?,?)", "uv_rollout_demo", "r_rollout_demo", rollout.id, "owner", "过去两周的退款", JSON.stringify([
  { type: "callout", tone: "info", title: "灰度 10% 影响的订单只有一次上线的十分之一", text: "回滚 5 分钟内完成，也不用客服提前准备话术。" },
  { type: "metric", items: [{ label: "退款单", value: 482, unit: "单", change: "+12%", note: "比上两周", spark: [30, 34, 29, 41, 38, 22, 19, 36, 40, 33, 45, 44, 25, 21] }, { label: "部分退款", value: 97, unit: "单", note: "占 20%" }, { label: "人工介入", value: 31, unit: "单", change: "-4", good: "down", note: "比上两周" }] },
  { type: "chart", title: "每天的退款单", kind: "line", labels: ["周一", "周二", "周三", "周四", "周五", "周六", "周日"], series: [{ name: "上周", values: [30, 34, 29, 41, 38, 22, 19] }, { name: "本周", values: [36, 40, 33, 45, 44, 25, 21] }] },
  { type: "table", title: "两种方式", columns: ["方式", "影响订单", "回滚用时（分钟）", "要客服配合"], rows: [["灰度 10%", 48, 5, "否"], ["一次上线", 482, 30, "是"]] },
]), new Date().toISOString());
createAsk(app, {
  runId: "r_rollout_demo", conversationId: rollout.id, kind: "question", question: "上线方式和退款规则请确认一下：",
  ui: { fields: [
    { id: "plan", label: "选哪种上线方式", type: "pick", required: true, items: [{ id: "gray", title: "先灰度 10%", summary: "按用户尾号放量，观察两天再全量", pros: ["出问题只影响少量订单", "回滚 5 分钟"], cons: ["全量要晚两天"] }, { id: "all", title: "一次上线", summary: "周一早上全量切换", pros: ["一次到位"], cons: ["回滚要 30 分钟", "要客服提前准备话术"] }] },
    { id: "start", label: "哪天开始", type: "date", required: true },
    { id: "rules", label: "逐条确认退款规则", type: "checklist", required: true, choices: ["通过", "不通过"], note: true, items: [{ id: "r1", title: "部分发货：只退已发货行的实付" }, { id: "r2", title: "优惠券按各行实付比例分摊，尾差放最后一行" }] },
  ] },
});

// An interactive page the agent wrote, inside a question.
const proto = createThread(app, { channel: "web", spaceId: "shop", title: "退款进度页怎么改", userId: "owner" });
addMessage(app, proto.id, "user", "退款进度页想改一下，给两个方案让我试。");
addMessage(app, proto.id, "assistant", "做了两个可以点的版本，切一下状态就能看到差别，试完在页面里选一个。", "r_proto_demo");
const page = savePage(app, { title: "退款进度的两种展示", runId: "r_proto_demo", conversationId: proto.id, userId: "owner", html: `<style>
.wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.opt{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--panel)}
h3{margin:0 0 6px;font:600 15px/1.4 var(--serif)} p{color:var(--muted);margin:0 0 10px}
.steps{display:flex;gap:6px;margin:8px 0}.step{flex:1;height:6px;border-radius:3px;background:var(--line)}.step.on{background:var(--accent)}
.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)}.row b{font-weight:600}
.tl{margin:0;padding-left:16px}.tl li{margin:4px 0}.tl li.on{color:var(--ink)}.tl li{color:var(--muted)}
</style>
<div class="wrap">
 <div class="opt"><h3>方案 A：进度条</h3><p>一眼看到走到哪一步</p><div class="steps"><span class="step on"></span><span class="step on"></span><span class="step"></span><span class="step"></span></div>
  <div class="row"><span>退款金额</span><b>¥128.50</b></div><div class="row"><span>预计到账</span><b>1–3 个工作日</b></div><p></p><button>选 A</button></div>
 <div class="opt"><h3>方案 B：时间线</h3><p>每一步的时间都列出来</p><ol class="tl"><li class="on">11-08 10:02 申请退款</li><li class="on">11-08 10:15 商家同意</li><li>原路退回中</li><li>到账</li></ol><button>选 B</button></div>
</div>
<p style="margin-top:10px">状态：<button>申请中</button> <button class="primary">已同意</button> <button>已到账</button></p>` });
createAsk(app, { runId: "r_proto_demo", conversationId: proto.id, kind: "question", question: "试一下两个版本，选一个：", ui: { view: [{ type: "page", id: page.id, title: "退款进度的两种展示" }] } });

// ---- designs: an own one waiting for the owner, someone else's assessed and checked against the branch
const ownDesign = createDesign(app, { spaceId: "shop", itemId: item.id, title: "退款金额改到订单行上算", origin: "own", sources: [`src:${prd}`], repos: ["shop"], userId: "owner" });
submitRevision(app, ownDesign.id, {
  facts: [
    { text: "退款申请页、售后详情和导出各自合计退款金额，部分发货时三处结果不一样", refs: [`src:${chat}#L1-L2`] },
    { text: "refundAmount 现在按订单所有行求和，不看发货状态", refs: [`src:${code}#L1-L6`] },
  ],
  gaps: ["需求说“运费按实际情况退”，没有说部分发货时怎么算：放进 D2 请你定"],
  decisions: [
    {
      kind: "change", title: "退款金额在订单行上算，页面不再自己合计", reqs: ["退款只算已发货行", "导出与页面一致"],
      fields: {
        behavior: { brief: "三个页面各算一遍 → 都调 refundAmount", table: { head: ["情况", "现在", "改后"], rows: [["部分发货", "按整单退", "只退已发货的行"], ["有订单优惠", "各页面自己分摊，尾差不一", "按实付比例分摊，尾差归最后一行"], ["导出", "按整单金额", "和页面一致"]] } },
        where: { brief: "refund.js 一处；页面只展示结果", text: "页面拿到的是每行可退金额，不再自己求和。" },
        callers: { brief: "退款申请页、售后详情、导出任务、对账报表" },
        migration: { brief: "已发起的退款单不重算，只影响新发起的退款" },
      },
      rejected: [{ text: "在网关里统一算", why: "网关拿不到发货状态，要多查一次订单服务" }],
    },
    {
      kind: "add", title: "运费按已发货行的金额比例退", reqs: ["部分发货可退运费"],
      fields: {
        entry: { brief: "退款申请页提交时，refundAmount 带上运费" },
        layer: { brief: "和行金额一起放在 refund.js，运费规则只在这里" },
        contract: { brief: "refundLineAmounts 多返回运费一项", code: "type RefundResult = {\n  lines: number[];      // 每行可退（分）\n  shipping: number;     // 可退运费（分）\n};\nfunction refundLineAmounts(order: Order): RefundResult;", lang: "ts" },
        reuse: { brief: "沿用按比例分摊、尾差归最后一行的做法" },
        behavior: { brief: "按情况决定退多少运费", table: { head: ["情况", "可退运费"], rows: [["全部发货", "全部运费"], ["部分发货", "按已发货行金额占比"], ["都没发货", "走取消流程，不在这里"]] } },
        excludes: { brief: "不处理运费险和包邮券" },
      },
      question: { text: "部分发货时运费怎么退？", options: ["按已发货行的金额比例", "按已发货的件数比例", "这次不退运费，全部发货后一起退"], recommended: 0 },
    },
    {
      kind: "remove", title: "删掉页面里的两份合计（约 80 行）", reqs: ["导出与页面一致"],
      fields: {
        removes: { brief: "售后详情和导出任务里各自的 sumRefund" },
        users: { brief: "全仓库只有这两处调用，搜索 sumRefund 没有别的结果" },
        fallback: { brief: "页面改为展示 refundAmount 的结果，界面不变" },
        cleanup: { brief: "导出任务的单元测试改用 refundAmount 的结果" },
      },
    },
  ],
}, { note: "第一版" });

const extDesign = createDesign(app, { spaceId: "shop", itemId: item.id, title: "退款改造技术方案", origin: "external", author: "小王", sources: [`src:${tech}`], repos: ["shop"], userId: "owner" });
submitRevision(app, extDesign.id, {
  facts: [
    { text: "对账报表读的是落库前的退款金额（report/daily.js 第 88 行），不经过 refundAmount", refs: [`src:${code}#L1-L6`] },
    { text: "满减分摊出过负数，讨论群里有记录", refs: [`src:${chat}#L6-L6`] },
  ],
  concerns: [
    { level: "risk", text: "方案没有写回滚：新算法上线后发现问题，已经按新口径退出去的单子怎么处理", where: ["技术方案 · 上线计划"] },
    { level: "question", text: "回放上月 2000 笔部分发货退款时，结果不一致的单子由谁看、看到什么程度算通过？" },
  ],
  decisions: [
    {
      kind: "change", title: "退款金额改由订单服务计算", reqs: ["退款只算已发货行"],
      fields: { behavior: { brief: "只退已发货的行，优惠按实付比例分摊" }, where: { brief: "订单服务的 refundAmount" } },
      concerns: [
        { level: "problem", text: "对账报表读的是落库前的金额，方案没有改它，上线后报表和实际退款会对不上", where: ["report/daily.js:88"], refs: [`src:${code}#L1-L6`] },
        { level: "question", text: "旧订单的退款记录要不要按新口径回填？" },
      ],
      files: ["shop/refund.js", "shop/report/daily.js"],
    },
    {
      kind: "add", title: "新增 refundLineAmounts 返回每行可退金额", reqs: ["导出与页面一致"],
      fields: {
        contract: { brief: "refundAmount 签名不变，新增按行的结果", code: "function refundAmount(order: Order): number;\nfunction refundLineAmounts(order: Order): number[]; // 分", lang: "ts" },
        behavior: { brief: "金额换算成分计算，尾差归最后一行" },
      },
      concerns: [{ level: "improve", text: "导出任务可以直接用 refundLineAmounts 的结果，不用再保留自己的合计，能少维护一份口径" }],
      files: ["shop/refund.js", "shop/test.js"],
    },
    {
      kind: "change", title: "金额超过两位小数时报错", reqs: ["金额精度两位小数"], stated: false,
      fields: { behavior: { brief: "需求要求超出精度直接报错，方案没有提" } },
      concerns: [{ level: "question", text: "文档没写超出两位小数怎么办；代码现在是四舍五入，和需求不一致，要问作者打算怎么处理" }],
    },
    {
      kind: "remove", title: "去掉页面里自己算的合计", reqs: [],
      fields: { removes: { brief: "售后详情的 sumRefund" } },
      concerns: [{ level: "risk", text: "导出任务里还有一份合计，方案只删了页面的，两处口径会继续不一致", where: ["export/refund.js:40"] }],
    },
  ],
  outside: ["shop/README.md"],
}, { note: "评估技术方案" });
// The branch came out: checked against the design (a second version with what the code did).
const ext1 = getDesign(app, extDesign.id).body;
ext1.decisions[0].after = { done: "partly", deviation: "方案说在订单服务算，实际在网关里又算了一遍：网关的结果只用来展示，但两处口径以后可能分开", simpler: "网关直接用订单服务返回的金额，不用再算" };
ext1.decisions[1].after = { done: "yes" };
ext1.decisions[3].after = { done: "no", deviation: "分支里没有删 sumRefund，页面仍在自己合计" };
submitRevision(app, extDesign.id, ext1, { note: "对照分支 feature/refund" });
const extConcern = getDesign(app, extDesign.id).body.decisions[1].concerns?.[0];
if (extConcern) setConcernState(app, extDesign.id, extConcern.id, { state: "resolved", note: "分支里导出任务已改用 refundLineAmounts", by: "owner" });
// A saved snapshot of the built-in delivery flow, with fictional evidence; no Agent is launched.
const deliveryRaw = readFileSync(new URL("../flows/library/delivery.yaml", import.meta.url), "utf8");
const delivery = parseFlow(deliveryRaw);
mkdirSync(join(app.libraryDir, "_flows"), { recursive: true });
writeFileSync(join(app.libraryDir, "_flows", "delivery.yaml"), deliveryRaw);
const flowItem = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "退款改造：评审通过，等我推送", detail: "需求和方案已经确认，编码评审通过。核对分支后由我推送。", priority: 1, sourceRefs: [`src:${prd}#L7-L10`] }, "user");
const flowAt = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();
const flowDesign = createDesign(app, { spaceId: "shop", itemId: flowItem.id, title: "退款按已发货行分摊：已确认方案", origin: "own", sources: [`src:${prd}`], repos: ["shop"], userId: "owner" });
submitRevision(app, flowDesign.id, getDesign(app, ownDesign.id).body, { note: "需求和金额规则已核对" });
const flowRevision = getDesign(app, flowDesign.id).revision;
run(app.db, "update designs set status='approved',feedback=? where id=?", JSON.stringify([{ revision: flowRevision, action: "approve", by: "owner", at: flowAt(18), note: "按这个方案实现" }]), flowDesign.id);
const flowRun = createRun(app, { kind: "code", spaceId: "shop", title: "退款改造：评审通过", input: { itemId: flowItem.id, repos: ["shop"], task: "按已确认方案实现退款行分摊并验证" } });
setRunOutput(app, flowRun.id, { verdict: "approved", reviewStage: "done", coderSummary: "只退已发货行，分摊尾差、负数和金额精度的测试已通过。", check: { command: "node test.js", code: 0, output: "退款回归断言全部通过" } });
run(app.db, "update runs set status='done',started_at=?,finished_at=? where id=?", flowAt(16), flowAt(12), flowRun.id);
await addMaterials(app, flowItem.id, [{ kind: "run", ref: flowRun.id }, { kind: "source", ref: prd }], "owner");
run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,updated_at,started_by) values(?,?,?,?,?,?)", flowItem.id, delivery.id, JSON.stringify(delivery), flowAt(28), flowAt(4), "owner");
for (const [i, d] of delivery.stages.entries()) {
  const finished = i < 3, active = d.id === "push";
  const evidence = d.id === "clarify" ? [`src:${prd}#L7-L10`] : d.id === "design" ? [`design:${flowDesign.id}`] : d.id === "code" ? [flowRun.id] : [];
  changeStage(app, flowItem.id, d.id, finished ? "done" : active ? "doing" : "pending", {
    attempt: finished || active ? 1 : 0, enteredAt: finished ? flowAt(28 - i * 6) : active ? flowAt(4) : null,
    doneAt: finished ? flowAt(24 - i * 6) : null, since: active ? flowAt(4) : flowAt(24 - i * 6),
    by: active ? "owner" : d.id === "code" ? `code-work:${flowRun.id}` : d.id === "design" ? `design:${flowDesign.id}` : null, waitingOn: active ? "owner" : null, evidence, control: active ? { question: "owner" } : {},
  }, { actor: finished ? "assistant" : "host" }, finished ? "已核验，依据见记录" : active ? "评审已通过，轮到你核对后推送" : "", evidence);
  // changeStage timestamps transitions at the current clock; this fixture represents earlier work.
  run(app.db, "update item_stages set entered_at=?,done_at=?,since=? where item_id=? and stage_id=?", finished ? flowAt(28 - i * 6) : active ? flowAt(4) : null, finished ? flowAt(24 - i * 6) : null, flowAt(active ? 4 : 24 - i * 6), flowItem.id, d.id);
  run(app.db, "update item_stage_log set at=? where item_id=? and stage_id=?", flowAt(active ? 4 : 24 - i * 6), flowItem.id, d.id);
}
// Its chain (items/chain.ts): the 退款申请页 node it is about, the confirmed design whose first decision names
// it, the delegation that implemented it (its review state and a passing test on that node), and a finding
// on the negative split that started the earlier delegation, still in review.
{
  await addMaterials(app, flowItem.id, [{ kind: "req", ref: requirementPages.apply }], "owner");
  run(app.db, "update designs set body = json_set(body, '$.decisions[0].reqs', json_array(?)), work_id = ? where id = ?", requirementPages.apply, flowRun.id, flowDesign.id);
  recordReqStatus(app, flowRun.id, 1, [{ req: requirementPages.apply, status: "done", implementation: "按已发货行计算可退金额" }]);
  recordTests(app, { runId: flowRun.id, workId: flowRun.id, spaceId: "shop", round: 1, by: "agent", tests: [{ req: requirementPages.apply, name: "只退已发货的行", file: "test.js", status: "passed" }, { req: requirementPages.apply, name: "尾差归最后一行", file: "test.js", status: "passed" }] });
  run(app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,round,work_id,created_at,updated_at) values(?,?,'defect',?,?,'[]','confirmed',1,?,?,?)",
    "sf_demo_negative", flowItem.id, "满减分摊到最后一行出现负数", "大额满减券、三行都已发货的订单申请退款，最后一行可退金额是负数。", r.id, flowAt(30), flowAt(30));
}

// ---- a long delegation (shots code-work-live, code-work-review): nine rounds, the stage review under way,
// thirty-odd tasks, about three hundred artifacts, five long notes from the owner and a change description
// whose decisions name feature points under two requirements of the same name.
let longWork = "";
{
  const { addTask, updateTask } = await import("../src/agents/code-tasks.ts");
  const { artifactInbox, collectInbox } = await import("../src/agents/artifacts.ts");
  const { crc32, deflateSync } = await import("node:zlib");
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const codex = { profile: "codex", model: "gpt-6.2-sol", effort: "high" };
  // A made-up page screenshot (a PNG drawn here): a header, a side list and a few blocks, different per seed.
  const shot = (seed: number) => {
    const w = 320, h = 200, px = Buffer.alloc((w * 4 + 1) * h);
    const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: number[]) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255; }
    };
    fill(0, 0, w, h, [248, 247, 244]);
    fill(0, 0, w, 22, [44, 52, 60]);
    fill(0, 22, 64, h, [236, 234, 228]);
    for (let i = 0; i < 4; i++) fill(80, 36 + i * 38, 300 - ((seed * 37 + i * 53) % 90), 60 + i * 38, [222, 220, 214]);
    fill(80 + ((seed * 29) % 120), 36 + ((seed * 13) % 4) * 38, 140 + ((seed * 29) % 120), 60 + ((seed * 13) % 4) * 38, [64, 120, 128]);
    fill(240, 176, 300, 192, seed % 3 ? [64, 120, 128] : [190, 96, 64]);
    const chunk = (type: string, data: Buffer) => { const b = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(b) >>> 0); return Buffer.concat([len, b, crc]); };
    const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
  };

  // The requirement: two modules of the same name (one moved over from an older page tree), feature points under the first.
  const reqs = saveReqs(app, [
    { op: "add", key: "m", kind: "module", title: "售后退款" },
    { op: "add", key: "m2", kind: "module", title: "售后退款" },
    { op: "add", key: "f1", parent: "$m", kind: "feature", title: "售后入口按商家权限展示" },
    { op: "add", key: "f2", parent: "$m", kind: "feature", title: "退款记录页显示分摊明细" },
    { op: "add", key: "f3", parent: "$m", kind: "feature", title: "导入旧订单后退款金额不变" },
  ], { by: "user", label: "本人" }, { defaultSpace: "shop", canWrite: () => {}, canRead: () => {} }).keys;
  const longItem = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "售后退款：入口权限和分摊明细", detail: "售后入口按商家权限展示，退款记录页显示每行分摊，导入旧订单后金额不变。", priority: 1 }, "user");
  await addMaterials(app, longItem.id, [{ kind: "req", ref: reqs.m }, { kind: "req", ref: reqs.m2 }], "owner");

  // The work branch, with real commits for the first three tasks (their changes open under their rows).
  const root = createRun(app, { kind: "code", spaceId: "shop", title: "售后入口按权限展示并补退款分摊明细", input: { task: "售后入口按商家权限展示；退款记录页显示每行的分摊明细；导入旧订单后退款金额不变。按功能分别提交，补回归用例和截图。", repos: ["shop"], itemId: longItem.id, taskMode: true } });
  const wt = join(app.runsDir, root.id, "work", "shop");
  sh(repo, "worktree", "add", "-q", "-b", "feat/after-sale", wt, base);
  const commit = (files: Record<string, string | Buffer>, message: string) => {
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(wt, path, ".."), { recursive: true }); writeFileSync(join(wt, path), text); }
    sh(wt, "add", "-A"); sh(wt, "commit", "-qm", message);
    return sh(wt, "rev-parse", "HEAD");
  };
  const c1 = commit({ "src/after-sale/entry.js": "// 售后入口：有售后权限的商家才显示\nexport function showAfterSale(merchant) {\n  return merchant.roles.includes(\"after-sale\") && !merchant.staffOnly;\n}\n" }, "售后入口按商家权限展示");
  const c2 = commit({ "src/refund/records.js": "// 退款记录页：每行的分摊明细\nexport function splitRows(refund) {\n  return refund.lines.map((line) => ({ name: line.name, paid: line.paid, share: line.share, refund: line.paid - line.share }));\n}\n", "refund.js": REFUND_AFTER }, "退款记录页显示分摊明细");
  // The third reached well beyond the plan: test data exports, screenshots and logs got committed with it.
  const extra: Record<string, string | Buffer> = {};
  for (const name of ["list", "detail", "filter", "export", "empty"]) extra[`src/after-sale/pages/${name}.js`] = `// 售后${name} 页\nexport default {};\n`;
  for (const name of ["lines", "share", "rounding"]) extra[`src/refund/import/${name}.js`] = `// 导入旧订单：${name}\nexport default {};\n`;
  for (let i = 1; i <= 6; i++) extra[`test/import/case-${i}.test.js`] = `// 导入旧订单回归 ${i}\n`;
  for (let i = 1; i <= 8; i++) extra[`.work/screens/import-${i}.png`] = shot(i);
  for (let i = 1; i <= 5; i++) { extra[`.work/exports/orders-${i}.ndjson`] = `{"order":"A10${i}","refund":12.5}\n`; extra[`.work/exports/orders-${i}.csv`] = "order,refund\nA101,12.5\n"; }
  for (const name of ["import", "replay", "build"]) extra[`.work/logs/${name}.log`] = `${name} ok\n`;
  const c3 = commit(extra, "导入旧订单后退款金额不变");

  // Nine rounds: the first failed, two were stopped, the ninth is in its stage review now.
  const rounds = [root];
  const span: [number, number][] = [[400, 372], [370, 362], [360, 330], [328, 250], [248, 214], [212, 180], [178, 170], [168, 112], [100, 0]];
  const status = ["failed", "cancelled", "done", "done", "done", "done", "cancelled", "done", "running"];
  const verdicts = ["continuing", null, "synced", "changes-requested", "continuing", "continuing", null, "continuing", null];
  const picks = ["", "T1、T2", "T3", "T4、T5、T6、T7、T8", "T9、T10、T11", "T12、T13、T17", "T18", "T19、T20、T21、T22", "T11、T12、T15、T16、T23、T24、T25、T26、T27"];
  for (let i = 1; i < 9; i++) rounds.push(createRun(app, { kind: "code", spaceId: "shop", title: `交办第 ${i + 1} 轮：修改项 ${picks[i]}`, input: { continueFrom: root.id, round: i + 1, taskMode: true, repos: ["shop"], itemId: longItem.id, task: `修改项 ${picks[i]}` } }));
  const worktrees = [{ space: "shop", path: wt, branch: "feat/after-sale", targetBranch: "feat/after-sale", base, start: base, cutFrom: "main", newBranch: true, commits: true }];
  setRunOutput(app, root.id, { worktrees });
  rounds.forEach((x, i) => {
    run(app.db, "update runs set status=?, created_at=?, started_at=?, finished_at=?, ai=? where id=?", status[i], ago(span[i][0]), ago(span[i][0]), status[i] === "running" ? null : ago(span[i][1]), JSON.stringify(codex), x.id);
    if (verdicts[i]) setRunOutput(app, x.id, { verdict: verdicts[i] });
  });
  // The chain every round keeps (code-chain.ts): the page and the review tab read the rounds from it.
  const chain = { askRunId: root.id, conversationId: "", larkKey: null, larkMessageId: null, round: 9, rounds: rounds.map((x) => x.id), lastCodeRunId: rounds[8].id, awaitingUser: false };
  for (const x of rounds) run(app.db, "update runs set output = json_set(coalesce(output, '{}'), '$.codeChain', json(?)) where id = ?", JSON.stringify(chain), x.id);
  const plan = (checks: string[], reasons: string[]) => ({ tier: "ai", tierName: "按改动定", checks, maxRounds: 10, lead: true, reasons, metrics: {} });
  const fourth = rounds[3], ninth = rounds[8];
  longWork = ninth.id;
  setRunOutput(app, fourth.id, { reviewStage: "done", reviewPlan: plan(["review-simplify", "review-business", "reviewer", "review-arch", "review-history"], ["这一段改了入口权限、退款记录和导入三块，业务和历史看规则，架构看权限放在哪一层。"]),
    reviewLead: { round: 4, verdict: "revise", by: "lead", summary: "入口权限少判断了员工号，导入旧订单的尾差和新算法不一致，这两处要改；注释和命名的问题记成以后再做。", changeRequest: "1. 售后入口排除员工号\n2. 导入旧订单时尾差归最后一行，和新算法一致", rerun: ["review-business"] } });

  // Thirty-one tasks: the split, fixes from the fourth round's review, and what came up later.
  const titles = [
    "售后入口按商家权限展示", "退款记录页显示每行分摊明细", "导入旧订单后退款金额不变", "退款申请页显示可退金额的计算说明", "售后列表按申请时间倒序",
    "售后详情补退款进度", "导出退款表加“分摊方式”一列", "部分发货订单补回放用例", "退款失败的提示改成可重试", "售后入口的埋点补上来源",
    "入口注释写清权限条件", "员工号不该看到售后入口", "两份入口判断收成一处", "权限常量换成具名常量", "导入旧订单时尾差归最后一行",
    "导入失败时保留原金额并提示", "退款记录页空状态", "分摊明细在窄屏换行", "售后详情的金额对齐", "退款申请页的错误码映射",
    "回放用例换成真实的部分发货订单", "导出任务读日志里的分摊方式", "切换商家后旧权限不串用", "售后入口在没有订单时也显示", "导入后刷新页面金额不变",
    "退款记录页翻页保留筛选", "售后入口的帮助链接", "退款申请页的金额输入限制两位小数", "退款失败重试只退一次", "检查没通过", "撤回提交了的被忽略文件",
  ];
  const verifier = ["review-business", "review-arch", "review-style", "reviewer", "review-history", "review-simplify"];
  const notes: Record<number, { at: number; by: string; kind: string; text: string }[]> = {};
  titles.forEach((title, i) => {
    const seq = i + 1;
    addTask(app, root.id, { title, doneWhen: `${title}；有回归用例，截图放在 T${seq}/ 下。`, kind: seq >= 11 && seq <= 16 ? "fix" : "build" }, seq >= 11 && seq <= 16 ? "review-lead" : "coder");
    const round = Math.min(7, Math.max(1, Math.ceil(seq / 3.6)));
    const inNinth = [11, 12, 15, 16, 23, 24, 25, 26, 27].includes(seq);
    const doneAt = inNinth ? 92 - ([11, 12, 15, 16, 23, 24, 25, 26, 27].indexOf(seq) * 6) : span[round][1] + 6;
    notes[seq] = [{ at: doneAt, by: "coder", kind: "coder", text: `提交了 T${seq}：${title}。改了对应页面和用例，本地跑过 \`node test.js\`，截图放在 T${seq}/ 下。` }];
    if (seq % 2 === 1 || inNinth) notes[seq].push({ at: doneAt - 3, by: verifier[seq % verifier.length], kind: "verify", text: seq === 11 ? "问题撤回：重新看过，入口的注释已经写清三个条件，不需要再改。" : seq === 24 ? "没改好：切回旧商家后入口还按上一个商家的权限显示，缓存要按商家 id 分开。" : `验证通过：对照 T${seq} 的完成标准和截图逐条核对，行为一致。` });
  });
  // T13, T14 put off; T21 dropped; the rest done.
  const later = new Set([13, 14]);
  const commits: Record<number, string[]> = { 1: [c1], 2: [c2], 3: [c3] };
  for (const [seq, list] of Object.entries(notes)) {
    const n = Number(seq);
    run(app.db, "update code_tasks set state=?, origin=?, verifier=?, commits=?, notes=?, checkpoint=?, attempts=? where work_id=? and seq=?",
      later.has(n) ? "wontdo" : n === 21 ? "wontdo" : "done", JSON.stringify(later.has(n) ? { later: true } : n >= 11 && n <= 16 ? { findings: [] } : {}), verifier[n % verifier.length],
      JSON.stringify(commits[n] ? { shop: commits[n] } : {}), JSON.stringify(list.map((x) => ({ at: ago(x.at), by: x.by, kind: x.kind, text: x.text }))), Math.min(9, Math.ceil(n / 3.5)), n === 24 ? 1 : 0, root.id, n);
  }
  for (let cp = 1; cp <= 9; cp++) run(app.db, "insert into code_checkpoints(work_id, seq, heads, tasks, by, label, created_at) values(?,?,?,?,?,?,?)", root.id, cp, JSON.stringify({ shop: c3 }), "[]", "host", `完成 ${picks[cp - 1] || "T1"}`, ago(span[cp - 1][1]));

  // The fourth round's review: its problems became T11–T16.
  const f4: Record<string, { severity: "major" | "minor" | "nit"; title: string; task: number }[]> = {
    "review-business": [{ severity: "major", title: "员工号也能看到售后入口", task: 12 }, { severity: "major", title: "导入旧订单的尾差和新算法不一致", task: 15 }],
    "review-arch": [{ severity: "minor", title: "入口判断在页面和接口各写了一份", task: 13 }],
    "review-style": [{ severity: "minor", title: "入口注释没写清权限条件", task: 11 }, { severity: "nit", title: "权限用了裸数字", task: 14 }],
    "review-history": [{ severity: "minor", title: "导入失败时金额被清空，以前出过同样的问题", task: 16 }],
    "review-simplify": [],
  };
  for (const [check, list] of Object.entries(f4)) {
    recordReview(app, { codeRunId: fourth.id, round: 4, check, tier: "ai", verdict: list.some((f) => f.severity === "major") ? "changes_requested" : "approved", summary: list.length ? `提了 ${list.length} 个问题。` : "没有发现问题。", findings: list.map((f) => ({ severity: f.severity, title: f.title, detail: "", suggestion: "", evidence: [], confidence: "high" })) as never, ai: codex });
    for (const f of list) {
      const fid = one<{ id: number }>(app.db, "select f.id from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ? and f.title = ?", fourth.id, f.title)!.id;
      const tid = one<{ id: number }>(app.db, "select id from code_tasks where work_id = ? and seq = ?", root.id, f.task)!.id;
      run(app.db, "update review_findings set state = 'accepted', task_id = ? where id = ?", tid, fid);
    }
  }

  // The ninth round: coding with checks verifying beside it, the host's check, then the stage review under way.
  const checks9 = ["review-simplify", "review-business", "review-arch", "reviewer", "review-history"];
  const ev: [number, string, Record<string, unknown>][] = [[100, "prompt", { phase: "coder", via: "resumed", message: 2_400 }]];
  for (let i = 0; i < 60; i++) ev.push([99 - i, "tool", { phase: "coder", id: `c${i}`, title: ["读文件 src/after-sale/entry.js", "改文件 src/refund/records.js", "运行 node test.js", "搜索 showAfterSale", "读原件 退款改造需求"][i % 5], status: "completed" }]);
  ev.push([88, "status", { text: "规范验证 T11（编码 Agent 接着做别的项）" }], [87, "status", { phase: "reviewer", check: "review-style", verify: true, text: "使用 AI：codex · gpt-6.2-sol · high" }]);
  for (let i = 0; i < 6; i++) ev.push([86 - i, "tool", { phase: "reviewer", check: "review-style", verify: true, id: `v${i}`, title: "读文件 src/after-sale/entry.js", status: "completed" }]);
  ev.push([70, "status", { text: "业务（复看）验证 T23、T24、T25（编码 Agent 接着做别的项）" }], [64, "status", { text: "本人补充：切换商家后入口要按新商家的权限显示（编码已结束，下一轮带上）" }]);
  ev.push([58, "text", { phase: "coder", text: "T24 的缓存改成按商家 id 分开，切换商家时清掉上一个商家的入口权限；补了切换商家的回归用例。" }]);
  for (let i = 0; i < 12; i++) ev.push([98 - i * 5, "usage", { phase: "coder", used: 38_000 + i * 9_500, size: 272_000 }]);
  ev.push([40, "status", { text: "运行检查：node test.js" }]);
  const log = Array.from({ length: 160 }, (_, i) => `✓ 售后与退款回归 ${i + 1}：${titles[i % titles.length]}`).join("\n");
  ev.push([35, "check", { command: "node test.js", code: 0, ms: 284_000, output: `${log}\n\n160 个用例全部通过`, space: "shop" }], [35, "status", { text: "检查点 9：完成 T12、T15、T16、T23、T24、T26、T27" }]);
  ev.push([34, "status", { text: "评审负责人决定这次评审看什么" }], [34, "session", { phase: "lead" }], [32, "status", { text: "阶段评审：review-simplify、review-business、review-arch、reviewer、review-history（这一段看入口权限能否收成一处，再核对导入旧订单的金额和切换商家）" }]);
  checks9.forEach((c, k) => {
    ev.push([31, "status", { phase: "reviewer", check: c, text: `开始评审：${c}` }], [31, "status", { phase: "reviewer", check: c, text: "使用 AI：codex · gpt-6.2-sol · high（本人指定）" }]);
    for (let i = 0; i < 8 + k * 3; i++) ev.push([30 - i, "tool", { phase: "reviewer", check: c, id: `${c}-${i}`, title: ["读文件 src/after-sale/entry.js", "find_symbol showAfterSale", "读原件 退款改造需求", "运行 node test.js"][i % 4], status: i === 7 + k * 3 && k > 1 ? "in_progress" : "completed" }]);
  });
  ev.sort((a, b) => b[0] - a[0]);
  for (const [min, type, data] of ev) {
    const seq = addRunEvent(app, ninth.id, type, data);
    if (seq != null) run(app.db, "update run_events set at = ? where run_id = ? and seq = ?", ago(min), ninth.id, seq);
  }
  recordReview(app, { codeRunId: ninth.id, round: 9, check: "review-simplify", tier: "ai", verdict: "approved", summary: "入口判断已经收成一处；两处小的重复可以以后再收。", findings: [{ severity: "minor", title: "导入的金额换算和 refund.js 各有一份 toCents", detail: "", suggestion: "", evidence: [], confidence: "medium" }, { severity: "minor", title: "售后页面的空状态写了三遍", detail: "", suggestion: "", evidence: [], confidence: "medium" }] as never, ai: codex });
  recordReview(app, { codeRunId: ninth.id, round: 9, check: "review-business", tier: "ai", verdict: "changes_requested", summary: "切换商家后入口权限已经分开；但导入旧订单时运费没有按已发货行分摊。", findings: [{ severity: "major", file: "src/refund/import/share.js", line: 12, title: "导入旧订单时运费没有按已发货行分摊", detail: "", suggestion: "", evidence: [], confidence: "high" }] as never, ai: codex });
  const steer = (min: number, text: string) => ({ id: `note_demo_${min}`, at: ago(min), deliveredAt: ago(min - 1), by: "owner", text });
  setRunOutput(app, ninth.id, {
    worktrees, reviewStage: "checks", reviewHeads: { shop: c3 },
    reviewPlan: plan(checks9, ["这一段先看入口权限能否收成一处，再核对导入旧订单的金额和切换商家；规范这次不单派，注释的问题由精简一起看。"]),
    coderSummary: "这一轮改完了 T12、T15、T16、T23–T27：员工号看不到售后入口，导入旧订单时尾差归最后一行，切换商家后入口按新商家的权限显示。`node test.js` 160 个用例通过，截图在各项的 T<编号>/ 下。",
    check: { command: "node test.js", code: 0, output: "160 个用例全部通过", ms: 284_000 },
    notes: [
      steer(96, "**以这一条为准**：售后入口的权限只看商家角色和员工号两项，不再看灰度名单。\n\n1. 员工号一律不显示入口；\n2. 有售后角色的商家显示，没有的不显示；\n3. 灰度名单相关的判断和用例都删掉。\n\n改完在 T12 下放一张员工号登录后的截图。"),
      steer(90, "导入旧订单的金额：\n\n- 尾差归最后一行，和新算法一致；\n- 导入失败时保留原金额，页面提示“导入没完成，金额是原来的”；\n- 不要为导入单独写一份 toCents。\n\n回放用例用上月那 5 笔部分发货的订单。"),
      steer(76, "切换商家后入口还按上一个商家的权限显示，这是缓存没按商家分开。按商家 id 分开缓存，切换时清掉；补一个切换商家的回归用例。"),
      steer(66, "退款记录页的分摊明细在手机上挤成一行了：窄屏时每行的金额换到名字下面。截图放 T18。"),
      steer(52, "这一轮做完就停下来等我看，不要自动开下一轮。推送之前我要先在测试环境点一遍：\n\n1. 员工号登录；\n2. 有售后角色的商家登录；\n3. 导入一笔旧订单再刷新。"),
    ],
  });
  run(app.db, "update runs set input = json_set(input, '$.roundReview', json(?)) where id = ?", JSON.stringify({ ais: Object.fromEntries(checks9.map((c) => [c, codex])) }), ninth.id);

  // About three hundred artifacts: per task a few screenshots and a report now and then, and many logs, scripts and exports.
  for (let seq = 1; seq <= 27; seq++) {
    const dir = join(artifactInbox(app, ninth.id), `T${seq}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `${titles[seq - 1].slice(0, 8)}-${["修改前", "修改后", "窄屏"][i - 1]}.png`), shot(seq * 3 + i));
    if (seq % 4 === 0) writeFileSync(join(dir, "复验说明.md"), `# T${seq} 复验\n\n- 完成标准逐条核对\n- 截图见同目录\n`);
    for (const name of ["单元测试", "回放", "构建", "lint", "全量回归", "定向用例"]) writeFileSync(join(dir, `${name}.log`), `${name}：通过\n`);
    writeFileSync(join(dir, "验收脚本.mjs"), "// 打开页面、截图\n");
    writeFileSync(join(dir, "接口回放.json"), "{\"ok\":true}\n");
    await collectInbox(app, ninth.id, { source: "agent", by: "coder" });
  }

  // The change description written after the code: three decisions on the feature points, the rest outside it.
  const desc = createDesign(app, { spaceId: "shop", itemId: longItem.id, title: "售后入口和退款分摊明细：变更说明", origin: "derived", repos: ["shop"], workId: root.id, userId: "owner" });
  submitRevision(app, desc.id, {
    facts: [],
    decisions: [
      { kind: "change", title: "售后入口只看商家角色和员工号", reqs: [reqs.f1], tasks: [1], fields: { behavior: { brief: "有售后角色、不是员工号才显示入口" }, where: { brief: "src/after-sale/entry.js 一处" } } },
      { kind: "add", title: "退款记录页列出每行分摊", reqs: [reqs.f2, reqs.f1], tasks: [2], fields: { entry: { brief: "退款记录页" }, behavior: { brief: "每行显示实付、分到的优惠和可退" } } },
      { kind: "change", title: "导入旧订单按新算法算尾差", reqs: [reqs.f3], fields: { behavior: { brief: "尾差归最后一行" } } },
    ],
  } as never, { note: "编码后整理" });
  run(app.db, "update designs set status = 'recorded' where id = ?", desc.id);
}

// ---- 流程里的插件 (examples/plugins/stagekit): a signal, a job and a check on one flow ---------------
// `local-check` waits for a marker file, then the plugin writes a check file, then the owner confirms.
// The job's version was enabled on its card; the check looks at the job's result and is mandatory.
// One item stops at the check (the `flow-stage-blocked` shot); another waits for the marker (live:
// write `ready` into plugin-data/stagekit/ready.txt under --serve and it moves on).
const hookFlowRaw = [
  "id: local-check", "name: 本机检查", "description: 等标记文件就绪，插件写检查文件，结果由我确认。", "stages:",
  "  - id: mark", "    name: 等待标记", "    by: wait", "    done: { signal: \"stagekit:mark\", with: { file: ready.txt } }",
  "  - id: write", "    name: 写检查文件", "    by: { runner: \"stagekit:write\", with: { verified: false } }", "    budget: { minutes: 1 }",
  "  - id: confirm", "    name: 确认结果", "    by: owner", "    gate: confirm",
].join("\n") + "\n";
await answerAsk(app, proposeFlow(app, hookFlowRaw, { actor: "owner", userId: "owner" }).id, { choice: 0, by: "owner" });
saveGateChecks(app, "local-check", [{ id: "stagekit:word", stages: ["write"], mandatory: true }]);
const hookFlow = parseFlow(hookFlowRaw);
const blockedItem = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "退款对账脚本：核对检查文件", detail: "对账脚本跑完后由插件写一份检查文件，我确认后再发给财务。", priority: 2 }, "user");
run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,updated_at,started_by) values(?,?,?,?,?,?)", blockedItem.id, hookFlow.id, JSON.stringify(hookFlow), flowAt(3), flowAt(1), "owner");
const hookRun = createRun(app, { kind: "flow-runner", spaceId: "shop", title: `${blockedItem.title} · 写检查文件`, input: { runner: "stagekit:write", itemId: blockedItem.id, stageId: "write", flowId: hookFlow.id, flowStartedAt: flowAt(3), round: 1, spaces: ["shop"] } });
setRunOutput(app, hookRun.id, { runnerResult: { ref: `proof-demo.txt`, status: "done", summary: "待复核：检查文件已创建", evidence: [{ text: `检查文件 proof-demo.txt` }] } });
run(app.db, "update runs set status='done',started_at=?,finished_at=? where id=?", flowAt(1.2), flowAt(1.1), hookRun.id);
const hookAsk = createAsk(app, { userId: "owner", runId: hookRun.id, question: "「写检查文件」被检查拦下，是否仍然通过？\n\nstagekit:word：结果缺少“已验证”", options: [{ label: "仍然通过" }, { label: "等处理" }], context: { handler: "flow-plugin-gate", itemId: blockedItem.id, stageId: "write", completion: "accepted", logId: 0 } });
const proofEvidence = [{ text: `检查文件 proof-demo.txt` }, { text: "对账脚本这次的运行", link: `#/runs/${hookRun.id}` }, { text: "需求里的对账口径", link: `src:${prd}#L7-L10` }];
for (const d of hookFlow.stages) {
  const done = d.id === "mark", blocked = d.id === "write";
  changeStage(app, blockedItem.id, d.id, done ? "done" : blocked ? "blocked" : "pending", {
    attempt: done || blocked ? 1 : 0, enteredAt: done ? flowAt(3) : blocked ? flowAt(1.2) : null, doneAt: done ? flowAt(1.3) : null,
    by: blocked ? hookRun.id : null, waitingOn: blocked ? "owner" : null, askId: blocked ? hookAsk.id : null, evidence: blocked ? [hookRun.id] : [],
    control: done ? { pluginEvidence: [{ text: "文件 ready.txt 的标记是 ready" }] } : blocked ? { runId: hookRun.id, reported: true, pluginEvidence: proofEvidence, gateReview: { summary: "待复核：检查文件已创建", refs: [hookRun.id], failed: [{ id: "stagekit:word", reason: "结果缺少“已验证”" }] } } : {},
  }, { actor: done ? "host" : "stagekit:write", runId: blocked ? hookRun.id : undefined }, done ? "文件里的标记是 ready 就算完成" : blocked ? "stagekit:word：结果缺少“已验证”" : "", []);
  // changeStage stamps the current clock; this fixture is an hour old.
  run(app.db, "update item_stages set entered_at=?,done_at=?,since=? where item_id=? and stage_id=?", done ? flowAt(3) : blocked ? flowAt(1.2) : null, done ? flowAt(1.3) : null, done ? flowAt(1.3) : blocked ? flowAt(1.1) : flowAt(3), blockedItem.id, d.id);
}
const waitingItem = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "退款对账脚本：等标记文件", detail: "标记文件写好以后流程自己往下走。", priority: 3 }, "user");
await startFlow(app, waitingItem.id, "local-check", { actor: "owner", userId: "owner" });

// ---- two work lines for the work page (#/, #/work/:id) -----------------------------------------
// 示例商城 · 退款改造: the requirement above (in its flow, waiting for the owner to push) with a defect
// under it, a few more work items, key changes of every kind and origin over three weeks, where it
// stands and two next steps; 客服工单提效: a smaller one. Times are relative to now.
const refundLine = await createLine(app, { name: "示例商城 · 退款改造", goal: "部分发货的订单只退已发货的行，满减按各行实付比例分摊，12 月初全量上线。\n上线前用上月的退款单回放一遍，申请页、售后详情和导出三处金额要一致。", sources: [prd, chat], spaceId: "shop" }, "owner");
const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86400_000 - hours * 3600_000).toISOString();
run(app.db, "update items set due_at = ?, created_at = ? where id = ?", new Date(Date.now() + 12 * 86400_000).toISOString(), ago(20), refundLine.id);
setParent(app, flowItem.id, refundLine.id);
const negDefect = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "缺陷：满减分摊到最后一行出现负数", detail: "大额满减券的订单，最后一行承担尾差时可退金额变成负数。", priority: 1, waitingOn: "小王" }, "user");
setParent(app, negDefect.id, flowItem.id);
const replay = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "上月退款单回放对账", dueAt: new Date(Date.now() + 5 * 86400_000).toISOString(), priority: 2 }, "user");
setParent(app, replay.id, refundLine.id);
const couponAsk = one<{ id: string }>(app.db, "select id from items where title = ?", "等小李确认满减券的分摊口径");
if (couponAsk) setParent(app, couponAsk.id, refundLine.id);
const exportFix = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "导出任务改用 refundLineAmounts", priority: 3 }, "user");
setParent(app, exportFix.id, refundLine.id);
upsertItem(app, exportFix.id, { status: "done" }, "user");
const qaChat = upsertSource(app, { spaceId: "shop", kind: "chat", uri: "lark:oc_demo_refund_qa", title: "退款改造测试群", text: "[11-18 10:00] 小李: 回放脚本在测试环境跑通了", meta: { chatId: "oc_demo_refund_qa", chatMode: "group" } }).id;
await addMaterials(app, refundLine.id, [{ kind: "source", ref: qaChat }], "owner");
// Messages per day in the two groups over the last two weeks (the 14-day activity of 人和群).
for (const [chatId, perDay] of [["oc_demo_refund", [3, 5, 2, 0, 0, 8, 12, 9, 4, 0, 1, 14, 18, 11]], ["oc_demo_refund_qa", [0, 0, 1, 2, 0, 0, 0, 3, 6, 2, 0, 0, 5, 7]]] as const) {
  perDay.forEach((n, i) => {
    for (let k = 0; k < n; k++) run(app.db, "insert into lark_messages(message_id,chat_id,sender_name,content,create_ms) values(?,?,?,?,?)", `om_demo_${chatId}_${i}_${k}`, chatId, "小王", "（演示消息）", Date.now() - (13 - i) * 86400_000 - (k + 1) * 600_000);
  });
}
const noteChange = (itemId: string, at: string, c: { type: ChangeType; summary: string; detail?: string; risk?: string; next?: string; refs?: string[]; origin: "follow" | "flow" | "metric" | "problem" | "owner" | "line"; status?: string }) => {
  const id = `ic_demo_${Math.abs([...c.summary].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))}`;
  run(app.db, "insert into item_changes(id,item_id,at,type,summary,detail,refs,run_id,status,updated_at,risk,next,origin) values(?,?,?,?,?,?,?,'',?,?,?,?,?)",
    id, itemId, at, c.type, c.summary, c.detail ?? null, JSON.stringify(c.refs ?? []), c.status ?? "noted", at, c.risk ?? null, c.next ?? null, c.origin);
  return id;
};
// The stage changes the flow fixture above wrote just now are told again below at their own times.
run(app.db, "delete from item_changes where item_id = ? and origin = 'flow'", flowItem.id);
noteChange(refundLine.id, ago(17, 3), { type: "scope", origin: "follow", summary: "退款范围收窄：未发货的行走取消流程，不在退款里算", detail: "产品在讨论群里确认，未发货的行由取消流程处理，退款只算已发货的行。", refs: [`src:${chat}#L5-L5`, `src:${prd}#L7-L7`] });
noteChange(refundLine.id, ago(13, 5), { type: "decision", origin: "follow", summary: "满减按各行实付比例分摊，尾差归最后一行", detail: "阿青在群里定的口径，和需求文档第 8 行一致。", refs: [`src:${chat}#L3-L3`, `src:${prd}#L8-L9`] });
noteChange(flowItem.id, ago(10, 2), { type: "stage", origin: "flow", summary: "「澄清需求」做完：三处退款金额的口径对齐了", refs: [`src:${prd}#L7-L10`] });
noteChange(refundLine.id, ago(7, 6), { type: "deadline", origin: "follow", summary: "全量上线从 11 月 28 日推到 12 月 2 日", detail: "回放上月数据要多两天准备测试账号。", risk: "再往后推会撞上 12 月的大促封板", next: "回放脚本本周内跑通", refs: [`src:${chat}#L2-L2`] });
// The same message noted first by the assistant in the owner's conversation, the date added by item-follow (items/changes.ts `added`).
run(app.db, "update item_changes set origin = 'owner', source_key = 'lark:om_demo_deadline', added = ? where item_id = ? and type = 'deadline'", JSON.stringify([{ origin: "follow", runId: null, at: ago(7, 5), fields: ["due", "summary"] }]), refundLine.id);
noteChange(refundLine.id, ago(4, 1), { type: "result", origin: "metric", summary: "测试环境退款错算率从 2.1% 降到 0.3%", detail: "按已发货行计算后，剩下的错算都来自满减分摊。" });
noteChange(negDefect.id, ago(2, 4), { type: "blocker", origin: "problem", summary: "满减分摊到最后一行出现负数", detail: "大额满减券的订单，最后一行承担尾差后可退金额为负。", risk: "这类订单上线后会退出负数金额", next: "小王改成超出部分顺延到前一行，再补回归用例", refs: [`src:${chat}#L6-L6`] });
noteChange(flowItem.id, ago(0, 4), { type: "stage", origin: "flow", summary: "编码评审通过，等你核对分支后推送", next: "核对分支，推送后进预发验收" });
noteChange(refundLine.id, ago(0, 2), { type: "resolved", origin: "follow", summary: "发货状态接口联调通过，之前的阻塞解除", refs: [`src:${chat}#L1-L1`] });
noteChange(refundLine.id, ago(0, 1), { type: "scope", origin: "follow", status: "asked", summary: "阿青提出：退款原因要加“仅退运费”", detail: "阿青在群里提出要在退款原因里加一项“仅退运费”，影响申请页和导出。", risk: "加进来会重开“编码”这一段", refs: [`src:${chat}#L4-L4`] });
run(app.db, "update items set now = ? where id = ?", JSON.stringify({
  text: "截至今天，按已发货行退款的编码评审已通过，等你核对后推送；满减分摊的负数缺陷已复现，小王在改；上月退款单回放排在推送之后。",
  people: [{ name: "小王", role: "负责后端，在改负数缺陷" }, { name: "阿青", role: "产品，定退款口径" }, { name: "小李", role: "测试，准备回放数据" }, { name: "老周", role: "客服，提问题" }],
  weeks: [
    { label: "本周", text: "编码评审通过，等你推送；复现了满减分摊的负数缺陷，发货状态接口联调通过。" },
    { label: "上周", text: "上线推到 12 月 2 日；测试环境错算率降到 0.3%，回放脚本开始准备。" },
    { label: "2 周前", text: "定下满减按实付比例分摊、尾差归最后一行；需求澄清做完。" },
    { label: "3 周前", text: "" },
  ],
  at: ago(0, 1), runId: null,
}), refundLine.id);
const nextAt = ago(0, 1);
for (const [i, n] of [
  { text: "推送前用上月 200 单回放一遍退款金额", kind: "test", why: "评审只跑了单元测试，三处金额口径是否一致要拿真实数据看", refs: [`src:${prd}#L10-L10`] },
  { text: "问小李满减券的分摊口径什么时候能定", kind: "ask", why: "口径没定，负数缺陷怎么改跟着它", refs: [`src:${chat}#L2-L2`] },
].entries()) run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,run_id,created_at,updated_at) values(?,?,?,?,?,?,'open',null,?,?)", `nx_demo_${i}`, refundLine.id, n.text, n.why, JSON.stringify(n.refs), n.kind, nextAt, nextAt);

const ticketLine = await createLine(app, { name: "客服工单提效", goal: "工单进来先自动分类，常见问题用话术库直接回，人工只处理剩下的。", spaceId: "shop" }, "owner");
run(app.db, "update items set created_at = ? where id = ?", ago(15), ticketLine.id);
for (const [title, status] of [["工单自动分类试点", "open"], ["客服话术库整理", "open"], ["工单分类的标签定义", "done"]] as const) {
  const t = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title, priority: 2 }, "user");
  setParent(app, t.id, ticketLine.id);
  if (status === "done") upsertItem(app, t.id, { status: "done" }, "user");
}
noteChange(ticketLine.id, ago(9, 2), { type: "decision", origin: "owner", summary: "先在退款类工单上试自动分类" });
noteChange(ticketLine.id, ago(5, 3), { type: "stage", origin: "follow", summary: "分类标签定好了：退款、物流、质量、其他" });
noteChange(ticketLine.id, ago(1, 2), { type: "result", origin: "metric", summary: "试点一周，退款类工单 76% 分对", detail: "错分的多是“物流太慢要退款”这类两头都沾的。" });
run(app.db, "update items set now = ? where id = ?", JSON.stringify({ text: "截至今天，自动分类在退款类工单上试了一周，分对 76%；话术库整理了一半。", people: [{ name: "小赵", role: "客服组长" }], weeks: [{ label: "本周", text: "试点一周，分对 76%。" }, { label: "上周", text: "定好分类标签。" }, { label: "2 周前", text: "决定先在退款类工单上试。" }, { label: "3 周前", text: "" }], at: ago(0, 3), runId: null }), ticketLine.id);
run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,run_id,created_at,updated_at) values(?,?,?,?,?,?,'open',null,?,?)", "nx_demo_t", ticketLine.id, "把错分的 40 单按原因归一下类", "看是标签定义的问题还是模型的问题", "[]", "data", nextAt, nextAt);
// 观察中 (items/lifecycle.ts): a line whose requirement shipped, watched until 9 days from now; one
// metric moved past its mark after the launch. Closing its requirement puts it into 观察 by itself; the
// dates are then set to the demo's own.
const invoiceLine = await createLine(app, { name: "示例商城 · 发票抬头改版", goal: "开票页可以保存多个抬头，下单时选一个，11 月中旬全量。", spaceId: "shop" }, "owner");
const invoiceReq = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "开票页保存多个抬头", priority: 2 }, "user");
setParent(app, invoiceReq.id, invoiceLine.id);
upsertItem(app, invoiceReq.id, { status: "done" }, "user");
run(app.db, "update items set created_at = ?, phase = 'watching', phase_since = ?, watch_until = ? where id = ?", ago(24), ago(5, 2), new Date(Date.now() + 9 * 86400_000).toISOString(), invoiceLine.id);
run(app.db, "delete from item_changes where item_id = ? and origin = 'line'", invoiceLine.id);
noteChange(invoiceLine.id, ago(12, 3), { type: "decision", origin: "follow", summary: "抬头最多存 10 个，下单时默认用上次那个" });
noteChange(invoiceLine.id, ago(5, 2), { type: "stage", origin: "line", summary: "进入观察：群里说 11 月 16 日已全量", detail: "观察 14 天：这期间关注照读它的群、指标照取，每天的现状只提上线后的事；没有新问题会自动结束。" });
noteChange(invoiceLine.id, ago(1, 5), { type: "result", origin: "metric", summary: "开票失败率从 0.8% 升到 1.3%", detail: "多出来的失败都是抬头里带了全角括号。" });
run(app.db, "update items set now = ? where id = ?", JSON.stringify({ text: "截至今天，多抬头 11 月 16 日全量；开票失败率略升，都是带全角括号的抬头，小王在看。", people: [{ name: "小王", role: "负责后端" }], weeks: [{ label: "本周", text: "失败率略升，查到是全角括号。" }, { label: "上周", text: "11 月 16 日全量。" }, { label: "2 周前", text: "定下最多存 10 个抬头。" }, { label: "3 周前", text: "" }], at: ago(0, 4), runId: null }), invoiceLine.id);
// 已结束: two lines that ended, one by itself with its closing summary, one the owner dropped last month.
const endedDemo = (title: string, goal: string, days: number, status: "done" | "cancelled", reason: string, outcome: string, summary: string | null) => {
  const l = upsertItem(app, undefined, { spaceId: "shop", kind: "line", title, detail: goal }, "user");
  const at = ago(days);
  run(app.db, "update items set status = ?, closed_at = ?, created_at = ?, updated_at = ?, now = ? where id = ?", status, at, ago(days + 35), at,
    summary ? JSON.stringify({ text: "截至结束，已全量，上线后没有新问题。", people: [], weeks: [], at, runId: null, summary, summaryAt: at }) : null, l.id);
  run(app.db, "insert into item_events(item_id,at,kind,text,source_refs,actor) values(?,?,'line-end',?,'[]',?)", l.id, at, `${reason}（${status === "done" ? "观察了 14 天" : "在进行中"}、下面 0 件没结）\n<!-- line-end ${JSON.stringify({ outcome })} -->`, outcome === "auto-ended" ? "agent" : "user");
  noteChange(l.id, at, { type: "resolved", origin: "line", summary: `结束：${reason.replace(/^[^：]*：/, "")}`, ...(summary ? { detail: summary } : {}) });
  return l;
};
endedDemo("示例商城 · 优惠券叠加规则", "满减券和店铺券可以叠加使用，10 月底全量。", 9, "done", "自动结束：观察了 14 天，没有新问题", "auto-ended",
  "满减券和店铺券可以叠加，先算满减再算店铺券，10 月 28 日全量。\n\n**关键决定**：叠加后最低实付 0.01 元，不倒贴；平台券暂不参与叠加。\n\n**上线后**：两周里叠加使用率 18%，退款错算和客诉都没有增加。\n\n**还剩**：平台券叠加放到明年一季度，由阿青提需求。");
endedDemo("客服 · 退款话术整理", "把常见的退款问题整理成话术，给新客服用。", 36, "cancelled", "本人放弃了这条线：并进了“客服工单提效”", "owner-cancelled", null);

// One the assistant made on its own and the owner has not said yes to.
const cand = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "跟进：退款原因的统计口径", priority: 3 }, "agent");
run(app.db, "update items set status = 'candidate' where id = ?", cand.id);
// A 关注 over the two refund groups that drafts replies (#/listen/:id, its settings in the owner's words).
const dutyListen = saveContext(app, {
  kind: "place", name: "退款问题答疑", chats: ["oc_demo_refund", "oc_demo_refund_qa"], spaceId: "shop", expiresAt: null,
  note: "有人报退款金额不对的，先按订单号查退款单和分摊明细再回；问上线时间的告诉我，不用回。",
  brief: { handle: ["报退款金额不对、带订单号或截图的", "测试同学问回放结果的"], skip: ["闲聊和表情", "产品讨论需求口径的"], valid: "查到了退款单或代码依据，说得出哪一行算错、为什么", at: ago(3), confirmedAt: ago(3) },
  knobs: { reply: "draft" },
});
// ---- 快速通道: probes, a rule that looks first, one first look's layers; a 情境 with its rounds --------
// Seeded only before the shots that show them (fastLane()), so the earlier pages keep their screenshots.
const FAST_RULE = "rule_demo_fast", DRILL = "ctx_demo_drill";
let fastLaneSeeded = false;
const seedFastLane = async () => void (await fastLane());
async function fastLane() {
if (fastLaneSeeded) return;
fastLaneSeeded = true;
saveProbe(app, { name: "refund-order", description: "按退款单号查状态、各行退款金额和分摊明细（只读副本）", match: "(?<refund>R\\d{4,})", runtime: "node", timeoutSec: 20, direct: false,
  code: [
    "// 正则捕获到的退款单号在 OMEM_CAPTURES；只读查询，输出给快模型看。",
    "const id = JSON.parse(process.env.OMEM_CAPTURES).refund;",
    "const res = await fetch(`http://127.0.0.1:8080/readonly/refunds/${id}`);",
    "if (!res.ok) { console.error(`查不到 ${id}：${res.status}`); process.exit(1); }",
    "const r = await res.json();",
    "console.log(`退款单 ${id}：${r.status}，共退 ${r.total} 元`);",
    "for (const line of r.lines) console.log(`- ${line.sku}：退 ${line.amount}（分摊优惠 ${line.discount}）`);",
  ].join("\n") }, "owner");
saveProbe(app, { name: "release-window", description: "今天是不是封版日、下一个发布窗口几点", runtime: "bash", timeoutSec: 10, direct: true,
  code: "#!/usr/bin/env bash\n# 发布日历是团队共享的只读文件\ngrep \"$(date +%F)\" ~/release-calendar.txt || echo \"今天不封版，下一个窗口：每天 14:00\"" }, "owner");
saveProbe(app, { name: "refund-alarm", description: "退款接口近 10 分钟的报错数和最多的错误码", match: "报错|失败|5\\d\\d", runtime: "python", timeoutSec: 30, direct: false,
  code: "import json, urllib.request\nwith urllib.request.urlopen('http://127.0.0.1:8080/readonly/refund-errors?minutes=10') as r:\n    data = json.load(r)\nprint(f\"近 10 分钟报错 {data['count']} 次，最多的是 {data['top']}\")" }, "owner", "proposal");
const probeRun = (probe: string, at: string, ok: boolean, stdout: string, ms: number) => {
  const pr = createRun(app, { kind: "probe", spaceId: "shop", title: `预查「${probe}」：R1005 退了 312 元，比应退多了 60`, input: { probe, runtime: "node", timeoutSec: 20, captures: probe === "refund-order" ? { refund: "R1005" } : {}, matched: "R1005 退了 312 元，比应退多了 60" } });
  setRunOutput(app, pr.id, { exitCode: ok ? 0 : 1, timedOut: false, ms, stdout, stderr: ok ? "" : "查不到 R1005：502" });
  run(app.db, "update runs set status = ?, created_at = ?, started_at = ?, finished_at = ? where id = ?", ok ? "done" : "failed", at, at, at, pr.id);
  return pr.id;
};
const lookProbe = probeRun("refund-order", ago(0, 2), true, "退款单 R1005：已退款，共退 312 元\n- SKU-88 衬衫：退 189.00（分摊优惠 21.00）\n- SKU-91 袜子：退 123.00（分摊优惠 39.00）", 840);
probeRun("refund-alarm", ago(1, 5), true, "近 10 分钟报错 3 次，最多的是 REFUND_AMOUNT_EXCEEDED", 1210);
const fastRule = saveRule(app, {
  id: FAST_RULE, name: "答疑群报退款金额不对时先查单",
  description: "退款答疑群里有人报退款金额不对并带了退款单号，先按单号查退款单和分摊明细，能答就直接答；答不了的再交给助手细查。",
  enabled: true, spaceId: "shop",
  trigger: { event: "message", once: "event", waitMinutes: 0, unless: ["owner-engaged"] },
  conditions: { all: [{ field: "chat.name", op: "contains", value: "退款答疑" }, { field: "message.text", op: "matches", value: "R\\d{4,}" }] },
  judge: "code",
  actions: [{ type: "agent", spec: "assistant", task: "看这张退款单金额对不对，说清哪一行、为什么", reply: "draft", ownTopic: true, mergeReply: "separate", firstLook: true, probes: ["refund-order"], firstTo: "ephemeral" }],
} as never);
const lookRun = createRun(app, { kind: "first-look", spaceId: "shop", title: "先看一眼：R1005 退了 312 元，比应退多了 60", input: { ruleId: fastRule.id, text: "R1005 退了 312 元，比应退多了 60，麻烦看下" } });
setRunOutput(app, lookRun.id, { outcome: "answered", answer: "R1005 按新口径算没有多退：衬衫和袜子按实付比例分摊了 60 元满减，两行合计 312 元，和退款单一致。用户看到的“多了 60”是把满减算回了原价。", stages: {
  prefilter: "规则条件已经筛过：退款答疑群、消息带退款单号",
  probes: { ms: 860, results: [{ name: "refund-order", ok: true, ms: 840, runId: lookProbe }] },
  look: { ms: 14200, outcome: "answered", by: "model", ai: { profile: "codex", model: "gpt-6.1-luna", effort: "low" } },
  decision: { taken: "yes", threshold: 0.7, said: "依据够：有分摊明细", probabilities: { yes: 0.86, no: 0.14 } },
  first: { at: ago(0, 2), to: "ephemeral", why: [] },
} });
run(app.db, "update runs set status = 'done', created_at = ?, started_at = ?, finished_at = ? where id = ?", ago(0, 2), ago(0, 2), ago(0, 2), lookRun.id);

// ---- a 持续跟进 rule: a weekly drill, with one follow-up going on and two ended ----------------------
const drill = saveContext(app, {
  id: DRILL, kind: "situation", name: "项目 A 例行演练", spaceId: "shop", spec: "assistant", status: "active",
  note: "演练开始后我在意的是：退款链路有没有被切走、回切后数据对不对得上。每一步卡住超过 15 分钟告诉我；结束时给我一份三行小结，写进演练记录表。",
  recognize: "项目 A 的演练群里有人发“演练开始”，或演练记录表新增了一行",
  knobs: { firstLook: true, probes: ["release-window"], firstTo: "dm" },
} as never);
saveRule(app, {
  id: `situation:${drill.id}`, name: drill.name, description: drill.recognize!, enabled: true,
  trigger: { event: "message", once: "event", waitMinutes: 0, unless: [] },
  conditions: { all: [{ field: "chat.name", op: "contains", value: "演练" }, { field: "sender.kind", op: "equals", value: "bot" }, { field: "message.text", op: "contains", value: "演练开始" }] },
  judge: "code", actions: [{ type: "context", context: drill.id }],
} as never, "user", "owner", { origin: { kind: "situation", contextId: drill.id, name: drill.name, manual: true } });
// Its firings: one a bot's card (its whole JSON, with a long link), the way real ones look.
const drillCard = JSON.stringify({ header: { title: "演练开始 · 项目 A 退款链路" }, elements: [{ tag: "div", text: "切换到备用退款通道，预计 40 分钟" }, { tag: "action", actions: [{ tag: "button", text: "打开演练记录表", url: "https://tenant.larkoffice.com/base/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?table=tbl0123456789abcdef&view=vew0123456789abcdef" }] }] });
recordFiring(app, { ruleId: `situation:${drill.id}`, eventKey: "lark:om_demo_drill_1", summary: `群「项目 A 演练群」里 演练机器人 发了卡片：${drillCard}`, judgedBy: "code", reason: "", results: [{ action: "context", ok: true, detail: "开始一次跟进 sit_demo_1" }] });
recordFiring(app, { ruleId: `situation:${drill.id}`, eventKey: "lark:om_demo_drill_2", summary: "群「项目 A 演练群」里 演练机器人：演练开始，回切排在 16:00", judgedBy: "code", reason: "", results: [{ action: "context", ok: true, detail: "并入正在进行的跟进 sit_demo_1" }] });
const drillRound = (about: string, started: string, until: string, current: string, ended?: { at: string; summary: string }) => {
  const title = `${drill.name}：${about}`;
  const it = upsertItem(app, undefined, { userId: "owner", spaceId: "shop", kind: "todo", title, detail: about, sourceRefs: [] }, "agent");
  const th = createThread(app, { userId: "owner", spaceId: "shop", channel: "listen", key: `sit_demo_${it.id}`, title, settings: { itemId: it.id } });
  const sid = `sit_demo_${it.id.slice(-8)}`;
  run(app.db, `insert into situation_instances(id,context_id,user_id,item_id,conversation_id,space_id,title,status,started_at,window_until,current,summary,ended_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, sid, drill.id, "owner", it.id, th.id, "shop", title, ended ? "ended" : "active", started, until, current, ended?.summary ?? null, ended?.at ?? null);
  if (ended) run(app.db, "update items set status = 'done', closed_at = ? where id = ?", ended.at, it.id);
  return it.id;
};
const drillItem = drillRound("11 月第 4 周，切到备用退款通道", ago(0, 1), new Date(Date.now() + 3 * 3600_000).toISOString(), "已切到备用通道 40 分钟，退款单正常；回切排在 16:00，小李在核对切换期间的 23 张单。");
drillRound("11 月第 3 周，切到备用退款通道", ago(7, 2), ago(7, -2), "已回切", { at: ago(7, -1), summary: "切换 52 分钟，回切后有 2 张单重复退款，小王已手工冲正；下次回切前先停自动重试。" });
drillRound("11 月第 2 周，只演练数据回放", ago(14, 3), ago(14, -1), "已结束", { at: ago(14, 0), summary: "回放 1,240 张单，金额全部对上；用时比上次少 20 分钟。" });
return { lookRun: lookRun.id, drillItem };
}

// 问这条线: one question already asked in the line's 关注 conversation (or a conversation of its own).
const lineChat = itemContext(app, refundLine.id)?.conversationId ?? createThread(app, { channel: "web", spaceId: "shop", title: "问这条线：示例商城 · 退款改造", userId: "owner" }).id;
addMessage(app, lineChat, "user", "现在卡在哪？");
addMessage(app, lineChat, "assistant", [
  "卡在两处：",
  "",
  "1. **推送等你**：编码评审已通过，分支在等你核对后推送；推送后才进预发验收。",
  "2. **满减分摊的负数缺陷**：大额满减券的订单最后一行会退成负数，小王在改成超出部分顺延到前一行（[群聊](src:" + chat + "#L6-L6)）。它的改法还取决于小李那边的分摊口径，口径没定前别合进推送的分支。",
  "",
  "上月退款单回放排在推送之后，脚本已在测试环境跑通。",
].join("\n"));
// The refund line is the one moved last: it comes first.
run(app.db, "update items set updated_at = ? where id = ?", ago(0, 6), ticketLine.id);

// ---- a month of runs for the data page (#/insights) -------------------------------------------
// Fictional counts only: who asked, in which demo chat, with which made-up model.
{
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const kinds: [string, number][] = [["ask", 9], ["agent", 4], ["code", 2], ["review", 2], ["brief", 1], ["heartbeat", 2], ["mention", 2], ["guest", 2], ["ingest", 6]];
  const bag = kinds.flatMap(([k, w]) => Array<string>(w).fill(k));
  const people = ["user:owner", "user:owner", "user:owner", "user:xiaowang", "user:xiaoli"];
  const chats = ["退款改造项目群", "示例商城值班群", "和小王的私聊", "网页"];
  const ais = [{ profile: "codex-acp", model: "model-a" }, { profile: "codex-acp", model: "model-b" }, { profile: "claude-acp", model: "model-c" }];
  const day0 = Date.now() - 29 * 86400_000;
  let k = 0;
  for (let d = 0; d < 30; d++) {
    // A working week: busier on weekdays, a little busier towards now.
    const weekday = new Date(day0 + d * 86400_000).getDay();
    const n = Math.round((weekday === 0 || weekday === 6 ? 3 : 9) * (0.7 + d / 60) + rnd() * 5);
    for (let j = 0; j < n; j++) {
      const kind = pick(bag);
      const at = day0 + d * 86400_000 + Math.floor((8 + rnd() * 11) * 3600_000);
      const took = kind === "code" ? 1200 + rnd() * 3600 : 20 + rnd() * 400;
      const status = rnd() < 0.06 ? "failed" : "done";
      const id = `r_demo_insight_${k++}`;
      const guest = kind === "guest";
      const output: Record<string, unknown> = guest ? { verdict: "answer" } : kind === "code" && rnd() < 0.7 ? { verdict: "approved", ...(rnd() < 0.7 ? { appliedAt: new Date(at + took * 1000 + 3600_000).toISOString() } : {}) } : kind === "mention" ? (rnd() < 0.5 ? { triage: { action: "handle" }, handleRun: `${id}_h` } : {}) : {};
      const quiet = kind === "mention" && !output.triage ? 1 : 0;
      run(app.db, "insert into runs(id,kind,space_id,status,title,input,output,trigger,trigger_by,user_id,ai,quiet,created_at,started_at,finished_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, kind, pick(["shop", "shop", "refund", "personal"]), status, "演示", JSON.stringify({}), JSON.stringify(output),
        JSON.stringify({ via: guest ? "guest" : "web", where: pick(chats) }), guest ? pick(["lark:ou_demo_a", "lark:ou_demo_b", "lark:ou_demo_c"]) : pick(people), guest ? null : "owner",
        JSON.stringify(pick(ais)), quiet, new Date(at).toISOString(), new Date(at + 2000).toISOString(), new Date(at + took * 1000).toISOString());
      // Reactions on some answers, and memories recalled for some.
      if ((kind === "ask" || guest) && rnd() < 0.35) run(app.db, "insert into feedback(id,channel,message_id,run_id,on_bot,actor_id,actor_kind,emoji,polarity,at) values(?,?,?,?,?,?,?,?,?,?)",
        `fb_demo_${k}`, "lark", `om_demo_${k}`, id, 1, "ou_demo_member", "member", "THUMBSUP", rnd() < 0.82 ? "positive" : "negative", new Date(at + took * 1000 + 600_000).toISOString());
      // How some answers went afterwards (the data page's small table of reply outcomes).
      if ((kind === "ask" || guest || kind === "agent") && rnd() < 0.6) {
        const x = rnd();
        const label = x < 0.52 ? "resolved" : x < 0.68 ? "followup" : x < 0.76 ? "corrected" : x < 0.83 ? "taken_over" : "silent";
        run(app.db, "insert into reply_outcomes(run_id,at,channel,label,confidence,\"by\",labelled_at,due_at) values(?,?,?,?,?,?,?,?)", id, new Date(at + took * 1000).toISOString(), "lark", label, 0.9, "decision", new Date(at + 6 * 3600_000).toISOString(), new Date(at + 4 * 3600_000).toISOString());
      }
      if (kind !== "ingest" && rnd() < 0.5) run(app.db, "insert into memory_recalls(memory_id,run_id,used,at,purpose) values(?,?,?,?,?)", "m_demo", id, rnd() < 0.4 ? 1 : 0, new Date(at).toISOString(), "answer");
      if (kind === "ingest" && rnd() < 0.5) run(app.db, "insert into memory_recalls(memory_id,run_id,used,at,purpose) values(?,?,?,?,?)", "m_demo", id, rnd() < 0.2 ? 1 : 0, new Date(at).toISOString(), "upkeep");
    }
  }
}

// Every kind of chart in one view (#/ui/uv_charts_demo), to look at with --serve.
// In the personal space, so it stays out of the demo project's conversation list in the other shots.
const chartsDemo = createThread(app, { channel: "web", spaceId: "personal", title: "退款原因与趋势", userId: "owner" });
addMessage(app, chartsDemo.id, "user", "退款原因和这两周的走势画出来看看。");
run(app.db, "insert into ui_views(id,run_id,conversation_id,user_id,title,components,created_at) values(?,?,?,?,?,?,?)", "uv_charts_demo", "r_charts_demo", chartsDemo.id, "owner", "退款原因与趋势", JSON.stringify([
  { type: "metric", items: [{ label: "退款单", value: 482, unit: "单", change: "+12%", good: "down", note: "比上两周", spark: [30, 34, 29, 41, 38, 22, 19, 36, 40, 33, 45, 44, 25, 21] }, { label: "平均处理", value: "2.1", unit: "天", change: "-0.4", good: "down", note: "比上两周" }, { label: "部分退款", value: 97, unit: "单", note: "占 20%" }, { label: "人工介入", value: 31, unit: "单" }] },
  { type: "chart", title: "退款原因排行", kind: "hbar", unit: "单", labels: ["尺码不合适", "质量问题", "物流太慢", "与描述不符", "不想要了"], series: [{ name: "退款单", values: [168, 121, 84, 63, 46] }], highlight: "质量问题", goal: 150 },
  { type: "chart", title: "每天的退款单", kind: "area", unit: "单", labels: Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`), series: [{ name: "退款单", values: [30, 34, 29, 41, 38, 22, 19, 36, 40, 33, 45, 44, 25, 21] }] },
  { type: "chart", title: "每天新开的售后工单", kind: "line", unit: "单", labels: Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 9, 17 + i)).toISOString().slice(0, 10)), series: [{ name: "工单", values: [12, 15, 14, 18, 17, 9, 8, 16, 19, 21, 20, 23, 11, 10, 18, 17, 15, 14, 16, 7, 6, 13, 15, 17, 19, 22, 12, 9, 20, 24] }] },
  { type: "chart", title: "每个客服本周处理的工单", kind: "bar", unit: "单", labels: ["小王", "小李", "小张", "小赵", "小陈", "小周"], series: [{ name: "工单", values: [38, 27, 22, 16, 11, 7] }] },
  { type: "chart", title: "三个仓的发货与退回", kind: "hbar", unit: "单", labels: ["华东仓", "华南仓", "华北仓"], series: [{ name: "发货", values: [42, 31, 18] }, { name: "退回", values: [9, 6, 5] }, { name: "补发", values: [4, 2, 3] }] },
  { type: "chart", title: "三个渠道的退款率", kind: "line", unit: "%", labels: ["第 1 周", "第 2 周", "第 3 周", "第 4 周", "第 5 周", "第 6 周"], series: [{ name: "App", values: [3.1, 3.4, 3.2, 3.8, 4.1, 4.6] }, { name: "小程序", values: [2.2, 2.5, 2.4, 2.6, 2.3, 2.4] }, { name: "网页", values: [4.0, 3.6, 3.3, 3.1, 2.9, 2.7] }] },
  { type: "chart", title: "每周的退款方式", kind: "bar", stack: true, unit: "单", labels: ["第 1 周", "第 2 周", "第 3 周", "第 4 周"], series: [{ name: "原路退回", values: [96, 104, 112, 121] }, { name: "退到余额", values: [41, 38, 47, 52] }, { name: "人工打款", values: [9, 12, 7, 5] }] },
  { type: "chart", title: "退款单的构成", kind: "pie", unit: "单", labels: ["整单退款", "部分退款", "仅退运费", "其他"], series: [{ name: "退款单", values: [341, 97, 30, 14] }] },
]), new Date().toISOString());

// ---- work metrics for the data page's 工作数据 tab (fictional systems and numbers) --------------
{
  writeWorkFile(app, { spaceId: "shop", path: "数据/数据源目录.md", title: "数据源目录", text: `# 数据源目录

## 前端监控

- 页面报错、白屏、接口失败率；按页面和版本查。

## 埋点平台

- 退款申请页、售后详情的点击和提交事件。

## 订单库（只读副本）

- 退款单数、退款金额、部分退款的占比。
` });
  const plan = writeWorkFile(app, { spaceId: "shop", path: "观测/退款改造.md", title: "退款改造的观测计划", text: `# 退款改造的观测计划

## 要回答的问题

1. 部分发货的订单只退已发货的行以后，退款接口有没有更容易出错？
2. 用户能不能顺利把退款申请交上去，PC 和手机上一样吗？
3. 新申请页的量追上旧页了没有？

## 上线前

- 申请页的“仅退已发货”选择要埋点。

## 上线后看什么

- 退款接口报错率（前端监控，按天），超过 30% 的变化要警觉。
- 退款申请的完成率：打开申请页到提交成功，按端分开看。
- 新旧申请页的提交数：灰度期间并排看，新页的占比。
`, links: { item: refundLine.id } });
  writeWorkFile(app, { spaceId: "shop", path: "数据/采集/11-19 日指标采集.md", title: "11-19 日指标采集", text: "三个指标都取到了，报错率比前一周高。" });
  // A report the assistant wrote: two charts in one work file, drawn on the page.
  writeWorkFile(app, { spaceId: "shop", path: "数据/报表/退款改造上线一周.md", title: "退款改造上线一周", links: { item: refundLine.id }, text: `# 退款改造上线一周

**结论：部分退款已经占到退款单的两成，错算集中在满减分摊；报错率上升主要来自手机端。**

取数：订单库只读副本，11 月 13 日到 19 日；报错来自前端监控。

\`\`\`chart
{"kind":"pie","title":"退款单的构成","unit":"单","labels":["整单退款","部分退款","仅退运费","其他"],"series":[{"name":"退款单","values":[341,97,30,14]}]}
\`\`\`

\`\`\`chart
{"kind":"hbar","title":"退款接口报错按页面","unit":"次","labels":["申请页（手机）","申请页（PC）","售后详情","导出"],"series":[{"name":"报错","values":[86,31,12,4]}]}
\`\`\`

手机端申请页的报错里，七成是选择“仅退已发货”之后金额重新计算超时。
` });
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
  const series = async (name: string, values: number[], dims?: Record<string, string>) => recordPoints(app, name, values.map((value, i) => ({ value, at: day(values.length - 1 - i), ...(dims ? { dims } : {}) })));
  defineMetric(app, { name: "退款接口报错率", unit: "%", source: "前端监控", query: "前端监控：退款申请页 /refund/apply 的接口失败率，按天", itemId: refundLine.id, spaceId: "shop", schedule: "daily", direction: "down-good", why: "部分发货只退已发货的行以后，退款接口有没有更容易出错", planRef: `src:${plan.id}#L13-L15`, description: "部分发货改造上线后最该盯的护栏指标" });
  await series("退款接口报错率", [0.42, 0.38, 0.4, 0.45, 0.41, 0.39, 0.43, 0.4, 0.44, 0.47, 0.52, 0.61, 0.66, 0.72]);
  defineMetric(app, { name: "部分退款占比", unit: "%", source: "订单库（只读副本）", query: "订单库：当天退款单里只退部分行的比例", itemId: refundLine.id, spaceId: "shop", schedule: "daily", direction: "neutral", why: "部分发货的退款有多少，改造影响多大" });
  await series("部分退款占比", [8, 9, 8, 10, 11, 10, 12, 13, 12, 14, 15, 15, 16, 17]);
  defineMetric(app, { name: "仅退已发货的选择次数", unit: "次", source: "埋点平台", query: "埋点平台：refund_apply_shipped_only 的点击数，按天", itemId: flowItem.id, spaceId: "shop", schedule: "daily", direction: "up-good", why: "新加的“仅退已发货”有没有人用", view: { kind: "bar" } });
  await series("仅退已发货的选择次数", [0, 0, 0, 0, 0, 0, 0, 3, 9, 14, 22, 30, 41, 55]);
  // Two the assistant proposed from the plan, waiting for the owner: by device over two weeks, and new against old with one day so far.
  const planRun = createRun(app, { kind: "agent", spaceId: "shop", title: "给退款改造写观测计划", input: { spec: "assistant", task: "按 observation-plan 给退款改造写观测计划" } });
  const proposed = { by: "agent" as const, runId: planRun.id };
  defineMetric(app, { name: "退款申请完成率", unit: "%", source: "埋点平台", query: "埋点平台：refund_apply_submit_success ÷ refund_apply_open，按天、按端（PC / 手机）", itemId: refundLine.id, spaceId: "shop", schedule: "daily", direction: "up-good", why: "改版后用户能不能顺利把退款申请交上去，PC 和手机上一样吗", planRef: `src:${plan.id}#L16-L16`, view: { kind: "compare", compareBy: "端" } }, proposed);
  await series("退款申请完成率", [71, 72, 70, 73, 72, 74, 73, 72, 74, 75, 76, 75, 77, 78], { 端: "PC" });
  await series("退款申请完成率", [63, 62, 64, 63, 61, 62, 60, 58, 57, 55, 54, 52, 51, 49], { 端: "手机" });
  defineMetric(app, { name: "新旧申请页的提交数", unit: "单", source: "订单库（只读副本）", query: "订单库：当天从新申请页和旧申请页提交的退款单数，dims.side 写 新 / 旧", itemId: refundLine.id, spaceId: "shop", schedule: "daily", direction: "neutral", why: "灰度期间新申请页的量追上旧页了没有", planRef: `src:${plan.id}#L17-L17`, view: { kind: "compare", compareBy: "side", ratio: true, focus: "新" } }, proposed);
  await recordPoints(app, "新旧申请页的提交数", [{ value: 1284, at: day(1), dims: { side: "新" } }, { value: 2906, at: day(1), dims: { side: "旧" } }]);
  // Two more on the ticket line, not taken yet: the list of proposals groups them by line.
  defineMetric(app, { name: "退款类工单分对的比例", unit: "%", source: "工单系统", query: "工单系统：退款类工单里自动分类和人工复核一致的比例，按天", itemId: ticketLine.id, spaceId: "shop", schedule: "daily", direction: "up-good", why: "自动分类上线后，退款类工单有没有分到对的人手里" }, proposed);
  defineMetric(app, { name: "转人工的工单数", unit: "单", source: "工单系统", query: "工单系统：当天从自动分类转人工处理的工单数", itemId: ticketLine.id, spaceId: "shop", schedule: "daily", direction: "down-good", why: "分不清的工单有多少还要人来分" }, proposed);
  snapshotOmemUsage(app, { maxDays: 30 });
}

// ---- a work board: three parts done side by side, one sent back once (the run page, shot run-board)
const boardThread = createThread(app, { channel: "web", spaceId: "shop", title: "上月退款单为什么对不上", userId: "owner" });
const boardAsk = createRun(app, { kind: "ask", spaceId: "shop", title: "上月退款单为什么对不上", input: { conversationId: boardThread.id } });
{
  const { createAgentWork } = await import("../src/agents/agent-work.ts");
  const { dispatchBoard, reviewBoard, settleBoardRun } = await import("../src/agents/work-board.ts");
  const { getRun } = await import("../src/agents/runs.ts");
  const scope = { userId: "owner", spaces: ["shop"], denyTools: [], lark: { chats: null } };
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const work = createAgentWork(app, { askRunId: boardAsk.id, rootConversationId: boardThread.id, spaceId: "shop", title: "核对上月退款单的三处差异", startMessage: "核对上月退款单的三处差异" });
  const [bills, logs, coupons] = dispatchBoard(app, work, [
    { title: "对账单和订单库逐笔对", goal: "把上月对账单里的退款行和订单库的退款记录按订单号逐笔对上，列出金额不一致的。", accept: "交一张差异表：订单号、对账单金额、订单库金额、差额；每行带出处。", execution: { profile: "codex", model: "gpt-6.2-sol", effort: "low", source: "auto", reason: "清点和对照，写得出验收条件" }, scope },
    { title: "查部分发货订单的退款日志", goal: "差额集中在部分发货的订单：查这些订单的退款日志，确认走的是旧的整单比例还是新的按行分摊。", accept: "每个订单给出走了哪条路径和依据的日志行；说不清的单独列出。", execution: { profile: "codex", model: "gpt-6.2-sol", effort: "low", source: "auto", reason: "按订单号查日志" }, scope },
    { title: "核对满减券的分摊口径", goal: "对照《退款改造需求》和客服口径，确认满减券在部分退款时该怎么分摊。", accept: "一句结论加两处原文引用；两边不一致就都列出来。", scope },
  ], boardAsk.id);
  const runOf = (task: string) => one<{ run_id: string }>(app.db, "select run_id from agent_work_tasks where id = ?", task)!.run_id;
  const finish = (task: string, answer: string, started: number, finished: number) => {
    const id = runOf(task);
    run(app.db, "update runs set status='done', started_at=?, finished_at=?, output=json_set(coalesce(output,'{}'),'$.answer',?), ai=? where id=?", ago(started), ago(finished), answer, JSON.stringify({ profile: "codex", model: "gpt-6.2-sol", effort: "low" }), id);
    settleBoardRun(app, getRun(app, id));
  };
  finish(bills, "37 笔退款里 5 笔金额不一致，差额合计 86.40 元，都是部分发货的订单。\n\n| 订单 | 对账单 | 订单库 | 差额 |\n| --- | --- | --- | --- |\n| A1027 | 120.00 | 96.00 | 24.00 |\n| A1033 | 88.00 | 70.40 | 17.60 |", 16, 9);
  finish(logs, "5 个订单都走了旧的整单比例。", 15.8, 11);
  reviewBoard(app, boardAsk.id, [
    { task: bills, decision: "accept", note: "差异表和对账单逐行对得上" },
    { task: logs, decision: "redo", note: "过了期限才交回，也没给日志行：再在那台查一次，每个订单贴出判断走旧路径的那一行", execution: { profile: "codex", model: "gpt-6.2-sol", effort: "high", source: "auto", reason: "退回重做，升一档" } },
  ], "owner");
  // The course of each part: when it waited and ran (the two still going started a while ago).
  const course = (task: string, patch: (attempts: Record<string, unknown>[]) => void, status?: string) => {
    const attempts = JSON.parse(one<{ attempts: string }>(app.db, "select attempts from agent_work_tasks where id = ?", task)!.attempts) as Record<string, unknown>[];
    patch(attempts);
    run(app.db, `update agent_work_tasks set attempts = ?${status ? ", status = ?" : ""} where id = ?`, ...[JSON.stringify(attempts), ...(status ? [status] : []), task]);
  };
  // The first part borrowed the backend of the paired device lab-mac; the logs are on lab-mac, so that part ran
  // there: its first try came back after the deadline (not used), the second is running there now.
  const remote = (deadline: number, extra: Record<string, unknown> = {}) => ({ device: "lab-mac", mode: "remote", access: "read", deadline: ago(deadline), ...extra });
  course(bills, (a) => Object.assign(a[0], { queuedAt: ago(16.1), startedAt: ago(16), finishedAt: ago(9), device: "lab-mac", mode: "borrow", access: "read", deadline: ago(-14) }));
  course(logs, (a) => {
    Object.assign(a[0], { queuedAt: ago(16.1), startedAt: ago(15.8), finishedAt: ago(11), ...remote(12, { status: "failed", result: "过了期限", lateAt: ago(11) }) });
    Object.assign(a[1], { queuedAt: ago(8), startedAt: ago(7.6), status: "running", ...remote(-22, { remoteUrl: "http://192.0.2.20:4317/#/runs/r_demo_remote" }) });
  }, "running");
  course(coupons, (a) => Object.assign(a[0], { queuedAt: ago(16.1), startedAt: ago(11), status: "running" }), "running");
  for (const task of [logs, coupons]) run(app.db, "update runs set status='running', started_at=?, ai=? where id=?", ago(task === logs ? 7.6 : 11), JSON.stringify({ profile: "codex", model: "gpt-6.2-sol", effort: task === logs ? "high" : "medium" }), runOf(task));
  run(app.db, "update runs set status='done', started_at=?, finished_at=?, output=json_set(coalesce(output,'{}'),'$.answer',?) where id=?", ago(17), ago(16), "已经分三块在查：对账单逐笔对、部分发货订单的退款日志、满减券的分摊口径。三块都有结果后我再汇总给你。", boardAsk.id);
  // What the first part reported using; the two still running have not reported yet ("有 N 个没有用量数据").
  addRunEvent(app, runOf(bills), "usage", { input: 18_400, output: 2_150 });
}

// ---- the same ask also delegated a fix, in two rounds, with a review (shots progress-board, work-progress) --
// The ask and the delegation hang on the requirement in its flow (flowItem), so its work page shows them with
// the flow's stage: a board still running, a delegation waiting for the owner to accept it (T2 done on the
// second try), a review passed in its second round.
{
  const { addTask, takeTasks, updateTask } = await import("../src/agents/code-tasks.ts");
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const codex = (effort: string) => JSON.stringify({ profile: "codex", model: "gpt-6.2-sol", effort });
  run(app.db, "update runs set input=json_set(input,'$.itemId',?) where id=?", flowItem.id, boardAsk.id);
  const reviewPlan = { tier: "standard", tierName: "标准", checks: ["reviewer", "review-business"], maxRounds: 3, reasons: ["改了退款日志和导出两处"], metrics: {} };
  const first = createRun(app, { kind: "code", spaceId: "shop", parentId: boardAsk.id, title: "退款日志写明走了哪条分摊路径", input: { task: "退款日志里写明这笔退款走的是旧的整单比例还是按行分摊，导出任务读这一项；补部分发货的回放用例。", repos: ["shop"], itemId: flowItem.id } });
  const tasks = [
    addTask(app, first.id, { title: "退款日志写明分摊路径", doneWhen: "每条退款日志带 split=legacy 或 split=line，单测覆盖两种。", kind: "build" }, "coder"),
    addTask(app, first.id, { title: "部分发货订单补回放用例", doneWhen: "上月 5 笔差额订单都在用例里，按行分摊后差额为 0。", kind: "build" }, "coder"),
    addTask(app, first.id, { title: "导出任务读日志里的分摊路径", doneWhen: "导出的退款表多一列“分摊方式”，和日志一致。", kind: "build" }, "coder"),
  ];
  takeTasks(app, first.id, first.id);
  updateTask(app, first.id, tasks[0].seq, { state: "done", commits: { shop: ["3f2a91c"] } });
  // T2 did not pass its check in the first round: sent back, done by the second round.
  updateTask(app, first.id, tasks[1].seq, { state: "todo", attempts: 1 }, { kind: "verify", by: "reviewer", text: "回放用例只放了 3 笔，少了 A1033 和 A1041" });
  updateTask(app, first.id, tasks[2].seq, { state: "done", commits: { shop: ["8c41d07"] } });
  setRunOutput(app, first.id, { reviewPlan, reviewStage: "done", verdict: "changes-requested", coderAI: { profile: "codex", model: "gpt-6.2-sol", effort: "high" } });
  run(app.db, "update runs set status='done', created_at=?, started_at=?, finished_at=?, ai=? where id=?", ago(15.5), ago(15), ago(9), codex("high"), first.id);
  recordReview(app, { codeRunId: first.id, round: 1, check: "reviewer", tier: "standard", verdict: "changes_requested", summary: "回放用例少了两笔差额订单。", findings: [{ severity: "major", file: "test/replay.test.js", line: 12, title: "回放用例只覆盖了 3 笔差额订单", detail: "", suggestion: "把 A1033、A1041 加进去", evidence: [], confidence: "high" }] as never, ai: { profile: "codex", model: "gpt-6.2-sol", effort: "medium" } });
  recordReview(app, { codeRunId: first.id, round: 1, check: "review-business", tier: "standard", verdict: "approved", summary: "分摊方式的取值和需求一致。", findings: [], ai: { profile: "codex", model: "gpt-6.2-sol", effort: "medium" } });
  for (const f of all<{ id: number }>(app.db, "select f.id from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ?", first.id))
    run(app.db, "update review_findings set state='accepted', decision='fix' where id=?", f.id);
  const second = createRun(app, { kind: "code", spaceId: "shop", title: "退款日志写明走了哪条分摊路径 · 第 2 轮", input: { continueFrom: first.id, round: 2, task: "补上 A1033、A1041 两笔回放用例", repos: ["shop"], itemId: flowItem.id } });
  takeTasks(app, first.id, second.id);
  updateTask(app, first.id, tasks[1].seq, { state: "done", commits: { shop: ["d93e5b2"] } });
  setRunOutput(app, second.id, { reviewPlan: { ...reviewPlan, checks: ["reviewer"] }, reviewStage: "done", verdict: "approved", coderAI: { profile: "codex", model: "gpt-6.2-sol", effort: "high" } });
  run(app.db, "update runs set status='done', created_at=?, started_at=?, finished_at=?, ai=? where id=?", ago(8), ago(7.8), ago(2), codex("high"), second.id);
  recordReview(app, { codeRunId: second.id, round: 2, check: "reviewer", tier: "standard", verdict: "approved", summary: "5 笔差额订单都在用例里，回放通过。", findings: [], ai: { profile: "codex", model: "gpt-6.2-sol", effort: "medium" } });
  // What each round reported using (made-up figures).
  addRunEvent(app, first.id, "usage", { input: 96_300, output: 8_420 });
  addRunEvent(app, second.id, "usage", { input: 41_800, output: 3_960 });
}

// ---- operation rules and two rule packs (设置 → 安全, shot security-rules) ------------------------
{
  const { saveOperationRules } = await import("../src/agents/operation-policy.ts");
  const { enableRulePack, listRulePacks } = await import("../src/agents/rule-packs.ts");
  const skill = (name: string, description: string, pack: object) => {
    const dir = join(app.libraryDir, "_skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
    writeFileSync(join(dir, "operation-rules.yaml"), JSON.stringify(pack, null, 2));
  };
  const acmeWrites = (version: string, extra: object[] = []) => ({
    name: "acme 写操作", version, rules: [
      { id: "mr-merge", title: "合并请求前问本人", match: { kind: "command", executable: "acme", subcommand: ["mr", "merge"] }, action: "approve" },
      { id: "release", title: "发版前问本人", match: { kind: "command", executable: "acme", subcommand: ["release"] }, action: "approve" },
      ...extra,
    ],
  });
  saveOperationRules(app, [
    { id: "demo-mr", revision: 1, enabled: true, title: "建合并请求前问本人", scope: { spaces: ["shop"] }, match: { kind: "command", executable: "acme", subcommand: ["mr", "create"] }, action: "approve", approval: { approver: "owner", waitSeconds: 90 } },
    { id: "demo-prod", revision: 1, enabled: true, match: { kind: "command", executable: "acme", subcommand: ["deploy"], argsRegex: "--env[= ]prod" }, action: "deny" },
    { id: "demo-refund", revision: 1, enabled: true, match: { kind: "http", methods: ["POST"], host: "api.example.com", pathRegex: "^/v1/refunds" }, action: "approve", approval: { approver: "owner", waitSeconds: 120 } },
    { id: "demo-env", revision: 1, enabled: true, title: "不改 .env 文件", match: { kind: "file", operations: ["write", "delete"], pathRegex: "(^|/)\\.env$" }, action: "deny" },
    { id: "demo-send", revision: 1, enabled: false, match: { kind: "tool", name: "lark_send" }, action: "log" },
  ]);
  skill("acme-cli", "用 acme 命令行建合并请求、发版", acmeWrites("1"));
  skill("acme-billing", "用 acme 命令行查账单和退款", { name: "acme 账单", version: "3", rules: [
    { id: "refund", title: "退款前问本人", match: { kind: "command", executable: "acme", subcommand: ["billing", "refund"] }, action: "approve" },
    { id: "export", match: { kind: "command", executable: "acme", subcommand: ["billing", "export"] }, action: "log" },
  ] });
  const acme = listRulePacks(app).find((p) => p.id === "skill:acme-cli")!;
  enableRulePack(app, acme.id, { spaces: ["shop"] }, acme.confirmation!);
  // A newer version of the enabled pack: one rule more, to be confirmed.
  skill("acme-cli", "用 acme 命令行建合并请求、发版", acmeWrites("2", [{ id: "branch-delete", title: "删远端分支前问本人", match: { kind: "command", executable: "acme", subcommand: ["branch", "delete"] }, action: "approve" }]));
}

// 评审页的“同步到平台”: the reviewed change's item has a merge request attached (the GitHub plugin's kind), and
// the findings stand in every state a provider leaves them in: posted, answered there, failed, to be placed again, not sent.
{
  const now = new Date().toISOString();
  run(app.db, "update runs set input = json_set(input, '$.itemId', ?) where id = ?", item.id, r.id);
  run(app.db, "insert into flow_objects(id,kind,key,title,status,link,changed_at,updated_at) values('demo-pr','github:pull-request','example/shop#128','退款按已发货行分摊订单优惠 #128','open','https://github.com/example/shop/pull/128',?,?)", now, now);
  run(app.db, "insert into item_materials(item_id,kind,ref,created_at) values(?,'object','demo-pr',?)", item.id, now);
  const ids = all<{ id: number }>(app.db, "select f.id from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ? and f.state != 'rejected' order by f.id", r.id).map((f) => f.id);
  const comment = (n: number) => `https://github.com/example/shop/pull/128#discussion_r${1000 + n}`;
  const states: Record<string, unknown>[] = [
    { url: comment(1), object: "demo-pr", provider: "github:reviews", delivery: "published", state: "replied", reply: { author: "小王", at: new Date(Date.now() - 2 * 3600_000).toISOString(), summary: "尾差我改成记在金额最大的那一行了，麻烦再看一下 refund.js 第 18 行。" }, syncedAt: now, checkedAt: now },
    { url: comment(2), object: "demo-pr", provider: "github:reviews", delivery: "published", state: "open", syncedAt: now, checkedAt: now },
    { object: "demo-pr", provider: "github:reviews", delivery: "failed", error: "平台返回 502，稍后再发", syncedAt: now },
    { object: "demo-pr", provider: "github:reviews", delivery: "relocate", syncedAt: now },
  ];
  ids.slice(0, states.length).forEach((id, i) => run(app.db, "update review_findings set external = ? where id = ?", JSON.stringify(states[i]), id));
}

// 设置 → 安全 → 记录: what the rules above did in two runs, what went out in the owner's name, a few changes.
{
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const event = (minutes: number, actor: string, action: string, target: string, detail: Record<string, unknown>) =>
    run(app.db, "insert into audit_events(at,actor,action,target,detail) values(?,?,?,?,?)", at(minutes), actor, action, target, JSON.stringify(detail));
  event(60 * 50, "owner", "operation.pack.enable", "skill:acme-cli", { scope: { spaces: ["shop"] } });
  event(60 * 49, "owner", "operation.rules", "security", { count: 5 });
  event(60 * 27, "owner", "token.cli", "owner", {});
  event(60 * 26, "agent", "lark.mention-reply", "oc_demo_refund_qa", { runId: r.id, by: "auto", text: "部分发货的订单只退已发货的行，运费按已发货行的实付比例退；周四上线后生效。" });
  event(60 * 25, "owner", "lark.mention-reply.drop", "oc_demo_refund", { runId: r.id, reason: "对方已经撤回了问题" });
  event(60 * 5, "owner", "file.deny", "config/.env", { kind: "file", member: "owner", runId: r.id, ruleId: "demo-env", revision: 1, action: "deny", result: "策略判定" });
  event(95, "owner", "command.deny", "acme", { kind: "command", member: "owner", runId: r.id, ruleId: "demo-prod", revision: 1, action: "deny", result: "策略判定", commandLine: "acme deploy" });
  event(42, "owner", "command.approve", "acme", { kind: "command", member: "owner", runId: r.id, ruleId: "demo-mr", revision: 1, action: "approve", result: "策略判定", commandLine: "acme mr create" });
  event(41, "owner", "command.ask", "acme", { kind: "command", member: "owner", runId: r.id, ruleId: "demo-mr", revision: 1, command: "acme", cwd: "~/work/shop", approver: "本人", result: "等 本人 批准（规则指定）" });
  event(38, "owner", "command.approve", "acme", { kind: "command", member: "owner", runId: r.id, ruleId: "demo-mr", revision: 1, command: "acme", cwd: "~/work/shop", approver: "本人", result: "本人 批准" });
  event(38, "owner", "command.allow", "acme", { kind: "command", member: "owner", runId: r.id, ruleId: "demo-mr", revision: 1, command: "acme", cwd: "~/work/shop", approver: "本人", result: "本人 批准，放行" });
}

// 设置 → 推进工作 → 事项同步: a platform to read entries from, the way a plugin offers one. Nothing is
// subscribed here: the `item-sync` shot subscribes through the page, so no other shot has its items.
{
  const at = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const entry = (key: string, title: string, status: string, assignee: string, hours: number) => ({ key, url: `https://tracker.example.com/shop/refund/${key}`, title, status, assignee, revision: "1", updatedAt: at(hours) });
  const entries = [
    entry("128", "部分发货的订单申请退款，金额显示成负数", "open", "小王", 5),
    entry("131", "满减分摊后各行实付相加差一分钱", "open", "小王", 20),
    entry("133", "售后详情和导出的退款金额对不上", "open", "小李", 28),
    entry("119", "退款申请页在手机上按钮被键盘挡住", "closed", "阿青", 72),
  ];
  itemProviders.set("tracker:issues", {
    plugin: "tracker", spaces: [],
    def: {
      id: "issues", label: "示例工单平台", statuses: { open: "active", closed: "done" }, targetHint: "项目，写成 团队/项目",
      async pull() { return { items: entries, done: true }; },
      async setStatus(_ctx, req) { return { status: req.status, revision: String(Number(req.expectedRevision ?? 1) + 1) }; },
    },
    context: (_app, userId, spaceId, signal) => ({ userId, spaceId, signal, connection: async () => null }),
  });
}

// ---- 插件参与检索 (src/search/providers.ts): a fictional plugin with two recall routes and a reranker ----
// Registered in process like the platform above; nothing is turned on, the `search-providers` shot does that.
{
  const context = (_app: App, userId: string, spaceId: string, signal: AbortSignal) => ({ userId, spaceId, signal, connection: async () => null });
  retrievers.set("library:lookup", { plugin: "library", spaces: [], context, def: { id: "lookup", label: "示例资料库检索", async search() { return []; } } });
  retrievers.set("library:tickets", { plugin: "library", spaces: ["shop"], context, def: { id: "tickets", label: "相似工单", async search() { throw new Error("资料库服务没有响应（演示）"); } } });
  rerankers.set("library:rank", { plugin: "library", spaces: [], context, def: { id: "rank", label: "示例相关性模型", async score(_ctx, { candidates }) { return candidates.map((_, i) => -i); } } });
}

// ---- 向量和重排的来源 (设置 → 检索与记忆): the same plugin's vector provider, granted the shop's space only, and a
// local stand-in for a cloud API (OpenAI-shaped /embeddings, the usual /rerank). The model "missing-model" answers
// 404, to see a failure. Nothing is switched on: the `settings-search-providers` shot does that through the page.
const toyVector = (text: string, dims = 64) => {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % dims] += 1;
  return v;
};
const fakeApi = createHttpServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = (() => { try { return JSON.parse(raw || "{}"); } catch { return {}; } })() as { model?: string; input?: string[]; query?: string; documents?: string[]; dimensions?: number };
    const send = (status: number, json: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (body.model === "missing-model") return send(404, { error: { message: `The model '${body.model}' does not exist` } });
    if (req.url?.endsWith("/embeddings")) return send(200, { data: (body.input ?? []).map((t, index) => ({ index, embedding: toyVector(t, body.dimensions ?? 64) })) });
    if (req.url?.endsWith("/rerank")) {
      const q = new Set(body.query ?? "");
      return send(200, { results: (body.documents ?? []).map((d, index) => ({ index, relevance_score: [...d].filter((ch) => q.has(ch)).length / Math.max(1, d.length) })) });
    }
    send(404, { error: { message: "not found" } });
  });
});
await new Promise<void>((ok) => fakeApi.listen(0, "127.0.0.1", ok));
fakeApi.unref();
const fakeApiUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}/v1`;
// The address field takes a domain name only, so the stand-in is reached as an AI provider's address (设置 → AI),
// with a made-up key: the cards pick “示例云” as the key and leave the address empty.
app.config.ai.providers.push({ id: "demo-cloud", name: "示例云", kind: "openai-compatible", baseUrl: fakeApiUrl, backends: [] });
setKey(app.home, "demo-cloud", "demo-key-not-a-secret");
{
  const context = (_app: App, userId: string, spaceId: string, signal: AbortSignal) => ({ userId, spaceId, signal, connection: async () => null });
  embedders.set("library:vectors", { plugin: "library", spaces: ["shop"], context, def: { id: "vectors", name: "示例资料库向量", model: "demo-vec-64", dimensions: 64, maxBatch: 16, async embed(texts) { return texts.map((t) => toyVector(t)); } } });
}

// ---- 设备 (src/core/peers.ts): one paired device, which also holds a pairing token of this one -------------
// Its address is a documentation range: the status check finds it offline. The board above sends two of its
// parts there (the `settings-devices-work` and progress shots).
savePeers(app, [{ id: "lab-mac", url: "http://192.0.2.20:4317", token: "demo-peer-token", addedAt: new Date(Date.now() - 6 * 86400_000).toISOString() }]);
invite(app, { label: "lab-mac" });
invite(app, { label: "家里的台式机" });

// ---- 读一种新格式、页面类型 (src/plugins/formats.ts): a fictional plugin's parsers and page kind ----
// Two sources it read (a table and records) and a Wiki page of its kind. Registered in process.
const sampleTable = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "data/十月退款抽样.csv", title: "十月退款单抽样", text: [
  "# 十月退款单抽样", "", "| 单号 | 原因 | 金额 | 状态 |", "|---|---|---|---|",
  ...([["R1001", "尺码不合适", "129.00", "已退款"], ["R1002", "质量问题：开线", "89.50", "已退款"], ["R1003", "物流太慢", "45.00", "退款中"], ["R1004", "与描述不符", "260.00", "已退款"], ["R1005", "部分发货，只退已发货的一件", "39.90", "退款中"], ["R1006", "不想要了", "18.00", "已拒绝"], ["R1007", "质量问题：褪色", "72.00", "已退款"], ["R1008", "满减分摊后差一分钱", "0.01", "已退款"], ["R1009", "尺码不合适", "149.00", "退款中"], ["R1010", "物流太慢", "35.00", "已退款"]].map((r) => `| ${r.join(" | ")} |`)),
].join("\n"), meta: {
  parser: { id: "sheets:csv", version: "1" }, fields: { 来源: "售后导出" },
  display: { kind: "table", columns: ["单号", "原因", "金额", "状态"], rowLines: Array.from({ length: 10 }, (_, i) => [5 + i, 5 + i]) },
} }).id;
const replyRecords = [
  { title: "部分发货的退款怎么算", body: ["只退已发货的行，未发货的行直接取消，不进退款单。", "满减按各行实付比例分摊，尾差归最后一行。"] },
  { title: "退款金额显示成负数", body: ["是旧版本的缺陷，已修复；请用户刷新页面后重新提交。"] },
  { title: "退款多久到账", body: ["原路退回 1–3 个工作日；退到余额即时到账。", "超过 5 个工作日没到，转人工核对支付流水。"] },
  { title: "发票已开的订单能退吗", body: ["能退，退款完成后发票自动红冲，不用用户操作。"] },
];
const recordLines: string[] = [];
const recordItems = replyRecords.map((r) => {
  const start = recordLines.length + 1;
  recordLines.push(r.title, ...r.body);
  return { title: r.title, lines: [start, recordLines.length] as [number, number] };
});
const sampleRecords = upsertSource(app, { spaceId: "shop", kind: "doc", uri: "data/客服话术.jsonl", title: "客服话术库", text: recordLines.join("\n"), meta: {
  parser: { id: "sheets:jsonl", version: "1" }, display: { kind: "records", items: recordItems },
} }).id;
{
  const context = (_app: App, userId: string, spaceId: string, signal: AbortSignal) => ({ userId, spaceId, signal, connection: async () => null });
  const formats = registerFormats({ id: "sheets", permissions: { sourceParser: true, wikiPageKind: true } } as unknown as PluginManifest, "1", [], context, []);
  formats.sourceParser({ id: "csv", label: "表格（CSV）", match: { extensions: [".csv"], mimeTypes: ["text/csv"] }, async parse() { return { text: "" }; } });
  formats.sourceParser({ id: "jsonl", label: "逐行 JSON 记录", match: { extensions: [".jsonl"], urlPatterns: ["https://*/*.jsonl"] }, async parse() { return { text: "" }; } });
  formats.wikiPageKind({ kind: "runbook", label: "处理手册", describe: "遇到某一类问题时，一步步怎么查、怎么处理、找谁。", template: "## 现象\n## 先查什么\n## 怎么处理\n## 找谁" });
}
writePage(app, "shop", "ops/runbook-negative-amount", { meta: { title: "退款金额显示成负数怎么处理", kind: "runbook", summary: "用户反馈退款金额是负数时，客服和值班各做什么" }, body: [
  "## 现象", `部分发货的订单申请退款时，申请页的金额显示成负数（[话术](src:${sampleRecords}#L4-L4)）。`, "",
  "## 先查什么", `看这单是不是满减订单、有没有未发货的行；[十月抽样](src:${sampleTable}#L9-L9)里有一单同样的情况。`, "",
  "## 怎么处理", "请用户刷新后重新提交；仍是负数的转值班。", "", "## 找谁", "后端值班：小王。",
].join("\n") }, { actor: "wiki-writer" });

// ---- 通知出口 (src/plugins/notifier.ts): a fictional plugin with two outlets, registered in process ----
// One can carry questions; the other cannot reach anyone (its hint shows when the row opens). The owner
// has the first on for normal and above; the `settings-outlets` shot shows it.
{
  const context = (_app: App, userId: string, spaceId: string, signal: AbortSignal) => ({ userId, spaceId, signal, connection: async () => null });
  const lifetime = new AbortController().signal;
  notifiers.set("pager:phone", { plugin: "pager", spaces: [], context, lifetime, def: {
    id: "phone", name: "手机推送（演示）",
    async deliver() { return { ref: "demo" }; },
    async ask() { return { ref: "demo-ask" }; },
  } });
  notifiers.set("pager:desk", { plugin: "pager", spaces: [], context, lifetime, def: {
    id: "desk", name: "桌面提醒（演示）",
    async resolve() { return { ok: false, hint: "这台电脑上没有装桌面提醒的客户端（演示）" }; },
    async deliver() { throw new Error("客户端没有响应（演示）"); },
  } });
  app.config.notify.outlets = { owner: [{ id: "pager:phone", minUrgency: "normal", askKinds: ["question"] }] };
}

// ---- other people (src/auth/capabilities.ts) ---------------------------------------------------
// 小周 reads the shop's work as a read-only observer; 小林 is a member with two capabilities set
// apart from the preset and one space set on its own. Their tokens log the page in as them.
const xiaozhou = createUser(app, { id: "xiaozhou", name: "小周", role: "observer" });
addMember(app, "shop", xiaozhou.id, "reader");
const xiaolin = createUser(app, { id: "xiaolin", name: "小林", role: "member" });
addMember(app, "shop", xiaolin.id, "contributor");
addMember(app, "refund", xiaolin.id, "reader");
for (const [capability, kind, scope, effect] of [["work.view", "global", "", "allow"], ["items.operate", "global", "", "deny"], ["items.view", "space", "shop", "allow"]] as const)
  run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by,updated_at) values(?,?,?,?,?,?,?,?)", xiaolin.id, capability, kind, scope, effect, new Date().toISOString(), "owner", new Date().toISOString());
// Settings by area (src/auth/settings-sections.ts): 小林 sees and changes the assistant area; 小周 reads
// the knowledge and assistant areas. The `settings-member` shot opens the page as 小林.
for (const [user, capability] of [[xiaolin.id, "settings.assistant.view"], [xiaolin.id, "settings.assistant.edit"], [xiaozhou.id, "settings.knowledge.view"], [xiaozhou.id, "settings.assistant.view"]] as const)
  run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by,updated_at) values(?,?,'global','','allow',?,?,?)", user, capability, new Date().toISOString(), "owner", new Date().toISOString());
// 小吴: a member with nothing set apart, to compare the nav against the preset.
const xiaowu = createUser(app, { id: "xiaowu", name: "小吴", role: "member" });
addMember(app, "shop", xiaowu.id, "reader");
const xiaozhouToken = createApiToken(app, xiaozhou.id, "演示");
const xiaolinToken = createApiToken(app, xiaolin.id, "演示");
const xiaowuToken = createApiToken(app, xiaowu.id, "演示");
// The owner signed in with a token: the cloud tools card is not served to a page opened straight on the machine.
const ownerToken = createApiToken(app, "owner", "演示");
// ---- 凭据 (src/agents/credentials.ts): who holds what (the `account-credentials` shot, 设置 → 成员) ----
// 小吴 logged in to the example account (valid a week) and lends it to 小林; 小林's ends in two days and he
// lends it to everyone; 小周 only chose not to lend; the owner's is this machine's own login.
{
  const demoKind = "acmeauth:demo", day = 86400_000;
  for (const id of [xiaowu.id, xiaolin.id]) await startCredentialLogin(app, id, demoKind);
  setCredentialSharing(app, xiaowu.id, demoKind, { scope: "members", members: [xiaolin.id] });
  setCredentialSharing(app, xiaolin.id, demoKind, { scope: "all" });
  setCredentialSharing(app, xiaozhou.id, demoKind, { scope: "self" });
  const soon = Date.now() + 2 * day - 3 * 3600_000;
  run(app.db, "update credential_holds set expires_at=?, refresh_at=? where user_id=? and kind=?", soon, soon - 600_000, xiaolin.id, demoKind);
  // 小吴 also logged in to the code host (its own login waits on a page, so the hold is written as it ends up).
  run(app.db, `insert into credential_holds(user_id,kind,state,account_name,expires_at,refresh_at,check_day,checked_at,sharing,notified,provision,supplied_backends)
    values(?,?,'logged-in',?,?,?,'',?,?,'{}',?,'[]')`, xiaowu.id, "codehub:token", "xiaowu@example.com", Date.now() + 25 * day, Date.now() + 25 * day - 600_000, new Date().toISOString(),
    JSON.stringify({ scope: "self", members: [] }), JSON.stringify({ backends: [], commands: ["hub-demo"], paths: [".config/hub-demo"] }));
  run(app.db, `insert into credential_holds(user_id,kind,state,account_name,expires_at,check_day,checked_at,sharing,notified,supplied_backends)
    values('owner',?,'logged-in',null,?,'',?,?,'{}',?)
    on conflict(user_id,kind) do update set state=excluded.state,expires_at=excluded.expires_at,checked_at=excluded.checked_at,sharing=excluded.sharing,supplied_backends=excluded.supplied_backends`, demoKind, Date.now() + 20 * day, new Date().toISOString(), JSON.stringify({ scope: "all", members: [] }), JSON.stringify(["acmeauth:demo"]));
}
// 小林's own line (src/items/member-work.ts), and what waits for him: the owner's assistant asked him how
// the refund API is going (src/items/member-progress.ts).
{
  const at = new Date().toISOString();
  const mine = upsertItem(app, undefined, { spaceId: "shop", kind: "line", title: "小林 · 订单导出改造", detail: "导出支持按发货状态筛选，月底前上线。", userId: xiaolin.id }, "user");
  const fields = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "导出字段和财务对一遍", userId: xiaolin.id }, "user");
  const api = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "按发货状态筛选的接口", userId: xiaolin.id }, "user");
  setParent(app, fields.id, mine.id);
  setParent(app, api.id, mine.id);
  run(app.db, "update items set now = ? where id = ?", JSON.stringify({ text: "截至今天导出字段和财务对完了一半，筛选接口还没开始，离月底还有 9 天。", people: [{ name: "小李", role: "财务对接" }], weeks: [{ label: "本周 · 至今 5 天", text: "和财务对了导出字段" }], at, runId: null }), mine.id);
  run(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,run_id,created_at,updated_at) values('nx_xiaolin1',?,?,?,'[]','ask','open',null,?,?)", mine.id, "和小李把剩下的字段对完", "财务月底要用新导出对账", at, at);
  const { addChange } = await import("../src/items/changes.ts");
  addChange(app, { itemId: fields.id, type: "decision", summary: "导出金额统一保留两位小数", origin: "owner" });
  const { askMemberProgress } = await import("../src/items/member-progress.ts");
  await askMemberProgress(app, { itemId: refundLine.id, member: xiaolin.id, question: "退款接口的联调到哪了？这周能完吗？" });
}

// ---- 今天 (items/today.ts): this morning's card, put together from all of the above ----------------
// Last night's work-state proposed one line; the assistant made a second candidate; one item expired.
const nightRun = createRun(app, { kind: "work-state", title: "整理近况" });
setRunOutput(app, nightRun.id, { lineProposals: [{ key: "p0", name: "示例商城 · 售后时效看板", goal: "把退款从申请到到账的每一段时长做成看板，找出最慢的一段", items: [], sources: [] }] });
run(app.db, "update runs set status = 'done' where id = ?", nightRun.id);
const cand2 = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "回复小李：回放用哪个月的数据", priority: 3 }, "agent");
run(app.db, "update items set status = 'candidate' where id = ?", cand2.id);
const stale = upsertItem(app, undefined, { spaceId: "shop", kind: "todo", title: "整理退款页的埋点清单", priority: 3 }, "user");
upsertItem(app, stale.id, { status: "expired", note: "自动过期：14 天没有新进展（待办的默认期限），最后一次进展在 11 月 3 日。有新进展会重新打开，也可以在事项页恢复。" }, "agent");
// Last night's profile review proposed two changes for the assistant; the metrics proposed above wait too.
{
  const { createProposal } = await import("../src/agents/proposals.ts");
  createProposal(app, { target: "assistant", kind: "settings", title: "问退款单时能直接搜原件", reason: "最近三次问退款单，本人都补了一句“去对账单里查”", content: { add_tools: ["scan"] }, runId: null });
  createProposal(app, { target: "assistant", kind: "prompt", title: "回答退款金额前先对一遍分摊口径", reason: "两次把满减按整单比例算错，本人纠正过", content: { prompt: "回答退款金额前，先读《退款改造需求》里的分摊口径，再算。" }, runId: null });
}
// The brief written before the card: its first paragraph.
await attachBrief(app, `今天最要紧的是回小李：上月退款单的回放用哪个月的数据，他排在推送之后等你一句话。已备好：对账单里金额对不上的 3 单查过了，都是满减按整单比例分摊的旧路径（[差异表](#/items/${refundLine.id})）。`);
await sendToday(app);

// ---- capture ----------------------------------------------------------------------------------
const server = await startServer(app, { port: Number(process.env.DEMO_PORT ?? 0), host: "127.0.0.1", quiet: true });
const url = app.baseUrl;
if (serveOnly) {
  const fl = await fastLane();
  console.log(`快速通道：${url}/#/rules/probes；${url}/#/rules?id=${FAST_RULE}；先看一眼 ${url}/#/runs/${fl?.lookRun}；持续跟进 ${url}/#/rules?id=situation:${DRILL}&tab=rounds、事项 ${url}/#/items/${fl?.drillItem}`);
  console.log(`演示数据：${url}/#/code/${r.id}（Ctrl+C 结束）；九轮的长交办 ${url}/#/code/${longWork}；流程 ${url}/#/items/${flowItem.id}；插件拦下的 ${url}/#/work/${blockedItem.id}、等标记的 ${url}/#/work/${waitingItem.id}（标记文件 ${join(home, "plugin-data", "stagekit", "ready.txt")}）；分头在做的 ${url}/#/runs/${boardAsk.id}、${url}/#/work/${flowItem.id}；分享页 ${url}/#/share/${shareToken}；数据页 ${url}/#/insights；各种图表 ${url}/#/ui/uv_charts_demo`);
  console.log(`向量和重排的假云端接口：${fakeApiUrl}（模型名写 missing-model 会失败）`);
  console.log(`以别人的身份看（演示令牌）：小周（只读观察者）${url}/?token=${xiaozhouToken}；小林（成员，另设几项）${url}/?token=${xiaolinToken}；小吴（成员）${url}/?token=${xiaowuToken}；本人带令牌（云端工具要它）${url}/?token=${ownerToken}`);
  const cleanup = async () => { await server.close(); for (const id of ["stagekit", "helperkit", "acmeauth"]) forgetPlugin(id); app.events.emit("close"); app.db.close(); closeVault(home); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); process.exit(); };
  process.once("SIGINT", cleanup); process.once("SIGTERM", cleanup);
  await new Promise(() => {});
}
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: process.platform === "win32" ? "msedge" : "chrome" });
// Network screenshots use fictional interfaces and an identity response; no real proxy or provider is contacted.
const networkDemo = networkPolicySchema.parse({ id: "jp-egress", name: "日本出口", backends: ["claude", "claude-cli"], connection: { type: "system" }, watch: { interface: "demo-tun" }, probe: { url: "https://claude.ai/cdn-cgi/trace" }, require: { countries: ["JP"] }, ipv6: { enabled: true }, dns: { enabled: true } });
async function prepareNetworkDemo(page: Page) {
  const checkedAt = new Date(Date.now() - 6 * 60000).toISOString();
  const states = [{ id: networkDemo.id, status: "ready", reason: null, localReason: null, ip: "203.0.113.10", country: "JP", checkedAt, runs: [], ipv6: { status: "unknown", checkedAt, observations: [], source: "dns.google", reason: "有 IPv6 地址但连不上，这台机器多半没有 IPv6 出口，请求会走 IPv4" }, dns: { status: "inspected", checkedAt, servers: ["192.0.2.53"], source: "操作系统各接口 DNS 配置", warnings: [] } }];
  await page.route("**/api/agents/network-policies", (route) => route.fulfill({ json: { policies: [networkDemo], states, interfaces: [{ name: "demo-tun", addresses: ["192.0.2.1"] }] } }));
  await page.route("**/api/agents/*/probe", (route) => route.fulfill({ json: { at: new Date().toISOString(), agent: "演示 Agent", models: ["default"], efforts: [] } }));
  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.home = "~/.omem";
    data.config.agents.networkPolicies = [networkDemo];
    data.agents = [
      { id: "claude", name: "Claude Code (ACP)", transport: "acp", command: "claude-agent-acp", args: [], installed: true },
      { id: "claude-cli", name: "Claude Code (CLI)", transport: "claude-cli", command: "claude", args: [], installed: true, source: "claude" },
      { id: "codex", name: "Codex (ACP)", transport: "acp", command: "codex-acp", args: [], installed: true },
    ];
    await route.fulfill({ json: data });
  });
}
/**
 * 远程 → 交给成员 (src/remote/grants.ts): the demo machine opens no real browser (that needs aad), so the
 * session list, its picture and the grant requests are answered here; members and their capabilities
 * are answered too, so the demo library's own members stay as the other shots show them.
 */
async function prepareRemoteDemo(page: Page) {
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const session = {
    id: "rs_demo1", kind: "browser", title: "退款后台 · 售后单", createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    browser: { name: "Chrome", url: "https://admin.example.com/refund/R1005", profile: "后台" }, window: null, recording: null, viewers: 2,
    ownerId: "owner", ownerName: "本人", mine: true, grant: null, runId: null, spaceId: null, connections: [],
    grants: [{ id: "rg_demo1", sessionId: "rs_demo1", userId: "xiaolin", userName: "小林", mode: "operate", expiresAt: at(1.5), connected: true }],
  };
  const agent = { ...session, id: "rs_demo2", title: "预发 · 退款申请页", browser: { name: "Chrome", url: "https://staging.example.com/refund/apply", profile: null }, viewers: 0, runId: "r_demo_check", spaceId: "shop", grants: [] };
  const sessions = [session, agent];
  const caps: Record<string, string[]> = { xiaozhou: ["remote.view"], xiaolin: ["remote.view", "remote.operate"], xiaowu: [] };
  await page.route("**/api/remote", (r) => r.fulfill({ json: { available: true, version: "0.0.9", sessions, profiles: ["后台"], windowAvailable: true } }));
  await page.route("**/api/remote/recordings", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/remote/browser-profiles", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/remote/sessions/*/view", (r) => {
    const id = r.request().url().split("/sessions/")[1].split("/")[0];
    const s = sessions.find((x) => x.id === id)!;
    return r.fulfill({ json: { ...s, src: `/remote/${id}/` } });
  });
  await page.route("**/remote/rs_demo*/", (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px/1.6 system-ui,sans-serif;background:#eef1f4;color:#1f2937}header{background:#1f2937;color:#fff;padding:10px 20px;font-weight:600}main{padding:20px}table{border-collapse:collapse;background:#fff;width:100%}td,th{border-bottom:1px solid #e5e7eb;padding:8px 12px;text-align:left}</style><header>示例商城 · 售后后台</header><main><h3>售后单 R1005</h3><table><tr><th>商品</th><th>状态</th><th>实付</th></tr><tr><td>短袖 T 恤 × 1</td><td>已发货</td><td>39.90</td></tr><tr><td>帆布包 × 1</td><td>未发货</td><td>59.00</td></tr></table><p>应退：39.90（只退已发货的行）</p></main>` }));
  const names: Record<string, string> = { xiaozhou: "小周", xiaolin: "小林", xiaowu: "小吴" };
  await page.route("**/api/remote/grant-candidates", (r) => r.fulfill({ json: Object.entries(caps).map(([id, list]) => ({ id, name: names[id], caps: list })).filter((c) => c.caps.length) }));
  await page.route("**/api/members/*/capabilities", (r) => {
    const id = decodeURIComponent(r.request().url().split("/api/members/")[1].split("/")[0]);
    return r.fulfill({ json: { preset: "member", overrides: [], caps: caps[id] ?? [], spaceCaps: {}, ownSpaceCaps: {}, effective: {} } });
  });
  await page.route("**/api/remote/sessions/*/grants**", async (r) => {
    const req = r.request();
    const body = req.postDataJSON?.() ?? {};
    const grantId = req.url().split("/grants/")[1];
    if (req.method() === "POST") {
      const name = { xiaozhou: "小周", xiaolin: "小林", xiaowu: "小吴" }[body.userId as string] ?? body.userId;
      session.grants.push({ id: `rg_${body.userId}`, sessionId: session.id, userId: body.userId, userName: name, mode: body.mode, expiresAt: at(body.hours ?? 2), connected: false });
    } else if (req.method() === "PATCH") {
      const g = session.grants.find((x) => x.id === grantId)!;
      if (body.mode) g.mode = body.mode;
      if (body.hours) g.expiresAt = at(body.hours);
    } else session.grants = session.grants.filter((x) => x.id !== grantId);
    await r.fulfill({ json: { ok: true } });
  });
}

const shots: { name: string; path: string; width?: number; dark?: boolean; space?: string; init?: Record<string, string>; before?: (page: Page) => Promise<void>; prepare?: (page: Page) => Promise<void> }[] = [
  { name: "item-flow", path: `/items/${flowItem.id}`, width: 1440, prepare: async (p) => { await p.getByRole("region", { name: "事项流程", exact: true }).scrollIntoViewIfNeeded(); } },
  // 流程里的插件: the checks of `local-check` on the flows page, and the item the check stopped (its card on top).
  { name: "flow-plugin-checks", path: "/flows", prepare: async (p) => { await p.getByRole("button", { name: /本机检查/ }).first().click(); await p.waitForTimeout(800); await p.locator("#flow-checks-title").evaluate((el) => el.closest("section")?.scrollIntoView({ block: "end" })); await p.waitForTimeout(400); } },
  { name: "flow-stage-blocked", path: `/work/${blockedItem.id}?tab=flow`, prepare: async (p) => { await p.getByText("被检查拦下").first().waitFor(); await p.waitForTimeout(600); } },
  // The start page (工作): the two lines, then 按时间, then one line's own page with 问这条线 open.
  { name: "work-overview", path: "/" },
  { name: "work-timeline", path: "/?view=time" },
  // 今天: this morning's card opened from 需要你处理, by sections, each choice to pick.
  { name: "today-card", path: "/", prepare: async (p) => { await p.locator("#work-waiting .li", { hasText: "今天 ·" }).first().click(); await p.waitForTimeout(800); } },
  // Below the lines: the one being watched, then the lines that ended, by month.
  { name: "work-ended", path: "/", init: { "omem.workEnded": "1" }, prepare: async (p) => {
    await p.locator(".watching").evaluate((el) => {
      el.scrollIntoView({ block: "start" });
      // A little of the last line above it shows where the group sits.
      let s: HTMLElement | null = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s ?? document.scrollingElement)?.scrollBy(0, -90);
    });
    await p.waitForTimeout(400);
  } },
  // 需求到交付 on the work item, opened, with the requirement pointed at: what it is linked to lights up.
  { name: "item-chain", path: `/work/${flowItem.id}`, prepare: async (p) => {
    await p.locator(".chain-sum").click();
    await p.locator(".item-chain").scrollIntoViewIfNeeded();
    await p.locator(".chain-col").first().locator(".chain-row").first().hover();
    await p.waitForTimeout(400);
  } },
  { name: "work-line", path: `/work/${refundLine.id}`, init: { "omem.workAsk": "1", "omem.lineAsk": JSON.stringify({ [refundLine.id]: lineChat }) } },
  // A 关注's settings, scrolled to the knobs: each with what it does in practice.
  { name: "listen-settings", path: `/listen/${dutyListen.id}?tab=settings`, prepare: async (p) => {
    await p.locator(".knobs-title").first().evaluate((el) => {
      el.scrollIntoView({ block: "start" });
      // The end of the brief above it shows where the knobs sit.
      let s: HTMLElement | null = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s ?? document.scrollingElement)?.scrollBy(0, -130);
    });
    await p.waitForTimeout(400);
  } },
  // A piece of work split into parts done side by side: who has each, the track of when they ran, one sent back.
  { name: "run-board", path: `/runs/${boardAsk.id}`, prepare: async (p) => {
    await p.locator(".pg-sum", { hasText: "任务板" }).click();
    await p.getByRole("button", { name: "看时间轴和报告" }).click();
    await p.locator(".tb .rows .row").nth(1).click();
    await p.locator(".tb").scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  } },
  // The whole work of that ask, block by block: the board, the delegation (T2 opened on its two tries), the review.
  { name: "progress-board", path: `/runs/${boardAsk.id}`, prepare: async (p) => {
    for (const kind of ["任务板", "编码交办"]) await p.locator(".pg-sum", { hasText: kind }).click();
    await p.getByRole("button", { name: "第 2 次" }).first().click();
    await p.locator(".pg").scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  } },
  // The same on the requirement's work page (在做的), next to its flow.
  { name: "work-progress", path: `/work/${flowItem.id}`, prepare: async (p) => {
    await p.locator(".pg-sum", { hasText: "需求交付" }).click();
    await p.locator(".pg-sum", { hasText: "退款日志写明走了哪条分摊路径" }).filter({ hasText: "编码交办" }).click();
    await p.locator(".pg").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await p.waitForTimeout(400);
  } },
  { name: "insights", path: "/insights?tab=omem", space: "personal" },
  // One number opened in the drawer: by day, split by scene / space / model / who, then its records.
  { name: "insights-detail", path: "/insights?tab=omem&detail=usage%3Atotal", space: "personal", prepare: async (p) => {
    await p.locator(".sheet .splits").waitFor();
    await p.waitForTimeout(600);
  } },
  // The proposals to decide, by line; one opened: its chart by device, why it exists, where it came from, 保留 / 改 / 不要.
  { name: "insights-work", path: "/insights?tab=work", space: "shop", prepare: async (p) => {
    await p.locator("button.c-name", { hasText: "退款申请完成率" }).click();
    await p.waitForTimeout(900);
    await p.locator(".c-row.on").evaluate((row) => {
      const el = row.closest(".c-group") ?? row;
      let s: HTMLElement | null = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s ?? document.scrollingElement)?.scrollBy(0, el.getBoundingClientRect().top - 24);
    });
    await p.waitForTimeout(300);
  } },
  // A report the assistant wrote (a work file under 数据/报表/), its two charts drawn in the drawer.
  { name: "insights-report", path: "/insights?tab=work", space: "shop", prepare: async (p) => {
    await p.getByRole("button", { name: /报表/ }).click();
    await p.locator(".sheet .prose").waitFor();
    await p.waitForTimeout(1200);
  } },
  { name: "ask-citations", path: `/ask/${t.id}` },
  { name: "wiki-tree", path: "/wiki/shop/refund/cases/partial-shipment-over-refund" },
  { name: "wiki-tree-mobile", path: "/wiki/shop/refund/cases/partial-shipment-over-refund", width: 390, prepare: async (p) => { await p.getByRole("button", { name: "目录" }).click(); await p.waitForTimeout(400); } },
  { name: "search-hits", path: "/", prepare: async (p) => { await p.keyboard.press("Control+k"); await p.getByPlaceholder(/搜索原件/).fill("尾差 分摊"); await p.waitForTimeout(1500); } },
  { name: "wiki-citations", path: "/wiki/shop/refund/amount", prepare: async (p) => { await p.getByText("refund.js 第 10–21 行").first().click(); await p.waitForTimeout(1000); } },
  { name: "citations-table", path: "/wiki/shop/refund/confirmation", prepare: async (p) => {
    await p.getByText("第 7—29 项确认表").click();
    await p.locator(".drawer .cited-lines table").waitFor();
    if (await p.locator(".drawer table tbody tr").count() !== 29) throw new Error("确认表没有完整渲染");
    await p.locator(".drawer table").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await p.waitForTimeout(400);
  } },
  { name: "sources", path: `/sources/${prd}` },
  { name: "sources-catalog", path: `/sources/${kbPrd}`, space: "refund", init: { "omem.sourceTree.refund": JSON.stringify(["wiki:kb_demo", "wn:wn_root", "wn:wn_refund", "chat:group", "chat:oc_demo_team", "lark-drive", "@refund-web@", "@refund-web@dir:src"]) } },
  { name: "sources-review", path: `/sources/${kbOld}`, space: "refund", prepare: async (p) => { await p.getByRole("button", { name: /待复核/ }).click(); await p.waitForTimeout(600); } },
  { name: "memory", path: "/memory" },
  { name: "items", path: `/items/${item.id}` },
  { name: "requirements-loading", path: `/code/reqs/${requirementPages.apply}`, prepare: async (p) => {
    await p.route(`**/api/requirements/${requirementPages.records}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue().catch(() => {});
    });
    await p.locator(".list-col .pick").filter({ hasText: "退款记录页" }).click();
    await p.locator("main.detail [aria-busy='true']").waitFor();
  } },
  { name: "review-overview", path: `/code/${r.id}` },
  { name: "review-checks", path: `/code/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: "评审" }).click(); await p.locator(".chead").nth(1).click(); await p.waitForTimeout(300); } },
  { name: "review-change", path: `/code/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.locator(".pick", { hasText: "补测试与说明" }).click(); await p.waitForTimeout(900); await p.getByRole("button", { name: "下一处" }).click(); await p.waitForTimeout(1200); } },
  { name: "review-split-diff", path: `/code/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.getByRole("radio", { name: "左右" }).click(); await p.getByRole("radio", { name: "文件" }).click(); await p.locator(".tree .row-btn.file").first().click(); await p.waitForTimeout(1200); } },
  { name: "review-activity", path: `/code/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: "活动" }).click(); await p.waitForTimeout(500); await p.locator(".seg-head").last().click(); await p.waitForTimeout(300); await p.locator(".sess-head").nth(1).click(); await p.waitForTimeout(300); } },
  // A long delegation in its ninth round: the stage review check by check, and the round split into coding, the host's check and the review.
  { name: "code-work-stage-review", path: `/code/${longWork}`, prepare: async (p) => { await p.getByRole("tab", { name: "评审" }).click(); await p.waitForTimeout(600); await p.evaluate(() => document.querySelector("nav.tabs")?.scrollIntoView({ block: "start" })); await p.waitForTimeout(200); } },
  { name: "code-work-round", path: `/code/${longWork}`, prepare: async (p) => { await p.getByRole("tab", { name: /活动/ }).click(); await p.waitForTimeout(600); await p.locator(".seg-head").first().click(); await p.waitForTimeout(300); await p.evaluate(() => document.querySelector(".seg-head")?.scrollIntoView({ block: "start" })); await p.waitForTimeout(200); } },
  { name: "run-context", path: `/code/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: "活动" }).click(); await p.waitForTimeout(500); const s = p.locator("details.usage summary"); await s.click(); await s.scrollIntoViewIfNeeded(); await p.waitForTimeout(300); } },
  { name: "review-quotes", path: `/code/${r.id}`, prepare: async (p) => {
    await p.getByRole("tab", { name: /变更/ }).click();
    await p.locator(".pick").first().click();
    await p.waitForTimeout(1500);
    const select = async (sel: string, nth: number) => {
      await p.evaluate(([s, n]) => {
        const el = Array.from(document.querySelectorAll(s as string)).filter((e) => e.textContent!.trim())[n as number]!;
        const range = document.createRange(); range.selectNodeContents(el);
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, [sel, nth]);
      await p.waitForTimeout(250);
    };
    await select(".dfile td.code", 9);
    await p.getByRole("button", { name: /加入提问/ }).click();
    await p.getByRole("button", { name: "缩小" }).click();
    await select(".pt", 2);
    await p.getByRole("button", { name: /加入提问/ }).click();
    await p.locator(".dock .btn").first().click();
    await p.locator("textarea[aria-label='问题']").fill("[1] 这里换算成分的时候，[2] 的尾差会不会出现负数？");
    await p.waitForTimeout(300);
  } },
  { name: "delegate-sync", path: "/code", prepare: async (p) => { await p.getByRole("button", { name: "交办" }).first().click(); await p.waitForTimeout(400); await p.locator("textarea").first().fill("把 main 合并进来，再把退款精度改成超出两位小数报错"); await p.getByText("拉取目标分支在 origin 上的新提交").click(); await p.waitForTimeout(300); } },
  { name: "rules", path: `/rules?id=${rule.id}` },
  { name: "meeting-rule-confirmation", path: `/rules?id=${meetingRule.id}`, prepare: async (p) => { await p.getByText("入会确认", { exact: true }).scrollIntoViewIfNeeded(); } },
  { name: "agents", path: "/agents" },
  { name: "ai-network-conditions", path: "/settings?tab=agents&focus=network-conditions", before: prepareNetworkDemo, prepare: async (p) => { await p.locator(".be-head", { hasText: "Claude Code" }).click(); await p.waitForTimeout(400); await p.locator(".be.open").scrollIntoViewIfNeeded(); } },
  { name: "ai-network-conditions-mobile", path: "/settings?tab=agents&focus=network-conditions", width: 390, before: prepareNetworkDemo, prepare: async (p) => { await p.locator(".be-head", { hasText: "Claude Code" }).click(); await p.locator(".be.open").getByRole("button", { name: "编辑", exact: true }).click(); await p.locator(".net-editor").scrollIntoViewIfNeeded(); if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("网络条件表单横向溢出"); } },
  // 设置 → 安全: the rules in the order they apply (two from a pack), the packs below, one with a newer version.
  { name: "security-rules", path: "/settings?tab=security", before: async (p) => {
    // The page head shows the data directory: not the throwaway one's real path.
    await p.route("**/api/settings", async (route) => {
      const data = await (await route.fetch()).json();
      data.home = "~/.omem";
      await route.fulfill({ json: data });
    });
  }, prepare: async (p) => {
    await p.locator("#set-operation-rules .op").first().waitFor();
    await p.waitForTimeout(400);
  } },
  { name: "ask-question", path: `/ask/${decide.id}` },
  { name: "ask-form", path: `/ask/${rollout.id}`, prepare: async (p) => { await p.waitForTimeout(800); await p.getByText("先灰度 10%").click(); await p.getByText("逐条确认退款规则").scrollIntoViewIfNeeded(); await p.waitForTimeout(300); } },
  { name: "ask-view", path: `/ask/${rollout.id}`, prepare: async (p) => { await p.waitForTimeout(800); await p.locator(".ui-view").first().scrollIntoViewIfNeeded(); await p.waitForTimeout(300); } },
  { name: "ask-page", path: `/ask/${proto.id}`, prepare: async (p) => { await p.waitForTimeout(1500); await p.locator(".ui-page").scrollIntoViewIfNeeded(); await p.waitForTimeout(500); } },
  { name: "plugin-english", path: `/plugin/english?session=${tutor.conversationId}`, prepare: async (p) => { await p.waitForTimeout(1500); } },
  // Speaking practice inside the English page: an assessed talk (a voice model configured), and starting one without a voice model yet.
  { name: "english-speaking", path: `/plugin/english?session=${talk.conversationId}`, before: async (p) => void (await p.route("**/api/plugins/english/voice", (r) => r.fulfill({ json: { allowed: true, ready: true, detail: "", api: "live", model: "gpt-live-1" } }))), prepare: async (p) => { await p.waitForTimeout(1500); } },
  { name: "english-speaking-setup", path: `/plugin/english?session=${talk.conversationId}`, prepare: async (p) => {
    const f = p.frameLocator("iframe");
    await f.getByRole("button", { name: "新练习" }).click();
    await f.getByRole("radio", { name: "口语对话" }).click();
    await f.getByText("语音模型还没配好").waitFor();
    await p.waitForTimeout(300);
  } },
  { name: "plugin-default", path: `/plugin/journal?session=${journal.conversationId}`, space: "personal", prepare: async (p) => { await p.waitForTimeout(1500); } },
  { name: "share-link", path: `/share/${shareToken}` },
  { name: "share-link-mobile", path: `/share/${shareToken}/1`, width: 390 },
  // The docs home's hero: these three in dark too.
  { name: "ask-citations-dark", path: `/ask/${t.id}`, dark: true },
  { name: "memory-dark", path: "/memory", dark: true },
  { name: "sources-dark", path: `/sources/${prd}`, dark: true },
  { name: "design-own", path: `/code/designs/${ownDesign.id}` },
  { name: "design-external", path: `/code/designs/${extDesign.id}` },
  { name: "review-change-mobile", path: `/code/${r.id}`, width: 390, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.waitForTimeout(400); } },
  // 评审页：问题发到合并请求以后的状态，和发布、读讨论的入口。
  { name: "review-sync", path: `/code/${r.id}`, prepare: async (p) => {
    await p.locator(".rsync").waitFor();
    await p.locator(".rsync").scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  } },
  // 设置 → 安全 → 记录: the trail with one row open.
  { name: "security-audit", path: "/settings?card=trail", prepare: async (p) => {
    const card = p.locator("#set-trail");
    await card.locator("button.au-row").nth(1).click();
    await card.scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  } },
  // 事项同步, last: subscribing through the page reads the demo platform, and the items it brings in stay out of the shots above.
  { name: "item-sync", path: "/settings?card=item-sync", prepare: async (p) => {
    const card = p.locator("#set-item-sync");
    if (!(await card.locator(".sync").count())) {
      await card.getByRole("button", { name: "订阅" }).click();
      await card.getByRole("combobox", { name: "读什么" }).click();
      await p.getByRole("option", { name: "示例工单平台" }).click();
      await card.getByRole("textbox").fill("shop/refund");
      await card.getByRole("radio", { name: "直接建" }).click();
      await card.getByRole("button", { name: "订阅", exact: true }).click();
    } else await card.locator(".sync-row").first().click();
    await card.locator(".sync.open").waitFor();
    await card.scrollIntoViewIfNeeded();
    await p.locator(".toast").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
  } },
  // 插件参与检索: two recall routes turned on through the page (one limited to a space), a search so
  // each shows its last call (one of them fails on purpose), and the plugin's reranker picked.
  { name: "search-providers", path: "/settings?card=search-providers", prepare: async (p) => {
    const card = p.locator("#set-search-providers");
    await card.waitFor();
    for (const name of ["示例资料库检索参与召回", "相似工单参与召回"]) {
      const sw = card.getByRole("switch", { name });
      if ((await sw.getAttribute("aria-checked")) !== "true") { await sw.click(); await p.waitForTimeout(400); }
    }
    await card.getByRole("combobox", { name: "示例资料库检索对哪些空间生效" }).click();
    await p.getByRole("option", { name: /示例商城/ }).click();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    const rerankCard = p.locator("#set-rerank");
    const rr = rerankCard.getByRole("switch", { name: "开启重排" });
    if ((await rr.getAttribute("aria-checked")) !== "true") { await rr.click(); await p.waitForTimeout(400); }
    if ((await rerankCard.getByRole("radio", { name: "插件" }).getAttribute("aria-checked")) !== "true") {
      await rerankCard.getByRole("radio", { name: "插件" }).click();
      await rerankCard.getByRole("button", { name: "保存" }).click();
      await p.waitForTimeout(400);
    }
    await p.evaluate(async () => {
      await fetch("/api/search?q=" + encodeURIComponent("部分发货 退款") + "&space=shop");
    });
    await p.reload();
    await card.waitFor();
    await p.locator(".toast").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await card.scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // 设置 → 检索与记忆: vectors from the cloud API (the local stand-in above), tried before saving; reranking
  // turned on with the same service, tried too. Nothing is saved: changing the vector model asks first.
  { name: "settings-search-providers", path: "/settings?card=embeddings", before: async (p) => {
    // The page head names the data directory: the demo's temporary one is a path on this machine.
    await p.route("**/api/settings", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      const data = await response.json();
      if (route.request().method() === "GET") data.home = "~/.omem";
      // The address shown for 示例云 (the placeholder and the key's hint) is the local stand-in's, with a random
      // port: shown as a fixed one, in what reading and saving (turning reranking on) return. Only the page sees
      // it; the server still calls the stand-in.
      for (const provider of data.config?.ai?.providers ?? []) if (provider.id === "demo-cloud") provider.baseUrl = "https://api.example.com/v1";
      await route.fulfill({ response, json: data });
    });
  }, prepare: async (p) => {
    const vec = p.locator("#set-embeddings");
    await vec.getByRole("radio", { name: "云端接口" }).click();
    await vec.getByRole("combobox", { name: "向量接口的密钥" }).click();
    await p.getByRole("option", { name: /示例云/ }).click();
    await vec.getByRole("textbox", { name: "向量模型名" }).fill("demo-embed");
    await vec.getByRole("button", { name: "试一下" }).click();
    await vec.getByText(/能用：/).waitFor();
    const rr = p.locator("#set-rerank");
    const on = rr.getByRole("switch", { name: "开启重排" });
    if ((await on.getAttribute("aria-checked")) !== "true") { await on.click(); await p.waitForTimeout(400); }
    await rr.getByRole("radio", { name: "云端接口" }).click();
    await rr.getByRole("combobox", { name: "重排接口的密钥" }).click();
    await p.getByRole("option", { name: /示例云/ }).click();
    await rr.getByRole("textbox", { name: "重排模型名" }).fill("demo-rerank");
    await rr.getByRole("button", { name: "试一下" }).click();
    await rr.getByText(/能用：/).waitFor();
    await p.locator(".toast").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await vec.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await p.waitForTimeout(300);
  } },
  // 设置 → 设备 → 接别的设备派来的活: this machine takes read-only work; lab-mac is set apart to take none.
  // This machine's own name and addresses are answered with made-up ones (the page head of the 设备 tab shows them).
  { name: "settings-devices-work", path: "/settings?card=accept-work", before: async (p) => {
    await p.route("**/api/peers", async (route) => {
      const data = await (await route.fetch()).json();
      await route.fulfill({ json: { ...data, node: "studio", urls: ["http://192.0.2.10:4317"] } });
    });
    await p.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const data = await (await route.fetch()).json();
      data.home = "~/.omem";
      await route.fulfill({ json: data });
    });
  }, prepare: async (p) => {
    const card = p.locator("#set-accept-work");
    await card.locator(".aw-row").first().waitFor();
    await card.getByRole("radiogroup", { name: "接不接别的设备派来的活" }).getByRole("radio", { name: "只接只读" }).click();
    await p.waitForTimeout(400);
    await card.getByRole("radiogroup", { name: "lab-mac 派来的活" }).getByRole("radio", { name: "不接" }).click();
    await p.waitForTimeout(400);
    await p.locator(".toast").evaluateAll((els) => els.forEach((el) => el.remove()));
    await card.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await p.waitForTimeout(300);
  } },
  // 远程 → 交给成员: 小林 already operates it; 小周 is handed it to watch for two hours through the sheet.
  { name: "remote-grants", path: "/remote", before: prepareRemoteDemo, prepare: async (p) => {
    await p.getByRole("button", { name: /交给成员/ }).click();
    const sheet = p.getByRole("dialog", { name: "交给成员" });
    await sheet.getByRole("combobox", { name: "交给谁" }).click();
    await p.getByRole("option", { name: /小周/ }).click();
    await sheet.getByRole("radio", { name: "2 小时" }).click();
    await sheet.getByRole("button", { name: "交给他" }).click();
    await sheet.getByText("小周").first().waitFor();
    await p.locator(".toast").waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(300);
  } },
  // A source a plugin read as a table: one row picked, so its lines and citation show above the table.
  { name: "source-table", path: `/sources/${sampleTable}`, prepare: async (p) => {
    await p.getByRole("row", { name: /R1005/ }).click();
    await p.waitForTimeout(500);
  } },
  // An item that came from the platform, closed on this side: the write-back waits for a yes.
  // What a member may do (components/MemberCaps.vue): 小林's capabilities, one space opened.
  { name: "members-capabilities", path: "/settings?tab=members", before: async (p) => {
    // The page head names the data directory: the demo's temporary one is a path on this machine.
    await p.route("**/api/settings", async (route) => {
      const data = await (await route.fetch()).json();
      data.home = "~/.omem";
      await route.fulfill({ json: data });
    });
  }, prepare: async (p) => {
    await p.getByRole("button", { name: "小林能做什么" }).click();
    await p.locator(".mc-cap").first().waitFor();
    await p.locator(".mc-cap", { hasText: "看事项" }).getByRole("button", { name: /空间另设/ }).click();
    await p.waitForTimeout(300);
  } },
  // 设置 → 通知与打扰 → 通知出口: the demo plugin's two outlets under the built-in ones, the second opened.
  { name: "settings-outlets", path: "/settings?card=notify-outlets", prepare: async (p) => {
    await p.locator("#set-notify-outlets .ol").first().waitFor();
    await p.getByRole("button", { name: "手机推送（演示）的更多设置" }).click();
    await p.locator("#set-notify-outlets").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // 设置 → 安全 → 出网代理. The demo machine has no sandbox, so this machine's support and the runs' hosts
  // are answered here (fictional hosts); saving still goes to the demo server.
  { name: "settings-egress", path: "/settings?card=egress", before: async (p) => {
    await p.route("**/api/security/egress", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const data = await (await route.fetch()).json();
      const host = (h: string, count: number, denied = 0) => ({ host: h, count, bytes: count * 2048, denied, backend: false, ...(denied ? { lastDeniedAt: Date.now() - 40 * 60_000, error: "没有规则放行" } : {}) });
      await route.fulfill({ json: { ...data, support: { ok: true }, inspect: data.inspect.length ? data.inspect : ["api.example.com"], inspectionAvailable: true,
        runs: [{ runId: r.id, title: "核对退款金额的分摊口径", hosts: [host("registry.npmjs.org", 42), host("api.example.com", 6, 2), host("github.com", 3)] }, { runId: null, title: null, hosts: [host("pypi.org", 8)] }],
        denied: [{ runId: r.id, title: "核对退款金额的分摊口径", host: "api.example.com", count: 2, at: Date.now() - 40 * 60_000, reason: "没有规则放行" }] } });
    });
  }, prepare: async (p) => {
    await p.locator("#set-egress .eg-run-row").first().click();
    await p.locator("#set-egress").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // 设置 → 安全 → 运行的沙箱 and 完全访问. The demo machine is not Linux (no sandbox there), so the status is
  // answered here as a Linux machine with bubblewrap would answer it (fictional home directory, the folders
  // a run gets and two backends' state); saving still goes to the demo server.
  { name: "settings-sandbox", path: "/settings?card=sandbox", before: async (p) => {
    const home = "/home/demo", data = `${home}/.omem`;
    await p.route("**/api/security/sandbox", (route) => route.request().method() !== "GET" ? route.fallback() : route.fulfill({ json: {
      mode: "prefer", writable: [`${home}/work/tools`, `${home}/.config/acme`], hidden: [`${home}/.ssh`], fullAccess: "sandboxed",
      support: { ok: true, bwrap: "/usr/bin/bwrap", version: "0.9.0" },
      backends: [{ id: "codex", state: [`${home}/.codex`] }, { id: "claude", state: [`${home}/.claude`, `${home}/.claude.json`] }],
      defaults: { exampleBackend: "codex", writable: [`${home}/.codex`, `${home}/.cache`, `${home}/.npm`, `${home}/.local/share/pnpm/store`, `${data}/runs/example/scratch`, `${data}/artifacts/inbox/example`, `${data}/workspaces/example/1`, "/tmp"], hidden: [data] },
    } }));
  }, prepare: async (p) => {
    await p.locator("#set-sandbox .sbx-line").first().waitFor();
    await p.getByRole("button", { name: /各后端的状态目录/ }).click();
    await p.locator("#set-sandbox").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // 设置 → 安全 → 云端后端调只读工具: the owner with a token. The demo has no public address or cloud
  // backend, so the status is answered here with a fictional one.
  { name: "settings-cloud-tools", path: "/settings?card=cloud-tools", init: { "omem-token": ownerToken }, before: async (p) => {
    await p.route("**/api/cloud-tools", (route) => route.fulfill({ json: {
      enabled: true, tools: ["search", "read_source"], ttlMinutes: 15, maxCalls: 32, backends: ["doubao-cloud"], credentialIn: "channel",
      url: "https://omem.example.com", addressError: null, activeCredentials: 1,
      recent: [{ runId: r.id, title: "核对退款金额的分摊口径", calls: 5, errors: 1, lastError: "read_source：没有这一行（演示）", at: new Date(Date.now() - 25 * 60_000).toISOString() }],
      availableTools: [
        { name: "search", description: "在知识库中检索：原件片段、Wiki 页面、记忆、需求点。" },
        { name: "read_source", description: "读取一个来源的内容：原件按行读。" },
        { name: "read_page", description: "读取 Wiki 页面全文，以及反向链接。" },
        { name: "read_item", description: "读取一件事项的全貌。" },
      ],
      profiles: [
        { backend: "doubao-cloud", probe: { id: "p1", url: "https://omem.example.com", at: new Date(Date.now() - 2 * 86400_000).toISOString(), mode: "header", reason: "", confirmed: true } },
        { backend: "web-agent", probe: { id: "p2", url: "https://omem.example.com", at: new Date(Date.now() - 3600_000).toISOString(), mode: "url", reason: "", confirmed: false }, reason: "需要本人确认当前地址的成功探测" },
      ],
    } }));
  }, prepare: async (p) => {
    await p.locator("#set-cloud-tools .ct-backend").first().waitFor();
    await p.locator("#set-cloud-tools").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // 账号 → 凭据 as 小林 sees it: the example account soon to end (lent to everyone), the code host not logged
  // in yet, and below them the AI backend the example account supplies. Whether the example's install
  // directory exists depends on the machine taking the shot: it is left out here.
  { name: "account-credentials", path: "/account", init: { "omem-token": xiaolinToken }, before: async (p) => {
    await p.route("**/api/credentials", async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const data = await (await route.fetch()).json();
      for (const c of data.credentials) c.missingInstall = [];
      await route.fulfill({ json: data });
    });
  }, prepare: async (p) => {
    await p.locator(".cred").first().waitFor();
    await p.locator(".cred-title").evaluate((el) => {
      el.scrollIntoView({ block: "start" });
      let s: HTMLElement | null = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      (s ?? document.scrollingElement)?.scrollBy(0, -24);
    });
    await p.waitForTimeout(400);
  } },
  // The settings page as 小林 sees it: only the assistant area, and in it what only the owner changes stays read-only.
  { name: "settings-member", path: "/settings?tab=reply", init: { "omem-token": xiaolinToken }, prepare: async (p) => {
    await p.locator("#set-guests").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
  } },
  // The owner's lines as the read-only observer 小周 sees them (src/items/member-work.ts).
  { name: "observer-work", path: "/", init: { "omem-token": xiaozhouToken } },
  // A member's work page: 小林's own line, the owner's he may read, and what waits for him on the right.
  { name: "work-member", path: "/", init: { "omem-token": xiaolinToken } },
  { name: "item-external", path: "/items", prepare: async (p) => {
    const id = await p.evaluate(async () => {
      const json = (path: string, method = "GET", body?: unknown) => fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
      const t = await json("/api/item-sync", "PUT", { provider: "tracker:issues", target: "shop/refund", spaceId: "shop", importMode: "direct", mode: "confirm", enabled: true });
      await json(`/api/item-sync/${t.id}/pull`, "POST", {});
      const item = (await json("/api/items?space=shop&q=" + encodeURIComponent("金额显示成负数"))).find((i: { title: string }) => i.title.includes("金额显示成负数"));
      await json(`/api/items/${item.id}`, "PATCH", { status: "done" });
      return item.id as string;
    });
    await p.goto(`${url}/#/items/${id}`);
    await p.locator(".ext-write").waitFor();
    await p.locator(".item-external").scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  } },
  // 快速通道 and 持续跟进 (seeded just before, see fastLane): the probe library with a sample filled in, a rule
  // that looks first, and a 持续跟进 rule — its settings and its follow-ups (各次).
  { name: "probes", path: "/rules/probes?name=refund-order", before: seedFastLane, prepare: async (p) => {
    await p.getByLabel("示例消息").fill("R1005 退了 312 元，比应退多了 60，麻烦看下");
    await p.waitForTimeout(300);
  } },
  { name: "rule-first-look", path: `/rules?id=${FAST_RULE}`, before: seedFastLane, prepare: async (p) => { await p.locator(".fast").first().scrollIntoViewIfNeeded(); await p.waitForTimeout(300); } },
  { name: "situation-rule", path: `/rules?id=situation:${DRILL}`, before: seedFastLane },
  { name: "situation-rounds", path: `/rules?id=situation:${DRILL}&tab=rounds`, before: seedFastLane },
];
let failed = 0;
let overflowCount = 0;
for (const s of shots.filter((s) => !only || only.includes(s.name))) {
  const width = s.width ?? 1440;
  // Reduced motion: charts are captured drawn, not mid-entrance.
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: s.dark ? "dark" : "light", deviceScaleFactor: width < 600 ? 2 : 1, reducedMotion: "reduce" });
  // Every page opens on the demo project's space.
  await page.addInitScript(([space, init]) => {
    localStorage.setItem("omem-space", space);
    for (const [k, v] of Object.entries(init)) localStorage.setItem(k, v);
  }, [s.space ?? "shop", s.init ?? {}] as const);
  await page.route(`**/api/rules/${meetingRule.id}/permissions`, route => route.fulfill({ json: { issues: [], ok: ["演示数据：会议权限已配置"], notes: ["会议需要允许智能体加入"] } }));
  try {
    if (s.before) await s.before(page);
    await page.goto(`${url}/#${s.path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    if (s.prepare) await s.prepare(page);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    console.log(`${s.name}.png`);
    // The same check as scripts/screens.ts: printed with each shot (the shots are not failed for it).
    const issues = await overflowIssues(page);
    overflowCount += issues.length;
    if (issues.length) console.log(overflowReport(`  ${s.name}`, issues, 10));
  } catch (e) {
    failed++;
    console.error(`${s.name}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
await server.close();
// The isolated plugins (stagekit) run in their own processes inside it: stop them before the directory goes.
for (const id of ["stagekit", "helperkit", "acmeauth"]) forgetPlugin(id);
app.events.emit("close");
app.db.close();
// The members' credentials put secrets in the vault: its file is open until closed (Windows will not delete it).
closeVault(home);
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
if (overflowCount) console.log(`截图页面上共 ${overflowCount} 处溢出（见上；细查用 node scripts/screens.ts 对着 --serve 的地址）`);
if (failed) process.exitCode = 1;
