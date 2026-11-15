# 流程：一件事的阶段和关卡

## 课题（study 分组）

这组工具由流程阶段的 `tools` 或试验运行临时带上；阶段 `tools` 只能填本组的名字。coach 的精确工具清单另含只读的 `read_ledger`，复盘课题技能时可在本次空间范围内读台账，不替本人判定发现；其他内置角色不因此获得 study 分组。

| 工具 | 参数与用法 |
| --- | --- |
| `propose_directions` | `item, directions, note?`。方向零到三个，每个有 `goal / approach / acceptance / env? / estimate? / trials: [{ object, check }]`（1–40 个）。空数组是正常结果，note 写原因。只能由定方向阶段交；宿主按规范化的对象和检查项去掉已有结果的完全重复试验，保留同对象的新检查并标以前的结论；然后问本人选一个或这一轮不跑。本人附的话带入试验任务。 |
| `trial_report` | `trial, result, summary, evidence?, findings?, unsure?`。result 是 passed / failed / blocked / unclear；证据是 `$OMEM_ARTIFACTS` 内的文件路径或可读 `src:` 引用。只能由这个试验自己的运行交。候选 findings 为 `{ kind, title, repro }`，不会自动变成正式发现。 |
| `read_ledger` | `item, direction?, object?, result?, round?, limit?`，读试验摘要、证据和候选，以及已有发现。凡阶段 tools 包含 propose_directions，即使误授了此工具也拒绝读取。 |
| `record_finding` | `item, kind, title, repro, trials, same_as?, distinct_from?`，kind 是 defect / gap / idea。依据至少一条，须是本课题有结果的试验。相近标题会提示先读，same_as 合并依据到已有发现，distinct_from 是已核对且不同的发现 id 数组。拒绝的发现只影响这一条。 |
| `close_direction` | `direction, state: done / dropped, conclusion`，结论必填，未做的试验跳过。 |

`by: { object: trials, agent?: assistant, skill?: study-trial }` 按顺序一次跑一个试验，支持 AI、时间段和预算。没交结果可升档重做这个试验一次，后端失败同一试验重试一次；额度用完等原模型，不换后端。试验数或分钟用完时本轮这一段完成，剩下的留给下一轮；有未做完的方向时下一轮跳过定方向。功能清单用已有 write_file 写在事项空间的 `work/studies/<事项 id>/capabilities.md`，不写 Wiki。

内置 study 流程默认 manual，由本人决定何时再来一轮。flow.idleRounds 是连续完成且没有新发现的轮数；非 manual 到 flows.idleRounds（默认 3）时暂停自动开轮并给本人一条不急的通知。

流程是一份阶段清单，挂在事项上。每段由运行、编码交办、方案或本人承担，也可以只等。前提都已完成或跳过才开始；条件拿不准、关卡要求本人确认或连续自动开始达到上限时，宿主问本人。确认只认事项本人的回答，等待多久都不会自动通过。

| 工具 | 参数与用法 |
| --- | --- |
| `list_flows` | 不填列定义（id、名称、说明、阶段名）；填 `item` 返回这个事项适用的流程 id。 |
| `save_flow` | `yaml` 是整份 YAML。先给本人看阶段、承担者、关卡与完成要求；本人选“启用”才保存。只用于主人的共享定义。 |
| `flow_start` | `item`、`flow`；一个事项同时只能有一个进行中的流程。开始时复制定义，之后改模板不影响它。 |
| `flow_round` | `item`；本人说“再来一轮”时开始下一轮。定义须有 `repeat`，上一轮所有阶段完成或跳过后才可调用。只重做 `repeat.from` 及之后的阶段，之前的保留。 |
| `stage_report` | `item`、`stage`、`state: done / blocked / skip`、`note`；可带 `evidence`、`waiting_on`、`unsure`。做完须有依据，卡住写等谁或等什么，跳过写理由。结果说不清、要不要继续定不下来时用 `blocked` 加 `unsure: true`；宿主按阶段的升档上限带反馈重做，用完仍卡住。缺权限、缺材料等确定的阻碍不标拿不准。 |
| `report_tests`、`attach_artifact` | 只在承担一个阶段的运行里有。验证或验收的阶段用它们逐条交结果：`report_tests` 的每条写需求点（`req`）、`status`、`mode`（在哪测、怎么测）、`note`（做了什么、看到什么）和这一条的截图、录屏（先放进 `$OMEM_ARTIFACTS`）。事项页按条显示，本人照着看完再确认这一段。 |
| `stage_reopen` | `item`、`stage`、`reason`，可带 `refs`。该段重新开始，下游已完成的变成待复核，已跳过的保持跳过。 |
| `note_item_change` | 只给 `item-follow` 角色交结果，不随分组授出。`item` 只能是本次运行跟进的事项；`type` 为 scope / decision / deadline / blocker / info；`summary` 一句话，可带 `detail`、需求点 `req`、本流程阶段 id 数组 `stages`。`refs` 至少一条本批次原件的行引用，deadline 必填 ISO 时间或日期 `due`。不直接改需求点；影响进行中或已完成阶段时等事项本人选并进、另开或不用管。 |

