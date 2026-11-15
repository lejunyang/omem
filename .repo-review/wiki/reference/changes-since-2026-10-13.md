---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-15
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。


## 流程的轮次、档位和等推送：界面（11-15）

- 事项页的流程面板（`web/src/components/ItemFlow.vue`）：重复的流程在名字旁写“第 N 轮”；一轮做完时出一块“第 N 轮做完了”，带“再来一轮”；所选阶段多三行——模型（定义里写的档位，和这次实际用的 AI）、时间（开始时刻、时间段、现在等到几点）、预算（已用 / 上限分钟、请更好的模型看过几次，本人可以点“改”，只改这件事上的这一份）；“以前各轮”列出每一轮各阶段怎么结束的；等推送的阶段写明在等什么、上次看的结果。
- 流程定义页（`web/src/views/Flows.vue`）：“它会怎么走”里每段多一行模型、时间、预算，整份流程多一句轮次；“每一段可以写什么”补了 `ai`、`at` / `window`、`budget`、`repeat` 和 `done: { signal: … }`。
- 设置 → AI →“模型档位”：好的 / 中档 / 省的各配后端、模型、强度（`agents.tiers`）。
- 服务端跟着改的两处：只是“等到某时再开始”的宿主备注不显示在“最近”里；一轮结束时最后一段保留它自己的结论（原来被“第 N 轮已完成”盖掉）。没写模型的阶段不再出“用默认的模型”这一行。

## 课题第一期：流程轮次、AI 档位、时间段和预算（11-15）

- `src/flows/definitions.ts` 增加 `repeat / ai / at / window / budget / escalate` 与中文校验；`describeStage` 增加模型、时间、预算的文字，`describeFlow` 说明轮次。启用确认和校验预览共用，不改原有字段和措辞，未改 `done` 联合类型。
- `engine.ts / store.ts` 管当前轮和完成快照。默认手动，支持完成后、每天和星期；上一轮没完不开新的，前置段只做一次，自动推进上限照旧，错过日期不补跑。`item_flow_rounds` 随事项拉取，视图只读最近 10 轮；日志与阶段行带轮次。
- `agents.tiers` 三档默认不配。运行按 `execution.source=flow` 选 AI，不换其他后端或模型；缺档位沿用自身默认并每段每轮只记一次，配错卡住，额度用完等待，包括排队后复查和运行返回额度错误的情形。
- `timing.ts` 纯函数按配置时区算本轮时刻下限、可跨午夜的开始窗口和下一次日期，覆盖夏令时。已有巡检负责到点推进和累计分钟预算取消，不新建定时任务，运行不因窗口关闭被停止。
- `stage_report` 增加 `unsure`；未交结果或拿不准时按 `escalate` 上限带反馈重做。同轮重开保留已用时间和升档次数，新轮重置。`flow_round(item)`、round HTTP 与副本预算 HTTP 均按事项本人和空间检查，定义模板不受副本修改影响。
- 实现边界和设计差异见 `docs/v2/studies.md`“第一期的实现”；未做台账、`trials`、课题工具、内置课题模板或网页。真实 Codex gpt-6.1-sol / low 工具验收已尝试，CLI 在模型调用前因 `Could not find home directory` 退出，真实行为仍待验。
- 定向检查：9 个测试文件通过，`96 passed | 1 skipped (97)`（原有 Windows SSH 用例跳过）；`npx tsc --noEmit -p .` 退出码 0。命令和验收步骤见 `docs/v2/acceptance.md` 的 45f-1 至 45f-6。

## 流程 Git 信号：推送以后自己进入下一段（11-15）

