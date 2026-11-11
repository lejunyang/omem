import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, newId, now, truncate, webLink } from "../core/util.ts";
import { cancelAsk, createAsk, getAsk, registerAskHandler, type Ask } from "../agents/asks.ts";
import { CODE_HANDOFF_DENY, reportConversation, type CodeChain } from "../agents/code-chain.ts";
import { listTasks, taskLabel, type CodeTask } from "../agents/code-tasks.ts";
import type { PreCheck } from "../agents/pre-check.ts";
import { createRun, getRun, requeueRun, runUser, setRunOutput, type Run } from "../agents/runs.ts";
import { getThread } from "../agents/threads.ts";
import type { UiField } from "../agents/ui-blocks.ts";
import { designLine, designMarkdown } from "./render.ts";
import {
  createDesign, decideDesign, designCounts, designFeedback, designForWork, designSettings, findDesign, getDesign, onDesignDecided, setDesignStatus, setDesignWork,
  type Design, type DesignAction,
} from "./store.ts";
import { KIND_LABELS } from "./types.ts";

/**
 * A delegation and its design (docs/v2/coding-plan.md §3): whether the delegation writes one first,
 * the design stage between the check before coding and the coder, waiting for the owner (or the
 * assistant) to confirm it, coding from it, and the change description a delegation without one
 * hands in at the end. The state lives in the database — the design's status, the first run's
 * output (`designWait`, `designSession`, `designSkipped`) — so a restart finds a delegation waiting
 * where it was. A confirmation from anywhere (the card, the web page, settle_design) goes through
 * decideDesign and is acted on once, here.
 */

export type DesignMode = "auto" | "always" | "never";
/** What the first run keeps while it waits: the design, who confirms it, and the card asking the owner. */
export type DesignWait = { designId: string; by: "owner" | "assistant"; askId?: string; at: string };

const ACTIONS: { label: string; action: DesignAction }[] = [{ label: "通过", action: "approve" }, { label: "提意见", action: "comment" }, { label: "换个思路", action: "rethink" }];

/**
 * Whether this delegation writes a design before coding, and why: the delegation's own `design`, a
 * repository set to always, the setting, then (auto) the check before coding's answer. No answer: no.
 */
export function wantsDesign(app: App, root: Run, pre: PreCheck | null): { want: boolean; why: string } {
  const input = root.input as { design?: DesignMode; repos?: string[] };
  if (input.design === "never") return { want: false, why: "交办时说了不写方案" };
  if (input.design === "always") return { want: true, why: "交办时要求先写方案" };
  const always = (input.repos ?? [root.spaceId ?? ""]).find((id) => findSpace(app, id)?.settings.design === "always");
  if (always) return { want: true, why: `仓库 ${always} 设为总是先写方案` };
  const mode = designSettings(app).mode;
  if (mode === "never") return { want: false, why: "设置为不写方案" };
  if (mode === "always") return { want: true, why: "设置为总是先写方案" };
  const said = pre?.design;
  if (!said) return { want: false, why: "编码前检查没有说要写方案" };
  return { want: !!said.needed, why: said.why ? `编码前检查：${said.why}` : said.needed ? "编码前检查认为要先写方案" : "编码前检查认为不用写方案" };
}

/**
 * The design stage of a new delegation's first round, after the check before coding. Returns what
 * coding goes by — the approved own design, someone else's design taken as the baseline, or none — or
 * `wait` when the round ends here until the design is confirmed. A designer that hands nothing in
 * does not hold the delegation up: coding goes on without a design.
 */
