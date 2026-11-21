---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-21
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-21 上半天](./changes-2026-11-21-first-half.md)（36 节）：整理第一批（方案、设置页和数据页重做、其余页面整理）、工作线三四期和关注页、指标由本人确认、协同任务板、等本人处理的清单和提问卡的免打扰、按后端能力裁剪常驻说明和云端会话收尾、操作规则和规则包、对象授权、成员在助手里看流程和存规则、插件订阅事项与评审。
- [2026-11-20](./changes-2026-11-20.md)（24 节）：关注（盯群换成关注、从历史学、主动推进）、工作线的事项上下层和现状、演示和 Chrome 扩展的录制、成员用自己的 AI 账号、工作上的指标、每晚复查回复结果、插件设置。
- [2026-11-19](./changes-2026-11-19.md)：编码交办、流程、评审复核、会议、网页、设备和插件回调。
- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 本机 CLI 用一次性凭据发起云端探测

从 `src/auth/cloud-probe-ticket.ts` 看签发与核销。本机 CLI 未配置全局令牌时使用专用凭据，只能发起一次探测，60 秒后失效。

## 云端工具管理需验证本人身份

从 `src/auth/http.ts` 看管理请求的身份校验。本机 CLI 可自动认证，公网反代的放行配置见 `docs/v2/external-access.md`。

## 云端工具探测验证完整请求

从 `src/agents/cloud-probe.ts` 看两种探测。带头模式验证 GET 和 POST JSON，URL 模式要求首个 GET 不带 Authorization，再沿 next 地址提交查询参数。两者都要求读回最终回执，旧探测需要重新确认。

## 2026-11-21 · 云端后端按运行读取材料