- owner / wait 阶段支持 `done: { signal: git.pushed }`、`git.merged`，run / object 校验报中文错误；内置 delivery 的推送段加信号，只补缺，不覆盖已有模板。本人仍可手动完成。
- `src/flows/signals.ts` 从事项 code-work 查已应用落点，每个仓库的提交都在远端才完成；合并只查目标 / 默认分支的远端。普通应用保留接收基线，以临时索引核对补丁进入的提交；工作分支确认保留 base / head，避免把后来无关提交算进来。远端 squash / cherry-pick 不按补丁等价推断。
- 巡检、omem 推送成功、每小时仓库同步后检查；本地远端引用优先，缺少依据时每仓库十分钟尝试一次远端读取、总预算十五秒。通过引擎串行入口，以 host 写完成依据并继续推进；不推送、不切分支、不动本人索引。
- `flow_signals` 保存键、事项、阶段和完成 / 等待原因，相同结果不重复追加，检查顺带清理三十天前的记录。记录属于本机，拉取不传播、覆盖保留；doing 信号阶段视图增加 `waitingSignal`，未改网页。
- 验证：`test/flow-signals.test.ts` 使用真 Git 与本地裸远端，19 项通过；按任务指定的七文件命令运行，最终原样结果为 `Test Files 7 passed (7)`、`Tests 90 passed | 1 skipped (91)`；`npx tsc --noEmit -p .` 退出 0。跳过的是 Windows 上原有的假 SSH 测试。消息 / 文档 / 插件信号、补录与上下文跟进未做。


## 图表改成“可数的单位”的画法和配色，加入场动效（11-15）

- 仍只在 `packages/plugin-sdk/charts.ts` 画，接口和组件块的 schema 不变。柱改成一格一格的梯级（`rungUnit` 定一格是多少，每五格加粗，超过六十根才退回细实心柱）；横向排行改成一排竖刻度（拉伸的 SVG，`vector-effect: non-scaling-stroke`）；只有一两行的小表画数字加细条；折线逐点画点、周末空心、底线一天一根刻度，线一律直线；面积是一根根发丝线；饼图改成一百根刻度的表盘（`dialTicks` 分配）；指标数字放大、标签加字距，小走势也是发丝线。图下一行写读法（“一格 = 5 单 · 每五格加粗”）。
- 颜色 token：`--chart-1`…`--chart-8` 换成低饱和、色相和明度都拉开的一组；新增单组用的 `--chart-seq-1`…`4`（青瓷蓝明度阶）和只标“要看的那一个”的 `--chart-accent`（橙红）。色值和检查结果见 `docs/v2/interactive-ui.md`“图表的样子”。插件页的主题消息带上这些 token（`web/src/views/Plugin.vue`）；飞书卡片的 `SERIES`、`SEQ`、`ACCENT` 用浅色同一组值，测试核对。
- 入场动效：第一次进入视口时播一次（`IntersectionObserver`，CSS 动画，一秒左右），`prefers-reduced-motion`、`[data-chart-still]`、`<html data-chart-motion="off">`、`setChartMotion(false)` 时不播；`scripts/doc-screens.ts`、`scripts/screens.ts` 用 `reducedMotion: "reduce"` 截图（`screens.ts` 设 `MOTION=1` 可保留动效）。悬停时被指的柱、线、表盘一段保持，其余变淡，线图有读数线。
- `scripts/doc-screens.ts`：数据页的演示数据加了“回复发出后的结果”；`uv_charts_demo` 加了 30 天的折线、一组排行柱和三列并排的刻度行。


## 流程里的验证阶段：逐条的结果带截图和录屏（11-15）

- 承担一个阶段的运行（`flow-stage`）有了 `report_tests`、`attach_artifact` 和 `$OMEM_ARTIFACTS`（`src/flows/engine.ts`；交法和编码一轮相同）。
- `flowView` 的每个阶段多 `tests`（`stageTests`）：这一段的运行交过的用例，同一条取最新一次，没通过、没做的在前，带需求点标题、`mode`、`note` 和产物。
- 事项页的流程面板（`web/src/components/ItemFlow.vue`）在所选阶段下面列“逐条的结果”：一条一行，点开是说明和 `RunArtifacts`（截图、录屏的查看器）；没通过的默认展开。
- `roles/_common.md`“流程里的一个阶段”加了验证 / 验收的做法：和编码验证的分工、用例从需求点来、本人给的测试账号可以直接在测试环境登录（内置技能 `desktop-control` 的“安全”一节同步放开：测试环境、测试账号、凭据来自本人给的材料，三条都满足才行）、缺账号问本人或负责的人、不替本人下结论。折线、面积和小趋势线恢复成曲线（`charts.ts` 的 `curve`，单调三次，不会冲过数据点；飞书卡片 `curveType: monotone`）。


