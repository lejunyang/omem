---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-20
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 关注从历史学（11-20 夜）

- `learnFromHistory`（`src/channels/listen-coach.ts`）和 `POST /api/listen/:id/learn {chats, days}`：给定群里本人最近 N 天的回答记成关注的案例（引用的那条，或两小时内别人最近的一句），去重，够 5 条排 listen-coach。用于新建值班关注时拿已经结了的工单群先学一版经验。测试在 `test/listen.test.ts`。

## 工作线（二）：每条线的现状和下一步、每晚提议、工作页接口（11-20 夜）

- 原来的“主动推进”改成看一条线的现状（`src/channels/listen-assist.ts`）：只看顶层事项的关注，任务带线和下面各项、`lineTimeline`、上次的现状、本人说“不用”的下一步；运行用角色工具 `submit_line_state` 交 `now`（存进 `items.now`）和最多三条下一步（表 `item_next`，旧的没开始的变 `expired`），不再 notify、不再写 `推进.md`。`POST /api/work/:id/refresh` 马上看一次。
- 每天一张下一步卡片（`src/items/lines.ts` 的 `lineNextDue`，心跳里，`notify.laterTimes` 最早的时间或 10:00）：各条线一起，每条“就这么做 / 不用”（处理器 `line-next`）。就这么做起一轮 `agent`（lane `line-next:<线>`，不能发消息、拉人、建规则，不是 code 的不能交办编码），结束后标 done、结论进线的关注会话；不用记下，下次看这条线时读到。
- 每晚的 work-state 多了 `propose_lines`（`roles/work-state.md`）：对得上已有线的补材料、挂事项；新的一晚一张卡（处理器 `line-propose`：建 / 不用 / 并进某条），“不用”两周内不再问。
- 工作页接口 `src/items/work-http.ts`：`GET /api/work`、`/api/work/activities`、`/api/work/:id`，`PUT /api/items/:id/parent`、`/api/item-next/:id`、`/api/item-changes/:id/noise`，都只给本人。网页还没做。

## 工作线（一）：事项上下层、关注只建在顶层、关键变化多个来源（11-20 夜）

- 事项多了 `parent_id` 和类型 `line`（工作线）：需求、缺陷、评审挂在线下，缺陷可挂在需求下，最多三层（`src/items/tree.ts` 的 `checkParent` / `writeParent`，`src/items/parent.ts` 的 `setParent`）。`upsert_item` 的 `parent`，`list_items` 写出上层和下面几件、可按 `parent` 过滤，`read_item` 带 `parent` / `children`。工作线只由本人建：后台运行建 `line` 在工具和 `items/auto.ts` 的门上都被拒；线下还有没结的事项时不自动过期。
- 关注只建在顶层（`src/channels/listen-items.ts`）：`itemChats` 连下面各项的群；子事项开始流程建或同步的是顶层的关注；`foldChildContexts`（启动和挂上层之后，幂等）把子事项原来关注的案例和在跟的问题搬到顶层，原来的暂停。
- `item_changes` 多了 `risk`、`next`、`origin`、`noise`，类型多了 stage / result / owner / resolved。宿主自己写、只记不问的来源：流程阶段做完 / 卡住 / 等本人（`flows/store.ts changeStage`）、指标越过门槛（`data/metrics.ts`）、在跟的问题有了结论（`channels/listen-problems.ts`）。`src/items/changes.ts` 的 `lineTimeline` 把一条线和下面各项的变化合在一起。
- 卡片：去掉 `item:act` 和 `notify` 的 `actions`；流程进度卡只在转到等本人时发，之后改那一张，链接 `#/work/<事项>`；事项卡发出时记下卡片，`replaces` 真去改原卡片（`src/channels/lark-bot.ts`）。

## 事项的建议卡不再带“已处理 / 忽略”；后台运行结束后才收到的回答接着做（11-20 夜）

- `notify` 多了 `plain`：关于一件事项、但不是催它做完的通知（推进建议、指标变化、截止时间变了）不带“已处理 / 忽略”。这两个按钮会把整件事项标完成或取消，只留给提醒。推进运行（`input.listenAssist`）发的事项通知由 `notify` 工具自动标 `plain`。`src/core/notify.ts`、`src/channels/item-notification.ts`、`src/agents/tools.ts`、`src/data/metrics.ts`、`src/flows/follow.ts`。
- 推进的任务不再让模型写“回一句…我就开始”（运行结束后接不到回复），只在截止前两天内会误期的风险用 normal，其余 later。`src/channels/listen-assist.ts`。
- `ask_user` 由没有会话的后台 `agent` 运行发出、本人在它结束后才回答时，以前去调 `notify(entity: "run")` 并按事项去取，结果报错；现在用同一个角色和原来的任务再起一轮（`resumeFromRun`），回答写在任务最前面。别的运行仍然只通知一句。`src/agents/asks.ts` 的 `deliverAnswer`，测试在 `test/asks.test.ts`、`test/notification-card.test.ts`。

## 在跟的问题：回完接着跟，值班群收进关注（11-20）

