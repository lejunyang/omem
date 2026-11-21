---
title: 2026-11-21 上半天的变化
summary: 整理与下一阶段的头一批：设置页和数据页重做、工作线和关注页、任务板、等本人处理的清单、按后端能力裁剪的常驻说明、操作规则和规则包、成员在助手里的流程和规则。
kind: reference
updated: 2026-11-22
---

从 [2026-10-13 之后的变化](./changes-since-2026-10-13.md) 移过来的 2026-11-20 夜到 11-21 上半天的改动，原样保留；每条给出改了什么和从哪个文件读起。

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

## 设置 → 安全：操作规则和规则包（11-21）

- 旧的“命令规则”卡（`CommandRulesSettings.vue`，只能写命令名加一条参数正则）换成 `web/src/components/OperationRulesSettings.vue`：按生效顺序一行一条（开关、标题或由匹配内容生成的一句、种类标签、处理方式的状态色、范围摘要、上移 / 下移、展开），点开编辑四种匹配（命令 / HTTP / 文件 / 工具）、处理方式、谁来批和等多久、范围（`OperationScope.vue`，成员 / 角色或档案 / 空间 / 后端多选）。整份 `PUT /api/security/operation-rules`；服务端的 `rules.N.字段: 原因` 错误显示在第 N 行下面。规则包里的规则只改范围和开关。HTTP 规则行尾写“还没有执行点”，其余种类悬停说明由谁执行。
- 新卡“规则包”（`RulePacksSettings.vue`）：列出插件和技能带的包，启用时选范围、有更新时列新增 / 去掉 / 改了 / 顺序，“换成新版”把接口给的 `confirmation` 原样带回；停用用 `confirmDialog`。上面的规则有未保存的改动时不让动包。
- “工具审批”改成 `SetCard` 的样子，工具一行一个（名字、用途一行、审批方式在右）。
- 卡片链接：`?card=operation-rules`、`rule-packs`、`tool-approvals`；旧的 `?card=command-rules` 落到操作规则。类型和一行文字的生成在 `web/src/lib/operation-rules.ts`。
- 演示数据（`scripts/doc-screens.ts`）加了五条规则和两个技能带的规则包（命令名 `acme`、主机 `api.example.com`），新截图 `security-rules`。
## 关注和流程跟进复用当轮的事项材料（11-21）

从 `src/channels/listen-items.ts` 读起。关注按状态进入时间选最近的活跃或待复核阶段，另取最近三条变化。关注和流程跟进都从已识别的可读工作线取观察截止日。流程跟进在预筛返回后读取工作线，预筛期间改的截止日也会进入排队材料。

## 工作线追问保留变化的处理结果（11-21）

从 `src/agents/turn-focus.ts` 读起。近期变化标明已否决、已采纳、已另开事项或已记录；尚待决定的改期单独标明。

## 提问带上正在讨论的工作线（11-21）

从 `src/agents/turn-context.ts` 看入口、会话关联和候选的判定，从 `src/agents/turn-focus.ts` 看材料预算。会话运行的 focus 事件记录识别方式和实际发送的小块；本人对话的事项工具按同一结果默认归线。
## 插件如何识别候选事项（11-21）

