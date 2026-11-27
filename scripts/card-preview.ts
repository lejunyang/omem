/**
 * Look at omem's Feishu cards without Feishu (docs/v2/lark-cards.md, “怎么看卡片画出来的样子”):
 *   node scripts/card-preview.ts [outDir] [--only=name,name] [--json=card.json ...]
 *   node scripts/card-preview.ts --site        (redraws site/public/screens/lark-card-*.png)
 *
 * Builds sample cards with the real card code (src/channels/lark-asks.ts, the flow stage and design
 * layouts) in a throwaway data directory, draws each with open-feishu-card (a dev dependency: a copy of
 * Feishu's web card renderer) at the widths of a PC chat and a phone, and screenshots them into outDir
 * (default `card-preview`): `<name>-pc.png`, `<name>-mobile.png`, the card JSON, and `index.html` with all
 * of them. `--json` draws card JSON files instead (a card copied from a run, say). The sample content is
 * fictional. CHROMIUM=path picks the browser, SCHEME=dark the dark theme.
 *
 * Where it differs from the Feishu client (checked 2026-11-27 against the card builder): an icon on a
 * Markdown element is not drawn; images show only as placeholders (no img_key lookup); folds, forms and
 * buttons are drawn but do nothing. HTML entities in Markdown (omem writes `:` as `&#58;`) are decoded
 * here, as the client does. The card builder (open.larkoffice.com/cardkit, “导入卡片”) is the closer
 * check when someone is signed in.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium } from "playwright";
import { App } from "../src/core/app.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { answerAsk, createAsk, getAsk } from "../src/agents/asks.ts";
import { askCard, viewCard } from "../src/channels/lark-asks.ts";
import { designConfirmation } from "../src/designs/work.ts";
import type { Design } from "../src/designs/store.ts";

type Card = Record<string, unknown>;

const args = process.argv.slice(2);
const out = resolve(args.find((a) => !a.startsWith("--")) ?? "card-preview");
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",").filter(Boolean);
const files = args.filter((a) => a.startsWith("--json=")).map((a) => a.slice(7));
/** `--site`: redraw the docs site's card pictures (site/features/lark-bot.md) instead. */
const site = args.includes("--site");
const SCREENS = resolve("site/public/screens");
const SITE: Record<string, string> = { "stage-blocked": "lark-card-stage", "design-ready": "lark-card-design", view: "lark-card-view" };

let render: (dsl: Card) => string;
let css: string;
try {
  const ofc = await import("open-feishu-card");
  render = (dsl) => ofc.renderDslToString(dsl);
  css = ofc.ALL_CSS;
} catch {
  console.error("没有 open-feishu-card：先 pnpm install（它是开发依赖）");
  process.exit(1);
}

