import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import type { CodeChain } from "../agents/code-chain.ts";
import { getThread } from "../agents/threads.ts";
import { getRun } from "../agents/runs.ts";
import { buildCard, sendLark, updateLarkCard, type CardBlock } from "./lark-send.ts";

/**
 * One card per coding delegation, in the Feishu topic of the request: created when coding
 * starts and updated as the rounds go by (worktrees, checks, reviewer, next round), so the
 * owner can follow a long delegation in its own conversation instead of the main one.
 */

type State = { chain: CodeChain; messageId: string; phase: string; status: string; steps: { title: string; done: boolean }[]; text: string; closed: boolean; dirty: boolean };
const states = new Map<string, State>(); // askRunId -> state

const PHASE_LABEL: Record<string, string> = { coder: "编码", reviewer: "评审" };

function render(state: State): CardBlock[] {
  const blocks: CardBlock[] = [];
  blocks.push({ markdown: `第 ${state.chain.round} 轮 · ${PHASE_LABEL[state.phase] ?? state.phase}${state.status ? `：${state.status}` : ""}` });
  if (state.steps.length) blocks.push({ markdown: state.steps.slice(-8).map((s) => `${s.done ? "✓" : "…"} ${s.title}`).join("\n") });
  if (state.text) blocks.push({ hr: true }, { markdown: state.text.slice(-3000) });
  return blocks;
}

async function createCard(app: App, chain: CodeChain, anchorMessageId: string): Promise<string | null> {
  if (!chain.larkKey) return null;
  const [chatId, topic] = chain.larkKey.split("#");
  const card = buildCard({ title: `编码交办 · ${getRun(app, chain.lastCodeRunId ?? chain.rounds[0]).title.slice(0, 40)}`, color: "wathet", blocks: [{ markdown: "已开始，会在这里持续更新。" }] });
  // Groups get a topic (the card starts it); a private chat has no topics, fall back to an ordinary reply.
  let sent = await sendLark({ replyTo: anchorMessageId, inThread: true }, { card }).catch(() => null);
  sent ??= await sendLark({ replyTo: anchorMessageId }, { card }).catch(() => null);
  if (!sent) return null;
  run(app.db, "update conversations set settings = json_set(coalesce(settings,'{}'), '$.lastMessageId', ?) where id = ?", sent.messageId, chain.conversationId);
  return sent.messageId;
}

export function startCodeProgress(app: App, chain: CodeChain) {
  if (!chain.larkKey || states.has(chain.askRunId)) return;
  const thread = getThread(app, chain.conversationId);
  const anchor = thread?.settings.lastMessageId ?? "";
  const state: State = { chain, messageId: chain.larkMessageId ?? "", phase: "coder", status: "已开始", steps: [], text: "", closed: false, dirty: false };
  states.set(chain.askRunId, state);
  if (!state.messageId && anchor) {
    void createCard(app, chain, anchor).then((id) => {
      if (!id) return;
      state.messageId = id;
      const next = { ...chain, larkMessageId: id };
      run(app.db, "update runs set output = json_set(coalesce(output,'{}'), '$.codeChain', ?) where id in (" + chain.rounds.map(() => "?").join(",") + ")", JSON.stringify(next), ...chain.rounds);
      void updateLarkCard(id, buildCard({ title: `编码交办 · ${getRun(app, chain.lastCodeRunId!).title.slice(0, 40)}`, color: "wathet", blocks: render(state) })).catch(() => {});
    });
  }
}

function onEvent(app: App, e: { type: string; runId?: string; event?: { type: string; data: any } }) {
  if (e.type !== "run-event" || !e.runId || !e.event) return;
  const r = getRunSafe(app, e.runId);
  if (!r || r.kind !== "code") return;
  const chain = (r.output as { codeChain?: CodeChain }).codeChain;
  if (!chain?.larkKey) return;
  let st = states.get(chain.askRunId);
  if (!st) {
    st = { chain, messageId: chain.larkMessageId ?? "", phase: "coder", status: "", steps: [], text: "", closed: false, dirty: false };
    states.set(chain.askRunId, st);
  }
  st.chain = chain;
  const { type, data } = e.event;
  const phase = String(data?.phase ?? "coder");
  if (data?.phase) st.phase = phase;
  if (type === "status" && data?.text) st.status = String(data.text).slice(0, 200);
  else if (type === "text" && data?.text) { st.text += String(data.text); st.status = ""; }
  else if (type === "tool" && data?.title) {
    const title = String(data.title).replace(/^mcp\.omem\.|^omem[.:_]/, "").slice(0, 60);
    const step = st.steps.find((x) => x.title === title);
    if (step) step.done = data.status === "completed" || data.status === "failed";
    else st.steps.push({ title, done: data.status === "completed" });
  } else return;
  push(app, st);
}

function getRunSafe(app: App, id: string) {
  try { return getRun(app, id); } catch { return null; }
}

