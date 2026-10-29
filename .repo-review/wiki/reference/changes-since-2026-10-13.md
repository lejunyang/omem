---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，按模块列出入口文件；读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-10-28
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。

## 调度与 Web 服务

- **拉取命令归入同伴**（10-27）：数据拉取统一用 `omem peer pull <同伴或 SSH 主机>`，保留 `--remote-home`、`--overwrite` 和 `--dry-run`；移除旧的顶层 `omem pull` 入口。`scripts/relay.mjs` 的白名单与长任务超时识别一起调整；下文历史记录里的旧命令均指这项功能。
- **完整手动拉取**（10-27）：`src/core/pull.ts` 与新增的 `pull-transfer.ts`、`pull-snapshot.ts`、`pull-data.ts`、`pull-repos.ts`。SSH / HTTP 共用快照，传整个附件目录、仓库历史与非忽略工作文件、已检出子模块和编码工作区 / 补丁；业务表补上评审、问题、标注、归档、规则、学习和质量记录等，辅助表增加跨设备标识，自增编号重分配并保持关联。聊天追加合并并换算引用和行号；已有本地仓库保留改动与分叉，远端另存副本。新导入的任务规则、定时任务停用，远端排队运行取消，本机活跃任务保留。覆盖备份数据和托管仓库，恢复失败回滚。替代下文 10-16 的辅助表不参与合并及旧 worktree 不拉取的行为。
- **整理合并与队列隔离**（10-25）：`src/agents/jobs.ts` 将同空间、同要求的待整理材料去重合并，等待 30 秒、每批最多 40 份，同空间串行，保留聊天最早待整理行号。`src/agents/runs.ts` 先筛选有空位的任务类别，避免前 100 条后台积压挡住后续对话。空间自动整理开关不启动回溯；显式请求的历史回溯完成后，旧聊天也会作为新入库材料参与整理。
- **gzip**（10-25）：`src/server/http.ts` 按客户端支持压缩网页静态资源和超过 1 KB 的 JSON 等文本响应，实时事件保持流式发送。

## 插件

- **插件系统与英语练习**（10-28）：设计在 `docs/v2/plugins.md`。`src/plugins/registry.ts` 加载 `plugins/<id>/plugin.yaml`，插件档案经 `specs.ts` 的 `setPluginSpecSource` 出现在档案列表（本人改过的存 `library/_agents`，带 `plugin` 字段），技能播种到 `library/_skills`，工具与内容块由 `server.ts` 的 `register(api)` 注册（名字带 `<id>_` 前缀）。表 `plugin_records`（插件记录，`plugin_query` / `plugin_put`）和 `plugin_blocks`（内容块，答案只在服务端）。`src/plugins/blocks.ts`：内容块工具只能在 `plugin:<id>` 会话里用，提交后宿主判分、结果作为带 `meta.submission` 的消息进入会话（`inbox.ts` 的 `Inbound.meta`）。接口在 `src/plugins/http.ts`（`/api/plugins/*`、`/plugins/<id>/` 静态页）。网页 `web/src/views/Plugin.vue` 用无同源权限的 iframe 载入插件页，经 `plugins/sdk/client.ts` 的 postMessage 只转发本插件的接口。内置 `plugins/english`：`english_quiz`（选择、填空、听写、翻译）、`english_grade`、`english_snapshot`，学习者画像在 `learner.ts`（类 Elo 技能分、知识点、薄弱和该复习的点）。插件页面由 `scripts/build-plugins.ts` 构建到 `web/dist/plugins/<id>/`。

- **插件第三期**（10-28）：`src/plugins/trust.ts`（数据目录插件的代码哈希与信任记录，`secrets/plugin-trust.json`）、`registry.ts` 的 `trustPlugin` / `untrustPlugin` / `loadCode` / `codeRuns`（信任前不 import 代码，撤销时 `tools.ts` 的 `unregisterTools`）、`api.z`、`api.service()`、插件工具的 `approval`（`tools.ts` 的 `alwaysApprove`，走 `held`）。`src/plugins/services.ts`：服务的启动、令牌、空闲停止、遗留进程清理与输出；`http.ts` 的 `attachPluginStreams`（`/api/plugins/:id/streams/:name` 的 WebSocket 转发，本人鉴权）与 trust、services 接口、`/plugins/_sdk/omem.js`。`src/core/procs.ts` 收拢了 `freePort`、`reachable`、`killPid`、`commandLine`（`ide-web.ts` 改用它）。`plugins/sdk/service.mjs`（服务端帮助模块）、SDK 的 `stream()` 与外壳 `Plugin.vue` 的中继；设置页“插件”（`web/src/components/PluginsSettings.vue`）。
- **插件页面复用 omem 样式**（10-29）：英语练习页引入 `web/src/styles.css` 和 `UiSegmented`、`Skeleton`，删掉自己那套 token 和按钮样式（主按钮原来是蓝色）；`plugins/sdk/blocks.ts` 的表单和图表改用 `.card` / `.btn` / `.input` / `.textarea`；构建时把 `styles.css` 复制成 `/plugins/_sdk/omem.css` 给普通 HTML 页面用。
- **插件第二期**（10-28）：清单 `settings` 与 `src/plugins/settings.ts`（值存插件记录的保留集合 `_settings`，`/api/plugins/:id/settings`，外壳 `web/src/components/PluginSettings.vue`，页面经 SDK `openSettings()` 打开）。宿主通用块 `src/plugins/generic.ts`（`plugin_form` 检查必填、`plugin_chart` 只展示，状态 `shown`），渲染在 `plugins/sdk/blocks.ts`，没有自己页面的插件用 `web/src/components/PluginDefault.vue`。`loadPlugins` 也读 `<数据目录>/plugins`（`source: "data"`，不加载 `server.ts`，`web/` 直接当构建产物）。`blocks.ts` 改成按 `PluginEnv` 工作：`presentBlock` 共用，`ctx.present()` 不经 Agent 放块；不在插件会话里交出的块新开会话并返回 `sessionLink`。英语插件的题库：`english_bank_add`、`english_next`（页面工具），`learner.ts` 的 `pickFromBank`，提交消息按出题方式提示陪练补题。`config.webUrl` 与 `src/core/util.ts` 的 `webLink`，`channels/item-notification.ts` 的通知卡片链接也用它。

## 记忆

- **写入检查、复核、对比运行**（10-18）：`src/memory/quality.ts`、`roles/memory-reviewer.md`、`jobs.ts` 的 `memory-review` / `ingest-shadow`，网页“记忆 → 质量”，`omem memories stats|check|prune|rejections`。详见 [记忆与事项](../concepts/memory-and-items.md) 的“记忆质量”一节。
- **记忆记录写入来源**（10-17）：`memories.agent_profile / model / effort / run_id`，由工具令牌带入。10-18 修正了兜底重试时令牌记录的仍是主模型的问题（`runner.ts` 的 `runRole`、`sessions.ts` 的兜底分支）。
- **档案专属记忆与标签**（10-18）：`memories.agent`、`memories.tags`；`recall` 可按 `tag` 筛，档案只看到共享的和自己的。
- **事项自动收尾**（10-25）：状态 `expired`（`src/items/store.ts` 的 `CLOSED_STATUSES`，有新依据或备注时重新打开）；`src/items/expiry.ts`（按类型期限、积压、保留、推断候选、清点）；`config.items`；`notify-gate.ts` 新增 `ownerFollowUp` / `ownerReactions`；新工具 `settle_items` 与角色 `roles/item-keeper.md`（运行 `item-settle`）；定时任务 `item-sweep`（每小时）、`item-digest`（每天 09:30，飞书卡片按钮 `item:keep|reopen:<id>`，`lark-actions.ts`）；表 `item_checks`；接口 `/api/items-expiry*`、`/api/items/:id/keep`；事项页积压预览与期限显示，设置 → 定时任务 的期限设置。
- **记忆目录**（10-25）：`memories.folder` 与 `memory_folders`（目录说明），`src/memory/folders.ts`（规范化、检查、移动、改名合并、删除上移、给 Agent 的目录树文本）；`remember` / `supersede` 的 `folder`、`recall(folder=…)`、新工具 `list_memory_folders`、`organize_memories`；`jobs.ts` 的 `memory-organize` 与新角色 `roles/memory-organizer.md`（定时任务“整理记忆目录”）；`/api/memory-folders*`；网页 `MemoryFolderTree.vue`。`omem pull` 合并 `memory_folders`。
- **写法要求**：`roles/_common.md` 的“怎么写记忆”重写，ingest 先按“和本人有关、以后能直接用、确定”三问筛。

- **相关空间**（10-18）：`space_relations` 表与 `relatedSpaces` / `relateSpaces` / `unrelateSpaces`（`src/core/spaces.ts`）。限定在一个空间的运行对相关空间只读（`runner.ts` 的 `readable`/`writable`，工具层 `writeSpace`、`inScope`）；`search`/`scan`/`find_symbol` 默认带上相关空间；`remember` 和记忆复核会列出相关空间里的相近记忆（`quality.ts` 的 `similarMemories`）；定期整理的候选来自 `src/core/space-candidates.ts`，由 dreamer 用 `relate_spaces` 决定。空间类型 `topic` 在界面上改叫“通用”。

## Agent 与模型

- **后台会话复用与清理**（10-23）：`background-sessions.ts` 为巡检、整理、简报、出卡和 Wiki 写作/检查保留在线 ACP 会话，按完整权限、指令和模型隔离，只在第一轮发角色说明。使用本轮真实上下文占用，超过 60% 或用量未知则释放；默认 60 分钟空闲、3 个后台进程。MCP 令牌逐轮指向当前运行，取消/正常停服时清理。CLI 单次任务启用临时参数；ACP 按能力调用 `session/delete`，Codex 实际归档而非完全不落盘。现有聊天、编码续轮和历史记录不批量更改。配置在 `sessions.background`，验证在 `test/background-sessions.test.ts`。同日补齐 TraeX：ACP 释放时用目录声明的 `archiveArgs` 调用归档命令，CLI 后备 `traex-cli` 使用 `--ephemeral`；其他 ACP 优先走 `session/delete`，无协议和命令能力时明确提示保留历史。

- **交办同时改多个仓库，worktree 改动可检索**（10-19）：`delegate_code` 的 `repo_spaces`（数组）、`check_commands`、`space`；`/api/delegate` 加 `repos`；`omem delegate --repos`。每个仓库一个 worktree（`runs/<id>/work/<空间>`），补丁按仓库存 `patches/<空间>.patch`，运行输出 `worktrees`、`repos`（旧运行的 `worktree`/`changes.patch` 仍认）；应用时全部先检查再一起应用，之后删 worktree。改过的文件建索引到临时空间 `wt-<运行id>-<仓库>`（类型 `worktree`，`src/agents/worktree-index.ts`），评审可读；`listSpaces` 默认不含它，`writeSpace` 拒绝写入，`omem pull` 不合并；应用、丢弃或 `repo-sync` 发现 worktree 不在时连同索引删除（`sweepWorktreeSpaces`）。运行页交办可多选仓库，详情按仓库显示检查和 diff。

- **按任务配置模型与强度**（10-16）：`config.agents.roleModels[角色][后端]`，`src/agents/models.ts` 的名称归一化（`GPT-Sol-6.1` 能对上 `gpt-6.1-sol`），会话级 `/model` 命令和飞书 `/model` 卡片（`src/channels/lark-model-card.ts`），网页 设置 → Agent → 按角色指定。10-18：Agent 档案回答的会话里 `/model save` 改写档案本身。
- **排队识别与兜底链**（10-16、10-17）：`config.agents.fallback`、`queueTimeoutMinutes`；`acp.ts` 从原始流识别 traex 的 `queue_begin`，区分“迟迟不开口”和“中途卡住”，前者走兜底（`runner.ts` 的 `fallbackProfiles`、`isRetryableAgentError`）。
- **静默运行**（10-16）：`runs.quiet`，巡检/做梦/整理返回 QUIET 时不进运行列表。
- **25 个内置 ACP Agent 与官方注册表**（10-14）：`src/agents/catalog.ts`、`omem agents registry|add`。

