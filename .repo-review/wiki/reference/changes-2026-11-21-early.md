---
title: 2026-11-21 较早的变化
kind: reference
updated: 2026-11-21
---

## 后端能使用的工具与常驻说明（11-21）

从 `src/agents/capabilities.ts` 和 `src/agents/runner.ts` 读起。设备代跑使用 ACP 的能力，本机豆包 CLI 通过终端使用工具，云端会话只接收文本。小节标题下可连续写 `tools:`、`needs: tools` 和 `needs: local` 标记。运行事件记录能力、说明是否发出，以及会话背景和任务正文的字符数。

## 豆包会话恢复与取消（11-21）

`src/agents/doubao.ts` 将聊天恢复失败交回会话层，新建会话时重新带上摘要、近期消息和角色说明。创建和恢复请求都随本轮取消。临时任务恢复失败时，`src/agents/dispatch.ts` 在本轮结束后释放新建的替换会话，读回复失败也会清理。

## 后端会话清理耗尽后可重试（11-21）

后端会话清理连续失败 12 次后停止自动重试，并在本机保留失败时间和原因。本人可用 `GET /api/agents/session-cleanup/failures` 查看记录。恢复后端配置或授权后，向 `POST /api/agents/session-cleanup/retry` 提交该条记录的 `backendKey` 和 `sessionId`，宿主从下一次清理扫描起重新尝试。

## 设置页按“本人在想什么事”重新分组（11-21）

- `web/src/views/Settings.vue` 从两千多行拆成导航、目录、读写配置的公共部分（`views/settings/ctx.ts`）和每个标签一个懒加载文件（`views/settings/*.vue`）。分组：知识（空间 / 采集 / 检索与记忆 / 占用）、助手（通知与打扰 / 代你回复 / 推进工作 / 自检与复盘 / 定时任务）、AI（后端与模型 / 插件）、渠道与协作（渠道 / 成员 / 设备 / 分享）、系统（安全 / 外观与说明）。原“AI”标签的 21 张卡只留 6 张和后端有关的，其余按用途搬走；“连接”改叫“采集”，关注不在设置里管。
- 一行一项：`components/SetCard.vue`、`SetRow.vue` 和 `styles.css` 末尾的 settings 段；长的路径和命令用 `components/MonoLine.vue`（一行省略、悬停看全、可复制）。定时任务是一张分组的表（`lib/cron-text.ts` 把 cron 写成“每天 02:50”），空间是列表加详情，分享和成员一行一条。
- 任何一张卡可以用 `#/settings?card=<id>` 直达（`Settings.vue` 的 `CARDS` 表），旧的 `?tab=` 链接会落到搬家后的位置；`web/src` 和 `src/` 里给人看的“设置 → …”提示已改成新路径。
- “提醒的效果”统计从设置里移出，成了 `components/NotifyEffect.vue`，放在数据页“omem 自己”的“提醒”一节。
- 行为上的小变化：“跟随层数”和“每批标注数”填 0 以前会被悄悄换回默认值，现在保留 0。

## 整理第一批：下一阶段的方案、短文字的渲染、工作页右栏（11-21）

