---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-22
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-21 下半天](./changes-2026-11-21-second-half.md)（30 节）：成员的线和“等我的”、变化台账、“今天”并进简报、需求到交付的链路、远程会话交给成员、插件的检索 / 原件格式 / 页面类型、HTTP 规则的判定入口、成员能力和成员沙箱里的编码。
- [2026-11-21 上半天](./changes-2026-11-21-first-half.md)（60 节）：整理第一批（方案、设置页和数据页重做、其余页面整理）、工作线三四期和关注页、指标由本人确认、协同任务板、等本人处理的清单和提问卡的免打扰、按后端能力裁剪常驻说明和云端会话收尾、操作规则和规则包、对象授权、成员在助手里看流程和存规则、插件订阅事项与评审。
- [2026-11-20](./changes-2026-11-20.md)（24 节）：关注（盯群换成关注、从历史学、主动推进）、工作线的事项上下层和现状、演示和 Chrome 扩展的录制、成员用自己的 AI 账号、工作上的指标、每晚复查回复结果、插件设置。
- [2026-11-19](./changes-2026-11-19.md)：编码交办、流程、评审复核、会议、网页、设备和插件回调。
- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 2026-11-22：网页用上第二轮补齐的服务端字段

- 流程定义页（`web/src/views/Flows.vue`、`lib/flow-hooks.ts`）：去掉校验失败时自己解析 YAML 列阶段的兜底，停用标记只看校验的 `unavailableReferences` 和列表的 `unavailableChecks`（`FlowStageHooks.vue`、`FlowChecks.vue` 收 `unavailable`），插件信号名取列表的 `stageSummaries`；停用插件后改阶段名照常保存。“新用到的能力没有插件提供”的提示改成只对新增或改参的引用说。
- 事项的流程（`FlowStagePlugin.vue`）：运行器用 `carrier.runner`，删掉从 `carrier.label` 解析的 `runnerOf`；信号名用 `waitingSignal.name`；被拦下的卡片状态用 `gateReview.ask`，删掉点按钮前读 `GET /api/asks/:id`。还在等时 `stageActions` 只给“重开”，选了等处理以后写“你选了等处理（时间）”并给“处理好了，重新检查”；别人看时写负责人的名字（`ItemFlow` / `ItemFlowPage` 传 `who`）。`GET /api/flows` 只在阶段有运行器或检查时才读（取运行器用途和检查名）。`WorkStageTrack.vue` 拿到的精简阶段没有 `gateReview`，没改。
- 设置 → 安全（`SandboxSettings.vue`、`lib/sandbox.ts`）：主目录用接口的 `home`，删掉 `homeOf`；“按角色”下面按 `fullAccessGrants` 列出单独开着完全访问的内置角色、档案、规则（`grantLinks`），各链到 Agent 页或规则页。
- 后端：`AiDefaults.vue` 删掉按 `<插件>:<id>` 猜停用的分支，只认 `unavailableBackends`（设置 → AI 的档位也传了，`settings/ctx.ts` 存它）；`canProbe: false` 的后端用列表带的缓存、不发探测、不显示“重新检测”（`ctx.ts` 的 `loadProbes`、`AiBackend.vue`）。
- Agent 页按档案和技能的 `canEdit` / `canDelete` 显示保存、启用、停用、移动、文件和删除按钮；插件带来的档案不再出删除按钮。
- 向量状态行加“已有 N 个向量”，悬停看原件分块和记忆各多少（`embeddingStatusLine`）。重排“试一下”在改用环境变量时发出的草稿不带 `keyRef`，补了测试。进度视图的“只读 / 可写”此前已按 `access` 写好，服务端现在给了值。
- 文档截图：`settings-search-providers` 里示例云的地址显示成固定的 `https://api.example.com/v1`（`scripts/doc-screens.ts` 改写设置响应），重拍了它和 `work-progress`。

## 2026-11-22：试验和修改阶段的执行者摘要

- 流程列表的 trials、fixes 阶段保留 object 类型，在 `carrier.run` 返回执行类型、档案 id/name 和技能，最终缺省档案为 assistant。fixes 自身配置优先，未指定的字段分别继承首个 trials 阶段，与执行端共用同一规则。从 `src/flows/definitions.ts` 的 `studyStageCarrier`、`summarizeStage` 和 `src/studies/fixes.ts` 的 `fixModelStage` 读起。
- HTTP 列表用例覆盖两个对象阶段的指定档案、默认助手、显式助手和各字段继承、覆盖；改后重跑用例核对排队运行收到的档案与技能。字段文档在 `docs/v2/flows.md` 的“流程定义的结构化摘要”，用例在 `test/flows-http.test.ts`、`test/study-fix.test.ts`。

## 2026-11-22：停用运行器后的流程草稿保留

