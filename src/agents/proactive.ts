import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, localStamp, truncate } from "../core/util.ts";
import { casesText, NOT_MEETING, type CaseLite } from "../channels/listen-cases.ts";
import { listContexts, type ListenContext } from "../channels/listen.ts";
import { CASE_REASONS, creatorLabel } from "../items/auto-cases.ts";
import { changeOf, describeChange, listMetrics, metricPoints, type Metric } from "../data/metrics.ts";
import { listRules, type Firing } from "../rules/store.ts";

/**
 * What omem has learned lately, put in front of the agents that look back: the nightly dream, the coach
 * and the weekly report. The 关注 (their conversation summaries, cases and lessons), the items the
 * assistant made and what the owner did with them, the rules' firings, and the metrics past their
 * threshold. The host only gathers and counts; what to propose is the agents' call (roles/dreamer.md).
 */

const KIND_LABEL: Record<ListenContext["kind"], string> = { place: "地方型", item: "事情型", default: "内置" };
const REPLY: Record<ListenContext["knobs"]["reply"], string> = { none: "不回", draft: "草稿", auto: "直接回" };
const OWNER_ASKS: Record<ListenContext["knobs"]["ownerAsks"], string> = { notify: "只提醒本人", draft: "替本人拟草稿", answer: "可以直接答" };
const LISTEN: Record<ListenContext["knobs"]["listen"], string> = { addressed: "只看找本人或机器人的", relevant: "看和说明相关的", all: "全看" };

/** A 关注's knobs in one line, so a proposal can name what to turn. */
export function knobsLine(c: ListenContext) {
  const k = c.knobs;
  return `听：${LISTEN[k.listen]}；回复：${REPLY[k.reply]}；问本人的：${OWNER_ASKS[k.ownerAsks]}；找别人的：${k.othersAsks === "handle" ? "也处理" : "不管"}；${k.depth === "investigate" ? "值得查的会查" : "只答能马上答的"}`;
}

type CaseRow = CaseLite & { decided_at: string | null; owner_reply_at: string | null };

/** Cases of a 关注 that came in, or were decided, after `since` (meetings and auto items aside). */
function freshCases(app: App, contextId: string, since: string) {
  return all<CaseRow>(
    app.db,
    `select id, context_id, chat_id, chat_kind, chat_name, settled_at, asker_id, asker_name, ask, draft, decision, final, reason, owner_reply, verdict, note, scene, checked, created_at, decided_at, owner_reply_at
     from reply_samples where context_id = ? and ${NOT_MEETING} and max(created_at, coalesce(decided_at, ''), coalesce(owner_reply_at, '')) > ? order by created_at desc limit 60`,
    contextId,
    since,
  );
}

/** The owner had a say that went against the assistant: not sent, edited, disliked, marked, or replied where it stayed quiet. */
export const corrected = (c: Pick<CaseLite, "decision" | "verdict" | "owner_reply">) =>
  c.decision === "edited" || c.decision === "dropped" || c.decision === "disliked" || !!c.verdict || (!!c.owner_reply && (c.decision === "quiet" || !c.decision));

const DECISION_LABEL: Record<string, string> = { sent: "照发", edited: "改了再发", dropped: "没发", auto: "自动发出", disliked: "发出后不满意", quiet: "助手没回" };

function caseCounts(rows: CaseRow[]) {
  const by = new Map<string, number>();
  for (const r of rows) if (r.decision) by.set(r.decision, (by.get(r.decision) ?? 0) + 1);
  const own = rows.filter((r) => r.owner_reply).length;
  const marked = rows.filter((r) => r.verdict).length;
  return [...[...by].map(([d, n]) => `${DECISION_LABEL[d] ?? d} ${n}`), ...(own ? [`本人自己回 ${own}`] : []), ...(marked ? [`在网页上纠正 ${marked}`] : [])].join("、");
}

/** The conversation summary of a 关注, and whether it changed after `since`. */
function summaryOf(app: App, c: ListenContext, since: string) {
  if (!c.conversationId) return null;
  const r = one<{ summary: string; summary_at: string | null }>(app.db, "select summary, summary_at from conversations where id = ?", c.conversationId);
  if (!r?.summary.trim()) return null;
  return { text: r.summary.trim(), fresh: !!r.summary_at && r.summary_at > since };
}

/**
 * Per active 关注 with something new since `since`: its summary when it changed, its new cases (with
 * two or three examples, corrections first) and whether its lessons were rewritten. The rest are named
 * on one line. `fresh`: how many 关注 had anything new.
 */