- **Windows 上新版 Claude Code 启动失败**（10-18）：它的 npm 垫片指向原生 `claude.exe` 而不是 JS 脚本，原来退回 `cmd /s /c` 时路径里的空格把命令拆坏（`'C:\Program' 不是内部或外部命令`）。`npmShimTarget` 现在也认 `node_modules\…\*.exe`，直接运行它（`src/agents/spawn.ts`）。
- **codex-cli 后备调不了 omem 工具**（10-18）：`codex exec` 的审批策略是 never，MCP 工具默认要审批，所以每次调用都被拒（`MCP tool call requires approval, but approval policy is never`）。`codexArgs` 现在加 `-c mcp_servers.omem.default_tools_approval_mode="approve"`，只放行 omem 这一个服务器，档案里额外配的 MCP 服务器不变，沙箱仍是 read-only / workspace-write（`src/agents/cli.ts`，测试 `test/cli-args.test.ts`）。

## 飞书

- **新会话直接执行任务与独立话题**（10-24）：`/new [任务]` 不再把参数只当标题，带任务时直接进入新会话执行，空指令仍开空白会话；网页返回新的会话 ID。新增 `/topic <任务>`，可从飞书群聊或机器人私聊主界面发起，以本条指令消息作为话题根，由机器人先开话题，拿到真实 ID 后再启动 AI，进度和答案留在话题内。后续追问按持久的独立话题设置路由，即使 `/mode chat` 也不并回主会话；已在话题内则直接拒绝，不启动 AI 或重置上下文。保留用户、空间和发消息权限，不带旧历史；开话题失败不启动任务。入口 `commands.ts`、`inbox.ts`、`threads.ts`、`lark-bot.ts`、`lark-send.ts`；`test/threads.test.ts` 用假 ACP 与飞书客户端验证。

- **通知保留外链按钮**（10-23）：普通通知此前只发送标题和正文，漏掉 `link`；现在与事项卡片一起显示 HTTP(S) 外链按钮，站内路由、无效地址和其他协议不生成按钮。事项正文或来源已有同一外链时不重复。入口 `src/channels/item-notification.ts`、`lark-bot.ts`，假客户端回归 `test/notification-card.test.ts`。

- **修复话题回复的内部引用外泄**（10-23）：规则首次开话题回复补上原件引用转换；主动发送、卡片更新及草稿同时覆盖。文档引用链接到原文，不把 omem 行号当成飞书段落锚点；没有外部地址时保留文字。卡片仅处理 Markdown，回调参数不改。

- **普通 @ 跳过缺席成员**（10-23）：目标群完整成员列表没有该姓名时，继续发送正文与其余提及，仅工具回执记录跳过，不再回退全局同名记录和邮箱。全局未关联记录不宣称是多人；群内真实重名、分页不完整和权限错误仍报错。加急、限定收件人不静默降级，已知机器人身份保留。内置消息技能同步此口径。

- **附件采集不再被解析卡住**（10-22）：原文件先保存，文档附件进入独立、可重试的 `lark-resource-parse` 运行，异步调用转换器，成功后关联原消息并整理；失败保留文件和错误，不阻塞消息分页。视频封面可选，原始 JSON 的视频本体参与缺失检查，外链副本不冒充原附件。Docling 修复构建路径及工具链启动提示混入正文，补齐 CSV / Office 格式分流，旧版 Office 缺 LibreOffice 明确提示。实际 CSV / DOCX / XLSX / PPTX 与表格附件解析通过；真实 Agent 两次工具行为抽查通过。

- **机器人卡片的名称规则漏触发**（10-22）：实时入口兼容事件的 `bot` 和读取接口的 `app`，不再把机器人送去用户通讯录查姓名，而是通过只读采集接口核实同一群、同一消息的发送者名称；只保存事件携带的机器人侧 ID，成功名称缓存 10 分钟，失败留待下条消息重试。匹配规则前等待群名；消息入库保留机器人类型，后续采集可修正旧类型。假客户端验证名称条件命中与两路去重，真实卡片只做条件判断验证。指定群的真实机器人 @ 已确认消息 mentions 正确，未观察到对方响应。见 `lark-sender.ts` 与 `test/lark-sender.test.ts`。

- **气泡失败与任务状态分开、群内 @ 补齐**（10-22）：气泡上传失败尝试撤回原消息，不再用“任务失败”收尾；`output.thinkingDelivery` 单独记录投递原因，`read_run` 区分它和运行状态。普通超时不禁用后续气泡，权限拒绝只冷却当前群。兜底卡片只保留状态及最终结果；收尾等待慢请求并清理表情、监听器和计时器。`mentions` 支持已知机器人侧 open_id；姓名记录不明确时核对授权目标群的完整成员列表，不按姓名合并跨应用身份，重名和不完整分页拒绝。邮箱 API 的非零业务码保留权限原因。机器人不在群成员列表里，须用本应用已收到的 @ 身份，app_id 和采集侧 open_id 不直传。见 `lark-cot.ts`、`lark-progress.ts`、`lark-people.ts` 及对应测试。

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

- 变更点逐处跳转（10-27）：选中的变更点下面列出它在代码里的各处位置（按页面顺序，同一文件按行号；改动里没有的文件标“不在改动里”），点哪处跳哪处；代码上方的吸顶条显示“上一处 / 下一处”和计数，键盘 `n` / `N` 同样可用；跳到的行短暂描边；文件树给当前变更点涉及的文件加同色圆点（`ChangeView.vue` 的 `stops` / `go`，`DiffTree` 的 `hot`）。`scripts/doc-screens.ts --serve` 只启动演示数据供手动查看。
- 文档站（10-27）：`site/`（VitePress，独立的 package 和锁文件）：首页、开始使用、命令行、各功能页；主题沿用网页的 token（`site/.vitepress/theme/custom.css`），`<Shot>` 组件显示截图。`.github/workflows/docs.yml` 在 main 上 `site/**` 变化时构建并发布到 GitHub Pages（`DOCS_BASE` 为仓库名）。截图由 `scripts/doc-screens.ts` 生成：在临时数据目录里放入虚构的演示数据（示例商城 · 退款改造：需求、方案、群聊、代码、Wiki、记忆、事项、带五个评审项的交办、规则），用构建好的网页截 17 张到 `site/public/screens/`，README 也引用它们。
- 编码前的 Git 同步（10-27）：`src/agents/code-sync.ts`（`syncWorktree` 拉取 / 合并 / 变基，`finishSync` 把每轮冲突交给解决者再继续，`moveToTarget` 把未应用的改动变基到目标分支最新提交，`popStash` 放回同步前收起的改动）。`code.ts` 的 `syncPhase` 在编码前运行：冲突交给编码 Agent（`conflictTask`，`roles/coder.md` 加了 `ask_owner` / `wait_answer`），剩下的停下来发提问 `code-sync`（继续 → 新一轮 `syncResume`；放弃 → 回到同步前）。`WorktreeRef` 新增 `start` / `syncHead`：应用时先 `merge --ff-only` 到 `syncHead`（目标分支必须还在 `start`），再应用补丁。没有会话链的网页交办续轮用 `review-fix.ts` 的 `queueStandaloneFix`（可带 `extraInput`）。`code-git.ts` 推送可指定 `branch`，`force` 用 `--force-with-lease=<分支>:<上次拉取的提交>`。接口 `POST /api/runs/:id/move-to-target`、`GET /api/asks/:id`；`/api/delegate` 接受 `sync` / `syncOnly`。
- 运行页的引用与修改点（10-26）：选中文字后有“加入提问 / 加入修改点”两个按钮，范围是运行详情和从它打开的引用抽屉（带 `data-quotable` 的区域；`CodeView` 行带 `data-line`，引用带上行号）。引用按运行存在本机（`web/src/lib/quotes.ts`），按 [1]、[2] 编号；提问抽屉（`AskAboutRun` 的 `basket`）可缩小成可拖动的图标（`QuoteDock.vue`，位置记在本机），继续选别处再加入；修改点在 `FixBasket.vue` 里逐条写要求，和评审里定为“改”的问题一起开始修改，“概览”的修改框也会带上它们。
- 差异的上下 / 左右两种排列（`lib/diffLayout.ts`，本机记住），左右时删掉的行和替换它们的行并排；改动文件树（`DiffTree.vue`，文件夹可折叠，单层目录合并显示），在“变更”标签和“活动”的改动里都有。点变更点时把它第一处标记滚到屏幕约三分之一处（以前滚的是整个文件，标记常在屏幕外）。
- 规则“发到”选群聊后保存，下拉框仍显示群名（以前显示那个群对应会话的标题，常是群里的第一条消息）。
- 应用后的“接收位置与提交”移到页头下面的卡片里；Windows 上接收目录路径统一成本机格式（`git worktree list` 给的是正斜杠）。

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

## 2026-10-23：发送者名字查不到时短暂不再查

- `src/channels/lark-sender.ts`：名字没查到（本人不在的群里机器人发的消息 lark-cli 读不到、通讯录权限缺失）也缓存 2 分钟，之后再试；原先每条消息都会在处理前再起一次 lark-cli 或调一次通讯录接口。

## 2026-10-23：git 不再为临时仓库留下 fsmonitor 进程

- 用户配置里开了 `core.fsmonitor` 时，git 对每个碰到的仓库起一个脱离的 `fsmonitor--daemon`，仓库目录删掉后进程还在。测试里每个应用都有一个临时知识库仓库，交办编码也开临时 worktree，累积了几千个常驻进程，占满提交内存后测试进程分配失败。
- `src/core/git.ts` 的 `disableGitFsmonitor` 用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` 把 `core.fsmonitor=false` 放进进程环境（`App.open` 调用，测试在 `test/setup.ts`），omem 和它启动的 Agent 跑的 git 都继承；已在环境里设过就不重复。

## 2026-10-23：定时 / 消息唤醒

- `src/agents/wakes.ts`：`wake_later` → `scheduleWake` 建 `kind=wake` 的排队运行（`not_before` 为唤醒时间，`wakeTime` 限 1 分钟到 7 天）；到点 `fireWake`。`wake_on_message` → `saveRule` 带 `temporary`（`expiresAt`、`once`、`setBy`、`watch`），条件是群 id 加参数给的条件（默认排除机器人），动作 `wake`；`runAction` 的 `wake` 调 `fireWake`，`once` 时触发后 `deleteRule`；`consider` 跳过过期的，巡检 `expireTemporaryRules` 删除。普通规则不能带 `wake`（`saveRule` 拒绝）。迁移：`rules.temporary`。
- `fireWake`：目标是会话时加一条 `meta.wake` 的助理侧记录，有排队的 ask 就并进去，否则开 `input.wake` 的 ask 运行；`sessions.ts` 在这一轮只有唤醒记录时用 `# 唤醒` + `WAKE_NOTE` 框起来（不做被动召回），`jobs.ts` 的 ask 处理器把回答 `deliverToThread`，QUIET 不发。目标是档案时开 `kind=agent` 运行（`threadId` 指回原会话，唤醒自己时带上次的 `resumeSessionId`）。`skipIfOwnerSpoke` 时本人之后说过话就跳过。
- 每个会话或档案最多 5 个待触发（`checkPending`），`cancel_wake` 列出 / 取消；主助手和 Agent 档案都有这三个工具。`GET /api/wakes`、`DELETE /api/wakes/:id`；`GET /api/rules` 不再返回临时规则，规则页列表底部单列“临时唤醒”。
- `roles/_common.md` 加“等一会再接着做”，`docs/v2/rules.md` 加“临时规则”，`skills/omem/SKILL.md` 列了新工具。

## 2026-10-23：工作文件、案例页、日常不足信号

