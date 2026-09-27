# 第一批实现状态

2026-09-27。已从设计进入可运行代码。主链为：输入材料 → 固定版本/片段 → 引用阅读 → Agent CLI/ACP 追问 → 保存回答与依据 → 变更通知；另提供可关联证据的需求待办和到期提醒。

## 已实现

- Node/TypeScript 模块化服务，Fastify HTTP API；SQLite + 图片对象目录；Vue 3 阅读台。
- osdk Node 版本锁定、应用依赖闭包、项目任务与 osdk-guide 安装；正确仓库 lejunyang/one-sdk。
- 根 design.md、omem-design skill、8 个 Vue 公共组件：按钮/图标/徽章/面板/空态/引用/弹窗/布局。
- CaptureEnvelope 支持文本/图片/链接与应用、窗口、会话、事件等上下文；图片严格类型和预算校验。
- 文件、固定 Git commit 文件、lark-cli 文档导入；主动 HTTP/CLI 输入；opt-in TraeX hook 转发模板。
- 版本化材料与不可变片段；引用/反向引用；环跳回；恢复为新版本且拒绝覆盖后续修改。
- 持久变更/通知同事务；应用内即时提示或关闭逐条提示；待办状态、关联证据、UTC 到期提醒去重。
- 官方 ACP SDK 的 initialize/new/config/prompt/update/cancel/close；动态模型/effort、固定证据、图片、超时、输出预算、进程清理；过滤 thought chunks。
- Codex/TraeX/Claude CLI adapter 与显式 argv；不通过 shell 拼 prompt；CLI 图像暂不支持，明确报错。
- 真实 Vue API 页面：材料输入/目录/搜索/阅读/引用/追问/版本/待办/通知/历史/能力，以及 Batch 2 的学习任务/attempt/提案、判断 diff/receipt、通知投递详情和飞书创建/复用/pairing 流程。

## 实际验证

- `osdk run check`：TypeScript、Vue 类型检查、服务端测试、生产构建。
- **85 项服务端测试通过**：原有 19 项继续覆盖版本幂等、历史证据、恢复冲突、循环引用、图片拒绝、到期去重、搜索转义、访问令牌/来源检查、完整问答持久化、hook字段筛选、模型/effort协商、权限拒绝、超时/取消，以及真实文件/Git读取；B2-01 有 4 项 SQLite 迁移/事务故障注入和 3 项严格合同测试；B2-02 有 A-J01～07、A-I01～03 共 10 项持久 job/输入缓冲验收和 1 项 HTTP job 控制回归；B2-03 有 A-R01～08 共 8 项角色运行验收；B2-04 有 A-K01～10、A-F01～03 共 13 项策略/反馈验收和 1 项 HTTP 应用回归；B2-05 有 A-L01～07 共 7 项注册/绑定/密钥验收、1 项同 device request 暂态重试和 1 项公开 capability probe 测试；B2-06 有 12 项实时事件、决策卡片和通知故障验收；B2-08 新增 3 项两阶段 worker、重启/幂等/stale/停机集成测试及 2 项生产 Lark host 装配/生命周期测试。
- 浏览器用真实 Fastify/SQLite 和协议 fixture：材料录入、递归引用/环、问答保存、旧版本读取、事项/通知、job→提案→应用→证据、判断三动作与 stale、飞书 QR/完整链接/复用/pairing、桌面/768px/390px、服务重启与离线/模型/通知失败，以及真实 SQLite 中的 100 个固定片段连续下钻（12 组浏览器检查）。fixture 只在测试配置使用，产品没有模拟回答 fallback；飞书平台 live 结果仍单列在 B2-06，不用浏览器 fake adapter 冒充。
- **真实 TraeX ACP**：首批曾用当时默认模型完成一次问答；当前验证通过 `OMEM_LIVE_MODEL=gpt-5.4` 显式选用 `gpt-5.4 / medium`。模型能力仍来自实时探测，产品与脚本不禁用 Astra，也不把任一模型写成产品默认限定列表。
- **真实 lark-cli**：使用用户提供的 ACP Wiki 文档验证读取与 CaptureEnvelope 归一化（revision 15，12,245 字符，text+link），报告不保存正文。
- Docker/containerd：仅 doctor 实测；当前宿主不可用，未执行容器 pull/build。
- Codex/Claude CLI：核对本机 help 与 argv/协议实现；本轮未实测其登录后的真实生成，不将其宣称与 TraeX 同等验证。

## 明确的实现取舍

上一轮 Python + PostgreSQL + 多引擎是长期提案。根据个人优先、Vue、CLI/ACP 优先，本轮先采用统一 TypeScript + SQLite，减少启动依赖，保留 API/领域/adapter 边界。不是宣称已经具备多租户 ACL、分布式事务或 pgvector。

所有原件/回答可追溯，不等于每个 Claim 已由证据验证器证实。当前答案保存的 references 是“提供给本次模型的材料”，正式 supported_by 评估还未实现。模型输出不自动升级为现行事实，不自动产生可执行方法。

