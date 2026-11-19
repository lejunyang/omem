---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-19
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 再并掉四个只差一个参数的工具；旧工具名照样认（11-20）

- `flow_round` 并进 `flow_start`（不传 `flow` 就是开下一轮）；`lark_update_card` 并进 `lark_card`（带 `message_id` 原地更新）；`wake_later`、`wake_on_message` 并成 `wake`（`after` 和 `on_message: {chat_id, contains, from, …}` 二选一，`cancel_wake` 不变）；`continue_agent_work` 并进 `run_agent`（带 `work_id`，或 `own_topic=true` 不带 `name`，续在已有的工作会话上，`name` 不传沿用上一轮的 Agent）。都在 `src/agents/tools.ts`。
- 续一项工作原来靠拒绝清单挡住规则的运行和别的设备，现在 `continueAgentWork` 自己拒绝这两种调用方。
- `src/agents/tool-help.ts` 新加 `MERGED_TOOLS`（旧名 → 新工具和怎么传，含 11-19 并掉的 `fix_review` 等五个）：角色、档案里还写着旧名的，`expandTools` 换成新工具；按旧名调用时报错里说改用哪个、传什么。改了 `roles/assistant.md`、`_common.md`、`heartbeat.md`，`skills/omem/references` 的 agents、flows、lark、owner，内置技能 lark-messaging、improve-loop，`docs/v2` 的 rules、studies、status、architecture。

## 同一次推送的几件事项合用一个回归验证运行（11-19）

- 流程段新字段 `together: push`（`src/flows/definitions.ts`，只用于运行阶段）。`src/flows/engine.ts`：`start` 里按 `pushKey`（事项跟着的交办 `output.pushed` 的仓库、分支、head）找同一流程同一段还在排队的运行，`joinBatch` 把事项加进 `input.items`；没有就新建，`not_before` 推后一分钟等同批的。`runFlowStage` 拆成 `prepareStage`（每件检查是否还在等这个运行、时间窗和额度）和 `runStageAgent`，多件时用 `batchTask` 拼任务。`stopStageRun` 代替直接 `cancelRun`：合用的运行只拿掉这一件。
- `req_tests` 加 `item_id`（迁移末尾一条），`report_tests` 加 `item`（合用运行里必填）；`stageTests` 只取这件的结果，`stageShots` 不取合用运行里散放的图。`reportStage` 按 `input.items` 里这件的 `flowStartedAt` 核对。
- 之前同一次推送的几件缺陷各开一个回归验证运行，同时登录同一个环境。

## 并进别的交办的修改没做时，流程不再当作修好（11-19）

- `continue_code_run` 带 `item_id` 和 `new_item` 记成的修改项在 `origin.item` 记下来源事项（`src/agents/tools.ts` 的 `messageRound`，`code-loop.ts` 的 `ownerNote`）。
- `src/flows/objects.ts` 的 `droppedFor`：这次交办里记到该事项的修改项全是 `wontdo` 时，`code-work` 对象对这个事项不算完成，带 `dropped`（各项的回答）；`src/flows/engine.ts` 跟随它的那一段转为 `blocked`、等本人，不再进推送和回归验证。之前并入的事项只看交办整体，本人说“不做”的那件也被标成修复完成，接着推送、问要不要开始回归验证。

## 会议旁听的节奏可按规则设置；成员的展示页本人也能打开（11-19）

- 会议规则 `meeting-bot` 动作加 `listen`（`window` 分段看 / `after` 只在会后）、`listenEvery`（分钟，默认 5）、`listenLines`（攒满几行提前看，默认 60）、`listenPrefilter`（默认开）、`listenRollover`（同一会话连看几段，默认 8），`src/rules/types.ts`，规则页在“旁听”下面。之前写死每 3 分钟或 40 行一段，长会议的运行很多。
- `src/channels/lark-meetings.ts`：`considerWindow` 决定这一段现在交不交给旁听的 Agent；`prefilter` 用决策模型的新场景 `meeting`（旁听预筛，`src/core/decision-scenes.ts`，门槛 `ai.decision.thresholds.meeting`），判为不用看时只重置计时、不推进 `agent_seq`，这一段和下一段一起再判断（`screened` 记着跳过到哪一行，攒行数从那之后算）。`startAgent` 按 `listenRollover` 决定续用上一个会话还是换新会话，换时把 `heldNotes` 放进任务。
- `/api/ui/:id`（`src/server/http.ts`）：成员会话里画的表格、图表（`ui_views`）本人也能打开，和本人能看成员的运行一致；提问和交互页仍只给被问的人。之前本人点成员会话卡片上的“在网页上查看”得到“没有这个内容”。
- 测试：`test/meeting-rules.test.ts` 的 “how the listening agent paces itself”，`test/ui-blocks.test.ts`，`test/decision-log.test.ts` 补 `meeting` 场景。

## 图片页内预览、流程页截图网格、同一分支不再并行起两次交办、浏览器截图按可见区域（11-19）

- 页内预览：`web/src/components/ImagePreview.vue` 挂在 `App.vue`，`web/src/lib/image-preview.ts` 的 `openImages(list, index)` 打开、`previewFromClick` 处理正文里的图片。接入的地方：`Markdown.vue`（正文图片）、`DiffFile.vue`（改动前 / 改动后）、`Ask.vue`（发出的图片附件）、流程页。`RunArtifacts.vue` 原有的产物查看器不变。
- 流程页（`ItemFlowPage.vue`）：截图换成 `ShotGrid.vue` 的缩略图网格；`src/flows/engine.ts` 的 `stageShots` 按 `run_artifacts.sha` 去重（留带说明的），阶段重做过时别的运行的截图标 `earlier`，页面折叠在“之前几次的截图”。
- 交办的“等你决定”（`CodeTasks.vue`）用 Markdown 显示；`web/src/lib/markdown.ts` 的 `preprocess` 把裸写的 `src:<id>#L起-L止` 变成原文引用。
- `src/agents/review-fix.ts` 的 `openDelegationOn`：还在排队或准备工作区、请求的分支（`fromBranches` / `branchNames`）相同的交办也算“这条分支上已有没确认的交办”。之前两个流程的修复阶段隔两分钟各自 `delegate_code`，第一次还没建好工作区，第二次没被拦下，同一分支上就有了两次交办。测试 `test/delegation-branch.test.ts`。
- `skills/library/desktop-control/scripts/browser.mjs`：默认 `--window-size=1440,900`（`--size` 可改；无界面 Chrome 自己的 800×600 让视口只有约 765×500），新增 `shot` 用 CDP 截可见区域（`--full` 截整页）。`SKILL.md` 写明截页面用它，不用 `aad capture --role document`（按文档高度截，按视口定位的弹窗只占上面一截）。

## 开发中插件的目录监听在机器忙时不再漏掉改动；几处跟不上代码的测试（11-19）

- `src/plugins/links.ts` 的 `watchTree`：Linux 上不用 Node 的递归 `fs.watch`（负载高时实测十次漏八次），改为每个子目录一个非递归监听、新目录随时补上（最多 400 个）；`watch` 建不起来（inotify 实例被用完，报 EMFILE）时每秒比一遍文件大小和修改时间。`.links.json` 的监听也走它（`flat`）。测试在 `test/plugin-dev.test.ts`。
- 测试跟上已有的改动：`test/decision-log.test.ts` 按 11-18 改过的分诊措辞（“把握 0.58，不到 0.6，按「简短提醒」处理”）；`test/item-materials.test.ts` 的精简列表带 `wake`；`test/lark-answers.test.ts` 话题里的思考气泡改为等它出现再断言。

## 评审结论分享、运行页显示等你的流程段、飞书授权链接与接着做、消息采集开关（11-19）

- `src/core/shares.ts` 的 `shareReview`：review 类只读分享，内容是最近一轮评审的问题和本人决定、负责人总结、分支，不含过程；引用的代码位置用 `src/agents/run-file.ts` 的 `readRunFile`（从 `/api/runs/:id/file` 抽出）按评审分支读出前后几行，`src:`/`mem:` 用分享者能读的范围复制，正文里改成 `#ev-<n>`；分享页（`Share.vue`、`lib/share.ts`、`ShareItemBody.vue`）评审用三栏：问题目录、问题、证据；入口 `POST /api/runs/:id/share-review`、工具 `share_review`、评审概览“分享结论”。分享页 `web/src/views/Share.vue` 加了 review 的渲染。
- `web/src/components/FlowWaiting.vue`：流程页顶部等你的段抽成组件，运行页概览（`CodeWork.vue`）在交办归属的事项流程等你时也显示，不按流程或平台特判。
- `src/auth/connect-wait.ts`：成员没连接飞书或缺功能、scope 时，`needConnection` 生成预先勾好的登录页链接（`#/login?provider=lark&features=…&scopes=…`），私聊通知并记下会话（kv `connect_wait:<用户>`，6 小时）；`saveConnection` 后 `connectionGranted` 用 `[授权]` 一轮接着做。lark-cli 取令牌的回调带上命令参数（`larkCommandFeatures`），`lark_doc_update` 先查 doc-write。
- `src/auth/features.ts`：“我的消息”拆成“群聊消息”“单聊消息”；采集默认关，账号页“采集到 omem”分别打开（`setChatCapture`、`PUT /api/auth/connections/lark/capture`、`lark-member-capture.ts` 的 `chatTypes`）。登录页功能列表默认展开、说明另起一行、读 URL 参数预勾。

## 流程进度卡分段；跟着交办的段重做后不再误报卡住（11-19）

- `src/flows/store.ts` 的 `progress`：`markProgress` 收 `{ head, note }`，正文是加粗的首行、各段说的话、`**流程**`（每段带状态的一行）和 `**接下来**`（`PROGRESS_TAIL`）；通知带 `view: "flow"`，等你时 `tone: "warning"`。
- `src/channels/item-notification.ts` 的 `flowProgressCard`：长的说明折进“更多情况”，流程和接下来始终展开；只留“打开流程页”。
- `src/flows/engine.ts`：跟着交办的段带着本人意见重做，运行结束没交 `stage_report` 但发起或并进了交办（`objects.ts` 的 `codeWorkSince`）时，段跟着这次交办走；真没交结果时的说明分段写“运行最后说的”。跟的是分支评审时（`latestCodeWork` 的 `branchReview`），`stageTask` 让它带 `rereview_of` 复审，不再写“按需求点发起交办”。测试在 `test/flows.test.ts`、`test/notification-card.test.ts`。