## 图表与指标只有一种画法（11-15）

- 新增 `packages/plugin-sdk/charts.ts`（`@omem-ai/plugin-sdk/charts`）：柱、横向条形、折线、面积、细环、指标数字和小走势的唯一画法，不依赖框架，颜色全走 CSS 变量。`blocks.ts` 的 `chart` / `metric` 改由它画；网页的 `web/src/components/charts/`（`Chart`、`BarChart`、`RankBars`、`TrendChart`、`ShareChart`、`MetricRow`、`Sparkline`）是它的薄封装。
- 样子：发丝线网格（每根柱都标了数时不画）、细柱 2px 圆角、关键值用实心点加数字写在图上、几条线在线尾标名字、日期轴每个标签一根短刻度、单组面积图由细竖线组成；横向条形改成 HTML（名字、条、数，可带链接和行尾的其他列）；指标去掉卡片边框，改成发丝竖线隔开的一排数。约定见 `docs/v2/interactive-ui.md`“图表的样子”和 `.agents/skills/omem-design`。
- 颜色 token：`web/src/styles.css` 的 `--chart-1`…`--chart-8`、`--chart-grid`、`--chart-axis`（浅色、深色各一套，做过色盲区分检查），替换了 `blocks.ts` 里写死的 `--s1`…`--s8`；插件页的 `omem.css` 从同一文件复制。飞书卡片的 `SERIES` 用浅色同一组值，`chartSpec` 改成细柱、值轴浅网格、虚线目标线、细环饼图；`test/ui-blocks.test.ts` 核对卡片色值和 token 一致。
- 组件块 `chart` 加可选的 `highlight`（强调一个标签，须是 labels 里的一项）；以前的块照常显示。文字版里强调的那一行加粗。
- 数据页（`web/src/views/Insights.vue`）改用这些组件：一排数字是 `MetricRow`，单列的小表是带链接的条形，多列同单位的小表是并排的彩色条（其余单位写在行尾），每天的件数是按场景堆叠的柱（场景颜色固定），每天的正面、负面反馈是线尾标名字的折线；版式、文字、筛选、明细、导出不变。`scripts/doc-screens.ts` 加了一个月的虚构运行、`insights` 截图和一个包含各种图表的演示块（`#/ui/uv_charts_demo`，只供 `--serve` 时看）。



## 回复发出后有没有用（11-15）

- `src/agents/reply-outcomes.ts`、表 `reply_outcomes`（一次运行一行，随运行拉取）。回答别人的运行（ask / guest / lark-command / agent / rule-fire；协调、唤醒、会议轮次除外）发出回复时登记：`threads.ts` 的 `addMessage` 和 `channels/lark-feedback.ts` 的 `recordLarkSent`（`purpose = answer`）。
- 巡检节拍里 `labelReplies`（不等它跑完，一次最多 12 条）：到了 `replies.outcome.afterHours`（默认 6 小时）以后，取同一会话之后的用户消息和同一个群里之后的消息（话题内或引用它的优先，否则只取两小时内的），决策模型五选一；没人接话、只有表情的不问模型；概率低于 `replies.outcome.threshold`（0.6）按“看不出”；没有决策模型时每小时再试，一周后记“没判”。
- 改判保留第一遍的标注：夜间复盘的评判在 JSON 里多写 `original`（两种顺序一致才改，`replay.ts`），coach 用工具 `revise_reply_outcome`（分组 `delegate`），本人在运行页点（`POST /api/runs/:id/reply-outcome`，只给主人）。
- 用在：数据页“做得怎么样”的“回复发出后的结果”小表、“回复有用的占比”“被复盘改判的”（`insights.ts`）；运行页“回复发出后”一栏（`GET /api/runs/:id` 的 `reply`）；复盘挑题把“被纠正”当纠正信号；整理消息的任务在群聊原件后多一行；`read_run` 带上标注和依据。
- 第一次启用时 `backfillReplies` 把最近一周的回答补登记一次（kv `reply_outcomes_backfill`）。
- 设置 → AI →“回复发出后看有没有用”。设计和没做的见 `docs/v2/reply-outcomes.md`。