当前引用身份按每份规范化文本的段落生成；跨 revision 语义 Fragment 身份续接、精确选区 selector、原生飞书 block 映射、原文刷新依赖失效暂未实现。UI 没有冒称具备这些能力。

## 后续实施顺序

详细任务拆分、协议与验收已移交到 [batch2 文档包](batch2/README.md)。后续实现以该包和已确认需求为准；以下是范围概览，尚未实现。MemPalace 新增为本地检索独立 PoC 候选，见 [专项研究](../research/mempalace/README.md)。

1. 从真实材料/轨迹提炼 Claim、Episode、TaskProposal 的结构化输出；强制证据绑定、歧义/影响分类；高置信小范围自动应用并通知，其他形成可审阅决策。
2. 外部通知 sender + 投递幂等/回执/重试；用户配置飞书目标后接即时通知与摘要。完善 hook 本地 spool、断线补传和可配置字段脱敏。
3. ACP 长期会话复用、resume/context packing、结构化人工问题与权限决策 UI；目前问答每次新会话，权限请求只通知并拒绝。
4. 捕获源注册/增量刷新/并发游标、跨版本片段映射和依赖刷新；接群聊机器人和外部屏幕观察器。
5. osdk 管理 embedding/reranker 快照，加入语义检索基线；再对 WeKnora/Hindsight 进行 CLI provider 兼容性与资源 PoC。
6. 团队模式用 PostgreSQL、独立主体与逐证据 ACL；主动推进外部事项的执行器独立授权，不能沿用普通知识写权限。

项目 README 给出了运行方式；历史设计/原型保留用来解释目标，不能当本页的已交付清单。

## Batch 2 当前进度

B2-01 已实现：Proposal/ProposalBatch/AssessmentBatch/CorrectionProposal v1 严格合同、捕获 provenance、任务 CAS 更新合同、SQLite v1→v2 事务迁移、迁移历史校验，以及正式 memory/task application 的原子 receipt/change/notification/delivery intent 仓储边界。

A-M01～A-M04 使用实际 SQLite 文件与 Fastify 旧读取 API 验证：固定 ID/原始 JSON/图片字节/历史引用/任务版本保持不变；迁移中断完整回滚且重启幂等；未来 schema 拒绝且数据库文件字节不变；change/outbox 写失败时 memory/task、通知和 application receipt 全部回滚。合同样例仅用于严格 schema 正反例，不作为 Agent、飞书或外部投递集成完成证据。

B2-02 已实现：SQLite schema v3 的 job attempt/control/input batch；capture 与首个 job 同事务；租约、心跳、fencing token、分类有界重试、取消/补偿边界、显式 retry generation 和 attempt fingerprint；owner-only hook spool、receipt 后清理、冲突/容量告警；chat/screen 静默窗、最长窗口、内容去重和迟到补充批次。HTTP 已提供 job 查询/取消/重试和 input-event 入口。

B2-03 已实现：extractor/verifier/planner/feedback-curator v1 role bundles、经校验的 inline/native Skill 模式、ContextManifest、隔离 workspace、新会话运行、严格结构化输出/修复上限、受管理工具 allowlist、图片能力门、runtime permission/elicitation 拒绝记录，以及 role output/trace 持久化。真实 TraeX ACP 本轮通过 `OMEM_LIVE_MODEL=gpt-5.4` 使用 `gpt-5.4 / medium` 对虚构材料完成一次 extractor + 独立 verifier，二者均通过运行时 schema，报告保存在忽略提交的 `.omem/verification/live-role-smoke.json`；这不表示候选已经应用。

B2-04 已实现：Proposal/assessment 持久化、Unicode exact quote 与图片对象核验、source head/epoch 读取集、owner/转发/歧义/冲突/影响范围策略、自动 task/claim/episode 原子应用、decision 再校验、不可变 task/memory revision、来源更新依赖失效、CAS 恢复，以及同 scope 反馈约束。A-K01～10 与 A-F01～03 均使用真实 SQLite 状态和故障/竞态条件断言；语义 verdict 为确定性测试输入，不冒充真实模型评测。另通过 `OMEM_LIVE_MODEL=gpt-5.4` 在隔离临时库完成一次真实 capture → extractor → fresh verifier → deterministic policy → task/change/notification/delivery intent/receipt 闭环，报告保存在 `.omem/verification/live-learning-smoke.json`。40/120 质量集尚未运行。

B2-05 已实现：官方 Node SDK `registerApp()` adapter、新建/已有应用状态机、二维码和可直接打开的验证 URL、取消/拒绝/过期处理、同一 device poll 暂态网络重试、AES-256-GCM owner-only secret store、真实 capability probe 接口、128-bit 以上一次性 pairing、同 app/actor 绑定、connection/binding 版本切换；按 botmux 源码 revision `597ffb10172ea9ac2b50b75507d52a8cf5fb0cd7` 的 `lark-scopes.json` 扩展为可复用个人助理 profile，预留文档/云盘/知识库、表格/幻灯片、日历、任务、会议与 CardKit 能力，同时排除批量/系统消息、群成员/群主操作、文档权限转移和日历 ACL 写删。支持手工凭据或从本机 botmux 配置按 app_id 复用已有应用；导入只读配置，公开列表不含 secret，选定凭据转存进 omem 的加密 store，仍强制 capability probe 和同应用 pairing。A-L01～07 使用注入的 SDK transport 与 capability probe 做确定性测试；真实创建/复用应用结果记录在 B2-06 live 验证报告。主进程在没有 secret key 和真实 probe 时不启用该入口。

