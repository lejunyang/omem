---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，按模块列出入口文件；读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-10-18
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。

## 记忆

- **写入检查、复核、对比运行**（10-18）：`src/memory/quality.ts`、`roles/memory-reviewer.md`、`jobs.ts` 的 `memory-review` / `ingest-shadow`，网页“记忆 → 质量”，`omem memories stats|check|prune|rejections`。详见 [记忆与事项](../concepts/memory-and-items.md) 的“记忆质量”一节。
- **记忆记录写入来源**（10-17）：`memories.agent_profile / model / effort / run_id`，由工具令牌带入。10-18 修正了兜底重试时令牌记录的仍是主模型的问题（`runner.ts` 的 `runRole`、`sessions.ts` 的兜底分支）。
- **档案专属记忆与标签**（10-18）：`memories.agent`、`memories.tags`；`recall` 可按 `tag` 筛，档案只看到共享的和自己的。
- **写法要求**：`roles/_common.md` 的“怎么写记忆”重写，ingest 先按“和本人有关、以后能直接用、确定”三问筛。

- **相关空间**（10-18）：`space_relations` 表与 `relatedSpaces` / `relateSpaces` / `unrelateSpaces`（`src/core/spaces.ts`）。限定在一个空间的运行对相关空间只读（`runner.ts` 的 `readable`/`writable`，工具层 `writeSpace`、`inScope`）；`search`/`scan`/`find_symbol` 默认带上相关空间；`remember` 和记忆复核会列出相关空间里的相近记忆（`quality.ts` 的 `similarMemories`）；定期整理的候选来自 `src/core/space-candidates.ts`，由 dreamer 用 `relate_spaces` 决定。空间类型 `topic` 在界面上改叫“通用”。

## Agent 与模型

- **交办同时改多个仓库，worktree 改动可检索**（10-19）：`delegate_code` 的 `repo_spaces`（数组）、`check_commands`、`space`；`/api/delegate` 加 `repos`；`omem delegate --repos`。每个仓库一个 worktree（`runs/<id>/work/<空间>`），补丁按仓库存 `patches/<空间>.patch`，运行输出 `worktrees`、`repos`（旧运行的 `worktree`/`changes.patch` 仍认）；应用时全部先检查再一起应用，之后删 worktree。改过的文件建索引到临时空间 `wt-<运行id>-<仓库>`（类型 `worktree`，`src/agents/worktree-index.ts`），评审可读；`listSpaces` 默认不含它，`writeSpace` 拒绝写入，`omem pull` 不合并；应用、丢弃或 `repo-sync` 发现 worktree 不在时连同索引删除（`sweepWorktreeSpaces`）。运行页交办可多选仓库，详情按仓库显示检查和 diff。

- **按任务配置模型与强度**（10-16）：`config.agents.roleModels[角色][后端]`，`src/agents/models.ts` 的名称归一化（`GPT-Sol-6.1` 能对上 `gpt-6.1-sol`），会话级 `/model` 命令和飞书 `/model` 卡片（`src/channels/lark-model-card.ts`），网页 设置 → Agent → 按角色指定。10-18：Agent 档案回答的会话里 `/model save` 改写档案本身。
- **排队识别与兜底链**（10-16、10-17）：`config.agents.fallback`、`queueTimeoutMinutes`；`acp.ts` 从原始流识别 traex 的 `queue_begin`，区分“迟迟不开口”和“中途卡住”，前者走兜底（`runner.ts` 的 `fallbackProfiles`、`isRetryableAgentError`）。
- **静默运行**（10-16）：`runs.quiet`，巡检/做梦/整理返回 QUIET 时不进运行列表。
- **25 个内置 ACP Agent 与官方注册表**（10-14）：`src/agents/catalog.ts`、`omem agents registry|add`。

