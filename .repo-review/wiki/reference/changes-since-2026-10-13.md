---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-22
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-21 午后](./changes-2026-11-21-afternoon.md)（15 节）：插件接入检索、成员能力和交办、评审同步、安全记录及工作页。
- [2026-11-21 上半天](./changes-2026-11-21-first-half.md)（48 节）：整理第一批（方案、设置页和数据页重做、其余页面整理）、工作线三四期和关注页、指标由本人确认、协同任务板、等本人处理的清单和提问卡的免打扰、按后端能力裁剪常驻说明和云端会话收尾、操作规则和规则包、对象授权、成员在助手里看流程和存规则、插件订阅事项与评审。
- [2026-11-20](./changes-2026-11-20.md)（24 节）：关注（盯群换成关注、从历史学、主动推进）、工作线的事项上下层和现状、演示和 Chrome 扩展的录制、成员用自己的 AI 账号、工作上的指标、每晚复查回复结果、插件设置。
- [2026-11-19](./changes-2026-11-19.md)：编码交办、流程、评审复核、会议、网页、设备和插件回调。
- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 关注回查沿用问题材料的来源（2026-11-22）

从 `src/channels/listen-problems.ts` 的 `trackProblem` 和 `problemsDue` 读起。问题记录保存会话材料的来源，后续更新合并已有来源。定时回查和当前处理带入问题正文时，都沿用这份记录。个人关注全程只用个人材料时，回查轮和下一轮都可使用个人向量插件。网页中本人的文字按会话空间登记。会议操作备注只在显式读取时计入材料，来源不明的会议纪要仍走全文和符号检索。

## 个人关注的摘要带有助手回复时可用向量检索（2026-11-22）

关注摘要保留用户消息和助手回复。计算摘要来源时，合并前次摘要的来源和本次用户消息的来源。个人空间的消息即使已有助手回复，冷启动搜索也能调用个人空间插件；摘要含项目消息或来源不明时，仍可用全文和符号搜索。从 `src/agents/jobs.ts` 的 `thread-summary` 和 `test/plugin-embeddings.test.ts` 的冷启动用例读起。

## 关注助手按实际收到的摘要、补充和群历史校验向量权限（2026-11-22）

关注会话生成摘要时保存原摘要与新材料的来源。冷启动按实际带入的摘要登记来源；旧摘要来源不明时仍可用全文和符号搜索。实时补充在正文交给助手前登记，即使等待批次被取消，已交付的内容也受保护。新建关注合成群历史时保留归档消息 ID 和空间，仅含个人空间材料时可正常调用个人向量插件。从 `src/core/message-origins.ts`、`src/agents/sessions.ts` 和 `src/channels/lark-watch.ts` 读起。

## 关注助手主动搜索时核对查询材料的来源（2026-11-22）

从 `src/core/message-origins.ts` 的 `watchSearchSourceSpaces` 读起。助手用群里的原话调用 `search` 时，宿主核对会话历史、本轮消息和中途补入的消息。历史消息的来源按批在检索子进程中读取。项目群消息只交给已获项目空间授权的向量插件。来源不明时跳过受限向量插件，仍返回目标空间的全文和符号命中。

## 快速检查在每页飞书消息到达时记录来源（2026-11-22）

从 `src/rules/fast.ts` 的 `pollFastRules` 读起。分页期间群改绑时，已读到的消息沿用首次记录的来源空间。后续页重复返回同一消息，也只按原有顺序转交一次。

## 规则等待期间保留飞书消息来源（2026-11-22）

规则收到飞书消息时记录已归档的原件空间，尚未归档就记当时的采集空间。触发等待、动作延时和恢复执行都沿用事件里的来源。交给关注时再合并后来归档的空间和已有关注消息的来源。旧事件缺少来源且找不到原件时，受限向量插件收不到正文。入口见 `src/rules/engine.ts`、`src/rules/fast.ts`，转交见 `src/rules/actions.ts`。

## 云端向量按已收到的 HTTP 状态决定重试（2026-11-22）

云端接口返回错误响应头后，即使读取正文提前超时，最近错误仍显示 HTTP 状态码。向量请求遇到普通 4xx 只发一次，429 和 5xx 继续在剩余时限内退避重试。实现从 `src/search/api.ts` 读起。