- `src/channels/listen-problems.ts`（表 `listen_problems`）：关注的处理和“有人找你”的处理看完一个求助的问题后用 `track_problem`（`wake` 分组，关注的处理轮和有人找你的处理才给）记状态：open / waiting / blocked / closed，已查清的、在等谁、怎样算完（没结的必填）、结论、`recheck_after`。一处一条，结了以后同一处来了别的问题另起一条，旧的留给 listen-coach。
- 有人找你：`routeWatchedMessages` 开头对没结的问题排 `problem-follow`（十分钟后、每个问题一条，机器人自己的和记下之前的消息不算）；到点按问题状态预筛（场景 watch），不用看的记 `seen_ms`，要看的经 `mentions.ts continueProblem` 交回原来那次处理（同一会话）。同一处有没结的问题时后来 @ 本人的消息并进那次处理（`recentHandling`：话题里的问题谁发的都算，整个群的问题只算原来提问的人）。处理任务第 3、7 步改为回完用 `track_problem` 记下、不问本人要不要接着跟；本人点“不发”时 `dropProblemOf`。分诊后再查一次 `ruleOn`，分诊期间触发的规则优先。
- 关注：`prefilterBatch` 的材料多“在跟的问题”，说明改为只有给问题带来新东西才算要看；`watchedNote` 带问题列表和“按问题跟，不按消息跟”的做法；回查（`problemsDue`）往关注的处理对话里放一条 `meta.recheck`。
- 规则的 `context` 动作多 `adopt`：触发的群收进关注（`listen.ts adoptChat`，`settings.adopted` 记时间），问题都结了、三天没有消息和问题更新时放回（`releaseAdopted`，心跳）；规则页的“交给关注”多一个勾选。收进来的群会让一个关注超过 20 个群，`/api/listen` 的 `chats` 上限因此放到 200（页面上从群加进关注、改群列表时整份提交）。
- `listen-coach.ts`：已结的问题算新案例，任务多“跟过的问题”；场景多 `follow`（回完怎么跟），`roles/listen-coach.md`、`submit_playbook`。
- 文档：`docs/v2/mentions.md`“回完接着跟”、`skills/omem/references/owner.md`“在跟的问题”；测试 `test/listen-problems.test.ts`、`test/lark-mentions.test.ts`。

## 流程：评审出了结论不再停在卡住，本人上一段的话带到下一段（11-20）

- `src/flows/engine.ts` 的 `behindObject`：跟着交办或评审的段卡住了（运行没交结果、报了等待），之后交办的一轮或它的评审运行才结束、状态到了这一段要的（如 `findings` / `review-ok`）：按结论完成，不再一直停在“卡住”。时间取 `objects.ts codeWorkSettledAt`（各轮和它们评审子运行最晚的 `finished_at`）；本人自己的卡住（三次不认可）和预算用完的不动。
- `ownerAlreadySaid`：本人承担的段轮到时，前一段刚由本人带一句话完成（“将问题发送评论到 MR 里吧”），先用决策模型判断这句话是否已经定了这一段；判是（概率 ≥ 0.7）就记成做完，记录写“你在「…」时已经说了：…”，没配模型、判否或拿不准照常问本人。阶段任务（`stageTask`）多“本人在这一轮前面几段说的”（`ownerSaidBrief`），后面的段按本人原话做。
- 本人自己的段点“做完了”不必写原因（宿主记“本人做完了”），跳过仍要写。
- `web/src/components/FlowWaiting.vue`：`editable` 用 `withDefaults` 默认 true（Vue 把没传的布尔 prop 当 false，运行页上等你的卡片因此一个按钮都没有）；本人自己的段和要写原因的按钮都有输入框（之前“挑问题”没有框、点“做完了”又要求写原因）。
- 测试：`test/flows.test.ts`“跟着评审的段卡住以后评审才出结论”“本人完成上一段时写的话已经定了下一段”。

## 流程：本人自己说的变化直接并进，编码段认出已在做的交办（11-20）

- `src/flows/follow.ts`：批次里的行带 `owner`（聊天按 `sender_kind = 'owner'`，会话里本人自己的话；会话里同事的话按 `meta.asker` 标成同事，不再写成“本人”）。`note_item_change` 的 scope / decision 带 `decided: true`、引用里有本人那句话时记进运行的 `followOwnWords`；`finishFollow` 不为它们发卡片，按受影响的第一段分组，每段 `reopenStage` 一次（带反馈，actor 是本人，和本人在卡片上选“并进”一样），失败时改为出卡片问本人。`finishFollow` 现在返回 Promise（卡片和游标在同步部分已经定了）。
- `src/flows/engine.ts`：跟着编码交办的段按反馈重做，运行没交 stage_report 就结束时，除了运行开始后发起或续上的交办，事项上在这一段上次完成之后发起或动过的交办也算（`item_stage_log` 里这一段最近一次 done 的时间），段跟着它走，不报“没有交代结果”。阶段任务里写明“要改的已在事项上在做的交办里就交代一句结束”。
- 起因：本人在群里直接让助手改需求、助手已交办，跟进仍把本人这句话当成待定的范围变化出卡片；本人选并进后编码段的运行发现交办已经在做，按说明结束，宿主只认运行开始之后的交办，报成卡住等本人。
- `roles/item-follow.md`、`note_item_change` 的 `decided` 说明、`skills/omem/references/flows.md`；测试 `test/flow-follow.test.ts`、`test/flows.test.ts`。

## 演示：做一遍给助手看（11-20）

