/**
 * Feature screenshots for the docs site and README:
 *
 *   pnpm run build && node scripts/doc-screens.ts [outDir]
 *
 * Seeds a throwaway data directory with a fictional project (示例商城 · 退款改造: a requirement, a
 * technical plan, a group chat, code, a Wiki page, memories, items, a reviewed delegation, a rule),
 * serves the built web on it and captures each feature at 1440×900 (light). Nothing real is shown,
 * so the images can be published. When a page changes, run it again; the file names stay the same.
 * Uses the installed Edge or Chrome (CHROMIUM=path to override).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { recordReview } from "../src/agents/review.ts";
import { addRunEvent, createRun, setRunOutput } from "../src/agents/runs.ts";
import { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { createSpace, ensurePersonalSpace } from "../src/core/spaces.ts";
import { addItemEvent, upsertItem } from "../src/items/store.ts";
import { remember } from "../src/memory/store.ts";
import { saveRule } from "../src/rules/store.ts";
import { startServer } from "../src/server/http.ts";
import { upsertSource } from "../src/sources/store.ts";
import { writePage } from "../src/wiki/store.ts";

const out = resolve(process.argv[2] ?? "site/public/screens");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "omem-screens-"));
const app = App.open(home);
ensurePersonalSpace(app);

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
upsertSource(app, { spaceId: "personal", kind: "note", uri: "note:weekly", title: "本周计划", text: "- 周四前上线退款改造\n- 周五和小王对一下发货状态的接口\n" });
upsertSource(app, { spaceId: "shop", kind: "doc", uri: "docs/优惠券规则.md", title: "优惠券规则", text: "# 优惠券规则\n\n满减券按订单实付金额计算门槛。\n" });

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
  { id: "C1", title: "只退已发货的行", status: "done", requirement: "退款只计算已发货的行；未发货的行走取消流程（[需求](src:" + prd + "#L7-L7)）", implementation: "refundLineAmounts 先按 shipped 过滤", refs: [`src:${prd}#L7-L7`], locations: [{ file: "refund.js", start: 10, end: 11 }] },
  { id: "C2", title: "优惠按实付比例分摊", status: "done", requirement: "订单级优惠按各行实付金额比例分摊（[需求](src:" + prd + "#L8-L8)）", implementation: "按 amount / total 计算每行份额", refs: [`src:${prd}#L8-L8`], locations: [{ file: "refund.js", start: 13, end: 20 }] },
  { id: "C3", title: "尾差归最后一行", status: "partial", requirement: "分摊的尾差归最后一行（[需求](src:" + prd + "#L9-L9)）", implementation: "最后一行取剩余额；分摊结果为负时没有处理", refs: [`src:${prd}#L9-L9`], locations: [{ file: "refund.js", start: 16, end: 19 }] },
  { id: "C4", title: "金额精度两位小数", status: "partial", requirement: "超出精度直接报错，不四舍五入（[需求](src:" + prd + "#L10-L10)）", implementation: "toCents 用 Math.round，12.345 不会报错", refs: [`src:${prd}#L10-L10`], locations: [{ file: "refund.js", start: 2, end: 7 }] },
  { id: "C5", title: "补测试与说明", status: "done", requirement: "验收用例（[需求](src:" + prd + "#L12-L14)）", implementation: "test.js 覆盖三条验收", refs: [], locations: [{ file: "test.js", start: 4, end: 9 }, { file: "README.md", start: 5, end: 7 }] },
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
addRunEvent(app, r.id, "status", { text: "独立评审中：「完整」档，功能、业务、架构、历史、规范" });
for (const c of checks) {
  tools[c].forEach((title, i) => {
    addRunEvent(app, r.id, "tool", { id: `${c}-${i}`, title, status: "completed", phase: "reviewer", check: c });
  });
  addRunEvent(app, r.id, "text", { text: findings[c].length ? `结论：需要修改。${findings[c][0].title}。` : "结论：通过。", phase: "reviewer", check: c });
}
addRunEvent(app, r.id, "tool", { id: "lead-0", title: "rule_review", status: "completed", phase: "lead" });
addRunEvent(app, r.id, "text", { text: "接受两个严重问题，驳回规范项的注释建议；下一轮只复审功能和业务。", phase: "lead" });
run(app.db, "update runs set status = 'done', finished_at = ? where id = ?", new Date().toISOString(), r.id);

// ---- a rule -----------------------------------------------------------------------------------
const rule = saveRule(app, {
  name: "值班群 @ 我时先整理上下文",
  description: "值班群里有人 @ 我时，先读这条消息前后的讨论和相关文档，整理成问题、已知信息和建议的下一步，发给我确认后再回复。",
  enabled: true,
  trigger: { event: "message", once: "event", waitMinutes: 5, unless: ["owner-engaged", "answered"] },
  conditions: { all: [{ field: "chat.name", op: "contains", value: "值班" }, { field: "message.mentionsOwner", op: "is", value: true }] },
  judge: "code",
  actions: [{ type: "agent", spec: "assistant", task: "整理问题和下一步", reply: "draft", ownTopic: true }],
} as never);

// ---- capture ----------------------------------------------------------------------------------
const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
const url = app.baseUrl;
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: process.platform === "win32" ? "msedge" : "chrome" });
const shots: { name: string; path: string; width?: number; dark?: boolean; prepare?: (page: Page) => Promise<void> }[] = [
  { name: "today", path: "/" },
  { name: "ask-citations", path: `/ask/${t.id}` },
  { name: "wiki-citations", path: "/wiki/shop/refund/amount", prepare: async (p) => { await p.getByText("refund.js 第 10–21 行").first().click(); await p.waitForTimeout(1000); } },
  { name: "sources", path: `/sources/${prd}` },
  { name: "memory", path: "/memory" },
  { name: "items", path: `/items/${item.id}` },
  { name: "review-overview", path: `/runs/${r.id}` },
  { name: "review-checks", path: `/runs/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: "评审" }).click(); await p.locator(".check-head").nth(1).click(); await p.waitForTimeout(300); } },
  { name: "review-change", path: `/runs/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.locator(".pick").nth(2).click(); await p.waitForTimeout(1200); } },
  { name: "review-split-diff", path: `/runs/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.getByRole("radio", { name: "左右" }).click(); await p.getByRole("radio", { name: "文件" }).click(); await p.locator(".tree .row-btn.file").first().click(); await p.waitForTimeout(1200); } },
  { name: "review-activity", path: `/runs/${r.id}`, prepare: async (p) => { await p.getByRole("tab", { name: "活动" }).click(); await p.waitForTimeout(500); await p.locator(".sec-head").nth(1).click(); await p.waitForTimeout(300); } },
  { name: "review-quotes", path: `/runs/${r.id}`, prepare: async (p) => {
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
  { name: "delegate-sync", path: "/runs", prepare: async (p) => { await p.getByRole("button", { name: "交办" }).first().click(); await p.waitForTimeout(400); await p.locator("textarea").first().fill("把 main 合并进来，再把退款精度改成超出两位小数报错"); await p.getByText("拉取目标分支在 origin 上的新提交").click(); await p.waitForTimeout(300); } },
  { name: "rules", path: `/rules?id=${rule.id}` },
  { name: "agents", path: "/agents" },
  { name: "review-overview-dark", path: `/runs/${r.id}`, dark: true },
  { name: "review-change-mobile", path: `/runs/${r.id}`, width: 390, prepare: async (p) => { await p.getByRole("tab", { name: /变更/ }).click(); await p.waitForTimeout(400); } },
];
let failed = 0;
for (const s of shots) {
  const width = s.width ?? 1440;
  const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: s.dark ? "dark" : "light", deviceScaleFactor: width < 600 ? 2 : 1 });
  // Every page opens on the demo project's space.
  await page.addInitScript(() => localStorage.setItem("omem-space", "shop"));
  try {
    await page.goto(`${url}/#${s.path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    if (s.prepare) await s.prepare(page);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    console.log(`${s.name}.png`);
  } catch (e) {
    failed++;
    console.error(`${s.name}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
await server.close();
app.db.close();
rmSync(home, { recursive: true, force: true });
if (failed) process.exitCode = 1;