- **Windows 上新版 Claude Code 启动失败**（10-18）：它的 npm 垫片指向原生 `claude.exe` 而不是 JS 脚本，原来退回 `cmd /s /c` 时路径里的空格把命令拆坏（`'C:\Program' 不是内部或外部命令`）。`npmShimTarget` 现在也认 `node_modules\…\*.exe`，直接运行它（`src/agents/spawn.ts`）。
- **codex-cli 后备调不了 omem 工具**（10-18）：`codex exec` 的审批策略是 never，MCP 工具默认要审批，所以每次调用都被拒（`MCP tool call requires approval, but approval policy is never`）。`codexArgs` 现在加 `-c mcp_servers.omem.default_tools_approval_mode="approve"`，只放行 omem 这一个服务器，档案里额外配的 MCP 服务器不变，沙箱仍是 read-only / workspace-write（`src/agents/cli.ts`，测试 `test/cli-args.test.ts`）。

## 飞书

- **消息结构化、引用、图片与历史回溯**（10-18）：`src/channels/lark-messages.ts`、`lark_messages` 表、`lark_cursors.oldest_ms / backfill_to_ms`、按月的历史原件；网页聊天视图 `ChatView.vue`。
- **会话类型与采集方式**（10-18）：单聊、机器人单聊、普通群、话题群、omem 自己的机器人；免打扰；`lark.capture.policies` 与单会话覆盖。见 [渠道](../concepts/channels.md)。
- **免打扰不自动采集**（10-17），10-18 修正了“@我”补采只排除订阅群、不排除已读群导致重复的问题。
- **事项卡片**（10-16、10-18）：事项提醒发带“已处理/忽略”按钮的卡片；引用回复精确定位事项（`src/channels/lark-actions.ts`、`roles/_common.md` 的“事项与本人的回复”）。
- **setup 扫码建/绑机器人**（10-15）：`src/channels/lark-setup.ts`，App Secret 存 `secrets/lark.json`。
- **工作渠道**（10-14）：机器人消息工具、进度卡片、卡片回调、监听群、全量采集、日程、妙记、代码活动。

- **引用回复字段**（10-18）：真实 lark-cli 返回的引用回复是 `reply_to`，此前只认 `parent_id`/`upper_message_id`，聊天行的“↩ 回复”一直没出来；`parentOf` 现在先取 `reply_to`。远程 `lark-raw` 加 `types` 参数，能列出单聊。
- **飞书文档本地化**（10-18）：`src/channels/lark-docs.ts` 把文档里的图片、画板、视频/附件下载到 files/（正文写 `omem-file:`），内嵌表格转成表格，同步块读出原文，分栏/高亮块/按钮/书签/勾选/子页面列表转成 HTML（表格里的图片和链接写成 HTML 的 `<img src="omem-file:…">`、`<a href="src:…">`，网页 `web/src/lib/markdown.ts` 渲染前换成本地地址）；链接的文档一并导入（默认两层，`lark.capture.docLinkDepth`；视频与附件上限 `docMediaMaxMB` 默认 100 MB）并换成 `src:` 链接，读不到的通知本人并定时重试（`retryMissingDocs`，只改父文档里那条链接）。`importUrl` 对飞书文档多返回 `related`（一并导入且有变化的文档，也要整理）和 `missing`。素材下载被拒时改用预览接口，限流时退避重试；每篇文档记下它被读到时还能往下跟几层链接（`meta.depth`：直接给的 2，链接 1，链接的链接 0），重新读取和更新检查只按这个层数跟，不再每读一次都从它开始重新跟两层（之前 157 篇一路涨到 800 多篇）；一篇文档的素材 4 个并发下载（每个 lark-cli 调用约 1 秒，逐个下载时图多的文档要几分钟）；飞书写法的加粗（`**AI：**为…`，CommonMark 不认）在代码之外改成 `<b>`；原件页标题只有代码文件取文件名，其他原件显示完整标题（以前带 `/` 的标题只显示最后一段）；lark-cli 失败时错误里带上它返回的原因。旧文档用 `omem lark docs-refresh` 或远程 `lark-docs-refresh`（`stop: true` 停下）重读；远程 `lark-doc-raw` 核对文档相关的 lark-cli 返回，`lark-doc-import` 立即读一篇，`lark-docs-status` 看刷新进度和还没本地化的文档数。`/api/files` 支持视频类型和 Range，网页 Markdown 里视频用 `<video>`，`[名](omem-file:…)` 是附件下载链接。

