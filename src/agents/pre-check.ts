import { z } from "zod";
import type { App } from "../core/app.ts";
import { truncate } from "../core/util.ts";
import { getRun, setRunOutput, type Run } from "./runs.ts";

/**
 * The check before coding (docs/v2/pre-check.md). Before the first round of a new delegation codes,
 * `business-analyst` looks at what the change will touch — callers, shared interfaces and types,
 * other pages on the same component or endpoint, related requirement points — and at what went wrong
 * there before (memories, case pages, past findings, the files' history: code_history), and hands
 * in a brief with `submit_brief`. The coder gets it before it splits the work, so what has to be
 * kept working goes into the tasks' “done when”; the stage review gets it to check against, and
 * review-history then checks that the old problems were not repeated instead of searching anew.
 *
 * The host only runs it and passes the brief on; what matters, and how much, is the analyst's call.
 */

const where = z.array(z.string().max(300)).max(20).optional().describe("文件:行、符号、页面或接口");
const refs = z.array(z.string().max(200)).max(10).optional().describe("依据：mem:、src:、run:、req: 或提交号");
export const briefSchema = z.object({
  summary: z.string().min(1).max(2000).describe("一段话：这次要改哪里、会碰到什么、风险在哪"),
  areas: z.array(z.object({ files: z.array(z.string().max(300)).max(20), note: z.string().max(500) })).max(20).optional().describe("预计要改的位置"),
  impacts: z.array(z.object({ text: z.string().min(1).max(600), where, reqs: z.array(z.string().max(80)).max(10).optional(), refs })).max(30).optional()
    .describe("改动会波及、编码时要顾及的现有功能、调用方、共用的接口和类型"),
  history: z.array(z.object({ text: z.string().min(1).max(600), where, refs: z.array(z.string().max(200)).min(1).max(10) })).max(20).optional()
    .describe("这些地方以前出过的问题、修过的坑（必须带依据）"),
  regressions: z.array(z.object({ text: z.string().min(1).max(400), how: z.string().max(400).optional(), reqs: z.array(z.string().max(80)).max(10).optional(), auto: z.boolean() })).max(40).optional()
    .describe("改完要回归的：auto=true 是有现成的自动化测试（how 写命令或用例），false 是要人看的（how 写步骤）"),
  questions: z.array(z.string().max(400)).max(10).optional().describe("查不清、需要本人或助手确认的"),
});
export type Brief = z.infer<typeof briefSchema>;
export type PreCheck = Brief & { at: string; by: { profile: string; model?: string; effort?: string } | null };

/** The brief of a delegation (kept on its first run), or null. */
export function preCheckOf(app: App, rootId: string): PreCheck | null {
  const v = getRun(app, rootId).output.preCheck as PreCheck | undefined;
  return v && typeof v.summary === "string" ? v : null;
}

/** What submit_brief stores: on the delegation's first run, before the coder starts. */
export function savePreCheck(app: App, rootId: string, brief: Brief) {
  setRunOutput(app, rootId, { preCheck: { ...brief, at: new Date().toISOString(), by: null } satisfies PreCheck });
}

const list = (items: string[]) => items.map((x) => `- ${x}`).join("\n");
const tail = (x: { where?: string[]; reqs?: string[]; refs?: string[] }) =>
  [x.where?.length ? `位置：${x.where.join("、")}` : "", x.reqs?.length ? `需求点：${x.reqs.map((r) => `req:${r}`).join("、")}` : "", x.refs?.length ? `依据：${x.refs.join("、")}` : ""].filter(Boolean).join("；");

/**
 * The brief as a section of a task. `coder`: what to build into the tasks; `review`: what to check
 * against (was it kept working, were the old problems avoided, were the regressions run).
 */