- 工作文件（`src/sources/work.ts`）：原件 `kind=work`，uri `work/<路径>`，meta 记 `expiresAt`、`links`（`item` / `rule`）、写入它的运行和写入次数。`write_file` 工具（主助手和 Agent 档案）：`replace` / `append`，`expires` 接受 `30d`、`12h`、`2w`、日期或 `never`；挂事项时新建会在事项时间线记一笔，规则触发的运行里写的默认挂到那条规则。巡检先 `expireWorkFiles`，过期的变墓碑（`deleteSource`），同一路径再写是新文件。不排进 ingest。
- 事项：`read_item` 和 `GET /api/items/:id` 带 `files`，网页事项详情显示“工作文件”。规则：`agentAction` / `silentAgent` 的任务里加“这条规则的工作文件”（`ruleFiles`）。原件页可按“工作文件”筛，详情显示过期时间。
- 案例：`write_page` 的 kind 加 `case`；`upsert_item` 把有 4 条以上时间线的事项标成 done 时，返回里提示写 `cases/<主题>` 案例页并记一条指向它的 experience。`roles/_common.md` 加“工作文件与案例”。
- 不足信号（`src/memory/gaps.ts`）：失败运行按类型计数、回答开头说没找到（`NOT_FOUND`）配上前一句提问、本人以“不对 / 错了 / 你搞错…”开头的消息配上前一条回答、复核撤回、写入检查拦下（按原因计数）、被动召回带上 / 用上。做梦整理任务新增一段（有信号时即使没有别的变化也会跑），`roles/dreamer.md` 第 5a 条说明怎么处理；`GET /api/shortcomings?days=`，网页“记忆 → 不足”。

## 2026-10-23：问本人、下一步按钮、工具审批

- 新表 `asks`（`src/agents/asks.ts`）：`question` / `suggestion` / `approval` 三种，带选项（`label`，可选 `message`：点了替本人说的话）、是否允许文字回答、状态、回答、是否已被 Agent 拿到（`consumed`）、何时展示（`shown_at`）。
- 工具：`ask_owner`（先等 `wait_seconds`，默认 40）、`wait_answer`（每次 ≤ 50 秒，codex 等 MCP 客户端默认 60 秒超时）、`suggest_next`（只在有会话的运行里）。`prepareRun` 给主助手和 Agent 档案前两个，非访客都给 `wait_answer`。
- 回答去哪：有 Agent 在等就直接给它；提问的运行还在跑就先留着，运行结束时 `settleAsks`（`runs.ts` 收尾调用）作为 `[回答] …` 消息送回会话；没有会话的通知本人。建议按钮在运行结束后展示（飞书机器人回完话立刻 `showSuggestions`，其他情况 4 秒后），点了用 `receive(fromAsk)` 替本人说出 `message`。
- 对话里回复即回答：`receive` 先调 `answerFromMessage`——回编号选最近带选项的提问或建议；有提问就以这句话作答（Agent 在等时这条消息不再开新一轮）；审批要“批准 / 拒绝 + 理由”；其余情况让旧建议失效。`fromAsk`、群里别人说的话、访客不参与。
- 审批：`config.approvals.tools`（默认空）、`waitSeconds`；`callTool` 对列出的工具先 `held`：建审批、等一会；批准后 `setApprovalExecutor` 用当时的工具上下文执行，结果写进 `result`；拒绝理由经 `describeAnswer` 回给 Agent。
- 展示：飞书 `src/channels/lark-asks.ts`（卡片：选项按钮 + 文字框表单；审批是批准 / 拒绝；答完卡片改成记录；交互 `purpose: "ask"`，`lark-actions.ts` 转给 `handleAskAction`）；网页 `AskCard.vue`（对话页输入框上方、回答下方，“今天”页“等你回答”），接口 `GET /api/asks`、`POST /api/asks/:id/answer`，事件 `type: "ask"`；Telegram / OneBot 等发编号列表。
- `roles/_common.md` 加“问本人、给本人选项”，`skills/omem/SKILL.md` 列了新工具。

## 2026-10-23：飞书知识库、加急与只给部分人看、以本人身份写文档

- 知识库（`src/channels/lark-wiki.ts`）：`wikiNode`（`wiki +node-get`，131014 = 不在知识库）、`wikiChildren`（`+node-list` 分页）、`personalLibrary`（`wiki spaces get my_library`）。`importLarkDocument` 对 `/wiki/` 页面在 depth > 0 时把文档类子节点当同一层的链接（`docWikiChildren`，正文没链到的追加到末尾“知识库子页面”），整条导入共享预算 `docMaxPerImport`（`opts.budget`）。
- 知识库爬取：kv `lark_wiki_crawls` 存队列、已见节点、读到的原件 id；`crawlLoop` 每篇 `importLarkDocument(depth 0, wikiChildren false)`，新建的页面用 `relinkParent` 改掉此前页面里的链接；`batch` 读完一批 `paused`，`continueCrawl` 继续；缺权限时暂停不计失败；`resumeCrawls` 启动时继续；读到的交给整理（kv `lark_wiki_crawls:<id>` 记已交出的数量）。工具 `lark_wiki_crawl`，`omem lark wiki-crawl`，`GET /api/lark/wiki-crawls`、`POST /api/lark/wiki-crawls/:id/(continue|stop)`。`import_url` 加 `depth`。
- 授权（`src/channels/lark-auth.ts`）：lark-cli 错误带 `missing_scopes` 时抛 `LarkScopeError`；`asOwner` 把它变成一次 `auth login --scope … --no-wait --json`，链接经 `notify` 发给本人，后台 `--device-code` 等确认；同一组权限有效期内只发一次链接。`USER_FEATURES` 列读知识库和写文档要的权限，`omem lark user-permissions [--grant]`、`GET/POST /api/lark/user-permissions`、设置页“检查 lark-cli 授权”。
- 写文档（`src/channels/lark-doc-write.ts`）：`placeFor`（不填 / `my_library` = 个人文档库根目录；知识库页面；云空间文件夹）和 `docPlace` 判断位置是不是本人自己的（个人文档库，或 `drive metas` 的 owner 是 lark-cli 登录的本人）。工具 `lark_doc_create` / `lark_doc_update` / `lark_doc_move`：不是本人自己的位置时经 `held` 审批，问题写明知识库名和父页面，执行器带 `approved: true` 重跑不再拦；外部 Agent（工具上下文没有 `larkChats`）不能用；只有主人能用。
- 加急与只给部分人看：`larkTarget` 加 `urgent`（≤ 10 人）和 `only_to`（≤ 20 人），`larkDelivery` 按 `ctx.larkPowers` 放行并用 `resolveMention` 对人；`lark-send.ts` 的 `deliverLark`（`urgentLark` = `im.message.urgentApp`，`sendEphemeral` = `/ephemeral/v1/send`，按 `ou_` 前缀选 open_id / user_id）；草稿确认带上 `delivery`。规则 agent 动作加 `allowUrgent` / `allowPrivate`（`runner.ts` 的 `LarkAccess`，本人自己的运行两样都有），任务里写一句什么时候可以用；规则草稿生成会按原话勾上；规则页两个开关。
- `skills/library/lark-messaging/SKILL.md` 加加急和只给部分人看；`roles/assistant.md` 加知识库爬取和写文档的工具与做法。

### 2026-10-23：规则档案的临时复查

规则触发的档案给自己设唤醒时，延续原空间、用户身份、群聊投递范围与草稿/静默设置，复查可回到原话题。指定其他档案不会继承原运行的渠道权限或会话。档案唤醒返回 QUIET 时不投递，避免无变化也发消息。入口：`src/agents/wakes.ts`、`jobs.ts`；回归：`test/wakes.test.ts`、`test/lark.test.ts`。

## 2026-10-23：长说明的确认弹窗

- 临时唤醒取消时，标题与说明分开显示，说明不再挤进标题。
- `DialogHost` 的内容区支持长链接换行和限高滚动，操作区保留在可见范围；关联说明的无障碍标签。桌面、手机和较矮视口检查换行、滚动、取消与焦点返回。


## 2026-10-23：技能目录、档案默认 AI 与任务选型

- 技能页可展开多层目录，查看、编辑、新建和删除附属文本文件，切换文件时保护未保存内容。入口仍为 SKILL.md，附属文件列表改为递归相对路径；文件读写拒绝越界、符号链接、二进制和超过 2 MB 的文本，修改保留知识库 Git 历史。
- 内置角色的默认后端、模型和强度从设置页移到 Agent 档案页，继续使用原有 roles / roleModels 配置，无需迁移。与自定义档案共用检测控件：可用后端优先，模型和强度来自检测结果，无法检测时手填。
- 设置页新增任务选型：自主选择开关、总体偏好、具体后端/模型/强度及适用说明。工具 list_ai_backends 提供实际可用性和偏好；交办、独立工作会话续轮、请教、编码和评审可临时选择 AI 并记录理由，不覆盖档案默认。临时 assistant 任务无需新建档案，受调用者权限限制，禁止再次交办。
- 当前已开始的一轮不切换 AI；后台角色继续用角色默认。不同 AI 的工作轮次不复用旧后端会话；编码自动续轮保留本次编码和评审选择。ACP 实际握手发现明确指定的模型或强度不支持时失败，不悄悄使用默认值。
- 验证明细见 docs/v2/acceptance.md 对应条目。

## 空间与归档（10-23）

- 问答、原件和运行列表按所选空间展示，切换空间退出旧详情。任务规则保存所属空间、可选执行空间与结果会话；主助手成为默认执行者，不再选最接近的专用档案。旧无空间任务规则保持全局。入口：`src/rules/`、`src/core/capture-space.ts`、`web/src/views/Ask.vue`、`Runs.vue`。
- 规则分为任务规则和归档规则。归档先尊重手动归属及来源绑定，再按创建顺序匹配确定性条件，未命中的由 `archivist` 判断，不确定留个人。自然语言编写由 `archive-rule-writer` 调用草稿工具，核对保存后生效。入口：`src/sources/archive.ts`、两个新角色说明、`web/src/views/ArchiveRules.vue`。
- 历史材料可预览规则结果、校验后应用或交给 AI 判断；原件详情可指定归属并查记录。迁移保留 ID、正文、引用、消息位置与切片 ID，更新空间索引并失效向量缓存，原采集入口别名避免重复副本。已有记忆、事项和 Wiki 不自动搬动。

- 空间与归档补验：真实 Codex 完成隔离归属判断和自然语言草稿匹配，浏览器完成空间切换、规则保存及手动迁移。修正文本附件漏归档、归档后逐份重复排整理任务，以及模型使用未知材料类型的问题；类型条件明确使用 doc 等内部键名，并在草稿和保存入口统一校验。

### 2026-10-23：归档顺序、材料整理与飞书节点

- 移除归档规则的数字优先级，按创建顺序首条命中；编辑不改变顺序，旧规则自动迁移。
- 归档规则页使用任务规则的左列表、右编辑结构；加号左侧新增整理入口，在右侧预览并应用已有材料的归属。
- 飞书文档采集保存知识库 ID、节点及父节点，包括零深度导入和正文未变的刷新；标题、正文和上述元数据均可匹配。增加固定只读设备命令 `lark-wiki-node` 查询节点。

### 2026-10-24：归档条件改为名称和目录

- 归档移除 ID、token、作者和父页面地址条件；旧规则含已移除字段时整条停用，保留原始配置供核对，不自动放宽条件。
- 材料类型与采集渠道显示中文选项，逐条说明字段用途；按名称和文字匹配，不推测主题或同义词。
- 飞书采集保存知识库名、直接父目录名和完整祖先目录路径；失败或目录不完整时不使用旧名称匹配，排除未知字段也不命中。
- 整理已有材料可单独更新飞书目录，进度持久保存，正文、切片与引用不变；共同的祖先节点短时缓存，主动刷新清除缓存。

## Wiki 生成入口（10-24）

聊天新增 `generate_wiki`，与网页、CLI 共用 `src/wiki/generate.ts` 的规划与逐页写作流程。`focus` 完整传给每个写作子运行，保留发起用户和材料只读范围，页面只写入目标空间。助手不再自己先写工作文件或尝试用普通交办调用内置 Wiki 角色；规划、写作、检查说明补充代码优先、过时文档辨别和草稿核实。自定义角色需合并源码更新才能取得新工具与说明。

## 2026-10-24：分档、多角度评审方案（设计，未实现）