- 新文档 `docs/v2/next.md`：现在的形状（入口、主动行为、等本人处理的东西各有多少路），三条主干（关联、变化、出口）和多 Agent、插件、沙箱、权限、提示词、界面各自的分期。之后的整理按它排。
- `web/src/lib/markdown.ts` 新增 `renderInline`（行内 Markdown 和引用，不出块）；`web/src/lib/plain.ts`（`unblock`、`plainLine`，没有 DOM 依赖，测试 `test/web-plain.test.ts`）；点引用的处理抽到 `web/src/lib/cite-click.ts`，`Markdown.vue` 和新组件 `components/RichText.vue` 共用。句号、分号后面的裸 `src:` / `mem:` 引用以前不认，现在也变成链接。
- `Markdown.vue` 多 `compact`（`styles.css` 的 `.prose.compact`：14px / 1.7，标题不用衬线和底线），`AskCard` 用它；`AskCard` 多 `full`（单独打开时不截断、不重复写“需要你回答”）。
- 抽检页（`views/Quality.vue`）的理由、引文、问题、依据、建议，事项页候选的“为什么建”（`views/Items.vue`），夜间复盘列表的问题标题（`components/ReplayList.vue`，取任务第一行的纯文字）不再露出裸引用和 Markdown 记号。
- 工作页右栏 `components/WorkWaiting.vue` 重写：问题不再一条一张带表单的卡片，改成一两行的清单（第一句、种类、多久前；种类按 `handler` 归成 提问 / 审批 / 流程与编码 / 提议），多于 8 条时可按种类筛选并先列 8 条；点一条在新组件 `components/SideSheet.vue`（右侧抽屉）里回答。候选事项一行一条，“留下 / 不要”在行尾。

## 数据页重做：等你确认的清单、一个指标一格、点一个数打开抽屉（11-21）

- 工作数据：`web/src/components/MetricsBoard.vue` 重写。AI 提议的指标是上面一张“等你确认”清单，按工作线分组，一行一个（名字、来源和频率、why（没有就用说明）、最新值），行尾保留 / 不要；组标题“这一组都保留 / 都不要”，清单顶上“全部保留”。批量走新接口 `POST /api/metrics/decide {ids, status: active|dropped, note?}`（`src/data/http.ts`，同一个事务，有一个读不到或不能改就都不改）。在看的指标按线分节，`MetricRow` 加 `even`（`charts.ts` `MetricGroup.even`：标签最多两行、下面一行小字省略、格子按 210px 自动排），没有数的格子用 `MetricItem.pending` 写“还没取到 · 下次几点”。
- 一个指标一格：`src/data/metrics.ts tileSeries`——有 `compareBy` 时是 focus 那组，只有一组就是那组，计数（和 omem 自己的数）是各组合计，比例类是最新那组并写“共 N 组，点开比较”；`GET /api/metrics` 多 `groups`，取最近六周的点（原来是最近 120 个点，分维度多的只够几天）。`readMetric` 一次最多读 6000 个点。
- 详情 `web/src/components/MetricDetail.vue`：左图右定义（为什么看、说明、从哪来、怎么查（长的收起）、基线、多久取一次、挂在、观测计划、谁定的、画法），下面每个维度一张 `RankBars`（合计或平均）；分维度的计数没指定 compareBy 时画每天合计；保留 / 改 / 不要、暂停在右上；7 / 30 / 90 天在详情里切。omem 自己的维度名换成本人的话（`web/src/lib/metrics.ts dimName / dimValue`）。
- 资料：`web/src/components/MetricFiles.vue`，页头右侧“数据源目录 · 观测计划 N · 采集记录 N · 报表 N”，点开是抽屉里的清单，报表在抽屉里用 Markdown 画图；工作线页的“数据”一栏里也用它。
- omem 自己：`web/src/views/Insights.vue` 重写。页头同一行右侧是时间段、和上一段比、筛选、导出；四个关键的数（`KEY`）；可粘在顶部的节导航（用量 / 提醒 / 回答 / 编码与流程 / 知识 / 运行时长 / 长期走势，`CHAPTERS` 把报告的节归进去，认不出的进“其他”）；每节默认一两张图、排行前八行、六个数（已在顶上的不重复），其余“展开这一节”；口径收进“怎么数的”；空间显示名字。提醒一节留了 `<!-- NotifyEffect 接在这里 -->`。
- 抽屉：`web/src/components/InsightDrawer.vue`，新接口 `GET /api/insights/breakdown?metric=&<筛选>&pick=dim:value&q=&offset=`（`src/insights/insights.ts insightBreakdown`，权限 self）。返回这个数、上一段的值（报告没比较时另算紧邻的一段）、每天的记录数、按 scene / profile / space / model / by / chat / status 拆开（每种前八，只有一组或一组加“没记下”的不给）、抽屉筛选、带 `by`（你 / 成员名 / 渠道加 id 末四位）、`seconds`、`result` 的记录（新的在前，一页 100）。记录和 `/api/insights/records` 同一份（报告缓存里的 `records`），运行从缓存的 `runs` 找，记录点到的段外运行每 500 个一批补读；通知、复盘、抽检的记录带上所属运行（`RecordRef.run`）。页面上数字的链接改用页面自己的查询加 `detail`，打开抽屉不再重算报告，Esc 后焦点回到那个数。
- omem 运行数（`src/data/omem-usage.ts`）的 `trigger` 维度只存 via；以前存的整段触发信息（带人名、群名）在 `metricPoints` 读时换成它的 via，并和同一天同一组合的点相加。
- 演示数据（`scripts/doc-screens.ts`）：客服工单线上加两个提议；`--serve` 可用 `DEMO_PORT` 固定端口。截图 `insights`、`insights-work`、`insights-report` 重拍，新增 `insights-detail`。

