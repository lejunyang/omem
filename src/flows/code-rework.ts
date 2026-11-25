import type { App } from "../core/app.ts";
import { getRun } from "../agents/runs.ts";
import { listTasks, taskLabel, type CodeTask } from "../agents/code-tasks.ts";
import type { CodeNote } from "../agents/code-steer.ts";
import type { CodeWorkDetail } from "../agents/code-works.ts";
import type { Item } from "../items/store.ts";

const hasResult = (task: CodeTask) => task.state === "done" || task.state === "wontdo" && !task.origin.later &&
  (!!task.answer?.trim() && task.answer.trim() !== "不做" || task.notes.some(note => ["owner", "assistant", "verify"].includes(note.kind) && !/^(本人决定)?不做[。！]?$/.test(note.text.trim()) && !!note.text.trim()));

export function codeRework(app: App, item: Item, work: CodeWorkDetail, since: string) {
  const last = work.roundList.at(-1);
  if (!last) return null;
  if (work.branchReview) return last.createdAt > since ? { round: undefined, blocked: undefined, verified: false } : null;
  const belongs = (itemId?: string) => (itemId ?? work.item?.id) === item.id;
  const tasks = listTasks(app, work.rootId).filter(task => task.createdAt > since && (task.kind === "owner" || !!task.origin.item) && belongs(task.origin.item));
  const previous = last.createdAt <= since;
  const busy = last.status === "queued" || last.status === "running";
  const whileOpen = (at: string) => busy || !!last.finishedAt && at <= last.finishedAt;
  const notes = ((getRun(app, last.id).output.notes ?? []) as CodeNote[]).filter(note => note.at > since && belongs(note.item) && whileOpen(note.at) && (note.acceptedInRound || note.deliveredAt));
  if (previous && (!whileOpen(since) || last.finishedAt === since || !notes.length && !tasks.some(task => whileOpen(task.createdAt) && (!task.coderRun || task.coderRun === last.id)))) return null;
  const missing = tasks.filter(task => !hasResult(task));
  const undelivered = notes.filter(note => !note.deliveredAt);
  const parts = [missing.length ? `修改项 ${missing.map(task => `${taskLabel(task.seq)}「${task.title}」`).join("、")}还没有通过验证或给出不做的说明` : "",
    undelivered.length ? `补充要求尚未交到编码 Agent：${undelivered.map(note => note.text.slice(0, 80)).join("、")}` : "",
    last.status !== "done" || last.verdict !== "approved" ? "这一轮的评审没有通过" : ""].filter(Boolean);
  return { round: previous ? last.round : undefined, verified: previous && !busy && !parts.length, blocked: !busy && parts.length ? `第 ${last.round} 轮已结束：${parts.join("；")}` : undefined };
}