## 新建空仓库并建空间（11-19）

- `src/core/repositories.ts` 的 `initRepository`：名字放数据目录 repos/，绝对路径要不存在或是空目录；`git init -b main` 加一次空提交（没有 Git 身份时用 omem 的），工作区和分支才有起点。
- 入口：工具 `connect_repository` 的 `create`、`POST /api/spaces` 的 `init`、`omem space add --init [--path]`、设置 → 新建空间里代码仓库的“新建一个空仓库”。测试在 `test/spaces.test.ts`。

## 接着交办往下做只剩 continue_code_run（11-19）

- `fix_review`、`message_code_run`、`set_code_review` 并进 `continue_code_run`，按参数分：默认开下一轮；带 `fix` / `later` / `wontfix`（或对分支评审写 `task`）按评审结论改（`fixFindings` → `startFix`）；`when: now` 交给正在跑的这一轮（`messageRound` → `addCodeNote` / `ownerNote`）；不写 `task`、只写评审设置是只改之后的评审（`setLaterReview` → `setRoundReview`）。`text` 参数统一叫 `task`。
- 按评审结论改现在也能带编码 AI（`execution`，`startFix` 新参数；换 AI 不接着原会话），基于分支评审交办时沿用评审里点名的 `reviewExecutions`。`resplit_change_points` 加 `execution`（拆分运行的 input，`splitChangePoints` 优先用它）。
- `code_branch` 去掉 `sync`：和 `continue_code_run` 的 `sync` 重复；`continue_code_run` 只带 `sync` / `onto_latest_target`、不写 `task` 时排一轮只做同步（`syncOnly`）。`squash` 留着（确认前压缩工作分支，和 `apply_code_run` 的 `squash_message` 时机不同）。
- `CODE_STARTERS` 跟着缩成 delegate_code、review_branch、continue_code_run、settle_code_task。改了 `roles/assistant.md`、`skills/omem/references/code.md`、几处报错和测试里的工具名。

## 不能交办的运行也不能经别的工具开始编码或评审（11-19）

- `tool-help.ts` 的 `CODE_STARTERS`（delegate_code、review_branch、continue_code_run、fix_review、message_code_run、settle_code_task）：助手的临时任务、交出去的运行、借出的运行（`LEND_DENIED`）、规则的运行（`rules/actions.ts`）、有人找你的处理（`MENTION_DENY`）都整组禁用。以前这几处只列了 delegate_code / continue_code_run（规则和有人找你还漏了 review_branch），`fix_review` 在分支评审上等于交办、`message_code_run` 和 `settle_code_task` 能续轮，都没拦。以后新加会排编码或评审轮次的工具要放进这个列表。

## 按评审项指定 AI；复审并进 review_branch（11-19）

- `review_executions`（键：评审项名、`review-lead`、`split`）加在 `delegate_code`、`review_branch` 和 `roundReviewSchema`（`continue_code_run`、`fix_review`、`set_code_review` 共用）上，存为 `input.reviewExecutions` 或 `roundReview.ais`；`review.ts` 的 `namedReviewAI` 一处取用，评审项、评审负责人的各次运行、需求拆分都按它，点名的优先于轮换。`POST /api/review-branch` 收 `reviewAis`。
- 当天加的 `rereview_branch`、`link_finding_external` 去掉了：复审是 `review_branch` 带 `rereview_of`（`note`、`inputs`；仓库、分支、事项、方案、评审项和指定的 AI 沿用），登记评论是 `revise_finding` 带 `comment`。工具数不增加。

## 复审已有分支；评审问题对上评审平台的评论（11-19）

- `src/agents/rereview.ts`：`startRereview` 按上一次分支评审新建一次（`rereviewOf`、`rereviewNote`、`rereviewInputs`、`previousTips`）；`rereviewText` 进 `reviewContext`（增量提交、统计、diff，改写过的历史按全量；旧问题清单）；`recordPrior` 记 `submit_review.prior`（“仍在”优先）；`settleRereview` 在评审结束时标没复核、算 `stillBlocking` 和可 resolve 的评论，`review-chain.ts` 用它决定通过与否并写进卡片和事项时间线。
- `review_findings` 新列 `resolution`、`resolution_note`、`checked_run`、`resolved_run`、`external`。复审用 `review_branch` 的 `rereview_of`、登记评论用 `revise_finding` 的 `comment`（起初另加了两个工具，同一天并回去）；接口 `POST /api/runs/:id/rereview`、`GET /api/runs/:id/prior`、`PUT /api/runs/:id/findings/:fid/external`。
- 网页 `ReviewSummary.vue`：分支评审概览的“复审”按钮（补充、作者回复两栏），复审概览的“上次留下的问题”，原评审问题上的复审结论和评论状态。
- 文档 `docs/v2/review.md`“复审已有分支”，工具说明 `skills/omem/references/code.md`。

## 反向连接：连不到本机的设备也能调用本机（11-19）

- `src/core/peer-back.ts`：A 对打开了的设备保持一条控制连接（`/api/peer/back`，升级 `omem-back`，`x-omem-back-token` 带 A 签给它的本人令牌），B 要访问 A 时发 `{open: n}`，A 再连一条 `/api/peer/back/stream`，B 用它当到 A 的连接，A 把它 `emit("connection")` 给自己的服务。别的进程（ACP 桥、命令行）经本机服务的 `/api/peer/back/relay` 要连接。状态按数据目录分（测试里一个进程跑几个实例）。
- 设备记录多 `back`（对方连着本机）和 `serveBack`（本机连着对方）；`backOnly` 的设备 `peerFetch` 走 `backFetch`（`createConnection`，不能带 `agent`，否则 Node 不用它），`peerRoute` 多 `connect`，隧道和 `connectAcp` 用 `connectOption`。直连失败而有 `back` 的也退到反向。
- 进来的连接地址是 loopback 时换成 `0.0.0.0`，不带令牌一律 401；`backendAvailable` 对只能反向到的设备看它连没连着；`preClose` 时断开，免得空闲的 Agent 会话让服务关不掉。服务端升级过的 socket 不能 `setEncoding`（会抛错让进程退出），按行读用 `StringDecoder`。
- 入口：`omem peer back <设备> [on|off]`、`POST /api/peers/:id/back`、设置 → 设备每台下面的开关。文档 `docs/v2/mesh.md` §1.2，测试 `test/peer-back.test.ts`。

## 插件回调、对象“有更新”、omem 自己的事进规则（11-19）

- 插件回调：`api.hook({ name, handle(ctx, req) })`（`src/plugins/hooks.ts`；在 omem 进程里和隔离运行两条注册路径，`registry.ts`、`sandbox.ts`、`sandbox-runner.ts`）。公开地址 `POST /api/hooks/<插件>/<名字>/<密钥>`（`src/plugins/http.ts` 的 `registerHookRoutes`，单独一层只收原始文本、1 MB；`auth/routes.ts` 里是 public，`server/http.ts` 的鉴权钩子跳过它）。密钥在插件卡上生成和撤销（kv `plugin-hook:<插件>/<名字>` 只存哈希），每分钟 60 次，每次写 `audit_events`（`plugin.hook`）。`handle` 返回的 `refresh` 走 `refreshObjectByKey`，`emit` 走 `emitPluginSignal`。
- 对象修订：`PluginObjectState` 多 `revision` / `note`，`flow_objects` 多 `revision`、`revised_at` 列。`readObject` 在状态没变、修订变了时记 `object.<全名>.updated`、事项时间线“有更新”、推进流程、发 `object.change = "updated"` 的规则事件。`updated` 是保留状态：`validateObject` 拒绝，流程 `done` 可写（`findPluginObject` 的 `updatedAfter`，从进这一段或重开算起）。规则 `trigger.objectChanges`（默认 `["status"]`）。
- 规则触发 `omem`（`src/rules/omem-events.ts`）：订阅 `app.events` 的 `run`、`ask` 和新的 `omem` 事件（`AppEvent` 多一种，网页的事件流不发它）。各处发的：`setRunOutput`（`appliedAt` / `discardedAt` / `reviewStage: done`）、`upsertItem`（新建、改状态）、`changeStage`（阶段状态或“在等本人”变了）、`emitPluginSignal`；`reviewFinished` 留给评审链报已修 / 仍在。`types.ts` 的 `OMEM_TYPES`、`OmemFacts`、`omem.*` 字段；`engine.ts` 的 `inScope` 按子类型、空间和 `ruleId` 过滤；防循环看运行的 `trigger.source` / `input.rule`；十分钟去重在进程内。规则页多一个触发“omem 里发生的事”和对象的“哪些变化”。

## 群里发起的会议也能触发会议规则（11-19）

- 规则 `trigger.meetingFrom`（`joined` 默认 / `group` / `both`，`src/rules/types.ts`，引擎里 `meetingFromOk`）。机器人在群里收到 `video_chat` 消息（`src/channels/lark-bot.ts` 的 `handle`）时调 `groupMeetingStarted`（`src/channels/lark-meetings.ts`）：内容里的 `meet_number` 是会议号，先用机器人身份 `vc/v1/meetings/list_by_no` 查会议 id，查不到以 `no:<会议号>` 记下，入会返回或之后查到时 `adoptMeetingId` 换成真 id。`lark_meetings` 加 `chat_id`、`chat_name`、`started_by`、`owner_in`；事件加 `meeting.chat`、`meeting.startedBy`、`meeting.ownerIn`。本人之后入会按会议号认作同一场。规则页会议触发下多一组“我入会时 / 群里有人发起时 / 两种都算”。
- 本人 lark-cli 读到的同一条消息只有“[Video call]”，没有会议号，所以只对机器人所在的群有效。
- 规则的权限检查（`src/rules/permissions.ts` 的 `checkBot`）在规则看群里的会议时，多查 `im:message.group_msg` 和按会议号查会议的权限（`MEETING_ID_SCOPES`：`vc:meeting.meetingid:read` 或 `vc:meeting:readonly`）。

