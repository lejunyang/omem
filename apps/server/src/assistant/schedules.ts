import { z } from "zod";
import type {
  WorkAction,
  WorkReceipt,
} from "../../../../packages/contracts/src/work.js";
import type { ResearchTool } from "../knowledge/agent-research.js";
import type { PersonalLarkService } from "../integrations/lark-personal/service.js";
import type { ScheduleService } from "../schedules/service.js";

export type AssistantSchedulePorts = {
  personalLark: PersonalLarkService;
  schedules: ScheduleService;
};
type ScheduleOperation =
  | "subscribe_chat"
  | "configure_messages"
  | "configure_auto_watch"
  | "save_schedule"
  | "pause_schedule"
  | "resume_schedule"
  | "delete_schedule"
  | "run_schedule";
export function isScheduleAction(
  action: WorkAction,
): action is Extract<WorkAction, { operation: ScheduleOperation }> {
  return [
    "subscribe_chat",
    "configure_messages",
    "configure_auto_watch",
    "save_schedule",
    "pause_schedule",
    "resume_schedule",
    "delete_schedule",
    "run_schedule",
  ].includes(action.operation);
}
export function scheduleSummaries(schedules: ScheduleService) {
  return schedules
    .list()
    .map(
      ({
        id,
        kind,
        name,
        instruction,
        contextIds,
        enabled,
        timing,
        version,
        nextRunAt,
        lastRun,
      }) => ({
        id,
        kind,
        name,
        instruction,
        contextIds,
        enabled,
        timing,
        version,
        nextRunAt,
        lastRun: lastRun
          ? {
              state: lastRun.state,
              summary: lastRun.summary,
              error: lastRun.error,
              notificationState: lastRun.notificationState,
              finishedAt: lastRun.finishedAt,
            }
          : null,
      }),
    );
}
export class AssistantScheduleActions {
  constructor(readonly ports: AssistantSchedulePorts) {}
  tools(): ResearchTool[] {
    const { personalLark, schedules } = this.ports;
    return [
      {
        name: "messages_status",
        readOnly: true,
        description:
          "Read personal read-only collection settings, subscription reasons, failures and automatic discovery policy. Collection and discovery are separate switches. No Feishu messages are sent or marked read.",
        shape: {},
        run: () => personalLark.status(),
      },
      {
        name: "message_chats",
        readOnly: true,
        description:
          "Find actual known Feishu conversation IDs by name. refresh=true reads the recently visited conversation list using personal login, without subscribing or reading message bodies. Resolve duplicate names before proposing a subscription; use only returned IDs.",
        shape: {
          query: z.string().max(200).default(""),
          limit: z.number().int().min(1).max(100).default(30),
          refresh: z.boolean().default(false),
        },
        run: async ({ query, limit, refresh }) => {
          if (refresh) await personalLark.discover();
          return personalLark.searchChats(query, limit);
        },
      },
      {
        name: "schedule_list",
        readOnly: true,
        description:
          "List existing recurring briefs and automatic conversation discovery with actual settings, versions, next run, history and failures. Update the existing task rather than creating a duplicate.",
        shape: {},
        run: () => scheduleSummaries(schedules),
      },
      {
        name: "schedule_get",
        readOnly: true,
        description:
          "Read one returned recurring task and its latest actual result. Use returned version for a change. A queued or running task has not completed or delivered its result.",
        shape: { id: z.string() },
        run: ({ id }) => schedules.get(id),
      },
    ];
  }
  apply(action: WorkAction): WorkReceipt | null {
    const { personalLark, schedules } = this.ports;
    const receipt = (message: string, taskId?: string): WorkReceipt => ({
      tool: "work_action",
      operation: action.operation,
      message,
      ...(taskId ? { taskId } : {}),
    });
    if (action.operation === "subscribe_chat") {
      const chat = personalLark.searchChats(action.chatId, 1)[0];
      if (!chat) throw Error("会话尚未发现，请先查询最近会话并确认对象");
      personalLark.subscribe(action.chatId, action.mode);
      return receipt(
        `已${action.mode === "watch" ? "关注" : action.mode === "excluded" ? "排除" : "停止完整采集"}「${chat.name}」。${action.mode === "off" ? "提及例外仍按原设置处理。" : ""}${!personalLark.settings().enabled ? "飞书消息采集仍暂停，可要求开启。" : ""}`,
      );
    }
    if (action.operation === "configure_messages") {
      const settings = personalLark.configure(action.settings);
      return receipt(
        `飞书只读采集已${settings.enabled ? `开启，每${settings.intervalMinutes}分钟检查一次` : "暂停"}；已保存其余设置。`,
      );
    }
    if (action.operation === "configure_auto_watch") {
      if (action.collectionEnabled !== undefined)
        personalLark.configure({ enabled: action.collectionEnabled });
      const settings = personalLark.configureAutoWatch(action.settings);
      return receipt(
        `自动发现与关注已${settings.enabled ? `开启，每${settings.intervalMinutes}分钟筛选最近活跃群` : "暂停"}。${!personalLark.settings().enabled ? "消息采集仍暂停，需开启后才能发现和读取。" : settings.enabled ? "按已保存关注方向筛选，免打扰默认排除；个人登录只读。" : "已关注会话继续按消息采集设置读取。"}`,
      );
    }
    if (action.operation === "save_schedule") {
      if (action.id && !action.task.expectedVersion)
        throw Error("修改定时任务需要读取并提供当前版本");
      const task = schedules.save(action.task, action.id);
      return receipt(
        `已保存「${task.name}」，${task.enabled ? `下次运行：${task.nextRunAt}` : "当前暂停"}。简报通过已绑定机器人通知；未绑定时保留站内结果。`,
        task.id,
      );
    }
    if (
      [
        "pause_schedule",
        "resume_schedule",
        "delete_schedule",
        "run_schedule",
      ].includes(action.operation) &&
      "id" in action &&
      "expectedVersion" in action
    ) {
      const task = schedules.get(action.id!);
      if (!task) throw Error("定时任务不存在或已删除");
      if (task.version !== action.expectedVersion)
        throw Error("定时任务已变化，请重新读取设置");
      if (action.operation === "delete_schedule") {
        schedules.delete(task.id, action.expectedVersion);
        return receipt(`已删除「${task.name}」。`, task.id);
      }
      if (action.operation === "pause_schedule") {
        schedules.pause(task.id, action.expectedVersion);
        return receipt(`已暂停「${task.name}」，已有结果保留。`, task.id);
      }
      if (action.operation === "resume_schedule") {
        const { kind, name, instruction, contextIds, timing } = task;
        const saved = schedules.save(
          {
            kind,
            name,
            instruction,
            contextIds,
            timing,
            expectedVersion: task.version,
            enabled: true,
          },
          task.id,
        );
        return receipt(
          `已恢复「${task.name}」，下次运行：${saved.nextRunAt}。`,
          task.id,
        );
      }
      schedules.runOnce(task.id);
      return receipt(
        `已安排立即运行「${task.name}」，结果可在定时任务中查询。`,
        task.id,
      );
    }
    return null;
  }
}