/** Sample cards from the real card code, in a data directory thrown away afterwards. */
async function samples(): Promise<Record<string, Card>> {
  const home = mkdtempSync(join(tmpdir(), "omem-cards-"));
  const app = App.open(home);
  ensurePersonalSpace(app);
  app.config.webUrl = "https://omem.example.test";
  try {
    const cards: Record<string, Card> = {};
    const stage = createAsk(app, {
      runId: null,
      question: "**「实现与自测」卡住了**\n\n事项：退款改造：部分退款支持按商品行退",
      options: [{ label: "让助手接着做" }, { label: "我已处理，继续" }, { label: "先不处理" }],
      allowText: true,
      // No handler: there is no item behind the sample, and answering it must not drive a flow.
      context: {
        stageCard: {
          title: "「实现与自测」卡住了",
          itemTitle: "退款改造：部分退款支持按商品行退",
          flowUrl: "https://omem.example.test/#/items/demo/flow",
          discussUrl: "https://omem.example.test/#/ask",
          textAction: "按这句话处理",
          sections: [
            { label: "现在", text: "编码第 2 轮已完成，本地 23 条回归通过；预发环境的退款接口返回 403。" },
            { label: "卡点", text: "预发的退款服务要求调用方在白名单里，现在的测试账号不在。需要有人把 `refund-bff` 加进白名单，或换一个有权限的测试账号。" },
            { label: "建议的做法", text: "找小王按《预发环境接入说明》申请白名单（一般半天）；在这之前先用 Mock 跑通前端联调。" },
            { label: "依据", text: Array.from({ length: 12 }, (_, i) => `- 第 ${i + 1} 次调用：\`403 caller not in allowlist\``).join("\n") },
          ],
        },
      },
    });
    cards["stage-blocked"] = askCard(app, stage);
    await answerAsk(app, stage.id, { by: "owner", choice: 0 });
    cards["stage-answered"] = askCard(app, getAsk(app, stage.id));

    const design = { id: "dsg_demo", revision: 2, body: { decisions: [
      { id: "D1", kind: "add", title: "退款单增加商品行明细表，金额按行汇总" },
      { id: "D2", kind: "change", title: "退款金额校验改为按行校验，整单校验保留为兜底" },
      { id: "D3", kind: "refactor", title: "旧的整单退款入口改走新接口", question: { text: "旧入口是直接下线，还是灰度两周后下线？", options: ["直接下线", "灰度两周"], recommended: 1 } },
      { id: "D4", kind: "add", title: "回归按三种退款组合钉死" },
    ], concerns: [] } } as unknown as Pick<Design, "id" | "revision" | "body">;
    cards["design-confirm"] = askCard(app, createAsk(app, { runId: null, ...designConfirmation(app, design, "部分退款支持按商品行退", "") }));
    // Nothing left to decide: answered with the buttons (this renderer leaves a form's dropdowns empty).
    const settled = { ...design, body: { ...design.body, decisions: design.body.decisions.map(({ question: _, ...d }) => d) } } as typeof design;
    cards["design-ready"] = askCard(app, createAsk(app, { runId: null, ...designConfirmation(app, settled, "部分退款支持按商品行退", "") }));

    cards["approval"] = askCard(app, createAsk(app, { runId: null, kind: "approval", question: "要在预发执行 `refund-bff` 的回滚脚本，把今天 14:20 的部署退回上一版。", tool: "run_command", args: {}, allowText: true }));
    cards["question"] = askCard(app, createAsk(app, { runId: null, question: "今天的退款对账要不要先按旧口径出？\n\n新口径按商品行算，对账脚本还没改完；旧口径会把部分退款记成金额不一致，需要人工核对约 30 单。", options: [{ label: "先按旧口径出" }, { label: "等新口径" }], allowText: true }));

    cards["view"] = viewCard(app, { id: "uv_demo", title: "上线前检查", components: [
      { type: "callout", tone: "warning", title: "可以发，但对账要先处理", text: "按行退款上线后，当天的对账会把部分退款记成金额不一致。" },
      { type: "fields", items: [{ label: "分支", value: "feat/line-refund" }, { label: "轮次", value: "第 3 轮" }, { label: "评审", value: "通过（2 个小问题）" }, { label: "预发", value: "已部署 14:20" }] },
      { type: "list", title: "检查结果", items: [
        { title: "接口兼容：老客户端仍走整单退款", tag: "通过", tone: "success" },
        { title: "灰度开关默认关闭", tag: "通过", tone: "success" },
        { title: "退款对账任务没覆盖按行退款", tag: "要注意", tone: "warning", text: "先改对账脚本，或当天人工核对。" },
        { title: "预发验收录屏", tag: "产物", tone: "info", url: "https://example.com/demo.mp4" },
      ] },
      { type: "metric", items: [{ label: "退款率", value: "4.8", unit: "%", change: "+0.6pct", good: "down", note: "较上周" }, { label: "退款单", value: 482 }, { label: "平均时长", value: "2.1", unit: "天", change: "-0.4", good: "down" }] },
      { type: "fold", title: "完整检查记录", text: "1. 接口兼容：通过\n2. 开关：通过\n3. 对账：未覆盖\n4. 监控：已加按行退款的告警" },
    ] });

    cards["form"] = askCard(app, createAsk(app, { runId: null, question: "上线安排还差几件事要你定。", allowText: true, ui: { fields: [
      { id: "when", type: "date", label: "哪天上线", required: true },
      { id: "scope", type: "choice", label: "先放多少流量", options: ["5%", "20%", "全量"], default: "5%", required: true },
      { id: "notify", type: "toggle", label: "要不要提前通知客服", required: false },
    ] } }));
    return cards;
  } finally {
    // A new question notifies in the background; let that finish before the database goes away.
    await new Promise((r) => setTimeout(r, 1000));
    app.db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The client shows HTML entities in card Markdown as their characters (cardText writes `:` as `&#58;`). */
function decoded(card: unknown): unknown {
  if (Array.isArray(card)) return card.map(decoded);
  if (!card || typeof card !== "object") return card;
  const o = Object.fromEntries(Object.entries(card).map(([k, v]) => [k, decoded(v)]));
  if (o.tag === "markdown" && typeof o.content === "string") o.content = o.content.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  return o;
}

const cards: Record<string, Card> = files.length
  ? Object.fromEntries(files.map((f) => [basename(f).replace(/\.json$/, ""), JSON.parse(readFileSync(f, "utf8")) as Card]))
  : await samples();
const names = Object.keys(cards).filter((n) => !only || only.includes(n));
mkdirSync(out, { recursive: true });

/** Feishu's PC chat shows a card up to about 600px wide; on a phone it is the screen less the margins. */
const WIDTHS = { pc: 520, mobile: 340 } as const;
const page = (name: string, width: number) => `<!doctype html><meta charset="utf-8"><style>${css}
body { margin: 0; padding: 16px; background: ${process.env.SCHEME === "dark" ? "#1b1b1f" : "#f2f3f5"}; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.frame { width: ${width}px; }</style><div class="frame" id="${name}">${render(decoded(cards[name]) as Card)}</div>`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const tab = await browser.newPage({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2, colorScheme: (process.env.SCHEME as "light" | "dark") ?? "light" });
if (site) {
  // The docs site's pictures: a card on the chat's grey, at the PC width (site/public/screens, <Shot src=…>).
  for (const [name, file] of Object.entries(SITE)) {
    await tab.setContent(page(name, WIDTHS.pc).replace("padding: 16px", "padding: 24px"));
    const box = (await tab.locator(".frame").boundingBox())!;
    await tab.screenshot({ path: join(SCREENS, `${file}.png`), clip: { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 } });
    console.log(`${name}：${join(SCREENS, `${file}.png`)}`);
  }
  await browser.close();
  process.exit(0);
}
for (const name of names) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(cards[name], null, 2));
  for (const [kind, width] of Object.entries(WIDTHS)) {
    await tab.setContent(page(name, width));
    await tab.locator(".frame").screenshot({ path: join(out, `${name}-${kind}.png`) });
  }
  console.log(`${name}：${join(out, `${name}-pc.png`)}`);
}
await browser.close();
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>omem 卡片预览</title><style>${css}
body { margin: 0; padding: 24px; background: #f2f3f5; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
section { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 32px; } h2 { font-size: 14px; color: #646a73; }</style>
${names.map((n) => `<h2>${n}</h2><section>${Object.values(WIDTHS).map((w) => `<div style="width:${w}px">${render(decoded(cards[n]) as Card)}</div>`).join("")}</section>`).join("\n")}`);
console.log(`全部：${join(out, "index.html")}`);
