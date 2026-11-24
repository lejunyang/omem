import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, localStamp, now, truncate } from "../core/util.ts";
import { itemFocus } from "../agents/turn-context.ts";
import { itemFlow, itemStages } from "../flows/store.ts";
import { CODE_STARTERS } from "../agents/tool-help.ts";
import { lineTimeline } from "../items/changes.ts";
import { stepBrief } from "../items/change-step-store.ts";
import { lineEndCases, md } from "../items/lifecycle.ts";
import { declinedNext, nextOf } from "../items/lines.ts";
import { materialsBrief } from "../items/materials.ts";
import { getItem, type Item } from "../items/store.ts";
import { descendantIds } from "../items/tree.ts";
import { metricLessons } from "../data/metrics.ts";
import { mayRunRoutine, ownAccountProblem } from "../items/member-routine.ts";
import { OWNER } from "../core/users.ts";
import { itemContext, listContexts, type ListenContext } from "./listen.ts";

/**
 * Where a line stands (docs/v2/status.md “工作线”): about once a day, or soon after something on it changed, a
 * top-level item's 「关注」 with `assist` on gets a run that reads the line and everything under it
 * (state, flow stages, key changes, materials, metrics, what its groups talk about, the last state and
 * the next steps the owner said 不用 to) and hands in `submit_line_state`: one sentence as of today,
 * the people and their roles, the last weeks, at most three next steps. The host stores them; the
 * owner sees the next steps of all lines once a day on one card (items/lines.ts lineNextDue), never a
 * notification from this run. `act`: the read-only part (materials, an observation plan, metrics) is
 * done before handing in. It never codes, posts in groups or changes an item's status, and may stay
 * quiet when nothing changed since the last state.
 */
const GAP_MS = 20 * 3600_000;
const PER_DAY = 8;
const lane = (id: string) => `listen-assist:${id}`;
const key = (id: string) => `listen_assist:${id}`;

/** What the run may not use: no coding, posting, rules or watches of its own, and no notifications (the host keeps what it hands in). */
export const lineStateDenied = (mode: "suggest" | "act") => [...CODE_STARTERS, "apply_code_run", "code_git_action", "save_rule", "set_chat_watch", "lark_send", "lark_card", "lark_write", "lark_invite", "run_agent", "notify", ...(mode === "suggest" ? ["metric_define", "metric_record"] : [])];

/** The latest change on the line or under it, as the item's own `updated_at` does not move when a work item does. */
function lastMoved(app: App, item: Item) {
  const ids = [item.id, ...descendantIds(app, item.id)];
  const r = one<{ at: string | null }>(app.db, `select max(updated_at) at from items where id in (${ids.map(() => "?").join(",")})`, ...ids);
  return r?.at ?? item.updatedAt;
}

function queue(app: App, c: ListenContext, item: Item, mode: "suggest" | "act", why: string) {
  return import("../agents/runs.ts").then(async ({ createRun }) => {
    const focus = itemFocus(app, item, "explicit");
    const r = createRun(app, {
      kind: "agent",
      spaceId: item.spaceId,
      lane: lane(c.id),
      title: `看「${truncate(item.title, 40)}」的现状`,
      userId: item.userId,
      input: {
        spec: "assistant",
        task: await lineStateTask(app, c, item, mode, focus),
        turnContext: focus.context,
        listenAssist: c.id,
        lineState: item.id,
        why,
        // A member's line never runs on the owner's login (agents/runner.ts).
        ...(item.userId !== OWNER ? { ownAccountOnly: true } : {}),
        assistantScope: { spaces: [...new Set([item.spaceId, "personal"])], userId: item.userId, denyTools: lineStateDenied(mode), lark: { chats: [], draft: true } },
      },
    });
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key(c.id), now());
    return r;
  });
}