const timers = new Map<string, NodeJS.Timeout>();
function push(app: App, st: State) {
  if (!st.messageId || st.closed) return;
  st.dirty = true;
  if (timers.has(st.chain.askRunId)) return;
  timers.set(st.chain.askRunId, setInterval(() => {
    const s = states.get(st.chain.askRunId);
    if (!s || !s.dirty) {
      const t = timers.get(st.chain.askRunId);
      if (t) clearInterval(t);
      timers.delete(st.chain.askRunId);
      return;
    }
    s.dirty = false;
    void updateLarkCard(s.messageId, buildCard({ title: `编码交办 · 第 ${s.chain.round} 轮`, color: s.closed ? "green" : "wathet", blocks: render(s) })).catch(() => {});
  }, 3000).unref());
}

function onRun(app: App, e: { type: string; runId?: string; status?: string }) {
  if (e.type !== "run" || !e.runId || (e.status !== "done" && e.status !== "failed")) return;
  const r = getRunSafe(app, e.runId);
  if (!r || r.kind !== "code") return;
  const chain = (r.output as { codeChain?: CodeChain }).codeChain;
  if (!chain) return;
  const st = states.get(chain.askRunId);
  if (!st) return;
  const continued = (r.output as { continuedRunId?: string }).continuedRunId;
  if (e.status === "done" && continued) {
    st.status = "评审要求修改，已自动安排下一轮（同一编码会话）";
    st.text = "";
    st.steps = [];
    st.phase = "coder";
    push(app, st);
    return;
  }
  st.closed = true;
  const verdict = (r.output as { verdict?: string }).verdict;
  st.status = e.status === "done"
    ? verdict === "approved" ? "完成，评审通过"
    : verdict === "no-changes" ? "未产生改动，等本人决定"
    : "评审要求修改，等本人决定下一步"
    : `失败：${r.error ?? ""}`.slice(0, 300);
  if (st.messageId) void updateLarkCard(st.messageId, buildCard({ title: `编码交办 · ${st.status}`, color: e.status === "done" ? "green" : "red", blocks: render(st) })).catch(() => {});
}

/** Rebuild a card state from persisted run events (after a service restart). */
function hydrate(app: App, chain: CodeChain): State {
  const st: State = { chain, messageId: chain.larkMessageId ?? "", phase: "coder", status: "", steps: [], text: "", closed: false, dirty: false };
  for (const id of chain.rounds) {
    const r = getRunSafe(app, id);
    if (!r) continue;
    st.chain = { ...st.chain, round: Math.max(st.chain.round, (r.input as { round?: number }).round ?? st.chain.round) };
    for (const ev of all<{ type: string; data: string }>(app.db, "select type, data from run_events where run_id = ? order by seq", id)) {
      const data = JSON.parse(ev.data || "{}") as { phase?: string; text?: string; title?: string; status?: string };
      if (data.phase) st.phase = data.phase;
      if (ev.type === "status" && data.text) st.status = String(data.text).slice(0, 200);
      else if (ev.type === "text" && data.text) st.text += data.text;
      else if (ev.type === "tool" && data.title) {
        const title = data.title.replace(/^mcp\.omem\.|^omem[.:_]/, "").slice(0, 60);
        const step = st.steps.find((x) => x.title === title);
        if (step) step.done = data.status === "completed" || data.status === "failed";
        else st.steps.push({ title, done: data.status === "completed" });
      }
    }
    st.text = st.text.slice(-3000);
    if (r.status === "done") {
      if ((r.output as { continuedRunId?: string }).continuedRunId) {
        st.status = "评审要求修改，已自动安排下一轮（同一编码会话）";
        st.text = "";
        st.steps = [];
        st.phase = "coder";
      } else {
        st.closed = true;
        const verdict = (r.output as { verdict?: string }).verdict;
        st.status = verdict === "approved" ? "完成，评审通过" : verdict === "no-changes" ? "未产生改动，等本人决定" : "评审要求修改，等本人决定下一步";
      }
    } else if (r.status === "failed") {
      st.closed = true;
      st.status = `失败：${r.error ?? ""}`.slice(0, 300);
    }
  }
  return st;
}

/** Subscribe once for the process lifetime. */
export function registerCodeProgress(app: App) {
  // Cards of delegations still running when the process restarted get their state back.
  for (const row of all<{ output: string; status: string }>(app.db, "select output, status from runs where kind = 'code' and output is not null")) {
    try {
      const chain = (JSON.parse(row.output) as { codeChain?: CodeChain }).codeChain;
      if (chain?.larkKey && chain.larkMessageId && ["queued", "running"].includes(row.status)) states.set(chain.askRunId, hydrate(app, chain));
    } catch {}
  }
  app.events.on("event", (e) => onEvent(app, e));
  app.events.on("event", (e) => onRun(app, e));
}