- 现状是交办编码链单个 `reviewer` 评审、自动最多 3 轮（`src/agents/code-chain.ts`）。新设计在中大型改动上扩展：`docs/v2/review.md`。
- **工作集（workset）**：一个需求的跨空间上下文容器，只引用不复制，成员含文档、聊天、会话、文件、仓库空间与目标分支/基线，带版本快照与 stale 提示；新增 worksets / workset_members 表与 `create_workset` 等工具，可挂事项。
- **业务理解简报**：新角色 `business-analyst` 编码前从工作集提取带引用的业务规则和编号变更点（CP），本人确认或 lead 采信；业务规则仍沉淀到记忆/Wiki，不建第二份知识。
- **分档与评审委员会**：新角色 `review-lead` 编码前后两次 triage（light/standard/full，确定性预筛 + 理由可调）；功能（现有 reviewer）、风格规范、架构、业务理解、历史问题回扫五个只读赛道各跑独立会话、可分别配模型；新增 reviews / review_findings 表与 `submit_review`，lead 去重裁决、增量复审，轮数不收敛/僵持/方案分歧时停下来升级本人，防死循环。light 档保持现有链路不变。
- **变更解读视图**：以需求维度组织的三栏界面（业务 CP ↔ 代码行双向定位、气泡图例引导、流程图、分轮 diff、就地提问），引用统一走 CitationDrawer；（初稿原型已被修订版替换，见下）。分四阶段落地，未实现。

## 规则页整理（10-24）

- 去掉侧栏“规则”下的二级菜单，改为规则列表顶部的“任务规则 / 归档规则”切换（同 Agent 页的“档案 / 技能”），`/rules/tasks` 重定向到 `/rules`。
- 任务规则：空间选择并入“什么时候看”（“所有空间的群”或某个空间），新建规则默认不限空间；“结果发到”只在定时规则要回复时出现在动作里；动作的空间选择改为“默认空间”并用提示说明解析顺序；判断方式与说明同行，缩短触发说明。
- 归档规则：整理入口从图标按钮改为列表底部的“整理已有材料”；选中的规则可上移调整匹配顺序；文案统一为“规则原话 / 从原话生成条件”。原件详情的归属改为标题下一行“空间 · 依据 + 换空间”，历次归属显示空间名。

## 评审方案修订（10-24，设计，未实现）

- 档位改为可编辑的有序清单 `config.review.tiers`（默认轻 / 标准 / 完整），每档的触发条件（复用规则条件编辑器，字段为宿主算好的改动指标）、评审项、最多轮数、是否先看计划、业务简报策略都在 Agent 页新增的“评审”标签里改，可增删档位。
- 评审项（初稿的“赛道”）就是 Agent 档案：内置五项是内置角色，走现有自定义 / 合并；专项（如安全评审）新建档案勾“用作评审项”，可设“额外在什么时候加上”和挡住应用的级别；作为评审项运行时强制只读。
- 工作集并入事项：事项加材料清单（`item_materials`），简报和变更视图挂在事项上。
- 评审结果放在运行详情的“概览 / 变更 / 评审 / 活动”标签里，讲解与就地提问用右侧抽屉；去掉独立三栏页面、首次引导和行内气泡。新原型 `docs/v2/design/review-prototype.html` 直接引用 `web/src/styles.css`。
- 落地顺序改为：可配置多评审项 → review-lead 协调 → 事项材料与简报 → 变更视图。

## 分档评审第一阶段（10-24）

- `config.review`：有序档位（默认轻 / 标准 / 完整，`when` 条件、`guide` 一句话说明、`checks`、`maxRounds`）和评审项设置（`label`、`blocks` 阻塞级别、`when`、`guide`）。条件字段为宿主算的改动指标（行数、文件数、仓库数、路径、检查是否通过、任务原文），比较新增 `gte / lte`。第一轮先按条件选档，再请模型对照说明判断能否升档、加评审项。
- 新内置角色 `review-business` / `review-arch` / `review-style` / `review-history`；Agent 档案挂成评审项后也可参加。评审项运行时只给只读工具和 `submit_review`，不带额外 MCP，不能写。
- `submit_review` 写 `reviews` / `review_findings`；没调用的按文字结论兜底。达到该项阻塞级别的问题合成修改单交给编码续轮；轮数上限随档位（`CodeChain.maxRounds`）。
- `delegate_code` 新增 `review_tier`、`review_checks`；`/api/delegate` 接受 `reviewTier`。接口：`/api/review-settings`、`/api/review-options`、`/api/runs/:id/reviews`、`/api/runs/:id/file`。
- 界面：Agent 页“评审”标签；运行详情“本次评审”、按行号的 diff 与上下展开、选中内容就地提问（每个运行一个问答会话）。
- 同期修正：定时规则“先给我看”发到飞书会话时草稿落到原话题，网页会话按直接回复；归档迁移只让两个相关空间的向量重新加载。

## 分档评审第二阶段：评审负责人（10-24）

- 新内置角色 `review-lead` 和工具 `rule_review`（只在负责人运行里可用）；评审一轮的逻辑移到 `src/agents/review-chain.ts`，可在编码运行末尾执行，也可在本人确认计划后作为 `review` 运行执行。
- 档位新增 `lead`（默认标准、完整开）、`confirmPlan`（默认完整开）；`config.review.rereviewAllEvery` 默认 2。编码前预估档位，编码后判档可参考预估、开负责人的档可降一档。
- 四种停止条件（轮数上限、不收敛、僵持、方案分歧）写 `reviewStop`，链的 `waitReason` 同名；提问卡片的答复通过 `registerAskHandler` 处理（确认计划、继续 / 接受 / 停下）。
- `review_findings` 增加 `merged_into`、`triage_note`；`/api/runs/:id/reviews` 返回预估、各轮负责人结论、停止原因和待答的决定。飞书进度卡片加评审项行与负责人结论。

## 界面整理（10-24）

- 设置 → Agent“排队与兜底”改成逐行选择后端 / 模型 / 强度（可上移、移除），排队等待时间改为下拉；记忆对比运行的强度有选项时也用下拉。
- 空间卡片精简：说明限两行，目录只显示最后一级，相关空间一行，原件数、页面数和子模块状态放在底部。
- 事项卡片长标题、长等待对象不再溢出，空间标签显示空间名；全局 textarea 只能纵向拖动，`.stack` / `.card` / `.field` 里的段落去掉浏览器默认外边距。
- `delegate_code` 新增可选 `title`，运行列表和进度卡片用它代替任务第一行。
- 编码运行的 Agent 会话改为保留（`persistSession`），之前 Codex CLI 的编码会话是临时的，第 2 轮续接必然失败；续接仍失败时在同一工作区换新会话并带上原始任务。`continue_code_run` 续接最近一个有会话的轮次。
- review-lead：低于阻塞级别的待确认点用通过并写“建议你确认”，只有挡住应用的分歧才上报；结论不写问题编号。运行页在等你确认计划 / 做决定时不再重复显示同样的说明。
- 设置保存后只在改了启动时才读的设置（监听地址和端口、向量检索、飞书机器人开关和应用、Telegram、OneBot）时提示要重启，并列出是哪几项；`PUT /api/settings` 返回 `restart`（改动的启动项名称），去掉总是为真的 `restartNeeded`。
- 规则页的临时唤醒可以点开看详情（只读）。全局选中文字改为深色字，深色按钮和提示上选中的文字不再看不清。

## 回溯速度、换 AI、运行显示模型（10-25）

- 飞书历史回溯从 10 分钟一次的采集里拆出来，在独立后台循环按 `lark.capture.backfill.pagesPerMinute`（默认 20）和 `concurrency`（默认 2）推进，限流时退避（30 秒起翻倍，最长 10 分钟）；配置每轮读取，改了立即生效。去掉 `pagesPerPoll`。`set_lark_backfill` 新增 `pages_per_minute`、`concurrency`，返回总体进度；远程命令新增 `backfill-status`。
- `generate_wiki` 新增 `execution`，规划和各页写作都用它（`input.ai`）；新工具 `switch_run_ai` 给排队 / 进行中 / 失败的运行及子运行换 AI。`runRole` 在调用方没给选择时用运行自己的 `input.ai`（编码和评审运行除外）。
- 运行记录新增 `ai` 列（后端、模型、强度），在准备运行时记下主角色的选择，回退到别的后端时更新；运行列表和详情显示。排队中的运行返回 `waiting`（等空位、等同一会话前面的运行、定时）：这是 omem 自己的排队，开始时才选定模型；后端自己的排队在运行开始后的过程里显示。

## 网页缓存与预加载（10-25）

- 构建产物 `assets/*`（文件名带哈希）返回 `cache-control: public, max-age=31536000, immutable`，`index.html` 和前端路由回退返回 `no-cache`；之前全部是 `max-age=0`，每次都要回源验证。
- 经中间节点转发（`/api/peers/:id/*`）时保留对方的 `cache-control`、`etag`、`last-modified`，并转发 `if-none-match`、`if-modified-since`；之前这些都被丢掉，`omem peer open` 打开经中转的同伴时浏览器完全不缓存。
- 修正路由预加载：没写明 key 的路由（记忆、学习、Agent、规则、通知、设置）都被算成 `/` 互相覆盖，空闲预加载和悬停预加载对它们不生效；规则归档页也加入空闲预加载。

## 唤醒复查不留空气泡（10-25）

- 唤醒开的档案运行（`input.wake`）的思考气泡改为先收着不发（`startCot` 的 `defer`）；运行结束时 `endCot` 判断：回 QUIET 就丢掉，从不创建；有话要说就整段发出并收尾，再投递回复，顺序不变。实时发出的气泡如果运行最后是 QUIET，会被撤回（`finishCot` 的 `quiet`）。
- 唤醒开的 ask / agent 运行回 QUIET 时记 `quiet = 1`（之前对话类运行一律不记），`wake` 运行本身也记为无事可报；迁移把以前的补标。

## 多个飞书机器人、归属判断积压、任务选型、检测缓存（10-25）

- 新配置 `lark.bots`（`id`、`appId`、`agent`、`enabled`、`ownerOpenId`）和 `lark.botRelay`。每个额外机器人一条长连接，被 @ 或私聊时以绑定的 Agent 档案回答，会话 channel 为 `lark:<id>`；后续投递、`lark_*` 工具（`ToolContext.larkBot`）都经这个机器人发。群里每轮带 omem 机器人名单；回复里 `@名字` 由 `relayMentions` 在进程内交给对应机器人，连续转交有上限，有人发话清零。`lark-send.ts` 新增 `setLarkBotClient`、`larkClientFor`、`postedByOmem`，`Target.bot`；`reactLark` / `unreactLark` / `updateLarkCard` / `uploadLark` 多一个 `bot` 参数。`omem setup` 加“添加机器人”，设置 → 渠道加“其他机器人”。
- 常驻机器上积压了上千个“判断材料归属”：历史回溯按月写的 `lark:<会话>@<月份>` 原件每写一页都重排一次；`queueArchive` 只看最早的排队任务，它满 40 份后每次都新建单份任务且不去重。改为合并进任何未满的排队任务、全队列去重；同一会话已判断过的（留在个人空间的聊天、已判断会话的历史月份）沿用判断；启动时 `compactArchiveQueue` 重新打包旧队列。迁移加了 `json_extract(meta,'$.chatId')` 的部分索引。
- 任务选型：之前候选只在 `list_ai_backends` 里，真实运行里一次自主选型都没有。现在打开自主选型且有候选时，能交办的运行的环境说明里有“任务选型”一节；`_common.md` 改为每次交办对照候选选择。
- 模型检测：`/api/profile-options` 的后端带上缓存的检测结果；前端 `lib/probes.ts` 各页面共用，同一标签页只问一次；显示检测时间。
- 运行记录页加状态筛选（全部 / 排队中 / 进行中 / 失败），筛选时列表随运行状态变化刷新（合并 0.4 秒内的事件）。

## 机器人能力一致（10-25）

- 主机器人和 `lark.bots` 跑同一套代码：`startLarkBot(app, ref)` 建连接，`setupLarkBot(app, ref, client)` 装处理逻辑（测试传假客户端）。原先额外机器人的简化处理（`onBotMessage` / `botTurn`）删掉，`registerMainRelay` 换成按机器人的 `registerRelay`。
- 新增 `core/bot-context.ts`：AsyncLocalStorage 记“以哪个机器人说话”。`larkClient()` 跟随它；运行开始时重置为主机器人，`runTool` 按 `ctx.larkBot` 切换；`lark-cot` 不再用 `setCotSdk` 设的全局客户端（只留给测试），每个气泡记 `bot`；进度卡片、提问卡片、编码进度、Agent 气泡、通知按所属会话选机器人；`card_interactions` 加 `bot` 列（迁移）。
- id 按应用区分：额外机器人不把自己看到的 open_id 写进 `lark_people.bot_open_id`，@ 人和读群成员用 `user_id`；卡片可操作人、本人在群判断（`ownerInChat`）用各自应用的 id；去掉“只有主机器人能加急 / 只给部分人看”的限制。
- 群的采集、规则、监听只做一次：`keepsRecords` 判断主机器人是否在群里。规则事件带 `bot`，规则交给的 Agent 通过这个机器人回复。