/** Heartbeat: top-level item 关注 with `assist` on whose matter is alive get their look, at most once in 20 hours. */
export async function assistDue(app: App, at = Date.now()) {
  const { runsInLane } = await import("../agents/runs.ts");
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  let today = one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'agent' and json_extract(input, '$.listenAssist') is not null and created_at >= ?", start.toISOString())?.n ?? 0;
  const created: string[] = [];
  for (const c of listContexts(app, { kind: "item", activeOnly: true })) {
    if (today >= PER_DAY) break;
    const mode = c.knobs.assist ?? "act";
    if (mode === "off" || !c.itemId) continue;
    let item: Item;
    try { item = getItem(app, c.itemId); } catch { continue; }
    // A work item under a line is looked at with its line (its own 关注 folds into the line's).
    if (item.parentId || !["open", "waiting", "snoozed"].includes(item.status)) continue;
    // A member's line: only with the routine on and their own AI account (items/member-routine.ts).
    if (item.userId !== OWNER && !mayRunRoutine(app, item.userId)) continue;
    const last = one<{ value: string }>(app.db, "select value from kv where key = ?", key(c.id))?.value;
    const changed = !last || lastMoved(app, item) > last || !!one(app.db, `select 1 from item_changes where item_id in (${[item.id, ...descendantIds(app, item.id)].map(() => "?").join(",")}) and at > ? limit 1`, item.id, ...descendantIds(app, item.id), last);
    const soon = !!item.dueAt && Date.parse(item.dueAt) - at < 3 * 86400_000;
    const stale = !last || at - Date.parse(last) >= GAP_MS;
    // A quiet line is looked at only when something moved or its deadline is near.
    if (!stale || (!changed && !soon && last)) continue;
    if (runsInLane(app, lane(c.id)).length) continue;
    const r = await queue(app, c, item, mode as "suggest" | "act", changed ? "有新变化" : "截止时间近了");
    created.push(r.id);
    today++;
  }
  return created;
}

/**
 * The page's “更新” on a line: its look now, whatever the daily rhythm says. A top-level item with no
 * 关注 yet gets one (only reading, suggesting). Returns the run, or the one already queued or running.
 */
export async function refreshLine(app: App, itemId: string, by: string) {
  const item = getItem(app, itemId);
  if (item.userId !== by) throw new HttpError(403, "只能更新自己的工作线");
  if (item.parentId) throw new HttpError(400, "这件事挂在上层下面：在它的工作线上更新");
  // A member's “更新” runs on their own AI account, never the owner's (items/member-routine.ts).
  const problem = ownAccountProblem(app, item.userId);
  if (problem) throw new HttpError(409, problem);
  let c = itemContext(app, item.id);
  if (!c || c.status !== "active") {
    const { setItemListening } = await import("./listen-items.ts");
    c = setItemListening(app, item.id, true, c ? {} : { reply: "none" })!;
  }
  const { runsInLane, getRun } = await import("../agents/runs.ts");
  const busy = runsInLane(app, lane(c.id));
  if (busy.length) return getRun(app, busy[0].id);
  const mode = c.knobs.assist && c.knobs.assist !== "off" ? c.knobs.assist : "suggest";
  return queue(app, c, item, mode, "本人点了更新");
}

const STATE: Record<string, string> = { pending: "未到", gated: "等你开始", doing: "进行中", blocked: "卡住", done: "完成", skipped: "跳过", stale: "待复核" };

/** An item's running flow, stage by stage, or "". */
function flowText(app: App, id: string, flow = itemFlow(app, id), stages = flow && !flow.endedAt ? itemStages(app, id) : []) {
  if (!flow || flow.endedAt) return "";
  const rows = new Map(stages.map(s => [s.id, s]));
  return `流程「${flow.definition.name}」：${flow.definition.stages.map(s => {
    const r = rows.get(s.id);
    return `${s.name}（${STATE[r?.state ?? "pending"]}${r?.waitingOn ? `，等${r.waitingOn.replace(/^等+/, "")}` : ""}）`;
  }).join(" → ")}`;
}

/** One work item as the look reads it: kind, state, due, flow stages. */
function itemLine(app: App, it: { id: string; title: string; kind: string; status: string; due_at: string | null; waiting_on: string | null }, depth: number) {
  const flow = flowText(app, it.id);
  return `${"  ".repeat(depth)}- ${it.id}「${truncate(it.title, 60)}」[${it.kind}/${it.status}]${it.due_at ? ` 截止 ${it.due_at.slice(0, 10)}` : ""}${it.waiting_on ? ` 等 ${it.waiting_on}` : ""}${flow ? `；${flow}` : ""}`;
}

