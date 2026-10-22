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

- 之前“已读不推送”几乎从未生效：心跳通知的来源是聊天原件行（`src:<id>#L2-L4`），闸门却只认 `msg:<id>` 直接 ID。新增 `notify-gate.ts`：把引用行解析回飞书消息，命中任一即不推——①触发消息已读；②本人在该消息上回了表情（OK/DONE 等表情）；③本人之后在同群/同话题回复过。
- 普通、非紧急、未过期事项的首次提醒宽限 5 → 30 分钟（`config.notify.firstNudgeDelayMinutes`，旧字段 `minItemAgeMinutes` 改名），紧急/过期/本人设定的定时提醒不受限；heartbeat 职责写清不要几分钟内催、无新变化不重复催。
- 通知卡片点“忽略”会学习（`core/notify-lessons.ts`，存 kv `notify_mute_rules`）：按标题/正文的关键词（中文二元组+拉丁词，去停用词）匹配，相似度达阈值的同类提醒以后只进应用内通知、不再飞书推送；规则可审计、计命中数，`GET /api/notify-mute-rules` / 删除接口已备。作用边界：关键词相似匹配会有误伤可能，目前规则只静默推送不删除提醒，阈值 0.55，上限 100 条。

## 2026-10-20：忽略学习改为 AI 语义判断；档案页只认真专属记忆与样式修正

- 通知“忽略”不再用关键词匹配：点忽略时由模型把这条通知总结成一句带对象/场景边界的中文规则（一次性事件不生成），存 `kv notify_ignore_rules`；每次推送前由模型拿规则对新通知做语义判断，命中才静默（紧急通知不静默，不确定一律放行），规则可审计、计命中、可删除（`notify-lessons.ts`、`notify-ai-gate.ts`，`GET /api/notify-ignore-rules`）。新增 `ignore_notification_rule` 工具，本人引用消息直接说“这类不用提醒我”也能记录规则。
- 修复档案详情“专属记忆”混入共享记忆：之前列表语义是“共享+该档案”，导致一个排查类档案的详情里显示了二十多条与它无关的共享记忆；新增 `listMemories(agentScope:"own")`，档案页只列真正 `agent=档案名` 的记忆（`http.ts`、`memory/store.ts`）。
- 档案详情样式：改名“挂载技能”；技能 chip 可悬浮看描述、点击跳到技能管理页、× 单独移除，保留“+ 挂载技能”下拉；挂载技能与专属记忆各自在自己的卡片内滚动，不再一起滚动；修正 padding。

## 2026-10-20：首催宽限在通知层强制执行；已回复检测提前且更稳

- 30 分钟首次提醒宽限此前只写在角色提示里、代码没用上。改为在 `notify()` 集中强制：普通、非定时、非紧急事项的第一次通知，事项建立未满 `firstNudgeDelayMinutes`（默认 30）直接拒绝（425）；ingest 想立刻催也催不出来。定时提醒/urgent/已有通知的后续更新不受限。
- 已回复检测（`notify-gate`）重排：先做"本人在触发消息之后于同群/同话题回复"这一最强且不依赖读权限的判断（话题仅在双方都带话题标记时才要求一致，避免漏判）；触发引用解析不出消息行时，回退为同群近 30 分钟内本人有发言；之后才查已读与表情。修复"本人明明 12:06 已回复、12:01 ingest 仍催"的误打扰（注：12:01 时回复尚未发生，属于宽限要解决的场景）。

## 编码交办进度与续轮（2026-10-20）

- 修复手动 `continue_code_run` 被自动三轮上限挡住的问题；自动上限保留，手动第 4 轮及以后复用首轮工作区和上一轮编码会话。排队时重读主链，拒绝重复 queued/running 和过期自动回调。入口：`src/agents/code-chain.ts`、`tools.ts`、`code.ts`。
- 编码飞书卡片的创建、更新、失败状态、有限重试和重启恢复改为持久记录；已有话题查真实消息锚点，私聊走普通回复，不再改原会话 `lastMessageId`。卡片含各轮独立评审摘要，到上限或需要本人时持久记录等待状态。`read_run` 可查投递，`retry_code_progress` 只恢复原卡片；发起主助手的上下文保留结果，不自动唤醒以绕过自动轮数限制。入口：`src/channels/lark-code-progress.ts`、`src/agents/runs.ts`。恢复操作见 `docs/v2/acceptance.md`。
- 验证使用临时数据库、假飞书客户端；历史被吞掉的 API 错误仍未知，真实投递待应用后验收。