export function preCheckText(pc: PreCheck, mode: "coder" | "review"): string {
  const parts = [
    mode === "coder"
      ? "## 编码前的检查\n\n开始编码前，另一个 Agent 查了这次改动会碰到什么、这里以前出过什么问题。拆修改项时用上：要顾及的写进相关项的完成标准（需要单独改的另列一项），以前的问题别再犯，回归清单里有自动化测试的，在对应的项做完后跑一遍、写进 finish_task 的说明。觉得哪条不对，在说明里写理由，不用照做。"
      : "## 编码前的检查\n\n编码前查出的影响面、以前的问题和回归清单（编码 Agent 拆修改项时拿到过）。核对改动有没有顾及这些、有没有重犯以前的问题、回归有没有做；这次实际改的超出这里的，再按你的角度看。",
    `### 概要\n\n${pc.summary}`,
    pc.areas?.length ? `### 预计改动的位置\n\n${list(pc.areas.map((a) => `${a.files.join("、")}${a.note ? `：${a.note}` : ""}`))}` : "",
    pc.impacts?.length ? `### 要顾及的\n\n${list(pc.impacts.map((x) => `${x.text}${tail(x) ? `（${tail(x)}）` : ""}`))}` : "",
    pc.history?.length ? `### 以前出过的问题\n\n${list(pc.history.map((x) => `${x.text}（${tail(x)}）`))}` : "",
    pc.regressions?.length ? `### 回归清单\n\n${list(pc.regressions.map((x) => `${x.auto ? "[自动]" : "[人工]"} ${x.text}${x.how ? `：${x.how}` : ""}${x.reqs?.length ? `（需求点：${x.reqs.map((r) => `req:${r}`).join("、")}）` : ""}`))}` : "",
    pc.questions?.length ? `### 没查清的\n\n${list(pc.questions)}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** One line for status events and notifications. */
export const preCheckLine = (pc: Brief) =>
  [`要顾及 ${pc.impacts?.length ?? 0} 处`, `以前的问题 ${pc.history?.length ?? 0} 条`, `回归 ${pc.regressions?.length ?? 0} 项`, pc.questions?.length ? `没查清 ${pc.questions.length} 条` : ""].filter(Boolean).join("，");

/** Whether a new delegation gets the check: on unless the owner turned it off, or the delegation said no. */
export function wantsPreCheck(app: App, root: Run) {
  return app.config.agents.autoAdvance.preCheck !== false && (root.input as { preCheck?: boolean }).preCheck !== false;
}

/**
 * Runs the check for a delegation's first round (in its workspace, read-only) and keeps the brief
 * on the run. Not done, it says why and coding goes on without it.
 */
export async function runPreCheck(app: App, o: { run: Run; task: string; spaces: string[]; cwd: string; repos: { id: string; name: string; dir: string }[]; signal: AbortSignal; event: (type: string, data: unknown) => void }): Promise<PreCheck | null> {
  const { runRole } = await import("./runner.ts");
  o.event("status", { phase: "pre-check", text: "编码前检查：查这次改动会碰到什么、这里以前出过什么问题" });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 20 * 60_000);
  const abort = () => stop.abort();
  o.signal.addEventListener("abort", abort, { once: true });
  try {
    const res = await runRole(app, {
      role: "business-analyst",
      spaceId: o.run.spaceId!,
      spaces: o.spaces,
      task: [
        "# 编码前检查",
        "下面这次交办马上开始编码。你先查清改动会碰到什么、这里以前出过什么问题，用 submit_brief 交一份检查结果：编码 Agent 拆修改项时照着补上要顾及的点，评审时也拿它核对。",
        `## 交办的任务\n\n${o.task}`,
        `## 仓库\n\n${o.repos.map((r) => `- ${r.id}（${r.name}）：工作区 ${r.dir}（只读）`).join("\n")}\n\n查文件的历史用 code_history（space 写仓库 id）。`,
      ].join("\n\n"),
      runId: o.run.id,
      cwd: o.cwd,
      signal: stop.signal,
      onEvent: (e) => o.event(e.type, { ...e, phase: "pre-check" }),
    });
    const pc = preCheckOf(app, o.run.id);
    if (!pc) {
      o.event("status", { phase: "pre-check", text: `编码前检查没有交结果，直接开始编码：${truncate(String(res.text ?? ""), 300)}` });
      return null;
    }
    const done = { ...pc, by: res.ai };
    setRunOutput(app, o.run.id, { preCheck: done });
    o.event("status", { phase: "pre-check", text: `编码前检查：${preCheckLine(done)}` });
    return done;
  } catch (e) {
    if (o.signal.aborted) throw e;
    o.event("status", { phase: "pre-check", text: `编码前检查没能完成（${truncate((e as Error).message, 200)}），直接开始编码` });
    return null;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener("abort", abort);
  }
}