## 分支：评审已有分支、按分支检索（10-25）

- `code` 运行新增输入 `branches`（按仓库空间：`branch`、`base`）和 `fetch`：`checkoutBranch` 把分支 `--detach` 检出成 worktree 再 `reset --soft` 到分叉点，跳过编码，`coderSummary` 是提交列表；`reviewRound` 对它不续轮、不发升级提问，通知标题“分支评审…”；`applyCodeRun` 拒绝，`continue_code_run` 拒绝并提示 `from_branch`。`createBranchReview` 是工具、接口和命令行共用的入口。
- `delegate_code` 新增 `from_branch`（输入 `fromBranches`）：worktree 从该分支开始。`/api/delegate` 接受 `fromBranch`，`omem delegate --from-branch`。
- 新工具 `review_branch`、`list_branches`；`search`、`find_symbol` 新增 `branch`。`review_branch` 和 `delegate_code` 一样不给外部 MCP、不给唤醒接手的回合和请教。
- `worktree-index.ts`：`indexBranch`（`git show` 读分支改过的文件，不检出；空间 `br-<仓库>-<分支>-<hash>`，类型仍是 `worktree`，设置里有 `branch`、`baseRef`、`commit`、`deleted`），`branchIndexes`、`refreshBranchIndexes`（`repo-sync` 时更新），`overlayRepo`；交办工作区也记下删除的文件。`sweepWorktreeSpaces` 删掉分支已不存在的分支索引。
- `search.ts` 的 `shadowedFiles`：检索空间里同时有仓库和它的工作区 / 分支索引时，仓库里被改过或删掉的同名文件不出现。工具层 `canRead`：能读仓库就能读它的工作区和分支索引。
- `core/git.ts`：`resolveRef`、`fetchBranch`、`defaultBaseRef`、`listBranches`（不列 `omem/<运行>` 交办分支）。
- 接口：`GET /api/spaces/:id/branches`、`POST|DELETE /api/spaces/:id/branches/index`、`POST /api/review-branch`、`/api/search?branch=`。命令行：`omem review-branch`、`omem branches`、`omem search --branch`。网页：运行页“交办”弹窗分“实现 / 评审分支”，可选起点分支、要评审的分支和基线。

## 原件关注程度、标注与存量整理（10-25）

- `sources` 加 `attention`（focus / reference / ignore，null 为一般）和 `attention_by`（owner / agent / rule，低的不覆盖高的）；新表 `source_notes`（行范围、outdated / wrong / key / note、以哪份为准）、`attention_rules`、`digest_jobs`、`digest_done`。`src/sources/attention.ts`。
- 检索：忽略的不进全文和向量召回（`includeIgnored` 例外），融合后按档和标注调整分数，命中带 `attention`、`notes`。`read_source` 开头列出本段的标注和档位。
- `upsertSource` 对没人定过档的新材料套用关注程度规则；`scheduleIngest` 跳过仅检索和忽略的；`ingest` 角色可写主题页、`annotate_source`、`set_source_attention`。
- 存量整理 `src/agents/digest.ts`：运行类型 `triage`（角色 `triager`）、`digest`（角色 `distiller`），定时任务 `digest` 每 10 分钟补排；连续 3 批失败暂停。
- 工具：`set_source_attention`、`annotate_source`、`attention_rules`、`digest_sources`；`list_sources` 加 `level`。接口：`/api/sources?level=`、`/api/sources/levels`、`PUT /api/sources/:id/attention`、`POST /api/sources/attention`（含 dryRun）、`/api/sources/:id/notes`、`DELETE /api/source-notes/:id`、`/api/attention-rules`、`/api/digest-jobs`。远程命令 `digest-status`、`source-levels`；命令行 `omem digest`。网页：原件页档位筛选、详情里的档位和标注、“整理”弹窗。

## 并行与模型容量、存量整理加速（10-25）

- `src/agents/capacity.ts`：按“来源 + 模型”计数的空位（来源是账号：`traex-cli` / `codex-cli` / `claude-cli` 的 `source` 指向对应 ACP 后端）。`config.agents.capacity`：`perModel`（默认 3），`limits` 带模型是该模型上限、不带模型是整个后端合计（可不设），0 表示不自动使用。`config.concurrency` 上限改为 32。
- `runRole`：开始前 `acquire`；默认模型满了按顺序换到角色在其他后端配置的模型（`roleModels`，`roleAlternatives`）和兜底，都满了等（状态“等模型空位”），重试也重新取空位；显式 execution 和档案任务不换。对话回合 `holdForRun` 计入占用但不等，运行结束 `releaseRun`。
- 选型：`routingGuide` 不再要求有候选，列出各模型占用和近 7 天完成、失败、中位时长（`loadLines`），豆包标明没有工具；`list_ai_backends` 返回每个模型的 used / limit / recent7d 与 `tools`；`validateExecution` 拒绝助手自选上限为 0 的模型。`choosableProfiles` 去掉已有 ACP 的同源命令行后端。
- 存量整理：任务加 `parallel`、`batch`、`chars`；`queueNextBatch` 补足到 `parallel` 批，各批材料不重叠（查在途批次的 `sourceIds`），不再用 lane；精读批次在任务里附带行号的正文（默认 15 万字、最多 40 份），分级默认每批 150 份。`updateDigestJob` / `PUT /api/digest-jobs/:id` / `digest_sources action=pace` / `omem digest --pace` 调速度；`after` 等另一个任务做完再开始（那个任务完成时立即补排）；`countDigest` 把做过后被降档的材料算进已完成（以前精读降档后从总数和进度里消失）。
- 接口 `GET /api/agents/load`；网页 设置 → Agent → 并行（`AiCapacity.vue`），整理弹窗可设同时几批、每批几份并调整进行中的任务。
- 评审角色：`review-style` 从“只报明确约定”扩展到通用代码质量（重复造轮子、为封装而封装、模块划分、命名、注释里的中间指令）；`reviewer`、`review-business`、`review-arch`、`review-history` 加常见漏项和迁移类改动的对照要求。
- 分支评审的可读范围：`CodeInput.readSpaces`（`review_branch` 的 `read_spaces`、`POST /api/review-branch` 的 `readSpaces`、`omem review-branch --read`），加进编码与评审运行的空间范围；需求文档在个人空间、迁移要对照源仓库时用。接口按发起人可访问的空间校验。
- 评审档位条件新增 `change.codeLines`（有效代码改动行数）：`reviewMetrics` 按 `isSourceFile`（`src/sources/chunk.ts`，源代码扩展名，排除 `.min.js`）只累计源代码文件的增删行；档位理由和负责人估计里同时写出总行数和有效代码行数。默认档位不变，可在 Agent 页 → 评审 改用它。

## 编码和评审结束的卡片、夜间通知早上补发（10-26）

- 评审结束（不再自动续轮时）发一张带按钮的卡片（提问 `review-done`，`review-chain.ts` 的 `askDone`）：结论、改动和检查、各级问题数和默认要改的前几个（严重及以上和负责人接受的，与网页默认选中一致）、需求拆分的变更点数。分支评审或没通过的交办：“按评审修改 / 先不改”，输入框的文字作为补充要求一起改；通过的交办：“应用到仓库 / 丢弃改动”。分支评审通过且没有要改的只发通知。停下来等本人决定的（`escalate`）也带上同样的摘要。
- 确认评审计划的卡片带上编码 Agent 的改动统计、检查结果和说明。
- 宿主自己的提问（带 `handler` 的：评审计划、评审结果、升级）在非飞书会话里发起时也发到本人和机器人的私聊（`lark-asks.ts` 的 `targetFor`）；Agent 的提问仍只在它的会话里。
- 在网页上开始修改、应用或丢弃后，评审结果卡片作废（`cancelHostAsks`）；网页“概览”不重复显示这张卡片。
- 免打扰时段（`notify.quietStart` / `quietEnd`）里的普通通知不再直接丢掉推送：记为待发（`deferNotification`），时段结束后每 5 分钟检查一次，仍未读且不满一天的补发（`takeDeferred`），三条以内逐条发，多了合成一张列表。

## 评审的过程按评审项分开看（10-26）

- `runs.ts` 的 `addRunEvent`：流式文字按标签（`phase` / `check`）分开合并，同一运行里并行的评审项各写各的文字行，存下的 `text` / `thought` 事件带上标签（之前只存 `{ text }`，并行时会混在一起）。
- `/api/runs/:id/reviews` 每轮带 `reviewRuns`（这一轮的交办下单独起的 `review` 运行：确认计划后的评审、重新评审、补拆分）。
- 网页 `ReviewProcess.vue`：有评审的交办，“活动”标签按编码 Agent、各评审项、需求拆分、评审负责人分节显示工具步骤、文字和思考，顶上是宿主的进度；“评审”标签每个评审项和负责人旁有“看过程”，跳到对应一节。升级前记录的文字没有标签，归在“没有分开记录的输出”。

## 需求拆分独立成一步、拒收抄错的引用、引用抽屉加宽（10-26）

- `review-chain.ts`：`reviewContext` 拼评审任务（原 `reviewRound` 开头）；`splitChangePoints` 用 `review-business` 角色只做需求拆分，提交工具 `submit_change_points`（评审会话都有，写进交办运行的 `output.changePoints`，按轮次）。档位里没有业务评审时和各评审项并行跑；`POST /api/runs/:id/change-points` 给已有的评审补一次（`review` 运行，`splitOnly`）。`/api/runs/:id/reviews` 每轮带 `changePoints`，网页优先用它，其次用业务评审的。
- `deadRefs`：`submit_review` 和 `submit_change_points` 里 `src:` / `mem:` 指向不存在的原件或记忆时拒收，让评审者核对后重交（模型常把 id 抄错一两个字符）。
- 引用抽屉：文档类原件默认加宽（`omem.drawerWide` 记住本人的选择），表格保持列宽、横向滚动，图片不超出。

## 按评审修改、本人对问题的决定、引用打开代码和文档（10-26）

- `src/agents/review-fix.ts`：`review_findings` 加 `decision`（fix / later / wontfix）和 `decision_note`。`setFindingDecision`：不改必须写理由，并在所属事项记一条 `decision` 事件（`materialsBrief` 列出“本人的业务决定”）。`decisionsBrief`：同一次工作各轮和 `fromReview` 指向的分支评审里暂不改、不改的问题，进评审任务，评审者不再提。`startFix`：选中的问题和本人补充的要求写成任务；交办编码续在原工作区（`queueNextCodeRound`），分支评审基于分支交办（`fromBranches`、`itemId`、`readSpaces`、`fromReview`，挂在发起评审的会话下）。
- 工具 `fix_review`（`fix` / `later` / `wontfix` 带理由 / `text`）；`read_run` 列出最新一轮评审问题的编号、负责人裁决和本人决定。接口 `PUT /api/runs/:id/findings/:fid`、`POST /api/runs/:id/fix`。
- 网页：概览的每个问题右侧“改 / 暂不改 / 不改”（默认负责人接受的和严重以上的要改），下面“按评审修改 / 再改一轮”框可写补充要求，开始后跳到新运行。
- 引用：`/api/runs/:id/file` 不必指定空间（路径可带仓库空间前缀），分支评审清理工作区后读分支提交上的文件，找不到时到评审可读空间的已索引原件里找；引用抽屉新增 `file` 类型，`refAction(ref, runId)` 把 `路径:行` 变成链接（问题位置、依据、变更点位置）。文档类原件（飞书文档、Markdown）在引用抽屉里按排版显示、被引的行单独标出，可切回原文行号（`lib/sources.ts` 的 `readsAsDocument`）。

## 事项材料、运行页评审标签、运行记录查找（10-25）