- `src/remote/demos.ts`：一次演示是一个对话（渠道 `demo`，`ThreadSettings.demo`：目标、`contextId` / `itemId`、起止时间、整理方式），同一时间一个、只有本人。演示期间记进来的是不起一轮的本人消息（`meta.demo.kind`：`start`、`recording`、`pick`、`lark`、`remote`、`stop`、`organize`），按发生时间排；`stopDemo` 收本人在关注的群（连着事项时看事项的关注，都没有时看所有采集到的会话，`capturedChats` 沿 `(chat_id, create_ms)` 索引跳着取）里窗口内发的飞书消息、窗口内结束的远程录制，选了技能或经验时以本人名义发整理的消息（`organizeDemoText`）开始助手的一轮。接口 `GET/POST /api/demos`、`GET /api/demos/:id`、`POST /api/demos/:id/stop`（`src/remote/http.ts`，`routes.ts` 里都是 owner）。
- `POST /api/remote/recordings/import` 多 `demoId`：录制记进演示（`attachRecording`），不单独整理。`POST /api/clips` 多 `turn`（默认 true）：`ask` 带 `conversationId` 且 `turn: false` 时只记进那个对话（演示里是一条拾取），回答 `mode: "note"`；对话必须是发的人自己的（`noteTarget`，在存截图之前查）。
- `src/agents/commands.ts`：`/演示 <目标>`（在关注的群或关注的处理对话里发会连上它）、`/演示结束 [技能|经验|不整理]`；命令名可以是中文（`parseCommand`：中文命令可以和参数连写，取最长的前缀）。
- 内置技能 `skills/library/skill-from-demo`：读时间线（录制、拾取、本人的飞书消息），复述做法，只问会变的和怎么算做成，再 `save_skill` 或写关注的经验 `关注/<名>/演示/<目标>.md`、事项的工作文件。`src/channels/listen-cases.ts` 的 `demoLessonsDir` / `demoLessonsOf`，`playbookOf` 默认把演示过的做法接在经验后面（`demos: false` 不接）；listen-coach 的任务里单独一节，`roles/listen-coach.md` 第 7 条：不抄进经验、不删，案例和它不符时在 `notes` 里提。
- 扩展：`chrome/src/shared/demo.ts`（状态的规范化、整理方式、`clipForDemo`、`importFieldsForDemo`，单元测试 `demo.test.ts`）、侧栏顶部 `DemoBar.vue` 和 `use-demo.ts`（不存 storage，开着时每 15 秒读一次）；演示中拾取篮只有「记进演示」，录制上传只有「记进演示」。网页：`web/src/components/DemoControl.vue`，放在关注页头部和事项页。测试 `test/demos.test.ts`。

## 做梦读关注和数据提建议、coach 复盘别人的消息、周报（11-20）

- `src/agents/proactive.ts`：做梦任务多一节“关注、自动建的事项、规则和指标”（`dreamMaterial`）——有新动静的关注（`listenDigest`：更新过的会话摘要、新案例计数和纠正、两三个例子、经验改没改、参数一行）、自动建事项的留下 / 不要（`autoItemDigest`）、规则触发统计（`ruleDigest`，按规则走 `rule_firings` 的索引）、超门槛的指标（`flaggedMetrics`）、本人近况和已有关注 / 指标的事项（`coverageText`）、最近一周做梦发过的通知。有这些新动静时没有记忆变化也整理。`roles/dreamer.md` 第 8 条：一晚最多三条建议放进一条通知，本人回复后由主助手照改；dreamer 加了只读的 `list_rules`、`metric_read`。
- `src/agents/profile-jobs.ts`：复盘主助手时另选“有人找你”的处理和关注处理会话里的轮次（`assistantRuns`），证据带它们的案例（`reply_samples.handle_run`）和所在关注的说明与经验；关注里的轮次不读“之后本人说”（那个会话里是群里别人的话）；每晚挑档案时案例里的纠正也算信号。`roles/coach.md` 加了怎么看这类运行。
- `src/agents/weekly-report.ts`：定时任务 `weekly-report`（周五 17:00，默认开）排 `brief` 运行（`mode: weekly`），材料是本周的关注、事项、流程、编码、会议、指标、近况和上一份周报（与 kv `weekly_report_written:<周>` 比出本人改的行），只写 `周报/<年>-W<周>.md`，宿主发一条 later 通知。`roles/brief.md` 加了“周报”一节。测试 `test/proactive-material.test.ts`。

## 每晚复查回复结果（11-20）

