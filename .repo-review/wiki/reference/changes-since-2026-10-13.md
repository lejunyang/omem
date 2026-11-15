---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-16
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。


## 原件按地址查找走索引；数据页数有改动的发现（11-16）

- 原件表加 `sources_uri` 索引（`src/core/db.ts` 最后一条迁移）。群名、工作近况、引用、找人、有人找你这些地方只按地址（`lark:<群>`、链接）找原件，原来每次都扫整张原件表：常驻那台的备份库上一次热缓存约 250 ms、冷读 11 秒。`scripts/bench-scale.ts --source-uri` 用 10 万份 4KB 的原件比：200 次查找 9320.4 → 4 ms；`test/query-plans.test.ts` 检查这几种写法都走索引。升级时建索引要扫一遍原件表，只在第一次启动时花一点时间。
- 数据页“课题”板块在发现下面多三项：有改动的、改后重跑通过的、改后重跑仍然失败的（`src/insights/insights.ts` 的 `studySection`）。重跑结果的判定从 `findingFix` 抽成 `fixVerified`（`src/studies/fix.ts`），课题视图和数据页共用。测试 `test/insights.test.ts`。

## 插件的界面插槽、plugin link、从源码构建安装（11-16）

- 设计在 `docs/v2/flows.md` 第 8 节，写法在 `docs/v2/plugins.md` 的“放在 omem 页面上：插槽”“从源码构建”“开发中的插件”。
- 插槽：`api.slot(at, { block, when })`，位置 `item.panel` / `flow.stage` / `today`，`when` 的 `object`（本插件的对象类型）、`stage`、`flow`、`space`。放进去的块是 `display: true` 并带 `load(ctx, slot)` 和 `view(data)`；声明时检查位置、块、条件和对象类型，错了插件代码加载失败（`src/plugins/slots.ts` 的 `checkSlot`，`registry.ts` 的 `api.slot`，`LoadedPlugin.slots` 随代码卸下清空）。接口 `GET /api/slots`（这一页要画哪些块）和 `GET /api/slots/:plugin/:block`（一块的内容：核对事项可读、条件、对象挂在事项上，按看的人和事项空间构造 `PluginContext`，15 秒，schema 和展示组件两次校验，`page` 不收；插件出错 502），在 `src/auth/routes.ts` 登记为 `self`。隔离运行的 `api.slot` 报不支持（`sandbox-runner.ts`）。
- 网页：`web/src/components/PluginSlots.vue`（列出）和 `PluginSlot.vue`（逐块取数，用 `UiView` 画，`onErrorCaptured` 只让这一块报错）放在事项页侧栏的外部状态下面（`views/Items.vue`）、流程选中阶段的说明下面（`ItemFlow.vue`）和今日页右栏最上面（`views/Home.vue`）；没有插槽时什么都不显示。设置 → 插件的卡片写“放在页面上”。
- `omem plugin link <目录>` / `unlink <id>`（`src/plugins/links.ts`、`src/cli-main.ts`）：链接清单在本机 `<数据目录>/plugins/.links.json`，不随拉取；只能命令行链接本机目录（拒绝网络路径），和内置、`plugins/` 里已有的同 id 拒绝。`loadPlugins` 不带参数时最后加载链接的插件（`LoadedPlugin.linked`）；信任记目录（`trust.ts` 的 `dir`），改代码不用重新确认；服务里 `watchLinkedPlugins`（`main.ts` 启动）盯目录和链接清单，改了 0.3 秒后 `reloadLinked`，忽略 `web/`、`node_modules/`、`.git/`，发 `plugin` 事件。`plugin remove`、`DELETE /api/plugins/:id` 对链接的插件只去掉链接；安装同 id 拒绝。设置页标“开发中”，有“去掉链接”。
- 源码构建（`src/plugins/install.ts`）：`buildPlan` 在有 `build` 脚本、清单的 `server` 或服务脚本还不存在时给出命令（装依赖 `npm ci` / `npm install` 都带 `--ignore-scripts`，再 `npm run build`）和包脚本原文；没带确认过的 `key` 时抛 `BuildNeeded`，什么都不运行。命令行用终端确认，`POST /api/plugins/install` 和 `/update` 先返回 `{ build }`，设置页弹窗确认后带 `build: key` 再请求。确认后在解开的临时目录里逐条 `spawn`（去掉密钥类和 `OMEM_` 环境变量，共十分钟，超时连子进程停掉），输出写 `<数据目录>/logs/plugin-builds/<id>.log`。清单新增可选的 `server`（服务端文件的相对路径），`registry.ts` 的 `serverFile` 统一找服务端文件。
- SDK：`packages/plugin-sdk/slots.ts`（不带 import 的类型），`client.ts` 导出 `PluginSlot*`，`PluginSlotView` / `PluginSlotBlock` 带上展示组件和上下文类型。测试 `test/plugin-slots.test.ts`、`test/plugin-dev.test.ts`。

