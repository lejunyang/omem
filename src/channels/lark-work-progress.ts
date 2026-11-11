import { createHash } from "node:crypto";
import { botOfChannel, withBot } from "../core/bot-context.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { truncate, webLink } from "../core/util.ts";
import { getRun, type Run } from "../agents/runs.ts";
import { findThread } from "../agents/threads.ts";
import { progressMessages, refreshWork, workInConversation, type AgentWork } from "../agents/agent-work.ts";
import { buildCard, sendLark, updateLarkCard } from "./lark-send.ts";

/**
 * One progress card per multi-agent work, in its Feishu topic, updated in place (settings → AI →
 * 过程消息 = milestones). The rounds' reports and the coordination replies that only moved the work
 * on stay in the work conversation (agent-work.ts onlyMovedOn); this card is what the owner sees of
 * them: which round, who is working on what, the latest thing it did, and the run page.
 */

type Saved = { messageId?: string; fp?: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

/** The work a run belongs to: a round, a coordination turn, or any turn in the work's own conversation. */
function workIdOf(app: App, r: Run): string | null {
  const input = r.input as { agentWorkId?: string; coordinate?: { workId?: string } };
  if (r.kind === "agent" && input.agentWorkId) return input.agentWorkId;
  if (r.kind === "ask" && input.coordinate?.workId) return input.coordinate.workId;
  if (r.kind === "ask" && r.lane) return workInConversation(app, r.lane)?.askRunId ?? null;
  return null;
}

const firstLine = (s: string) => truncate((s.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "").trim(), 60);

/** The latest thing a run did: a tool it called or a status it reported. */
function lastStep(app: App, runId: string): string {
  const e = one<{ type: string; data: string }>(app.db, "select type, data from run_events where run_id = ? and type in ('tool', 'status') order by seq desc limit 1", runId);
  if (!e) return "";
  const d = JSON.parse(e.data || "{}") as { title?: string; text?: string };
  return truncate(String((e.type === "tool" ? d.title : d.text) ?? "").replace(/\s+/g, " ").trim(), 80);
}

/** What the card shows, from the database alone (testable without Feishu). */
export function workProgressView(app: App, work: AgentWork): { live: boolean; lines: string[]; link: string | null } {
  const live = all<{ id: string; kind: string; status: string; input: string }>(
    app.db,
    "select id, kind, status, input from runs where status in ('queued', 'running') and ((kind = 'agent' and json_extract(input, '$.agentWorkId') = ?) or (kind = 'ask' and lane = ?)) order by created_at",
    work.askRunId,
    work.workConversationId,
  );
  const active = live.find((r) => r.status === "running") ?? live[0];
  const rounds = work.rounds.length;
  const last = work.rounds.at(-1);
  let status: string;
  let stepOf: string | undefined = active?.id ?? last?.runId;
  if (active?.kind === "agent") {
    const input = JSON.parse(active.input) as { spec?: string; task?: string };
    status = `${input.spec ?? "Agent"} ${active.status === "running" ? "在做" : "排队中"}：${firstLine(input.task ?? "")}`;
  } else if (active) {
    const input = JSON.parse(active.input) as { coordinate?: unknown; wake?: unknown };
    status = input.coordinate ? "主助手在看报告、决定下一步" : input.wake ? "主助手按之前设的唤醒接着做" : "主助手在回复你";
  } else {
    stepOf = undefined;
    status = work.awaitingUser ? "停下了，等你回复" : last?.status === "failed" ? "最近一轮失败了，主助手的说明在下面" : "这一轮的结论或问题已发在下面；回复这个话题可以接着做";
  }
  const history = work.rounds.slice(-5).map((r, i, list) => {
    const n = rounds - list.length + i + 1;
    const state = r.status === "queued" ? (live.some((x) => x.id === r.runId && x.status === "running") ? "进行中" : "排队中") : r.status === "done" ? "完成" : "失败";
    return `- 第 ${n} 轮 ${r.agent}：${state}`;
  });
  const step = stepOf ? lastStep(app, stepOf) : "";
  const link = active?.id ?? last?.runId ?? null;
  return {
    live: !!active,
    lines: [
      `**第 ${rounds} 轮** · ${status}`,
      ...(step ? [`最近：${step}`] : []),
      ...(history.length > 1 ? ["", ...history] : []),
    ],
    link: link ? webLink(app, `#/runs/${link}`) : null,
  };
}

function cardOf(app: App, work: AgentWork) {
  const v = workProgressView(app, work);
  return buildCard({
    title: truncate(`进度 · ${work.title}`, 60),
    color: v.live ? "wathet" : "green",
    blocks: [
      { markdown: v.lines.join("\n") },
      { note: `${v.link ? `运行记录：${v.link} · ` : ""}各轮报告和过程在网页的运行页；这里只在做完、要你决定或卡住时发消息。工作标识：${work.askRunId}` },
    ],
  });
}

const savedOf = (app: App, workId: string) => (getRun(app, workId).output.workProgress as Saved | undefined) ?? {};
function save(app: App, workId: string, s: Saved) {
  run(app.db, "update runs set output = json_set(coalesce(output, '{}'), '$.workProgress', json(?)) where id = ?", JSON.stringify(s), workId);
}

const flights = new WeakMap<App, Map<string, Promise<void>>>();

/** Create or update the work's card in its topic. Nothing before the topic exists, nothing in `all` mode. */
export function flushWorkProgress(app: App, workId: string): Promise<void> {
  let map = flights.get(app);
  if (!map) flights.set(app, (map = new Map()));
  const prev = map.get(workId) ?? Promise.resolve();
  const next = prev.then(() => flush(app, workId)).catch((e) => console.warn(`[omem] 工作进度卡片更新失败：${(e as Error).message}`));
  map.set(workId, next);
  void next.finally(() => { if (map!.get(workId) === next) map!.delete(workId); });
  return next;
}

async function flush(app: App, workId: string) {
  if (progressMessages(app) !== "milestones") return;
  const work = refreshWork(app, workId);
  if (!work || work.supersededBy) return;
  const t = findThread(app, work.workConversationId);
  if (!t || !(t.channel === "lark" || t.channel.startsWith("lark:")) || !t.key?.includes("#")) return;
  const card = cardOf(app, work);
  const fp = hash(JSON.stringify(card));
  const s = savedOf(app, workId);
  if (s.fp === fp) return;
  await withBot(botOfChannel(t.channel), async () => {
    if (s.messageId) {
      await updateLarkCard(s.messageId, card);
      save(app, workId, { messageId: s.messageId, fp });
      return;
    }
    const anchor = t.settings.lastMessageId;
    if (!anchor) return;
    const sent = await sendLark({ replyTo: anchor, inThread: true, purpose: "progress", conversationId: t.id }, { card });
    save(app, workId, { messageId: sent.messageId, fp });
  });
}

const registered = new WeakSet<App>();

/** Follow the runs of every work: a status change updates the card soon, a step within a few seconds. */
export function watchWorkProgress(app: App, delays = { status: 500, step: 8000 }) {
  if (registered.has(app)) return () => {};
  registered.add(app);
  const workOf = new Map<string, string | null>();
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const schedule = (workId: string, ms: number) => {
    const due = Date.now() + ms;
    const cur = timers.get(workId);
    if (cur && cur.at <= due) return;
    if (cur) clearTimeout(cur.timer);
    const timer = setTimeout(() => {
      timers.delete(workId);
      void flushWorkProgress(app, workId);
    }, ms);
    timer.unref?.();
    timers.set(workId, { at: due, timer });
  };
  const listener = (e: { type: string; runId?: string; status?: string }) => {
    if (!e.runId || (e.type !== "run" && e.type !== "run-event")) return;
    if (progressMessages(app) !== "milestones") return;
    try {
      let workId = workOf.get(e.runId);
      if (workId === undefined) {
        workId = workIdOf(app, getRun(app, e.runId));
        workOf.set(e.runId, workId);
      }
      if (e.type === "run" && ["done", "failed", "cancelled"].includes(e.status ?? "")) workOf.delete(e.runId);
      if (workId) schedule(workId, e.type === "run" ? delays.status : delays.step);
    } catch {}
  };
  app.events.on("event", listener);
  return () => {
    app.events.off("event", listener);
    for (const t of timers.values()) clearTimeout(t.timer);
    registered.delete(app);
  };
}