- **读不到的文档、重新读取、更新检查**（10-19）：重试次数和间隔可配置（`lark.capture.docRetryMax` 默认 3、`docRetryHours` 默认 6），用完安静放弃（已删除、不存在、不是 docx 的按 lark-cli 错误码 3380002/3380003 等直接放弃，不提醒），`docs-missing --ignore` 手动放弃，同一批只发一条汇总通知；重新读取的进度存在 kv `lark_docs_refresh`，启动时 `resumeRefresh` 接着读，本次已读过的跳过；新的定时任务 `lark-docs-watch` 按上次修改后 7/30/90/180/365 天（`docRecheckDays`）检查，`drive metas batch_query` 批量取最后修改时间，改过的才重读。元数据新增 `fetchedAt`、`changedAt`、`modifiedAt`、`checkedAt`。

- **飞书里的人与 @**（10-19）：`src/channels/lark-people.ts`、表 `lark_people`（邮箱为主键的人，记 lark-cli 与机器人各自的 open_id、user_id）。采集时 `learnPeople` 用 lark-cli 的 `+search-user` 批量取名字和邮箱，机器人收到消息时记下自己的 id；`lark_send` / `lark_card` 加 `mentions`；`lark_messages` 加 `mentions` 列。聊天原文去掉 `@名字(ou_…)` 的 id（`withoutOpenIds`，启动时一次性清理旧原件 `cleanUpLarkIds`），网页显示邮箱。机器人权限加 `contact:user.employee_id:readonly`、`contact:user.email:readonly`、`contact:user.id:readonly`，`omem lark bot-permissions` 检查并给申请链接或扫码补齐（`checkLarkApp` 现在对照全部所需权限）。lark-cli 出错时缺权限不再误报成登录失效。

## 运维

- **`omem service`**（10-15）：自带 PM2 的后台服务（`src/core/service.ts`）。
- **`omem pull <host>`**（10-16）：经 ssh 拉另一台机器的库，合并或覆盖（`src/core/pull.ts`）。新表 `memory_rejections`、`shadow_writes` 不参与合并。10-18 起对已配对的同伴改走 HTTP（`fetchPeer`，`/api/peer/snapshot`）。
- **多台设备**（10-18）：`omem peer invite|add|list|call`、`omem diag`；配对码 = 地址 + 本人 API 令牌（`src/core/peers.ts`），`via` 经中间节点转发（`/api/peers/:id/*`），固定远程命令清单（`src/core/peer-exec.ts` 的 `peerCommands`，`POST /api/peer/exec`）。同时改了鉴权：没有配置令牌时只信任本机请求（以前对所有来源都当作本人）；网页支持 `?token=` 和 401 时填写令牌。临时 ssh 转发见 `scripts/relay.mjs`。配对码带本机所有网卡地址，断线后自动换地址；`omem peer name` 设本机名字（`config.node.id`），`omem link` 给浏览器带令牌的链接，`omem user tokens|revoke` 管令牌，`omem peer open` 在本机转发同伴的网页。同伴之间不自动同步，`omem pull` 手动拉。设计与以后的持续同步方向见 `docs/v2/architecture.md` 的“多台设备”。
- **默认监听所有网卡、开机自启、更新命令**（10-18）：`config.host` 默认 `0.0.0.0`（旧配置里的 `127.0.0.1` 视为未设置，`localhost` 只给本机）；`omem service enable|disable`（`src/core/autostart.ts`）；`osdk run upgrade` / `scripts/upgrade.ts`，远程 `update` 复用它。
- **判官按需启动**（10-15）：`src/sources/judge.ts`。
- **对话里建空间、关联仓库**（10-15）：`create_space`、`connect_repository`（`src/core/repositories.ts`）。

## 文档与技能