- **编码收尾异常隔离补充**（10-20）：`trySettleCodeChain` 确保交接记账失败不会把已完成运行改成失败，也不会阻断终态事件。飞书恢复逐链隔离，已发最终卡片但记账失败仍重试；缺卡创建耗尽后首次启动补一次有限预算，明确撤回或 HTTP 404 后换 UUID 补建，权限和限流失败保留原 ID。`test/code-settlement.test.ts` 和飞书进度测试覆盖这些故障路径。

## 2026-10-21：审查修正（通知闸门、召回统计、思考气泡）与界面修正

- 通知闸门 `notify-gate.ts` 三处缺陷：聊天行正则解构多跳了一组，消息 id 恒为空，已读和表情判断从未生效；聊天行时间按 +08:00 解析，而采集写的是 UTC，“同群近 30 分钟本人发过言”的回退永远不命中；表情比对用的是机器人的 open_id，lark-cli 读到的是它自己应用的 id。已读查询改为“确知已读才算”（`lark-read.ts` 的 `readMessageIds`），查不到、字段缺失或 lark-cli 不可用都不静默。
- 记忆召回“命中”只记本次运行（`markUsed(runId, …)`），以前一次命中会把这条记忆在所有运行里的召回都记成命中；迁移按每次运行重算。Agent 运行不再重复保存整段叙述（`output.fullText`，迁移删除）。
- 思考气泡：同一段推理在第一次推送后追加的文字没有再推，长段落只显示开头；改为按已推长度推增量，后面出现工具调用或结束时才关闭这段。
- `continue_agent_work` 不指定 agent 时取最后一个非 digester 的轮次（以前会选到 digester，报“没有名为 digester 的 Agent 档案”）。`ignore_notification_rule` 加进 assistant / heartbeat 的工具清单（角色说明里提了，清单里没有）。去掉未使用的 `notify.proactivelyInvestigate`、`notifyPolicy`、`isUrgent`、`isUnread`、`cotWorkingFor`。
- 原件页：代码仓库空间一次取全部路径（`GET /api/sources/paths`，不算行数），目录树的计数完整、不再分页；平铺列表加载后不满一屏会继续加载，“还有 N 份，向下滚动加载”的提示去掉，加载提示居中。
- 聊天原件的图片和附件：`[Image: img_…]` 形式的图片消息也能显示；采集时没下载的（旧消息、只有 key 的行）在第一次显示时经 `GET /api/lark/messages/:mid/resources/:key` 由本人 lark-cli 读取（失败再用机器人），存入原件文件，之后直接显示。
- 编码交办详情的 diff 默认折叠，展开某个文件才渲染它的行，可一键全部展开。
- `scripts/dev.ts` 在 Windows 上不再经 shell 启动 node（路径含空格时 API 起不来）。

## 2026-10-21：内置角色可管理、档案进化

