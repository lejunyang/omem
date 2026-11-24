import { highQuietRules } from "../rules/quiet-stats.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { json, localStamp, now, truncate } from "../core/util.ts";
import { listMetrics, metricsSummary } from "../data/metrics.ts";
import { workUri } from "../sources/work.ts";
import { listCodeWorks } from "./code-works.ts";
import { flaggedMetrics, listenDigest } from "./proactive.ts";
import { runRole } from "./runner.ts";
import { createRun, listRuns, type RunContext } from "./runs.ts";
import { replyOf } from "./types.ts";
import { workStateBrief } from "./work-state.ts";

/**
 * The weekly report (Friday afternoon, schedule `weekly-report`): the brief role in its weekly mode
 * writes the week up as a work file 周报/<YYYY>-W<ww>.md in the personal space, and the owner gets one
 * later-urgency notification linking to it. The material is what omem knows of the week — the 关注
 * and their summaries, items and flows, coding, meetings, metrics, the work state — and last week's
 * report as the owner left it: what they changed there is how they want it written.
 *
 * The run reads and writes that one file; the notification is the host's.
 */
export const WEEKLY_DIR = "周报";
export const weeklyPath = (label: string) => `${WEEKLY_DIR}/${label}.md`;
const WRITTEN = (label: string) => `weekly_report_written:${label}`;

/** The ISO week of a moment in the owner's time zone, as "2026-W47". */
export function weekLabel(app: App, at = new Date()): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: app.config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  // The ISO week belongs to the year of its Thursday.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const week = Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Queue the weekly report unless one is waiting or running. */
export function scheduleWeeklyReport(app: App) {
  const busy = [...listRuns(app, { kind: "brief", status: "queued" }), ...listRuns(app, { kind: "brief", status: "running" })].find((r) => r.input.mode === "weekly");
  if (busy) return busy;
  return createRun(app, { kind: "brief", spaceId: "personal", title: `周报 ${weekLabel(app)}`, input: { mode: "weekly" } });
}

type ReportFile = { id: string; uri: string; text: string; updatedAt: string };

function reportFile(app: App, label: string): ReportFile | null {
  const r = one<{ id: string; uri: string; text: string; updated_at: string }>(app.db, "select id, uri, text, updated_at from sources where kind = 'work' and uri = ? and deleted_at is null order by updated_at desc limit 1", workUri(weeklyPath(label)));
  return r ? { id: r.id, uri: r.uri, text: r.text, updatedAt: r.updated_at } : null;
}

/** This week's report as written so far (the morning card links it on Fridays), or null. */
export function weeklyReportFile(app: App, at = new Date()) {
  const label = weekLabel(app, at);
  const f = reportFile(app, label);
  return f ? { id: f.id, label } : null;
}

/** Lines the owner took out (or rewrote) and put in, comparing the report as written with the file now. */
export function ownerEdits(written: string, current: string, max = 15) {
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const before = new Set(lines(written));
  const after = new Set(lines(current));
  return { removed: [...before].filter((l) => !after.has(l)).slice(0, max), added: [...after].filter((l) => !before.has(l)).slice(0, max) };
}

/** The latest earlier report as it stands, and what the owner changed in it since it was written. */
export function previousReport(app: App, label: string) {
  const r = one<{ id: string; uri: string; text: string; updated_at: string }>(
    app.db,
    "select id, uri, text, updated_at from sources where kind = 'work' and uri like ? and uri < ? and deleted_at is null order by uri desc limit 1",
    `${workUri(WEEKLY_DIR)}/%`,
    workUri(weeklyPath(label)),
  );
  if (!r) return null;
  const prevLabel = r.uri.slice(workUri(WEEKLY_DIR).length + 1).replace(/\.md$/, "");
  const written = one<{ value: string }>(app.db, "select value from kv where key = ?", WRITTEN(prevLabel))?.value ?? null;
  const edits = written !== null && written.trim() !== r.text.trim() ? ownerEdits(written, r.text) : null;
  return { label: prevLabel, id: r.id, text: r.text, edited: !!edits, edits, known: written !== null };
}