- `src/agents/outcome-review.ts`：定时任务 `outcome-review`（05:20，默认开，`replies.outcome.review`：`max` 30、`batch` 10、`sample` 5、`days` 3）挑一到三天前、第一遍由决策模型标的回答（本人标的、本人改判过的、按表情记的、已改判或复查过的不挑；宿主的“没人接话”只在后来有动静时挑），先挑几条查询就能算出的对不上的信号（提问的人又问了、本人自己答了、负面表情、“不对”这类话），再挑把握低的、看不出的，另随机抽几条有把握的；每批一个运行，交给新角色 `outcome-reviewer`（`roles/outcome-reviewer.md`），材料是发出后一整天的消息、本人之后的动作、表情、同群相近的案例。
- 新的交结果工具 `review_reply_outcomes`（`ROLE_TOOLS`，分组 `delegate`）→ `reply-outcomes.ts` 的 `checkReply`：同一个结果记 `checked = 'confirmed'`（把握低的第一遍不再按看不出算），不同就写 `revised_*`（“夜里复查（模型）”）并记 `checked = 'revised'`；`reply_outcomes` 新增 `checked*` 六列（迁移在最后），拉取的 `newer` 带上 `checked_at`。
- 本人改判过的别人不再改：`reviseReply` 对别人返回 409，复盘评判跳过。
- 数据页“做得怎么样”多“夜里复查过的”“复查同意第一遍的占比”“随机抽查里同意第一遍的占比”；`omem.reply_outcomes` 多 `review` 维度，`judge` 分出本人 / 表情 / 宿主 / 模型，每天记新的一天时前四天重算（`omem-usage.ts` 的 `retake`）。运行页复查同意时多一行；设置 → AI 里可以关复查、改每晚条数。测试 `test/outcome-review.test.ts`。

## 更新时 SSH 拉不下来就改用 https（11-20）

- `scripts/upgrade.ts`：`git pull --ff-only` 失败时，把 SSH 形式的 origin 换成同一仓库的 https 地址（`scripts/git-url.ts` 的 `httpsOf`）再拉当前分支；进程管理器起的服务里 ssh 认不出当前用户（`No user exists for uid …`）或没有 agent 时，远程 `update` 也能拉到代码。测试 `test/git-url.test.ts`。

## 删除空的空间；切换仓库目录检出的分支（11-20）

- `src/core/spaces.ts` 的 `deleteSpace` / `spaceContent`：本人可以删除什么都没有的空间（`DELETE /api/spaces/:id`），连同成员、与其他空间的关联和知识库里的目录；有原件、页面、记忆、事项、运行等内容的、个人空间、下面还挂着仓库的业务空间、分支索引都拒绝，并说清还有什么。`GET /api/spaces/:id` 多了 `content`。仓库空间的仓库目录不动。
- `src/core/repositories.ts` 的 `checkoutBranch`：`PUT /api/spaces/:id/branches {current}` 把仓库空间自己的目录切到某个分支（只在 origin 上的建成跟踪分支），目录里有没提交的改动时拒绝；切完重新导入。新的交办从这条分支切出，没有 origin 时确认交办也合回这条分支。
- 设置 → 空间：仓库空间多了“仓库目录检出的分支”和“切换”；编辑框左下角“删除空间”（有内容时不可点，悬停看原因）。测试在 `test/spaces.test.ts`。

## 没有远端的仓库确认交办时合进切出来的分支（11-20）

- `src/agents/code-branch.ts` 的 `landLocally`：仓库没有 origin 时，确认交办不再只留一条本地分支，而是在能快进时把工作分支合进它切出来的分支（检出着就在那里 `merge --ff-only`，没检出就移动引用）；那条分支上有交办之外的新提交、或检出处快进不了时不合，在确认说明里写原因。接着已有分支做的交办照旧。测试 `test/code-land-local.test.ts`。

## Chrome 扩展的录制：在自己的浏览器里把一件事教给助手（11-20）

- 扩展（`chrome/`）侧栏多了「录制」一页（`sidepanel/RecordPanel.vue`、`use-recording.ts`，和拾取篮用顶上的两个标签切换）：写要教什么、选标签页、开始 / 停止 / 接着录、加标记（可先在页面上指一个元素）、删步骤，停止后「整理成技能」或「只保存」，可选一个关注或事项。录制中工具栏图标显示 REC。
- 后台 `background/recording-service.ts`：在被录的标签页注入 `inject/recorder.ts`（点击、填写、提交、Enter，元素名字和角色取法同 aad，路径和所在标题用拾取的 `element-context`），从被录页打开的新标签页一起录，`chrome.tabs.onUpdated` 记换页，`captureVisibleTab` 给点击和换页截图；请求用 `chrome.webRequest` 只观察（manifest 加了 `webRequest` 权限，仍不连调试器），DevTools 开着时 `panel/recording-bridge.ts`（挂在 devtools 页面）补上请求体和响应体，`findPartner` / `mergeRequests` 合并同一个请求。数据在 IndexedDB `omem-record`（`shared/recording-store.ts`）。遮盖、敏感输入框、上传内容的规则在 `shared/recording.ts`，单元测试 `recording.test.ts`，e2e `e2e/record.e2e.test.ts`。
- 服务端新接口 `POST /api/remote/recordings/import`（只有本人，`src/remote/import.ts`）：写成 aad 浏览器录制的文件（`steps.jsonl`、`evidence/network.jsonl`、`images/`），`summary.source` 为 `chrome-extension`；`contextId` 把整理的消息发到关注的对话，`itemId` 在消息里写明事项；遮盖再做一次（`src/remote/redact.ts`，规则同 aad 的 `redact_network`，多了 `pwd`，片段留前端路由）。
- `src/remote/recordings.ts`：步骤一行多了所在标题、CSS 路径、截图文件路径，“打开页面”和指着元素的标记有了说法；没有 aad 操作说明和可回放步骤时概要直接列步骤。`requests.ts`：没有响应体时不再把重复的 GET 当轮询。`list_recordings` 标出 Chrome 扩展录的；内置技能 `skill-from-recording` 说明了标记和没有响应体的情况（已有数据目录里的副本不会自动更新）。文档 `docs/v2/remote.md`“在自己的 Chrome 里录”，测试 `test/remote-import.test.ts`。

