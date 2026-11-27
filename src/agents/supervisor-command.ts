import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { parseModelArgs } from "./commands.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { itemAccess } from "../items/access.ts";
import { resolveModelOption } from "./models.ts";
import { userProbe } from "./probe.ts";
import { getRun } from "./runs.ts";
import { changeLongTask, longTaskInThread, startLongTask, type LongTask } from "./long-tasks.ts";
import type { Thread } from "./threads.ts";
import type { Inbound } from "./inbox.ts";

const usage = "/监工 [后端 [模型] [强度]] 任务";
type ParsedSupervisorAi = {
  ai?: LongTask["ai"]; group?: string; rest: string; notes: string[];
  ambiguous?: { profile: string; model: string }[]; unknown?: string;
};

// Only the first line can name the backend and model; subsequent lines belong to the goal.
export function supervisorArgs(app: App, args: string, userId: string): ParsedSupervisorAi {
  const first = /^(\S+)([\s\S]*)$/.exec(args);
  const profile = first && allProfiles(app.config).find(p => p.id === first[1]);
  if (!first || !profile) return { rest: args, notes: [] };
  let rest = first[2];
  const token = /^[^\S\r\n]+([\w.@:/-]+)(?=\s|$)/.exec(rest);
  const effortOnly = /^(low|medium|high|xhigh|max)$/i;
  let model: string | undefined;
  if (token && !effortOnly.test(token[1]) && !/^effort$/i.test(token[1])) {
    const offered = userProbe(app, userId, profile.id)?.models ?? [];
    const resolved = resolveModelOption(token[1], offered);
    if (!offered.length || resolved.matched) {
      model = resolved.value;
      rest = rest.slice(token[0].length);
    }
  }
  const level = /^[^\S\r\n]+(?:effort[ \t]*[:=][ \t]*([\w.-]+)|(low|medium|high|xhigh|max))(?=\s|$)/i.exec(rest);
  const selected = parseModelArgs([model, level && `effort=${level[1] ?? level[2]}`].filter(Boolean).join(" "));
  return { ai: { profile: profile.id, ...selected }, rest: rest.slice(level?.[0].length ?? 0).trimStart(), notes: [] };
}

export function longTaskText(app: App, task: LongTask) {
  const last = task.notes.at(-1)?.runId;
  const report = last ? getRun(app, last).output.progressText : undefined;
  const status = { draft: "等确认任务书", active: "进行中", paused: "已暂停", ended: "已结束", done: "已完成" };
  const url = app.config.webUrl?.trim().replace(/\/+$/, "");
  const where = url ? `[打开工作话题](${url}/#/ask/${task.threadId})` : `工作会话 ${task.threadId}`;
  return [`长任务 ${task.id} · ${status[task.status]} · ${where}`,
    `监工 ${[task.ai.profile, task.ai.model, task.ai.effort].filter(Boolean).join(" · ")} · 预算 ${task.budget.hours} 小时 / ${task.budget.codeRounds} 轮`,
    report || task.goal].join("\n");
}

export async function supervisorCommand(app: App, thread: Thread, args: string, inb: Inbound) {
  const userId = inb.userId ?? OWNER;
  if (inb.asker || inb.speaker || thread.userId !== userId) return "请在自己的会话里使用 /监工。";
  const current = longTaskInThread(app, thread.id);
  const spaceId = current?.spaceId ?? thread.spaceId;
  if (current && current.userId !== userId) return "请在自己的长任务话题里操作。";
  if (!itemAccess(app, userId, { spaceId, userId }, args ? "write" : "read") || (args && !canWrite(app, userId, spaceId)))
    return "没有权限操作这个长任务。";
  if (!args) return current ? longTaskText(app, current) : `用法：${usage}。在任务的话题里发 /监工 可以看进展。`;
  const control = /^(暂停|继续|结束|加|换)(?:\s|$)/.exec(args);
  if (control) {
    if (!current) return "请在要调整的长任务话题里发这条命令。";
    const value = args.slice(control[1].length).trim();
    let updated: LongTask;
    switch (control[1]) {
      case "加": {
        const hours = /^(\d+(?:\.\d+)?)\s*小时$/.exec(value);
        if (!hours || Number(hours[1]) <= 0) return "用法：/监工 加 3 小时";
        updated = await changeLongTask(app, current.id, { action: "budget", budget: { hours: current.budget.hours + Number(hours[1]) } });
        break;
      }
      case "换": {
        const { ai, rest } = supervisorArgs(app, value, userId);
        if (!ai || rest) return "用法：/监工 换 后端 [模型] [强度]";
        updated = await changeLongTask(app, current.id, { action: "ai", ai });
        break;
      }
      default: {
        if (value) return "用法：/监工 暂停、/监工 继续、/监工 结束";
        const action = control[1] === "暂停" ? "pause" : control[1] === "继续" ? "resume" : "end";
        updated = await changeLongTask(app, current.id, { action });
      }
    }
    return longTaskText(app, updated);
  }
  if (args === "接管") return "请用 /监工 加上要推进的目标，另开长任务。";
  if (current) return "在这个话题直接说要补充的内容，或发 /监工 查看状态。";
  const { rest: goal, ai } = supervisorArgs(app, args, userId);
  if (!goal) return `请写明任务目标。用法：${usage}`;
  const task = startLongTask(app, { spaceId, userId, threadId: thread.id, goal, ai });
  return longTaskText(app, task);
}