const STATE: Record<string, string> = { pending: "未开始", gated: "等本人同意", doing: "进行中", blocked: "卡住", done: "完成", skipped: "跳过", stale: "要复核" };

/** Flow stages that moved this week, per item, and where each flow stands now. */
function flowProgress(app: App, since: string) {
  const log = all<{ item_id: string; stage_id: string; to_state: string; at: string; note: string }>(
    app.db,
    "select item_id, stage_id, to_state, at, note from item_stage_log where at > ? and to_state in ('done','skipped','blocked','gated') order by at limit 300",
    since,
  );
  const items = [...new Set(log.map((l) => l.item_id))].slice(0, 15);
  return items.map((id) => {
    const f = one<{ flow_id: string; definition: string; ended_at: string | null }>(app.db, "select flow_id, definition, ended_at from item_flows where item_id = ?", id);
    const names = new Map((json<{ stages?: { id: string; name?: string }[] }>(f?.definition ?? "{}", {}).stages ?? []).map((s) => [s.id, s.name ?? s.id]));
    const title = one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? id;
    const moved = log.filter((l) => l.item_id === id).map((l) => `${names.get(l.stage_id) ?? l.stage_id} ${STATE[l.to_state] ?? l.to_state}${l.to_state === "blocked" && l.note ? `（${truncate(l.note.replace(/\s+/g, " "), 60)}）` : ""}`);
    const nowAt = all<{ stage_id: string; state: string }>(app.db, "select stage_id, state from item_stages where item_id = ? and state in ('doing','gated','blocked')", id).map((s) => `${names.get(s.stage_id) ?? s.stage_id} ${STATE[s.state]}`);
    return `- ${id}「${truncate(title, 50)}」${f ? `（流程 ${f.flow_id}${f.ended_at ? "，已结束" : ""}）` : ""}：${[...new Set(moved)].join("、")}${nowAt.length ? `；现在：${nowAt.join("、")}` : ""}`;
  });
}

/** The owner's items that changed this week, with their latest few events. */
function itemChanges(app: App, since: string) {
  const items = all<{ id: string; kind: string; status: string; title: string; updated_at: string }>(
    app.db,
    "select id, kind, status, title, updated_at from items where updated_at > ? and coalesce(user_id, 'owner') = 'owner' and status != 'candidate' order by status in ('done','cancelled','expired') desc, updated_at desc limit 30",
    since,
  );
  return items.map((i) => {
    const events = all<{ kind: string; text: string }>(app.db, "select kind, text from item_events where item_id = ? and at > ? and kind in ('created','status','note','updated','stage') order by at desc limit 3", i.id, since);
    return `- ${i.id} [${i.kind}/${i.status}] ${truncate(i.title, 60)}${events.length ? `：${events.map((e) => truncate(e.text.replace(/\s+/g, " "), 80)).join("；")}` : ""}`;
  });
}

