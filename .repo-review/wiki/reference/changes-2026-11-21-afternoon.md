---
title: 2026-11-21 午后的变化
kind: reference
updated: 2026-11-22
---

## 插件接入召回和重排（11-21）

从 `packages/plugin-sdk/server.ts` 看注册接口，从 `src/search/providers.ts` 看空间、调用预算和状态。`src/search/search.ts` 按 id 回读后参与 RRF 融合，`src/search/rerank.ts` 在同一入口为主搜索与被动记忆选择重排器。配置和状态字段见 [接进检索](../../../docs/v2/plugins.md#接进检索)。

## 早上一张“今天”：下一步、清点、夜里的提议合成一张（11-21）

- `src/items/today.ts`：宿主拼一个 ask（处理器 `today`），不起模型。四段：等你处理（`pendingActions` 按种类计数、列三条，不带按钮）、各条线（`now.text`、三天内到期、`lines.ts newNextSteps` 的下一步）、夜里整理出来的（`heldProposals` 读 work-state 运行输出里的 `lineProposals`、`pendingCandidates`、`digestFor`、夜里问的 `line-end`、`replayDigest` 的建议）、不急的通知（只计数）。字段 id 带前缀（`n_` 下一步、`p_` 提议、`c_` 候选、`r_` 恢复、`k_` 保留、`e_` 线要不要结束、`x_` 复盘），每段有上限（`TODAY_MAX`），表单最多 30 项。
- 提交时逐项交给原来的处理：`decideNext`、`decideProposal`（从 `line-propose` 处理器里抽出来，两处共用）、`decideCandidate`、`keepItem`、`answerAsk` 回答那条 `line-end` 自己的 ask、`resolveEffect`；状态已经变了的跳过；结果写进 ask 的 `result`。新的一张发出时，前一天没答的“今天”取消。
- 开关 `notify.today`（`{ enabled, at }`，默认开、09:30，`config.ts`）。入口：巡检调 `today.ts morningDue`（开着走 `todayDue`，按日期记 kv `today_card_day`；关着走原来的 `lineNextDue`）；`item-digest` 定时任务走 `jobs.ts itemDigestDue`（开着时 `sendItemDigests(app, { except: [OWNER] })`，本人的复盘段也不在这里消费）；work-state 结束调 `proposalsDue`（开着不发 `linesCard`，提议留在运行输出里，kv `line_propose_run` 记已经问过的那次运行）。
- `src/items/today-time.ts holdForToday`：免打扰里问的 `line-end`，飞书出口本来会延到免打扰结束（`deferredUntil`），开着“今天”时改延到“今天”的时间并标 `forToday`；“今天”带上它后去掉 `deferredUntil`、记 `inToday`，没答的只留在网页的待处理里。白天问的照旧。
- 表单分组：`UiField` 多一个只给宿主用的 `group`（`ui-blocks.ts` 的类型，不进给 Agent 的 schema；`packages/plugin-sdk/blocks.ts` 同步）。`lark-asks.ts cardFields` 把它带到 `CardField.group`，`lark-send.ts formFields` 在组变化处插一行标题、分组时不编号；`web/src/components/UiFields.vue` 同样插标题。
- 网页：`WorkWaiting.vue` 与 `pending.ts` 的种类加“今天”；设置 → 通知与打扰（`NotificationSettings.vue`）加一行开关和时间。演示库（`scripts/doc-screens.ts`）发一张“今天”，新截图 `today-card`；`work-overview`、`work-timeline`、`work-ended`、`item-external` 因右栏和候选变了重拍。测试 `test/today.test.ts`。

## 管成员的人进得了成员页；成员直接打开深链接不再被送回问答（11-21）

- `web/src/App.vue`：判断“这一页他能不能开”要等路由把打开时的地址解析完（`router.isReady()`）。页面按需加载，解析完之前路径还读作 `/`：成员从通知或卡片里的链接直接打开某一页时，会被当成开了没有权限的首页，送回问答。
- 设置入口对有 `users.manage` 的人也出现（标题“成员与记录”）：只有 成员、安全（只有“记录”）、外观与说明 三个标签，不读本人的配置；`views/Settings.vue` 的可见标签改成按当前用户算，并等 `/api/me` 回来再决定。成员页（`MembersSettings.vue`）读不到登录设置时只显示邀请、成员和角色。
- 只被单独给了 `settings.members` 能力、没有 `users.manage` 的成员仍进不了：列成员、邀请这些接口还认旧权限（服务端后续要统一）。

## HTTP 规则的判定入口：浏览器里的请求发出前来问（11-21）

- `src/agents/http-gate.ts`：`httpWatch` 给出这个调用方现在要问哪些请求（生效的、动作不是放行的 HTTP 规则的主机和方法，带 `revision`），`httpGate` 判一个请求（JSON 请求体才参与 `body.jsonPath`），走命令同一个 `gateOperation`。接口 `GET / POST /api/operation-gate/http`，和命令垫片同样只认本机带运行令牌的请求。
- `gateOperation`（`command-gate.ts`）对 HTTP：卡片和审计里请求写成“方法 主机 路径”，卡片写“Agent 操作的网页要发出受保护的请求”和所在页面；`pending` 的回答带 `askId`。`operation-policy.ts` 的 `enforcedBy.http` 改成 `["browser"]`，`ruleApplies` 从 `decide` 里提出来共用。
- 网页：HTTP 规则不再标“还没有执行点”（连旧服务端时仍标），编辑里说明它在 aad 操作的浏览器里生效、管不到别的途径。
- 执行点在 aad 那边（请求闸门，另一个仓库），两边还没连起来跑过。测试 `test/http-gate.test.ts`，设计在 `docs/v2/command-gate.md` 的“网页请求”。

## 网页按成员能力显示（11-21）

- 设置 → 成员：每行行尾“能做什么”，打开 `web/src/components/MemberCaps.vue`（右侧抽屉）：预设（全局角色）加一句说明，能力按区域分组，每项写有没有和从哪来（预设带的 / 空间角色带的 / 单独给的 / 单独不给 / 部分空间有），用 `UiSegmented` 选跟预设 / 允许 / 不给；按空间的能力展开他能读的空间逐个另设。整份 `PUT /api/members/:id/capabilities`，底部一句话写改了什么，关闭时有未保存改动用 `confirmDialog` 问。成员行显示“另设 N 项”（每人读一次 `GET /api/members/:id/capabilities`）。
- `web/src/lib/caps.ts`：`hasCap`、`capIn`、`capAnywhere`（`own` 用 `ownSpaceCaps`）、`hasPerm`；本人和 `state.me` 还没读到时为真，`/api/me` 没有 `caps` 时退回旧权限（`member: true` 的页面照开、规则看 `agents.manage`）。store 用 `followMe` 把 `state.me` 交给它。测试 `test/web-caps.test.ts`。
- `App.vue` 的侧栏每项写要的能力；打开没有能力的页面不再先渲染（以前会先发请求、弹“没有权限”再跳回问答）。
- 别人看工作页（`views/Work.vue`、`WorkDetail.vue`）：服务端给的是 `sharedLines` 的精简结构，`web/src/lib/shared-work.ts` 转成页面用的 `Line` / 详情；收起本人才有的部分，`WorkLine`、`WorkChange`、`WorkSheet` 加 `readonly`。
- `views/Rules.vue`：没有 `rules.edit` 时是只读清单，只用 `ruleSummary` 的字段。
- 事项详情按 `can.edit` / `can.operate`（没有 `can` 的旧服务端按“是不是自己的”）；`ItemMaterials` 加 `readonly`；运行页交办按 `code.delegate`，停止重试按 `can.operate`；`CodeWork` 的下一步动作、追加要求、修改点、分支落地按 `can`；Wiki 写页、需求树编辑按 `state.me.wiki` / `writes`。
- 演示数据加小周（只读观察者）、小林（成员，另设三项）、小吴（成员），`--serve` 打印他们的演示令牌；截图 `members-capabilities`、`observer-work`。

## 评审页：问题同步到平台的状态和入口（11-21）

- `web/src/components/ReviewSync.vue`，挂在 `ReviewSummary.vue` 的“待处理问题”标题下：读 `GET /api/runs/:id/review-sync`，写发到哪个对象、已发 / 没发 / 作者回复 / 没发出去 / 要重新定位各几条；“发布 N 条…”“结束已修的 N 条…”调对应接口，用返回的 `askId` 从右侧打开确认（`AskCard`），“读讨论”调 `refresh`。有几个对象时先选发到哪个。没有对象也没有发过的评论时不渲染。
- `web/src/lib/reviews.ts`：`External` 补 `delivery`、`error`、`reply`，`externalBadge` 把一条问题在平台上的状态说成一个标签（没发出去、要重新定位、评论开着、作者回复了……）；作者的回复显示在问题下面。
- 演示数据：评审的事项挂一个 GitHub 合并请求，四条问题各在一种状态；截图 `review-sync`。

## 成员的 AI 账号：能不能隔离和严格模式的开关（11-21）

- `web/src/components/AgentAccountsAdmin.vue` 读 `GET /api/agent-accounts` 的 `isolation`：第一行写这台机器能不能把成员的运行和本人的分开（不能时写原因），第二行是“成员的运行不能隔离时”：照常运行并记一笔 / 不运行（`agents.accountIsolation`，经 `views/settings/Members.vue` 的 `saveConfig` 保存），下面一句列出分不开的后端和原因。这张卡以前只在能起沙箱的机器上出现，现在不能隔离的机器上也出现（只有这几行）。
- “已登录的成员”只列登录过某个后端的人。

## 评审问题同步到合并请求（11-21）

评审结束后，本人可以在确认卡选择事项关联的合并请求和要发布的问题。平台回复会回到运行；复审判为已修后，再由本人确认结束讨论。从 `src/agents/review-sync.ts` 读确认和回读链路，接口类型在 `packages/plugin-sdk/server.ts`，GitHub 参考实现在 `plugins/github/server.ts`。

## 助手提交后切分支的多仓交付（2026-11-21）

从 `src/agents/member-git.ts` 的 `inspectUnreceivedMemberGit` 读起。助手收尾遇到拒收时，宿主分别核对当前 HEAD 和登记分支相对上次接收点的提交。任一引用读失败仍保留另一边的标签，并记下归属待核对。跨仓项只交付了一部分时退回待做，独立完成的项照常进检查点。

## 助手拒收提交的归属（2026-11-21）

从 `src/agents/member-git.ts` 读起。宿主分别检查工作树状态和未接收提交的标签。状态输出超限时，未交付的修改项仍按提交标签退回，工作树保留供核对。

## 成员交办的工作树交付（2026-11-21）

从 `src/agents/member-git.ts` 读起。主编码和助手完成修改项时，宿主接收成员已有提交，并把工作树余下的改动补交到同一项。主编码用 `name_work_branch` 命名临时分支。多仓前检查只读挂载，解冲突由宿主按文件暂存。助手的安装记入运行审计，某仓拒收时仍合入其他已接收的提交，见 `src/agents/code-helpers.ts`。

## 成员在沙箱内提交（11-21）

主编码和助手各自在本轮仓库的私有 Git 目录提交。`finish_task` 校验提交对象、分支和预期基点，再把提交接到宿主工作树。挂载从 `src/agents/workspaces.ts` 读起，接收在 `src/agents/member-git.ts`。

## 成员交办的身份、沙箱和宿主命令（11-21）

主编码、助手、评审和后续轮次使用交办发起人的身份。账号选择和严格模式从 `src/agents/accounts.ts` 读起，挂载计划见 `src/agents/sandbox.ts`。宿主准备依赖和检查在 `src/agents/code.ts` 留下成员与交办记录。设备代跑的命令规则在 `src/core/peer-acp.ts` 接入执行节点。配置和验收见 `docs/v2/agent-accounts.md`。

## 设置 → 安全 → 记录（11-21）

- `audit_events` 以前只有 `GET /api/access/audit` 原样返回最近 200 条，没有页面读它。新加 `src/auth/audit-view.ts` 的 `auditRows`：把每条记录说成“谁、做了什么、对谁、结果”，成员、群、空间和关注显示名字，规则带标题（没标题的用它匹配的东西），分四类（`ops` 规则的判定和批准、`identity` 以本人身份发出的、`access` 成员登录分享、`other`），按 id 往前翻。规则判定的行，执行人写成“某人的运行”；批准和拒绝写做决定的人。认不出的动作照原名显示。
- 接口 `GET /api/security/audit?group=&before=&limit=`（要 `users.manage`）；`detail`（当时记下的原样内容）只给本人。
- 网页 `web/src/components/AuditTrail.vue`，在 设置 → 安全 最下面（`?card=trail`）：一行一条（颜色点表示放行 / 等批准 / 拒绝），右上按类筛，点开看原样内容和“看这次运行”。
- 演示数据加了十一条虚构的记录，截图 `security-audit`；测试 `test/audit-view.test.ts`。

## 工作页文字里的事项和运行 id 显示成标题（11-21）

- `GET /api/work/:id` 多一个页面级的 `refTargets`：`textTargets`（`src/items/changes.ts`）扫目标、现状、每周一句、收尾原因、下一步和变化的文字，认出本人的事项（`i0m…`）和运行（`r0m…`）id，配上标题；认不出的、别人的不给。
- `WorkDetail.vue` 把它并进 `targets`，现状那一句和四周各一句改用 `RichText` 加 `readableIds` 渲染（原来是纯文字），下一步的依据也用页面级的那份：id 变成“事项：标题 / 运行：标题”的链接，提交号和路径变成小号等宽。