- `src/items/materials.ts`：表 `item_materials`（kind：source / conversation / repo / space / run，`ref`、`label`、`meta` 里有分支、基线、说明和加入时原件的 hash）。`addMaterials` 校验本人能看到、只能加自己的会话和运行；`materialViews` 给出可读、已删除、加入后有更新；`materialSpaces` 和 `materialsBrief` 给编码和评审用。
- `CodeInput.itemId`：`review_branch` / `delegate_code` 的 `item_id`，`POST /api/review-branch`、`/api/delegate` 的 `itemId`。编码和评审的可读空间加上材料所在空间，任务里附“所属事项”和材料清单；运行和分支自动成为材料（`linkRunToItem`），评审结束在事项时间线记一条；续轮带上 `itemId` 和 `readSpaces`。
- 工具：`upsert_item` 加 `materials_add / materials_remove`（只改材料时不动事项字段），`read_item` 返回 `materials`；`submit_review` 加 `change_points`（`reviews.change_points`），`roles/review-business.md` 要求提交变更点。
- 接口：`GET /api/items/:id` 带 `materials`（运行附最新一轮的结论），`POST /api/items/:id/materials`、`DELETE /api/items/:id/materials/:mid`；`GET /api/runs/:id` 的 `context.items`。
- 运行记录：`runs.roles`（`|coder|reviewer|`，`prepareRun` 记下内置角色，迁移按类型和评审记录补旧的），`/api/runs` 的 `kind=role:<名>`、`q`（标题、id、任务原文）、`brief`（不带输入输出）；网页每页 40 条。原件：`/api/sources/:id?window=`（聊天取最后几行）、`/api/sources/:id/messages?from=&to=`，列表每页 200 条。
- 网页：`lib/reviews.ts`（`useReviews`）、`ReviewSummary.vue`（概览）、`ReviewChecks.vue`（评审）、`ChangeView.vue`（变更，`DiffFile` 的 `points` / `active` 画标记和高亮）、`AskAboutRun` 的 `heading` 和插槽（讲解抽屉）、`ItemMaterials.vue`、`lib/refs.ts`（`refAction`）。
- 分支评审的说明写明 HEAD 在分叉点、改动在暂存区是正常的检出状态，评审者不要求“确认分支”。

## 内存观察、本地向量分批、回溯失败退避（10-25）

- `src/core/memory-watch.ts`：每 10 分钟记一次进程内存（RSS、V8 堆、external、ArrayBuffer），保留两天；`diag` 的 `memory` 给出当前细分、向量缓存大小和抽样历史，以及前后四分之一时段 V8 堆的最低值（持续上升才是泄漏；本地向量模型的内存池和向量矩阵是涨到峰值后持平）。
- 本地向量模型：一批里的文本按长度排序、按“条数 × 最长文本 ≤ 1.6 万字”分组再送入模型（整批按最长的补齐，注意力内存随长度平方增长），结果顺序不变；`embeddings.memArena: false` 关闭 onnxruntime 的 CPU 内存池（默认保持，速度优先）。
- 飞书历史回溯：每个会话记连续失败次数，失败后按 30 秒翻倍、最长 1 小时等待再试（`retryAt`）；本人不在群里、没有权限（230002 等）记为 `gaveUp`，不再重试；同一页失败 3 次后不再要求附件下载齐全，先保存消息继续翻页（缺的附件之后用 `lark fill-files` 补）。限流仍由整个回溯循环退避，不算会话的失败。本人重新回溯某个会话时清掉放弃和等待。`backfillOverview` 加 `waitingRetry`、`gaveUp`，`set_lark_backfill` 的进度里列出。以前只剩失败的会话时，回溯循环每十几秒重试一次、永不停止。
- 向量矩阵按页加载（每页 4000 行，页间让出事件循环），`VectorIndex.prepare` 异步加载，`search` 只看已加载的空间、未加载的在后台开始加载；`vectorSearch` 先 `prepare`。启动预热改成异步。复用的 chunk id 只淘汰装着旧向量的空间（以前清空全部缓存，下一次检索同步重读全部约 48 万向量）。起因：一次分支评审第一次检索 37 万向量的代码空间，主进程被一条同步查询卡住约 13 分钟，所有工具调用、回复和计时器都在等，评审项和同时在跑的整理全部按“600 秒无活动”失败。
- 评审项失败后自动等 30 秒重试一次（只重试失败的项）；仍失败的发卡片问本人是否重新评审（`review-retry`：重试评审 / 不用了，选重试或直接回一句补充要求即排一个新的 `review` 运行）。全部失败时运行仍记为失败，但卡片已发出；部分失败时其余结论照常交给负责人。

## 2026-10-26：定时规则选择群聊与缺失目标处理

“发到”补充已采集的飞书群，不要求先和助理建立会话。保存时创建或复用本人的群会话，不接管访客会话、不发送消息。缺少投递目标的旧规则明确失败，不再追加禁止发群的指令后私发本人；其他机器人会话保留对应机器人。见 `src/rules/destinations.ts`、`src/rules/actions.ts`、`web/src/views/Rules.vue` 和 `test/rule-destinations.test.ts`。

## 2026-10-26：网页独立评审修改可继续下一轮

修复从网页分支评审进入修改后，第二轮误要求问答会话链的问题。无会话链任务通过 `continueFrom`、`resumeSessionId` 复用工作区与编码会话，保留执行配置和来源评审；写事务内拒绝重复提交、工作区缺失或已释放的续轮。失败请求不关闭确认入口、不修改问题决定。实现与回归：`src/agents/review-fix.ts`、`test/review-fix.test.ts`。

## 2026-10-26：应用修改回原目标分支

编码修改按首轮目标分支选择接收工作区：已有工作区就复用，否则自动检出本地分支；只有远端记录时建立对应本地分支。仓库主目录保持原分支，不要求用户手动切换。确认框和结果显示目标分支及接收目录，结果可复制目录；应用后查看文件读取接收位置。多仓库先全部预检，失败清理本次新建的未改动接收工作区与分支；成功保留接收工作区，不自动提交或推送。旧分支任务从 `fromBranches` 或 `baseRef` 恢复目标。实现：`src/agents/code.ts`、`src/server/http.ts`、`web/src/views/Runs.vue`；回归：`test/code-worktrees.test.ts`、`test/branch-review.test.ts`。

## 2026-10-26：应用后的提交与推送

运行详情的接收位置新增 Git 面板：读取实际分支、HEAD、暂存 diff 和文件状态，填写信息后提交或提交并推送，也可仅推送已有提交。与主助手的 `code_git_status` / `code_git_action` 共用 `src/agents/code-git.ts`，按运行及仓库定位记录中的接收工作区，校验原仓库、原分支、空间权限与读取后的状态。只提交暂存内容，不自动 add；推送固定 origin 原分支，不强推、不拉取，保留 Git hooks。提交和推送逐步记录，推送失败不丢本地提交，可单独重试。编码 Agent 仍在临时工作区产出补丁，不直接提交；自动交接和规则运行的工具限制同步更新。接收目录继续保留，后续明确指定同一分支的新交办基于本地最新 commit。回归使用临时仓库及本地裸远端，覆盖状态变化、未暂存修改、分支/仓库变化、权限、非快进与 hook 拒绝、失败恢复、并发请求。

## 2026-10-27：规则运行以 QUIET 结尾不再发出

规则交给档案、在触发消息的话题（或群）里自动回复时，档案常常先用 `lark_send` 发结论（要 @ 值班人），最后写一句总结再加 QUIET 表示“不要重复发”。之前只有唤醒运行认 QUIET，首轮运行会把“总结 + QUIET”整段发到话题里。现在规则运行的回答以 QUIET 结尾（`isQuiet`）时不投递，运行仍在列表里、思考气泡保留；规则任务说明里也写明“用 lark_send 发过结论的最后只回 QUIET”。实现：`src/agents/jobs.ts` 的 `agent` 处理器、`src/rules/actions.ts`；回归：`test/lark.test.ts`。

## 2026-10-27：重试接着做、运行中追加消息、盯群

- **重试**（`src/agents/retry.ts`）：编码交办点“重试”不再按原输入从头建工作区，而是在同一链里作为新一轮，接着原工作区和编码 Agent 会话做；ACP 会话一打开就记一条 `session` 事件，写到一半失败的也能接上；上一次已写完代码、在检查或评审时失败的，只重跑检查和评审。已应用或丢弃的按原输入重来。Agent 运行重试时任务前面带上一次的错误和已做的写入（`attemptNote`），发过的消息不再发；工作会话和静默排查接着原会话。重试保留发起人，网页跳到新运行。
- **运行中追加消息**（`src/agents/steer.ts`）：会话的一轮进行时，同一发送人的新消息先照常排进下一轮；正在进行的这一轮下次调用工具时，把它们附在工具结果后面交给 Agent，并从下一轮移走，下一轮空了就取消（`steeredInto`），飞书里不再单独回复；没赶上的照常成一轮。
- **盯群**（`src/channels/lark-watch.ts`、`set_chat_watch`）：主助手可以自己盯（`spec=assistant`，默认），也可以交给档案；规则带本人的目的（`note`）、到期时间（`expiresAt`，默认 3 天，巡检或下一条消息时结束并通知本人）和批次（`batchMinutes`，默认 10 分钟，处理者可以自己调；后来的消息不推迟这一批，@ 本人或机器人的 30 秒内）。整个群（含话题）一个会话，处理者自己判断哪些话题要单独交给 Agent。本人在自己的消息里要求时，`invite_bot` 用本人身份把 omem 的机器人拉进群（`inviteOwnBot`，与规则动作共用）。没事的批次回 QUIET，记为无事可报。规则页列出“正在盯的群”（`/api/watches`），可取消。

## 2026-10-27：需求点成树、重新整理拆分

- **树形变更点**：`change_points` 多了可选的 `parent`。需求涉及几个页面或模块时，拆分者先建页面 / 模块节点，再把变更点挂在下面（最多 4 层）；怎么分组由它按需求材料自己的组织决定，小需求仍平铺。`pointTreeProblem` 拒收编号重复、父节点不存在、成环或太深的提交。“变更”标签按文件夹折叠展开（超过 20 个时只展开第一层），点一组高亮组下全部代码；标签和概览的数字只数变更点。
- **重新整理**：`requestSplit` 起一个只做拆分的 `review` 运行，`revise` 时把当前的变更点（`currentPoints`：本轮单独的拆分，或业务评审交的）和本人的要求一起交给拆分者，在原来的上面调整、编号尽量不变，整份替换；同一轮还有评审或拆分在跑时拒绝。入口：“变更”里的“重新整理”（`POST /api/runs/:id/change-points` 带 `revise` / `note`），主助手的 `resplit_change_points`。
- 实现：`src/agents/review.ts`、`review-chain.ts`、`tools.ts`、`web/src/components/ChangeView.vue`、`DiffFile.vue`；回归：`test/branch-review.test.ts`。
- 文档站首页：问答、记忆、原件排在前面，评审放后面；首屏图换成三张截图叠放的 `HeroCollage.vue`（浅色 / 深色各一套，`doc-screens` 生成 `*-dark`）。

## 2026-10-27：每次评审都单独拆需求

之前档位里有业务评审时，变更点靠业务评审在 `submit_review` 里顺带交 `change_points`；需求一大，问题清单和变更点要一次交齐，常被漏掉，本人只好在“变更”里手动点“拆分需求”。现在 `reviewRound` 不论档位都和各评审项同时跑一步单独的需求拆分（`splitChangePoints`，提交 `submit_change_points`），失败时随没完成的评审项在 30 秒后自动重试一次；业务评审的角色说明不再要求交变更点，字段只为旧的自定义说明保留。评审进行中“变更”标签显示“需求拆分和各评审项同时进行”，不再给“拆分需求”按钮；按要求起的拆分运行（包括主助手发起的、刷新页面前发起的）页面会接着跟进。概览里的“需求拆分”统计改用 `currentPoints`。实现：`src/agents/review-chain.ts`、`roles/review-business.md`、`web/src/components/ChangeView.vue`；回归：`test/branch-review.test.ts`。

## 2026-10-27：交办进行中调整、每轮先拉取、一个分支一个交办

