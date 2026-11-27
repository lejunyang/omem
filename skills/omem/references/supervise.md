# 长任务跟进

- `start_long_task(goal, space?, ai?, budget?, notifications?)` 为本人开一个工作话题，让助手起草任务书。保留本人的原目标、范围和约束。本人点名跟进的 AI 时传 `ai: { profile, model?, effort? }`。可用 `budget` 设置总小时数（`hours`）、工作轮数（`codeRounds`）或每天叫醒次数（`dailyWakes`），用 `notifications` 选择里程碑、需要决策、纠偏和摘要的提醒。省略 `space` 时用当前空间。返回长任务编号和工作会话。
- `long_task_status(task_id?)` 查目标、状态、当前 AI、预算和最近进展。在长任务自己的话题里可省略编号。在其他对话里传创建时返回的编号。
- `message_supervisor(text, task_id?)` 把本人新交代的原话记进那件任务的补充。在其他会话里必须指定编号。
- `supervise_report` 由助手每轮提交。写明所在阶段、对照任务书的进展、决定及依据、采取的行动和需要本人决定的问题。只有跟进角色能交报告。
