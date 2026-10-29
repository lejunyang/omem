import { botOfChannel, withBot } from "../core/bot-context.ts";
import { createHash } from "node:crypto";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { type CodeChain, saveCodeChain, trySettleCodeChain, maxCodeRounds } from "../agents/code-chain.ts";
import { getThread } from "../agents/threads.ts";
import { getRun } from "../agents/runs.ts";
import { findSpace } from "../core/spaces.ts";
import { reviewChecks, reviewsOf, STOP_LABEL, SEVERITY_LABEL, type LeadResult, type ReviewPlan, type StopReason } from "../agents/review.ts";
import { buildCard, sendLark, updateLarkCard, larkClient, type CardBlock } from "./lark-send.ts";

/** Durable outbox on the initiating ask. Never repurpose the conversation's reply anchor. */
type Delivery = {
  status: "pending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt?: number;
  error?: string;
  operation?: "anchor" | "create" | "update";
  anchor?: string;
  ordinaryReply?: boolean;
  delivered?: string;
  leaseUntil?: number;
  checkpoint?: string;
  sentAt?: number;
  reconciliationPageToken?: string;
  cardGeneration?: number;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const workers = new WeakMap<App, Map<string, Promise<void>>>();
const registered = new WeakSet<App>();
const MAX_ATTEMPTS = 5;

function chainAt(app: App, id: string) {
  return getRun(app, id).output.codeChain as CodeChain | undefined;
}
function deliveryAt(app: App, id: string): Delivery {
  return (getRun(app, id).output.codeProgress as Delivery | undefined) ?? { status: "pending", attempts: 0 };
}
function saveDelivery(app: App, id: string, delivery: Delivery) {
  run(app.db, "update runs set output=json_set(coalesce(output,'{}'),'$.codeProgress',json(?)) where id=?", JSON.stringify(delivery), id);
}

/** Only keep error category and numeric API code. SDK messages may contain tokens or chat text. */
function safeError(e: unknown): string {
  const code = String((e as any)?.response?.data?.code ?? (e as any)?.code ?? "").match(/^\d+$/)?.[0]
    ?? String((e as Error)?.message ?? "").match(/（(\d+)）/)?.[1];
  return code ? `飞书 API 错误 ${code}` : e instanceof Error && e.message.startsWith("进度锚点") ? "进度锚点不可用" : "飞书请求失败（详情未保存，避免泄露消息或凭据）";
}

/** One line per review check of the latest round, then review-lead's ruling. */
function reviewLines(app: App, runId: string): string {
  const r = getRun(app, runId);
  const plan = r.output.reviewPlan as ReviewPlan | undefined;
  if (!plan) return "";
  const round = (r.input.round as number | undefined) ?? 1;
  const labels = new Map(reviewChecks(app).map((c) => [c.name, c.label]));
  const rows = reviewsOf(app, [r.id]).filter((x) => x.round === round);
  const lines = plan.checks.map((name) => {
    const row = rows.find((x) => x.check_name === name);
    if (!row) return `- ${labels.get(name) ?? name}：${r.output.reviewStage === "checks" ? "评审中" : "未开始"}`;
    const counts = (["blocker", "major", "minor", "nit"] as const).map((s) => [s, row.findings.filter((f) => f.severity === s && f.state !== "rejected" && f.state !== "merged").length] as const).filter(([, n]) => n);
    const verdict = row.verdict === "approved" ? "通过" : row.verdict === "failed" ? "没有完成" : "要求修改";
    return `- ${labels.get(name) ?? name}：${verdict}${counts.length ? `（${counts.map(([s, n]) => `${SEVERITY_LABEL[s]} ${n}`).join("、")}）` : ""}`;
  });
  const lead = r.output.reviewLead as LeadResult | undefined;
  return [`**评审 · 「${plan.tierName}」档**`, ...lines, lead?.by === "lead" ? `负责人：${lead.summary}` : ""].filter(Boolean).join("\n");
}

type RepoCheck = { space: string; diffStat?: string; check: { command: string; code: number; ms?: number } | null };

/** One line per repository: the check's result and the size of the change. Details stay in the run. */
function checkLines(app: App, repos: RepoCheck[] | undefined): string {
  if (!repos?.length) return "";
  return repos.map((r) => {
    const name = repos.length > 1 ? `${findSpace(app, r.space)?.name ?? r.space}：` : "";
    const check = !r.check ? "没有配置检查命令"
      : `检查 \`${r.check.command}\` ${r.check.code === 0 ? "通过" : `未通过（退出码 ${r.check.code}）`}${r.check.ms ? `，${Math.round(r.check.ms / 1000)} 秒` : ""}`;
    // Last line of `git diff --stat`: "3 files changed, 10 insertions(+), 2 deletions(-)".
    const size = r.diffStat?.trim().split("\n").pop()?.trim();
    return `- ${name}${check}${size ? `；${size}` : ""}`;
  }).join("\n");
}

export function snapshot(app: App, chain: CodeChain) {
  const latest = getRun(app, chain.lastCodeRunId!);
  const blocks: CardBlock[] = [{ note: `交办标识：${chain.askRunId}` }];
  if (chain.rounds.length > 3) blocks.push({ note: `更早 ${chain.rounds.length - 3} 轮评审保存在运行记录中。` });
  for (const id of chain.rounds.slice(-3)) {
    const r = getRun(app, id);
    if (r.output.review) blocks.push({ fold: { title: `第 ${r.input.round ?? 1} 轮独立评审 · ${r.output.verdict ?? ""}`, markdown: String(r.output.review).slice(0, 2000) } });
  }
  // A confirmed plan reviews after the coding run ended: the review is still going on.
  const reviewing = latest.status === "done" && ["queued", "checks", "lead"].includes(String(latest.output.reviewStage ?? ""));
  const terminal = ["done", "failed", "cancelled"].includes(latest.status) && !reviewing;
  const approved = latest.status === "done" && latest.output.verdict === "approved";
  const stop = latest.output.reviewStop as StopReason | null | undefined;
  const status = reviewing ? "评审中"
    : latest.output.verdict === "awaiting-plan" ? "编码完成，评审计划等你确认"
    : terminal && stop && !approved ? `停下来等你决定：${STOP_LABEL[stop]}`
    : terminal
    ? approved ? latest.output.acceptedByOwner ? "完成，你已接受现在的改动" : "完成，评审通过"
      : latest.status !== "done" ? `运行${latest.status}，等本人处理`
      : latest.output.verdict === "no-changes" ? "未产生改动，等本人处理"
      : `评审要求修改${chain.round >= maxCodeRounds(app, chain) ? "，已到自动推进上限" : ""}，等本人处理`
    : latest.status === "queued" ? "已安排下一轮（复用原工作区和编码会话）" : "进行中";
  // The card is the state (round, status, review, result); the process goes in the thinking bubbles.
  blocks.unshift({ markdown: `第 ${chain.round} 轮 · ${status}\n运行：${latest.id}` });
  const estimate = getRun(app, chain.rounds[0]).output.reviewEstimate as { tierName: string; reason: string } | undefined;
  const review = reviewLines(app, latest.id);
  if (review) blocks.splice(1, 0, { markdown: review });
  else if (estimate && !terminal) blocks.splice(1, 0, { markdown: `评审负责人预估：「${estimate.tierName}」档（${estimate.reason}）` });
  if (terminal && latest.output.coderSummary) blocks.push({ fold: { title: "编码说明", markdown: String(latest.output.coderSummary).slice(0, 2000) } });
  // Runs from before multi-repository delegation only have `check`.
  const repos = (latest.output.repos as RepoCheck[] | undefined) ?? (latest.output.check ? [{ space: "", check: latest.output.check as RepoCheck["check"] }] : undefined);
  const checks = terminal ? checkLines(app, repos) : "";
  if (checks) blocks.push({ markdown: checks });
  return buildCard({ title: "编码交办", color: terminal ? approved ? "green" : "orange" : "wathet", blocks });
}

async function resolveAnchor(app: App, chain: CodeChain): Promise<string> {
  const [chatId, topic] = chain.larkKey!.split("#");
  // A topic id (omt_…) is not a message id. Resolve a real message in that topic.
  if (topic) {
    const res = await larkClient().im.message.list({ params: { container_id_type: "thread", container_id: topic, page_size: 20, sort_type: "ByCreateTimeDesc" } });
    if (res?.code) throw Object.assign(new Error("进度锚点查询失败"), { code: res.code });
    const id = res?.data?.items?.find((m: any) => !m.deleted && m.message_id)?.message_id;
    if (!id) throw new Error("进度锚点不存在");
    return id;
  }
  const t = getThread(app, chain.conversationId);
  return t.settings.lastMessageId ?? "";
}

/** A review after the coding run (confirmed plan) keeps the card live until it has a verdict. */
function checkpointOf(latest: ReturnType<typeof getRun>) {
  const reviewing = ["queued", "checks", "lead"].includes(String(latest.output.reviewStage ?? ""));
  return `${latest.id}:${["done", "failed", "cancelled"].includes(latest.status) && !reviewing ? `${latest.status}:${latest.output.verdict ?? ""}` : "active"}`;
}

/** The card goes through the bot of the conversation the coding was asked in (lark.bots). */
function deliver(app: App, askId: string) {
  const conv = chainAt(app, askId)?.conversationId;
  const channel = conv ? one<{ channel: string }>(app.db, "select channel from conversations where id = ?", conv)?.channel : undefined;
  return withBot(botOfChannel(channel), () => deliverAs(app, askId));
}

async function deliverAs(app: App, askId: string) {
  let chain = chainAt(app, askId);
  if (!chain?.larkKey) return;
  const larkKey = chain.larkKey;
  let d = deliveryAt(app, askId);
  const latest = getRun(app, chain.lastCodeRunId!);
  const checkpoint = checkpointOf(latest);
  if (d.checkpoint !== checkpoint) d = { ...d, checkpoint, attempts: 0, nextAttemptAt: undefined };
  if (checkpoint.endsWith(":active") && d.sentAt && Date.now() - d.sentAt < 3000) return;
  const card = snapshot(app, chain);
  const fingerprint = hash(JSON.stringify(card));
  if (d.delivered === fingerprint || d.attempts >= MAX_ATTEMPTS || (d.nextAttemptAt ?? 0) > Date.now()) return;
  // Atomic lease shared by server/CLI, survives process death. Network calls are bounded by SDK.
  const claimed = run(app.db, `update runs set output=json_set(output,'$.codeProgress.leaseUntil',?) where id=? and coalesce(json_extract(output,'$.codeProgress.leaseUntil'),0) <= ?`, Date.now() + 120000, askId, Date.now()).changes;
  if (!claimed) return;
  d = { ...d, status: "pending", attempts: d.attempts + 1, leaseUntil: Date.now() + 120000 };
  saveDelivery(app, askId, d);
  try {
    // A process may die after the API accepted creation but before messageId was saved.
    // Reconcile by our stable card marker before another create, in addition to API UUID dedup.
    if (!chain.larkMessageId && d.operation === "create") {
      const [chatId, topic] = larkKey.split("#");
      const res = await larkClient().im.message.list({ params: {
        container_id_type: topic ? "thread" : "chat", container_id: topic ?? chatId,
        start_time: String(Math.floor(Date.parse(getRun(app, askId).createdAt) / 1000)),
        sort_type: "ByCreateTimeDesc", page_size: 50,
        ...(d.reconciliationPageToken ? { page_token: d.reconciliationPageToken } : {}),
      } });
      if (res?.code) throw Object.assign(new Error("查询已有进度卡片失败"), { code: res.code });
      const found = res?.data?.items?.find((m: any) => !m.deleted && m.msg_type === "interactive" && m.sender?.sender_type === "app" && String(m.body?.content ?? "").includes(chain!.askRunId));
      if (found?.message_id) {
        d.reconciliationPageToken = undefined;
        chain = { ...chainAt(app, askId)!, larkMessageId: found.message_id };
        saveCodeChain(app, chain, askId, ...chain.rounds);
      } else if (res?.data?.has_more) {
        // Continue the bounded scan on the next retry, including after restart.
        d.reconciliationPageToken = res.data.page_token;
        throw new Error("已有卡片查询未完成");
      } else d.reconciliationPageToken = undefined;
    }
    if (!chain.larkMessageId) {
      d.operation = "anchor";
      d.anchor ||= await resolveAnchor(app, chain);
      d.operation = "create";
      saveDelivery(app, askId, d);
      const uuid = hash(d.cardGeneration ? `omem-code:${askId}:${d.cardGeneration}` : `omem-code:${askId}`);
      // Private chats cannot start topics. Resolve chat kind before sending rather than
      // retrying arbitrary API errors as a message in a different conversation.
      if (!larkKey.includes("#") && d.anchor && d.ordinaryReply === undefined) {
        const info = await larkClient().im.chat.get({ path: { chat_id: larkKey } });
        if (info?.code) throw Object.assign(new Error("飞书会话查询失败"), { code: info.code });
        d.ordinaryReply = info?.data?.chat_mode === "p2p";
        saveDelivery(app, askId, d);
      }
      const sent = await sendLark(d.anchor ? { replyTo: d.anchor, inThread: !d.ordinaryReply, uuid, purpose: "progress" } : { chatId: larkKey.split("#")[0], uuid, purpose: "progress" }, { card });
      if (!sent.messageId) throw new Error("飞书返回缺少消息 ID");
      chain = { ...chainAt(app, askId)!, larkMessageId: sent.messageId, larkKey: !larkKey.includes("#") && sent.threadId ? `${larkKey}#${sent.threadId}` : larkKey };
      saveCodeChain(app, chain, askId, ...chain.rounds);
    } else {
      d.operation = "update";
      saveDelivery(app, askId, d);
      await updateLarkCard(chain.larkMessageId, card);
    }
    saveDelivery(app, askId, { ...d, status: "sent", sentAt: Date.now(), attempts: 0, delivered: fingerprint, error: undefined, leaseUntil: 0, nextAttemptAt: undefined });
  } catch (e) {
    const apiCode = String((e as any)?.response?.data?.code ?? (e as any)?.code ?? String((e as Error)?.message).match(/（(\d+)）/)?.[1] ?? "");
    if (d.operation === "create" && apiCode && larkKey.includes("#")) d.anchor = undefined;
    // Only confirmed disappearance permits replacement; permissions, throttling and
    // transport failures must keep the existing ID. A new UUID generation is needed
    // because Feishu may still deduplicate the UUID of the deleted card.
    // https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch
    if (d.operation === "update" && (apiCode === "230011" || (e as any)?.response?.status === 404)) {
      const fresh = chainAt(app, askId)!;
      if (fresh.larkMessageId === chain.larkMessageId) {
        saveCodeChain(app, { ...fresh, larkMessageId: null }, askId, ...fresh.rounds);
        d = { ...d, cardGeneration: (d.cardGeneration ?? 0) + 1, delivered: undefined, sentAt: undefined,
          operation: "create", anchor: undefined, reconciliationPageToken: undefined };
      }
    }
    saveDelivery(app, askId, { ...d, status: "failed", error: safeError(e), leaseUntil: 0, nextAttemptAt: Date.now() + Math.min(60000, 3000 * 2 ** (d.attempts - 1)) });
  }
}

/** Explicit start is also the recovery entry point; no states.has barrier. */
export function startCodeProgress(app: App, chain: CodeChain) {
  if (!chain.larkKey) return;
  void flushCodeProgress(app, chain.askRunId).catch((e) => console.warn("[omem] 编码进度恢复失败", (e as Error).name));
}
export async function flushCodeProgress(app: App, askId: string) {
  let map = workers.get(app);
  if (!map) workers.set(app, map = new Map());
  const active = map.get(askId);
  if (active) return active;
  const task = deliver(app, askId).finally(() => map!.delete(askId));
  map.set(askId, task);
  return task;
}

/** Retry an exhausted outbox on explicit request, without starting another coding round. */
export async function retryCodeProgress(app: App, askId: string) {
  const d = deliveryAt(app, askId);
  saveDelivery(app, askId, { ...d, attempts: 0, nextAttemptAt: undefined, delivered: undefined, sentAt: undefined });
  await flushCodeProgress(app, askId);
  return deliveryAt(app, askId);
}

export function registerCodeProgress(app: App) {
  if (registered.has(app)) return;
  registered.add(app);
  const recover = (initial = false) => {
    try {
      for (const row of all<{ id: string }>(app.db, "select id from runs where kind='ask' and json_extract(output,'$.codeChain.askRunId')=id")) {
        try {
          const chain = chainAt(app, row.id);
          if (!chain) continue;
          const latest = getRun(app, chain.lastCodeRunId!);
          // Existing successful historical cards need no replay. Unresolved delegations
          // and outbox records (including terminal update failures) must recover.
          if (!getRun(app, row.id).output.codeProgress && latest.status === "done" && latest.output.verdict === "approved") continue;
          const d = deliveryAt(app, row.id);
          // Give a never-created card one finite budget on startup, not on every poll.
          if (initial && !chain.larkMessageId && d.operation === "create" && d.attempts >= MAX_ATTEMPTS)
            saveDelivery(app, row.id, { ...d, attempts: 0, nextAttemptAt: undefined });
          const deliveredFinal = d.status === "sent" && d.checkpoint === checkpointOf(latest) && !d.checkpoint.endsWith(":active");
          // Retry failed handoff bookkeeping even if the final card was delivered.
          if (deliveredFinal && latest.output.codeResultMessageId) continue;
          trySettleCodeChain(app, chain.lastCodeRunId!);
          if (deliveredFinal) continue;
          startCodeProgress(app, chain);
        } catch (error) {
          console.warn(`[omem] 编码进度链恢复失败 ${row.id}：${error instanceof Error ? error.name : "Error"}`);
        }
      }
    } catch (error) {
      console.warn(`[omem] 编码进度恢复扫描失败：${error instanceof Error ? error.name : "Error"}`);
    }
  };
  const listener = (e: any) => {
    if (!["run", "run-event"].includes(e.type) || !e.runId) return;
    try {
      let r = getRun(app, e.runId);
      // A review run works on a coding run: the card belongs to that one.
      if (r.kind === "review" && typeof r.input.codeRunId === "string") {
        if (["done", "failed", "cancelled"].includes(r.status)) trySettleCodeChain(app, r.input.codeRunId);
        r = getRun(app, r.input.codeRunId);
      } else if (r.kind !== "code") return;
      else if (["done", "failed", "cancelled"].includes(r.status)) trySettleCodeChain(app, r.id);
      const chain = r.output.codeChain as CodeChain | undefined;
      if (chain) startCodeProgress(app, chain);
    } catch (error) {
      console.warn(`[omem] 编码进度事件处理失败 ${e.runId}：${error instanceof Error ? error.name : "Error"}`);
    }
  };
  app.events.on("event", listener);
  recover(true);
  const timer = setInterval(recover, 3000);
  timer.unref();
  return () => { clearInterval(timer); app.events.off("event", listener); registered.delete(app); };
}

export { settleCodeChain } from "../agents/code-chain.ts";