- 内置角色（`roles/*.md`）在 Agent 页列出，可“自定义”：复制到 `library/_roles/<名>.md`，源码版本另存在 `_roles/.base/`。之后的运行用自定义版本（`runner.ts` 的 `loadRole(name, app)`）。omem 更新改了源码时列表显示“源码有更新”，可“恢复源码版本”（删自定义，Git 历史保留）或“合并源码更新”：`git merge-file` 三方合并，干净就直接保存，有冲突交给模型（`role-merge` 运行，`oneshot.ts` 的无工具一次调用），结果同样校验后保存。命令行 `omem roles list|customize|reset|merge`。
- 内置角色和档案一样能学：`remember(agent="reviewer")`、`save_skill(agent="reviewer")`（挂载写进自定义版本的 frontmatter），角色运行时注入它的专属记忆、常用技能排在前面；角色内 `scope=agent` 写自己的经验，不传时仍写共享（ingest 记的是本人的偏好）。档案名不能与内置角色重名（记忆和技能按名字归属）。`list_agents` 同时列出内置角色。
- 档案进化：新角色 `coach` 和每晚 04:10 的 `profile-review`（最近有 3 次以上运行、且有本人随后的纠正或失败的档案/角色，每晚最多 3 个）。coach 读运行产出和之后本人在同一会话说的话：经验和偏好直接 `remember(agent=…)`（照常经过写入检查和复核），提示词、技能、设置的改动用新工具 `propose_profile_change` 存为 `profile_proposals`，本人在档案页采纳（提示词显示差异）或忽略。档案页“进化”区显示近 30 天运行、专属记忆被召回/用上的次数、上次复盘、待采纳建议和历史，可“立即复盘”。
- Agent 页重做：左侧“我的档案 / 内置角色 / 技能”，＋ 进入完整的新建表单（名称、用途、后端、模型、强度、空间、目录、工具、可读空间、技能、写文件、提示词、工作约定），已有档案默认是表单、可切“原文”；挂载技能和工具用 `ChipPicker`（一个 ＋ 下拉，选中即加）。去掉列表头部的内联新建。
- 通知的 AI 闸门改用 `agents/oneshot.ts` 的 `askModel`（与角色合并共用）。

## 2026-10-21：多 Agent 协作改成主助手接手的循环

- 不再有 digester：专门 Agent 每轮完成或失败后，报告作为它的消息放进工作会话，并在该会话的通道里排一个“协调”回合（`ask` + `coordinate`，`agent-work.ts` 的 `onWorkRunSettled`）。主助手以这项工作负责人的身份读报告（`sessions.ts` 的 `coordinationNote`）：继续交办、换 Agent、自己核实、整理结论或请本人决定。回复发到 `workDeliveryTarget`，各 Agent 的完整报告折叠在下面（`jobs.ts` 的 `deliverCoordination`）。本人在话题里的新消息与报告合并成同一回合。
- 防失控：本人上次在工作会话说话以后最多自动推进 `MAX_AUTO_TURNS`（6）次，超过时 `continue_agent_work` / `run_agent` 在协调回合里被拒绝，提示词要求汇报；专门 Agent 轮数上限 20 → 30（协调回合不计）。失败的轮次也会交给主助手（以前只在成功时推进）；协调回合本身出错会在话题里说一声。
- 信息不丢：同一个 Agent 的下一轮接着它上一轮的会话（`persistSession` / `resumeSessionId`，接不上时改新会话），任务前附上这项工作到目前为止的经过（本人的话、其他 Agent 的报告，`workContext`）。
- Agent 之间可以请教：新工具 `ask_agent(name, question)`（档案和主助手自动有），被请教的档案在提问的工具调用里直接运行（不排队，避免所有槽位都在等请教时卡死），是一条可见的子运行（`consult.ts`），不能再请教或交办（`denyTools`）；重启时中断的请教直接失败。
- 飞书里每个 Agent 的回合、被请教的回合和主助手的协调回合都有自己的原生思考气泡，标题写明是谁在做什么，按顺序出现在工作话题里；工作话题建好之前不在原群里显示（`lark-agent-cot.ts`）。
- 编码交办停下（通过、到自动轮数上限、失败、无改动）时，唤醒发起的主助手在原会话发一条结果和下一步（`code-chain.ts` 的 `wakeAssistantForCodeResult`，`handoff`），这一回合没有编码工具。编码和评审的输出只取最后一次工具调用之后的文字，评审的中途叙述不再进到结果消息里。
- 迁移：仍在排队的 `agent-followup`（旧 digester）运行取消；`roles/digester.md` 删除。

## 2026-10-21：规则页