起因是一次长交办里：本人在会话里随口问的话被当成“按评审修改”卡片的回答，接连开了好几轮；按分支评审修改又在同一分支开了第二个工作区；“后面从简”没有办法落到评审上，也停不下来。

- **卡片回答**：`src/agents/asks.ts` 的 `answerFromMessage`。宿主处理的提问（`context.handler`：评审结束、评审计划、停下的评审、同步冲突）只认编号或以选项开头的回复；其他话照常交给助手。`Ask.handler` 让文字渠道的提示也说清这一点。
- **交办进行中调整**：新增 `src/agents/code-steer.ts`。`addCodeNote` 把本人的补充记在当前一轮的 `output.notes`；编码中的 Agent 在下一次 omem 工具调用时收到（`tools.ts` 的 `steering`），没收到的在它这一轮写完、检查之前接着同一会话交给它（`code.ts` 的 `code()`）；已写完代码的随下一轮任务（`queueNextCodeRound`）。`setRoundReview` 设之后各轮的评审（`input.roundReview`：档位可比之前轻、只做哪些评审项、`split: false` 不拆需求），还没开始评审的这一轮也生效，续轮沿用。`stopCodeWork` 停下这一轮和排队中的评审，链停在 `waitReason: "stopped"`，不唤醒助手接手。工具 `message_code_run` / `set_code_review` / `stop_code_run`，`continue_code_run` / `fix_review` 多了评审选项；接口 `POST /api/runs/:id/notes`、`PUT /api/runs/:id/round-review`，`/fix` 收 `review` 和 `reviewAi`，编码运行的“停止”按本人停下处理。
- **评审计划**：`review.ts` 的 `planReview` 多了 `only`（只做这些评审项）；本人指定的那轮不受“上一轮已是某档，不降档”的限制，不再走计划确认；`review-chain.ts` 在 `split: false` 时不跑需求拆分。
- **每轮先拉取**：`code.ts` 的 `syncPhase` 在没有显式同步时，先用 `code-sync.ts` 的 `behindOrigin` 看目标分支在 origin 上有没有新提交，有就按 `pull` 合进来（冲突照常交给编码 Agent）；拉到的内容写进运行说明的“Git 同步”。
- **一个分支一个交办**：`review-fix.ts` 的 `openDelegationOn` 找同一仓库、同一目标分支上没应用的交办。`delegate_code`（除非 `parallel`）和网页交办遇到时拒绝；分支评审的 `startFix` 续在它上面（它还在跑时拒绝）。`startFix` 把没选“改”的未定问题记为 `later`。
- **多轮换模型**：档位的 `rotateModels` 和共用的 `review.rotation`（`config.ts`、`review.ts` 的 `rotatedExecution`）；第 1 轮各评审项用自己档案的模型，之后按轮次加评审项序号在列表里轮换。`roundReview.rotate` 让一次交办单独开关（工具参数 `rotate_models`）。设置在 `ReviewSettings.vue` 档位页“怎么推进”。
- **网页**：`ReviewSummary.vue` 的“待处理”按本人还要处理的算（含负责人定为要改的提示），最新一轮带上之前各轮的“暂不改”；补充要求和评审选项存在 `lib/quotes.ts` 的 `fixDraft`，切标签不丢，“修改点”抽屉共用；`NextRoundReview.vue` 选之后的评审档位、拆需求和评审 AI；`CodeSteer.vue` 在进行中的交办上补充和改评审；选中文字浮出的按钮悬停底色不透明。
- **编码交办卡片只放状态**：`src/channels/lark-code-progress.ts` 的 `snapshot` 不再把运行事件（编码 Agent 的流式文字、每次工具调用）附在卡片上；卡片只有轮次、状态、评审结论和结果，过程看思考气泡。
- **Windows 上的拉取**：`pull-transfer.ts` 解包时以快照目录为工作目录、用相对路径调用 `tar`（Git for Windows 的 GNU tar 会把 `C:\…` 当成远程主机）。

## 2026-10-28：复用工作区、准备命令

起因是大仓库每次交办都在 `runs/` 下的新 worktree 里重装依赖。设计和后面两步（在 VS Code 里打开工作区、VS Code 插件）写在 `docs/v2/ide.md`。

- **复用工作区**：新增 `src/agents/workspaces.ts`。仓库空间设置 `workspaces`（本人已有的 `git worktree add` 目录）和 `pool`（omem 在数据目录 `workspaces/<空间>/<n>` 自建的数量），`leaseWorkspace` 借出、`releaseWorkspace` 归还。租约是工作区 git 目录里的 `omem-lease.json`，只在运行目录 `runs/<id>/work/<空间>` 的链接（Windows 为 junction）指向它时有效；本人的目录有未提交改动不借；归还时 `reset --hard` + `clean -fd`（保留忽略的文件）并回到原分支。`code.ts` 的 `addWorktree` 先借、借不到再新建；`WorktreeRef.slot` 记真实目录，`workDirOf` 让编码 Agent、检查和评审在真实目录里运行；`removeWorktrees` 对借来的只归还不删除。
- **准备命令**：仓库设置 `setupCommand`，`code.ts` 在同步之后、编码之前对每个工作区比较命令和锁文件（Git 索引里的版本）与上次成功时的 `setupKey`，变了才运行；失败不中止，失败输出交给编码 Agent。
- **检查命令的引号**：`code.ts` 的 `shell` 在 Windows 上照 Node `shell: true` 的方式原样传给 cmd，带双引号的检查命令以前会被转义坏。
- **网页与接口**：设置 → 空间 → 编辑（仓库空间）加准备命令、复用工作区数量和目录，列出各工作区状态；`GET /api/spaces/:id/workspaces`。
- **在 VS Code 中打开**：`code.ts` 的 `codeFolders`（工作区的真实路径，应用后为接收位置）与 `GET /api/runs/:id/folders`（带 `local`、主机名）；网页 `OpenInIde.vue` 和 `lib/ide.ts` 生成 `vscode://file/…` 或 `vscode://vscode-remote/ssh-remote+<别名>/…`，SSH 别名和编辑器（VS Code / Insiders / Cursor）存在看的人的浏览器里。
- **VS Code 插件第一版**：新增 `vscode/`（独立 package），设计在 `docs/v2/ide.md` 第三节。宿主新增 `GET /api/code-runs/at?folder=`（`code.ts` 的 `codeRunsAt`，按文件夹找交办和各轮）。插件：`current.ts`（当前交办、路径对应）、`review.ts`（评论控制器：评审问题线程与改 / 暂不改 / 不改，选中提问走 `/api/ask` 并轮询会话写回线程，修改点，“开始修改”调 `/fix`；“修改单”视图）、`runs.ts`、`progress.ts`（`/api/runs/:id?after=` 轮询事件到输出通道和状态栏）、`delegate.ts`（任务文档 + CodeLens 调 `/api/delegate`）。`vscode/test/run.mjs` 用 `seed.mts` 起演示 omem，在真实 VS Code 里跑 `suite.cjs`。
- **网页版 VS Code**：新增 `src/server/ide-web.ts`（按需启动官方 `code serve-web`，回环随机端口与 connection token；会话 cookie；`/ide` 的 HTTP 与 WebSocket 代理，转发时加 `vscode-tkn`、去掉 omem 自己的 cookie 与 Authorization；进程树结束与遗留进程清理；下载中的 202 换成自动刷新页）。`http.ts` 加 `GET /api/ide/open`（本人，设 cookie 后跳转）、注册 `/ide` 代理和 upgrade 处理；配置 `ide.web.enabled / command`（设置 → 外观与说明）；`/api/runs/:id/folders` 带 `web`；`OpenInIde.vue` 的编辑器多“网页版 VS Code”；Vite 代理 `/ide`（ws）。
- **网页版 VS Code 经同伴打开**：新增 `src/core/peer-tunnel.ts`，`/ide` 和 `/api/ide/open` 原样转发（含 WebSocket 升级，不跟随跳转）：`omem peer open` 的本机服务把它们交给路上第一台直连设备；中间设备在 `/api/peers/:id/ide…`、`/api/peers/:id/api/ide/open` 上原样转给下一台，升级请求单独核对本人令牌。`ide-web.ts` 的 `ideAllowed` 也认本人令牌（转发来的请求）。
- **插件的连接设置**：新增 `vscode/src/connection.ts`（`omem.connection` = `local` / `direct` / `peer`，`omem.port`、`omem.url`、`omem.peer`、`omem.sshHost`；令牌按服务地址存 SecretStorage；omem 机器上的路径与本窗口 URI 互转，Remote-SSH 窗口和 `sshHost` 都走 `vscode-remote`）和 `connect.ts`（“连接 omem…”：本机先试默认端口、粘贴 `omem link` 链接或配对码逐个地址试连、填地址和令牌、从本机 omem 的 `/api/peers` 选设备；状态栏连接状态，`omem.connected` 控制欢迎页）。修正：以前 Remote-SSH 窗口里的文件夹（`vscode-remote` 协议）被跳过，认不出交办。评审线程正文不再重复标题，已选的决定按钮隐藏。
- **插件连配对的设备不再要本机服务**：`connection.ts` 的 `pairedPeers` 读数据目录（`omem.home` / `OMEM_HOME` / `~/.omem`）的 `secrets/peers.json`，`target()` 照 `peerFetch` 的走法算出请求地址和令牌（直连用设备地址，`via` 发到中间设备的 `/api/peers/<id>`，地址不应答时试其他地址）；没有数据目录时才经本机服务转发。连接选项改名“本机配对的设备”。
- **网页版 VS Code 不再要开关**：去掉 `ide.web.enabled`，运行页“在 VS Code 中打开”一直有网页版；`GET /api/ide/cli` 给出要用的 VS Code 命令行，齿轮面板里显示并可就地填 `ide.web.command`；找不到命令时打开返回说明。转发给 serve-web 时带 `X-Forwarded-Host`（`peer-tunnel.ts` 第一跳加上），修正经 `peer open` 打开别的机器时 WebSocket 去连对方回环端口、1006 断开。插件：空的提问线程不再有两个删除按钮（空线程 VS Code 自带删除），标题改为“问 omem，或记为修改点”；直接连接到本机回环地址时按本机文件对应路径。
- **交办清理、工作区设置、主目录里改**：`src/agents/code-cleanup.ts`（`cleanupCandidates` / `cleanItems`：没应用的交办、已应用的接收工作区、runs 下的遗留 worktree）和工具 `clean_code_runs`（先列清单，`confirm` + `run_ids` 才清）；工具 `set_code_workspaces`（`pool`、`workspaces`、`setupCommand`、`inPlace`）。`workspaces.ts` 的 `inPlace` 把仓库主目录作为第一个候选（干净才借，`leaseWorkspace` 返回 `{ path, main }`，分支评审不借主目录），`code.ts` 在主目录里不建 omem 分支、`WorktreeRef.inPlace`，应用时不打补丁、`releaseWorkspace(keep)` 不重置，丢弃照常重置。`connect_repository` 按 git remote 认出同一仓库的已有空间，不再新建；`relink: true` 改关联（有未应用交办时拒绝，删掉 omem 自建的复用工作区）。设置 → 空间加“直接在仓库主目录里改”。
- **先应用再接着改**：`code.ts` 的 `applyCodeRun(…, { keepWorking })` 应用后保留工作区，把应用的部分在工作区里提交（`omem: 已应用到 …`）作为新的起点，之后的差异和下一次应用只含新改的；`partlyAppliedTo` / `partlyAppliedAt` 让运行页和 `code_git_action` 能在接收目录提交。网页概览的“先应用再接着改”、`fix_review` / `continue_code_run` 的 `apply_first`。
- **按钮状态**：`styles.css` 的悬停样式不作用于禁用的按钮；`api.ts` 给触发写请求的按钮加 `busy`（转圈、不可点），请求结束移除；`.lnk` 改为全局样式。评审选项收成一行摘要，点开再选；之前各轮的“暂不改”改为“改”时本地状态同步更新。

## 2026-10-28：工具按需给出、omem tool 命令行

起因是主助手每次会话要带 80 个工具、约 65KB 的参数说明，每加一个能力就再多一个工具。