## 飞书关注按消息来源校验向量插件权限（2026-11-22）

普通关注和规则转入都会记录正文入队时的来源空间。已有归档的消息取原件空间，未归档的消息取当时的采集空间。跟进时一并检查后来归档的原件。群改绑后，个人空间插件仍收不到已入队的项目正文。实现从 `src/core/capture-space.ts` 和 `src/channels/lark-watch.ts` 读起。

## 向量设置可切回默认值（2026-11-22）

保存和检测向量设置时，`keyRef`、`url` 和 `dimensions` 可以传 `null` 清除。两处共用 `src/auth/settings-sections.ts` 的字段合并，保存时会预览实际模型或地址变化影响的索引。

## 带运行器的流程由本人提交和确认（2026-11-22）

从 `docs/v2/plugins.md` 的「插件承担一个阶段」读提交和启用方式。本人通过流程保存接口或自己的助手提交新版本，确认卡列出阶段、插件和用途。两个入口的成员权限及本人确认前后的状态由 `test/flow-plugin.test.ts` 覆盖。

## 完成检查按合并后的原件和 URI 定位结果核对权限（2026-11-22）

从 `src/flows/plugin-gates.ts` 读检查收到的证据。合并旧链接按保留件的空间和读取权限过滤；URI 链接与原件读取接口共用 `src/sources/store.ts` 的解析。检查收到的可读链接保留原样，事项上的证据完整保留。

## 插件完成检查的原件读取链接（2026-11-22）

从 `src/flows/plugin-gates.ts` 读检查回调的证据裁剪。同一原件的 `src:`、网页链接和 HTTP 原件读取链接均按事项空间和原件读取权限过滤。提交者留下的原始证据在事项上保留。回归见 `test/flow-plugin.test.ts`。

## 角色和档案表单中的已停用后端（2026-11-22）

从 `web/src/components/AiDefaults.vue` 读保存值的显示。角色和档案表单都从 `/api/profile-options` 读取已停用后端的来源与原因，候选列表只列可用条目。冷启动回归见 `test/web-review-entry.test.ts`。

## 插件完成信号的批次时限（2026-11-22）

从 `src/flows/plugin-signals.ts` 读巡检的并发数、每次检查的时限和批次游标。余下时间不足一次完整检查时，游标留给下批，阶段不会因为排在批末而增加失败次数。双模式回归见 `test/flow-plugin.test.ts`。

## 主助手代答与复盘显示豆包实际审批档位（2026-11-22）

从 `src/agents/doubao-cli.ts` 的启动入口读起。「使用 AI」按启动参数记录风险审批或完全访问。会话回退到豆包，以及复盘的两次评判，都在各自运行记录里看到实际档位。

## 沙箱设置校验后端状态路径类型（2026-11-22）

从 `src/agents/own-run.ts` 的挂载计划读起。后端所需目录已被普通文件占用时，保存设置和准备运行都会指出路径。首次启动仍会创建缺失目录。

## 交办发起人的评审档位判断（2026-11-22）

从 `src/agents/code.ts` 的 `runCodeTask` 读起。编码前预估档位和首轮检查后细化计划时，短问答都以发起人身份选择账号与审批模式。

## 成员多仓评审的工作树权限（2026-11-22）

从 `src/agents/review-chain.ts` 的评审入口读起。评审按交办分配的仓库只读挂载，覆盖工作区池和直接检出两种方式。与编码同时进行的验证在自己的快照写测试产物。

## 成员查看内置角色（2026-11-22）

从 `src/server/http.ts` 的角色接口读起。有档案管理权限的成员可看内置角色的名称、用途和默认 AI。在 Agent 页打开角色进入只读摘要；只有本人的详情包含正文、专属记忆和复盘建议。自定义操作仅向本人回传原文。

## 成员管理 Agent 档案（2026-11-22）

从 `src/server/http.ts` 的档案接口读起。成员查看档案详情或保存说明、状态时取得与列表一致的摘要。档案原文的读写权限在 `src/auth/settings-sections.ts` 中与 MCP 配置一起限定给本人，技能原文沿用原权限。

`web/src/views/Agents.vue` 用摘要填写用途和状态，保存后重新读取档案。只有完整详情才加载原文和专属学习记录。