- 新增“规则”（`src/rules/`，设计见 `docs/v2/rules.md`）：一句话原话 + 触发（新消息 / 第一次看到的群 / 定时，每条或每群一次）+ 条件（宿主求值的 JSON：群名、群里的机器人、发送人、邮箱、正文、消息类型、@ 本人、卡片标题，all / any / not）+ 判断方式（条件、条件 + 模型确认、模型，模型判断每规则每小时最多 60 次）+ 按顺序的动作（交给 Agent、持续监听、拉机器人进群、优先采集、通知）。
- 事件来源：机器人实时收到的群消息（`lark-bot.ts`）和本人采集的所有会话（`lark-personal.ts`，含第一次读到的群）；同一条消息对每条规则只处理一次（`rule_handled`）；定时规则建 `rule:<id>` 定时任务。
- 交给 Agent：可以从触发消息开话题；回复方式“只告诉我”（结论通知本人）、“先给我看”（它的 lark_send 变成草稿）、“直接回复”（结论和 @ 发在这个群/话题）；它只能往触发的群发（`runRole` 新增 `lark` 范围）。
- “拉机器人进群”以本人身份（lark-cli `im chat.members create`）把 omem 自己的机器人加进群，是本人身份唯一的写操作，只在本人配置的规则里发生（AGENTS.md 已写明）。“优先采集”把群设为 ingest 并立刻采集一次，之后免打扰也照读。
- 模型的两件事都是无工具的一次调用：从原话生成规则（`draftRule`），判断事件是否满足原话（`aiJudge`）。规则页可“用最近的消息试一试”（只看不做）、看触发记录。助理有 `list_rules` / `save_rule`，它建的规则默认不启用。
- 共享组件修正：`UiCheckbox` 的选中样式写成了 `.on .box`，任何带 `on` 类的祖先（比如选中的列表行）都会让它显示成选中，改为只看自身。

## 2026-10-21：机器人与本人采集不重复写；批量回溯与补拉图片附件

- 机器人在群里实时写下的消息，本人采集（lark-cli）再读到时会重复追加一行（两边都写 `lark:<群>` 原件，之前不查）。现在双方按行尾的消息 id 跳过对方已写的（`linesWritten`，只查原件末尾 20 万字），`lark_messages` 的行号指向已有的那一行。规则、监听、通知原本就按消息 id 去重，不受影响；历史回溯写按月原件，按 `lark_messages` 去重，与实时原件不重叠。
- 批量回溯：`omem lark backfill [会话…] --name/--kind/--all --days N`；助手的 `set_lark_backfill` 改为一次多个会话（`chat_ids`），本人说“某类群”时助手先用 `list_lark_chats` 挑出会话。
- 补拉缺的图片和附件：`fillResources` 找出 `lark_messages` 里没有本地文件的图片/文件 key，以及 10-16 之前只存在于聊天原件行里的 key，逐个用本人 lark-cli 读取（机器人兜底）；CLI `omem lark fill-files`（前台，打印进度），远程 `lark-fill-files`（后台，完成后通知，`status: true` 看进度），`POST /api/lark/fill-files`，`set_lark_backfill files=true`。

## 2026-10-21：规则按应用 id 认出 omem 自己的机器人

- 新字段 `chat.hasOwnBot`：群成员里有没有 `lark.appId` 这个应用（机器人收到的消息直接算有），不看名字。`chat.bots` 仍是名字列表，成员读取同时保留应用 id（`engine.ts` 的 `chatBots`）；“拉机器人进群”后清掉这个群的缓存。
- 从原话生成规则时告诉模型机器人的真实名字（`kv.lark_bot_name`），并要求“助理机器人 / omem 机器人”用 `chat.hasOwnBot`。之前模型会写 `chat.bots contains "omem"`，而机器人名字通常不含 omem，条件永远成立。

## 2026-10-21：TraeX 按模型的思考强度与结构化排队状态