## 关注页重排、线的群由本人定、观察中的线（11-21）

- 关注页 `web/src/views/ListenDetail.vue` 重写：标题右边是开关和删除，一行概况，群收成“N 个群”（点开是名字和最近一条消息多久前，取自 `/api/lark/captured`），原来页内的锚点导航换成标签页 在聊什么 / 经验和案例 / 记忆 / 处理记录 / 设置（`?tab=`）；群的页面是概况、在哪些关注里，再是 案例 / 记忆。嵌在线页面里只有开关和 设置 / 经验和案例 的切换，线页面的这个标签改叫“关注设置”。
- 设置的说法：`web/src/lib/listen.ts` 的选项改成本人的话，新增 `KNOB`（每项的名字和一行说明）；“怎么挑”“挑的门槛”只在“挑和说明有关的”时出现，只读的事情型关注只显示回复、开会、主动推进。`seeOthers` 没有地方用，网页拿掉了（接口照收）。
- 线的群：`src/channels/listen-items.ts` 新增 `contextChats`、`itemChatsPatch`，关注的设置里多 `added`、`dropped`（`src/channels/listen.ts`），同步时不再被事项材料改回去。`PUT /api/listen/:id {chats}` 对事情型关注按这个存；`GET /api/work/:id` 的 `chats` 是关注实际读的群，`listen` 多 `status`；`WorkDetail.vue` 的“人和群”加“不再关注”和“再关注一个群…”。
- `set_chat_watch`：`context` 认名字（`listen.ts contextByIdOrName`）；事情型关注可以 `chat_id` 加群、`chats` 给完整列表；说明里的参数换成和网页一样的说法。
- 观察中的线：`listen-items.ts watchingNote`，`agents/sessions.ts watchedNote` 和 `flows/follow.ts` 的跟进任务多一句“已经上线，只关心报错、用户反馈和数据异常”；`/api/listen` 的 `item` 带 `phase`、`watchUntil`，关注页显示同一句。
- 修正：侧栏“来源”里的事项 id 以前一律链到运行页（打开是空的）。`src/items/changes.ts refTargets` 给变化和下一步里的事项、运行 id 查出标题（`ChangeLite` / `NextLite` 的 `refTargets`），`web/src/lib/work.ts otherRefs` 按它链接，其余只写字；`web/src/lib/flow.ts evidenceLink` 只给运行、方案、事项链接，`ItemFlow.vue`、`ItemFlowPage.vue` 认不出的依据写成字。`/api/work/activities` 只给显示的 300 条做这些查找。

## 指标：从哪来、由本人确认、按指标的画法画（11-21）

