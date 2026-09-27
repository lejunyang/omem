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
- 真实 Vue API 页面：材料输入/目录/搜索/阅读/引用/追问/版本/待办/通知/历史/能力/组件展示。

## 实际验证

- `osdk run check`：TypeScript、Vue 类型检查、服务端测试、生产构建。
- **59 项服务端测试通过**：原有 19 项继续覆盖版本幂等、历史证据、恢复冲突、循环引用、图片拒绝、到期去重、搜索转义、访问令牌/来源检查、完整问答持久化、hook字段筛选、模型/effort协商、权限拒绝、超时/取消，以及真实文件/Git读取；B2-01 有 4 项 SQLite 迁移/事务故障注入和 3 项严格合同测试；B2-02 有 A-J01～07、A-I01～03 共 10 项持久 job/输入缓冲验收和 1 项 HTTP job 控制回归；B2-03 有 A-R01～08 共 8 项角色运行验收；B2-04 有 A-K01～10、A-F01～03 共 13 项策略/反馈验收和 1 项 HTTP 应用回归。
- 浏览器用真实 Fastify/SQLite 和协议 fixture：材料录入、递归引用/环、问答保存、旧版本读取、事项/通知、桌面与 390px 手机，以及真实 SQLite 中的 100 个固定片段连续下钻（7 组浏览器检查）。fixture 只在测试配置使用，产品没有模拟回答 fallback。
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

B2-05～B2-08 尚未实现。当前服务没有自动启动 capture→extractor→verifier worker 编排，也没有飞书扫码/绑定、真实外部投递或决策 UI。answerer 仍走第一批证据问答路径；topic session resume 和只读 MCP provider 尚未接入，现有 Batch 2 角色全部强制 fresh session、默认无工具。