- 草稿列表按结构解析，不因信号或运行器停用而丢弃待启用定义，继续按流程查看空间裁剪。保存和确认卡启用仍校验新增、改参引用。从 `src/flows/http.ts` 的草稿读取、`src/flows/definitions.ts` 的保存边界读起。
- 假插件 HTTP 回归覆盖初次启用、停用后 PUT 改名、GET 草稿、本人回答及重读新定义；也核对改参仍被拒绝。用例在 `test/flow-plugin.test.ts`。

## 2026-11-22：第二轮网页对接的服务端字段

- 知识查看者得到只读后端摘要；普通探测读缓存，缺缓存返回空列表，刷新仅本人。缓存批量按主键读取。从 `src/server/http.ts`、`src/agents/probe.ts`、`src/auth/routes.ts` 读起。

- 进度投影 attempts 带 read/write 访问档位。从 `src/agents/progress.ts`、`progress-runs.ts` 读起。

- 重排检测按请求 api 整份替换，null 清字段，支持试用环境变量密钥。从 `src/server/http.ts` 的 rerank/test 读起。

- embeddings.embedded 提供分块、有效记忆已有数量及合计，复用部分索引。从 `src/search/embedding-index.ts`、`embeddings.ts` 读起。

- 豆包 CLI 从帮助探测目录参数，放到业务参数之前，无支持时用进程 cwd。从 `src/agents/doubao-cli.ts` 读起。

- 档案技能列表带当前人的 canEdit/canDelete，无管理能力的删除仍拒绝。从 `src/server/http.ts`、`src/auth/routes.ts` 读起。

- 本人沙箱状态增加 home 和各处完全访问授权清单，规则使用部分索引。从 `src/agents/own-run.ts`、`src/core/db.ts` 的末尾迁移读起。

- 设置列出所有配置引用的停用插件后端及原因。从 `src/core/config.ts` 的 allProfiles 和 `src/server/http.ts` 读起。

- gateReview.ask 显示处理状态和答复时间，查看者可读、本人答复，越过后保留、重开清除。从 `src/flows/engine.ts`、`plugin-gates.ts` 读起。

- 事项阶段直接带 carrier.runner、waitingSignal.id/name。从 `src/flows/engine.ts`、`signals.ts` 读起。

- 流程列表新增 stageSummaries，含承担者、完成信号与参数、时限。从 `src/flows/definitions.ts` 的 summarizeStage 读起。

- 流程保存保留同阶段未变的停用引用；校验和列表单独提示不可执行能力，校验结果也带停用检查 unavailableChecks。从 `src/flows/definitions.ts`、`http.ts`、`plugin-gates.ts` 读起。

## 网页接上向量和重排的来源、设备的接活开关和进度里的设备（2026-11-22）

设置 → 检索与记忆：“向量检索”卡（`web/src/components/EmbeddingSettings.vue`）选来源（不用 / 本机模型 / 云端接口 / 插件的向量提供者，按插件分组），云端填地址、模型名、密钥（设置 → AI 的服务商或环境变量名）、维度、每批条数和超时；来源和参数是一份草稿，“试一下”调 `POST /api/search/embeddings/test`，“保存”遇到 409 `confirmation: "embedding-model"` 时用 `confirmDialog` 写出清掉和重算的条数，确认后带 `?confirmEmbedding=<token>` 再存，取消就恢复。为此 `web/src/api.ts` 的 `ApiError` 多了 `data`（响应体）。“重排”卡（`RerankSettings.vue`）同样选本机 / 云端 / 插件，`rerank.api` 整份替换，“试一下”调 `POST /api/search/rerank/test`；本机模型的条数、长度和线程照旧即改即存。原来“插件参与检索”卡里选重排和插件门槛的两行挪走：选重排在“重排”卡，非本机重排的门槛在“对话前带上相关记忆”卡；那张卡改名“插件参与召回”，只管召回。草稿和形状的纯函数在 `web/src/lib/search-settings.ts`。

设置 → 设备：新卡“接别的设备派来的活”（`AcceptWorkSettings.vue`，`lib/accept-work.ts`），三档 `node.acceptWork` 只提交 `{node:{acceptWork}}`；按 `GET /api/peers` 的 paired[] 一行一台单独设，提交完整的 `acceptWorkFrom`。进度视图和任务板按尝试的 `mode` 写“借 ×× 的后端 / 在 ×× 跑”，历次尝试写期限、迟到标记和对方运行页链接（`lib/progress.ts` 的 `placeLabel`、`lateText`、`remoteHref`）；运行页的 `peer-work` 种类写“别的设备派来的任务”。演示数据（`scripts/doc-screens.ts`）加了一个本地假的 `/embeddings`、`/rerank` 接口和指向它的“示例云”服务商、一个插件向量提供者、配对设备 lab-mac，任务板的两块改成借它的后端和在它上面跑（其中一次迟到）。截图 `settings-search-providers`、`settings-devices-work`，重拍了 `search-providers`、`run-board`、`progress-board`。