/** Work lines that ended this week with their closing summary, and those that went into 观察 (items/lifecycle.ts). */
export function linesEnded(app: App, since: string) {
  const ended = all<{ id: string; title: string; status: string; closed_at: string; now: string | null }>(app.db,
    `select i.id, i.title, i.status, i.closed_at, i.now from items i where i.parent_id is null and i.status in ('done','cancelled') and i.closed_at > ? and coalesce(i.user_id,'owner') = 'owner'
       and (i.kind = 'line' or i.phase is not null or exists(select 1 from items c where c.parent_id = i.id) or exists(select 1 from item_events e where e.item_id = i.id and e.kind = 'line-end'))
     order by i.closed_at limit 15`, since);
  const watching = all<{ id: string; title: string; phase_since: string; watch_until: string | null }>(app.db,
    "select id, title, phase_since, watch_until from items where parent_id is null and phase = 'watching' and phase_since > ? and status in ('open','waiting','snoozed') and coalesce(user_id,'owner') = 'owner' order by phase_since limit 15", since);
  const reason = (id: string) => one<{ text: string }>(app.db, "select text from item_events where item_id = ? and kind = 'line-end' order by id desc limit 1", id)?.text.replace(/\n?<!--[\s\S]*?-->\s*$/, "").trim();
  return [
    ...ended.map((l) => {
      const summary = json<{ summary?: string } | null>(l.now, null)?.summary;
      return `- ${l.id}「${truncate(l.title, 50)}」${l.status === "cancelled" ? "放弃了" : "结束了"}（${localStamp(l.closed_at, app.config.timezone, { short: true }).slice(0, 5)}${reason(l.id) ? `；${truncate(reason(l.id)!, 100)}` : ""}）${summary ? `\n  收尾小结：${truncate(summary.replace(/\s+/g, " "), 600)}` : ""}`;
    }),
    ...watching.map((l) => `- ${l.id}「${truncate(l.title, 50)}」进入观察（${localStamp(l.phase_since, app.config.timezone, { short: true }).slice(0, 5)} 起${l.watch_until ? `，到 ${localStamp(l.watch_until, app.config.timezone, { short: true }).slice(0, 5)}` : ""}）`),
  ];
}

/** Meetings this week, with the summary the meeting's agent wrote at the end when there is one. */
function meetings(app: App, since: string) {
  return all<{ meeting_id: string; topic: string; started_at: string; source_id: string | null }>(app.db, "select meeting_id, topic, started_at, source_id from lark_meetings where started_at > ? order by started_at limit 20", since).map((m) => {
    const final = one<{ a: string | null }>(app.db, "select json_extract(output, '$.answer') a from runs where lane = ? and status = 'done' and json_extract(input, '$.meetingWindow') is null order by created_at desc limit 1", `meeting:${m.meeting_id}`)?.a;
    return `- ${localStamp(m.started_at, app.config.timezone, { short: true })}「${truncate(m.topic || "无标题", 40)}」${m.source_id ? ` src:${m.source_id}` : ""}${final ? `\n  会后小结：${truncate(final.replace(/\s+/g, " "), 400)}` : ""}`;
  });
}

/** Coding delegations and branch reviews that moved this week: where each ended up. */
function coding(app: App, since: string) {
  return listCodeWorks(app, { ended: true, limit: 80 })
    .filter((w) => w.updatedAt > since)
    .slice(0, 15)
    .map((w) => `- ${w.rootId}「${truncate(w.title, 50)}」${w.branchReview ? "（评审分支）" : ""}${w.repos.length ? ` ${w.repos.map((r) => `${r.space}${r.branch ? `@${r.branch}` : ""}`).join("、")}` : ""}：${w.stage.text}${w.stage.group === "ended" ? "" : `，${truncate(w.now, 60)}`}${w.item ? `；事项 ${w.item.id}` : ""}`);
}