B2-06 已实现 schema v8 的飞书 target/连接 lease/事件 inbox/投递尝试/卡片命令持久化；官方 SDK WebSocket adapter 记录连接与重连状态并在终止失败后重新启动，同一 connection 只允许一个 lease owner。绑定目标会自动建立 owner notification 与 decision target；把机器人加入群或直接绑定群时会立即启用消息监控，移群立即停用，不再增加第二次 owner 批准。自己的 bot 消息被过滤，重复/冲突/乱序事件保留身份与事件时间。正式应用事务为 active target 创建确定性 Card 2.0 intent，sender 固定 binding/version 与 provider UUID，处理租约恢复、429 退避、认证停用、响应丢失重试和一小时后 `unknown`。决策卡 callback 严格核验 app/operator/chat/message/nonce/proposal/expected-version/expiry，先持久入队再 ACK，异步 CAS 到 `MemoryService.decide()`，竞态/stale 后更新卡片为实际状态。

A-L08～14、A-N01～05 已用官方 SDK adapter 边界、真实 SQLite 重启、lease/故障注入和 Card 2.0 payload 做 12 项确定性测试；其中 A-N04 只覆盖当前支持的逐条即时模式，短窗合并/定时外发摘要尚未实现。用户授权的独立应用已真实通过凭据/权限回读、WebSocket 握手、私聊 pairing、主动通知、Card 2.0 callback 和入群消息自动采集；真实断网恢复、移群、secret 轮换、429/响应丢失与平台去重窗口仍只做故障注入，不能报 live pass。运行时组件保持显式装配，不在默认主进程里凭空启用外部连接。

B2-07 已实现：Vue 学习流程读取真实 job/attempt/proposal 状态；待判断页展示具体 body diff、策略原因、固定证据和只对 pending 开放的补背景/拒绝/确认动作；通知详情读取 application receipt、原证据和逐渠道 delivery 状态；飞书页支持新建、指定 App ID 增量授权、botmux/手工凭据导入、二维码与完整可点击授权链接、checking、同应用 pairing、失败恢复及 active connection。服务端为这些页面提供结构化只读 DTO，公开响应不含 secret。

A-U01～A-U05 由 12 组真实 Chromium + Fastify + SQLite 检查覆盖，详情见 [B2-07 验证记录](batch2/b2-07-verification.md)。提炼/复核结果仍是确定性 assessment 输入，飞书扫码/平台回调仍是注入 adapter；它们只验产品流程，不冒充新的真实模型或飞书联调。B2-06 已完成的真实应用结果继续有效。本轮没有调用 ACP，也没有使用 Astra。

B2-08 已开始集成：`learning.enabled=true` 时服务生命周期会启动受 lease/fencing 保护的持久 worker，把 `extract_claims` 与 `verify_proposals` 拆成两个可恢复 job。extractor 与 verifier 使用独立 Agent session，结构化结果及公开 trace 分别持久化；服务在 verifier 覆盖全部 proposal 且 digest 一致后才进入 MemoryService，模型本身无写库权限。confirmed feedback 会进入提炼上下文并在复核前再次强制应用；stale input 在模型调用前拒绝。优雅停机中断的 attempt 进入 transient retry，而不是误记成用户取消；同时修复了 ACP stdout 在 cancel/end 竞态下重复关闭流的问题。

新增 3 项集成测试验证：HTTP capture 自动完成两阶段 Agent 流程并原子应用；extractor 后重启继续 verifier，重复复核不重复 task/receipt；旧 source job 拒绝而新版本继续完成，停机中的 Agent job 可重试。另以 `OMEM_LIVE_MODEL=gpt-5.4 OMEM_LIVE_EFFORT=medium` 完成一次真实持久 worker 链路：两个 job 均 succeeded、proposal applied、task=1、notification=2，报告位于忽略提交且 mode 0600 的 `.omem/verification/live-pipeline-smoke.json`。

B2-08 生产 Lark host 也已接入：显式配置 `lark.enabled=true` 并提供 `OMEM_SECRET_KEY` 后，主服务会装配官方 registration、公开 OpenAPI capability probe、botmux existing-app provider、WebSocket connection supervisor、delivery worker 和 card worker；关闭服务会停止连接与未完成注册。公开 API 实际回读 scope/callback，事件则在真实 WebSocket 收到后追加到 capability profile，不能用 requested config 冒充已生效。host 测试验证 active connection 自动启动、真实 outbox 被 worker 消费、群消息开启监控并记录 observed event；使用的是注入 transport，不新增 live 结论。

B2-08 仍未全部完成：40 个开发样本与 120 个冻结 holdout 尚未建立和人工标注，A-N04 的短窗合并/定时外发摘要仍未实现。answerer 仍走第一批证据问答路径；topic session resume 和只读 MCP provider 尚未接入。