[插件开发文档](../../../docs/v2/plugins.md#订阅事项与评审事件) 说明了如何根据创建和状态事件区分候选、采纳和拒绝。事件字段见 `src/items/store.ts`，采纳和拒绝对应的状态见 `src/items/auto.ts`。

## 插件订阅事项与评审、同步外部条目、直接采集指标（11-21）

从 `packages/plugin-sdk/server.ts` 看三个接口，从 `src/plugins/process-hooks.ts` 看注册、声明校验与用户连接范围。`src/plugins/event-store.ts` 和 `event-delivery.ts` 负责同事务入队和按实体投递。事项同步通过 `/api/item-sync` 配置，指标从 `src/data/metrics.ts` 的 `collectDue` 进入。

事项按提供者、用户、连接账号和外部键去重。同页先建映射，再把子项挂到同空间的父项。导入时间线和回写确认写明外部来源，入口是 `src/items/providers.ts`。跨空间去重、三层限制及冲突回写的回归用例在 `test/item-providers.test.ts`。

## 其余页面的界面整理（11-21）

只改排版和文字，行为和接口不变。

- 页头统一成 `.page-head`（22px 标题、一句灰字说明、右侧动作）：工作页的标题不再是 28px 衬线，日期和条数并成一句；抽检页补了说明。
- 溢出：工作页的列表行改用阴影延伸悬停底色，不再用负外边距撑出列；事项页看板卡片的网格列加 `minmax(0, 1fr)`，长接口路径不再撑出列；抽检表窄屏隐藏两列。
- 运行页左栏：搜索和状态常驻，范围、类型、触发人、触发方式、含无事可报收进“筛选”（按钮上写改过几项）；列表行只写后端名，模型和强度在悬停里；“这项工作的各轮”不再重复写 Agent 名。
- 裸 id：`web/src/lib/work.ts` 的 `readableIds` 把页面上服务端认出的事项、运行 id 换成带标题的链接，原件 id 变成引用，其余 id、提交号、多段路径写成行内代码；工作线页的现状、下一步理由、流程里“卡住了 / 等你”的说明用它。需求页变更依据改成“原件 1”这样的引用标签。
- 长说明收进 ⓘ 或展开：事项页“可能要跟的”（每条两行）、Agent 页的表情反馈和夜间复盘（先列 6 条）、通知页的正文（先显示几行）和忽略规则（默认收起）、抽检页的最近抽检（一条一行，细节展开）、飞书知识库、账号、记忆页的说明。
- 几处 Agent 写的原因（规则试跑、归档、原件归属）改用 `RichText`。

## 读取事项材料时续查飞书权限（11-21）

事项材料的来源权限缓存满一天后，网页详情和 `read_item` 会等待飞书核对，再展示该成员仍可读的文档。从 `src/items/materials.ts` 的 `materialViews` 读起。

## 事项材料和撤权后的访问（11-21）

- 添加飞书原件时直接核对成员的来源权限，首次添加无需先打开原件。见 `src/items/materials.ts`。

- 群附件可通过包含原消息的聊天副本或解析原件获取，文件下载逐份核对原件权限。见 `src/auth/stored-files.ts`。

## 存储文件和事项对象授权（11-21）

文件预览从 `src/auth/stored-files.ts` 读起。文件名反查到原件时核对单件可见性，聊天附件和生成图按上传者、消息或运行判断。历史引用在独立线程分批补齐。

从 `src/items/access.ts` 读起。事项列表、详情、流程看板和候选操作按当前空间权限和事项归属判断。成员通过网页新建的事项归到自己的账号。移动子事项还会写到旧父事项和新父事项的时间线，两处都需要写权。详情里的聊天摘要与工作文件也按关联原件的可见性过滤。
## ACP 批准的命令由垫片核销（11-21）

ACP 在执行前批准经 PATH 调用的命令，垫片在同一轮中核销一次授权。后台会话池把同一会话令牌交给 ACP 和子进程，每轮将令牌指向当前运行。可从 `src/agents/acp-permission.ts` 和 `src/agents/command-gate.ts` 读起。

## 工具仅记录规则保留原审批（11-21）

工具命中 log 后仍按原设置询问或在完成时告知。入口在 `src/agents/tools.ts`。

## 高危操作按范围匹配和授权（11-21）

规则从 `src/agents/operation-policy.ts` 读起，配置迁移在 `src/core/config.ts`。授权按成员、目标与规则版本核销，审批卡片见 `src/agents/command-gate.ts`。接口、规则包和各执行点覆盖的字段见 `docs/v2/command-gate.md`。

## 设置页重新分组后的路径（11-21）

从 [快速开始](../../../site/guide/getting-started.md) 看日常设置，从 [验收清单](../../../docs/v2/acceptance.md) 查各功能的操作步骤。下表的旧入口均从“设置”进入。

| 旧入口 | 现在从哪里进 |
| --- | --- |
| AI 的通用、语音、决策、图片生成、API key | 设置 → 后端与模型，子标签名称照旧 |
| AI 的后端、默认 AI 与档位、任务选型、并行、排队与兜底 | 设置 → 后端与模型，卡片名称照旧。模型档位在“默认 AI 与档位”里 |
| AI 的 ACP 注册表、添加或修改 Agent 配置 | 设置 → 后端与模型 → 添加 Agent |
| AI 的成员的 AI 账号 | 设置 → 成员 → 成员的 AI 账号 |
| AI 的自动推进、方案先行；定时任务的事项自动收尾 | 设置 → 推进工作，卡片名称照旧 |
| AI 的流程进行中，自己跟进群和文档；总是同意的关卡… | 设置 → 推进工作，找“流程进行中，跟进群和文档”或“总是同意的关卡” |
| AI 的你直接做的提交，事后挂回事项上；课题的试验可以在哪跑 | 设置 → 推进工作，找“你直接做的提交挂回事项”或“课题的试验在哪跑” |
| 定时任务的重点文档补写、巡检预筛；通用的时区 | 设置 → 定时任务，点开“重点文档补写”或“巡检”那一行。时区在“时区”卡片 |
| AI 的回复发出前的检查、回复发出后看有没有用；渠道的有人找你、访客提问、私聊指令、拉人进群 | 设置 → 代你回复，卡片名称照旧 |
| AI 的过程消息；渠道的通知时间 | 设置 → 通知与打扰，卡片名称照旧 |
| 渠道的提醒的效果 | 数据页“omem 自己”一栏的“提醒”一节 |
| AI 的每晚抽检、夜间复盘 | 设置 → 自检与复盘，卡片名称照旧 |
| 检索；AI 的记忆质量 | 设置 → 检索与记忆，记忆质量在同名卡片 |
| AI 的桌面与浏览器控制；系统或安全的网页地址 | 设置 → 设备，找“桌面与浏览器控制”或“网页地址” |
| 渠道的机器人应用（含默认空间、飞书网页应用）；助手之间的转交、盯群 | 设置 → 渠道，分别找“飞书机器人”和“机器人在群里” |
| 连接的你的飞书、飞书文档；个人消息采集、飞书会话；其他平台 | 设置 → 采集，分别找“飞书文档”“消息采集”“其他平台” |
| 连接的关注 | 工作页点开对应工作线，进“关注设置”。新建关注在规则页或对助手说 |

## 角色说明按工具条件拆小节（11-21）

- `roles/_common.md`：“工作方式”只留通用的三条，检索、写入、相关空间、代码基线移到“查资料和写入”（有读的工具才带），命令规则和权限弹窗移到“执行命令”（`needs: local`，等后端能力的判断接上后生效）；“引用”只留格式和位置，查证、代码原件、附件移到“引用：查证与附件”；“同时在办的工作”加了工具条件。
- `roles/assistant.md`：原来 12 节都没有条件，拆成 22 节，每节按它讲的工具带 `<!-- tools: … -->`（找之前的对话、提问时怎么查、跟进、编码交办与分支评审、空间 Wiki 和运行、别人的技术方案、材料的定级和整理、飞书的发消息 / 文档和知识库 / 盯群和拉人、学习、沉淀与委派……）；“回答”单独成节，没有条件。内容只是搬家，改了三句衔接的话。
- 量出来的常驻角色文字（`_common.md` 加主助手正文，字符数）：全部工具 29,450（和以前相当），只有读的工具 6,253，一个工具都没有 2,652。按后端能力算实际能调用的工具合进来以后（见“按后端能力拼提示词”一节），没有工具的云端后端上主助手的整份常驻说明实测 2,229 字符（以前约 31,500），预算测试 `test/prompt-budget.test.ts` 把这类后端的上限定在 3,000。
- 还没用真实模型跑过拆完之后的主助手。

## 2026-11-21 · 待处理清单的草稿时限与标题

四种飞书回复草稿共用两天的创建时间下限。待处理清单和工作页草稿数都取自 `src/items/pending.ts` 的同一条查询。清单标题取第一段，经 `src/search/present.ts` 的 `plainText` 去掉 Markdown 与 HTML 标记后显示首句。

## 2026-11-21 · 等本人处理的清单

从 `src/items/pending.ts` 看各来源和根工作线的关联。`GET /api/pending` 按本人及可读空间筛选，阶段和变化按各自的卡片去重，指标、档案、技能及飞书草稿分组计数。工作页接口同时返回这份清单与原有 waiting 字段。


## 2026-11-21 · 提问卡遵守免打扰

从 `src/channels/lark-asks.ts` 看紧迫度和心跳补发，公共时间策略在 `src/core/notify.ts`。后台提问立即出现在网页，飞书在允许时段送出仍有效的卡。
## 任务板的验收与可见范围（11-21）

共享会话里由派单的成员验收。协调消息标出本轮待验收的块，长报告给出续读位置。必选块及退回重做的块验收完即可汇总。运行详情的任务板入口、板查询和进度事件都按发起运行的读权限展示。从 `src/agents/work-board.ts` 和 `src/server/http.ts` 读起。

## 协同任务板（11-21）

主助手可以一次派出几块独立调查，在必选块收齐后逐块验收。重做保留子任务 id、旧报告与执行记录。调度从 `src/agents/work-board.ts` 读起，工具用法见 `skills/omem/references/agents.md`。界面可以从运行详情的 `board` 取关联，读 `GET /api/agent-work/:id/board`，收到 `work` 事件后刷新。
## 豆包创建回执晚于取消时清理新会话（11-21）

`src/agents/doubao.ts` 在发出创建请求前把 UUID 记入运行，取消后仍在这次请求原有的 30 秒期限内接收会话 ID。ID 到达时中断任务，`src/agents/dispatch.ts` 将新会话交给现有清理队列。回执丢失或超时，运行记录保留请求 UUID 和错误。

## 云端角色的常驻说明长度预算（11-21）

`test/prompt-budget.test.ts` 分别记录原目标与固定材料的实测上限。云端主助手目标为 16,500 字符，当前上限为 18,489。四个纯文字角色目标各为 3,000，各自的过渡上限随未标记正文缩短而下调。

## 云端续聊失败后按入口重建首轮（11-21）

聊天由 `src/agents/sessions.ts` 重新组装历史和本轮消息。飞书 `/ai` 等已提供完整任务的入口由 `src/agents/doubao.ts` 重新发送角色说明和任务，并按调用方的保留设置处理新会话。

## 后台任务按交付工具选择后端（11-21）

`src/agents/runner.ts` 的 `requiredTools` 明确一轮必须可用的工具。后台角色默认使用角色交付工具，自动选型和候补链按同一能力筛选。所有候选都缺工具时，作业在写入事项游标或记忆复核状态之前结束，并记录原因。

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