- `skills/omem/SKILL.md`（给外部 Agent 的说明）补了写记忆的要求、`tags`、聊天原件的行格式；AGENTS.md 加了“仓库里的几类说明”和改功能时要同步的文档清单（10-18）。

## 代码理解

- tree-sitter 接入 Go/Rust/Java/Kotlin/Swift 与另外十几种语言（10-14），见 `src/sources/treesitter.ts`、`treesitter-more.ts`；[导入到可检索](../flows/import-to-searchable.md) 一页只写了 TS/JS/Python。
- Swift 语法解析时关掉 V8 的优化编译（10-18）：Node 24 的 TurboFan 编译它约 400 KB 的词法函数会耗尽 zone 内存、整个进程崩溃（Node 22、26 没有这个问题），其他语法不受影响。见 `treesitter.ts` 的 `NO_TIER_UP`。

## 网页

- 定时任务改成表单（`web/src/components/CronEditor.vue`）：每隔几分钟/几小时、每天、工作日、每周几天、自定义 cron，显示含义和接下来三次时间（10-19）。
- 加载态（`Skeleton.vue`）与虚拟滚动（`VirtualList.vue`，动态行高）：原件列表、长原件、聊天、运行列表、记忆列表（10-18）。
- 原生 select / checkbox / datetime-local / confirm / prompt 全部换成自己的组件（10-18）：`web/src/components/UiSelect.vue`、`UiCheckbox.vue`（含 switch）、`UiSegmented.vue`、`UiDateTime.vue`、`DialogHost.vue` 与 `web/src/lib/dialog.ts`。约定写进了 AGENTS.md 和 `.agents/skills/omem-design`。


## 2026-10-19：事项来源、通知与跨空间归属

- 通知持久化本次事件来源，飞书正文和来源区共用最终 URL 去重集合；定时提醒使用设定提醒的来源。
- 事项来源默认合并，显式 replace/remove 要求旧快照和原因，保留修复历史。
- ingest 只读发现可访问空间中的已有事项，跨空间进展提交提案，主助手复核后应用；空间写权限仍独立检查。
- 本人主助手可通过受限 MCP 工具预览/修复错误关联并审计，保留未迁移事件仍使用的共有来源，旧卡片停用后可刷新原消息；按钮回调校验 payload 目标和操作者权限。部署与数据修复见 docs/v2/item-maintenance.md。

## 2026-10-19：飞书机器人消息与事项来源摘要

- 机器人收到消息事件先应答再处理，按消息 id 去重（`handled_messages`，channel `lark-bot`）。以前处理慢时飞书在约 20 秒、5 分钟后重推，同一条消息变成两三轮回答。
- 分享的群（`share_chat`）、名片、合并转发读成文字：群名先查个人采集的 `lark_cursors`，再用机器人、最后用本人 lark-cli（只读）；说明是否已采集，没有采集时提示订阅和回溯。只有材料的消息多等 `sessions.contentWaitMs`（默认 15 秒）。
- 引用回复：消息接口返回 `msg_type` 和字符串 `sender.id`，以前按事件字段读成 `[undefined]`。引用助手自己的回复（卡片读出来只有“请升级客户端”）时，按回复时记下的 `larkMessageId` 取回答原文。别人的 @ 保留名字，只去掉对机器人的 @。
- 事项来源：`refExcerpt`（`src/items/evidence.ts`）给出原件标题和所引行摘要；飞书卡片来源区按最终 URL 合并，网页事项详情的“相关依据”显示标题和摘要。

## 2026-10-19：子模块递归与交办编码链

- 代码仓库：`git ls-files --recurse-submodules` 索引已检出子模块的文件，gitlink 目录不当文件；omem 克隆的仓库在同步前逐个初始化子模块（嵌套在父模块内更新，单个失败不阻塞），状态写入空间设置。
- 交办编码：评审不通过自动续轮（最多 3 轮），复用同一 ask 运行、同一 worktree 和编码 Agent 会话；新增 `continue_code_run` 用于本人之后的调整，不再新建交办。
- 飞书新增独立“编码交办”卡片：交办开始时在原消息下开话题，编码/评审各轮进度在同一张卡片更新。