## 助手自己建的事项要站得住：why、候选和本人的取舍（11-20）

- `src/agents/tools.ts`：`upsert_item` 多了 `why`。新建时不是本人自己这一轮（`ownTurn`：本人这一轮的话、成员在自己会话里说的、本人批准过的调用、没有运行的调用之外都算）就必须写，引用照 `source_refs` 校验；同名候选不重复建，本人两周内不要过的同名事项拒绝；后台运行不能改候选的状态；本人这一轮改自动事项的状态按本人的选择记（actor `user`）。`list_items` 的 status 多 `candidate`。
- `src/items/auto.ts`：`gateItem` 用决策场景 `item`（`src/core/decision-scenes.ts`“自动建事项”，风险答案 keep、谨慎答案 candidate，默认 0.6，配置 `ai.decision.thresholds.item`；设置页的门槛列表按场景自动列出）。材料：事项、理由、建的角色、`workStateBrief`、活跃的「关注」名字和说明、最近的自动事项取舍、免提醒规则。没有决策模型或出错时只认引用了本人原话（群聊里“（本人）”那一行、本人发给助手的消息）或点名关注的理由。另有 `decideCandidate`、`pendingCandidates`、`sweepCandidates`（三天没答取消，不进清点的“已过期”）、`candidatesBody`、`itemLessons`。
- `src/items/store.ts`：状态多 `candidate`（不在 active、不提醒、`itemExpiry` 返回 null，`item.created` 事件等留下时才有）；每次状态变化调 `src/items/auto-cases.ts` 的 `noteAutoOutcome`，自动事项（时间线有 `auto` 事件，文字以“为什么建：”开头）的取舍记进 `reply_samples`（`source = item`、`chat_kind = item`、`handle_run` 是建它的运行、`final` 是事项 id、`asker_name` 是建它的角色，插入时即 settled）。`src/mentions/reply-learn.ts`、`triage.ts` 读案例时排除这类。
- 9:30 清点（`jobs.ts` 的 `sendItemDigests`）多一段候选，卡片每件一行“留下 · 标题 / 不要”（`item:take|drop:<id>`，`lark-actions.ts`）；事项页顶部“可能要跟的”、详情里的候选提示用 `POST /api/items/:id/candidate`（`{ keep }`，在 `src/auth/routes.ts` 登记为 self）。`GET /api/items` 和详情对候选带 `auto: { why, by }`。
- 整理、巡检、夜间整理、简报的任务和有人找你的处理任务末尾带“本人最近对你自动建的事项的取舍”（该角色自己的在前，最多 8 条）。角色说明：`roles/_common.md`“事项与本人的回复”和“怎么写记忆”第 3 问、`ingest.md`、`heartbeat.md`、`dreamer.md`、`brief.md`；`src/memory/quality.ts` 的免责式拒绝理由也要求 why。测试 `test/item-gate.test.ts`。

## 插件读得到本人填的设置：api.settings() 和登录方式的 ctx.settings（11-20）

- `src/plugins/registry.ts`：在 omem 里运行的插件多了 `api.settings()`，返回本人在 设置 → 插件 里填的值（清单 `settings`，带默认值），每次调用时读；隔离运行的照旧在工具的 `ctx.settings()` 里读（`sandbox-runner.ts` 里调用会报错说明）。
- `src/agents/agent-logins.ts`、`accounts.ts`：登录方式的 `login`、`refresh`、`logout` 的上下文多了 `settings`；插件 SDK 的类型同步（`packages/plugin-sdk/agent-login.ts`）。文档 `docs/v2/plugins.md`“AI 账号的登录方式”，测试 `test/agent-logins.test.ts`。

## 成员的 AI 账号：额度和模型按账号、技能进账号目录、换后端、停用时清理、插件登录（11-20）