## 插件阶段的验收与恢复（2026-11-21）

从 `examples/plugins/stagekit/README.md` 可走通文件信号、作业、验收词否决和本人越过。队列恢复和等待中的外部作业取消见 `test/flow-plugin-worker.test.ts`。检查的适用范围与证据在 `src/flows/plugin-gates.ts`，后端来源解析在 `src/agents/catalog.ts`。

## 插件第四期：流程提供者、完成检查与 ACP 目录（2026-11-21）

- 完成信号和 Git 共用巡检，证据留在阶段，失败退避；从 `src/flows/plugin-signals.ts` 读起。
- 运行器由本人确认，持久运行恢复同键作业，期限取消；从 `src/flows/plugin-runner.ts`、`src/agents/runs.ts` 读起。
- 结果检查默认关闭，只能收紧，强制错误暂停，本人单次越过留审计；从 `src/flows/plugin-gates.ts`、`src/flows/engine.ts` 读起。
- backends 声明进入信任指纹与统一目录，停用移出，保存配置显示来源；从 `src/plugins/backends.ts`、`src/agents/catalog.ts`、`src/plugins/trust.ts` 读起。
- 文件示例在 `examples/plugins/stagekit/`。网页选择、阶段证据与错误、检查设置、后端来源待接，字段见 `docs/v2/flows.md`。

## 2026-11-22 · 本人沙箱的目录与审批

`src/agents/runner.ts` 按本轮传给豆包 CLI 的参数显示「完全访问」或「风险审批」。访客单项开着时，运行页也能区分实际采用的审批方式。

本人沙箱为 `/tmp` 根保留私有临时文件系统。只读档案把工作目录设为 `/tmp` 时仍可创建私有临时文件，显式放开的子目录照常挂载，见 `src/agents/own-sandbox.ts`。

普通运行、短问答和复盘评判在启动前共用 `src/agents/own-sandbox.ts` 的权限计算。豆包 CLI 读取独立的审批参数，已隔离的只读任务可以关闭后端审批，omem 的工具和写权限仍按只读处理。

`PUT /api/security/sandbox` 在 `src/core/config.ts` 合并磁盘上的外部改动后校验后端示例，用合并结果生成响应。路径无效时返回 400，保留外部编辑、原内存配置和审计记录。接口与成功审计见 `src/server/http.ts`。

沙箱目录随每轮任务正文发送。`src/agents/runner.ts` 和 `sessions.ts` 共用当轮说明，CLI 与 ACP 恢复会话时会收到新挂载和新产物路径。

多仓库评审自动找到的原工作树只进入本人沙箱的只读计划。成员账号按评审入口提供的工作目录和显式授权挂载，见 `src/agents/runner.ts`。

设置中生成的 Claude 和 Codex API 档案继承基础后端的状态目录布局。状态布局见 `src/agents/catalog.ts`，运行和设置示例共用 `src/agents/own-run.ts`。

## 2026-11-21 · 本机登录沙箱与统一的完全访问模式

豆包 CLI 的审批模式在准备运行时按可写角色和 `runAccess` 的强制档位决定，参数层不再读取全局设置或合并后的完全访问标记。未隔离的访客沿用风险审批，ACP、Codex 和 Claude 的模式及 ACP 独立写权限保持原计算。`test/doubao-cli.test.ts` 覆盖沙箱关闭、不支持时回退和已隔离的档位组合，`test/full-access.test.ts` 覆盖角色行为表。

多仓库运行在准备阶段收集分配的工作树、快照、核对过的产物目录及后端状态目录，再应用隐藏与只读规则。启动参数、运行状态和 Agent 当轮说明共用这份挂载计划；设置接口的默认示例也经过相同的状态目录校验。Git links/pointers、只读工作树与可写快照沿用原规则。回归覆盖 `test/own-run.test.ts`、`test/workspace-mounts.test.ts` 和 `test/own-sandbox-linux.test.ts`。