## 2026-10-19：多 Agent 长任务工作会话

- `run_agent(own_topic=true)` 建立独立工作会话（飞书由原消息开话题）：专门 Agent 的长产出只留在工作会话，新增 `digester` 角色自动消化，结论、决策点和下一步才回主会话；主助手不再原样转发长输出。
- 工作会话以 ask 运行为锚、轮次落库（最多 8 轮）；`continue_agent_work` 在原话题续下一轮，本人在话题里回复即在工作会话继续。
- 主助手职责更新：判断长任务、自动推进或明确请本人介入；交办编码仍走编码链和“编码交办”卡片。

## 2026-10-19：read_source 读聊天/记忆、网页分页与布局

- `read_source` 支持 `msg:<id>`、`mem:<id>`（也认不带前缀的消息 id）：以前复核记忆时记忆标的来源是消息，工具只查 `sources` 表，连续报“找不到原件”；现在分别渲染消息和记忆原件（`src/agents/tools.ts`）。
- 原件列表：文件夹默认折叠，展开过的跨分页保留，搜索时全展开；分页每页 1000 份，滚到底自动加载（`web/src/views/Sources.vue`，服务端 5000 上限）。
- 运行记录：后端分页（`limit` 上限 500、`offset`、`countRuns`，`GET /api/runs` 返回 `{runs,total}`），网页每页 100 条滚动加载，运行事件只在新 run 排队时刷新列表；类型补中文名（`ingest-shadow` 对比整理、`memory-review` 复核记忆等）。
- 布局修正：运行页侧栏头部改成两行网格，标题不再被控件挤成竖排；设置页 tab 横滚不再显示滚动条；空间卡片网格允许长路径换行，不再撑破页面；类型下拉选项文字与图标垂直居中。

## 2026-10-20：多 Agent 话题与回复整理

- 飞书话题键沿用 `omt_…` 原样：以前 omem 开工作话题时去掉了前缀，本人在话题里的回复变成另一个会话，助手在那里再委派又开了一套工作，导致同一话题里出现两路回复。迁移把旧键改回并合并同一话题的重复会话（`src/core/db.ts` 最后一条迁移）。
- 在话题里再 `run_agent(own_topic=true)` 续在同一项工作（`agent-work.ts` 的 `workInConversation`）；消化结果只发一处（`workDeliveryTarget`：有话题发话题，否则回主会话），飞书里是一张卡片，完整报告在折叠面板里（`lark-send.ts` 的 `fold` 块）。`roles/digester.md` 改成“整理成能直接用的回复”，不再压到两屏。
- 回复取最后一次工具调用之后的文字（`types.ts` 的 `replyFromSegments`，ACP 与命令行后备都按工具调用切段）：之前把中途的叙述和最终回答拼在一起，读起来像发了两遍。
- 发往聊天的本机路径改写（`common.ts` 的 `localPathLinks`）；`lark_*` 在话题会话里默认发进话题（`tools.ts` 的 `larkPost`）。
- 运行详情加“所在会话与关联”（`http.ts` 的 `runContext`），任务全文可展开。
- 外部只读访问的设计见 `docs/v2/external-access.md`（未实现）。

## 2026-10-20：通知收敛、原生思考气泡、预加载、Agent 学习分层、记忆召回统计