- 运行时 profile 上带成员账号的字段从 `account` 改名 `ownAccount`（`sandbox.ts` 的 `accountOf`）：`account` 现在是配置里 profile 的 spec。
- 额度：`quota.ts` 加 `quotaKey`（成员账号是 `<后端>@acct:<用户>`），`quotaKind` 不再对成员账号返回空；`readCodex` / `readClaude` 对成员账号在他的沙箱里、以账号目录为 cwd 读；`startQuotaWatch` 也读最近 6 小时在用的成员账号（`accounts.ts` 的 `memberQuotaProfiles`）；`forgetQuota` 在退出时删。`capacity.ts` 的用完标记对成员账号加 `acct:<用户>/` 前缀，`outOfQuotaList` 不列它们；`runner.ts` 的 `noteQuota` 对成员账号也记。`runner.ts` 的兜底链和 `choose-ai.ts` 的候选对成员先 `accountFor`（登录了就换成他的账号，不抛错），`chooseAI` 还去掉 `accountBlocked` 的候选。
- 探测：`probe.ts` 的 `cachedProbe` / `saveProbe` 多一个 `userId`（键 `probe:<档案>@acct:<用户>`），新 `probeFor`（按运行带的账号）、`userProbe`（按人：登录了用他的）、`probeAccount`（登录成功后在沙箱里探测）；`probeOn` 对成员账号以账号目录为 cwd；`doubao-cli.ts` 的模型探测也能进沙箱。`dispatch.ts`、`execution.ts`（`validateExecution` 多一个 `userId`，`tools.ts` 里传 `ctx.userId`）、`commands.ts` 的 `/model`、`list_ai_backends` 用它们。
- 技能：`agent-skills.ts` 拆出 `wantedEntries` / `writeEntriesTo`，新 `accountSkillDirs`（目录里的技能路径按账号目录和各后端的 `account.env` 展开）和 `writeAccountEntries`；`writeAgentEntries` 和还原也处理 `<数据目录>/accounts/*/home`；`accounts.ts` 的 `ensureAccountHome` 新建了目录时写一次（接管开着时）。
- 配置：`config.ts` 加 `accountSpecSchema`（严格字段，`{home}` 只在 env 的值，env 值只许 `{home}/…` 或普通值，`dirs` / `owns` 是相对路径，正则要能编译），`agentProfileSchema.account`；`agents.accounts` 多 `own-or-other`。`catalog.ts` 的 `accountCatalog(profiles)` 把带 `account` 的 profile 按 source 并进来；`accounts.ts` 的查找都改成带 `app`（`accountEntries` / `accountEntry(app, id)` / `accountEntryFor(app, p)`）。
- `own-or-other`：`withAccount` 多一个 `others` 回调，`prepareRun` 传 `failoverProfiles(...).slice(1)`；换到的后端照常 `withAccount`。运行指定的 AI 被换掉时不再用它校验模型。
- 停用：`src/auth/http.ts` 停用用户后调 `removeAllAccounts`（停登录、各后端退出、删 `agent:` 开头的连接、kv、账号目录，`audit_events` 记 `agent-accounts.remove-all`）。
- 插件登录：新文件 `src/agents/agent-logins.ts`（`AgentLoginContext` / `AgentLoginDef`、`registerAgentLogin`、`loginMethodsFor`）；`plugins/registry.ts` 的 `api.agentLogin`（数据目录的插件要在 `permissions.agentLogin` 声明后端，后端要能按人登录，`describePlugin` 的权限里列出），`sandbox-runner.ts` 隔离运行时拒绝，`types.ts` 加类型。`accounts.ts`：`startLogin` 多一个 `method`（`native` 或 `<插件>:<id>`），插件登录在 omem 进程里调 `login`，`show` 的链接和验证码进页面并经 `notify` 发到本人私聊（自己的设备码登录也发），11 分钟超时；登录态记 `method`、`expiresAt`、`refreshAt`；`refreshPluginLogin`（“检查”也走它）和每分钟的 `tickAgentLogins`（`main.ts`）续签，null 或出错改成过期并通知；`removeAccount` 先调插件的 `logout`，删 `agent:<后端>` 和 `agent:<后端>:…` 的连接。视图多 `methods`、`method`、`methodLabel`、`expiresAt`、`quota`；新接口 `POST /api/me/agent-accounts/:backend/quota`（self），登录接口收 `{ method }`。SDK 类型在 `packages/plugin-sdk/agent-login.ts`，从主入口导出。
- 网页：`AgentAccounts.vue` 加登录方式下拉、额度一行和“重新读取”、登录方式和到期时间；`AgentAccountsAdmin.vue` 的规则三选一、列出登录方式；`PluginsSettings.vue` 的权限说明列出 `agentLogin`。测试 `test/agent-accounts.test.ts`（加了 7 项）、新的 `test/agent-logins.test.ts`。

## 成员用自己的 AI 账号：账号目录当 HOME，Linux 上用 bubblewrap 启动（11-20）