- 探测（Agent 页“检测模型”、飞书 /model 卡片）逐个切换模型读 reasoning_effort，存为 `effortsByModel`；TraeX 的默认模型没有强度选项，之前因此显示“不支持”。`/model`、模型卡片、设置页的强度选项按当前模型列出，没有强度的模型直接说明。
- TraeX 内置启动参数加 `-c features.headless_queue_status=true`；已保存的旧默认参数（`acp serve`）自动换成新的（`catalog.ts` 的 `previousArgs`）。排队状态从 `session_info_update._meta.trae.queueStatus` 读（`acp.ts` 的 `queueStatusOf`，旧的 queue_* 更新仍兼容）：排队中暂停空闲计时，位置变化发状态，结束时报告等了多久；思考气泡里显示同样的内容。

## 2026-10-21：豆包 OpenAPI 作为云端模型后端

- 新后端 `doubao`（`src/agents/doubao.ts` + `dispatch.ts` 统一各传输入口）：豆包 Managed Agent OpenAPI（sessions / events / MessageStream），设备码 OAuth 拿用户 access_token 存 `secrets/doubao.json`（按飞书 app id 分，自动刷新、保留 refresh token），会话留在豆包，线程用 `resumeSessionId` 续聊；reasoning 进思考、artifact 附为链接；云端运行用不了 omem MCP 工具，请求带工具时会说明。
- 权限按应用区分：`omem doubao status` 检查 omem 持有 secret 的全部应用（租户令牌读 `doubao:*` 用户权限）和 lark-cli 自己的应用；`omem doubao login [--app]` 设备码授权，也有远程命令 `doubao-status` / `doubao-login`（远程发起后在飞书确认，完成通知）。
- 在一台同伴机器上真机验证：助理机器人应用有权限，授权后两轮对话正常且第二轮记得第一轮答案（同一 session）。

## 2026-10-21：新话题继续旧工作；思考气泡超长修复；后台进度不私聊

- 问题：本人在一个新飞书话题里让主助手接着旧工作做时，它用 `continue_agent_work(work_id)` 把下一轮排进旧工作会话，之后专家的报告、协调回复、编码交办交接（code-chain handoff）都回到旧话题；旧话题里已排队的轮次继续在旧 lane 跑。现在从别的会话（尤其新话题）继续旧工作会 `forkAgentWorkTo`：在新会话建工作线程、新 ask 链承载后续所有轮次（专家仍接它自己的 Agent 会话与工作经过），旧工作标记 superseded、旧 lane 里排队的轮次取消；编码交接在唤醒主助手时跟随最新工作会话。
- 思考气泡：飞书对单个 COT 事件有长度限制，推理文本整段推送时返回 “event[n] content too long”，气泡被错误结束并显示“思考过程可能包含不符合规则的信息，已隐藏”，且当时会全局停用所有后续气泡。现在 reasoning delta 按 4000 字分段；超长只结束本轮气泡，后续轮次照常。
- 通知：编码评审到上限、`set_lark_backfill files=true` 的补拉完成等后台任务通知一律发到所在工作话题（`notify.larkConversationId`，飞书 sink 按会话 key 回复到话题），不再私聊本人。

## 2026-10-20：Oncall 本人被 @ 保留规则

- 新增默认关闭的 `lark.capture.mentionRetention`：绑定 CLI 本人身份、授权租户、工单确认群映射；可通过固定 bytedcli 只读命令发现新关联群，分类只定优先级。
- @ 搜索提前且不跳过常规已读群；真实 mention 命中后独立保存触发消息、优先上下文和持续采集，不受免打扰及普通预算限制。邀请当前 omem app 使用用户鉴权，前后以 omem SDK 核验成员，审批/有限重试/采集失败存库。
- 两入口共用消息/原件行与资源关系；机器人事件先持久化，失败重试与重启恢复独立于用户读取。记录本人移除、机器人移除和真实解散。规则不发群消息、不回复、不改工单。
- `omem lark retention-status` 查看配置与进度；启用步骤、搜索/轮询延迟、权限和编辑覆盖边界见 `docs/v2/lark-mention-retention.md`。

- 保留规则评审修正：分页正文逐页保存，缺失/重复令牌不推进游标；不依赖未经核实的消息更新事件，机器人以自身权限有限回读近期已保存消息，覆盖本人离群后的近期卡片更新。真实解散状态不被后续移除事件覆盖。