- 通知默认只在**未读 / 紧急 / 临期 / 未处理**之一成立时推送：lark-cli 的 `im +messages-read-status` 查本人已读（`lark-read.ts`，peer 命令放开该只读接口）；`config.notify` 加静默时段（22:00–09:00，定时提醒不受限、紧急可穿透）和开关。`notify` 增加 `urgency`。heartbeat / ingest 职责改成“能查的先查、长任务开话题推进、缺手段再问本人”。
- 飞书过程回显改用原生 `im.v1 message_cot`（AG-UI 事件，参考 deepcoldy/botmux 的 cot-message）：可折叠气泡、工具调用逐行、最新调用转圈、`RUN_FINISHED` 收尾；失败自动回退原“处理中”卡片。
- 网页路由 chunk 首屏后空闲预取、侧栏 hover/focus 预取（`preload.ts`）。
- Agent 学到的东西分三层：档案只存身份（Agent 经工具写超长 prompt 会被拒并引导到技能/记忆），步骤沉淀为技能，偏好与经验进 `scope=agent` 的记忆；`_common.md` 写明分工。code review 类档案按此逐步积累。
- 记忆加召回账本 `memory_recalls`：recall 每次落账，运行结束时回答/消息/写入引用到的记忆记为命中；记忆页新增“召回”标签和四种排序，便于治理。

## 2026-10-20：思考气泡协议修正、教指定档案、档案页可视化

- 原生思考气泡之前建得出、内容不更新：message_cot 的事件 `content` 必须是 JSON 字符串，传对象被网关报误导性的 41050（no user authority）；修正后工具行按 START（进行中转圈、可流 ARGS）→ END+RESULT（停止转圈）两段推送，整轮失败自动 best-effort 收尾并停用，不再留下永久空转气泡（`src/channels/lark-cot.ts`）。
- `remember` / `recall` 新增 `agent` 参数：主助手可用 `remember(agent="某档案")` 教任意档案的专属偏好/经验（档案不存在直接报错），`recall(agent="…")` 只看该档案；档案自己运行仍默认归属自己。主助手无 spec 时可见全部记忆以便统筹（`src/agents/tools.ts`）。
- 网页档案详情新增“挂的技能”和“专属记忆”两个折叠块：技能可直接勾选/移除（即时保存 frontmatter），专属记忆可查看与撤回（`Agents.vue`、`GET /api/agents/:name`）。

## 2026-10-20：气泡与进度卡重复、排队时多卡、长任务上限与卡死看门狗

- 思考过程只在原生气泡展示：普通“处理中”卡片不再回显模型思考文本；气泡首批事件推送成功后，卡片收敛为一行提示并最终承载结论；气泡不可用时卡片保留步骤作为后备（`lark-progress.ts` 加 minimal 模式）。
- 排队中的回合不再立刻建气泡和进度卡：消息轮到本回合真正 running 时才创建，修掉“回合 A 还在跑时发 B，出现两张永不更新的卡”的问题（`lark-bot.ts` 监听 run running）。
- 气泡收尾更稳：finish 后等所有工具 END/RESULT 推完再发 RUN_FINISHED（带 30 秒兜底），避免结束早于最后的工具事件；增加 proven 标记（`lark-cot.ts`）。
- 多 Agent 工作轮数上限 8 → 20；触顶不再把错误抛给本人，主助手改为直接在本会话继续完成请求（读工作会话上下文），`continue_agent_work` 工具返回指引（`agent-work.ts`、`tools.ts`）。
- 交互式运行（ask/agent）30 分钟没有任何事件即自动中止并释放会话通道，agent 进程挂死时后续排队消息不会再永久沉默（`runs.ts` 心跳看门狗 watchStalls）。

## 2026-10-20：档案页记忆渲染复用与记忆归属语义澄清

- 设置 → Agent 档案详情的“专属记忆”改用与记忆一级页相同的 `components/MemoryCard.vue`（类型中文化、有效期/标签/复核状态/演变依据按钮一致），添加技能改用 `UiSelect`，不再用原生 select；Memory.vue 也改为复用该组件。
- 记忆归属语义写清：`scope="agent"` 只表示“当前正在运行的档案自己”，不能指定别的档案；主助手教指定档案必须 `remember(agent="档案名")`（档案不存在报错），查看用 `recall(agent=…)`（`roles/_common.md`、`roles/assistant.md`、remember/recall 工具描述）。
- peer 新增只读命令 `library-file`：查看远端知识库 Git 里的档案/技能文件内容、目录或 git 历史，便于排查 Agent 学到了什么。