- 新文件 `src/agents/sandbox.ts`：`sandboxSupport`（只在 Linux、找得到 `bwrap`（或 `OMEM_BWRAP`）、探测命令能跑通时打开，进程内检查一次，`omem diag` 的 `agentAccounts`）；纯函数 `bwrapArgs`（只读根、新的 user / PID 命名空间、`/tmp` 和要隐藏的目录换成空的，挂载按路径深浅排，同一路径可写优先，网络不隔离）和 `sandboxEnv`（去掉服务环境里的凭据和指向隐藏目录的变量，HOME 换成账号目录，Node 放在 PATH 最前）；`sandboxCommand` 按命令的真实位置补只读挂载（npm / pnpm 的安装前缀、Node、omem 的代码）。`accountOf` / `accountTag` 读运行带的账号。
- 新文件 `src/agents/accounts.ts`：账号目录 `<数据目录>/accounts/<用户>/home`（0700，拒绝符号链接）、`withAccount`（`prepareRun` 里调用：本人和没有 `account` 的后端不变；成员登录过的换成他的账号；没登录看 `agents.accounts`，`own` 时抛出提示）、`accountBlocked`（`runner.ts`、`sessions.ts` 的兜底链去掉这样的后端）、登录（在沙箱里起 `account.login`，从输出认链接和验证码，命令留到结束或超时再 `status`）、粘贴令牌（`secrets/vault.db`，提供方 `agent:<后端>`，账号页的“已连接的应用”不列它）、检查、退出（`logout`、删 `owns` 里的目录，最后一个后端时删整个账号目录）。登录态在 kv `agent_account:<用户>:<后端>`。
- `src/agents/catalog.ts`：`CatalogEntry.account`（`cli`、`env` 里的 `{home}`、`dirs`、`mounts`、`owns`、`login`、`status`、`logout`、`tokenEnv`），填了 Codex、TraeX、Claude Code，豆包命令行放在新的 `accountOnlyCatalog`；`accountCatalog()` 列出全部。
- `spawn.ts` 的 `launch` 加 `sandbox`：ACP（含 `deleteAcpSession`）、命令行兜底、归档命令、豆包命令行都传 `accountOf(profile)`；豆包命令行的长提示文件在沙箱里放进账号目录。`session-children.ts` 按账号目录找 Codex 的会话记录。
- 跟着账号走：`background-sessions.ts` 的池 key 加账号；`sessions.ts` 的会话 key 和 `stepKey` 加 `|acct:<用户>`，兜底那一步带上成员的账号（`carryAccount`），被换掉的会话用原账号清理（`recordedAccount`）；`session-cleanup.ts` 的 `backend_key` 加 `@acct:<用户>`，恢复时按它补回账号，账号目录没了就删记录；成员账号的豆包命令行会话不记清理。`quota.ts` 的 `quotaKind`、`capacity.ts` 的 `outOfQuotaUntil`、`runner.ts` 的 `noteQuota` 对成员账号不读不记本人的额度。
- 配置 `agents.accounts`（后端 → `owner` / `own`，默认空即借用）。接口在新文件 `src/server/agent-accounts-http.ts`：`/api/me/agent-accounts…`（self，只动自己的；本人调用登录返回 400）、`GET /api/agent-accounts`、`PUT /api/agent-accounts/:backend/policy`、`DELETE /api/agent-accounts/:user/:backend`（owner），都登记在 `src/auth/routes.ts`。
- 网页：`web/src/components/AgentAccounts.vue`（账号页“我的 AI 账号”）、`AgentAccountsAdmin.vue`（设置 → AI “成员的 AI 账号”）。`osdk.toml` 加 `[sys.pkg]`，只声明 apt / dnf 的 bubblewrap，`scripts/upgrade.ts` 不跑 `osdk pkg apply`。
- 设计里没做的（额度按账号读、探测缓存按账号分、技能同步进账号目录、`own-or-other`、插件登录）和没在真机上验的写在 `docs/v2/agent-accounts.md` 开头。测试 `test/agent-accounts.test.ts`。

## 事情型关注主动推进（11-20）

- `src/channels/listen-assist.ts`：`ListenKnobs.assist`（off / suggest / act，事情型默认 suggest）。`assistDue`（心跳）对活着的事项、有变化或快到截止、离上次 20 小时以上的起一次只读推进运行，任务里有事项状态、流程阶段、最近变化和时间线、关注会话摘要、观测计划和指标、上次的建议（工作文件 `关注/<名>/推进.md`）；最多三条建议用 notify 发出。`quiet.ts` 允许它 stay_quiet。网页关注详情多了“主动推进”，`set_chat_watch` 和 `/api/listen` 认 `assist`。测试 `test/listen-assist.test.ts`。

## 工作上的指标、数据源目录和观测计划；omem 自己的用量按天存（11-20）

- `src/data/metrics.ts`：表 `metrics`、`metric_points`（主键 metric_id + at + dims，同一点再记会替换；两张都进拉取）。`defineMetric`（新指标必须写查法）、`recordPoints`（和基线比：固定的 `baseline`，或前 7 个点的中位数；超过 `threshold`（默认 0.3）时 `notify` 稍后档、写进关联关注的会话、事项时间线）、`readMetric`（序列、变化、`ChartSpec`）、`collectDue`（到时间的指标按空间起一次 `kind = agent` 的只读取数运行，`input.metricCollect`，禁发消息、交办、建事项；每天最多 40 次；`quiet.ts` 允许它 `stay_quiet`）。
- 工具分组 `data`：`metric_define`、`metric_record`、`metric_read`（`chart: true` 附 ` ```chart ` 块）；主助手有 `group:data`。说明页 `skills/omem/references/data.md`。内置技能 `data-sources`（盘点数据源目录，写工作文件 `数据/数据源目录.md`）、`observation-plan`（需求的观测计划）。
- `src/data/omem-usage.ts`：心跳每天把前一天（首次最多 30 天）的 omem 用量写成 `omem.runs`、`omem.run_minutes`、`omem.runs_by_ai`、`omem.reply_outcomes`（判定、谁判的、有没有改判）、`omem.cases`、`omem.conversations`。
- 网页：`web/src/lib/markdown.ts renderCharts` 把 ` ```chart ` 块画成图；事项页 `ItemMetrics.vue`；接口 `src/data/http.ts`（`/api/metrics`、`/api/metrics/:id`、改采集频率和门槛）。

## 「关注」管会议和事项，规则能交给关注（11-20）