## 用真实模型跑了上下文跟进和提交认领，改了两处（11-16）

- 记录在 `docs/v2/flows.md` 文末“用真实模型跑过的”。两个角色的理解都对（提议和决定分得清、闲聊不交、提交归不到已有事项时建议新建并写理由），问题出在宿主。
- 改期的提议：`note_item_change` 的 `deadline` 加 `decided`。本人说的或材料写明已定才直接改截止时间并告知一次；不带的保持 noted，这一批提炼完后为最后一条提议出一张“改成这个时间 / 不改”的卡片，本人选了才改。截止时间改了以后，其他还在等的改期提议记 dismissed、卡片收回。`item_changes` 加 `due` 列（新时间不再拼进说明里）；给后面阶段的“最近的变化”里写明是提议还是已改。从 `src/flows/follow.ts` 的 `applyDeadline`、`askChanges` 读起，角色说明 `roles/item-follow.md`，测试 `test/flow-follow.test.ts`。
- 事项页：改期的提议标“有人提出改期”，只有两个按钮；变化列表里写“提出改成”或“截止时间改成了”哪天（`web/src/components/ItemFlow.vue`、`web/src/lib/flow.ts` 的 `changeChoices`）。
- 提交认领：仓库第一次核对以后才新建的分支，从它和已知分支的 merge-base 算起，不再直接落在分支末端（`src/flows/commits.ts`，`test/flow-commits.test.ts`）。

## 时区设置（11-16）

- `config.timezone` 原来只在定时任务、部分每日计数和给模型的时间里用，默认取系统时区、网页上改不了；免打扰、稍后汇总的时点、学习卡片的“今天”和网页上的所有时间都按服务器或浏览器自己的时区。现在 设置 → 定时任务 顶部可以选时区（`web/src/views/Settings.vue`），`PUT /api/settings` 校验名字并在变了时用 `rezoneScheduler` 重排定时任务（`src/core/scheduler.ts`，换时区前错过的时间点不补跑）。
- 服务端：`src/core/util.ts` 加 `validZone`、`zonedParts`、`zoneMidnight`、`useProcessZone`；服务（`main.ts`）和 CLI 启动时、设置变了时把进程的 `TZ` 设成配置的时区，没带时区的 `toLocaleString`、`getHours` 和启动的 Agent 都随它。`notify.ts` 的免打扰和汇总时点、`learn/cards.ts` 的“今天”和连续天数显式按配置时区算。配置里不认识的时区退回系统时区。
- 网页：`web/src/lib/time.ts`（`fmt`、`toWallDate` / `fromWallDate`、`dayKey`），时区来自 `/api/me` 的 `timezone`（分享页来自分享接口）。`fmtTime`、`clockTime`、聊天、日期选择器、cron 预览、首页问候和日期、数据页都改用它。测试 `test/timezone.test.ts`。

