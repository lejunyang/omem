import type { App } from "../core/app.ts";
import { parseAiSpec, type AiSpec } from "./ai-spec.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { itemAccess } from "../items/access.ts";
import { getRun } from "./runs.ts";
import { changeLongTask, followAiLabel, longTaskInThread, startLongTask, type LongTask } from "./long-tasks.ts";
import type { Thread } from "./threads.ts";
import type { Inbound } from "./inbox.ts";

const usage = "/跟进 [后端或组名 [模型] [强度]] 任务";

function selectionProblem(spec: AiSpec) {
  if (spec.unknown) return spec.unknown;
  if (spec.ambiguous) return "匹配到多个模型，请用完整型号重发命令：" + spec.ambiguous.map(p => p.model).join("、");
}

export function longTaskText(app: App, task: LongTask) {
  const last = task.notes.at(-1)?.runId;
  const report = last ? getRun(app, last).output.progressText : undefined;
  const status = { draft: "等确认任务书", active: "进行中", paused: "已暂停", ended: "已结束", done: "已完成" };
  const url = app.config.webUrl?.trim().replace(/\/+$/, "");
  const where = url ? `[打开工作话题](${url}/#/ask/${task.threadId})` : `工作会话 ${task.threadId}`;
  return [`长任务 ${task.id} · ${status[task.status]} · ${where}`,
    `由 ${followAiLabel(task.ai)} 跟进 · 预算 ${task.budget.hours} 小时 / ${task.budget.codeRounds} 轮`,
    report || task.goal].join("\n");
}

export async function supervisorCommand(app: App, thread: Thread, args: string, inb: Inbound) {
  const userId = inb.userId ?? OWNER;
  if (inb.asker || inb.speaker || thread.userId !== userId) return "请在自己的会话里使用 /跟进。";
  const current = longTaskInThread(app, thread.id);
  const spaceId = current?.spaceId ?? thread.spaceId;
  if (current && current.userId !== userId) return "请在自己的长任务话题里操作。";
  if (!itemAccess(app, userId, { spaceId, userId }, args ? "write" : "read") || (args && !canWrite(app, userId, spaceId)))
    return "没有权限操作这个长任务。";
  if (!args) return current ? longTaskText(app, current) : `用法：${usage}。在任务的话题里发 /跟进 可以看进展。`;
  const control = /^(暂停|继续|结束|加|换)(?:\s|$)/.exec(args);
  if (control) {
    if (!current) return "请在要调整的长任务话题里发这条命令。";
    const value = args.slice(control[1].length).trim();
    let updated: LongTask;
    switch (control[1]) {
      case "加": {
        const hours = /^(\d+(?:\.\d+)?)\s*小时$/.exec(value);
        if (!hours || Number(hours[1]) <= 0) return "用法：/跟进 加 3 小时";
        updated = await changeLongTask(app, current.id, { action: "budget", budget: { hours: current.budget.hours + Number(hours[1]) } });
        break;
      }
      case "换": {
        const spec = parseAiSpec(app, value, { userId });
        const problem = selectionProblem(spec);
        if (problem) return problem;
        if (!spec.ai || spec.rest) return "用法：/跟进 换 后端或组名 [模型] [强度]";
        updated = await changeLongTask(app, current.id, { action: "ai", ai: spec.ai });
        return [...spec.notes, longTaskText(app, updated)].join("\n");
      }
      default: {
        if (value) return "用法：/跟进 暂停、/跟进 继续、/跟进 结束";
        const action = control[1] === "暂停" ? "pause" : control[1] === "继续" ? "resume" : "end";
        updated = await changeLongTask(app, current.id, { action });
      }
    }
    return longTaskText(app, updated);
  }
  if (args === "接管") return "请用 /跟进 加上要推进的目标，另开长任务。";
  if (current) return "在这个话题直接说要补充的内容，或发 /跟进 查看状态。";
  const spec = parseAiSpec(app, args, { userId });
  const problem = selectionProblem(spec);
  if (problem) return problem;
  const { rest: goal, ai } = spec;
  if (!goal) return `请写明任务目标。用法：${usage}`;
  const task = startLongTask(app, { spaceId, userId, threadId: thread.id, goal, ai });
  return [...spec.notes, longTaskText(app, task)].join("\n");
}