## 设计稿：课题（自主探索一个项目）（11-15）

- `docs/v2/studies.md`，未实现；取舍本人已定（第 11 节）。一个长期的探索（给一个仓库找缺陷和改进点）按需一轮一轮转：好模型提方向、本人确认，没人看着时主要由便宜模型按方向逐个做试验（可以改代码，可以请好模型升档看一眼），之后小结并把试验归并成发现。
- 三条硬约束：不凑数（没有方向、没有发现都是正常结果）；不被旧记录带偏（提方向时不给台账，提完才对账，只去掉完全重复的试验）；不固定节奏和分工（默认本人开始一轮，预算每轮定）。
- 不另起一套调度：课题是一件持续关注的事项，加一份带轮次的流程，加一份台账。给流程补四样通用的能力——轮次（`repeat`）、阶段的 AI 档位与时间段（`ai` / `at` / `window`）、升档（`escalate`）、预算（`budget`）；“一个方向下跑很多试验”由新的对象 `trials` 承担。
- 试验在哪跑不写死：登记的执行环境（本机、云端会话型后端、托管的流水线、另一台设备）。另一台设备现在只能由本机的模型经 `code_workspace` 去操作或 `ask_agent(档案@节点)` 一问一答，“把试验派过去”要新做。第三方样本的代码只在标了可以执行的环境里跑。
- 台账是三张挂在事项上的表：方向、试验、发现；功能清单和各方向的结论写在仓库空间的 Wiki 里。夜里的改动留在交办分支上、经评审、不合并不推主分支；推送只对课题登记的远端和分支前缀持续授权；对外只出草稿。具体怎么挑样本、怎么跑写成技能，不进仓库。


## 流程的两个页面重做版式和文字（11-15）

- 事项里的流程面板（`web/src/components/ItemFlow.vue`）：阶段是一排细条（完成、进行中、等你、未到四种颜色），等你的那一段单独一块说明要做什么并带按钮，下面是所选阶段的“谁来做 / 跟着 / 依据 / 最近”和可展开的“经过”。只是加入、开始、等待这类宿主自己写的备注不再显示在“最近”里（`src/flows/engine.ts` 的 `ROUTINE`）。
- 流程定义页（`web/src/views/Flows.vue`）和规则页同一个版式：左边列表（名字、说明、“5 段 · 2 段你来做”），右边是“它会怎么走”的编号清单和 YAML 原文；输入时保留上一次读得出来的清单，YAML 有错时在清单上方写明。没选中时是说明和“新建流程”。
- 一个阶段用大白话怎么说只有一处：`src/flows/definitions.ts` 的 `describeStage`（谁来做、怎么开始、做到什么算完、什么时候才需要），定义页的校验接口和助手起草流程时发给本人的确认卡片共用。`POST /api/flows/validate` 多返回 `name`、`description`，每次都要做的阶段 `when` 为空。
- 设置 → AI → 自动推进 多了流程的两项：没有人参与时连着自己开始几段后先问（`flows.autoAdvance`）、停在等你的阶段过几天提醒（`flows.staleDays`）。

## 事项流程网页：进度、关卡与定义（11-15）