## 真实跑过一轮课题以后的修正，外部状态卡片（11-16）

- 用真实模型在一个小示例仓库上走了两轮课题（记录在 `docs/v2/studies.md` 文末）。第一轮试验全部“跑不了”，是任务措辞的问题；改了 `src/studies/trials.ts` 的任务文字和内置技能 `study-trial`，`src/studies/store.ts` 的 `reconcile`（跑不了的不算试过）和 `confirmDirection`（选了新方向时结束跑完却没结论的旧方向），`src/studies/materials.ts` 的覆盖统计（不数跑不了的）。试验阶段收尾的说明改成“通过 2 个，没通过 1 个”这样的词，没有推送时不提推送。
- `web/src/components/ItemObjects.vue`：事项页的“外部状态”，每个关联的插件对象一张卡（类型、标题、状态、几个字段、上次什么时候读的、读失败或来源停用），可以贴链接挂上、解除。流程阶段跟着插件对象时，阶段详情里显示它的状态词和字段。
- `web/src/components/FlowSettings.vue`：多一张“你直接做的提交，事后挂回事项上”（开关、安静分钟数）。流程定义页的字段说明补了插件对象的写法。
- “没人认领的提交”审查时改的：交办已经占了哪些分支和提交，只在某条分支真有新提交时才算，而且只看最近 60 天的交办（原来每半小时对每个仓库读一遍全部编码交办并各起几个 Git 进程）。

## 流程第三期第一步：插件的对象和信号（11-16）

- 插件 `api.object` 注册只读对象类型，宿主按事项主人连接读取；进程内与隔离 IPC 均沿用插件现有信任路径，停用、卸载或撤销信任后注销类型并停止读取。
- `flow_objects` 存当前状态，按全名和键生成稳定 id 并随事项拉取；材料增加 object，flow 组增加 `attach_object(item,url)`；本人接口为 `POST/GET /api/items/:id/objects` 与 `DELETE /api/items/:id/objects/:object`。完整对象视图与流程字段见 [流程文末](../../../docs/v2/flows.md)。
- 巡检只查未结束事项关联、未到终态的对象，每轮二十个、串行、十五秒超时，失败五/十五/六十分钟退避；状态变化只记一次信号与每件事项的时间线，再按当前阶段推进。对象阶段可等关联，owner 等其他承担者可按指定对象状态完成；重开不复用旧状态。
- PluginContext.emit 只记录 plugin 前缀信号，keys/payload 各四千字符；SDK 增加对象和信号类型。公开例子只有 GitHub 合并请求，检查读不到就不显示，不接内部平台。
- 不改 web，不做动作、插槽、规则事件、plugin link 或源码安装。新增 `test/flow-objects.test.ts`（24 tests），完整定向命令在 flows.md 文末。首轮为 `Test Files 1 failed | 14 passed (15)`、`Tests 15 failed | 166 passed | 1 skipped (182)`，失败均为 Windows 临时目录清理前未关闭连接保管库；补 closeVault 后为 `Test Files 15 passed (15)`、`Tests 182 passed | 1 skipped (183)`。根目录和 SDK 的 tsc 均退出 0。真实 Codex 冒烟尝试因 `Could not find home directory` 在 CLI 启动时退出 1，未执行模型，真实账号也未验。

## 课题第三期第二步：自动交办与改后重跑、登记范围内推送（11-15）