本人可为指定云端后端启用少数只读工具，先探测公网回执，再确认。凭据限一次运行的成员、空间、名单、时长和次数。运行页显示调用，审计记录签发与作废。从 `src/agents/cloud-probe.ts` 看探测和准入，从 `src/agents/cloud-tools.ts` 看凭据与调用。[配置和接口](../../../docs/v2/external-access.md#云端后端调只读工具)。

## 2026-11-21 · 变化台账：一件事只记一次、谁接手了、本人取舍过什么

- 幂等写入：`src/items/changes.ts` 的 `recordChange` 是 `item_changes` 唯一的写入口（`addChange` 是它的包装）。键是“来源 + 事项 + 类型”：聊天的行换成飞书消息 id（同一条消息在两份原件里是一个键），文档的行按那几行文本的哈希，宿主自己的事件用自己的键（`problem:`、`metric:<id>@<点的时间>`、`stage:`、`review:`、`commits:`、`meeting:<id>#L…`）。同一个键再来：说法相同不动；更具体的（补了日期、细节、风险、更完整的一句）更新原行，`added` 记谁补了什么；本人处理过的（并进 / 另开 / 不用）不改说法；同一次运行用不同说法交的、提议不同日期的各留一条（键加 `~2`）。各写入方能拿到的来源列成表写在 `changes.ts` 开头。item-follow、`upsert_item` 的 `change_type`、在跟的问题、指标、流程阶段都经它；评审结论（`review-chain.ts`）和提交认领（`commits.ts`）也记进时间线了。旧行没有键照常显示。
- 处理归属：`src/core/handling.ts`。处理记录就是已有的 `handled_messages`，各路的行多了 `actor / decision / change_id / reason`，让开记成 `yield:<路>`；规则的 `rule_handled` / `rule_firings` 一起读。回复的顺序 `REPLY_ORDER`：当场回答 → 规则 → 关注 → 有人找你。规则遇到 @ 机器人的消息、关注遇到已经当场回答的、有人找你遇到规则或关注接手的，都记让开和原因；关注的批次里前面的路已经接手回复的消息，说明里写“只记下不回”（行为变化：规则把消息交给了 Agent、关注或唤醒的会话时，读这个群的关注不再另回一遍；只转发、通知、拉机器人或采集的规则不算接手回复，还没判完的规则也不让关注让开，这两种情况关注照旧）。`read_source` 读群聊时列出这一段已经被处理过的消息；`TurnContext.handled` 带这一轮触发消息的处理记录。线的页面（`GET /api/work/:id`）每条变化带 `runId / sourceKey / added / yields`，页面多 `yielded`；时间线卡片（`WorkChange.vue`）一个小的“几处补充 · 几处让开”，悬停或点开看。
- 关注的经验给直接 @ 机器人：`watch-trial.ts` 的 `watchExperience`（相近案例、经验文件、本人对回复的决定，预算 `WATCH_EXPERIENCE`）同时给盯群批次和 `directExperience`；后者放进这一轮的消息，选了哪些记在运行的 `watchExperience`。访客（不是用户的人、`asker`、guest 运行）不带，成员只拿自己能读的空间里的关注。
- 会议的结果：`src/agents/meeting-outcomes.ts`。会后整理那一轮的任务列出已确认关联（关注把会交给的事项、会议所在的群挂在哪件事上、会议记录已经是哪件事的材料）和只是像的事项；新工具 `meeting_outcomes`（ROLE_TOOLS，只给会后整理）交决定 / 待办 / 没定的问题，引用会议记录的行，写成 `decision / todo / question` 三类变化。没确认关联的先问本人（“记到这件事 / 不用”，同意后把会议记录挂上）。事项本身改期会上定了才改，否则问“改成这个时间 / 不改”。
- 本人取舍：`src/items/choices.ts`，表 `owner_choices`（随拉取同步）。回答提问的共同路径（`asks.ts recordAnswer`）记取舍：提问上下文带 `choice`，或按处理器登记的读取（每晚的工作线提议卡、“今天”）；事项页的候选、数据页的指标、档案改动的拒绝也记。提出之前先查 `mayPropose`：工作线提议、线要不要结束、候选事项、指标提议、档案改动、会议结果候选；“情况变了”的标准写在 `CHANGED` 一处。`pendingMetrics`、`pendingProfileProposals` 滤掉以后再说没到期的。`TurnContext.choices` 带这条线最近的取舍。
- 迁移一项 `CHANGE_LEDGER_MIGRATION`（`db.ts` 末尾）。测试 `test/change-ledger.test.ts`、`handling.test.ts`、`watch-experience.test.ts`、`meeting-outcomes.test.ts`、`owner-choices.test.ts`。

## 2026-11-21 · 工作项上的“需求到交付”

- `src/items/chain.ts`（`GET /api/items/:id/chain`，权限同事项详情 `items.view`）：只读已有关联拼四段。需求 = 事项的 `req` 材料（`req_status` 的实现状态、`req_tests` 的测试，含子节点）；发现 = `study_findings`（不含重复的）；方案 = `designs.item_id` 和事项的交办的 `designs.work_id`，决定的 `reqs` 写的是事项的需求点 id 才连；交付 = 事项的 `run` 材料里的编码交办、发现和方案的 `work_id`，状态用 `code-works.ts listCodeWorks`，测试 `testsOfWork`，发现发起的交办加改后重跑结果；`req_status.run_id` 落在某次交办的轮次里、或测试记在某个需求点上，就连回那个需求点。事项挂的平台对象（合并请求）列在交付里，不连。每条 `links` 只指前面几段的条目。线（有子项）按子项分组，同一条只出现一次；上限 `CHAIN_MAX`（每段 12、每条线 12 组、看 60 个子项）。别的空间的需求和方案、看不到的交办不带出来。
- 网页 `web/src/components/ItemChain.vue`（纯函数在 `web/src/lib/chain.ts`），挂在 `WorkDetail.vue` 流程那块下面和 `Items.vue` 的“外部状态”下面；默认收起成一行数，四段都空时不出现。需求节点详情（`/api/requirements/:id` 多了 `items`）在标题下写“属于工作项：……”。
- 串不起来的：发现没有记需求点；平台对象没有记属于哪次交办；流程阶段的验收结果没有读进来。测试 `test/item-chain.test.ts`、`test/web-chain.test.ts`，截图 `item-chain`。

## 2026-11-21 · “今天”并进简报、复盘提的改动、AI 提议的指标，周五带周报

- `src/items/today.ts` 多了几段，各从一个取数函数来：**简报**是卡的开头一段（kv `today_brief`，按日期）；**复盘提的改动**读 `pending.ts pendingProfileProposals`（快过期的排前面并写哪天过期；改设置的 `a_<id>` 采纳 / 不要，走 `proposals.ts applyProposal` / `rejectProposal`；改提示词、写技能的只给 Agent 页的链接）；**AI 提议的指标**读 `pending.ts pendingMetrics`（`m_<id>` 留下 / 不要，走 `defineMetric` 的 active / dropped）；周五这周的周报写好了就在末尾链过去（`weekly-report.ts weeklyReportFile`）。上限 `TODAY_MAX.profiles` 3、`metrics` 4，多的写“还有 N 条在 Agent 页 / 数据页”。“等你处理”那段不再数档案和指标。
- `pending.ts`：档案提议和指标的查询拆成 `pendingProfileProposals` / `pendingMetrics`，`pendingView` 和“今天”共用（工作页右栏照旧是计数的一行）。
- 简报（`jobs.ts` 的 `brief`）：“今天”开着时任务第一行写“并进今天”，运行不给 `notify`，最后一条消息交给 `today.ts attachBrief`：卡还没发就等着；卡已发、还没答就改同一张（`reviseAsk`，飞书上更新原卡）；那天没别的事就单发一张只有简报的“今天”；卡已经答过了才照以前发一条“简报 · 日期”的通知。`roles/brief.md` 分“并进今天”和“单独发”两种写法：并进时只写清单表达不了的（最要紧的两三件和为什么、已备好的、清单里没有的变化），不再列到期事项和待答的问题。
- “今天”开着时 `profile-review` 不发“有 N 条改进建议待确认”，`expireProposals` 记下提醒时间但不发“两天内过期”的通知；关着时都和以前一样（`test/proposal-expiry.test.ts` 按关着测）。测试在 `test/today.test.ts`。

## 2026-11-21 · 远程页：把会话交给成员

- 会话主人在画面上方点“交给成员”，在右侧抽屉（`web/src/components/RemoteGrants.vue`）里选人、只看或可操作、多久，已交给的人一行一个，可改模式、从现在起延长、收回（`confirmDialog`）。候选人由 `/api/users` 和每人的 `/api/members/:id/capabilities` 里的 `remote.view` / `remote.operate` 算出（`web/src/lib/remote-grants.ts`）。
- 被授权的人：侧栏“远程”在有 `remote.view` 或 `remote.operate` 时也出现（`App.vue` 的 `addRemotePage`）；`Remote.vue` 按 `desktop.control` 收起新开、关闭、录制、画面设置和助手栏，只看时去掉地址栏。页面每 15 秒和授权到期时重读 `GET /api/remote`，交给他的会话不见了就写“××收回了这次授权”或“授权到期了”；模式改了就重开画面。
- 会话标签标出“交给 N 人”“助手”“××的”，助手开的会话画面上方链到那次运行。
- 已知：成员直接打开 `#/remote` 会被送到问答（`App.vue` 的页面守卫在 `addRemotePage` 之前判断，这次没改守卫）。演示数据里远程会话和授权接口是桩（演示机器起不了 aad），截图 `remote-grants`。

## 2026-11-21 · 插件检索、原件格式和页面类型的网页

- 设置 → 检索与记忆 加了“插件参与检索”（`web/src/components/SearchProviders.vue`）：读 `GET /api/search/providers`，逐个打开召回、限定空间，选用哪个重排，选了插件重排时可填 `rerank.pluginPassiveThreshold`。保存走设置页的 `saveConfig`（整份 `search` / `rerank`）。没有插件提供者也没配过时整张卡不出现。
- 原件带 `meta.display` 时，原件页默认按表格或条目显示（`web/src/components/SourceStructured.vue`，切行和行号在 `web/src/lib/source-display.ts`），超过 300 行用 `VirtualList`。选中一行只是把行号写进地址的 `from` / `to`，引用格式和引用抽屉不变；有 `display` 的原件一次读全文，因为行号指向整份正文。元信息写解析器的名字，找不到时写“读它的插件停用了”。
- 设置 → 采集 → 其他平台 末尾列出解析器（`web/src/components/SourceParsers.vue`）。Wiki 页头显示类型（`GET /api/wiki/kinds` 找名字，找不到照原样写），编辑和“写一页新文章”可以选类型；接口不给模板正文，所以没有“用模板开始”。
- 演示数据（`scripts/doc-screens.ts`）加了一个进程内注册的检索插件、一个解析器插件（两份原件、一个页面类型和一页 Wiki），截图 `search-providers`、`source-table`。

## 指定了思考强度的运行偶尔一开始就失败（11-21）

- 现象：本人指定了模型和强度的交办，开始时报“该 Agent 不支持设置 effort，无法使用指定值 high”，重试就好。运行记录里从建好会话到报错不到一秒：适配器在模型列表还没加载完时就开了会话，那一刻列出的设置项里没有强度。
- `src/agents/acp.ts`：找不到强度的设置项时，按会话现有的模型再选一次拿回最新的设置项；本人指定了强度的运行隔一会儿再取（300 毫秒起，逐次加倍），也接适配器主动发来的 `config_option_update`，最多等 12 秒，仍然没有才报错。没有指定强度的运行只取一次，不等，照旧用后端的默认值。等过的运行在状态里留一行“思考强度的选项过了 N 秒才出现”。
- 头一版只重新取一次（同一天早些时候），在常驻服务器上又出了一次同样的失败，所以改成等。测试在 `test/stall.test.ts`（假 Agent 的 `FAKE_LATE_EFFORT`）；真实后端上是否就是这个原因，要看之后的运行里有没有那行状态。

## 2026-11-21 · 多人操作同一浏览器页面

主人和获得操作授权的成员可以直接交替输入。每份操作授权在连接期间使用独立的 aad 控制器，画面和剪贴板都对应同一标签页。见 `src/remote/proxy.ts`。

## 2026-11-21 · 浏览器会话交给成员

远程会话支持有期限的只看或操作授权。管理和列表从 `src/remote/http.ts`、`grants.ts` 读起；画面按会话和模式校验，断开和过滤在 `proxy.ts`。技能打开的浏览器登记到运行，来源校验在 `agent-browser.ts`。接口和返回示例见 `docs/v2/remote.md`。

## Wiki 按类型到期复查（2026-11-21）

从 `src/wiki/upkeep.ts` 读起。调度保留页面到期原因，通过 `wiki-lint` 的指定页面复查入口交给核对角色，即使引用的原件没有更新也会核对。

## 仓库基线采用原件解析器（2026-11-21）

从 `src/sources/code-baseline.ts` 读起。仓库同步把 Git blob 交给文件导入使用的解析器；已索引的文件在解析器版本或选择变化时重新读取，保留原件 ID。

## 插件定义原件格式和 Wiki 页面类型（11-21）

- 上传、目录导入和 URL 导入按插件匹配规则选择解析器。原件保存 Markdown、解析器版本和结构化行范围。读 `src/plugins/formats.ts`、`src/sources/import.ts` 和 `src/sources/import-process.ts`。
- 插件可定义 Wiki 模板、校验和维护间隔。规划在 `src/agents/jobs.ts`，写作在 `src/wiki/verify.ts`，按类型核对在 `src/wiki/upkeep.ts`。两个完整示例在 `examples/plugins/formats`。

## 被动记忆的插件门槛（11-21）

在 `src/core/config.ts` 查看可选的 `rerank.pluginPassiveThreshold`。它接受任意有限分数，省略时沿用原门槛。
`src/memory/passive.ts` 按本次出分来源筛选记忆，回退时使用本地门槛。

## 插件回退后按本地模型精度排序（11-21）

`src/search/rerank.ts` 统一检查整批候选的发送权限，并把本次实际打分的提供者返回给调用方。主搜索对本地分数保留三位小数，插件保留原分。设置中的 `lastProvider` 使用同一个评分来源。

## 共享设备调用检索插件（11-21）

共享设备按共享空间和材料种类使用召回与重排，受限原件和要求在本机核对权限的文档留在本机。内置路线与插件路线的命中在去重、截断前统一检查共享可见性，`src/auth/visibility.ts` 按候选原件 id 合批核对。授权入口见 `src/core/federation.ts`，插件候选检查见 `src/search/providers.ts`。

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

## 事项同步的网页（11-21）

- 设置 → 推进工作 多一张卡“事项同步”（`web/src/components/ItemSyncSettings.vue`，`?card=item-sync`）：一行一个订阅（目标、平台 → 空间、导入了几件、多久前读过或“上次没读到”），展开改“新条目”（先当候选 / 直接建）、“这边改了状态”（先问我 / 直接写回，只读的平台没有）、暂停和“现在读一次”；“订阅”先 `PUT /api/item-sync` 再读第一遍。没有插件提供平台、也没有订阅时不渲染。
- 事项详情和工作页多一块“来自……”（`ItemExternal.vue`）：条目的编号、标题、那边的状态、上次读的时间；没写回的状态按它的四种情况（等确认、等下次同步、冲突、失败）给按钮，走 `POST /api/items/:id/writeback`。
- 服务端：`GET /api/item-sync` 的目标带 `items` 和 `synced_at`，数据源带 `targetHint`（`ItemProvider.targetHint`，GitHub 插件填了）；`externalView`（`src/items/providers.ts`）给 `GET /api/items/:id` 和 `GET /api/work/:id` 同一份 `external`，多了 `providerLabel`。
- 演示数据加了一个虚构的“示例工单平台”（只注册数据源，不订阅），截图 `item-sync`、`item-external` 排在最后，经页面订阅和改状态拍出来；类型在 `web/src/lib/item-sync.ts`。

## 全局 owner 启用普通规则（11-21）

所有全局 owner 账号都可在网页或助手会话中直接启用普通定时通知规则。调度随保存生效。启用确认的角色判断见 `src/rules/store.ts`。

## 读取不可见事项的流程（11-21）

成员读取事项流程时，空间不可见与事项不存在都返回 404。流程路由的能力检查在 `src/auth/routes.ts`，事项的对象授权在 `src/items/access.ts`。

## 成员在网页启用规则（11-21）

成员在网页或助手中新建规则、重新打开停用规则时，先保存为停用。主人私聊收到对应版本的确认卡，点击启用后定时调度才生效。保存与调度从 `src/rules/store.ts` 读起，网页与助手共用的确认入口在 `src/rules/confirmation.ts`。

## 成员请求立即启用通知规则（11-21）

`src/rules/store.ts` 的 `saveRule` 按执行账号和规则保存前的状态决定是否启用。成员助手新建规则、修改已停用的规则时，规则保持停用，由系统主人确认后启用。

## 通用流程的事项推荐（11-21）

`src/flows/definitions.ts` 的 `flowsFor` 与成员开始流程共用适用条件。适用空间为空列表和省略时含义相同，推荐仍按事项类型筛选。

## 成员开始流程时检查定义（11-21）

网页和助手都从 `src/flows/engine.ts` 的 `startFlow` 启动。成员只可为自己的事项启动可见且适用的流程。隐藏定义按不存在处理，检查通过后才复制阶段。

## 其他 owner 账号在助手里查看流程（11-21）

从 `src/agents/tools.ts` 的 `callTool` 读起。账号拥有全部空间能力时，工具沿用运行的空间范围。其他 owner 账号列流程和获取推荐时也使用这个范围。

## 成员在助手里查看流程（11-21）

网页和 `list_flows` 共用 `src/flows/definitions.ts` 的空间判断。工具按本轮空间进一步筛选，事项推荐只使用筛选后的定义。

## 成员在对话里保存规则（11-21）

`src/agents/tools.ts` 的 `save_rule` 用来源会话解析“这个群”。成员保存普通通知规则时投递目标留空，已有规则保留原目标。成员发起的启用确认由系统主人处理，飞书把卡片发到主人私聊。

## 成员查看运行写入记录

历史事件和实时事件共用成员视图。只有能读取目标对象的人才能看到写入链接；规则动作在只读视图里只显示类型。从 `src/agents/run-writes.ts` 读起。

## 成员按能力读取工作和评审（11-21）

`src/auth/capabilities.ts` 定义能力、作用域和旧权限映射。从 `src/auth/routes.ts` 看接口登记，从 `src/items/access.ts` 和 `src/auth/run-scope.ts` 看对象和列表的范围。观察者读取共享工作线与事项；运行记录、评审差异与事件流检查完整运行范围。成员管理接口的请求示例见 `docs/v2/multi-user.md`。