云端向量和重排的接口地址（`embeddings.url`、`rerank.api.url`）接受任何 `http` / `https` 地址，本机和内网的模型服务可以直接填（合并前只接受域名）；`src/core/config.ts` 的 `searchApiFields`。被检查拦下的阶段卡第一句不再重复标题（`web/src/lib/flow.ts` 的 `nextWords`）。

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

## 网页接上流程里的插件和插件后端的来源（2026-11-22）

流程定义页每一段多了“改谁来做、怎么算完”（`web/src/components/FlowStageHooks.vue`）：内置和插件的信号按来源分组，“谁来做”里有插件执行；选中后写回 YAML（`web/src/lib/flow-hooks.ts` 的 `writeCarrier` / `writeDone`，用 `yaml` 的文档接口保留注释），参数的 JSON Schema 扁平时画成表单，否则是 JSON 框。`PUT /api/flows/:id` 返回 `askId` 时页面写“已提交，等你启用才生效”，就地启用。插件停用后 `/api/flows/validate` 读不了这份定义，页面按 YAML 自己列出各段并标停用。同页“完成前的检查”是 `FlowChecks.vue`，整表 `PUT /api/flows/:id/checks`。

事项的流程里插件的部分集中在 `FlowStagePlugin.vue`（用在 `FlowWaiting`、`ItemFlowPage`、`ItemFlow`）：插件信号的在等 / 问不到 / 没人能判断（给手动完成），运行器的执行者和运行链接，`pluginEvidence` 按 `src:` / `#/` / http(s) 打开，`gateReview` 的原因和“仍然通过 / 等处理”（回答 `askId` 那张卡，先读 `GET /api/asks/:id` 看还在不在等）。`lib/flow.ts` 的 `stageActions` 对被检查拦下的阶段给“处理好了，重新检查”和“重开”。

`AiDefaults.vue` 的后端下拉标“来自插件 ××”，已选而不可用的仍是选中项，写原因并链到插件页；只有保存的 `<插件>:<id>` 没出现在任何列表里时也这样显示。设置 → 后端与模型的后端行（`AiBackend.vue`）和未安装列表标来源；插件页在信任确认和卡片上列出后端和启动命令。进度视图的落点：`CodeTasks.vue` 读 `?task=T<n>`，`ItemFlowPage.vue` 读 `?stage=`，`ItemStudy.vue` 读 `?direction=` / `?trial=`，都用 `web/src/lib/landing.ts` 滚到并标出；`/items/:id/flow` 改道时保留查询参数（`web/src/main.ts`）。测试 `test/web-flow-hooks.test.ts`；演示数据装了 `examples/plugins/stagekit`，截图 `flow-plugin-checks`、`flow-stage-blocked`。

## 网页接上本人沙箱和补齐的接口字段（2026-11-22）

设置 → 安全 多了“运行的沙箱”和“完全访问”两张卡，从 `web/src/components/SandboxSettings.vue` 读起（纯函数在 `web/src/lib/sandbox.ts`，目录清单是 `SandboxPaths.vue`）。卡片读写 `GET` / `PUT /api/security/sandbox`，每次改动整份保存，“全部开”先确认并带 `confirmAll`；目录被拒时服务端的原因写在那一行下面。主目录从返回的路径里推出来（接口不给），用来把路径写成 `~/…`。

网页改用服务端补齐的字段，去掉自己拼的逻辑：本人的称呼读 `/api/me` 的 `ownerName`（`web/src/lib/owner-name.ts`）；成员页每人的“通知出口”复用 `NotifyOutlets.vue`（`user` 属性，`?user=` / `userId`），成员能不能勾审批看 `grantedAskKinds`；进度视图取 `?summary=true` 的合计、`local`、`href` 和证据的 `target`（`web/src/lib/progress.ts`）；出网和云端工具用接口给的运行标题和 `availableTools`（`web/src/lib/run-titles.ts` 只剩 `runName`）；HTTP 规则“在哪里生效”读顶层 `enforcedBy`（`web/src/lib/rule-places.ts`）。

`web/src/styles.css` 进度视图的窄屏 `@media` 少一个右括号，后面的“settings 2”一段原来只在窄屏生效，已补上。

沙箱的路径规则按 POSIX 写。Windows 上原来读、存这张卡都报错：现在 `sandboxStatus`（`src/agents/own-run.ts`）在路径不是 POSIX 的机器上不算示例运行的可写清单（返回空），模式和完全访问照常保存，带目录的保存返回 400 并说明这台配不了目录。不可用的原因改成“沙箱只支持 Linux”（原来写的是“多账号”）。

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

## 接活设备读取飞书群历史长页（2026-11-22）