- `src/studies/fixes.ts`：流程新增 fixes 承担者，内置 study 在小结后加“改”，默认每轮最多两条。只挑本轮新建、new / confirmed、没有交办、有失败依据且方向允许编码的缺陷；范围也须允许编码。逐条沿用 `queueFindingFix` → `queueCodeWork`，评审可应用才重跑，失败留给本人，不反复交办。
- `trials.ts`、`workspace.ts`：普通试验与重跑共用 `startTrial`、study-trial、trial_report；重跑在交办工作区，记录 fix_of / work_id 和 HEAD，模型取试验阶段，缺省取“改”的 AI；不升档、不重试。分钟按交办、评审与重跑实际运行时间计；预算结束或流程停止、重开、跳过只取消重跑，交办不动。
- `scope.ts`、`push.ts`：本人登记 pushRemote / pushPrefix，均非空才持续授权。study_push 只由宿主临时给试验和重跑，只推当前干净工作区 HEAD 到固定的远端及前缀，不强推；成功、失败审计，成功存 study_pushes 并随事项拉取。小结和改阶段说明列本轮推送。
- 课题视图 findings[].fix 新增 verified / reruns，试验新增 fixOf / workId，scope 新增 pushRemote / pushPrefix，顶层 pushes 为最近 50 次成功推送。接口与判断详见 `docs/v2/studies.md` 文末；验收在 `test/study-fix.test.ts`、`test/study-push.test.ts`。
- 未改网页，未做自动应用、合并、分支删除、逐次推送批准、读取流水线结果、远端设备执行或新定时任务。内置流程及技能只补缺，已有 study.yaml 不自动增加“改”。真实模型与外部流水线待验。
## 没人认领的提交：本人确认后挂回事项（11-16）

现有 Git 核对入口顺带观察本机分支的新增本人提交，首次只放游标、不翻历史；按安静期或二十条成批。交办的工作分支、应用提交、已有事项的分支及处理过的提交不再提议。共用事项候选打分，交 commit-claim 角色建议归属，由本人在一张卡片上选择挂到已有事项、新建待办或不用管；挂上后只补录没开始的编码交办阶段，新建不自动开流程。

主逻辑 `src/flows/commits.ts`，配置 `flows.commits` 默认开启、安静三十分钟；新角色和专用交结果工具 claim_commits。git_commit_cursors 留本机，待答合并新提交替换旧卡，失败保留游标、同批最多两次。flow_signals 记每批结局。测试在 `test/flow-commits.test.ts`，拉取隔离在 `test/pull-complete.test.ts`；验证数字见验收清单。没有改 web/，没有写仓库和远端，没有替本人自动关联或确认。

最终指定十二文件回归：`Test Files 12 passed (12)`、`Tests 169 passed | 1 skipped (170)`；提交专项十九项全过，tsc 与差异检查退出 0。旧原地交办只排除应用提交，不占用本人整条分支；旧单仓库交办记录也兼容。真实 Codex 验证受 CLI 无法找到 home 阻断，尚未进入角色运行；真实渠道卡片未验。命令、前几轮失败与修正见 `docs/v2/acceptance.md` 的“没人认领的提交”。

## 界面：流程看板、补录、逐条签字、关卡授权、课题的范围和修改（11-15）

- `web/src/views/Board.vue`（`#/board`，事项页“按流程看”进入）：`GET /api/flows/board` 的事项按流程分区、按该流程定义的阶段顺序分列，没有事项的列只留名字；筛“等我的”“卡住的”；窄屏改成按阶段分组的列表。今日页（`Home.vue`）多一块“流程里等你的”。词和排序在 `web/src/lib/flow.ts` 的 `boardLine`。
- `web/src/components/ItemFlow.vue`：未开始的阶段有“这一段已经做过了…”（补录）；验证结果每条有“看过，对 / 不对…”和撤销，标了不对的原因显示在这条下面；因授权直接开始的阶段（`flowView.stages[].autoStarted`）可以叫停并退回每次问；跟进到了当天上限时那一行改说“明天一起看”。
- `web/src/views/Flows.vue`：已经改成直接开始的关卡标在那一段下面，可以“改回每次问我”。
- `web/src/components/FlowSettings.vue`（设置 → AI）：上下文跟进的开关、安静分钟数、条数、每天批数；关卡升降的开关和次数；课题的执行环境（名字、标识、怎么用、用哪一档模型、能不能执行第三方样本的代码），整份编辑后一次保存。
- `web/src/components/ItemStudy.vue`：台账顶上一行“范围”，展开改仓库、可以改代码、本机执行第三方样本；选方向时可勾“这个方向的发现可以改代码”；发现上“去改…”发起编码交办并显示交办状态；试验显示跑在哪个提交上。
- 定方向交提案后给本人的提问改成分条的文字，预算用人话写（`src/studies/service.ts`）。