- 事项详情材料上方的 `ItemFlow`：未开始时一行建议或选择入口；四种颜色的阶段条、本人操作卡片、承担者与对象、原件 / 运行 / 方案依据、最近五十条经过每次看十条、停止与重开。窄屏阶段换行，不横向滚动。状态文字、动作与用时集中在 `web/src/lib/flow.ts`，有独立测试。
- “规则 → 流程”（`#/flows`）：定义列表、带注释的两段新建模板、YAML 编辑与防丢修改；右侧中文预览来自主人专用的 `POST /api/flows/validate`，采用 `parseFlow` 补齐后的前提。有效且有改动才能保存。
- `src/flows/http.ts` 增加只读 `stages[].question`，区分开始与完成确认；`GET /api/items` 的 `flow: { stage, name, waiting } | null` 在 HTTP 层对已过滤事项一次 join 和窗口查询，每事项只取一个当前阶段。运行触发的“流程”链接回事项。
- 未改流程引擎。网页“还不行”写原因后调用现有 `reopen`，与提问回调的三次返工处理存在差异，见 `docs/v2/flows.md`。演示数据增加需求交付流程停在本人推送的事项，仅生成 `item-flow` 截图。

## 数据页（原叫“成效”）重做版式和文字（11-15）

- 侧栏叫“数据”，有自己的图标（`chart`）；抽检也换了图标（`sample`），不再和运行共用一个。
- `web/src/views/Insights.vue` 重写：不再把每个指标铺成一张卡片。每个板块上面是几个数（整块可点，看是哪些记录），下面按内容用条形列表（只有次数的）、小表格（几列的，如评审意见的采纳 / 不采纳 / 采纳率、各后端的次数和时长）和按天的小柱（合计一行，各场景各一行）；口径收在“这些数是怎么数的”里。筛选默认收起。
- `src/insights/types.ts` 的 `Metric.cell`：服务端把成组的数字标成“哪张表、哪一行、哪一列”，页面据此排表；已经作为数字或表格出现的图不再画第二遍。
- `src/insights/insights.ts`：板块标题、说明、空状态、口径和指标名全部改成给本人看的话（不出现字段名和内部函数名）；明细列表写“问答 · 做完”和本地时间。导出的标题是“omem 的数据”。


## 成效页：记录、范围、基线与导出（11-15）

## 事项流程：第一期服务端（11-15）

- 内置流程 `flows/library/delivery.yaml`（需求交付）；`roles/assistant.md` 加工具组 `group:flow` 和一节“流程：让一件事自己往前走”（什么时候起草流程、什么时候让事项走流程、怎么回答进度、怎么重开）；`roles/_common.md` 加一节“流程里的一个阶段”，带 `stage_report` 的运行都会看到（只做这一段、以写明的完成条件为准、结束时必须交代、要本人拍板的不用“完成”带过）。成效页的场景表把阶段运行归到“提醒与跟进”。

`src/flows/` 实现 YAML 定义、内置补缺播种、事项上的流程副本、阶段状态与日志、前提推进、when 决策 / 本人提问、本人关卡、报告、重开、结束和倍增提醒。`code-work` / `design` 是小型对象注册表：按事项 run 材料找交办，读 `codeWork.stage.key` 与最近轮 `roundList.verdict=approved`，方案还核对本版确认记录的 `by` 等于事项本人。没有扫描 runs 的 JSON 事项字段。

所有阶段变化同时写日志和事项时间线、发 item changed，进度通知用 replaces 替换。只有本人自己的答案能过关卡，在写答案前与处理回调时均检查收件人和回答人。`done: confirm` 返工最多三次，运行结束没交结果卡住。新增 `group:flow` 的五个工具、`read_item.flow`、定义和事项流程 HTTP、集中路由权限；细节见 `docs/v2/flows.md` 的“第一期的实现”。

迁移只追加三个表；流程和阶段以显式 updated_at 比较，日志以 sync_key 映射整数 id，三个表都随事项拉取，既有引用重写也覆盖其中的 JSON。没有增加投影、触发器、缓存或依赖。启动从 `flows/library/*.yaml` 补缺，目录缺失或为空也可用；本切片不带默认 delivery.yaml。