`read_item(item_id)` 的 `flow` 返回流程摘要、阶段状态、进入时间、承担者、等待对象、依据和最近 50 条日志，还带当前轮、重复方式、下一轮时间、是否可手动开始、各段等待的时刻、指定和实际 AI、预算及已用分钟、升档次数、最近 10 轮结果快照。`changes` 是最近十条变化、状态与引用，`follow` 是当前订阅原件、已处理位置及待处理数量。工具只能修改本次运行可读且可写空间里、属于调用者的事项。

依据可以是 `src:<原件id>#L起-L止`、运行 id（也接受 `run:<id>`）、`code-work:<交办首轮id>` 或 `design:<方案id>`。必须是调用者可读的材料。`done: confirm` 时交结果会另问本人，不能代答。本人说还不行会把理由交给同一承担者重做，第三次仍未通过就卡住；运行结束却没交结果时，只有配了 `escalate` 且本轮次数没用完才换档重做，否则卡住。

定义可写 `repeat: { from: plan, every: manual }`（默认手动；也支持 `done / day / [tue, fri]`）。运行阶段的 `ai` 支持 `strong / standard / cheap` 或 `{ profile, model?, effort? }`，档位在配置 `agents.tiers` 中映射。没配档位沿用角色或档案自己的 AI；配错卡住，额度用完等恢复，不自动换更贵的。阶段还可写 `at: "10:00"`、`window: "23:00-05:00"`，按配置时区限制开始，已运行的不因窗口结束停止。

`budget: { minutes: 240, trials: 8 }` 用于运行和 trials 阶段，分钟本轮累计，升档也计时，排队和等本人确认不计。普通运行阶段用满分钟时卡住等本人，trials 用满试验数或分钟时完成本轮阶段并保留队列；普通运行的 trials 字段只保存。`escalate: { to: strong, max: 2 }` 用于写了 `ai` 的这两类阶段。本人可经 `POST /api/items/:id/flow/stages/:stage/budget` 改副本的 `budget`、`escalate.max`，不改模板；同轮重开不重置已用值，新轮重新计数。

定义格式见 `docs/v2/flows.md`。支持 `by: {run: {agent?, skill?}}`、`by: {object: code-work / design}`、`by: {object: trials, agent?, skill?}`、`by: owner`、`by: wait`；`needs` 只指向更早的阶段，不填等上一个、`[]` 无前提。`when` 与文字完成要求最多 300 字，`note` 最多 1000 字。`done` 可用 `confirm`、一句话或已有对象状态；owner / wait 还可写 `{ signal: git.pushed }` 或 `{ signal: git.merged }`，关联交办已应用的提交全部进入远端 / 目标分支远端后由宿主完成，本人也可手动完成。person、其他信号、插件对象留待后续阶段。定义在 `library/_flows/<id>.yaml`，内置模板只补缺。

阶段运行复用事项材料和会话摘要，使用 `note` 说明这段做什么；`agent` 可以是内置角色或 Agent 档案，不填用主助手，`skill` 只给这一轮。流程监听已有对象和运行事件，更新同一张进度通知；流程走完不关闭事项。网页流程条和飞书进度卡的专门版式尚未实现。