/** The task of the weekly mode: the week's material, the previous report and where to write. */
export function weeklyTask(app: App, since: string, until: string, label: string) {
  const path = weeklyPath(label);
  const prev = previousReport(app, label);
  const current = reportFile(app, label);
  const listen = listenDigest(app, since, { examples: 0, summaryChars: 600, knobs: false, when: "本周" });
  const metrics = listMetrics(app, { activeOnly: true }).filter((m) => m.lastAt && m.lastAt > since);
  const flagged = flaggedMetrics(app, since);
  const lines = workStateBrief(app, 3000);
  const section = (title: string, rows: string[]) => `## ${title}\n\n${rows.join("\n") || "（无）"}`;
  return [
    `# 周报（${label}）`,
    `时间范围：${localStamp(since, app.config.timezone)} 至 ${localStamp(until, app.config.timezone)}。`,
    `写完用 write_file(path="${path}", space="personal") 交上去（整份替换），不要另建别的文件、不发通知、不改事项：宿主会把文件链接发给本人。最后用两三句话说这周最要紧的是什么，这几句会放在通知里。`,
    prev
      ? `## 上一份周报（${prev.label}，src:${prev.id}）\n\n${
          prev.edited
            ? `本人改过这一份。改动就是本人要的写法：删掉的那类内容这次不写，加上或改成的那种说法这次照着用。\n\n本人删掉或改掉的行：\n${prev.edits!.removed.map((l) => `- ${truncate(l, 160)}`).join("\n") || "（无）"}\n\n本人加上或改成的行：\n${prev.edits!.added.map((l) => `- ${truncate(l, 160)}`).join("\n") || "（无）"}\n\n现在的全文：`
            : prev.known
              ? "本人没改过这一份：结构和详略可以沿用。全文："
              : "（不知道本人改没改过）全文："
        }\n\n${truncate(prev.text, 6000)}`
      : "## 上一份周报\n\n（还没有，这是第一份：按角色说明里周报的结构写）",
    current ? `## 这周已经有一份（src:${current.id}，可能是本人改过的）\n\n在它的基础上更新，本人写的地方原样保留：\n\n${truncate(current.text, 6000)}` : "",
    lines ? `## 本人近况（work-state 整理的这几周在推进的线；全文 read_page(space="personal", page="state/work")）\n\n${lines}` : "",
    listen.text ? listen.text.replace(/^### /, "## ") : "",
    section("本周结束和进入观察的工作线（结束的带收尾小结）", linesEnded(app, since)),
    section("事项本周的变化（已结束的在前）", itemChanges(app, since)),
    section("流程进展", flowProgress(app, since)),
    section("安静率高的规则（过去 7 天，供本人核对，不自动改规则）", highQuietRules(app, new Date(until))),
    section("编码交办和评审", coding(app, since)),
    section("会议", meetings(app, since)),
    metrics.length || flagged.length
      ? `## 指标（本周取过数的；放图用 metric_read(chart=true) 拿图表块）\n\n${metricsSummary(app, metrics)}${flagged.length ? `\n\n超过门槛的：\n${flagged.map((f) => f.line).join("\n")}` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The weekly mode of the brief run (agents/jobs.ts hands it here). */
export async function weeklyReport(ctx: RunContext) {
  const app = ctx.app;
  const until = now();
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const last = one<{ value: string }>(app.db, "select value from kv where key = 'weekly_report_at'")?.value ?? weekAgo;
  // A report missed for weeks still covers this week only.
  const since = last > weekAgo ? last : weekAgo;
  const label = weekLabel(app, new Date(until));
  const task = weeklyTask(app, since, until, label);
  const userId = one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", ctx.run.id)?.user_id ?? undefined;
  const r = await runRole(app, {
    role: "brief",
    spaceId: "personal",
    spaces: null,
    task,
    runId: ctx.run.id,
    signal: ctx.signal,
    userId,
    // Read-only besides its file: the notification is the host's, items are the daily brief's business.
    denyTools: ["notify", "upsert_item"],
    addTools: ["metric_read"],
    onEvent: (e) => ctx.event(e.type, e),
  });
  run(app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  if (ctx.signal.aborted) throw new Error("CANCELLED");
  const file = reportFile(app, label);
  const mine = !!file && (file.updatedAt >= until || one(app.db, "select 1 from sources where id = ? and json_extract(meta, '$.runId') = ?", file.id, ctx.run.id));
  if (!file || !mine) throw new Error(`这次没有写出周报文件 ${weeklyPath(label)}（个人空间）`);
  // What the run left: next week's run compares the file with it to see what the owner changed.
  run(app.db, "insert into kv(key,value) values(?, ?) on conflict(key) do update set value = excluded.value", WRITTEN(label), file.text);
  run(app.db, "insert into kv(key,value) values('weekly_report_at', ?) on conflict(key) do update set value = excluded.value", until);
  const said = replyOf(r).trim();
  notify(app, { title: `周报 · ${label}`, body: truncate(said || "这周的周报写好了，点开看；直接在文件里改，下周照你改的写。", 600), link: `#/sources/${file.id}`, urgency: "later", runId: ctx.run.id, userId: userId ?? undefined });
  return { summary: said, file: file.id, label };
}
