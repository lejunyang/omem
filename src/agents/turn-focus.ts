import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { accessibleSpaces } from "../core/users.ts";
import { localStamp, sha256, truncate } from "../core/util.ts";
import { playbookPath } from "../channels/listen-cases.ts";
import { changeOf, describeChange, listMetrics } from "../data/metrics.ts";
import { descendantIds } from "../items/tree.ts";
import type { itemFocus } from "./turn-context.ts";

type Focus = ReturnType<typeof itemFocus>;
type Change = { at: string; type: string; summary: string; status: string; due: string | null };
const changeStates: Record<string, string> = { dismissed: "已否决", split: "已另开事项", merged: "已采纳", noted: "已记录" };
const kinds: Record<string, string> = { scope: "范围", decision: "决定", deadline: "截止", blocker: "阻塞", info: "信息", stage: "阶段", result: "结果", owner: "负责人", resolved: "解决" };
const stageStates: Record<string, string> = { doing: "进行中", blocked: "卡住", gated: "待确认" };
const status: Record<string, string> = { open: "待办", waiting: "等待", snoozed: "稍后", done: "完成", expired: "已过期", cancelled: "取消", candidate: "候选" };
const compact = (text: string, n: number) => truncate(text.replace(/\s+/g, " ").trim(), n);

function flaggedOnLine(app: App, ids: string[], spaces: string[] | null) {
  const metrics = listMetrics(app, { itemIds: ids, spaces, activeOnly: true });
  const byId = new Map(metrics.map(m => [m.id, m]));
  // For each series use the latest value and the same seven-point baseline as metric_record.
  const series = all<{ metric_id: string; dims: string; vals: string }>(app.db, `with recursive series(metric_id,dims) as (
    select value, (select min(dims) from metric_points where metric_id=keys.value) from json_each(?) keys
    union all select metric_id, (select min(p.dims) from metric_points p where p.metric_id=s.metric_id and p.dims>s.dims)
      from series s where s.dims is not null)
    select metric_id, dims, (select json_group_array(value) from
      (select value from metric_points p where p.metric_id=s.metric_id and p.dims=s.dims order by at desc limit 8)) vals
    from series s where dims is not null order by metric_id, dims`, JSON.stringify([...byId.keys()]));
  const flagged = new Map<string, string>();
  for (const s of series) {
    const m = byId.get(s.metric_id)!;
    const values = JSON.parse(s.vals) as number[];
    const change = changeOf(m, values.reverse().map(value => ({ value })));
    if (change?.flagged && !flagged.has(m.id)) flagged.set(m.id, describeChange(m, change) + (s.dims === "{}" ? "" : ` ${s.dims}`));
    if (flagged.size === 3) break;
  }
  return [...flagged.values()];
}

export function focusBlock(app: App, focus: Focus, userId: string) {
  const { item, line, stage, listen, context } = focus;
  const date = (at: string) => localStamp(at, app.config.timezone).slice(0, 10);
  const head = "# 这一轮在说的事";
  const tail = `要更多就 read_item(${item.id})。${line ? "这一轮新建的相关事项、变化默认挂在这条线下。" : ""}`;
  const parts = [{ name: "标题", text: head }];
  let remaining = app.config.sessions.turnContextChars - head.length - tail.length - 1;
  const block = (name: string, lines: string[], budget: number) => {
    if (!lines.length || remaining < 12) return;
    const text = truncate(lines.join("\n"), Math.min(remaining - 1, budget));
    parts.push({ name, text });
    remaining -= text.length + 1;
  };
  const spaces = accessibleSpaces(app, userId);
  if (line) {
    const phase = context.line?.phase;
    block("工作线", [`工作线《${compact(line.title, 70)}》 · ${phase === "ended" ? "已结束" : phase === "watching" ? "观察中" : "进行中"}`, ...(line.now ? [`现状（${date(line.now.at)}） ${compact(line.now.text, 180)}`] : [])], 300);
    const next = all<{ text: string }>(app.db, "select text from item_next where item_id=? and status in ('open','doing') order by created_at,id limit 3", line.id);
    block("下一步", next.map(n => `下一步 · ${compact(n.text, 68)}`), 225);
  }
  if (item.id !== line?.id) {
    const parent = item.parentId && one<{ title: string }>(app.db, `select title from items where id=? and user_id=? and (? is null or space_id in (select value from json_each(?)))`, item.parentId, userId, spaces && JSON.stringify(spaces), JSON.stringify(spaces));
    block("事项", [`事项《${item.title}》 · ${status[item.status]}${parent ? ` · 属于《${parent.title}》` : ""}${item.dueAt ? ` · 截止 ${item.dueAt.slice(0, 10)}` : ""}`], 175);
  }
  if (stage && context.stage) {
    const state = stageStates[stage.state] ?? stage.state;
    block("流程", [`流程 · ${context.stage.name}（${state}）${stage.waitingOn ? ` 等${stage.waitingOn}` : ""}${stage.state === "blocked" && stage.note ? ` · ${compact(stage.note, 90)}` : ""}`], 160);
  }
  const root = line?.id ?? item.id;
  const family = line ? [root, ...descendantIds(app, root)] : [item.id];
  const ids = all<{ id: string }>(app.db, `select id from items where id in (select value from json_each(?)) and user_id=? and (? is null or space_id in (select value from json_each(?)))`, JSON.stringify(family), userId, spaces && JSON.stringify(spaces), JSON.stringify(spaces)).map(r => r.id);
  const changes = (asked: boolean) => all<Change>(app.db, `select at,type,summary,status,due from item_changes where item_id in (select value from json_each(?)) and noise=0
    and ${asked ? "status='asked'" : "status!='asked' and at>=?"} order by at desc,id desc limit ?`, JSON.stringify(ids), ...(asked ? [] : [new Date(Date.now() - 7 * 86400_000).toISOString()]), asked ? 3 : 5);
  for (const asked of [true, false]) {
    const label = asked ? "待定" : "近期变化";
    block(label, changes(asked).map(c => {
      const state = c.type === "deadline" && c.due && c.status === "noted" ? "改期待定" : changeStates[c.status] ?? c.status;
      return `${asked ? label : `${label}（${state}）`} · ${date(c.at)} [${kinds[c.type] ?? c.type}] ${compact(c.summary, 65)}`;
    }), asked ? 260 : 400);
  }
  block("指标", flaggedOnLine(app, ids, spaces).map(s => `越过门槛 · ${compact(s, 70)}`), 235);
  if (listen && (!spaces || (spaces.includes(listen.spaceId ?? item.spaceId)))) {
    const path = playbookPath(listen);
    const file = one<{ id: string }>(app.db, "select id from sources where uri=? and space_id=? and deleted_at is null limit 1", `work/${path}`, listen.spaceId ?? item.spaceId);
    block("关注", [`关注《${compact(listen.name, 40)}》 ${compact(listen.note || listen.brief?.valid || "", 60)}`.trim(), ...(file ? [`经验文件 ${path}，要细节用 read_file 读，或 read_source(src:${file.id})。`] : [])], 200);
  }
  parts.push({ name: "详情", text: tail });
  const text = parts.map(p => p.text).join("\n");
  return { text, hash: sha256(text), blocks: parts.map(p => ({ name: p.name, chars: p.text.length })) };
}