- Oncall 保留规则评审修正：实时完成回执独立保存，回读成功删除任务，十次失败停止自动重试并输出状态；尚未确认可读的机器人群不排回读。优先列表每轮共用 20 次请求预算，群分页和话题分轮持久续读、逐页保存，倒序越过时间窗停止。身份不匹配恢复常规订阅路径；恢复 @我联系人学习，说明旧聚合源替换；聊天按时间展示并保持引用行号；已存资源 key 不重复下载。

- Oncall 保留规则第二轮评审修正：消息保存透传原件写入状态，仅实际变化触发整理；完整处理成功后记录消息摘要，无变化回读跳过渲染与引用查询。处理摘要和刷新时间标记随 72 小时窗口清理；补安静群重复回读、真实编辑仍整理和标记过期测试，说明未确认 skip 群仍先保存单条触发消息的边界。

- 2026-10-21：历史回溯不再把整页已知 ID 当作终止，新增持久远端页令牌和话题进度，逐页保存、已知 ID 补资源，完成需要耗尽证据，旧队列原目标保留并重新核验。机器人回读改按群复合索引游标限量检查，清理分批；卡片资源失败独立重试，不阻断后续正文更新。main 兼容补丁保留已合入通知/手动续轮、规则与资源能力。

- 2026-10-21：补空归属消息专测（三项归属 NULL 且原件无 ID 时仍补原件、续 next、重放不重复）；补四十群旧结束复核后恢复整理意图及永久附件失败状态回归。原树验证内部 requestBackfill，最新 main 兼容树验证正式 chat_ids/files 工具入口；清理 parentOf 无用导入和无调用者 rebuildArchive。

## 2026-10-22：编码交办结果回到主助手、自动推进可设置、静默排查与“别人在处理时不插手”

- 编码交办停下后唤醒主助手失败：c7cc213 在 ES 模块里用了 `require(...)`，Node 下直接报 `require is not defined`，第 3 轮以后每次停下主助手都不说话。改为静态导入；顺序也调整为先判断“下一轮已自动排队”再写入消息，避免同一结果重复写三次。`test/esm.test.ts` 检查 src 里没有不经 createRequire 的 `require(`（vitest 自带 require，测试发现不了这类问题）。
- 后台通知发到工作话题（同一提交）查的是不存在的 `conversations.key` 列，且回复型目标被提前丢弃，通知发不出去；改为 `external_id`，放行 `replyTo` 目标。
- 自动推进上限可设置：`agents.autoAdvance.turns`（多 Agent 工作本人上次说话后最多自动交办几次，默认 6）、`codeRounds`（编码交办自动改到第几轮，默认 3）；设置 → Agent → 自动推进。
- 思考气泡：单个事件内容上限从 4000 字降到 1000 字（飞书按字节限长），工具参数和结果同样截断；网关或能力类失败只停 30 分钟，不再整个进程停用。
- 飞书里问助理：思考气泡可用时不再先发“处理中”卡片，只加“处理中”表情，有结论再发回答；气泡 15 秒内没出来才退回进度卡片。
- 规则交给 Agent 并“在消息下开话题”时不再先发“按规则处理这条消息”的卡片，Agent 的气泡或回答以话题回复开出话题（`replyAt`）。
- 规则可以等待与跳过：`trigger.waitMinutes`（命中后等几分钟，`rule-fire` 运行）、`trigger.unless`（`owner-engaged` 本人已在讨论里、`answered` 已有人回复）；动手时读话题或前后半小时的讨论（`src/rules/context.ts`：已存消息 + 一次只读 lark-cli 列表），模型判断也带上讨论。
- Agent 回复方式 `silent`（静默排查）：不开话题、不发气泡、最后文字不发出；任务附上讨论和怎么决定发不发、追问什么；它在话题里发过言就跟进该话题 24 小时（新消息一分钟后交回同一 Agent 会话），本人在话题里说话即停止。

## 2026-10-22：移除“Oncall 本人被 @ 保留”