## 网页对话可以带图片和文件；流程的定义搬进流程页、靠对话建；人物卡按邮箱；Wiki 页头整理（11-19）

- 对话附件：`src/agents/attachments.ts`（存进 `files/<hash>.<ext>`，`POST /api/ask/attachments`；`/api/ask` 收 `attachments`，消息 `meta.attachments`，正文用 `[图片1]` / `[文件1]` 引用；`renderMessages` 把每个附件的路径交给 Agent）。`web/src/views/Ask.vue`：粘贴、拖进或点按钮加文件，输入框上方显示，点一个在光标处插入引用，发出的消息下面带缩略图。
- 流程：侧栏“流程”下分“进行中”（看板）和“流程定义”（`web/src/components/FlowTabs.vue`），规则页和事项页不再有流程入口。`Flows.vue` 新建时是“和助理一起建一个流程”：讲做法、交给助理起草（开一段对话，助理问清后 `save_flow`）；`GET /api/flows` 多了 `drafts`（等本人启用的 `flow-save` 提问），列表里直接启用 / 不用；打开一份先看“它会怎么走”，“让助理改”开对话起草新版本，YAML 收在“查看定义”里。
- 人物卡路径：`personSlug` 改成“名字-邮箱前缀”（按 id 找不到邮箱时，用同名的人共有的那一个邮箱；同名不同人又没邮箱时用 id 尾部），以前随“有没有同名记录”在 `people/名字`、`名字-id 尾`、`名字-邮箱前缀` 之间变。`mergePersonCards`（`src/agents/work-state.ts`，每晚 work-state 开头跑）把旧路径的卡并到新路径：一张的直接移动，多张的留最长的那张，其余正文放进“合并进来的旧卡”一节、“本人补充”合在一起、旧路径记成别名，并让这些人当晚重新整理；`roles/work-state.md` 说明怎么把那一节并进去。
- Wiki：聊天类原件（`APPEND_ONLY`，挪到 `src/wiki/store.ts`）只是有了新消息时不算“原件已变化”（列表的计数、目录的黄点、页面的提示、`stalePages` 都不算，`PageCite.grew` 标出来），以前个人空间 56 页里 41 页是这种，自动检查本来就不看它们。“原件已变化”从页面顶部的横条改成侧栏入口打开的对话框（`WikiAttention.vue`）；页头只留“编辑”“让助理改写”，“这页有错”“移动”“删除”收进“更多”。
- Agent 页：标签栏右边的 ＋ 去掉，“新建”放在“我的档案”和技能列表的小标题旁。
- 事项的流程页（`ItemFlowPage.vue`）也放上课题的台账（`ItemStudy`）：以前只在事项详情里，流程页提示“在下面的台账里选一个”却没有地方选。

## 远程画面的剪贴板互通、aad 的“更新到最新”真的会更新（11-19）

- aad 0.0.9 的 assist 两个方向都能传文字、富文本、图片和文件。omem 这边：远程页的画面设置把“复制的文字带回”换成“剪贴板互通”，加了文件上限（`remoteSettings.clipboardMaxMb`，默认 100，`src/remote/settings.ts`）；不是 100 时给 aad 加 `--clipboard-max-mb`，只在 aad 0.0.9 及以后（`clipboardFiles`），旧版不认这个选项会起不来。转发不用改：上传走查看页的 WebSocket，带回的东西是同一路径下的 GET。
- 设置 → AI 的“更新到最新”和 `omem setup desktop` 以前跑 `osdk install github:…`，已经装了一个版本时 osdk 只说“already installed”，从来没更新过。现在先 `osdk list-remote` 找最新的 release，装 `github:…@<版本>`（`src/core/tools.ts` 的 `installTool`）。
- aad 查看页的状态行、按钮、粘贴提示和“远程剪贴板”托盘换成 omem 的样子：查看页经 omem 转发、同源，远程页在它加载时把 omem 的配色、字体、圆角和阴影的值写进一段样式（`Remote.vue` 的 `skinViewer`），切换深浅色时重写。

## 要本人回答的内容分段写（11-18）

- `src/agents/brief.ts`：`checkBrief` 在 `ask_user`、`report_task`、`settle_code_task`、`rule_dispute`、`stage_report` 上退回不分段的长文字；`roles/_common.md` 加“给本人看的问题和报告”，`roles/coder.md` 的 blocked 写法同步。
- 卡片：`src/channels/lark-asks.ts` 的 `briefBlocks`（首句加粗、放得下的展开、其余折叠），编码修改项卡片标题截短、记录单独折叠；`code-tasks.ts` 的 `taskText` 用加粗小标题、本人原话与完成标准相同时不重复；`web/src/components/AskCard.vue` 首句加粗、长正文可展开；流程关卡卡片首句是问题。
- `reviseAsk`（`src/agents/asks.ts`，sink 的 `revised` 原地重画飞书卡片）和 `POST /api/asks/:id/question`。
- 网页：侧栏“流程”（看板），事项列表里走流程的事项打开流程页；`Ask.vue` 输入框按文字变化自动撑开（含预填）。

## 单独发的图片和文件并进 @ 机器人的那一轮（11-18）

- 飞书的图片、文件消息不能带 @。`src/channels/lark-bot.ts` 的 `processEvent` 记下每个成员在哪个群（话题）里最近一次 @ 了机器人（`recentAsks`）；两分钟内同一个人在同一处单独发的图片、文件标为 `followsAsk`，像 @ 一样交给 `handle`，不再等内容窗口，正在跑的那一轮直接收到。访客不并。
- 私聊里发的图片、文件也进对话（之前只存成原件、回一句“已保存”）：照旧存为原件，没写要做什么时按 `contentWaitMs` 等后面的话。

## 飞书 @ 机器人的富文本消息带上图片（11-18）

- 修正：@ 机器人时一起发的图片、视频在富文本（post）里，`src/channels/lark-bot.ts` 的 `messageText` 只取 `text` / `href`，图片节点被丢掉，Agent 收到的这一轮没有图。现在 `img` 写成 `![Image](img_…)`、`media` 写成 `[Media: file_…]`（和采集记录的写法一致）。
- 新函数 `attachmentNote`：消息带附件时在这一轮的文字和引用的消息后面附一行 message_id 与 file_key，Agent 用 `lark_message_file` 读；之前这一轮不带消息 id，只有回看历史时才找得到。

## 事项的流程页（11-18）

- 新页面 `web/src/views/ItemFlowPage.vue`（路由 `/items/:id/flow`）：等你的段（按钮、一句话、在对话里讨论）、背景、各段结果全文与插图、接下来、来源、流程记录。看板、今日页、飞书进度卡（`src/flows/store.ts` 的 `link`）指向它；`ItemFlow.vue` 加“打开流程页”。
- `flowView` 的阶段加 `result`（执行者最后写的全文，`stageResult`）。`flow-stage` 提问只回文字不点按钮：开始 / 判断关卡按文字开始，“做完了吗”按文字重做。
- `web/src/views/Ask.vue` 认 `?draft=&space=` 预填输入框。
- 跟着对象的段在 blocked 且等的不是本人时仍跟随对象（`advance` 里的 `following`）；编码交办段的任务说明改为发起或并进交办后直接结束。

## 别的事项的修改并进同一分支的交办（11-18）

- `message_code_run` 加 `item_id`：交办记到那个事项（`joinCodeWork`，`src/flows/objects.ts`，材料 `meta.joined`），`latestCodeWork` 认它，流程编码阶段跟着走。`delegate_code` 的同分支拒绝说明改为指向这条路、不问本人。续交办的工具改用 `codeSpace`，流程阶段的运行能续项目下仓库的交办。

## 技能分组的自动整理和分组树（11-18）

- 后台角色 `skill-organizer`（`roles/skill-organizer.md`，运行类型 `skill-organize`，`src/agents/jobs.ts`）：新收进来的、说明变了的技能，以及本人没分组的技能满 8 个时，放进分组和用途、必要时建组写说明，做完通知。要看的技能按 `skill-groups.json` 里的 `seen`（上次看到的说明）判断，`main.ts` 每分钟调 `scheduleSkillOrganize`（`src/agents/agent-skills.ts`）。`agentSkills.autoOrganize` 默认开。
- 本人（或主助手按本人的话）改的分组、用途、组说明记 `userSet`，整理角色的 `organize_skills` 跳过它们，也不能改开关。`POST /api/agent-skills/organize`（可带 `group` 重整一组）。
- 网页：技能列表上方的分组树 `web/src/components/SkillTree.vue`；分组页按用途分节、可折叠，去掉用途标签和每行的用途输入框，改为“移动”对话框（`web/src/lib/skill-move.ts`）；技能页顶上回到分组；Agent 页导航改为 `router.push`，后退可用。`/api/skills` 带 `purpose`。测试 `test/agent-skills.test.ts`。

## 本人放弃一个提问（11-18）

- `POST /api/asks/:id/dismiss`（`src/server/http.ts`）：本人的、还在等的、不是宿主决定卡片的提问按失效关闭（`lapseAsk`），飞书卡片随之变成已失效。`web/src/views/Home.vue` 的“等你回答”每条加“不用了”。测试 `test/ask-dismiss.test.ts`。

## 运行交的截图按附件压缩设置压（11-18）

- `src/core/media.ts` 加 `compressImageFile`：按 `media.auto` 的模式、质量、长边、最小体积压一张不在 `files/` 里的图片，小 10% 以上才给出压缩后的文件。
- `src/agents/artifacts.ts` 的 `collectInbox`、`attachPath` 收下后对图片调它，替换文件并更新 `run_artifacts` 的 entry、mime、size、sha。测试 `test/artifact-compress.test.ts`。

## 进度卡和事项页带阶段截图（11-18）