export async function designStage(app: App, o: {
  run: Run; task: string; spaces: string[]; cwd: string; signal: AbortSignal; event: (type: string, data: unknown) => void; pre: PreCheck | null;
}): Promise<{ wait: true } | { wait: false; design: Design | null }> {
  const root = getRun(app, o.run.id);
  const input = root.input as { itemId?: string; repos?: string[] };
  if (root.output.designSkipped) return { wait: false, design: null };
  let d = designForWork(app, root.id);
  if (!d) {
    const want = wantsDesign(app, root, o.pre);
    if (!want.want) return { wait: false, design: null };
    d = createDesign(app, { spaceId: root.spaceId!, title: root.title, origin: "own", itemId: input.itemId ?? null, repos: input.repos ?? [], workId: root.id, userId: runUser(app, root.id) });
    o.event("status", { phase: "design", text: `先写方案（${want.why}），本人确认后再编码` });
  }
  if (d.origin !== "own" || d.status === "approved") return { wait: false, design: d };
  if (d.status === "review") {
    // Found waiting (a restart while the card was out): it still waits.
    confirm(app, root, d);
    return { wait: true };
  }
  const said = designFeedback(app, d.id).at(-1);
  // A comment is worked in by the session that wrote the version; another approach starts afresh.
  const resume = d.revision && said?.action === "comment" ? (root.output.designSession as string | undefined) : undefined;
  setRunOutput(app, root.id, { reviewStage: "design" });
  const { runDesigner } = await import("./designer.ts");
  const before = d.revision;
  let res: Awaited<ReturnType<typeof runDesigner>> | null = null;
  try {
    res = await runDesigner(app, { design: d, run: root, task: o.task, cwd: o.cwd, spaces: o.spaces, signal: o.signal, event: o.event, resumeSessionId: resume });
  } catch (e) {
    if (o.signal.aborted) throw e;
    o.event("status", { phase: "design", text: `写方案没能完成（${truncate((e as Error).message, 200)}）` });
  }
  if (res?.sessionId) setRunOutput(app, root.id, { designSession: res.sessionId });
  if (res?.design) {
    confirm(app, root, res.design);
    return { wait: true };
  }
  if (before) {
    // A rewrite that came to nothing: the last version is still there to confirm.
    setDesignStatus(app, d.id, "review");
    o.event("status", { phase: "design", text: `没有按意见写出新的一版，第 ${before} 版仍等确认${res?.text ? `：${truncate(res.text, 200)}` : ""}` });
    confirm(app, root, getDesign(app, d.id), "上次的意见没能改出新的一版（写方案的角色没有交），下面还是上一版。");
    return { wait: true };
  }
  // No first version: coding goes on without one, and the work is not tied to an empty design.
  setDesignWork(app, d.id, null);
  setRunOutput(app, root.id, { reviewStage: null });
  o.event("status", { phase: "design", text: `写方案的角色没有交方案，直接编码${res?.text ? `：${truncate(res.text, 200)}` : ""}` });
  return { wait: false, design: null };
}

/**
 * A delegation without a design of its own gets an empty change description to hand in at the end
 * (submit_design, `derived`). Once per delegation; not when it goes by a design.
 */
export function ensureDerived(app: App, root: Run): Design {
  const had = designForWork(app, root.id);
  if (had) return had;
  const input = root.input as { itemId?: string; repos?: string[] };
  return createDesign(app, { spaceId: root.spaceId!, title: root.title, origin: "derived", itemId: input.itemId ?? null, repos: input.repos ?? [], workId: root.id, userId: runUser(app, root.id) });
}

/** The design a delegation codes from: an approved own design, or someone else's taken as the baseline. */
export function goesBy(app: App, rootId: string): Design | null {
  const d = designForWork(app, rootId);
  return d && d.revision > 0 && ((d.origin === "own" && d.status === "approved") || d.origin === "external") ? d : null;
}