- `src/data/metrics.ts`：`Metric` 多 `why`、`planRef`、`definedBy`（owner / agent / omem）、`definedRun`、`confirmedAt`、`droppedAt`、`ownerNote`、`view`，状态多 `proposed`、`dropped`。迁移 `db.ts METRIC_ORIGIN_MIGRATION`：以前的工作指标改成提议，omem 自己的算已确认。`defineMetric(app, input, { by, runId })`：agent 新建的一律是提议（要 `why`），不能留下、不要或要回本人不要过的；`recordPoints` 只对 active 的通知；`collectDue` 取 active 和 proposed；`metricDecisions` / `metricLessons` 读本人最近的取舍。
- 画法：`metricTable`（按维度组合或 `view.compareBy` 分组）、`metricCharts`（line / area / bar / stack / compare / pie / table / number，`ratio` 另画占比）、`figureSeries`、`latestOf`、`nextTake`；`readMetric` 多 `kind`、`charts`、`table`、`latest`，`metricText` 带全部图表块。
- 工具 `metric_define`（`src/agents/tools.ts`）按 `ownTurn` 区分本人和后台，多 `why`、`plan_ref`、`view`、`status: dropped`；`metric_record` 写明提议没有通知；`metric_read` 列表带“本人对 AI 提议的指标最近是这么定的”。看线的运行（`channels/listen-assist.ts`）的“数据”一节标出提议、act 档带取舍。线结束和重新打开（`items/lifecycle.ts`）照顾提议。
- 接口（`src/data/http.ts`）：`GET /api/metrics` 多 `figure`、`latest`、`nextAt`、`plan`，`item=` 含下面的事项，`dropped=1`；`PUT /api/metrics/:id` 多名字、单位、why、基线、画法、`status: dropped` 和 `note`；`/api/metrics/files` 多 `report` 和 `item=`。
- 网页：`packages/plugin-sdk/charts.ts` 的 `metricsElement` 多 `select`（数字本身是按钮，`aria-expanded`），`MetricItem` 多 `tag`；`components/charts/MetricRow.vue` 多 `keys`、`selected`、`select` 事件，只在内容变了才重画、只有数变了才重新数；`components/MetricsBoard.vue` 重写（待确认的筛选、详情按画法、一两天写成文字、没取过写何时取、保留 / 改 / 不要、报表点开画图、`item` 范围）；`ItemMetrics.vue` 改成套这块板。
- 技能 `observation-plan`（少而准、why / plan_ref、view、报表）、`data-sources`、`skills/omem/references/data.md`。演示库多两个提议（按端并排、只有一天的新旧对比）和一份两张图的报表，新截图 `insights-report`，重拍 `insights-work`。

## 工作线（四）：自己结束，结束了去哪看（11-21）

- 新文件 `src/items/lifecycle.ts`：进行中 → 观察中 → 已结束。迁移加 `items.phase`、`phase_since`、`watch_until`，`Item` 多 `phase`、`phaseSince`、`watchUntil`，`LineNow` 多 `summary`、`summaryAt`；配置 `workLines.watchDays`（默认 14）。
- 进入观察不问本人：流程走完（`flows/engine.ts end` 调 `flowCompleted`）、线下都结了且有完成的（`store.ts` 新的 `onItemStatus` 钩子里看子事项关闭）、一个待办期限没动静，或看线的运行交 `submit_line_state` 的 `phase`（`items/line-schemas.ts`，把握 ≥ 0.6）。看线的任务（`channels/listen-assist.ts lineStateTask`）多“这条线在观察中”“本人以前怎么定的”和 phase 的判断说明。
- 结束：心跳里 `lineLifecycleDue`（`agents/jobs.ts`）按守卫结束、悄悄延期或问一次（`line-end` 卡，14 天一条、每天两张）；结束时停关注和指标、下一步过期、排一轮收尾（`queueWrapUp`，`submit_line_state` 交 `summary`，`lines.ts` 里 `lineWrapUp` 的分支）；重新打开时恢复。自动结束的事件以“工作线自动结束”开头，`items/expiry.ts digestFor` 把它算进清点，`digestBody` 单列“工作线已结束”。
- `items/expiry.ts itemExpiry`：显示成线的顶层事项（`tree.ts lineLike`）不再过期。`items/changes.ts` 来源多 `line`。周报（`agents/weekly-report.ts linesEnded`）多一节“本周结束和进入观察的工作线”。
- 接口：`PUT /api/work/:id/phase`、`GET /api/work/ended`；`GET /api/work` 多 `ended`、`endedMore`，线带阶段；`GET /api/work/:id` 多 `phase`、`summary`、`ended`、`openUnder`（`auth/routes.ts` 只给本人）。
- 网页：`web/src/views/Work.vue` 进行中下面是“观察中”小卡和默认收起的“已结束”（按月、搜索、查看更多）；`WorkLine.vue` 的状态点写“观察中 · 到 12/05”；`WorkDetail.vue` 标题下的观察中 / 已结束说明带（收尾小结、重新打开），头部“收尾”打开新组件 `components/WorkPhase.vue`。`lib/work.ts` 多 `shortDay`、`byMonth`、`endedLine`。演示库（`scripts/doc-screens.ts`）多一条观察中的线、两条结束的线，新截图 `work-ended`。

