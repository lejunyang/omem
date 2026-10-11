import type { App } from "../core/app.ts";
import type { RoleName } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace, getSpace, updateSpace } from "../core/spaces.ts";
import { json, newId, now, truncate } from "../core/util.ts";
import { addItemEvent, dueReminders, listItems, upsertItem } from "../items/store.ts";
import { syncDirectorySpace } from "../sources/import.ts";
import { getSource } from "../sources/store.ts";
import { listPages, pageExists, syncWiki } from "../wiki/store.ts";
import { runCodeTask } from "./code.ts";
import { runRole } from "./runner.ts";
import { createRun, registerHandler, type RunContext } from "./runs.ts";

const QUIET = /^\s*QUIET\s*$/i;

async function agent(ctx: RunContext, role: RoleName, spaceId: string, task: string, spaces?: string[] | null) {
  const r = await runRole(ctx.app, {
    role,
    spaceId,
    spaces,
    task,
    runId: ctx.run.id,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, e),
  });
  run(ctx.app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  return r;
}

// ---------------------------------------------------------------- conversations

export function ensureConversation(app: App, input: { id?: string; spaceId: string; channel?: string; externalId?: string; title?: string }) {
  if (input.id) {
    const c = one<{ id: string }>(app.db, "select id from conversations where id = ?", input.id);
    if (c) return c.id;
  }
  if (input.externalId) {
    const c = one<{ id: string }>(app.db, "select id from conversations where channel = ? and external_id = ?", input.channel ?? "web", input.externalId);
    if (c) return c.id;
  }
  const id = input.id ?? newId("c");
  run(app.db, "insert into conversations(id,space_id,channel,title,external_id,created_at,updated_at) values(?,?,?,?,?,?,?)", id, input.spaceId, input.channel ?? "web", input.title ?? "", input.externalId ?? null, now(), now());
  return id;
}

export function addMessage(app: App, conversationId: string, role: "user" | "assistant", text: string, runId?: string | null, meta: Record<string, unknown> = {}) {
  const id = newId("msg");
  run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)", id, conversationId, role, text, runId ?? null, JSON.stringify(meta), now());
  run(app.db, "update conversations set updated_at = ?, title = case when title = '' then ? else title end where id = ?", now(), truncate(text.replace(/\s+/g, " "), 40), conversationId);
  return id;
}

export function conversationMessages(app: App, conversationId: string, limit = 200) {
  return all<{ id: string; role: string; text: string; run_id: string | null; meta: string; created_at: string }>(
    app.db,
    "select * from (select * from messages where conversation_id = ? order by created_at desc limit ?) order by created_at",
    conversationId,
    limit,
  ).map((m) => ({ id: m.id, role: m.role, text: m.text, runId: m.run_id, meta: json(m.meta, {}), createdAt: m.created_at }));
}

/** Ask the assistant. Creates the user message immediately and an `ask` run that answers it. */
export function ask(app: App, input: { text: string; spaceId?: string; conversationId?: string; channel?: string; externalId?: string }) {
  const spaceId = input.spaceId ?? "personal";
  const conversationId = ensureConversation(app, { id: input.conversationId, spaceId, channel: input.channel, externalId: input.externalId });
  const messageId = addMessage(app, conversationId, "user", input.text);
  const r = createRun(app, { kind: "ask", spaceId, title: truncate(input.text.replace(/\s+/g, " "), 60), input: { conversationId, messageId, text: input.text } });
  run(app.db, "update messages set run_id = ? where id = ?", r.id, messageId);
  return { conversationId, messageId, runId: r.id };
}