- 阶段运行报做完或卡住时，它交过的截图最近 4 张跟着进度卡走：`src/flows/store.ts` 收 `runImages`，`notify` 的 `images` 存在通知上，`src/channels/lark-bot.ts` 发卡前用 `item-notification.ts` 的 `cardImages` 上传（按机器人缓存）。这时说明保留分段、最长 1200 字。
- `flowView` 每段加 `shots`（`engine.ts` 的 `stageShots`，去掉已归到用例的），`ItemFlow.vue` 在“最近”下面列出。
- `roles/_common.md` 的“流程里的一个阶段”：看到的画面交成截图、不要只留在 `/tmp`；复现、定位类的 `note` 分段写现象、步骤、原因、要改什么。

## 流程的一段能交办到业务空间下的仓库（11-18）

- 流程阶段的运行只能写事项所在的业务空间，相关的仓库空间只能读，`delegate_code` 因此拒绝交办，缺陷流程的“修复”全部卡住。
- `src/agents/tools.ts` 加 `codeSpace`：要交办的仓库是本次可写的业务空间下的仓库时放行；别处的仓库照旧拒绝，往仓库空间写内容也照旧拒绝。测试 `test/delegate-scope.test.ts`。

## 浏览器长期资料和网页操作沉淀（11-18）

- 内置技能 `desktop-control` 带 `scripts/browser.mjs`：按名字开 Chrome，资料长期放在 `remote/profiles/<名>`（和“远程”页同一处），开着就复用；默认无界面；`--header` 按域名加请求头；每次启动生成一个小扩展，拦下页面打开本机程序的 `xxx://` 链接（Chrome 的“要打开 xdg-open 吗”原生弹窗还会挡住页面输入）。
- 技能新增“做通了就留下来”：动手前先找已有技能和脚本，做通的网页操作用 `save_skill` 存成技能和脚本，凭据只在运行时读。原来“不要改用脚本模拟”的说法改成只禁止用脚本绕过被拒绝的操作。
- 起因：复现缺陷的运行每次用新的临时资料，大页面冷加载几十秒，再从头一步步登录；复用资料后同一页面 6 秒。

## 重启打断的后台运行在原会话里接着做（11-18）

- 以前重启只把 running 的运行改回 queued，重新开始时开新会话、从头做，也不知道重启前发过什么，容易重发消息。
- `src/agents/runs.ts` 的 `markRestarted`（`startWorker` 里、改回 queued 之前）：给每个运行的 input 记 `restarted`（写入条数；12 小时内开始的 ACP 运行再记最后一个会话、它的 AI、目录和原来的 `ready`），并把那个会话在 `session_cleanup` 里设为 -1，免得启动时被当作临时会话删掉。
- `src/agents/runner.ts` 的 `takeRestart`：这次运行重新开始后的第一轮 `runAgent` 取走它（记 `used`），AI 和目录都相同就用 `resumeSessionId` 恢复；任务前加 `restartNote`（重启前的写入清单）。原来是临时会话的，这一轮结束后设回 `ready = 1` 交给清理。后台池（`reuseSession`）遇到要恢复的会话时不走池。
- `src/agents/session-cleanup.ts` 的 `releaseRetainedSessions`：运行没用上保留的会话就结束了，也把它还给清理。

## 卡片的 allowed 认 lark-cli 读到的 open_id（11-18）

- open_id 按应用区分：Agent 用 `lark_read` 列群成员拿到的是 lark-cli 那个应用的 id，写进 `lark_card` 的 `allowed` 后，被指定的人点按钮只看到“只有 ou_… 可以处理”，卡片开头也 @ 不到他。
- `src/agents/tools.ts` 的 `lark_card`：主机器人发卡时按 `lark_people` 把 `cli_open_id` 换成本机器人看到的 `bot_open_id` 再记录。
- `src/channels/lark-actions.ts` 的 `mayAct`：点击时操作人的 `bot_open_id` / `user_id` 经 `lark_people` 对应到的任一个 id 在 `allowed` 里都算，已经发出去的旧卡片也能点。
- 别人点了被拒时，提示里的处理人写成“姓名（邮箱）”（`personLabel`，按 `lark_people` 认任一个 id），超过三人写“等 N 人”；以前对 lark-cli 的 id 查不到名字，只显示 ou_…。
- `lark_card` 的说明写明 `allowed` 可以比 @ 的人多：给 `mentions` 时只 @ 这些人。

## 流程的进度卡只说发生了什么，阶段任务只带摘要（11-18）

- `src/flows/store.ts`：`changeStage` 只在助手或宿主让一段做完、跳过、卡住、待复核时记一行进度，流程走完时也记（`engine.ts` 的 `end`）；开始、关卡和本人自己的操作不发卡。卡片正文是这些行加一行“现在 · 在做 / 等你开始 / 卡住”，不再列全部阶段；去掉运行和提问编号，`waitText` 防止“等等本人”。
- `src/items/materials.ts` 的 `materialsBrief`、`src/items/requirements.ts` 的 `reqBrief` 加 `compact`：流程阶段的任务里说明截到 1500 字、材料最近 12 份、需求点只列标题，进行的地方最近 5 处（`engine.ts` 的 `placesBrief`）。一件做了很多轮的事以前给部署这类阶段带了约 40KB 的历史。
- `stage_report` 的说明要求 note、waiting_on 写给本人看，不带内部编号。
- 本人承担、以 Git 信号完成的阶段（推送）轮到时先跑一次 `checkGitSignals`，没推才问本人（`engine.ts` 的 `askOwnerNow`）；以前代码早就推了也会先发一张“轮到你：推送”。
- 阶段的运行先 `ask_user` 问了本人、接着报卡住等本人时，不再另发一张“卡住了”的进度卡（`store.ts`，按运行里还没答的提问判断）。
- 流程的提问卡片改成同一个版式（`engine.ts` 的 `askText`）：“事项 · 段”、要定什么，再按需要列结果、这一段做什么、前面各段的结果、确认后接着哪几段、依据数目。以前是一句话塞进全部说明，完成确认不写是哪件事。

## 接管 Agent 自带的技能，按分组给总入口（11-18）

- 新的 `src/agents/agent-skills.ts` 和 `skill-groups.ts`，设计见 `docs/v2/agent-skills.md`。打开 `agentSkills.takeOver`（默认关）后，定时扫描 `catalog.ts` 里各条目 `skills.read` 列出的目录（Codex：`$CODEX_HOME/skills`、`~/.agents/skills`；TraeX：`$TRAE_HOME/skills`、`~/.agents/skills`；Claude Code：`$CLAUDE_CONFIG_DIR/skills`），把里面的技能复制进 `library/_skills`。原件移进 `agent-skills/backup/<时间>/` 并写 manifest，链接只删除。技能按名称前缀归组，分组、用途和开关记在 `library/skill-groups.json`。
- 每个 Agent 只往一个目录（`skills.write`）写 omem 说明和每个启用分组的总入口，这些目录带 `.omem-managed` 标记。组大时按用途拆成 `purposes/NN.md`。
- 运行时的技能目录每组只占一行，停用的技能不列出。`read_skill` 可以读分组的总入口，`list_skills` 新增 `group` 参数。新工具 `organize_skills` 放在 `skills` 分组，设备和影子运行不能用。
- Agent 页的技能列表按组折叠，另有分组页和“Agent 自带的技能”面板。`GET /api/skills` 不再返回正文。新增命令 `omem skills`。

## 设置 → AI 能看 ACP 适配器版本并升级（11-18）

- 展开一个后端时，ACP 那一行下面显示 npm 适配器（codex-acp、claude-agent-acp……）的已装版本和公开源上的最新版，有新版时可以点“升级”，确认后升级。装法和远程命令 `agent-upgrade` 是同一套，都在 `src/agents/adapter.ts`：只升目录里那个已经装好的包，从 `osdk.toml` 的公开源装，装进命令实际所在的 npm 前缀，版本变了就重新检测模型。
- 检测到的模型里有的没有思考强度、别的模型有时，提示可能是适配器比这个模型旧（11-18 codex-acp 2.5.0 和 gpt-6.2-sol 就是这样）。
- 接口：`GET /api/agents/:id/adapter`、`POST /api/agents/:id/adapter/upgrade`，权限同设置。

## 远程升级 ACP 适配器从公开源装（11-18）

- `peer call <设备> agent-upgrade` 原来用那台机器自己的 npm 设置装 `@latest`，公司镜像落后时会装回旧版（codex-acp 停在 2.5.0，不认识 Codex 新的默认模型，Agent 页上这个模型没有思考强度）。现在带 `--registry` 用 `osdk.toml` 的 `[registries.npm]`（`src/core/peer-exec.ts` 的 `publicNpmRegistry`），和依赖安装一致。
- 换了源仍是旧版：npm 报告装成功了，但装进的是 omem 进程里 npm 自己的全局目录，命令实际找到的那份没动。现在装进命令所在的那个前缀（`peer-inspect.ts` 的 `adapterPrefix`，结果里返回 `prefix`）。另外可以给 `version`（如 `2.7.0`）装指定版本，这一次带 `--min-release-age=0` 和 `--before=<现在>`，不受发布时长下限限制；装完的版本不是要的版本时 `ok` 为 false。

## 会议里叫机器人：主助手来查、可设叫法和口头叫它、旁听时按会议性质主动查（11-18）

- 同一天前一版把会上提问交给访客角色。改为默认由主助手按本人的权限查（`answerBy: assistant`，运行沿用规则运行的禁用项，但不限于规则的空间，`lane = meeting-answer:<id>`），访客路径保留为 `answerBy: guest`。起运行前先由决策模型判断是不是在问它（“访客提问把关”打开且可用时），只是提到它的不起运行。
- 叫它的方式：机器人的名字，加规则里的 `answerNames`（如“助理”）；`answerSpoken` 打开时口头叫它也算。
- 主动查（`proactive`、`meetingKind`、`proactiveMax`）：旁听窗口按会议性质和新的内置技能 `skills/library/meeting-assist` 查会上提到的点，用新工具 `meeting_suggest`（`ROLE_TOOLS`，只在 `input.meeting.suggest` 的旁听运行里给）交给本人，卡片上可“发到会里”。这时旁听运行按本人的权限查。
- 规则页“拉机器人入会”加了“会上主动查”、会议性质、“也叫它”、“说话时叫它也算”、“谁来查”。设计在 `docs/v2/rules.md`“在会里回答和主动查”，测试 `test/meeting-rules.test.ts`。