- 10-20 加入的 `lark.capture.mentionRetention`（`lark-retention.ts`、`lark-event-queue.ts`、`omem lark retention-status`、`docs/v2/lark-mention-retention.md`）整体移除：它依赖公司内部的工单命令行，按工单系统的字段做群映射，绕开规则系统另写了一套“被 @ → 优先采集 → 邀请机器人”，还让这些群跳过规则和监听。同样的事用规则表达（条件“@ 了本人”，动作“优先采集”“拉机器人进群”）；要核对是不是值班工单群，交给 Agent 档案挂的值班技能（内部命令行写在技能里，`library/_skills`，不进仓库）。
- 机器人每分钟回读近 72 小时消息、失败事件持久队列只服务于这些群，一并移除；`im.chat.member.user.deleted_v1`、`im.chat.disbanded_v1` 不再订阅。
- 同一提交里通用的部分保留：历史回溯按远端页令牌续读、两路消息共用 `lark_messages` 与原件行、@ 我的消息写进各群原件。

## 2026-10-22：访客提问、规则给直接 @ 让路、私聊指令

- 有人 @ 机器人时规则让开：`markAddressed` 在 `rule_handled` 记一条 `@bot`，`consider` 遇到就跳过（含跟进话题的接续），机器人和采集两路送来都一样。别的机器人 @ 它照常走规则。
- 访客模式 `lark.guests`（默认关）：未登记的人在群里 @ 机器人（`p2p` 时也包括私聊机器人）、别的机器人 @ 它且没有规则接手 → `guest` 运行。新内置角色 `gatekeeper`（判断 answer / refuse / ignore，输出 JSON）和 `guest`（只读工具，空间是群所在空间——个人空间不算——加 `guests.spaces`，都没有时用一个空的 `guest` 空间）；`prepareRun` 对 `guest` 不给技能、相关空间和本人偏好。每人每小时 `perHour` 次。
- 私聊指令 `lark.commands`（默认关）：`main.ts` 每分钟调 `pollOwnerCommands`，用 `+messages-search --sender <本人> --chat-type p2p` 找本人发的 `/ai`、`/ai拉群`（kv `lark_cmd:<消息id>` 去重），排 `lark-command` 运行。`/ai`：主助手（`runRole`，不能发飞书）读最近的私聊处理，结果以本人身份 `+messages-send --as user --markdown` 发回私聊，加署名；回 `NO_REPLY` 时只通知本人；按私聊续 Agent 会话（kv `lark_cmd_session:<会话>`）。`/ai拉群`：以本人身份 `+chat-create --users <对方> --bots <lark.appId>`，机器人在新群里先说明来由，再经 `answerFromChannel` 带上私聊作上下文回答。
- AGENTS.md 的飞书身份约定改为：以本人身份写只有规则里的“拉机器人进群”和本人亲手发的私聊指令。

## 2026-10-22：本人在群时的访客、最近打开的文档、运行筛选

- `lark.guests.ownerPresent`：本人也在的群里，访客可以照常受限（`guest`）、把关后交给主助手（`gated`，guest 运行带 `gateOnly`，只判断）或直接交给主助手（`free`）。交给主助手时按本人身份运行，`Inbound.asker` 写进消息 meta，会话里显示为“某某（群里的同事，不是本人；本人也在这个群）”。本人在不在群：`ownerInChat` 用机器人的群成员接口，缓存半小时，查不到当不在。
- 最近打开的文档：`captureRecentDocs` 在每次采集里排在 @我 之后、会话之前，`drive +search --opened-since` 列本人最近打开的 docx / doc / wiki，没存过的用 `importUrl` 读进采集空间，每次最多 10 篇；`lark.capture.recentDocs`（默认开）、`recentDocsDays`（默认 7）。远程只读命令 `lark-recent-docs`。
- 运行记录：`/api/runs?kind=` 可逗号分隔多个，`agent:<名>` 是某个 Agent 档案的运行；页面上换成可多选的筛选，补上 Agent 档案、访客提问、私聊指令等类型。静默判断改为 `isQuiet`（QUIET 前面有一句话也算），迁移把以前漏判的巡检等运行补标；勾选框改名“含无事可报”。