## 课题进数据页、简报与 coach（11-15）

数据页在编码交付后增加课题板块：期间已交试验、按事项的四种结果、新发现的当前判定、结束方向、按模型的试验运行次数；只含可读空间，没有试验不显示，不排名、不计算发现率。数字沿用 RecordRef 回到运行或事项，Markdown / CSV 一并导出。按人、模型等筛选时省略不能归属的发现和方向。

每日简报的 brief 处理器从台账拼“上一轮的探索”，按原有 brief_at 只纳入新结束的课题轮次；成功才推进边界，生成期间新结束的留给下次。模型照材料写，不给它 read_ledger。coach 精确清单增加只读 read_ledger，按课题技能或阶段读失败、拿不准与被否决发现及原因，提出技能建议。未改网页、台账行为、表、设置或接口；真实模型待验。

入口：`src/insights/insights.ts`、`src/agents/study-brief.ts`、`src/agents/jobs.ts`、`roles/brief.md`、`roles/coach.md`；验收见 `docs/v2/acceptance.md` 的 study-d4。
## 流程第四期的一部分：本人补录、逐条签字、关卡升降、每日上限和看板数据（11-15）

本期只改服务端与测试，新增网页入口由独立任务接入。未到或等确认阶段可由本人写说明补记完成，可附 src: / run: / design: 依据；不要求前提已完成，后面仍按原推进规则走，重开清除 recorded。验证结果每行可签 ok / wrong / 撤销，范围与 stageTests 一致；新结果不继承旧签字，全 ok 不自动确认，本人重开时把 wrong 的用例名及备注带进新任务。

`src/flows/gates.ts` 沿用审批阶梯的本人提问和 kv 标记，按流程、阶段、用户累计直接开始，默认五次问一次；先别做、跳过或改要求重新计数，fixed 与自动上限提问不参与。明确选“以后直接开始”才写 flow_gate_grants，授权不绕过 autoAdvance；因授权自动开始的阶段被本人重开、暂停或拒绝完成时撤销并记时间线。授权与撤销墓碑随事项拉取；阶段被删除或改 id 后授权失效。req_tests 仍是设备本地结果，签字跟在结果行上，不新增跨设备合并。

跟进用 flow_signals 当天带运行的 context.batch 计数，默认每件每天 12 次，0 不限；按配置时区换日，到限不动游标，每天只记一条提示。flow.followCapped 是布尔值，follow 仍为数组。看板与事项列表共用一次阶段选择查询，不逐件读 flowView；`GET /api/flows/board` 可按 mine / blocked 筛，今日页直接用 mine，卡住且等本人的一项可同时在两个筛选中。

接口、字段、同步选择与未做范围见 `docs/v2/flows.md` 文末“第四期的一部分”。入口：`src/flows/engine.ts`、`gates.ts`、`follow.ts`、`http.ts`，迁移只加在 `src/core/db.ts` 末尾，路由登记在 `src/auth/routes.ts`。未增加工具、角色、定时任务、投影表或触发器，未做 git.commits 的无人认领提交补录。验证见 `docs/v2/acceptance.md` 的 flow-f3 项。

最终按任务指定的十三个文件运行 Vitest（`--maxWorkers=2 --configLoader native --cache=false`）：`Test Files  13 passed (13)`、`Tests  156 passed | 1 skipped (157)`，退出 0；类型检查与 git diff --check 均退出 0。开发中一轮出现五个测试超时和一个 worker 通信错误，另一轮有四个待答询问筛选的测试断言失败，后续重跑与修正通过；完整命令及六轮原始数字在验收文档。本期不改 web/，未暂存、提交或推送，未跑全量测试、vue-tsc、真实模型或真实渠道。
## 课题第三期第一步：范围、工作区、执行环境和发现交办（11-15）