## 会议里回答提问：按访客处理，先给本人看，有上限、能暂停（11-18）

- 会议规则的“在会中聊天里回答点名机器人的问题”原来交给本人的旁听档案，用 `meeting_send` 直接发到会里，读的是本人的范围。现在由 `src/channels/meeting-answers.ts` 接手：提问按访客处理（`askAsGuest`，门卫先判断，`guest` 角色只读会议所在空间和对访客开放的空间，答案截到 200 字以内），再按规则的控制项发出。旁听档案只对本人说，`meeting_send` 工具去掉了。
- 规则动作 `meeting-bot` 新增 `answerFrom`（all / owner）、`answerMode`（draft 默认 / auto）、`answerMax`（默认 5）、`answerSpoken`（默认关）。草稿发卡片到本人私聊（`card_interactions.purpose = meeting-answer`，“发到会里 / 不发 / 这场会不再回答”）；直接发时先回 `OneSecond` 表情，两次至少隔一分钟。本人在会中聊天发 `/ai 停`、`/ai 继续` 暂停和恢复。
- 状态记在 `lark_meetings.answers`（新列），每次发出写 `audit_events`（`lark.meeting-answer`），会后纪要或通知列出回答了什么、哪些没回答和原因。不再需要旁听档案才能回答。
- 规则页“拉机器人入会”动作里加了这几项设置。设计在 `docs/v2/rules.md`“在会中聊天里回答”，测试 `test/meeting-rules.test.ts`。飞书公开文档里没有机器人在会议里出声的接口（`vc/v1/bots/*` 在内测，只能发文字和表情），所以没有做语音。

## 知识库爬取：掉登录、断网时暂停，不再把整个队列记成失败（11-18）

- 爬取（`src/channels/lark-wiki.ts` 的 `crawlLoop`）原来只在“缺少飞书权限”时暂停。lark-cli 的本人登录掉了（token_missing）时，每篇都当成单独的失败移出队列，一夜把队列清空、标成完成，失败页面的子页面也没再列出来。现在掉登录、授权被拒、网络错误（`CRAWL_HALT`）和连续 10 篇失败都让爬取暂停，这一篇留在队列里，继续时接着读；暂停原因记在爬取的 `halted`，继续时清掉。
- 一篇读不了（没有这篇的权限）时仍列出它的子页面；列子页面失败单独记一次失败。
- 每晚读取（`src/channels/lark-knowledge.ts` 的 `readDaily`）遇到这类暂停时当晚停下，原因写进 `lark_kb_last_read` 的 `skipped`，不再让每个知识库各撞一次。

## 有人找你：分诊结果分行写、处理运行挂在下面、唤醒不再算成又找了你（11-18）

- 分诊结果（`src/mentions/triage.ts` 的 `triageSummary`）：第一行写决定，下面每行一个决策模型的回答（“做法：先查再告诉本人（把握 0.85）”“交给：主助手（把握 0.85）”），说明括号里是把握；不再在结尾贴处理运行的 id。
- 处理运行不是 mention 运行的子运行（不改 `parentId`，它以本人的身份跑，归属和工作区按自己算），运行详情接口把 `output.handleRun` / `joined` 一起列进“后续任务”（`src/server/http.ts`）。运行列表按完整 id 搜时也列出安静结束的运行（`runWhere`）。
- 每天次数到上限时，简短提醒和运行结果写清是哪一项、上限几次、在 设置 → 渠道 → 有人找你 改（提醒里是链接，`capNote`）。
- 继承来的触发（`src/core/run-trigger.ts`）带 `followUp: "wake" | "child"`：显示成“小李 · 接着「有人找你」的唤醒”；运行页“触发人”的次数只算本人亲自触发的，按人筛选仍能找到这些后续。之前存下的唤醒（有 `parentId` 且 `input.wake`）读出来时一样补上。

## 设置 → 连接：订阅的会话并进“飞书会话”一个列表（11-18）

- 原来的“订阅的会话”和“已采集过的会话”两个列表合成一个“飞书会话”（`web/src/components/LarkCapturedChats.vue`）：每行有订阅开关、采集到的空间和处理方式，元信息一行写类型、免打扰、参与过、最近消息；全部会话（`capturedChats` 去掉了 `limit 500`），显示总数，虚拟滚动，可按名称筛选或只看已订阅的，标题悬停看全名。“读取最近会话”只列还没采集过的。
- 订阅条目去掉了 `since`：最早那版采集留下的字段，后来读到哪里记在 `lark_cursors`，它一直是空的，所以订阅列表总显示“尚未采集”。
- 接口：`GET/PUT /api/lark/subscriptions` 换成 `PUT /api/lark/chats/:id/subscription`（`setSubscribed`）和 `/space`（`setChatSpace`：写会话自己的空间绑定，和 `/space` 命令同一处，订阅里的空间跟着改）。列表里的空间是 `captureSpace` 的结果，批量版 `ownerCaptureSpaces`（`src/core/capture-space.ts`）和单个的共用一条优先顺序；三千多个会话约 50ms。

## 远程画面可以单独打开和全屏（11-18）

- 远程页地址栏右边加了“单独打开”和“全屏操作”（`web/src/views/Remote.vue`）。单独打开是新路由 `#/remote/<会话>`（`web/src/main.ts` 的 `/remote/:id?`），`App.vue` 对它不画侧栏，只留对话框和提示；页面只有地址栏和画面，会话结束时给回远程页的链接。
- 全屏对地址栏和画面这一块调 `requestFullscreen`，Chromium 安全上下文里再 `navigator.keyboard.lock()`，Esc、Alt+Tab 送到远程，按住 Esc 退出。图标 `maximize` / `minimize` 加进 `web/src/lib/icons.ts`。

## 设置 → AI 按后端整理、网络条件的状态写清查到了什么（11-18）

- 设置 → AI → 通用（`web/src/views/Settings.vue`、新组件 `web/src/components/AiBackend.vue`）：已装的后端按账号（`source`）合并，ACP 和命令行成一行，可折叠。点开后有默认模型（两份配置一起改）、适合做什么、网络条件、用量（在用、整个账号和单个模型的上限、账号额度和本账号的阈值）。外面只留默认 AI 与档位、任务选型（开关、总体偏好、运行前自动选）、并行（总数和默认值）。
- 任务选型的候选（`agents.routing.candidates`）改为每个后端一条（不带模型）加可选的模型各一条，界面不再写 effort；旧的带 effort 的候选照常生效。模型那条的说明会带上后端那条（`src/agents/choose-ai.ts` 的 `candidateWhen`，助手环境说明 `runner.ts` 的 `routingGuide` 同样）；排顺序时先找模型那条。
- 账号额度的阈值可以按账号另设：`agents.capacity.quotaBySource.<source>.avoidAbove / perDayBelow`，没设的用 `quotaAvoidAbove / quotaPerDayBelow`（`src/agents/quota.ts` 的 `quotaAvoid`）。
- 网络条件（`web/src/components/AiNetworkConditions.vue`、`web/src/lib/network-status.ts`）：放进各后端里，状态由一个共享的轮询维护；新加的默认勾上这个账号的几个后端。IPv6、DNS 的原因和提示改成写清查到了什么（`src/agents/network-diagnostics.ts`），去掉每次都附的“这是配置检查，不能证明……”和“DNS 不返回 AAAA 不能证明……”两条，DNS 没问题时显示“没发现问题”。
- 设置页右侧目录（`buildToc`）也认 `.section-title` 做卡片标题，以前只认 `<strong>`，所以 AI 页只列出三项。
- 数据页（`web/src/views/Insights.vue`）的导出从标题旁挪到筛选右边，点开选 Markdown 或 CSV。空间卡片里仓库行的设置按钮不再被长名字挤窄，和空间的设置按钮对齐。

## 成员在本人空间的群里也能问、附件跟着回复走、要审批的人不在群里就拉进来、仓库可以不再问提交（11-17）

- 成员的一轮在哪个空间跑（`src/core/users.ts` 的 `turnSpaceFor`，`agents/inbox.ts` 建运行、`agents/sessions.ts` 的 `prepareRun`）：会话所在的空间他读不了（新群没有绑定空间，按本人的采集设置落在 `personal`）时，这一轮改在他自己的个人空间跑，会话不动。能读什么本来就由工具按他的空间逐个校验，会话的空间只决定这一轮写到哪里，不再让 `runner.ts` 整轮拒绝。
- `lark_send_file` 等的 `reply_to` 说明（`agents/tools.ts` 的 `larkTarget`，`skills/omem/references/lark.md` 的“附件”）：给这一轮的提问发附件不填 `chat_id`、`reply_to`，和回复落在同一处；之前助手把附件回到最早那条提问下面开了话题，提问的人在回复处看不到。
- @ 的人不在群里（`larkPost` 的回执）：本人的运行里提示用 `lark_invite` 把要参与的人（审批人、要确认的人）拉进来，本人批准后再发；以前写“无需重试”，规则里审批卡片因值班人不在群就停了。说明页“拉人进群”同步。
- 飞书登录申请的权限（`src/auth/lark.ts` 的 `optionalIdentityScopes` / `grantedScopes`，`auth/http.ts` 的 `/api/auth/:provider/start`）：`contact:user.employee:readonly`（读 `enterprise_email`）改成应用开通了才申请；有的租户后台没有这个权限，一申请授权页就报“缺少权限”拒绝整个登录。`contact:user.email:readonly` 仍每次申请。
- 飞书网页应用 `/lark/` 免登失败时（`web/src/lark/LarkApp.vue`）：`requestAccess` 被拒（不只是 errno 103）也退回 `requestAuthCode` 再试；都失败时页面写出两边的 errno 和说明，并列出开发者后台要核对的项（网页应用能力、主页 `<网页地址>/lark/`、安全设置的“重定向 URL”加 `<网页地址>/lark/`——飞书的免登文档要求，设置页原先只写了 H5 可信域名——、发版，IP 或 http 地址可能不被接受）。以前只显示飞书原话“please check errno”。两个端内接口都失败时（内网 `http://IP` 地址实测 errno 2700002 / 2602002）自动改走普通的飞书授权页登录一次（`/api/auth/lark/start?purpose=login&return=<视图>`），回到 `/lark/` 的同一视图（`auth/http.ts` 的 `back` 认 `/lark/#/` 开头的返回地址；起初回到主站，主站开着实时连接 `/api/events`，侧边栏里多一个常连的页面）；三分钟内再失败才显示原因。
- 运行中的补充（`agents/steer.ts` 的 `mayJoinTurn`，`inbox.ts` 排队合并同样用它）：以前只并同一发送人的消息，群里同事那一轮在跑时本人 @ 补充会另起一轮、等它跑完。现在发消息的人能看到的空间不少于这一轮的人（本人总是）就并进去，这一轮仍按原来那人的权限，补充提示里写明；看得更少的人和不是用户的同事（`asker`、盯群的 `speaker`）仍另起一轮，免得借别人的权限读到自己看不到的。
- 运行页筛选区（`web/src/views/Runs.vue`）：“所有人”“所有方式”两个下拉挪到单独一整行。之前两个下拉挤在网格右列，把右列撑到二百多像素，左列的“编码/全部运行”“当前空间/所有空间”被压到出滚动条，“交办”按钮被拉宽。
- 卡片里的 @（`channels/lark-people.ts` 的 `applyCardMentions`，`larkPost` 的 `mentions` 和审批卡片 `allowed` 两处）：卡片正文已经写了 `@名字` 的就把那处换成真正的 @，只有没写到的人才在顶上加一行；以前卡片顶上一个真 @、正文里再一个 `@名字`，同一个人出现两次。文字和 Markdown 消息本来就是这样。
- 提交认领（`src/flows/commits.ts`）：卡片多一项“这个仓库以后不用问”，选了就把仓库空间的 `commitClaim` 设为 false，巡检跳过这个仓库；设置 → 空间里能勾回来（`web/src/views/Settings.vue`）。