## 2026-10-22：对话前带上相关记忆

- 记忆也有向量了：迁移给 `memories` 加 `embedding`，`embedPendingMemories`（`src/search/embeddings.ts`）在后台循环、`omem setup embeddings` 里跟在片段后面补齐；换向量模型时一起清空，`updateMemoryText` 改了内容就清掉这条的向量。
- `src/memory/passive.ts` 的 `passiveRecall`：消息向量与记忆向量余弦 ≥ `memory.passive.threshold`（默认 0.6）的、最多 `limit`（5）条，限定在本次运行可读的空间、共享或本档案的记忆、无归属或本人的；不含偏好和经验（它们在 `learnedContext` 里每次都带）。
- `sessions.ts` 的 `threadTurn`：本人（或登记用户）的新消息才查，监听群、协作进展、编码交办结束不查；结果作为“可能相关的记忆”接在新消息后面；同一 Agent 会话里带过的不再带（`passiveSeen`，会话重开后重新算）。访客运行（`prepareRun` 的 `recall` 为 null）不带。
- 召回统计：`memory_recalls.via`（`recall` / `passive`），被动带上的用上与否照常按回答里有没有 `mem:<id>` 判断；“记忆 → 召回”多显示一句被动带上的次数与命中率。设置 → 检索 可开关、调门槛。
- 校准与对照见 `docs/v2/evaluation.md`“对话前带上相关记忆”：0.6 时正例约八成带上相关记忆、带上的 96% 相关，反例一成误带；VCPToolBox 的 RiverMemo 在同样数据和向量下比直接余弦低 11 个点，没有引入标签图联想。

## 2026-10-22：写记忆前先对照已有的

- `src/memory/passive.ts` 拆出 `nearMemories`（按向量找相近记忆，被动召回、整理、写入检查共用）。
- 整理新材料：`jobs.ts` 的 `knownNearMaterial` 把新内容按 1500 字切几段，各取相近记忆（余弦 ≥ 0.6，当前空间和相关空间），最多 12 条附在 ingest 任务后。
- `remember` 工具：Agent 写入前 `memoriesNearWrite` 找同一空间、同一档案可见的相近记忆（向量 ≥ `SAME_TOPIC` 0.75；没有向量时主题名相同或两字相似度 ≥ 0.3），有就返回 409 列出它们和已有的主题名、标签，Agent 用 `supersede`、放弃，或带 `distinct_from` 重新调用。本人写入不拦。
- 做梦整理：`sameTopicPairs` 在有变化的记忆和同空间其他记忆之间找向量相近的对，列进 dreamer 任务。
- `roles/_common.md` “怎么写记忆”加“先看已有的再写”；`skills/omem/SKILL.md` 写了 `distinct_from`。

## 2026-10-22：思考气泡收尾竞态与诊断日志

- `lark-cot.ts` 在上传期间收到新文字、工具状态或结束信号后，继续补推事件，再检查所有推理节点和工具是否结束；已关闭的段落收到迟到文字时另开节点，避免丢末尾文字或缺少 MESSAGE_END 就发 RUN_FINISHED。
- 原先 30 秒兜底只重复检查，缺少工具完成事件时会一直等待。现在从首次结束请求计时，到期标记缺失工具状态并收尾，重复 finish 不延长截止时间，终态清理定时器。
- 新增 `lark-cot` 结构化诊断：运行/气泡/消息 ID、请求序号、接口阶段、事件类型及 UTF-8 字节数、耗时、错误码和可用的服务端 logId。成功与请求写标准输出，失败与超时写标准错误；不记录正文、工具参数或原始错误响应。清理失败单独留痕，内容超长按业务响应和 HTTP 异常统一识别。
- `test/lark-cot.test.ts` 用假客户端控制请求完成时序，覆盖并发收尾、分批、迟到/缺失工具状态及各阶段错误和日志脱敏。历史隐藏提示的直接原因仍无法由旧日志确定；本次修复已复现的协议缺陷，真实飞书展示待部署验收。