## 工作线（三）：工作页（11-20 夜）

- 首页 `#/` 换成 `web/src/views/Work.vue`：“本月在推进”，按工作线 / 按时间 / 按阶段（流程看板抽成 `components/FlowBoard.vue`，`/board` 只给成员用）；右栏 `components/WorkWaiting.vue` 把等本人的合在一处。原 `Home.vue` 删掉，最近通知和后台运行收在工作页下方。
- 线和工作项的页 `#/work/:id`（`web/src/views/WorkDetail.vue`）：阶段条 `components/WorkStageTrack.vue`、点线时间线 `components/WorkTimeline.vue`、变化卡 `components/WorkChange.vue`、右侧详情 `components/WorkSheet.vue`、编辑 `components/WorkEdit.vue`、问这条线 `components/LineAsk.vue`；流程标签嵌入 `ItemFlowPage`（`embedded`），关注标签嵌入 `ListenDetail`（`id` + `embedded`）。呈现用的函数在 `web/src/lib/work.ts`（`test/work-web.test.ts`）。
- 侧栏“今日”改名“工作”，“流程”打开 `/?view=stage`；本人打开 `/items/:id/flow` 转到 `/work/:id?tab=flow`。事项页改叫“全部事项”，线、有下层的、走流程的事项点开去工作项页。
- `web/src/lib/markdown.ts`：写好的引用链接 `[文字](src:…#L3-L9)` 不再被“裸引用”的替换拆开（11-19 起带范围的引用显示成半截）。

## 侧栏去掉本人的“流程”；工作线卡片头部对齐（11-21）

- `web/src/App.vue`：本人的侧栏不再有“流程”（就是工作页的“按阶段”，流程定义从看板右上角进），成员仍有 `/board`；在 `/flows` 时高亮“工作”。`web/src/components/WorkLine.vue`：“关注中”和“更新”放进一个居中对齐的 `.tools`。截图 `work-overview` 重拍。

## 数据页分“工作数据 / omem 自己”两栏（11-21）

- `web/src/views/Insights.vue` 顶部两栏，`?tab=work|omem`；没有 tab 时带报告筛选或明细的链接落到 omem 一栏，否则是工作数据；报告只在 omem 一栏打开时才请求。新组件 `web/src/components/MetricsBoard.vue`（`scope: work | omem`）。
- `GET /api/metrics` 每条多了 `itemTitle`、`lineId`、`lineTitle`（`rootOf`）；新 `GET /api/metrics/files` 列工作文件里 `数据/`、`观测/` 下的（数据源目录、观测计划、采集记录）。
- `src/data/metrics.ts` 的 `tellChange`：通知带 `graceDone`，通知失败只记日志，时间线和关注会话照写；链接改到 `#/work/<事项>` 或 `#/insights?tab=…&metric=…`。测试 `test/metrics.test.ts`，截图 `insights`、`insights-work`（`scripts/doc-screens.ts` 加了演示指标）。