export async function lineStateTask(app: App, c: ListenContext, item: Item, mode: "suggest" | "act", focus = itemFocus(app, item, "explicit")) {
  const tz = app.config.timezone;
  const ids = [item.id, ...descendantIds(app, item.id)];
  type Row = { id: string; title: string; kind: string; status: string; due_at: string | null; waiting_on: string | null; parent_id: string | null };
  const rows = all<Row>(app.db, `select id, title, kind, status, due_at, waiting_on, parent_id from items where id in (${ids.map(() => "?").join(",")}) order by created_at`, ...ids);
  const tree: string[] = [];
  const walk = (parent: string, depth: number) => { for (const r of rows.filter((x) => x.parent_id === parent)) { tree.push(itemLine(app, r, depth)); walk(r.id, depth + 1); } };
  walk(item.id, 0);
  const ownFlow = flowText(app, item.id, focus.flow, focus.stages);
  const changes = lineTimeline(app, item.id, { limit: 20 });
  const metrics = all<{ name: string; item_id: string; status: string }>(app.db, `select name, item_id, status from metrics where status in ('active','proposed') and item_id in (${ids.map(() => "?").join(",")})`, ...ids);
  const plan = one<{ id: string }>(app.db, `select id from sources where kind = 'work' and deleted_at is null and uri like 'work/观测/%' and json_extract(meta, '$.links.item') in (${ids.map(() => "?").join(",")}) limit 1`, ...ids);
  const summary = c.conversationId ? one<{ summary: string | null }>(app.db, "select summary from conversations where id = ?", c.conversationId)?.summary : null;
  const declined = declinedNext(app, item.id);
  const open = nextOf(app, item.id, ["open", "doing"]);
  const local = localStamp(new Date(), tz).slice(0, 10);
  const watching = item.phase === "watching";
  const cases = lineEndCases(app, item.userId, 10);
  // What the owner kept and dropped of the metrics agents proposed, for a run that may propose more.
  const lessons = mode === "act" ? metricLessons(app, { spaces: [...new Set([item.spaceId, "personal"])] }) : "";
  return [
    `# 看这条${item.kind === "line" ? "工作线" : "事"}现在的样子：${item.title}（${item.id}）`,
    "",
    `今天是 ${local}。状态 ${item.status}${item.dueAt ? `，截止 ${item.dueAt.slice(0, 16).replace("T", " ")}` : "，没有截止时间"}${ownFlow ? `；${ownFlow}` : ""}。`,
    watching ? `\n## 这条线在观察中（${item.phaseSince ? md(app, item.phaseSince) : ""}起，到 ${item.watchUntil ? md(app, item.watchUntil) : ""}）\n\n它看起来已经做完、上线了。观察期里宿主照读它的群、照取指标，期满没有新问题会自动结束。这次的下一步只写上线后的事：看上线后的数据、查上线后冒出的问题、回答还没结的疑问；没有这类事就不写下一步。` : "",
    item.detail ? `\n目标：${truncate(item.detail, 600)}` : "",
    tree.length ? `\n## 下面的工作项\n\n${tree.join("\n")}` : "\n## 下面的工作项\n\n（没有，这件事自己就是一项工作）",
    `\n${await materialsBrief(app, item.id, item.userId, { compact: true })}`,
    summary ? `\n## 它的群里最近在聊\n\n${truncate(summary, 1500)}` : "",
    changes.length ? `\n## 关键变化（新的在前，含下面的工作项）\n\n${changes.map((x) => `- ${localStamp(x.at, tz).slice(5)} [${x.type}·${x.origin}]${x.itemId !== item.id ? `「${truncate(x.itemTitle, 30)}」` : ""} ${truncate(x.summary, 160)}${x.steps?.length ? `\n  ${truncate(stepBrief(x.steps), 320)}` : ""}`).join("\n")}` : "\n## 关键变化\n\n（还没有记下的变化）",
    `\n## 数据\n\n${plan ? "已有观测计划。" : "还没有观测计划。"}${metrics.length ? `指标：${metrics.map((m) => `${m.name}${m.status === "proposed" ? "（AI 提议，待本人确认）" : ""}`).join("、")}（metric_read 看变化）。` : "还没有指标。"}${lessons ? `\n\n${lessons}` : ""}`,
    item.now ? `\n## 上次写的现状（${localStamp(item.now.at, tz)}）\n\n${item.now.text}${item.now.people.length ? `\n人：${item.now.people.map((p) => `${p.name}（${p.role}）`).join("、")}` : ""}${item.now.weeks.length ? `\n${item.now.weeks.map((w) => `${w.label}：${w.text}`).join("\n")}` : ""}` : "",
    open.length ? `\n## 还没定的下一步（这次交的会替换没开始的那些）\n\n${open.map((n) => `- [${n.status === "doing" ? "在做" : "没定"}] ${n.text}`).join("\n")}` : "",
    declined.length ? `\n## 本人说“不用”的下一步（不要再提同样的）\n\n${declined.map((n) => `- ${n.text}${n.why ? `（当时的理由：${truncate(n.why, 80)}）` : ""}`).join("\n")}` : "",
    cases.length ? `\n## 本人以前怎么定的（各条线什么时候算结束，新的在前）\n\n${cases.map((c) => `- ${localStamp(c.at, tz).slice(5, 10)}「${truncate(c.title, 30)}」${truncate(c.text, 200)}`).join("\n")}\n\n本人恢复过、说过“还没完”的那类情况，判断时更保守；本人自己结束、自动结束后没恢复的那类，可以照着判断。` : "",
    "",
    "# 要你做的",
    "",
    "读这条线和下面的工作项（read_item、list_items parent=…、read_source、list_conversations），弄清它现在到哪了、谁在做什么、卡在哪，然后用 submit_line_state 交：",
    "1. now：一句“截至今天……”，120 字以内，说到哪了、卡在哪、离截止还有多远。只写有依据的事实。",
    "2. people：这条线上的人和各自做什么（负责后端、提需求、测试、评审……），最多 8 个，不写本人。",
    "3. weeks：本周·至今N天、上周、2周前、3周前，每周一句；那周没动静写“暂无进展”。",
    `4. next：最多三条具体的下一步，每条写清做什么、为什么现在做（why）、依据（refs：原件引用、事项 id、阶段、指标），kind 选 read / test / code / ask / data。本人会在每天早上的“今天”卡片上点“就这么做”或“不用”，点了就有助手去做，所以要能直接动手，不写“关注一下”“推进一下”。`,
    [
      "5. phase（可选，没把握就不填）：这条线到了哪一段。只按材料里的事实判断：群里或需求系统里写了“已发布”“已全量”“上线完成”，流程走完了，下面的工作项都结了，本人说过做完了。",
      `   - ${watching ? "还在观察：不用填；观察期里又出了要返工的大问题、回滚了，才填 active" : "还在做：不用填"}；`,
      "   - 做完了、上线后还要看一阵（上线后的缺陷、上线后的指标、还没回答的问题）：state = watching，可以给 days（观察几天，最多 60）；",
      "   - 确实结束了（需求在需求系统里关了，上线后也没有新问题；取消了写 cancelled）：state = done，refs 放依据；",
      "   - reason 一句话写依据，confidence 写 0 到 1 的把握。宿主只在把握够的时候动：进入观察要 0.6 以上，结束要 0.8 以上、有依据、线下也没有没结的事；拿不准时宿主会问本人一次。",
    ].join("\n"),
    mode === "act"
      ? "交之前，能只读完成的先做：用 upsert_item 的 materials_add 把找到的材料挂上，按 observation-plan 写观测计划并用 metric_define 定义指标、metric_record 记下基线。改代码、发消息、改事项状态都只作为下一步提出来。"
      : "只看不动手：要做的都写成下一步。",
    "不要用 notify，也不要在群里说话：宿主会把你交的放到工作页和每天的卡片上。和上次写的现状比没有新东西、下一步也一样时，调用 stay_quiet。",
  ].filter((x) => x !== "").join("\n");
}