/** The design in the coder's task: what to build from, how its tasks name the decisions, what to say when it departs. */
export function designCoderText(app: App, d: Design): string {
  const head = d.origin === "own"
    ? `## 方案（本人已确认，第 ${d.revision} 版）`
    : `## 方案（别人写的方案，评估过，第 ${d.revision} 版；照它实现，评估时的意见在各决定下面）`;
  return [
    head,
    "这次照下面的方案实现。拆修改项时每项填它属于哪个决定（plan_tasks 的 decision）；做不下去、要换做法时用 report_task 说明，不要悄悄偏离；做完一项时实际做法和方案不一样的写进 finish_task 的 deviation，做完以后看出更简单或可以统一的做法写 simpler。",
    designMarkdown(app, d, { mode: "full" }).replace(/^# /, "### ").replace(/\n## /g, "\n#### "),
  ].join("\n\n");
}

/** The design in what a reviewer and review-lead read: the decisions, so findings can name the one they are about. */
export function designReviewText(app: App, rootId: string): string {
  const d = designForWork(app, rootId);
  if (!d || !d.revision) return "";
  const what = d.origin === "derived" ? "变更说明（编码或拆分时写的）" : d.origin === "own" ? "本人确认过的方案" : "别人写的方案（评估过，意见在各决定下面）";
  return [
    `## 方案：${what}`,
    "每条问题填它属于哪个决定（decision）；对不上任何决定、也对不上需求点的，是“方案之外”的改动，问题照常提，不填 decision。",
    designMarkdown(app, d, { mode: "brief" }).replace(/^# /, "### ").replace(/\n## /g, "\n#### "),
  ].join("\n\n");
}

/** The decisions in a work's closing summary: one line each, its state from its tasks, a deviation marked. */
export function designDigest(app: App, rootId: string): string {
  const d = designForWork(app, rootId);
  if (!d || !d.revision) return "";
  const tasks = listTasks(app, rootId);
  const lines = d.body.decisions.map((x) => {
    const mine = tasksOf(d, x.id, tasks).filter((t) => t.state !== "reverted");
    const done = mine.filter((t) => t.state === "done").length;
    const state = x.after?.done ? { yes: "做了", partly: "部分", no: "没做" }[x.after.done]
      : mine.length ? (done === mine.length ? "做了" : done ? `做了 ${done} / ${mine.length} 项` : "没做") : "";
    return `- ${x.id} [${KIND_LABELS[x.kind]}] ${x.title}${state ? `：${state}` : ""}${x.after?.deviation ? "（有偏差）" : ""}`;
  });
  const outside = d.origin === "derived" ? [] : tasks.filter((t) => !t.origin.decision && t.kind === "build" && t.state === "done");
  return [
    `**${d.origin === "derived" ? "变更说明" : "方案"}**：${d.body.decisions.length} 个决定`,
    ...lines.slice(0, 12),
    lines.length > 12 ? `- ……另有 ${lines.length - 12} 个` : "",
    outside.length ? `- 方案之外：${outside.map((t) => taskLabel(t.seq)).join("、")}` : "",
  ].filter(Boolean).join("\n");
}

/** A decision's tasks: those naming it (own, someone else's design), or those it lists (a change description). */
export function tasksOf(d: Design, decisionId: string, tasks: CodeTask[]): CodeTask[] {
  const x = d.body.decisions.find((y) => y.id === decisionId);
  if (!x) return [];
  if (d.origin === "derived") return tasks.filter((t) => x.tasks?.includes(t.seq));
  return tasks.filter((t) => t.origin.decision === decisionId);
}

// ---- confirming ---------------------------------------------------------------------------------

/**
 * Ask for the design to be confirmed: the assistant that delegated, when the setting leaves it to it
 * and nothing in the design waits on the owner; else the owner, with a card (each open question a
 * field of its own). Once: an open card or a turn already queued is kept.
 */
function confirm(app: App, root: Run, d: Design, note = "") {
  const chain = (getRun(app, root.id).output.codeChain as CodeChain | undefined) ?? null;
  const prev = getRun(app, root.id).output.designWait as DesignWait | undefined;
  const toAssistant = designSettings(app).confirm === "assistant" && !designCounts(d.body).questions && !!chain;
  let wait: DesignWait;
  if (toAssistant) {
    wakeAssistant(app, root, d, chain!);
    wait = { designId: d.id, by: "assistant", at: now() };
  } else {
    const open = prev?.askId && prev.designId === d.id ? one(app.db, "select 1 from asks where id = ? and status = 'pending'", prev.askId) : null;
    const askId = open ? prev!.askId! : askOwner(app, root, d, chain, note).id;
    wait = { designId: d.id, by: "owner", askId, at: now() };
  }
  setRunOutput(app, root.id, { designWait: wait, verdict: "awaiting-design", reviewStage: null });
}

function askOwner(app: App, root: Run, d: Design, chain: CodeChain | null, note: string): Ask {
  const questions = d.body.decisions.filter((x) => x.question && !x.question.answer);
  const lines = d.body.decisions.map((x) => `- ${x.id} [${KIND_LABELS[x.kind]}] ${x.title}${x.question && !x.question.answer ? "（要你定）" : ""}`);
  const question = [
    `**方案写好了：${truncate(root.title, 60)}**`,
    note,
    `第 ${d.revision} 版 · ${designLine(d)}`,
    lines.join("\n"),
    `全文：${webLink(app, `#/design/${d.id}`)}`,
    `通过后开始编码；提意见会按你说的改一版再给你看；换个思路会重新写。${questions.length ? "要你定的问题在下面选，也可以在方案页上写别的回答。" : ""}`,
  ].filter(Boolean).join("\n\n");
  const fields: UiField[] | null = questions.length
    ? [
        { id: "action", type: "choice", label: "你的决定", options: ACTIONS.map((a) => a.label), default: ACTIONS[0].label, required: true },
        ...questions.map((x): UiField => ({
          id: x.id, type: "choice", label: truncate(`${x.id}：${x.question!.text}`, 200), options: x.question!.options.map((o) => truncate(o, 200)),
          ...(x.question!.recommended !== undefined && x.question!.options[x.question!.recommended] ? { default: truncate(x.question!.options[x.question!.recommended], 200) } : {}),
          required: false,
        })),
        { id: "text", type: "textarea", label: "意见（提意见、换个思路时写）", required: false },
      ]
    : null;
  return createAsk(app, {
    runId: root.id,
    conversationId: chain ? reportConversation(app, chain) : null,
    userId: runUser(app, root.id),
    question,
    ...(fields ? { ui: { fields, submitLabel: "提交" } } : { options: ACTIONS.map((a) => ({ label: a.label })), allowText: true }),
    context: { handler: "design-confirm", designId: d.id, rootId: root.id },
  });
}

/** The assistant that delegated confirms (settle_design), in the conversation the work reports to. */
function wakeAssistant(app: App, root: Run, d: Design, chain: CodeChain) {
  const busy = one(app.db, "select 1 from runs where kind = 'ask' and status in ('queued', 'running') and json_extract(input, '$.handoff.designId') = ?", d.id);
  if (busy) return;
  const conversationId = reportConversation(app, chain, root);
  const messageId = newId("msg");
  run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)",
    messageId, conversationId, "assistant", `编码交办 ${root.id} 的方案写好了（方案 ${d.id}，第 ${d.revision} 版），设置为由你确认，没有要本人定的问题。\n\n${designMarkdown(app, d, { mode: "brief" })}`, root.id, JSON.stringify({ design: d.id, record: true }), now());
  createRun(app, {
    kind: "ask",
    spaceId: getThread(app, conversationId).spaceId,
    title: `编码交办：方案等你确认`,
    input: { conversationId, messageIds: [messageId], handoff: { kind: "design", runId: root.id, workId: root.id, designId: d.id }, denyTools: CODE_HANDOFF_DENY },
    lane: conversationId,
    parentId: chain.askRunId,
  });
}