export function listenDigest(app: App, since: string, opts: { examples?: number; summaryChars?: number; knobs?: boolean; when?: string } = {}) {
  const live = listContexts(app, { activeOnly: true });
  const blocks: string[] = [];
  const quiet: string[] = [];
  for (const c of live) {
    const rows = freshCases(app, c.id, since);
    const summary = summaryOf(app, c, since);
    const lessons = !!c.playbookAt && c.playbookAt > since;
    if (!rows.length && !summary?.fresh && !lessons) {
      quiet.push(`「${c.name}」`);
      continue;
    }
    const fixes = rows.filter(corrected);
    const examples = [...fixes, ...rows.filter((r) => !corrected(r) && (r.decision || r.owner_reply))].slice(0, opts.examples ?? 3);
    blocks.push(
      [
        `- 「${c.name}」${c.id}（${KIND_LABEL[c.kind]}${c.kind === "default" ? "：私聊和 @ 本人的消息" : `，${c.chats.length} 个群`}${c.itemId ? `，事项 ${c.itemId}` : ""}${opts.knobs === false ? "" : `；${knobsLine(c)}`}）`,
        summary?.fresh ? `  会话摘要（${opts.when ?? "上次以来"}更新过）：${truncate(summary.text.replace(/\s+/g, " "), opts.summaryChars ?? 400)}` : "",
        rows.length ? `  新案例 ${rows.length} 个：${caseCounts(rows) || "都还没有结果"}${fixes.length ? `；其中本人纠正 ${fixes.length} 个` : ""}` : "",
        lessons ? `  经验（listen-coach 写的）${opts.when ?? "上次以来"}改过` : "",
        examples.length ? casesText(examples).split("\n").map((l) => `  ${l}`).join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (!blocks.length && !quiet.length) return { text: "", fresh: 0 };
  return {
    fresh: blocks.length,
    text: [`### 关注（在用的 ${live.length} 个）`, ...blocks, quiet.length ? `其余没有新动静：${quiet.join("、")}` : ""].filter(Boolean).join("\n"),
  };
}

/** Items the assistant made on its own and what the owner did with them after `since`: counts per creator, a few examples. */
export function autoItemDigest(app: App, since: string, examples = 3) {
  const rows = all<{ id: string; ask: string; decision: string; reason: string | null; asker_name: string; final: string }>(
    app.db,
    "select id, ask, decision, reason, asker_name, final from reply_samples where source = 'item' and decided_at > ? order by decided_at desc limit 200",
    since,
  );
  if (!rows.length) return { text: "", n: 0 };
  const by = new Map<string, { kept: number; dropped: number }>();
  for (const r of rows) {
    const x = by.get(r.asker_name) ?? { kept: 0, dropped: 0 };
    if (r.decision === "sent") x.kept++;
    else x.dropped++;
    by.set(r.asker_name, x);
  }
  const dropped = rows.filter((r) => r.decision === "dropped");
  const shown = [...dropped, ...rows.filter((r) => r.decision !== "dropped")].slice(0, examples);
  return {
    n: rows.length,
    text: [
      "### 助手自己建的事项（上次以来本人的取舍）",
      ...[...by].map(([creator, x]) => `- ${creatorLabel(creator)}：留下 ${x.kept}、不要 ${x.dropped}`),
      "例子：",
      ...shown.map((r) => {
        const [title, why = ""] = r.ask.split("\n");
        return `- ${r.decision === "sent" ? "留下" : "不要"}（${CASE_REASONS[r.reason as keyof typeof CASE_REASONS] ?? r.reason ?? ""}）〔${creatorLabel(r.asker_name)}〕${truncate(title, 60)} ${r.final}${why ? `：为什么建：${truncate(why, 100)}` : ""}`;
      }),
    ].join("\n"),
  };
}

/**
 * Rules that fired after `since`: how often, how many acted (an action other than a skip), were skipped,
 * failed (an action not ok), with the latest failure. `failed`: firings with a failure in all.
 */
export function ruleDigest(app: App, since: string) {
  const lines: string[] = [];
  let failed = 0;
  for (const rule of listRules(app)) {
    // The index is (rule_id, at): one rule at a time stays on it.
    const rows = all<{ results: string; at: string }>(app.db, "select results, at from rule_firings where rule_id = ? and at > ? order by id desc limit 500", rule.id, since);
    if (!rows.length) continue;
    let acted = 0, skipped = 0, bad = 0;
    let lastBad = "";
    for (const r of rows) {
      const results = json<Firing["results"]>(r.results, []);
      const fail = results.find((x) => !x.ok);
      if (fail) {
        bad++;
        if (!lastBad) lastBad = `${fail.action}：${truncate(fail.detail.replace(/\s+/g, " "), 140)}`;
      } else if (results.length && results.every((x) => x.action === "skip")) skipped++;
      else acted++;
    }
    failed += bad;
    lines.push(`- 「${rule.name}」${rule.id}${rule.enabled ? "" : "（已停用）"}：触发 ${rows.length} 次，做了 ${acted}、让开 ${skipped}、失败 ${bad}${lastBad ? `；最近一次失败 ${lastBad}` : ""}`);
  }
  return { text: lines.length ? ["### 规则（上次以来触发过的）", ...lines].join("\n") : "", n: lines.length, failed };
}

/** Active metrics with a point recorded after `since` whose series' newest point is past its threshold. */
export function flaggedMetrics(app: App, since: string): { metric: Metric; line: string }[] {
  const out: { metric: Metric; line: string }[] = [];
  for (const m of listMetrics(app, { activeOnly: true })) {
    if (!m.lastAt || m.lastAt <= since) continue;
    // Only the series that got a point since: one not taken again says nothing new tonight.
    const series = all<{ dims: string }>(app.db, "select distinct dims from metric_points where metric_id = ? and created_at > ?", m.id, since);
    for (const s of series) {
      const dims = json<Record<string, string>>(s.dims, {});
      const c = changeOf(m, metricPoints(app, m.id, { dims, limit: 30 }));
      if (!c?.flagged) continue;
      out.push({ metric: m, line: `- ${Object.keys(dims).length ? `[${Object.entries(dims).map(([a, b]) => `${a}=${b}`).join(",")}] ` : ""}${describeChange(m, c)}（${m.id}${m.itemId ? `，事项 ${m.itemId}` : ""}${m.contextId ? `，关注 ${m.contextId}` : ""}）` });
    }
  }
  return out;
}

/** What the owner works on, and which items already have a 关注 or metrics: for proposing either where one is missing. */
export function coverageText(app: App, workState: string) {
  if (!workState) return "";
  const items = listContexts(app, { kind: "item", activeOnly: true }).filter((c) => c.itemId);
  const metricItems = new Map<string, number>();
  for (const m of listMetrics(app, { activeOnly: true })) if (m.itemId) metricItems.set(m.itemId, (metricItems.get(m.itemId) ?? 0) + 1);
  const title = (id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? "";
  return [
    "### 本人近况，以及已经有关注、指标的事项",
    `本人近况（work-state 每晚整理）：\n${workState}`,
    `有事情型关注的事项：${items.map((c) => `${c.itemId}「${truncate(title(c.itemId!), 30)}」`).join("、") || "（没有）"}`,
    `有指标的事项：${[...metricItems].map(([id, n]) => `${id}「${truncate(title(id), 30)}」${n} 个`).join("、") || "（没有）"}`,
  ].join("\n");
}

/** Proposals the nightly dream already sent (its notifications) in the last week: not to be sent again as they were. */
export function recentDreamProposals(app: App, days = 7) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return all<{ at: string; title: string; body: string }>(
    app.db,
    "select at, title, body from notifications where json_extract(context, '$.runId') in (select id from runs where kind = 'dream' and created_at > ?) and at > ? order by at desc limit 10",
    since,
    since,
  );
}

/**
 * The dream's section on 关注, auto items, rules and metrics. `has`: anything new enough that the night
 * should look even when no memory or item changed.
 */
export function dreamMaterial(app: App, since: string, workState: string) {
  const listen = listenDigest(app, since);
  const autos = autoItemDigest(app, since);
  const rules = ruleDigest(app, since);
  const metrics = flaggedMetrics(app, since);
  const coverage = coverageText(app, workState);
  const sent = recentDreamProposals(app);
  const has = listen.fresh > 0 || autos.n > 0 || rules.failed > 0 || metrics.length > 0;
  const parts = [
    listen.text,
    autos.text,
    rules.text,
    metrics.length ? ["### 指标（上次以来新取的点里超过门槛的）", ...metrics.map((m) => m.line)].join("\n") : "",
    coverage,
    sent.length ? ["### 最近一周夜间整理已经发给本人的通知（同样的建议不要原样再提）", ...sent.map((n) => `- ${localStamp(n.at, app.config.timezone)} ${n.title}：${truncate(n.body.replace(/\s+/g, " "), 200)}`)].join("\n") : "",
  ].filter(Boolean);
  if (!parts.length) return { text: "", has };
  return {
    has,
    text: [`## 关注、自动建的事项、规则和指标（宿主按记录数的，只是线索；按角色说明第 8 条决定要不要向本人提建议）`, ...parts].join("\n\n"),
  };
}