## 2026-10-20：save_skill 可挂到指定档案

- `save_skill` 增加 `agent` 与 `attach`：主助手教某个档案时 `save_skill(agent="档案名")` 保存技能并写进该档案 frontmatter（已挂则不重复）；在档案内运行默认挂当前档案；`attach=false` 只建共享技能。目标档案不存在报错（`src/agents/tools.ts`）。`_common.md`、`skills/omem/SKILL.md` 同步说明；补测试。

## 2026-10-20：通知闸门修 src 引用失效、首次提醒宽限、“忽略”学习

- 之前“已读不推送”几乎从未生效：心跳通知的来源是聊天原件行（`src:<id>#L2-L4`），闸门却只认 `msg:<id>` 直接 ID。新增 `notify-gate.ts`：把引用行解析回飞书消息，命中任一即不推——①触发消息已读；②本人在该消息上回了表情（OK/DONE，已核实小王那条 `is_read=true`，表情类也覆盖）；③本人之后在同群/同话题回复过。
- 普通、非紧急、未过期事项的首次提醒宽限 5 → 30 分钟（`config.notify.firstNudgeDelayMinutes`，旧字段 `minItemAgeMinutes` 改名），紧急/过期/本人设定的定时提醒不受限；heartbeat 职责写清不要几分钟内催、无新变化不重复催。
- 通知卡片点“忽略”会学习（`core/notify-lessons.ts`，存 kv `notify_mute_rules`）：按标题/正文的关键词（中文二元组+拉丁词，去停用词）匹配，相似度达阈值的同类提醒以后只进应用内通知、不再飞书推送；规则可审计、计命中数，`GET /api/notify-mute-rules` / 删除接口已备。作用边界：关键词相似匹配会有误伤可能，目前规则只静默推送不删除提醒，阈值 0.55，上限 100 条。

## 2026-10-20：忽略学习改为 AI 语义判断；档案页只认真专属记忆与样式修正

- 通知“忽略”不再用关键词匹配：点忽略时由模型把这条通知总结成一句带对象/场景边界的中文规则（一次性事件不生成），存 `kv notify_ignore_rules`；每次推送前由模型拿规则对新通知做语义判断，命中才静默（紧急通知不静默，不确定一律放行），规则可审计、计命中、可删除（`notify-lessons.ts`、`notify-ai-gate.ts`，`GET /api/notify-ignore-rules`）。新增 `ignore_notification_rule` 工具，本人引用消息直接说“这类不用提醒我”也能记录规则。
- 修复档案详情“专属记忆”混入共享记忆：之前列表语义是“共享+该档案”，导致 24 条与 issue-investigator 无关的共享记忆全显示；新增 `listMemories(agentScope:"own")`，档案页只列真正 `agent=档案名` 的记忆（`http.ts`、`memory/store.ts`）。
- 档案详情样式：改名“挂载技能”；技能 chip 可悬浮看描述、点击跳到技能管理页、× 单独移除，保留“+ 挂载技能”下拉；挂载技能与专属记忆各自在自己的卡片内滚动，不再一起滚动；修正 padding。

## 2026-10-20：首催宽限在通知层强制执行；已回复检测提前且更稳

- 30 分钟首次提醒宽限此前只写在角色提示里、代码没用上。改为在 `notify()` 集中强制：普通、非定时、非紧急事项的第一次通知，事项建立未满 `firstNudgeDelayMinutes`（默认 30）直接拒绝（425）；ingest 想立刻催也催不出来。定时提醒/urgent/已有通知的后续更新不受限。
- 已回复检测（`notify-gate`）重排：先做"本人在触发消息之后于同群/同话题回复"这一最强且不依赖读权限的判断（话题仅在双方都带话题标记时才要求一致，避免漏判）；触发引用解析不出消息行时，回退为同群近 30 分钟内本人有发言；之后才查已读与表情。修复"本人明明 12:06 已回复、12:01 ingest 仍催"的误打扰（注：12:01 时回复尚未发生，属于宽限要解决的场景）。