registerAskHandler("design-confirm", async (app: App, ask: Ask, ctx) => {
  const { designId, rootId } = ctx as { designId: string; rootId: string };
  const d = findDesign(app, designId);
  if (!d || d.status !== "review") return;
  const value = (ask.value ?? {}) as Record<string, unknown>;
  const typed = (ask.answer ?? "").trim();
  // A button, the form's choice, or a typed reply that starts with one (“提意见：……”); other words are a comment.
  const picked = ask.choice !== null ? ask.options[ask.choice]?.label
    : typeof value.action === "string" ? value.action
    : ACTIONS.find((a) => typed.startsWith(a.label))?.label;
  const action = ACTIONS.find((a) => a.label === picked)?.action ?? "comment";
  const text = typeof value.text === "string" ? value.text.trim()
    : picked && typed.startsWith(picked) ? typed.slice(picked.length).replace(/^[：:，,\s]+/, "")
    : ask.ui?.fields?.length ? "" : typed;
  const answers = Object.fromEntries(d.body.decisions.filter((x) => x.question && typeof value[x.id] === "string" && String(value[x.id]).trim()).map((x) => [x.id, String(value[x.id]).trim()]));
  const by = !ask.answeredBy || ask.answeredBy === OWNER ? "owner" : ask.answeredBy;
  try {
    decideDesign(app, d.id, { action, text: text || (action === "comment" ? typed : ""), answers, by });
  } catch (e) {
    // Not taken (a question left open on approval, a comment without words): asked again with why.
    const root = getRun(app, rootId);
    notify(app, { userId: ask.userId, title: `方案没有${picked ?? "处理"}：${truncate(root.title, 40)}`, body: (e as Error).message, link: `#/design/${d.id}` });
    if (getDesign(app, d.id).status === "review") confirm(app, root, getDesign(app, d.id), `上次的回答没有收下：${(e as Error).message}`);
  }
});