- 本人登记课题能碰的仓库、编码许可和本机第三方执行许可；默认仓库从事项空间推导，两项许可关闭。范围按事项拉取，Agent 没有修改工具。入口 `src/studies/scope.ts`。
- 方向确认记录各仓库基线，试验借用交办相同的宿主工作区和租约，每次清理后从基线开始；第一个仓库作为运行目录，其余路径写进任务。失败记当前试验 blocked；结束方向、停止流程、关闭事项时清理，不重置本人检出目录。入口 `src/studies/workspace.ts`、`src/agents/workspaces.ts`。
- `studies.envs` 登记环境说明、可选 AI 和第三方执行许可；本机内置。提案只认登记的 id / 名字，规划任务列清单；卡片和页面选择共用第三方授权检查。试验使用环境 AI，额度等待与升档复用阶段规则。入口 `src/studies/envs.ts`。
- 本人可从未否决的发现发起编码交办，使用范围内仓库和依据方向的基线，新建交办分支；发现变 confirmed，返回现有交办状态与链接，小结能读到已有改动。与 delegate_code 共用 `queueCodeWork`，不自动应用、合并或推送。入口 `src/studies/fix.ts`、`src/agents/code-delegate.ts`。
- 接口及视图字段见 [课题设计](../../../docs/v2/studies.md#第三期的第一步)。本步没改网页，没做夜里自动改代码并重跑、推送授权或跨设备执行。内置技能只补缺，已存在的数据目录副本需本人更新。

## 事项页：变化列表和课题的台账（11-15）

- `web/src/components/ItemFlow.vue`：跟进找到、要本人定的变化放在流程条下面，写明影响哪几段、并进来会重开哪一段，三个按钮对应并进、另开、不用管（`POST /api/items/:id/flow/changes/:change`，`src/flows/follow.ts` 的 `settleChange`）；下面列全部变化（类型、一句话、状态、原话）和正在跟的群、文档、攒着几条新内容。
- `web/src/components/ItemStudy.vue`（课题流程才出现，`flowView.flow.study`）：在做的方向和一条试验进度，下面分发现、试验、方向、覆盖四块。等本人选方向时在“方向”里选（`POST /api/items/:id/study/choose`），发现可以认可、不算、以后再说，在做的方向可以结束并写结论。词表和排序在 `web/src/lib/study.ts`。
- 审查时改的服务端：事项的群和会话对应的原件按 id、`(space_id, uri)` 和群 id 的索引查（原来的联表会对原件表全表扫描）；文档和会议按行哈希比对，只把以前没有的行交给提炼，只删行不起运行（`item_follow_cursors.seen`）；引用只要求首尾两行在这一批里；流程视图列出全部等本人定的变化；课题视图改成驼峰字段，方向和发现按写入顺序排；试验的运行不再挂进事项材料。
- 流程定义页的字段说明补了课题的写法。没有新截图。

## 课题第二期：台账和逐个试验（11-15）

- `src/studies/` 保存方向、试验、发现；提案先独立想，提交后才按对象与检查项对账，完全重复且有结果才去掉，其余同对象历史只标 prior。方向和空提案均问事项本人，选定后才建队列，不跑则跳过本轮余下阶段。
- `trials` 阶段接在原流程的事项串行队列和运行结束事件里，一次一个 study-trial；档位、额度等待、时间段复用第一期。未交或拿不准最多升档重做这个试验一次，后端失败重试一次；预算用满完成本轮阶段，剩下的下轮继续，停止时取消当前运行、保留队列。不新增定时任务。
- 新 study 工具组只由阶段临时授予，不加入内置角色默认工具。read_ledger 在定方向阶段强制拒绝；候选发现由小结归并，标题相近须明确合并或区分；发现依据必须是本课题有结果的试验，结束方向要结论。证据复用运行产物。
- 功能清单通过主助手已有 write_file 写事项空间的工作文件；定方向只带功能标题的次数与日期和最近提交标题，不带台账结论。内置四个 study 技能及 study.yaml 均只补缺。
- 课题 GET 和两条本人写接口在 `src/studies/http.ts`，返回最近 200 试验及产物、发现及依据、覆盖与 idleRounds。非 manual 连续三轮没有新发现就停自动开轮并 later 通知；manual 只带计数。三表随事项拉取，通用拉取 SQL 补列名引用以支持 check 字段。
- 网页见上一节；不做执行环境登记、推送授权、试验内交办或远端试验。测试与细节见 `test/studies.test.ts` 和 `docs/v2/studies.md`“第二期的实现”。
## 流程第二期：上下文跟进（11-15）

- 进行中的事项订阅材料里的聊天、会话、文档和会议，从流程开始时的末尾跟新内容；复用巡检，二十分钟安静或三十条成批，排除助手和机器人，保留本人的话。
- 新决策场景 `follow` 只在有把握无关时跳过，否则交只读角色 `item-follow`，通过 `note_item_change` 交带引用的变化。工具只认本运行的事项、批次原件行与流程阶段；不改需求点、不发消息。
- 信息只记，截止时间更新时间线并发一次不急的通知；影响进行中或已完成阶段时问事项本人，并进带反馈重开最早受影响阶段、下游待复核，另开挂来源，忽略保留记录。同批最多三张卡，多条卡逐条选。
- `flowView` / `read_item.flow` 增加最近十条变化及订阅游标、待处理数量；阶段任务带最近变化。变化随事项拉取，游标和三十天的批次信号记录保留本机。入口 `src/flows/follow.ts`、`test/flow-follow.test.ts`。
- 本次不改网页，不新增定时任务、投影或触发器，不做会议纪要专用流程。新增材料在首次巡检发现时初始化末尾，不补读关联前的内容。

验证命令：

```sh
npx vitest run test/flow-follow.test.ts test/flows.test.ts test/flows-http.test.ts test/flow-signals.test.ts test/flow-rounds.test.ts test/decision-log.test.ts test/esm.test.ts test/tool-help.test.ts test/role-tools.test.ts test/permissions.test.ts test/pull-complete.test.ts test/config-merge.test.ts test/insights.test.ts --maxWorkers=2 --configLoader native --cache=false
npx tsc --noEmit -p .
git diff --check
```

最终定向回归退出 0，原样汇总：`Test Files  13 passed (13)`、`Tests  198 passed | 1 skipped (199)`。其中跟进专项 `21 tests` 全过；跳过的是 Windows 无法执行的 SSH shell 脚本用例。类型检查退出 0，无类型错误；空白检查通过。

开发首轮为 `Test Files  3 failed | 10 passed (13)`、`Tests  4 failed | 190 passed | 1 skipped (195)`：旧默认值断言、截止时间通知的有效来源、普通对象重开复核均已修正。末轮前有一次全部断言通过但 Vitest 报 `Errors  1 error`，错误为 `[vitest-worker]: Timeout calling "onTaskUpdate"`，退出 1；同一命令复跑得到上述退出 0 的最终结果。HTTP 测试收尾仍输出两条 `database is not open` 异步警告，8 个用例均通过，未改该测试的既有收尾逻辑。

真实 Agent 验证尝试：`codex exec --ephemeral -s read-only -m gpt-6.1-sol -c model_reasoning_effort=low`，要求按新角色分别判断虚构的范围提议和无关闲聊；当前环境启动时报 `Error finding codex home: Could not find home directory`，退出 1，没有得到模型结果。真实模型与渠道效果仍待验证。

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
