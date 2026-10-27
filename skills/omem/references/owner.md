# 问本人、唤醒与规则（owner）

## 问本人

- `ask_owner(question, options?)` / `wait_answer(ask_id)`：问本人一个非问不可的问题（选哪个方案、授不授权、只有本人知道的事实），本人在飞书卡片、网页首页点选或回复；每次最多等 50 秒，没答可以接着 `wait_answer`，或先做不依赖答案的部分。一次一件事，有选项就给选项，推荐的放第一个。
- `suggest_next`：回答下面附 1–3 个下一步按钮，只在 omem 自己的对话里有效。
- 某些工具调用需要本人批准时，工具会说明在等；批准后宿主会执行并把结果告诉你，不要自己重复调用。

## 唤醒

- `wake_later(after, note, agent?)` / `wake_on_message(chat_id, note, contains?, from?, mentions_owner?)` / `cancel_wake(id?)`：过一段时间、或某个飞书群出现符合条件的消息时唤醒。omem 里的会话由它的 Agent 接着做；在外部 Agent 里调用要用 `agent` 指定唤醒哪个档案。
- 最远 7 天，每处最多 5 个待触发。规则触发的档案不传 agent 时唤醒自己，延续原空间、话题和回复权限（含草稿 / 静默），没有新变化回 QUIET；交给其他档案不会继承原运行的渠道权限。
- note 写足复查对象、口径和工作文件，醒来时未必记得细节。提醒本人做事用事项的 remind_at，不用唤醒。

## 规则

- `list_rules` / `save_rule(description, rule?, enabled?)`：本人的规则（遇到什么情况自动叫哪个 Agent 做什么，见 docs/v2/rules.md）。只在本人明确要求时建；不给 `rule` 时由模型从原话生成条件和动作；默认不启用，请本人到规则页核对。
- `rule` 可含 `spaceId`、`trigger`、`conditions`、`judge`、`actions`。`agent` 动作的 `spec` 默认 `assistant`，可选 `space` 指定执行空间；省略时按档案、规则、触发空间解析。没有专用档案的日常任务用主助手，不挑最接近的档案代替。
- 定时任务 `reply=auto` 发回结果会话，`none` 通知本人，`draft` 的群消息先给本人确认。