/**
 * Confirmed or sent back from anywhere: the card still out closes, and the first round, which ended
 * waiting, is queued again — it codes from the approved design, or rewrites it by what was said.
 */
onDesignDecided((app, design, d) => {
  if (design.origin !== "own" || !design.workId) return;
  const root = one<{ id: string }>(app.db, "select id from runs where id = ? and kind = 'code'", design.workId);
  if (!root) return;
  const r = getRun(app, root.id);
  const wait = r.output.designWait as DesignWait | undefined;
  const label = ACTIONS.find((a) => a.action === d.action)!.label;
  if (wait?.askId) cancelAsk(app, wait.askId, `已${label}（${d.by === "owner" ? "本人" : d.by === "assistant" ? "助手" : d.by}）`);
  // Discarded while it waited: confirmed for the record, nothing to code.
  if (r.status !== "done" || r.output.verdict !== "awaiting-design" || r.output.discardedAt || r.output.appliedAt) return;
  requeueRun(app, r.id, { verdict: null, designWait: null, reviewStage: null });
});

/**
 * The owner said to code without waiting for the design (continue_code_run while it waits): the card
 * closes, the work is no longer tied to the design (it stays as it is, for reference), and the first
 * round goes on to coding; what they said reaches the coder with it.
 */
export function skipDesign(app: App, rootId: string, by: string, text: string): Run {
  const r = getRun(app, rootId);
  if (r.status !== "done" || r.output.verdict !== "awaiting-design" || r.output.discardedAt) throw new HttpError(409, "这次交办不在等方案确认");
  const wait = r.output.designWait as DesignWait | undefined;
  if (wait?.askId && getAsk(app, wait.askId).status === "pending") cancelAsk(app, wait.askId, "本人说不等方案，直接编码");
  if (wait?.designId) setDesignWork(app, wait.designId, null);
  if (text.trim()) {
    const notes = (r.output.notes as { id: string; text: string; at: string; by: string }[] | undefined) ?? [];
    setRunOutput(app, r.id, { notes: [...notes, { id: newId("note"), text: text.trim(), at: now(), by }] });
  }
  requeueRun(app, r.id, { verdict: null, designWait: null, reviewStage: null, designSkipped: { by, at: now(), designId: wait?.designId ?? null } });
  return getRun(app, r.id);
}
