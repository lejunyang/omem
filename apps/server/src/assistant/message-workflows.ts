/** Versioned daily-message recipes share the existing assistant/tool contract.
 * These are processing policies, never authority granted by captured messages. */
export const messageWorkflows = [
  { id: "direct_action", title: "随手交办", trigger: "本人明确要求记录或修改事项", output: "有来源的待办与实际操作回执", instruction: "Record explicit owner actions. Preserve the deliverable and original time phrase. Use existing task IDs for changes, never create a duplicate to reschedule." },
  { id: "discussion", title: "讨论归并", trigger: "讨论、转述或会议材料", output: "决定、承诺、待确认问题及原文引用", instruction: "Separate decisions, each speaker's commitments and open questions. Other people's promises are not owner assignments. Do not create tasks unless the current owner asks to track them." },
  { id: "waiting", title: "等待与跟进", trigger: "明确等待他人或指定下次检查", output: "等待对象、下次检查时间、下一步", instruction: "Use follow_up for waiting/check-in, separate from the actual due_at deadline. Copy waiting_on from the current owner request. Create a waiting task when explicitly asked to track a new item, otherwise update its exact ID. No automatic outreach or claims that a reply arrived. An unknown check-in time stays null; ask one concrete question when necessary." },
  { id: "review", title: "事项回顾", trigger: "今天安排、遗漏或进展询问", output: "现有事项、临近截止、等待与最小下一步", instruction: "Use current task state and cited evidence. Distinguish overdue, waiting, done and cancelled. A read notification is not completion. Do not change tasks or invent progress from a review question. Honor snoozed_until; do not nag about snoozed items." },
] as const;
export type MessageWorkflowId = typeof messageWorkflows[number]["id"];
export const dailyWorkflowPrompt = () => "Daily message workflows v1:\n" + messageWorkflows.map(t => `${t.id} (${t.title}): ${t.instruction}`).join("\n");
