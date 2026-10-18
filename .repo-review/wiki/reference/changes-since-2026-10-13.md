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
- **飞书文档本地化**（10-18）：`src/channels/lark-docs.ts` 把文档里的图片、画板、视频/附件下载到 files/（正文写 `omem-file:`），内嵌表格转成表格，同步块读出原文，分栏/高亮块/按钮/书签/勾选/子页面列表转成 HTML（表格里的图片和链接写成 HTML 的 `<img src="omem-file:…">`、`<a href="src:…">`，网页 `web/src/lib/markdown.ts` 渲染前换成本地地址）；链接的文档一并导入（默认两层，`lark.capture.docLinkDepth`；视频与附件上限 `docMediaMaxMB` 默认 100 MB）并换成 `src:` 链接，读不到的通知本人并定时重试（`retryMissingDocs`，只改父文档里那条链接）。`importUrl` 对飞书文档多返回 `related`（一并导入且有变化的文档，也要整理）和 `missing`。旧文档用 `omem lark docs-refresh` 或远程 `lark-docs-refresh` 重读；远程 `lark-doc-raw` 核对文档相关的 lark-cli 返回，`lark-doc-import` 立即读一篇，`lark-docs-status` 看刷新进度和还没本地化的文档数。`/api/files` 支持视频类型和 Range，网页 Markdown 里视频用 `<video>`，`[名](omem-file:…)` 是附件下载链接。

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

- 加载态（`Skeleton.vue`）与虚拟滚动（`VirtualList.vue`，动态行高）：原件列表、长原件、聊天、运行列表、记忆列表（10-18）。
- 原生 select / checkbox / datetime-local / confirm / prompt 全部换成自己的组件（10-18）：`web/src/components/UiSelect.vue`、`UiCheckbox.vue`（含 switch）、`UiSegmented.vue`、`UiDateTime.vue`、`DialogHost.vue` 与 `web/src/lib/dialog.ts`。约定写进了 AGENTS.md 和 `.agents/skills/omem-design`。