## 飞书结果没送达时重发答案、气泡等待与 TLS 故障识别（11-17）

- 飞书对话（`src/channels/lark-bot.ts`）：AI 已经完成后，结果发送失败不再显示成“没有完成”。复用已保存的会话答案进入原有持久投递队列（`agents/inbox.ts` 的 `retryChannelReply`），恢复后更新原进度卡；没有进度卡时保留原回复位置和同一 UUID，避免后续消息改变投递位置，不再运行 AI。
- 进度与错误卡（`lark-progress.ts`）带运行 ID；投递失败写“结果暂未送达”。气泡首次请求仍在等待时不因满 15 秒就宣称不可用，只在 `lark-cot.ts` 明确失败后退回进度卡。
- AI 后端本身报 TLS 建连前断开时（`runner.ts` 的 `isTransientUpstream`）认作瞬时故障，角色和对话共用已有接手与冷却逻辑；证书过期不在这个分类里。飞书投递出错仍只重发答案。
- 回归：`test/lark-bots.test.ts`、`test/lark-progress.test.ts`、`test/choose-ai.test.ts`，假飞书客户端与真实 ACP 假后端子进程。

## 加过的同事第一次找机器人就认出来、机器人自己读群里前面的消息（11-17）

- 同一个人在两个飞书应用里的记录（`lark_people`）：`rememberPerson` 把一个事实能连上的几行合成一行（lark-cli 那行有邮箱，机器人那行有 open_id 和 user_id），id 互相矛盾的不合。以前只更新第一条匹配的行，合并时撞上 `bot_open_id` 唯一约束被吞掉，机器人那行一直没有邮箱。
- 预建账号认领机器人身份（`src/channels/lark-identity.ts` 的 `claimLarkSender`）：本人按邮箱或名字建的账号，在这个人第一次 @ 机器人或私聊它时对应上：通讯录邮箱相同；或账号邮箱经 `batchGetId` 得到的 user_id 和发送人的相同（机器人没有读邮箱权限也行）；或账号没邮箱、只有一个同名账号。对应后写 `audit_events`（`lark.identity.claim`）、通知本人；没对应上的人在账号没变时不再查。`add_users` 给已有账号也补上机器人的 open_id。只在主机器人上做，其他机器人仍按 user_id 认人。
- 上下文（`lark-bots.ts` 的 `contextLines`）：话题里的提问不再只看这个话题，带上话题第一条、最近几条和群里最近的消息；只有设成话题单独对话（`isolatedTopic`）的才只看话题。话题开头没有记录时（机器人后进群、本人不在群里），机器人先读这个话题（`lark-bot-history.ts`）。
- 新工具 `lark_chat_history`（`lark-msg` 组，访客回答也有）：以机器人身份往前读本次会话所在的群或话题，读到的记进这个群的原件并返回行号，可以引用。访客回答只能读被问的群；本人的运行可以指定别的群。外部 Agent 没有。
- 把关（`roles/gatekeeper.md`、决策模型的选项）：“看下群里的问题”“看下这个 cc”算要回答，不再因为看不到问题就不理；`roles/guest.md`：先读前面的消息再答，读不到才请对方转发。

## 做完的提交不再问要不要新建事项（11-17）

- 提交认领（`roles/commit-claim.md`）：对不上进行中的事项、提交本身已经做完一件事的（一次完整修复），角色用 `stay_quiet`，不再建议新建；只有明显还要接着做的才建议新建，并在 `claim_commits` 里填 `ongoing: true`。理由只写这一条为什么对得上，不写排除其他事项的推理（理由原样出现在卡片上）。
- 宿主兜底（`src/flows/commits.ts`）：没标 `ongoing` 的新建建议，选项写“记一件已完成的事”，本人确认后事项直接记为已完成；标了的才是“新建一件事（还没做完）”，留为待办。

## 别人的事不进本人的事项、Wiki 等上线再写、问题表单直接发到飞书（11-17）

- `upsert_item` 新建前的宿主检查（`tools.ts` 的 `notOwnersBusiness`）：回答群里同事的那一轮（触发人不是本人）不建事项；整理（ingest）时来源全是本人不在的群（`lark-guest.ts` 的 `ownerInChatKnown`，读不到成员列表时不拦）也不建。整理的任务里会写出本人不在哪些群。角色：别人 @ 机器人让它做的事是机器人的，不建事项、不接着查（`roles/ingest.md`），替同事做的事用工作文件和唤醒跟进（`roles/assistant.md`）。
- 还在开发、没上线的需求（方案、需求分支代码、测试泳道配置、复测进度）不写 Wiki，挂在事项上，上线或结束后按最终实现写；这类进度问题不作为页面的待确认问题（`roles/ingest.md`、`roles/distiller.md`、内置技能 wiki-writing 第 4、8 条）。
- Wiki 写完要本人定的问题：表单不再等“对话回复”（生成没有回复，表单一直没发出去），直接发成飞书表单卡片，写完的报告只在网页；免打扰之后补发时，带表单（`#/ui/`）的通知单独发卡片，不并进“夜里的 N 条通知”。
- 有人找你：本人在同一分钟里回了（采集只记到分钟）也算已处理，按记录里的先后判断（`notify-gate.ts` 的 `ownerRepliedAfter`）。

## 运行按人和方式筛选、助手登记用户（11-17）

- 运行页“触发人”一个人只有一项：`core/run-trigger.ts` 的 `triggerers` 按名字合并（同一个人经机器人和 lark-cli 两个应用来，open_id 不同），返回各方式的次数；`listRuns` 的 `by=name:<名字>` 按名字筛，新加 `via` 按方式筛（`chat` 找助手、`mention` 有人找你……），页面多一个“触发方式”下拉。群里同事经主助手问的那一轮，触发人记成他在机器人应用里的 open_id（消息 meta 的 `askerId`）。
- 工具 `add_users`（`curate` 组）：本人 @ 几个人让助手加成用户时，按群成员认出人、记飞书身份和邮箱（`contact.user.get`，读不到就只靠飞书登录），按话里说的空间加成员；已是用户的只补权限；只认本人的消息。

## 机器人身份改文档、lark-cli 掉登录后重新授权、网络条件不误停（11-17）

- `lark_doc_fetch` / `lark_doc_update` 加 `identity: "bot"`：用 omem 自己的机器人（`lark.appId` 和密钥，lark-cli 的 `--as bot`，`src/channels/lark-cli.ts` 的 `larkCliAsBot`）读写，不用本人的权限和批准，不做整篇覆盖。机器人没有权限、又是群里同事的请求时（消息 meta 的 `askerId`），工具给出授权链接（`src/auth/grants.ts`：`/api/auth/lark/grant/<票据>`，半小时有效，只有那个人能完成，只要 `docs:permission.member:create` 和后台刷新），同意后令牌按 `lark:<open_id>` 存进连接（和成员的连接一样续期），宿主用它 `drive +member-add --member-type appid` 把机器人加为那篇的可编辑协作者再重试（`tools.ts` 的 `botForRequester`）。本人没权限时工具提示改用机器人（`ownerDenied`）。
- 飞书文档里不放 omem 的引用：`src:` 等能对到飞书文档、飞书消息或网页的换成原链接，其余只留文字，`[[页面]]` 留标题，不用会过期的分享（`tools.ts` 的 `docCitations`）；知识库名读不到时用 `wiki_spaces` 里的名字，不再显示数字 id；工具结果里以 `（给 Agent）` 开头的行不进本人看到的批准结果（`asks.ts` 的 `forOwner`）。
- lark-cli 报本人登录没了（token_missing）时，`lark-auth.ts` 的 `watchOwnerLogin` 发一次完整登录的链接（和 setup 相同的 `--domain`），本人确认后用 `--device-code` 保存；免打扰时段不发（十分钟的链接等到早上就过期了）。只有采集失败时 6 小时内不重复发；工具调用（`larkActor` 里有人，规则处理报警、助手）用到时，离上一条半小时就重发，不让一条没赶上确认的链接拖住报警规则六小时。`onOwnerLoginMissing` 的回调返回实际做了什么，`larkCli` 抛给 Agent 的错误写明链接是否已发、几点前有效或几点后重发，不再一律说“已请本人重新授权”。主助手角色说明：不要自己在命令行里跑 `lark-cli auth login`。
- 网络条件（`network-policy.ts`）：接口指纹只看所监控的接口（没指定时看实体网卡的 IPv4），容器网卡和 IPv6 临时地址不再让运行停下；代理端口无响应（2 秒）和出口检测没回应要连续两次才停，拒绝连接、地区或 IP 不符仍立即停；改条件只重新检查、不中止运行；运行前只等没检查过或已过期的条件（`refreshForRun`，最多 4 秒），失败的在后台重试。设置页：并排字段对齐、未检查不再显示成警告色、连接错误写成中文。
- 飞书文档读不到的通知按原因分组，每篇一行链接，不再每篇后面跟同一段英文报错（`lark-docs.ts` 的 `unreadableReason`）。