registerHandler("ask", async (ctx) => {
  const { conversationId, messageId, text } = ctx.run.input as { conversationId: string; messageId: string; text: string };
  const history = conversationMessages(ctx.app, conversationId, 13).filter((m) => m.id !== messageId);
  const task = [
    history.length ? `## 本次对话之前的内容（供理解指代）\n\n${history.map((m) => `${m.role === "user" ? "本人" : "助理"}：${truncate(m.text, 1500)}`).join("\n\n")}` : "",
    `## 本人刚发来的消息\n\n${text}`,
    `（消息 id：msg:${messageId}，记忆来源可引用它。）`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await agent(ctx, "assistant", ctx.run.spaceId ?? "personal", task, null);
  const answer = r.text.trim() || "（Agent 没有给出文字回答）";
  const id = addMessage(ctx.app, conversationId, "assistant", answer, ctx.run.id, { agent: r.agent });
  return { answer, messageId: id };
});

// ------------------------------------------------------------------- ingest

export function scheduleIngest(app: App, spaceId: string, sourceIds: string[], note = "") {
  if (!sourceIds.length) return null;
  const space = findSpace(app, spaceId);
  if (!space || space.settings.autoIngest === false || (space.kind === "repo" && space.settings.autoIngest !== true)) return null;
  return createRun(app, { kind: "ingest", spaceId, title: `整理新材料（${sourceIds.length}）`, input: { sourceIds, note } });
}

registerHandler("ingest", async (ctx) => {
  const { sourceIds, note } = ctx.run.input as { sourceIds: string[]; note?: string };
  const lines = sourceIds.map((id) => {
    try {
      const s = getSource(ctx.app, id);
      const range = (s.meta as { appendedFrom?: number }).appendedFrom;
      return `- 原件 ${s.id}：${s.uri}（${s.kind}，「${s.title}」）${range ? `，新内容从第 ${range} 行开始` : ""}`;
    } catch {
      return `- 原件 ${id}（已不存在）`;
    }
  });
  const r = await agent(ctx, "ingest", ctx.run.spaceId!, `新进入的材料：\n${lines.join("\n")}${note ? `\n\n补充说明：${note}` : ""}`);
  return { quiet: QUIET.test(r.text), summary: r.text.trim() };
});

// --------------------------------------------------------------------- wiki

registerHandler("wiki-plan", async (ctx) => {
  const spaceId = ctx.run.spaceId!;
  const { focus, autoWrite = true } = ctx.run.input as { focus?: string; autoWrite?: boolean };
  const existing = listPages(ctx.app, spaceId);
  const r = await agent(
    ctx,
    "wiki-planner",
    spaceId,
    [
      focus ? `本人的要求：${focus}` : "为这个空间规划完整的 Wiki。",
      existing.length ? `已有页面：\n${existing.map((p) => `- ${p.slug}「${p.title}」`).join("\n")}` : "目前还没有页面。",
    ].join("\n\n"),
  );
  const plan = (one<{ output: string }>(ctx.app.db, "select output from runs where id = ?", ctx.run.id)?.output ?? "{}");
  const pages = (json<{ plan?: PageBrief[] }>(plan, {}).plan ?? []) as PageBrief[];
  if (!pages.length) throw new Error("规划没有提交页面计划（submit_plan）");
  if (autoWrite)
    for (const page of pages) createRun(ctx.app, { kind: "wiki-write", spaceId, title: `写作：${page.title}`, input: { brief: page }, parentId: ctx.run.id });
  return { summary: r.text.trim(), pages: pages.length };
});

export type PageBrief = { slug: string; title: string; kind: string; question: string; outline: string; entry_points: string[]; section?: string };

registerHandler("wiki-write", async (ctx) => {
  const spaceId = ctx.run.spaceId!;
  const { brief, instructions } = ctx.run.input as { brief: PageBrief; instructions?: string };
  const exists = pageExists(ctx.app, spaceId, brief.slug);
  const task = [
    `页面：${brief.slug}「${brief.title}」（类型：${brief.kind}）`,
    `读者问题：${brief.question}`,
    `讲解路线：${brief.outline}`,
    `调查入口：${(brief.entry_points ?? []).join("、") || "自行调查"}`,
    exists ? "这个页面已经存在：先 read_page，保留仍然正确且有用的内容，在此基础上改进。" : "",
    instructions ? `本人的补充要求：${instructions}` : "",
    "其他已有/计划中的页面（需要时链接它们，不要重复讲）：\n" + listPages(ctx.app, spaceId).map((p) => `- [[${p.slug}]] ${p.title}`).join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await agent(ctx, "wiki-writer", spaceId, task);
  if (!pageExists(ctx.app, spaceId, brief.slug)) throw new Error(`写作结束但没有提交页面 ${brief.slug}`);
  return { summary: r.text.trim(), page: `${spaceId}/${brief.slug}` };
});

/** Pages whose cited originals changed since they were written. */
export function stalePages(app: App, spaceId: string) {
  return all<{ page_id: string; uris: string }>(
    app.db,
    `select c.page_id, group_concat(distinct s.uri) uris from page_cites c join sources s on s.id = c.source_id
     join pages p on p.id = c.page_id where p.space_id = ? and (s.hash != c.hash or s.deleted_at is not null) group by c.page_id`,
    spaceId,
  );
}

registerHandler("wiki-lint", async (ctx) => {
  const spaceId = ctx.run.spaceId!;
  syncWiki(ctx.app, spaceId);
  const stale = stalePages(ctx.app, spaceId);
  if (!stale.length) return { quiet: true, summary: "没有受影响的页面" };
  const task = `受影响的页面与变化的原件：\n${stale.map((s) => `- ${s.page_id.split("/").slice(1).join("/")}：${s.uris}`).join("\n")}`;
  const r = await agent(ctx, "wiki-linter", spaceId, task);
  return { quiet: QUIET.test(r.text), summary: r.text.trim(), pages: stale.length };
});

// --------------------------------------------------------------------- sync

registerHandler("sync", async (ctx) => {
  const spaceId = ctx.run.spaceId!;
  const report = syncDirectorySpace(ctx.app, spaceId, (done, total) => ctx.event("status", { text: `同步 ${done}/${total}` }));
  ctx.event("status", { text: `新增 ${report.created}，更新 ${report.updated}，移除 ${report.removed}，未变 ${report.unchanged}` });
  const space = getSpace(ctx.app, spaceId);
  if ((report.updated || report.removed) && listPages(ctx.app, spaceId).length && space.settings.autoLint !== false && stalePages(ctx.app, spaceId).length)
    createRun(ctx.app, { kind: "wiki-lint", spaceId, title: "检查受影响页面", parentId: ctx.run.id });
  return { created: report.created, updated: report.updated, removed: report.removed, unchanged: report.unchanged, skipped: report.skipped.length };
});

// ---------------------------------------------------------------- heartbeat

registerHandler("heartbeat", async (ctx) => {
  const app = ctx.app;
  // 1. Due reminders need no model: deliver them directly.
  const due = dueReminders(app);
  for (const item of due) {
    notify(app, { title: `提醒：${item.title}`, body: item.detail, link: `#/items/${item.id}` });
    addItemEvent(app, item.id, "reminded", "已按时提醒", "agent");
    upsertItem(app, item.id, { remindAt: null, status: item.status === "snoozed" ? "open" : item.status }, "agent");
  }
  // 2. Watches and waits only need attention when new material arrived.
  const last = one<{ value: string }>(app.db, "select value from kv where key = 'heartbeat_at'")?.value ?? new Date(Date.now() - 86400_000).toISOString();
  const started = now();
  const fresh = all<{ id: string; space_id: string; uri: string; title: string; kind: string }>(
    app.db,
    "select id, space_id, uri, title, kind from sources where updated_at > ? and deleted_at is null and kind in ('chat','doc','note','web') order by updated_at desc limit 60",
    last,
  );
  const watching = listItems(app, { status: "active" }).filter((i) => i.kind === "watch" || i.kind === "waiting");
  run(app.db, "insert into kv(key,value) values('heartbeat_at', ?) on conflict(key) do update set value = excluded.value", started);
  if (!fresh.length || !watching.length) return { quiet: true, reminders: due.length, summary: due.length ? `发送了 ${due.length} 条提醒` : "QUIET" };
  const sent = all<{ at: string; title: string }>(app.db, "select at, title from notifications where at > ? order by at", last);
  const task = [
    sent.length ? `上次巡检以来已经发给本人的通知（不要重复这些内容）：\n${sent.map((n) => `- ${n.at.slice(0, 16)} ${n.title}`).join("\n")}` : "",
    `关注/等待中的事项：\n${watching.map((i) => `- ${i.id} [${i.kind}] ${i.title}${i.waitingOn ? `（等待 ${i.waitingOn}）` : ""}${i.watch?.query ? `：关注 ${i.watch.query}` : ""}`).join("\n")}`,
    `上次巡检（${last}）以来新增或变化的材料：\n${fresh.map((s) => `- ${s.id} ${s.space_id}:${s.uri}「${s.title}」(${s.kind})`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await agent(ctx, "heartbeat", "personal", task, null);
  return { quiet: QUIET.test(r.text), reminders: due.length, summary: r.text.trim() };
});

// -------------------------------------------------------------------- dream

registerHandler("dream", async (ctx) => {
  const app = ctx.app;
  const since = one<{ value: string }>(app.db, "select value from kv where key = 'dream_at'")?.value ?? "1970-01-01";
  const mems = all<{ id: string; space_id: string; kind: string; subject: string; content: string; status: string }>(
    app.db,
    "select id, space_id, kind, subject, content, status from memories where updated_at > ? order by updated_at desc limit 80",
    since,
  );
  const items = all<{ id: string; space_id: string; kind: string; title: string; status: string; remind_at: string | null; due_at: string | null }>(
    app.db,
    "select id, space_id, kind, title, status, remind_at, due_at from items where updated_at > ? or (status in ('open','waiting','snoozed') and coalesce(due_at, remind_at, '9999') < ?) order by updated_at desc limit 80",
    since,
    now(),
  );
  const runs = all<{ kind: string; title: string; status: string; error: string | null }>(app.db, "select kind, title, status, error from runs where created_at > ? and kind != 'dream' order by created_at desc limit 40", since);
  run(app.db, "insert into kv(key,value) values('dream_at', ?) on conflict(key) do update set value = excluded.value", now());
  if (!mems.length && !items.length) return { quiet: true, summary: "自上次整理以来没有新的记忆或事项" };
  const task = [
    `上次整理：${since}`,
    `有变化的记忆（${mems.length}）：\n${mems.map((m) => `- ${m.id} [${m.space_id}/${m.kind}/${m.status}] ${m.subject ? m.subject + "：" : ""}${truncate(m.content, 160)}`).join("\n")}`,
    `有变化或已过期的事项（${items.length}）：\n${items.map((i) => `- ${i.id} [${i.space_id}/${i.kind}/${i.status}] ${i.title}${i.due_at ? " 截止 " + i.due_at : ""}${i.remind_at ? " 提醒 " + i.remind_at : ""}`).join("\n")}`,
    runs.length ? `期间的后台运行（用于提炼经验）：\n${runs.map((r) => `- [${r.kind}/${r.status}] ${r.title}${r.error ? "：" + truncate(r.error, 120) : ""}`).join("\n")}` : "",
    "需要更多上下文时用 recall（可加 include_history）和 list_items 查同主题的其他记录。",
  ]
    .filter(Boolean)
    .join("\n\n");
  const r = await agent(ctx, "dreamer", ctx.run.spaceId ?? "personal", task, null);
  return { summary: r.text.trim() };
});

// -------------------------------------------------------------------- brief

registerHandler("brief", async (ctx) => {
  const app = ctx.app;
  const since = one<{ value: string }>(app.db, "select value from kv where key = 'brief_at'")?.value ?? new Date(Date.now() - 86400_000).toISOString();
  const items = listItems(app, { status: "active" });
  const fresh = all<{ id: string; space_id: string; uri: string; title: string; kind: string }>(
    app.db,
    "select id, space_id, uri, title, kind from sources where updated_at > ? and deleted_at is null and kind != 'code' order by updated_at desc limit 60",
    since,
  );
  const runs = all<{ id: string; kind: string; title: string; status: string }>(app.db, "select id, kind, title, status from runs where finished_at > ? and kind in ('code','wiki-plan','wiki-write','ingest') order by finished_at desc limit 30", since);
  run(app.db, "insert into kv(key,value) values('brief_at', ?) on conflict(key) do update set value = excluded.value", now());
  const task = [
    `时间范围：${since} 至今`,
    `进行中的事项（${items.length}）：\n${items.map((i) => `- ${i.id} [${i.kind}/${i.status}] ${i.title}${i.dueAt ? " 截止 " + i.dueAt : ""}${i.remindAt ? " 提醒 " + i.remindAt : ""}${i.waitingOn ? " 等待 " + i.waitingOn : ""}（更新于 ${i.updatedAt.slice(0, 16)}）`).join("\n") || "（无）"}`,
    `期间新增或更新的材料（${fresh.length}）：\n${fresh.map((s) => `- ${s.id} ${s.space_id}:${s.uri}「${s.title}」(${s.kind})`).join("\n") || "（无）"}`,
    `期间完成的后台运行：\n${runs.map((r) => `- ${r.id} [${r.kind}/${r.status}] ${r.title}`).join("\n") || "（无）"}`,
  ].join("\n\n");
  const r = await agent(ctx, "brief", "personal", task, null);
  return { summary: r.text.trim() };
});

// -------------------------------------------------------------------- tutor

registerHandler("tutor", async (ctx) => {
  const { sourceIds, focus } = ctx.run.input as { sourceIds: string[]; focus?: string };
  const list = sourceIds.map((id) => {
    const s = getSource(ctx.app, id);
    return `- ${s.id} ${s.uri}「${s.title}」`;
  });
  const r = await agent(ctx, "tutor", ctx.run.spaceId!, `材料：\n${list.join("\n")}${focus ? `\n\n学习重点：${focus}` : ""}`);
  return { summary: r.text.trim() };
});

registerHandler("code", runCodeTask);

export function scheduleSpaceSync(app: App, spaceId: string) {
  const s = getSpace(app, spaceId);
  updateSpace(app, spaceId, { settings: { ...s.settings, syncRequestedAt: now() } });
  return createRun(app, { kind: "sync", spaceId, title: `同步 ${s.name}` });
}