- 会议（`src/channels/listen-meetings.ts`）：没有规则接的会议交给关心它的关注（群里发起的给含这个群的关注，本人入会的给默认关注），`meetings: ask` 发只给本人看的卡片（`watch-trial.ts` 的 `ownerCard` 已导出复用），`listen` 直接进；进会沿用规则的旁听流程（`lark-meetings.ts startListenPlan`，计划上带 `contextId`），旁听任务带关注的说明、经验和摘要，记下的和会后小结写回关注会话（`jobs.ts` 里 `listenMeeting`）。“以后不用问”记在参数 `meetingSkip`。进会与否记成案例（`chat_kind = 'meeting'`，不参与回复类的检索和统计）。本人不在的群会议，旁听的写法改成“本人不在会上”。`lark_meetings` 加 `context_id`。
- 事项（`src/channels/listen-items.ts`）：开始流程自动建只看不回的事情型关注（`byFlow`，流程结束暂停），启动时 `migrateItemContexts` 补上；`setItemListening` / `set_chat_watch(item)` 打开的不随流程停。群跟着事项关联的群（跟进时同步）。`follow.ts` 跟进的范围是有流程的事项或打开了关注的事项。只看不回的事情型关注不再接收群消息路由（跟进自己读）。
- 规则（`src/rules/to-listen.ts`）：新动作 `context` 交给关注；`ruleToContext` 把只看某几个群的 Agent 规则转成关注。网页接口 `POST /api/items/:id/listen`、`POST /api/rules/:id/to-listen`。

## 「关注」：盯群换成关注，按案例和场景经验处理（11-20）

- `src/channels/listen.ts`：新表 `listen_contexts`（place / item / default），每个关注一份说明、一组参数（`ListenKnobs`）、一条处理会话（channel `listen`，key 是关注 id）。`chat_settings('lark-watch')` 只留作群的索引（`contexts`、`spaceId`）。启动时 `migrateWatches` 把旧盯群迁成地方型关注（保留会话，`watch.log` 进案例表）。
- `lark-watch.ts`：一条消息交给它所在的每个关注，第一个能回复的是 `lead`（事情型 → 地方型），别的关注在提示里被告知；`watch-trial.ts claimReply` 在发送前认领（`handled_messages` 的 `listen-reply`）。`seedContext` 读各群三天背景，`backlog` 窗口内的照新消息处理。预筛（`prefilterBatch`）按关注的 `strictness`、`perDay`、经验和案例判断。
- 处理者的提示（`sessions.ts watchedNote`）按参数生成（问本人的、找别人的、主动查到什么程度），带经验、相近案例、本人最近的决定、召回的记忆。会话摘要按发言人写（以前都标成“本人”），关注的摘要分在聊的话题、没结的问题、已有结论（`jobs.ts thread-summary`）。
- 案例：`reply_samples` 加 `context_id`、`source`、`scene`、`verdict`、`note`、`checked`、`reply_id`。盯群的决定、没回的一批（`stay_quiet` → `noteQuiet`）、本人在关注群里自己回别人（`collectOwnerReplies`）都记成案例；有人找你的样本归到默认关注。`listen-cases.ts nearCases` 按同一个人、同一个群、问法相近排，分诊、处理者、预筛都用。
- `listen-coach`（新角色，`listen-coach.ts`）：心跳里攒够 5 条本人有态度的案例、离上次 12 小时以上时整理，用角色专用的 `submit_playbook` 按场景交经验，宿主写成工作文件 `关注/<名>/经验.md` 并给案例标场景；说明该改时发给本人确认。原件目录把 `关注/` 下的工作文件按路径分文件夹（`catalog.ts`）。
- `set_chat_watch` 改成设关注：`chats`、`context`、`name` 和各参数，说不用关注了是暂停。`/watch`、规则的“盯群”动作走 `watchChat`。网页接口在 `listen-http.ts`。测试 `test/listen.test.ts`，旧的 `watch-trial`、`watch-prefilter`、`lark` 测试改成关注。

## 盯群先对齐、试运行、按本人的决定学；没改过的内置技能跟新版（11-20）

- 新文件 `src/channels/watch-trial.ts`：盯群说明（`brief`）的确认卡片、试运行的草稿卡片（可改、不发带原因）、连续照发 `PROMOTE_AFTER`（5）条后问要不要直接发、直接发的回复被本人点负面表情退回草稿（`lark-feedback.ts` 调 `dislikedWatchReply`）、本人决定的记录（`WatchRule.log`，最多 30 条）。卡片都只给本人看：本人在群里用临时卡片，否则私聊。`lark-actions.ts` 多三种卡片用途 `watch-brief`、`watch-draft`、`watch-promote`。
- `set_chat_watch`（`src/agents/tools.ts`）：reply 为 draft / auto 时要 `brief`，`reply: auto` 默认存成 draft 加 `wantsAuto`（`trial: false` 跳过），新盯群记 `since`，改了 `brief` 就再发确认卡片。`larkPost` 遇到盯群处理者的草稿走 `draftWatchReply`，直接发的记 `noteAutoReply`。
- `lark-watch.ts`：`since` 之前的消息不交出去（`sentMs` 认毫秒、秒和 ISO），消息尾标“@了本人 / @了别人”（采集路径传入本人在 lark-cli 里的 id），预筛带上说明和本人的决定。`sessions.ts` 的 `watchedNote` 改成异步：带说明、最近的决定，问本人或要本人拍板的只 notify，别人的事不接，纠正满 `REVISE_AFTER`（3）次要求重拟说明。
- `src/agents/specs.ts` 的 `seedBuiltinSkills`：已有的内置技能如果每个文件都还和 omem 最后一次写进去（`omem: add/update built-in skills` 提交）时一样，就换成新版并提交 `omem: update built-in skills …`；改过的照旧不动。测试在 `test/desktop-control.test.ts`、`test/watch-trial.test.ts`。

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