- **按需给出**：新增 `src/agents/tool-help.ts`。`CORE_TOOLS` 是直接列出的常用工具（检索、读原件、记忆、事项、问本人、`lark_send`，以及各后台角色交结果的工具）；一次运行能用的工具超过 `DIRECT_ALL`（20）个时，其余的不单独列出，换成 `omem_help`（工具名看说明和参数，分组 id 看 `skills/omem/references/<分组>.md`，不填列出全部）和 `omem_call(tool, args)`。`omem_call` 的说明里按分组列着本次能用的工具名和一句话用途。`tools.ts` 的 `mcpTools` 给 MCP 列表用（`/api/tools`、`/mcp`、`omem mcp`），`callTool` 处理这两个工具，转调时照常检查工具清单、审批和对比运行。主助手的工具说明约从 65KB 降到 18KB；工具不多的角色不变。
- **omem tool**：`src/cli-main.ts` 新增 `omem tool [名] [参数…]`：一个 JSON 对象、`键=值`（值能按 JSON 解析就按 JSON）或 `-f 文件`（`-` 为标准输入）；`omem tool help [名|分组]`。有 `OMEM_TOKEN` 时调服务的 `/api/tools/<名>`，没有时按 `omem mcp` 的范围在本机执行（`externalToolContext`，不含交办编码、评审分支和角色专用工具）。
- **Agent 进程的环境**：新增 `src/agents/tool-cli.ts`。`prepareRun` 的 `mcp.env` 带 `OMEM_URL`、`OMEM_TOKEN`，并把 `<数据目录>/bin` 放到 PATH 前面，那里的 `omem`（Windows 为 `omem.cmd`）用当前的 node 运行当前的 omem；`acp.ts`、`cli.ts` 启动 Agent 时合并进去。环境变量本身不授权，权限仍由令牌决定。
- **说明拆分**：`skills/omem/SKILL.md` 只留概览、接入方式和分组表，原来的长清单按分组移到 `references/`（sources、memory、items、wiki、agents、owner、code、lark、learning）。`roles/_common.md` 开头说明了 `omem_call` / `omem_help` 和 `omem tool`。
- 测试：`test/tool-help.test.ts`（分组完整、列表拆分、权限、参数说明、命令行参数、环境）。

## 2026-10-28：事项搜索、记忆里的引用、运行写下的东西、更新原通知、配置合并保存

- **事项页**：`Items.vue` 的快速输入框改为右上角“新建事项”弹窗；新增搜索框（`/api/items?q=`，搜索时 `status=all`，请求按序号丢弃过时结果，进行中显示 `.spinner`）。
- **记忆里的引用**：新增 `web/src/components/MemoryText.vue`，把记忆正文里的 `[[slug]]` / `[[空间:slug|文字]]`、`[文字](src:…)`、裸 `src:` / `mem:` / `msg:` 变成链接，经 `openCitation` 在引用抽屉里打开；`MemoryCard`、`CitationDrawer` 的记忆和演变、记忆页的复核撤回与对比运行都用它。
- **搜索加载态**：`CommandPalette.vue` 在防抖和请求期间显示“搜索中…”，旧结果变淡；`Memory.vue` 输入后立即进入加载态并丢弃过时结果；`styles.css` 新增 `.spinner`。
- **运行写下的东西**：新增 `src/agents/run-writes.ts` 的 `runWrites`，按运行的 `tool-write` 事件和带运行 id 的行（工作文件 `meta.runId`、记忆 `run_id`）列出写下的东西及打开位置；`GET /api/runs/:id` 返回 `writes`。`RunActivity.vue` 在结束的运行下列出它们并给“运行记录”链接（运行页自身不显示链接）。起因：问答回答末尾的“已记录：…”只说写了什么，网页上找不到，工作文件又写在别的空间。
- **更新原通知**：`notify` 接受 `replaces`（之前通知的 id）：新通知的 context 记 `replaces`，原通知标为已读、记 `replacedBy` 并取消夜间暂缓；飞书渠道发送普通通知后记下 `larkMessageId` / `larkBot`（`setNotificationCard`），遇到 `replaces` 时改原卡片而不是发新的，改失败才发新卡片。`notify` 工具返回通知 id，参数加 `replaces`；`skills/omem/references/items.md` 同步。
- **配置合并保存**：`src/core/config.ts` 的 `saveConfig` 改为三方合并（`mergeConfig`）：以本进程上次读入或保存时的配置为基准，只把本进程改过的字段写到磁盘上的现状之上，其余以文件为准，传入的对象变成合并结果。以前服务、`omem setup`、CLI 各持一份启动时的完整配置，谁后保存就整份覆盖别人改过的项（包括服务运行期间的手改）。
- **飞书工具默认发到本会话**：`lark_send` / `lark_card` 等不填 `chat_id`、`reply_to`、`user_id` 时，发到本次运行所在的飞书会话（`tools.ts` 的 `runLarkChat`）。起因：本人在私聊里让助理发起授权，Agent 拿不到当前私聊的 chat_id，发不了可更新的授权卡片，只好改用 `notify`。
- **飞书回答带运行 id、按 id 查找**：飞书回答卡片底部小字“运行 <id>”（`lark-send.ts` 的 markdown 内容支持 `note`，`lark-progress.ts` 的 `finish` 带上，访客的回答也带）。新增 `src/core/lookup.ts` 的 `lookupId` 与 `GET /api/lookup?id=`：运行、记忆、原件、事项、消息、对话、规则、通知、页面按 id 查（接受 `运行 `、`src:`、`mem:`、`msg:` 前缀和 `#L` 行号），按调用者能看的空间过滤；`CommandPalette.vue` 输入像 id 的内容时把命中放在第一行，回车打开对应页面或引用抽屉。
- **运行记下新建还是更新**：`tool-write` 事件多记工具回执 `result`（前 400 字）；`runWrites` 从回执里取 id 和“已新建 / 已更新 / 已更正”，旧事件仍按原来的方式推断；`RunActivity.vue` 显示为“新建工作文件：…”“更正记忆：…”。
- **访客被拒后本人确认**：`lark-bot.ts` 的 `answerGuest` 在群里拒绝一个人后调用 `askOwnerAboutGuest`：本人在群里（`ownerInChat`）就发群内仅本人可见的卡片（`sendEphemeral`），否则发到本人私聊；交互 `purpose=guest-approval`，payload 存原消息。`lark-actions.ts` 处理按钮：同意时 `decideGuest` 把原消息交回注册的机器人（`onGuestApproved`），`handle(m, { by })` 跳过采集和门卫，按本人身份交给主助手，上下文写明本人同意；不同意只在 guest 运行记一条状态。`roles/gatekeeper.md` 的群内拒绝回复改为“需要主人同意，已经去问了”。运行记录页加“当前空间 / 所有空间”。

## 2026-10-28：会议规则（本人入会时拉机器人进会）

- **触发与条件**：`rules/types.ts` 加触发 `meeting`、字段 `meeting.title / no / participants / participantCount / host`（`EVENT_FIELDS` 按触发分组，`/api/rule-options` 给出）、运算 `gte` / `lte`；`store.ts` 校验会议规则只用会议字段、动作只能是 `meeting-bot` / `notify` / 只告诉我的 `agent`；不写条件的会议规则表示每场会议（`engine.judge`）。`testRule` 对会议规则用 `lark_meetings` 里最近的会议试。
- **入会事件**：新增 `src/channels/lark-meetings.ts`。有启用的会议规则时常驻两个 `lark-cli event consume`（`vc.meeting.participant_meeting_joined_v1` / `…_ended_v1`，用户身份；关 stdin 停止），起不来就每分钟 `vc +meeting-list-active`。`main.ts` 每 15 秒 `tickMeetings`。新表 `lark_meetings`、`lark_meeting_lines`（迁移）。
- **动作 `meeting-bot`**：`bots`（`main` / `lark.bots` id）、`confirm`、`record`、`spec`、`space`、`task`、`answer`、`importShared`、`leaveWithOwner`。入会、读事件、会中发消息、离会都用机器人自己的客户端调 `vc/v1/bots/{join,events,message,leave}`（请求格式按 lark-cli 1.0.97 的 `--dry-run` 核对）。确认卡片 `purpose=meeting-join`，`lark-actions.ts` 处理。
- **记录与旁听**：会中事件两种形态都认（lark-cli 的 `event_type + payload`、接口的 `activity_event_type + *_items`），转写按 `sentence_id` 覆盖；会议原件 `lark:meeting:<id>`，结束后 `scheduleIngest`，再用 `vc +detail` 找 `minute_token` 把妙记补进去（`lark-personal.ts` 拆出 `minutesText`、`minutesSeen`）。旁听运行 `lane=meeting:<id>`，输入带 `meeting` 时结果不投递（`jobs.ts`）；新工具 `meeting_send`（只在 `meeting.answer` 的运行里可用，`skills/omem/references/lark.md`）。
- **权限检查**：新增 `src/rules/permissions.ts` 与 `GET /api/rules/:id/permissions`；`save_rule` 结果附上。`lark-setup.ts` 加 `larkAppScopes`、`larkEventLink`，`larkScopeLink` 可指定 `token_type`；机器人清单加 `vc:meeting.bot.join:write`、`vc:meeting.message:write`，lark-cli 用户清单加 `vc:meeting.meetingevent:read`。
- **界面**：`Rules.vue` 触发加“我加入会议时”，条件字段随触发切换，动作“拉机器人入会”的编辑项，“飞书权限”一节（重新检查），“用最近的会议试一试”。

## 10-29：提醒时区、会议不建事项、工具按分组授权

- **提醒晚 8 小时**：事项的提醒时间按写入时的样子存（`2026-10-28T16:45:00+08:00`），到期查询却拿它和 `now()`（UTC，`…Z`）按字符串比，东八区的提醒要等 UTC 走到同一个钟点才发出。`items/store.ts` 加 `UTC(col)`（SQLite `strftime` 换算成 UTC）用于 `dueReminders`、事项排序和巡检的过期查询；存的值不变，Agent 读到的仍是本人的时间。
- **会议不建事项**：`roles/ingest.md`：飞书日程和会议邀请本身不建事项、不设提醒（飞书自己提醒），只有分给本人的具体任务才建；`_common.md` 同样写明。
- **工具按分组授权**：`tool-help.ts` 的 `expandTools`：角色和 Agent 档案的 `tools` 可写 `group:<分组>` 和 `-<工具>`，加载时展开（`ROLE_TOOLS` 不随分组授出），保存角色时检查分组名。主助手改成按分组写（排除 `write_page`、`propose_item_update`、`propose_profile_change`、`meeting_send`），实际可用的工具和以前一样；以后新工具放进分组就可用，自定义过的主助手也不用再为工具清单合并。
- **改卡片不再依赖读消息接口**：`tools.ts` 的 `larkGuard` 遇到 `reply_to` / `lark_update_card` 时，先从 `card_interactions`（机器人发的卡片）和 `lark_messages` 找消息所在的会话，找不到才调飞书 `im.message.get`，失败时把飞书的错误码带进报错。起因：机器人读不了消息时，改自己刚发的卡片也报“无法确认被回复消息所在的飞书会话”。


## 10-29：编码交办卡片的检查行、运行标题的悬浮提示

- 编码交办结束的卡片原来把运行输出的 `repos`（含 `git diff --stat` 的文件列表）原样转成 JSON 放在“检查：”后面；没有配置检查命令或交办了多个仓库时都会这样。`src/channels/lark-code-progress.ts` 的 `checkLines` 改为每个仓库一行：检查命令通过 / 未通过（退出码、耗时）或“没有配置检查命令”，加上改动规模（`--stat` 最后一行）。文件明细只在运行页看。
- 运行标题在创建时截成 60–80 字的标签，交给 Agent 的任务（`input.task` / `input.text`）不截。运行列表的简要模式（`listRuns` 的 `brief`）现在带上任务的前 600 字，`web/src/views/Runs.vue` 的列表项和详情标题悬浮时显示它。
- 记忆里的页面引用（如 `[[cases/x]]`）原来带着类名 `page`，被全局 `.page` 的页面内边距撑开，左右留白很大、虚线下划线错位；`web/src/components/MemoryText.vue` 的类名改为 `ref-<种类>`。运行记录列表头部的状态和范围两组筛选不再挤在一行，状态单独一行，范围与“含无事可报”一行。