## 换 AI 后没了下文、同事的口径、气泡断连、@ 别的机器人、http 地址的网页版 VS Code（11-17）

- 对话这一轮调 `switch_run_ai` 给自己换 AI 时，接替的运行排在同一会话、带着同样的消息；工具调用结束时 `steer.ts` 把它当补充消息并进了正在停下的旧运行并取消，旧运行随后也停，两边都没有回答。现在被要求停下（`runs.ts` 的 `stopRequested`）或输出里已有 `replacedBy` 的运行不再收补充消息，规则的同批触发同理。`test/steer.test.ts`。
- `sessions.ts`：网络条件的尝试信号里也带着运行自己的停止，停一轮（/stop、接管、换 AI）时会把热着的 ACP 进程一起关掉；只在网络条件叫停时才关。
- 群里机器人自己采集的那一行原样存了事件里的 `@_user_1` 占位，下一轮的群上下文看不出本人把问题转给了谁。`lark-bot.ts` 的 `captureGroup` 存成 `@名字`。`roles/assistant.md` 加了一条：标着“群里的同事”的消息，他自己的需求和口径他说了算，不再出卡片问本人；以本人身份写文档、发消息时宿主自己会请本人批准。
- 思考气泡（`lark-cot.ts`）：已经在显示的气泡遇到连接被重置、拒绝、解析失败（`ECONNRESET` 等）时同一批重发两次，不再一次断连就撤回、换成“处理中”卡片。
- `lark_send`：Markdown 里 @ 了别的应用的机器人（群成员列表没有、从近期提及核实的，`resolveMention` 带 `bot`）时改发富文本 post（`lark-send.ts` 的 `{ post }`），开头是真正的 @；卡片里的 @ 机器人收不到，只显示一串 id。`realMentions` 遇到 omem 自己机器人的名字原样保留，不再把“@某某的助理”拆成 @某某。
- 网页版 VS Code 用内网 IP 的 http 地址打开：非安全上下文没有 `crypto.subtle`，VS Code 解不开签名模块 vsda。`ide-web.ts` 在页面配置后插 `/ide/__omem/plain-context.js`（只在非安全上下文生效：置空 `serverLicense`，把 `vsda_bg.wasm` 的请求换到 `/ide/__omem/vsda.wasm`），vsda 由服务端解密（`decryptVsda`）。webview 仍要 HTTPS 或 localhost。
- 重启后待投递的渠道回复（`inbox.ts`）：会话已不在的直接出队；记下入队时间，一天内渠道一直不收（没有发送方的会话、一直失败）的出队，回复留在会话记录里。

## 临时会话、评审复看与旧对话补归档（11-17）

- `src/agents/acp.ts` 按实际恢复结果决定是否保留会话；恢复失败后新建的临时会话不再因请求里有旧 ID 而漏归档。`session-cleanup.ts` 的持久登记也核对实际 ID。
- 定时回收覆盖“有人找你”到期的跟进会话、已应用或丢弃交办的独立评审与复看，以及重启前被替换但未退役的旧对话。跟进窗口与分诊共用 `src/mentions/channel.ts` 的 30 分钟常量；排队续轮、待唤醒、当前对话、归档后可恢复的对话和活跃轮次仍保留。
- `test/session-cleanup-lifecycle.test.ts` 用真实 ACP 假后端子进程验证归档、恢复失败、续聊保护和重新打开数据目录后的补回收。修复只恢复已有清理预期，不新增用户设置。

## 同目标 IPv6 出口与 DNS 配置诊断（11-17）

- 网络条件增加可选的 `ipv6` / `dns` 设置。同一检测 URL 用真实 AAAA 访问，保留 Host、SNI 和证书校验；已观察到的出口违反允许列表才限制，IPv6 未确认或地区未知不因此阻止执行。DNS 配置风险只提示，不作为运行闸门。
- `network-request.ts` 使用 Node 原生 HTTP(S) / TLS，支持 IPv6 地址覆盖和代理 CONNECT，不依赖 curl。TUN 先用系统解析，必要时用可配置的 Google / Cloudflare DoH JSON；指定代理时经代理做公网目标的 DoH 查询。AAAA 按 TTL 有界缓存、并发合并，429 遵守 Retry-After 并切换服务，不因本地两秒轮询增加公网 DNS 查询。
- `network-diagnostics.ts` 读取系统接口 DNS（Linux / macOS / Windows 固定只读命令，失败退回 Node 默认解析器）与可选 Mihomo 生效配置的安全字段；文件和默认解析器变化作废检查。明确区分配置风险与实际 DNS 泄露，未知不停止已有执行。测试见 `test/network-policy.test.ts` 和 `test/network-diagnostics.test.ts`，包括真实 TLS / IPv6 / CONNECT / DoH 服务与证书域名不匹配。

## 渠道对话重启后交回结果；VS Code 的 HTTP 地址限制（11-16）

- 服务重启会恢复排队和执行中的对话，但原渠道等待最终结果的回调已不存在。`runs.ts` 为恢复的渠道对话标记 `recoverReply`，`jobs.ts` 让它们自行交回结果；`inbox.ts` 在发送前保存待投递记录，渠道尚未连接或发送失败时保留并重试，重试复用会话消息，并发检查互相让开。网页和 CLI 对话不外发；过程里发过截图不视为最终结论已交回。测试见 `test/channel-recovery.test.ts`。
- `acp.ts` 两处标准输出改用 `Readable.toWeb`，由 Node 处理读取取消与迟到数据的生命周期；不再向已关闭的 `ReadableStream` 控制器 enqueue，避免因此崩溃重启。`test/acp-cleanup.test.ts` 以 SDK 取消超长消息后仍有 stdout 到达复现：旧适配器以 `Controller is already closed` 退出，新适配器正常收尾。
- 真机对照确认：新版 VS Code 在 HTTP 内网 IP 下缺少 `crypto.subtle`，第一次令牌校验通过，第二次握手签名失败并报 `Unauthorized client refused`；localhost 完成连接。此前的本人登录鉴权仍有效。远程使用 HTTPS 或 `omem peer open` 的 localhost 地址，说明同步到 README、`docs/v2/ide.md` 和文档站。

## 豆包 CLI 模型名按检测结果匹配（11-16）

- `src/agents/dispatch.ts` 在启动豆包 CLI 前，用已有的 `resolveModelOption` 将最终选中的模型匹配到检测列表中的原名，覆盖档案默认、角色覆盖和自动选型；空格、连字符或大小写差异不再造成 `Unsupported --model value`。刷新模型只更新检测结果，执行时也必须使用它；不改写档案，无法匹配时仍报 CLI 的原始错误。
- `test/doubao-cli.test.ts` 覆盖新会话、续聊、保留强度、不改写档案及没有检测结果或未知名称的报错。真实 CLI 用不存在的会话做参数验证：旧拼法在模型校验被拒绝，匹配后的名称通过校验并到达会话查找，未新建对话。

## 后端网络条件与 TUN 异常接手（11-16）

- `agents.networkPolicies` 按后端 ID 绑定网络条件，支持系统路由或指定 HTTP(S) 代理、接口监控、Trace / JSON 格式的出口探测、地区与固定 IP 允许列表。成功默认缓存一小时，并发探测合并；配置、网络接口或地址变化作废旧结果，过期和故障期间不允许新执行，旧响应不能恢复失效状态。没有绑定的后端不受影响。
- `src/agents/network-policy.ts` 每两秒检查本地接口和代理端口；默认网络异常取消当前后端尝试，沿用任务的兜底策略，区别于用户取消整个任务。ACP、命令行、复用后台会话、对话、模型探测、额度读取与借出 ACP 入口接入检查；受限进程启动时统一代理环境变量，系统路由模式清除继承的通用代理设置。恢复连续确认两次，短暂恢复探测后按需检查；没有可用兜底时保留工作并说明失败。会话清理在网络不可用时延后，运行时注入的代理变量不改变清理账本中的后端身份。
- 设置 → AI → 通用 新增“网络条件”表单及当前状态；后端和模型选择处显示网络受限原因。配置与检查接口只给本人；远程后端由执行设备约束。示例截图使用虚构出口、网卡和运行，不展示本机信息。测试入口 `test/network-policy.test.ts`，结合本地 HTTP 与假 ACP 检查缓存、失效、手动指定、停止和接手；真实 TUN 路由及进程树行为仍需本人在部署环境验收。

## 原件按地址查找走索引；数据页的流程板块和有改动的发现（11-16）

- 原件表加 `sources_uri` 索引（`src/core/db.ts` 最后一条迁移）。群名、工作近况、引用、找人、有人找你这些地方只按地址（`lark:<群>`、链接）找原件，原来每次都扫整张原件表：常驻那台的备份库上一次热缓存约 250 ms、冷读 11 秒。`scripts/bench-scale.ts --source-uri` 用 10 万份 4KB 的原件比：200 次查找 9320.4 → 4 ms；`test/query-plans.test.ts` 检查这几种写法都走索引。升级时建索引要扫一遍原件表，只在第一次启动时花一点时间。
- 数据页加“流程”板块（`flowsSection`，在编码交付之后，没有流程时不出现）：每份流程定义一张按阶段的表，期间里平均每件在做 / 等你 / 卡住的小时数和返工次数，上面是走完、中途停下的事项数和等你的时间合计。每件事用流程回顾的 `reviewStages` 算（分钟裁到期间，返工只数期间里的），设计在 `docs/v2/flows.md` 10.7。
- 数据页“课题”板块在发现下面多三项：有改动的、改后重跑通过的、改后重跑仍然失败的（`src/insights/insights.ts` 的 `studySection`）。重跑结果的判定从 `findingFix` 抽成 `fixVerified`（`src/studies/fix.ts`），课题视图和数据页共用。测试 `test/insights.test.ts`。