从 `src/agents/own-run.ts` 看本地运行选择，从 `own-sandbox.ts` 看挂载和后端模式。工作区及 ACP 写权限按角色保留，`GET/PUT /api/security/sandbox` 供本人检查和保存设置。配置组合及使用范围见 [本人的运行进沙箱](../../../docs/v2/agent-accounts.md#本人的运行进沙箱)。

## 整机诊断仅本人可读（2026-11-21）

`GET /api/diag` 随对等设备管理在 `src/auth/settings-sections.ts` 中登记为本人专属。成员仍可按区域读取设置卡片。

## 直接评审分支的用量（2026-11-21）

从 `src/agents/progress.ts` 的 `allocate` 读起。运行页和事项页按展示的块分配用量。直接评审已有分支时，首轮计入评审块；页面有对应编码块时，共用运行计入编码块，独立重评仍计入评审块。

## 成员查看插件卡片（2026-11-21）

从 `src/plugins/http.ts` 的 `pluginView` 读起。插件列表、详情和改图标共用成员视图，保留插件权限摘要；服务和服务命令返回空数组。

## 设置页的成员接口（2026-11-21）

从 `src/auth/settings-sections.ts`、`src/auth/routes.ts` 读区域权限及本人专属操作。设置读写隐藏其他成员的通知出口，`GET /api/notify/outlets?user=…` 返回目标的出口和已授权种类，`GET /api/me` 提供 `ownerName`。设置卡片的权限和返回字段见 `docs/v2/multi-user.md`。

进度的去重用量、落点和可见证据从 `src/agents/progress.ts` 读起。出网与云端工具状态附运行标题，云端工具的可选名单和说明从 `src/agents/cloud-tools.ts` 读起。

事项链路和指标按 `src/items/member-work.ts` 的可见子树统计。晚到妙记追加会议结果的条件在 `src/channels/lark-meetings.ts`。HTTP 规则可用的执行点由 `src/agents/operation-policy.ts` 给出，空规则和已有规则口径一致。

## 额外飞书机器人的群回复说明（2026-11-21）

从 `src/agents/sessions.ts` 的 `threadTurn` 看群消息提示。额外机器人沿用主助手时，与主机器人一样收到结合群上下文、直接回复的说明。同事提问的那一轮还会说明哪些事由提问人决定。

## 2026-11-21：云端向量、重排和插件向量

- 向量的 openai 配置归一为 api，可引用 AI 服务商密钥；共同提供者层负责批量、重试、维度校验、归一化、积压和降级。模型、维度或服务变化先预览并确认重建，本地模型也一样。
- 新增通行云端重排接口，兼容两种响应字段；非本地被动记忆门槛共用 pluginPassiveThreshold，空着使用余弦门槛。重排失败保持融合顺序。
- SDK api.embedder 与 permissions.embedder 支持进程内和沙箱向量。宿主限制空间，插件升级模型变化先暂停通知，重新确认后才重建；新增向量权限需重新信任。
- 新增本人专用的固定文本检测接口，GET /api/search/providers 合并向量 / 重排状态、积压、错误和未授权空间。云端网页字段另行接入。
- 从 `src/search/embedding-provider.ts`、`embedding-index.ts`、`embeddings.ts`、`rerank.ts`、`providers.ts`、`src/plugins/process-hooks.ts`、`sandbox-runner.ts` 和 `packages/plugin-sdk/server.ts` 读起。配置和验收见 `docs/v2/architecture.md`、`plugins.md`、`acceptance.md`；假服务与沙箱回归在 `test/search-api-*.test.ts` 和 `plugin-embeddings.test.ts`。

## 常驻说明按对话、后台和运行类型选节（2026-11-21）

合并时留在常驻说明里的四段（它们是高频动作的规则，不是偶尔才走的流程；改成“先读分组说明再做”的话，弱一些的模型会跳过）：`roles/_common.md` 的“怎么写记忆”（只给这次能写记忆的运行）、“问本人、给本人选项”、“流程里的一个阶段”（只给承担流程阶段的运行），`roles/assistant.md` 的“提问时怎么查”。分组说明页里保留同样的内容。受影响的预算是主助手、ingest、dreamer、coder、distiller、coach 六个角色；主助手对话时的常驻说明约 1.9 万字符（这一轮开始前约 3.1 万）。

从 `src/agents/instruction-sections.ts` 看小节的条件，从 `runner.ts` 和 `sessions.ts` 看场景来自哪里。群里被 @ 和关联事项的操作说明随本轮消息发送，原会话可以接着处理唤醒。写记忆、编码交办、流程验收等 17 个流程的正文移到工具分组。每轮的 `prompt.scene` 记录场景词，`test/prompt-budget.test.ts` 覆盖 44 个角色的对话和后台预算。

## 设置页按区域显示，接上通知出口、出网代理、云端工具和成员的例行整理（2026-11-21）

网页侧。设置页先读 `GET /api/settings/sections`，判断都在 `web/src/lib/settings-access.ts`（纯函数）和 `lib/caps.ts` 的 `settingsArea` / `settingsKey` / `settingsCard`；`Settings.vue` 的 `TAB_KEYS` 写每个分类读写哪些配置键，`SetCard` / `SetRow` / `SetGate` 带 `keys` 后决定显示和只读（`lib/set-readonly.ts`，只读的控件 `inert`），`settings/ctx.ts` 把保存的 403 换成指出键的一句话。新卡：`components/NotifyOutlets.vue`（`/api/notify/outlets`，账号页也用）、`EgressSettings.vue`（`/api/security/egress`）、`CloudToolsSettings.vue`（`/api/cloud-tools`）；成员详情的例行整理在 `MembersSettings.vue`（`/api/work/routine?user=`）。演示数据和截图在 `scripts/doc-screens.ts`（`settings-outlets`、`settings-egress`、`settings-cloud-tools`、`settings-member`）。

## 网页：统一的进度视图，远程授权按原因结束，Wiki 用模板开始（2026-11-21）

- 进度视图从 `web/src/components/ProgressBoard.vue` 和 `web/src/lib/progress.ts` 读起：读 `GET /api/runs/:id/progress` 或 `/api/items/:id/progress`，一块一行摘要，展开是任务的紧凑行，只读、每项链到自己的页面。运行页（`views/Runs.vue`）用它替换原来的任务板位置，任务板一块可展开原来的 `TaskBoard`；接口不存在时照旧显示 `TaskBoard`。`views/WorkDetail.vue` 和 `views/Items.vue` 各加一个“在做的”。刷新跟着 `run`、`work`、`changed item` 事件。
- 远程页（`views/Remote.vue`、`components/RemoteGrants.vue`、`lib/remote-grants.ts`）：抽屉读 `GET /api/remote/grant-candidates`，旧服务端退回读成员列表；被授权的一侧订 `remote-grant-ended` 事件，按 `revoked` / `expired` / `closed` 说话；`GET /api/remote` 里最近结束的条目不再当成会话。
- Wiki（`views/Wiki.vue`）：类型清单带 `templates=1`，编辑时正文为空才出现“用模板开始”。
- 演示数据（`scripts/doc-screens.ts`）：退款改造的需求上补了两轮的编码交办和评审，新截图 `progress-board`、`work-progress`。

## 从旧交办的助手分工找回首轮（2026-11-21）

从 `src/agents/progress.ts` 的编码投影读起。助手分工同时记有主轮和修改项号。即使拆项后还没写检查点就中断，修改项也能列出分派它的可见主轮。多项共用的主轮在交办总量里只算一次。

## 编码助手请教评审时按提问方归集用量（2026-11-21）

从 `src/agents/code-loop.ts` 的 `askReviewer` 读起。评审会话随交办复用，咨询运行挂在实际提问的助手下。一项单独请教时，其他助手负责的项继续显示各自的用量。

## 并行编码助手的用量按分工归到修改项（2026-11-21）

从 `src/agents/progress.ts` 的编码投影读起。两项共用主编码轮时，各自保留主轮的用量，转派后的助手及其子运行只计入分给它的项。交办总量按运行去重。旧轮在检查点前中断时，宿主接管事件里的项号也能找回归属。

## 修改项换模型或转派后保留之前的尝试（2026-11-21）

`src/core/db.ts` 在修改项更换编码运行时保存原关联。`src/agents/progress.ts` 将这些记录与当前运行、助手分工和检查点合并，每项按可见运行去重汇总。整块计入各轮及其子运行，旧轮缺少逐项记录时仍保留在交办总量里。

## 单项重评按实际执行的评审项汇总用量（2026-11-21）

从 `src/agents/progress.ts` 的评审投影读起。评审事件中的检查名称标明哪次运行执行了哪一项。同一轮中，一项完成、另一项重试时，重试的 token 只归到执行了重试的项，整块按运行去重。

## 多轮交办共用一个评审进度块（2026-11-21）

从 `src/agents/progress.ts` 读起。同一交办的续轮并入根评审块，各评审项保留每轮结论、问题和取舍，运行用量按 ID 去重。

## 2026-11-21 · 按运行或事项查分头进度

从 `src/agents/progress.ts` 读五种来源的状态、等待原因、尝试与产物；`progress-runs.ts` 负责运行范围和用量去重。两个详情接口下的 `/progress` 返回同一种数组，`work_status` 也接受运行或事项标识。历史任务板地址和原有字段继续可用。

## 两种第 162 版库升级后均可查看云端用量

主干的第 161、162 号迁移用于通知投递，旧云端分支用这两个编号记录用量和清理探测令牌。升级在同一写事务内补齐表及索引，保留投递记录、用量和清理之后签发的手工令牌。从 `src/core/db.ts` 的 `openDb` 读起。

## 全局 HTTP 令牌由本机配置管理

通用设置的读取和保存响应均省略全局 HTTP 令牌。保存普通设置时保留本机令牌，修改登录配置需要本人身份。从 `src/server/http.ts` 的 `/api/settings` 读起。

## 两个进程同时升级主干库时保留手工令牌

从 `src/core/db.ts` 的 `openDb` 读起。每次迁移先取得 SQLite 写锁，再核对当前版本。服务与 CLI 同时打开旧库时，后取得锁的进程会接着已提交的版本继续。双进程鉴权回归见 `test/cloud-http.test.ts`。

## 主干库首次启用云端工具时保留手工令牌

从 `src/core/db.ts` 的 `openDb` 读起。升级首次创建云端用量表时，同一事务会跳过旧探测令牌清理。已有该表的旧库仍执行一次清理。三种升级路径见 `test/cloud-http.test.ts`。

## 升级时撤销旧 CLI 遗留的云端探测令牌

从 `src/core/db.ts` 的迁移读起。升级时按本人、旧探测名称和空客户端清理遗留令牌。管理接口的回环代理验收见 `test/cloud-http.test.ts`。

## 本机 CLI 用一次性凭据发起云端探测

从 `src/auth/cloud-probe-ticket.ts` 看签发与核销。本机 CLI 未配置全局令牌时使用专用凭据，只能发起一次探测，60 秒后失效。

## 云端工具管理需验证本人身份

从 `src/auth/http.ts` 看管理请求的身份校验。本机 CLI 可自动认证，公网反代的放行配置见 `docs/v2/external-access.md`。

## 云端工具探测验证完整请求

从 `src/agents/cloud-probe.ts` 看两种探测。带头模式验证 GET 和 POST JSON，URL 模式要求首个 GET 不带 Authorization，再沿 next 地址提交查询参数。两者都要求读回最终回执，旧探测需要重新确认。

## 2026-11-21 · 云端后端按运行读取材料

本人可为指定云端后端启用少数只读工具，先探测公网回执，再确认。凭据限一次运行的成员、空间、名单、时长和次数。运行页显示调用，审计记录签发与作废。从 `src/agents/cloud-probe.ts` 看探测和准入，从 `src/agents/cloud-tools.ts` 看凭据与调用。[配置和接口](../../../docs/v2/external-access.md#云端后端调只读工具)。

## 空间成员和对象详情（11-21）

给成员分配空间角色时直接拒绝别人的个人空间，见 `src/core/users.ts`。按对象 id 读取详情时，对不可见和不存在的对象返回相同的 404，见 `src/auth/routes.ts`。

## 成员打开评审设置（11-21）

从 `web/src/App.vue` 看侧栏和深链权限，从 `web/src/components/ReviewSettings.vue` 看档位、评审项和轮换模型的只读展示与保存。只有助手区查看权的成员可以直接打开评审设置。

## 成员使用工具与续办工作的权限（11-21）

工具按分组和具体动作取能力，目录、实际调用和权限拒绝记录从 `src/auth/tools.ts` 读起。观察者的个人令牌可用于 CLI 和 MCP。学习目标与公开分享有效期只由本人修改。助手区查看者可读评审配置和表单模型选项，编码交办单独取档位列表。续办工作先检查归属和操作权，再排队或转话题；专用 Agent 的身份和空间范围见 `src/agents/agent-work.ts`。

## 成员权限按区域和对象检查（11-21）

设置接口按七个区域投影配置，写入时逐键授权并记录审计。区域与本人专用字段从 `src/auth/settings-sections.ts` 读起。原件标注、事项材料和上级关系的路由对照见 `docs/v2/multi-user.md` 的“成员能力”。Wiki 类型列表支持 `templates=1`，空间范围沿用类型目录。

## 2026-11-21 · 上游代理的 Basic 认证

严格成员运行使用带凭据的上游代理时，`src/agents/network-request.ts` 仅在 CONNECT 的代理认证头中发送解码后的账号密码。

## 2026-11-21 · 严格成员运行的出网代理

从 `src/agents/egress-run.ts` 读运行入口与回收，`egress-proxy.ts` 处理 HTTP、CONNECT 和按名单解密。本人由安全接口查看主机汇总和待批请求，策略与限制见 `docs/v2/command-gate.md` 的“出网代理”。

## 夜间通知补送避免重复提醒（2026-11-21）

飞书补送和插件出口按通知共用发送顺序。飞书逐张或整批发送前重新核对回执，前一个出口发送失败时另一个可接手。从 `src/core/notify.ts` 的 `withDeferredPush` 和 `src/channels/lark-bot.ts` 的 `sendDeferredLark` 读起。

## 成员的插件审批出口由本人授权（2026-11-21）

成员可以调整自己的通知门槛和普通提问偏好。读取旧设置时只显示当前已授权的种类，成员可直接修改并保存。工具审批和流程关卡按成员、出口和种类授权，发送前和接受回答时都复核。设置与投递从 `src/plugins/notifier.ts` 读起。

## 插件按成员投递通知和提问（2026-11-21）

普通投递、更新、提问和撤回共用一个插件出口。宿主保存投递回执，验证回答人的绑定身份。实现从 `src/plugins/notifier.ts` 读起，文件示例在 `examples/plugins/localnotice/`。

## 2026-11-21 · 成员的线和“等我的”，助手替本人问成员进展

- 成员看到的线：`src/items/member-work.ts`。成员和观察者的 `GET /api/work`、`/api/work/:id`、`/api/work/activities`、`/api/work/ended` 与本人同一个形状（原来的精简树 `sharedLines` 和网页的 `lib/shared-work.ts` 删了）。`viewerOf` 取“看工作线”的空间和自己事项的空间；`seesLine` 判一条线给不给（自己的，或本人在“看工作线”空间里的，不含候选 / 等待 / 稍后）；`visibleTree` 逐层判下面的事项（自己的，或本人的、在“看工作线”空间里、`itemAccess` 能读、不是候选 / 等待 / 稍后；上层看不到的下层也不给），有一件看不到就是 `partial`：不给 `now`、线自己的下一步、收尾小结、结束原因。计数、时间线、按时间（`changeFilter`）、已结束的线（`memberEnded`，partial 的不按小结搜）都只算看得到的；引用经 `scrubTargets` 只留读得到的事项和运行。每条线和详情带 `partial / mine / person / can`。
- 成员自己的线：`POST /api/items` 建 `kind: line` 原来就按请求者；新 `POST /api/work/:id/next`（`addNext`）手写下一步；`PUT /api/work/:id/phase`、`POST /api/work/:id/refresh`、`PUT /api/items/:id/parent`、`PUT /api/item-next/:id`、`PUT /api/item-changes/:id/noise` 从“只给本人”改成按事项本人和 `items.edit` / `items.operate`（`routes.ts` 这几行改了），别人的线 403。
- 例行整理：`src/items/member-routine.ts`。`users.settings.lineRoutine`（默认关；`GET/PUT /api/work/routine`，本人可带 `user` 替成员改，写 `audit_events`）。`mayRunRoutine` 在 `listen-assist.ts assistDue`、`lifecycle.ts queueWrapUp`、`flows/follow.ts` 排运行前检查：开着、登录了自己的 AI 账号、`sandboxSupport` 能隔离；不够就不排，原因存 kv 给工作页。这些运行的输入带 `ownAccountOnly`，`runner.ts runRole` 只留带成员自己账号的候选后端，一个都没有就失败，不借本人的登录。成员手动“更新”“就这么做”也查 `ownAccountProblem`（409）。
- 等我的：`pending.ts` 原来就按人取；能进工作页的人事项链到 `#/work/<id>`。`GET /api/work/today` 返回 `buildToday(app, now, 本人)` 的文字（不带选项，不发卡）。网页：成员的右栏只在有等他的时候出现，顶上一行可以展开的“今天”。流程：`web/src/lib/flow.ts` 的 `stageLine` / `nextWords` 和 `WorkStageTrack`、`ItemFlow` 多一个“是谁的”参数，不是自己的写“等 某人”。
- 问进展：`src/items/member-progress.ts` 和工具 `ask_member_progress`（`tool-help.ts` 的 `ask` 组，`auth/tools.ts` 要 `users.manage`，处理器里再查只有本人的运行）。`checkProgressAsk`：本人的事项、对方是在用的成员（不是观察者）、对方在工作页上看得到或有“看事项”。没本人确认先 `held`（本人这一轮亲口要的除外，`ownerAskedThisTurn`）；发出建一条归对方的提问（`context.handler = member-progress`、`askedBy`、`progressItem`，没有 runId），同一件事一人一条，再问用 `reviseAsk` 改；写 `audit_events`（`member-progress.ask`）。回答由处理器经 `recordChange`（`origin: member`，`source: ask:<id>`）记成 `info` 变化并 `notify`（later）；“现在说不了”记 kv，`PROGRESS_COOLDOWN_MS`（三天）内不再问。`roles/assistant.md` 加“向成员要进展”一小节，`skills/omem/references/owner.md` 写要点。
- 对别人显示本人的名字：`users.ts nameForOthers`（本人自己的“本人”换成本人的名字，没有就是“主人”），`asks.ts` 的通知和 `lark-asks.ts` 的卡片说明用它。
- 账号页“线的例行整理”开关（`web/src/views/Account.vue`）；文档截图 `work-member`（演示数据里小林的线和一条问进展）。测试 `test/member-lines.test.ts`、`member-progress.test.ts`、`flow-web.test.ts`。

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

- 现象：本人指定了模型和强度的交办，开始时报“该 Agent 不支持设置 effort，无法使用指定值 high”，有时重试就好，有时连着十几分钟都这样。
- 原因（读了适配器的代码、在一台机器上复现过）：适配器只在“会话当前的模型在它拿到的模型目录里”时才列出思考强度。它拿到的目录有时是旧的（没有较新的模型）：这时当前模型照样排在模型列表最前面，但没有强度可选，再选一次同一个模型也是空操作。前两版修法（重新取一次、等 12 秒）都是按“选项晚一点才到”做的，不对。
- 现在的做法（`src/agents/acp.ts`、`src/agents/catalog.ts`）：
  - 目录条目可以声明 `launchConfig`（启动时从哪个环境变量读 JSON 配置、模型和强度各叫什么键）。有这个声明的后端，运行指定的模型和强度在启动时就写进去，会话一开始就在这个模型和强度上，不依赖它当时列出什么。会话自己报的当前模型和强度（`models.currentModelId`，形如 `模型[强度]`）对得上时，即使没有列出强度的设置项也算设好了，状态里记一行“思考强度 … 已在启动时指定”。上次检测时这个模型没有的强度不写进启动配置。
  - 兜底（没有这种声明的后端）：会话列出的模型或强度比上次检测时少，就按“目录不全”处理——隔一会儿重开会话再试（指定了模型或强度的运行 15、30、60、120 秒各一次，仍然不全就失败并说明；没指定的试两次后照旧用后端的默认值）。被恢复的会话不会因此被删。指定了后端的运行不因为这个换到别的后端。
  - 后端主动发来的 `config_option_update` 也接了。
- 测试：`test/stall.test.ts`（假 Agent 的 `FAKE_CUT_UNTIL`、`FAKE_LAUNCHED`、`FAKE_LATE_EFFORT`）、`test/execution.test.ts`（检测结果过期、模型真的没了的情况）。

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