本期的适配：HTTP 示例重复的 note 分为 instruction（定义说明）和 note（最近进展）；提醒按自然日，间隔为 2、4、8 天；缺方案时复用 designer 的 runDesigner（submit_design 的原有角色限制），默认主助手尚需单独授予 group:flow。没有改角色正文或内置技能，也没有实现网页、飞书专门版式、信号、插件对象、上下文订阅、看板、成效页或关卡升降。

监听 changed(code-task)、changed(design)、run（含终态），按运行主键、continueFrom / parent 与事项材料定位正在走的流程。尚无即时事件：应用 `src/agents/code.ts:1226`、丢弃 `:1239`，分支确认 `src/agents/code-branch.ts:477`、归还 `:486`，方案创建 `src/designs/store.ts:53`、基础信息更新 `:276`、绑定交办 `:290`。未改编码或渠道发射器；下次已有事件或心跳重读。

验证：`npx vitest run test/flows.test.ts test/flows-http.test.ts test/esm.test.ts test/tool-help.test.ts test/permissions.test.ts test/pull-complete.test.ts --maxWorkers=2 --configLoader native --cache=false`：6 个文件，62 通过、0 失败、1 项既有跳过；`npx tsc --noEmit -p .` 通过。含真实 worker 调度到假 Agent、通过 stage_report 交结果的路径，不连真实模型。`npm pack --dry-run --json --cache .flow-pack-cache` 成功；仓库没有内置 YAML，实际清单不含流程文件；将相同 package.json 放进临时 fixture 包后，dry-run 列出 flows/library/fixture.yaml，验证白名单；缓存与 fixture 目录已删除。默认 npm 缓存不可写，故临时指定工作区缓存。按任务约束未跑全量检查，未操作仓库 Git 状态，未修改禁改文件。

主助手角色另需授予 `group:flow`，建议增加：“一件事项需要按阶段持续推进时，先用 list_flows(item) 查看适用流程；已有合适流程就 flow_start，没有则用 save_flow 起草，等本人启用。”“流程阶段运行按 note 和 done 做，结束前用 stage_report 交结果：done 附依据，blocked 写等谁或等什么，skip 写原因。”“发现已完成阶段的前提变化时，用 stage_reopen 写原因和依据；confirm 只由本人回答，不把运行结束当作完成。”本切片没有编辑角色正文。

## 设计稿：流程后续期、插件的对象与信号、成效页（11-15）


- `src/insights/scenes.ts` 是固定场景表；`insights.ts` 独立计算八个板块，按本人或成员范围过滤，精确本地日期默认 30 天、上限 180 天，内存缓存 3 分钟。`runs_insights` 是唯一新索引，包含时间、小列及编码和分诊状态的小字段表达式；请求不读运行大段输入、输出或事件。
- `web/src/views/Insights.vue` 与侧栏“数据”（当时叫“成效”）：复用抽检布局、现有控件和 SDK 的 SVG 图表。数字与图表数据点可打开同筛选的记录清单，只有标识、状态和时间；支持上一段、Markdown/CSV 导出，估算由主人自行填假设且只存浏览器。API、peer、导出均不含访客正文。
- 数据限制写在 `docs/v2/flows.md` §10.6：找人按运行批次；访客用时按回答运行完成，基线用 reply_samples，双方各 10 个样本才画比较条；页面阅读不冒充回答阅读，约定命中标累计。交付的阶段指标随 flows 一起补入。验收见 `docs/v2/acceptance.md` 的 44a 起。

## 设计稿：流程、插件的对象与信号（11-15，流程部分另行实现）

- `docs/v2/flows.md`：一件事怎么自己往前走。流程定义是一份阶段清单，每个阶段声明前提、承担者、怎样算完成和进入前的关卡，流转由前提推出来，不画连线；跳过、并行、重开、补录、只改这一件事的副本都是一等操作，复杂的编排留在阶段内部（交办、技能）。另写了信号的来源和归属、事项订阅它的群和文档、插件要补的四样接口和两种安装方式。成效页的实现与边界见上条及该设计稿第 10 节。