从 `src/channels/lark-cli-tools.ts` 读起。飞书返回的消息超过 60,000 字符时，分页信息单独放在截断正文前，助手可以取出令牌继续同群同查询。

## 跨设备飞书读取保留文档选区、群分页和消息副本（2026-11-22）

从 `src/agents/board-lark-read.ts` 读起。接活设备按文档 ID 核对按读者保存的 wiki 原件，读取时保留选区。群历史的续页令牌绑定本次运行和原查询，续页时重新核验群归属。消息按各份原件的当前空间核验，其他空间补采同一条消息后，任务仍可读取本空间已有的消息和附件。

## 接活设备按任务空间核验飞书读取（2026-11-22）

远端任务读取飞书现文前，先在接活设备核对文档或群消息原件的当前空间。按 ID 批量取消息时逐条核验，读取整群时也检查分月归档。未归档的目标、账号范围搜索和无法限定目标的参数均在调用飞书前拒绝。从 `src/agents/board-lark-read.ts` 读起，两档接活的用例在 `test/work-board-peer.test.ts`。

## 成员查看内置角色（2026-11-22）

从 `src/server/http.ts` 的角色接口读起。有档案管理权限的成员可看内置角色的名称、用途和默认 AI。在 Agent 页打开角色进入只读摘要；只有本人的详情包含正文、专属记忆和复盘建议。自定义操作仅向本人回传原文。

## 跨设备任务按当前空间读取附件和技能（2026-11-22）

飞书消息留在任务空间时，单独归档的附件按原件当前空间核对，见 `src/agents/tools.ts` 的 `messageFileText`。技能目录、分组用途页、正文和附带文件共用 `src/agents/specs.ts` 的可见范围：执行档案指定的技能、可读空间挂载的技能和公共技能。

## 跨设备任务只读取已入库的飞书消息附件（2026-11-22）

从 `src/agents/tools.ts` 的 `messageFileText` 读起。任务板借后端和在对端运行时，读取已有附件原件沿用原件访问权限。附件尚未入库时，工具在下载或导入前返回原因，消息的附件记录保持原样。

## 成员管理 Agent 档案（2026-11-22）

从 `src/server/http.ts` 的档案接口读起。成员查看档案详情或保存说明、状态时取得与列表一致的摘要。档案原文的读写权限在 `src/auth/settings-sections.ts` 中与 MCP 配置一起限定给本人，技能原文沿用原权限。

`web/src/views/Agents.vue` 用摘要填写用途和状态，保存后重新读取档案。只有完整详情才加载原文和专属学习记录。

## 任务板跨设备尝试的停止与重派

在发起设备的运行页停止远端任务时，任务板立即取消当前尝试。接活设备离线时，取消请求保留到恢复连接。入口在 `src/agents/runs.ts` 的 `cancelRun`，任务状态和远端取消队列在 `src/agents/work-board.ts`。

退回本机和改借后端时，`work-device.ts` 按本机启用的档案选择执行者。对方独有的档案由本机主助手接手。远端调查可使用接活设备的技能、平台读取工具与档案标为只读的认证 MCP，见 `src/agents/runner.ts`。

直连中断后，反向请求沿用原配对的派单身份。签名只对当前命令、参数和反向凭据有效。传输入口在 `src/core/peers.ts`，接活端核验在 `src/agents/peer-work.ts`。

## 2026-11-21：任务板可以派到其他设备

- `dispatch_work` 每块可指定 device、mode 和 access。borrow 借 ACP 在本机只读，remote 在对方同名空间起运行。选择前核对配对、在线、协议与空间权限；在线设备只返回后端空位和仓库空间名称。读 `src/agents/work-device.ts`、`tools.ts`。
- 接活四条命令放进 peerCommands，经既有 /api/peer/exec 按配对令牌校验；node.acceptWork 默认关闭，acceptWorkFrom 按配对标识覆盖。远端档案按名字找，找不到用主助手；只读令牌拒写，写模式只开放任务空间的记忆、页面和事项。读 `src/agents/peer-work.ts`、`runner.ts`。
- 尝试记设备、模式、远端运行、期限与幂等键；本地轮询队列按索引限批处理，短时断网恢复继续，到期或失联一小时失败。取消先到也作废幂等键，重派后旧结果只记迟到。产物复用课题的 2 MB / 8 MB 上限，远端用量进入本地运行。读 `src/agents/work-board.ts`、`studies/remote.ts`。
- readBoard 和统一进度返回 deviceName、mode、remoteRunId、remoteUrl、deadline、lateAt；远端用量跟随本地尝试去重汇总。飞书卡片并列标设备，从 `src/agents/progress.ts`、`progress-runs.ts`、`src/channels/lark-work-progress.ts` 读起。接活开关与进度网页细节待接入。双临时 App 和假 ACP 的验证见 `test/work-board-peer.test.ts`。

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
