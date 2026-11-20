import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { now, truncate } from "../core/util.ts";
import { CODE_STARTERS } from "../agents/tool-help.ts";
import { listContexts, type ListenContext } from "./listen.ts";

/**
 * Proactive help on a matter (an item 「关注」 with `assist` on): about once a day, or soon after the item
 * changed, the assistant looks at where the matter stands and pushes it on — context nobody linked yet
 * (documents, groups, code), progress against the deadline, the next step of its flow stage (tests to
 * write or run, coding to start, a review waiting), and its data (an observation plan, metrics that
 * moved). `suggest`: at most three concrete suggestions to the owner, each with its evidence; `act`: the
 * read-only part is done at once (materials linked, the observation plan written and its metrics
 * defined, a test checklist drafted), and what needs the owner is suggested. It never starts coding,
 * posts in groups or changes the item's status by itself. Suggestions go into a work file next to the
 * 关注's lessons, so the next look does not repeat them.
 */
const GAP_MS = 20 * 3600_000;
const PER_DAY = 8;
const lane = (id: string) => `listen-assist:${id}`;
const key = (id: string) => `listen_assist:${id}`;

export function assistPath(c: Pick<ListenContext, "name" | "id">) {
  const name = c.name.replace(/[\\/:*?"<>|#\s]+/g, " ").trim().slice(0, 40) || c.id;
  return `关注/${name}/推进.md`;
}

type ItemRow = { id: string; title: string; detail: string; status: string; due_at: string | null; space_id: string; updated_at: string; kind: string };

/** Heartbeat: item 关注 with `assist` on whose matter is alive get their look, at most once in 20 hours. */
export async function assistDue(app: App, at = Date.now()) {
  const { createRun, runsInLane } = await import("../agents/runs.ts");
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  let today = one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'agent' and json_extract(input, '$.listenAssist') is not null and created_at >= ?", start.toISOString())?.n ?? 0;
  const created: string[] = [];
  for (const c of listContexts(app, { kind: "item", activeOnly: true })) {
    if (today >= PER_DAY) break;
    const mode = c.knobs.assist ?? "off";
    if (mode === "off" || !c.itemId) continue;
    const item = one<ItemRow>(app.db, "select id, title, detail, status, due_at, space_id, updated_at, kind from items where id = ?", c.itemId);
    if (!item || !["open", "waiting", "snoozed"].includes(item.status)) continue;
    const last = one<{ value: string }>(app.db, "select value from kv where key = ?", key(c.id))?.value;
    const changed = !last || item.updated_at > last;
    const soon = !!item.due_at && Date.parse(item.due_at) - at < 3 * 86400_000;
    const stale = !last || at - Date.parse(last) >= GAP_MS;
    // A quiet matter is looked at only when something moved or its deadline is near.
    if (!stale || (!changed && !soon && last)) continue;
    if (runsInLane(app, lane(c.id)).length) continue;
    const r = createRun(app, {
      kind: "agent",
      spaceId: item.space_id,
      lane: lane(c.id),
      title: `推进「${truncate(item.title, 40)}」`,
      userId: OWNER,
      input: {
        spec: "assistant",
        task: assistTask(app, c, item, mode as "suggest" | "act"),
        listenAssist: c.id,
        assistantScope: {
          spaces: [item.space_id, "personal"],
          userId: OWNER,
          // Pushing on is suggesting and reading: no coding, no posting, no rules or watches of its own.
          denyTools: [...CODE_STARTERS, "apply_code_run", "code_git_action", "save_rule", "set_chat_watch", "lark_send", "lark_card", "lark_write", "lark_invite", "run_agent", ...(mode === "suggest" ? ["metric_define", "metric_record"] : [])],
          lark: { chats: [], draft: true },
        },
      },
    });
    run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", key(c.id), now());
    created.push(r.id);
    today++;
  }
  return created;
}

function assistTask(app: App, c: ListenContext, item: ItemRow, mode: "suggest" | "act") {
  const changes = all<{ kind: string; summary: string; status: string; at: string }>(app.db, "select type kind, summary, status, at from item_changes where item_id = ? order by at desc limit 8", item.id);
  const events = all<{ kind: string; text: string; at: string }>(app.db, "select kind, text, at from item_events where item_id = ? order by at desc limit 8", item.id);
  const flow = one<{ name: string; stage: string; state: string }>(
    app.db,
    `select json_extract(f.definition,'$.name') name, s.stage_id stage, s.state state from item_flows f join item_stages s on s.item_id = f.item_id
     where f.item_id = ? and f.ended_at is null and s.state in ('doing','gated','blocked','pending') order by case s.state when 'doing' then 0 when 'gated' then 1 when 'blocked' then 2 else 3 end limit 1`,
    item.id,
  );
  const metrics = all<{ name: string }>(app.db, "select name from metrics where item_id = ? and status = 'active'", item.id).map((m) => m.name);
  const plan = one<{ id: string }>(app.db, "select id from sources where kind = 'work' and deleted_at is null and uri like 'work/观测/%' and json_extract(meta, '$.links.item') = ? limit 1", item.id);
  const summary = c.conversationId ? one<{ summary: string | null }>(app.db, "select summary from conversations where id = ?", c.conversationId)?.summary : null;
  const before = one<{ text: string }>(app.db, "select text from sources where uri = ? and deleted_at is null order by captured_at desc limit 1", `work/${assistPath(c)}`)?.text;
  return [
    `# 推进这件事：${item.title}（${item.id}）`,
    "",
    `状态 ${item.status}${item.due_at ? `，截止 ${item.due_at.slice(0, 16).replace("T", " ")}` : "，没有截止时间"}${flow ? `；流程「${flow.name}」现在在「${flow.stage}」（${flow.state}）` : ""}。`,
    item.detail ? truncate(item.detail, 600) : "",
    summary ? `\n## 它的群里最近在聊\n\n${truncate(summary, 1500)}` : "",
    changes.length ? `\n## 最近的变化\n\n${changes.map((x) => `- ${x.at.slice(5, 16).replace("T", " ")} ${x.kind}（${x.status}）：${truncate(x.summary, 160)}`).join("\n")}` : "",
    events.length ? `\n## 事项时间线（新的在前）\n\n${events.map((x) => `- ${x.at.slice(5, 16).replace("T", " ")} ${truncate(x.text, 160)}`).join("\n")}` : "",
    `\n## 数据\n\n${plan ? "已有观测计划。" : "还没有观测计划。"}${metrics.length ? `指标：${metrics.join("、")}（metric_read(item=${item.id}) 看变化）。` : "还没有指标。"}`,
    before ? `\n## 之前给本人的建议（不要重复，已经做了的不再提）\n\n${truncate(before, 2500)}` : "",
    "",
    "# 要你做的",
    "",
    "看这件事现在卡在哪、下一步是什么，找出本人还没想到或还没顾上的：",
    "1. 上下文：和这件事有关、还没挂到事项上的文档、群、会话、代码（search、read_source、list_conversations）。",
    "2. 进度：对照截止时间和流程阶段，有没有要提前处理的风险（谁在等谁、哪段卡住了）。",
    "3. 下一步：按阶段想具体的动作——该写或该跑的测试、该开始的编码交办、等着的评审、该找的人。",
    `4. 数据：${plan ? "指标有没有异常变化、观测计划缺了什么" : "这是需求类的事就按技能 observation-plan 想观测计划"}。`,
    "",
    mode === "act"
      ? "能只读完成的直接做：用 upsert_item 的 materials_add 把找到的材料挂上，按 observation-plan 写观测计划并用 metric_define 定义指标、metric_record 记下基线，测试清单写成工作文件。要本人拍板或会改动东西的（编码、发消息、改事项状态）只提建议。"
      : "只提建议，不替本人动手。",
    `最多三条建议，每条写清做什么、为什么（带依据：原件引用、指标、阶段）、本人回一句就能让你接着做的话。用 notify 发给本人（截止前两天内的风险用 urgent，其余 later），并用 write_file（mode=append，path=${assistPath(c)}，item=${item.id}）记下日期和这几条。和之前的建议比没有新东西就调用 stay_quiet。`,
  ].filter((x) => x !== "").join("\n");
}
