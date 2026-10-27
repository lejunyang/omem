# Agent、技能与运行（agents）

## 档案与交办

- `list_agents`：本人建好的 Agent 档案，同时列出可以教的内置角色。
- `run_agent(name, task, own_topic?)`：交给专门的 Agent。多步或长任务用 `own_topic=true`：工作在独立会话（飞书话题）里进行；每轮 Agent 交回报告后，omem 的主助手在工作会话里接手，决定继续交办、汇报或请本人决定（本人上次说话后最多自动推进若干次，可在设置里调），回复和折叠的完整报告只在话题里发一次。
- 已经在这个话题里时再调用 `run_agent(own_topic=true)` 或 `continue_agent_work` 都续在同一项工作上，同一个 Agent 接着它上一轮的会话。
- 没有专门档案的一次性任务可 `run_agent(name="assistant", …)`，继承调用者的工具、空间和发送范围，不能再交办；不用为临时换模型新建或修改档案。
- `ask_agent(name, question)`：向另一个档案请教并同步拿到回答（被请教的不能再请教或交办）。
- `save_agent`：建或改档案，只在本人要求时做；档案正文只写稳定的职责和原则。

## 选 AI

- `list_ai_backends()` 返回可用后端、默认模型、缓存的模型 / 强度、各模型现在的占用与上限（`limit` 为 0 是本人不想自动用的，不要选）、近 7 天的完成和失败，以及本人的任务选型偏好；同一账号的命令行后端不单独列出；传 `profile` 可检测该后端，`refresh: true` 强制刷新。准备临时换 AI 时先核对，未知选项不要猜；同样合适时选空闲的。豆包（`tools: false`）用不了 omem 工具，交给它时把材料原文写进任务。
- `run_agent`、`continue_agent_work`、`ask_agent` 可传 `execution: {profile, model?, effort?, source: "user" | "auto", reason}`；`profile` 是后端 id，`name` / `agent` 仍是档案名。本人明确指定填 `user`，助手根据任务选择填 `auto`；关闭自主选型时后者被拒绝。普通 Agent 工作的后续轮次需继续显式传入本人的指定。选择只作用于任务并留运行记录；更换后端或模型时使用新会话并携带工作经过。
- `switch_run_ai(run_id, execution, with_children?)`：给已经安排的运行换 AI（后端一直排队或失败、本人要求中途换模型）。排队中的直接改，进行中的停下后重新排队，失败的用新 AI 重试，默认连同子运行（如 Wiki 各页写作）；编码交办改用 `continue_code_run` 的 `execution`。

## 技能与改进

- `list_skills` / `read_skill`：本人沉淀的做法。`read_skill(name, file="references/checks.md")` 可读技能内的多层附属文本文件；返回的文件列表使用相对路径。不接受越界或符号链接，文本限 2 MB。
- `save_skill`：把可复用做法存成技能；`agent="档案名"` 保存后直接挂到该档案或内置角色（主助手教档案时用；内置角色会先复制成本人的自定义版本），档案内运行不填默认挂当前档案，`attach: false` 只建技能不挂；名字不存在会报错。
- `propose_profile_change(target, kind, title, reason, …)`：给档案或内置角色提改进建议（`prompt` 新正文、`skill` 新技能全文、`settings` 加减工具和技能），本人在 Agent 页采纳后才生效；偏好和经验直接 `remember(agent=…)`。

## 运行记录

- `list_runs` / `read_run`：查运行的状态、输入输出和子运行。`read_run` 单列思考气泡的 `thinkingDelivery` 错误，它是投递状态，任务成败看运行 status。