## 插件的界面插槽、plugin link、从源码构建安装（11-16）

- 设计在 `docs/v2/flows.md` 第 8 节，写法在 `docs/v2/plugins.md` 的“放在 omem 页面上：插槽”“从源码构建”“开发中的插件”。
- 插槽：`api.slot(at, { block, when })`，位置 `item.panel` / `flow.stage` / `today`，`when` 的 `object`（本插件的对象类型）、`stage`、`flow`、`space`。放进去的块是 `display: true` 并带 `load(ctx, slot)` 和 `view(data)`；声明时检查位置、块、条件和对象类型，错了插件代码加载失败（`src/plugins/slots.ts` 的 `checkSlot`，`registry.ts` 的 `api.slot`，`LoadedPlugin.slots` 随代码卸下清空）。接口 `GET /api/slots`（这一页要画哪些块）和 `GET /api/slots/:plugin/:block`（一块的内容：核对事项可读、条件、对象挂在事项上，按看的人和事项空间构造 `PluginContext`，15 秒，schema 和展示组件两次校验，`page` 不收；插件出错 502），在 `src/auth/routes.ts` 登记为 `self`。隔离运行的 `api.slot` 报不支持（`sandbox-runner.ts`）。
- 网页：`web/src/components/PluginSlots.vue`（列出）和 `PluginSlot.vue`（逐块取数，用 `UiView` 画，`onErrorCaptured` 只让这一块报错）放在事项页侧栏的外部状态下面（`views/Items.vue`）、流程选中阶段的说明下面（`ItemFlow.vue`）和今日页右栏最上面（`views/Home.vue`）；没有插槽时什么都不显示。设置 → 插件的卡片写“放在页面上”。
- `omem plugin link <目录>` / `unlink <id>`（`src/plugins/links.ts`、`src/cli-main.ts`）：链接清单在本机 `<数据目录>/plugins/.links.json`，不随拉取；只能命令行链接本机目录（拒绝网络路径），和内置、`plugins/` 里已有的同 id 拒绝。`loadPlugins` 不带参数时最后加载链接的插件（`LoadedPlugin.linked`）；信任记目录（`trust.ts` 的 `dir`），改代码不用重新确认；服务里 `watchLinkedPlugins`（`main.ts` 启动）盯目录和链接清单，改了 0.3 秒后 `reloadLinked`，忽略 `web/`、`node_modules/`、`.git/`，发 `plugin` 事件。`plugin remove`、`DELETE /api/plugins/:id` 对链接的插件只去掉链接；安装同 id 拒绝。设置页标“开发中”，有“去掉链接”。
- 源码构建（`src/plugins/install.ts`）：`buildPlan` 在有 `build` 脚本、清单的 `server` 或服务脚本还不存在时给出命令（装依赖 `npm ci` / `npm install` 都带 `--ignore-scripts`，再 `npm run build`）和包脚本原文；没带确认过的 `key` 时抛 `BuildNeeded`，什么都不运行。命令行用终端确认，`POST /api/plugins/install` 和 `/update` 先返回 `{ build }`，设置页弹窗确认后带 `build: key` 再请求。确认后在解开的临时目录里逐条 `spawn`（去掉密钥类和 `OMEM_` 环境变量，共十分钟，超时连子进程停掉），输出写 `<数据目录>/logs/plugin-builds/<id>.log`。清单新增可选的 `server`（服务端文件的相对路径），`registry.ts` 的 `serverFile` 统一找服务端文件。
- SDK：`packages/plugin-sdk/slots.ts`（不带 import 的类型），`client.ts` 导出 `PluginSlot*`，`PluginSlotView` / `PluginSlotBlock` 带上展示组件和上下文类型。测试 `test/plugin-slots.test.ts`、`test/plugin-dev.test.ts`。

## 流程回顾和 coach 的建议、重开时正在做的下游、只跟一份（11-16）

- 回顾：流程结束（走完、本人停止、事项关闭）时宿主按阶段日志算一份回顾存进 `item_flow_reviews`（随事项拉取），事项页显示“这一次走得怎样”。计算是纯函数 `reviewStages`（`src/flows/review.ts`），每段的 doing / gated / blocked / 等本人分钟、卡住的原因、开始次数、重开 / 拒绝 / 待复核 / 升档、跳过、关卡的问与答；口径写在 `docs/v2/flows.md` 文末。`item_stage_log` 加 `waiting_on`、`event` 两列，`changeStage` 多一个可选的 `event` 参数，旧行由 `inferEvent` 推断。
- 事项关闭现在会结束任何流程（以前只有课题流程）。
- coach：同一份定义本人的事项又结束满 3 件就起一次 `flow-review` 运行（失败的下次结束再算进来，不新增定时任务），任务给定义原文和几份回顾，禁用写记忆和档案建议的工具，只能 `save_flow` 出草稿或 `stay_quiet`。`roles/coach.md` 加“读流程回顾”；新工具 `read_flow_reviews` 在 flow 分组。
- 重开时正在做的下游：照做，给本人一张“停下 / 继续做”的卡片（`control.upstream`，flow-stage 回答 `kind: upstream`）；停下按阶段类型取消（交办用 `stopCodeWork` 只停不删）并待复核，没答就做完的也待复核；流程结束、新一轮、本人在那一段上动作时撤回。事项页有同样两个按钮。
- 上下文跟进：同一个群或文档在两个空间各有一份时只跟一份（事项所在空间的，否则本人可写、最早建立的）；群消息按这一份自己的行号读（`lark_message_lines`）。测试 `test/flow-review.test.ts`。

## 课题的试验可以派给本人的另一台设备（11-16）

- 执行环境（`studies.envs`）加 `peer`：选了这个环境的试验交给那台设备，由它用自己的模型、在自己宿主管理的工作区里跑，结果和证据文件送回本机的台账。保存设置时校验设备已配对、不是别人的服务（`src/studies/envs.ts` 的 `checkEnvPeers`）；设置里环境多一个“派给设备”（`web/src/components/FlowSettings.vue`）。
- 本机（`src/studies/remote.ts`）：试验阶段轮到这样的试验时不选模型，`POST /api/peer/trial` 发出试验、方向、环境、每个仓库规范化后的远端地址和基线提交、档案 / 技能 / 档位名、分钟上限，拿回那台的运行 id；之后在试验阶段已有的推进里 `GET /api/peer/trial/:id` 问结果，不新增定时。回来的结果记一条已结束的 `study-trial` 运行收下证据。派不出去、那台出错或失联超过一小时，同一个试验再派一次，之后记“跑不了”；那台明确拒绝的不重试。停止流程、重开、预算用完等时 `POST …/cancel`。
- 那台（`src/studies/remote-host.ts`）：只认本人令牌；按 `remoteKey` 找自己的仓库空间，没有就 409 “<设备>上没有这个仓库”；新运行类型 `peer-trial`，缺基线提交时 fetch 一次，用和本机试验同一个 `checkoutManaged` 准备工作区，跑完归还；派来的运行里 `trial_report` 只收文件证据。带回的证据单个 2 MB、合计 8 MB，文本超了截断。
- 表 `study_trials` 加 `peer`、`peer_run`、`peer_seen`（后者本机状态，不拉取）；课题视图的试验加 `peer`、`peerRunId`。`src/studies/trials.ts` 的任务文字抽成 `trialTask` 两边共用，`workspace.ts` 抽出 `checkoutManaged` / `releaseManaged`。
- 文档：`docs/v2/studies.md` 文末“第四期：把试验派给另一台设备”，`docs/v2/mesh.md` 第 4.5 节。测试 `test/study-remote.test.ts`（同一进程两个 app，那台起真实 HTTP 服务）。真实两台设备没验。

## 插件对象的动作、对象状态变化规则、场景包里的流程（11-16）

- 对象类型可以声明 `actions`（插件自己的工具，按状态限定），事项页“外部状态”卡上出按钮。本人点了确认一次后直接执行、不出审批卡片（`POST /api/items/:id/objects/:object/actions/:action`，self）；Agent 调同一个工具走审批档位，第一次见到时放进“每次问”。每次执行写 `audit_events`（`object.action`）并马上重读对象状态。入口 `src/flows/object-actions.ts`，工具包装在 `src/plugins/objects.ts` 的 `withObjectActions`（进程内和隔离两条路都包）。动作工具在新分组 `object-actions`，主助手有它。
- 对象材料给 Agent 的一行加了字段、可做的动作（工具名和参数）和 `object:<id>`；`stage_report` 的依据认 `object:<id>`。
- GitHub 平台包：合并请求的“合并”动作（只在 open 时），工具 `github_merge_pull_request`，平台包多一项“合并 PR”（`repo` 权限）。
- 规则多一种触发 `object`（`trigger.objectKind`、`trigger.objectStatuses`，字段 `object.*`）：对象状态变化时在信号和推进之后交给规则，只带本人能读的空间里的关联事项；规则页可配，`GET /api/rule-options` 多 `objectKinds`。见 `docs/v2/rules.md`“对象状态变化规则”。
- 场景包清单多 `flows`（`flows/<id>.yaml`）：启用时只补没有的、删掉的不加回来，包内档案名加前缀；对象类型还没有时先不加，任何插件启用或被信任时再试（流程和规则都是）。插件加载改成先跑完所有代码、再补各插件带来的东西。打包可以带流程（`--flows`）。
- 例子 `examples/plugins/ghdelivery`：GitHub 需求交付流程、三个技能、一条“合并请求被关掉”规则。测试 `test/object-actions.test.ts`；详细记录在 `docs/v2/flows.md` 文末“第三期：对象的动作、规则事件和场景包里的流程”。


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
