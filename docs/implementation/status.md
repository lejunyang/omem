# 实现状态

> 本页为唯一当前状态来源。文档最后更新：2026-09-27（第三轮代码修复全部完成并提交后）。代码基线：`16d3aa6` + assistant-v3 修复 + v14 治理增量 + 第三轮 P0 修复；**具体能力以仓库代码为准**。

## 当前状态

- **代码基线**：`16d3aa6` 之后叠加 assistant-v3（V3-01～V3-06）六组修复，并新增 v14 治理增量（memory_equivalences 关系表、decisions.attention_case/dedupe_key、AcpAssistantModel 生产接线）。
- **Schema 版本**：SQLite `SUPPORTED_SCHEMA_VERSION = 14`（`apps/server/src/storage/migrations.ts`；v14 新增 `memory_equivalences` 表 + `decisions.attention_case`/`dedupe_key` 列与去重索引）。
- **测试**：实测 2026-09-27（`osdk run check`，exit 0，含 typecheck + 全量 vitest + build）— **176 通过 / 0 失败**（30 个测试文件）。原 19 项 Windows CRLF/反斜杠 digest 与 Unix 权限位失败已全部修复。ACP 子进程清理：根因是 `acp()` 的 `finally` 里 `stop(child)` 只发信号不等待进程退出，Windows cwd 句柄释放延迟导致 `rmSync` 竞争。已在 `agents.ts` 中 spawn 后注册 `child.once("close")`，finally 里 `stop` 后 `await Promise.race([closed, 5s timeout])`，测试 cleanup 改为单次 `rmSync` 不吞错不重试。连续 3 次 agents/role-runtime 全过。
- **主助手模型接线**：生产装配 `apps/server/src/app.ts`（Web 路径）和 `apps/server/src/integrations/lark/runtime.ts`（飞书路径）均已 `new AssistantRuntime({ store, model: new AcpAssistantModel({ profile, workspaceRoot }), retrieval: new KeywordRetrieval(store.db), feedback: new FeedbackService(store), ... })` —— **Web 和飞书主助手生产路径均接真实 ACP adapter + RetrievalPort + scoped 纠正**。`DeterministicAssistantModel`（`assistant/default-model.ts`）**仅用于测试注入**。生产不存在"无模型配置时的假回答降级"：`AcpAssistantModel` 在无 profile / CLI transport / 未授权 / 超时 / 输出非 JSON 时一律抛 `ModelUnavailableError`，runtime 记 `failed` turn + `error=model_unavailable:*`，零 citation、零任务，绝不产出编造回答。任务创建经 `detectTaskIntent()`（21 祈使模式 + 11 咨询模式）确定性门控：咨询类即使模型发出 create_task 也被拒绝零写入；直接交办时 capture owner 消息为真实 source 证据后经 `MemoryService.evaluate()` 治理。取消经 `TurnCancelledError` fence 在 govern/complete 前检查，`withTimeout` Promise.race 主动 abort。
- **外部验证状态**：`AcpAssistantModel` 已复用真实 `acp()` 传输（`agents.ts`），并有 fixture agent（`tests/fixtures/acp-agent.mjs`）解析/超时/取消测试覆盖；但本机无 traecli/Codex 等真实 CLI，**真实 ACP 主助手端到端与真实飞书 WebSocket 收发仍未跑过 live**（均为注入/fixture adapter 测试）；语义检索（embedding）未接入，当前为 SQLite 关键词召回。

## 能力矩阵

| 能力域 | 代码已实现 | 本地测试通过 | 真实 ACP 验证 | 真实飞书验证 | 剩余缺口 |
| --- | --- | --- | --- | --- | --- |
| 主助手对话 | 会话路由/turn 持久化与幂等排队（同 transport_event_id 不重复建 turn/task）、RetrievalPort 注入（Web+飞书均接 KeywordRetrieval 中文 2-gram 召回）、create_task 经 MemoryService + detectTaskIntent 意图门控（咨询类零写入）、群可见性 deny-by-default + 注入 policy、模型异常诚实失败（ModelUnavailableError→failed turn，不造假）、取消 TurnCancelledError fence + withTimeout（hung model 不挂死）、scoped 纠正注入（Web+飞书）、AcpAssistantModel 接真实 acp() 传输 + transport 路由 | 是（assistant-runtime 19、acp-model 9、conversation-router 3、conversation-security 3、lark-delivery-recovery 5） | 否（已接真实 acp() 传输 + fixture 解析测试；本机无 traecli，未 live） | 否（WebSocket 收发为注入 adapter） | 真实 ACP 端到端；HTTP cancel e2e；重启 pending turn 完整重放 |
| 检索 | RetrievalPort 接口 + KeywordRetrieval（SQLite LIKE + CJK 2-gram 分词 + 停用词 + 长度加权打分）；source-profile 确定性规则分析；project_trusted 软过滤（未确认不过滤） | 是（retrieval-source-profile 6、retrieval-keyword 3） | 不适用 | 不适用 | embedding/语义检索；MemPalace sidecar；跨版本 Fragment 身份续接 |
| 知识治理 | AttentionGate 六态 + 四条件门控、memory_equivalences 等价关系表、decisions.attention_case/dedupe_key 去重、**evaluateBatch 生产化接入 pipeline verify()**（整 ChangeSet 去重累计 impact，超限全部 park 不 apply）、冲突记录、refresh_records、proposal/policy/receipt 原子应用 | 是（attention-gate、proposal-policy、learning-pipeline G17 批量） | 部分（历史一次 live smoke，`.omem/verification/`） | 否 | 完整重核验（extractor+verifier 重跑）consolidation job；真实模型语义冲突判断 |
| 输入保真 | per-part provenance、canonical principal 映射、owner/非owner 区分、agent/derived 入队区分、**飞书富文本/图片/reply 解析为统一 parts**（post→标题+段落，image→asset download，reply→replyTo/quoted） | 是（batch2-fixes G04–G07/G14、lark-rich-parts 3） | 否 | 否（open_id 绑定全链路；图片为 fake transport 验证） | 飞书真实网络图片下载；reply_to 真实引用关系解析 |
| 通知/投递 | outbox、投递幂等/重试/退避、卡片 callback 校验、cancel 撤销未发卡、短窗合并/定时汇总 | 是（lark-delivery、lark-realtime、annotation-cancel-delivery） | 否 | 部分（历史一次真实应用配对/通知/callback live） | 断网恢复、移群、secret 轮换、429 真实窗口 |
| 质量评估 | 证据支持六维拆分、规则基线语义判断、空分母 null、标注卡/冻结 manifest | 是（quality-evaluation、quality-annotation、import-quality-isolation） | 否 | 否 | 120 条 holdout 未建立；真实模型预测的语义评估效果 |
| 外部集成 | lark registration/pairing/加密 secret store、ACP adapter（Codex/TraeX/Claude）、Git/file 连接器 | 是 | 部分（TraeX 一次） | 部分（lark 一次） | MemPalace/WeKnora/Hindsight sidecar；无 Docker（见下） |

## G01–G20 验收场景逐项覆盖

来源：[assistant-v3/migration-and-acceptance.md](assistant-v3/migration-and-acceptance.md) 第 88–109 行。测试名均为 `apps/server/tests/` 下实际存在的用例，未重新编号。

| ID | 场景简述 | 对应测试文件 · 用例名 | 状态 | 证据/断言要点 |
| --- | --- | --- | --- | --- |
| G01 | 导入 40 段业务说明，无逐句确认卡 | retrieval-source-profile.test.ts · "G01: importing a business doc profiles it…asks zero per-sentence confirmations"；import-quality-isolation.test.ts · "G01 ordinary import does not create quality annotation work" | pass | 导入即生成 source-profile 且可关键词检索；普通 capture 零 quality dataset/sample/card |
| G02 | 保留父上下文，区分现状与规划 | retrieval-source-profile.test.ts · "G02: keeps parent context for anaphora and separates present-state from planning discourse" | pass | 回指「上述三种」保留父句；「当前…未来可能…」不统一标 verified fact |
| G03 | 代码/TODO/SQL 示例当示例非指令 | retrieval-source-profile.test.ts · "G03: code, SQL examples and TODOs are parsed as code examples, not owner instructions" | pass | 符号/commit 保留；不当成 owner 交办或执行命令 |
| G04 | 逐句 actor/time 保留 | batch2-fixes.test.ts · "G04 keeps each speaker's actor/time on its own part (top-level actorId null)" | pass | per-part provenance，不拍平为 actor=null |
| G05 | 两人同说保留两份 | batch2-fixes.test.ts · "G05 keeps both speakers when two actors say the same thing" | pass | 去重键 content_digest::actorId，两份参与者记录都保留 |
| G06 | 绑定 owner 的 ou_* 自动 apply | batch2-fixes.test.ts · "G06 bound owner's ou_* message maps to canonical owner and auto-applies" | pass | canonical principal 比较，不反复要求认领 |
| G07 | 非 owner 群消息不自动建 owner task | batch2-fixes.test.ts · "G07 a non-owner group member's task clue is NOT treated as owner's own task" | pass | 留为他人活动线索，不自动建 owner Task |
| G08 | owner 明确交办时经 MemoryService 建任务；咨询类不建任务 | assistant-runtime.test.ts · "G08: owner-verified task is created through MemoryService, not store.createTask"、"governance: consultative query does not create task even if model requests create_task"、"governance: group-member material cannot be turned into an owner task" | **pass** | `detectTaskIntent()` 确定性判断（21 祈使模式 + 11 咨询模式）：owner 直接交办 → capture 消息为真实 source 证据 → `MemoryService.evaluate()` 治理 → auto_apply receipt；咨询类（"接口说明""怎么写"）即使模型夹带 create_task 也被拒绝，零写入，回答改写为"未创建任务，因为这是咨询而非交办"；群成员材料诱导 → `retain_as_source` 不建 owner task。 |
| G09 | 群内不泄漏私密证据 | assistant-runtime.test.ts · "G09: group conversations deny evidence by default when no policy is injected"、"G09: injected policy hides private evidence in group; p2p history does not leak" | pass | 群会话无 policy 时默认 deny-by-default；注入 policy 隐藏私密证据；p2p 历史不向群泄漏 |
| G10 | 无关材料 defer 不建 decision | attention-gate.test.ts · "G10: off-task material with missing time/scope is deferred, retrievable, never a decision card" | pass | ignore_noise/defer_until_use 态，不创建 decision card |
| G11 | 冲突→一个有背景的问题 | attention-gate.test.ts · "G11: a conflict that overwrites existing knowledge becomes one contextual decision, not a JSON blob" | pass | awaiting_decision 态，decision 带背景/证据/选择 |
| G12 | 重复/矛盾不新增 active | attention-gate.test.ts · "G12a: same statement links existing memory"、"G12b: opposite claims keep both as dispute"；retrieval-source-profile.test.ts · "G12: recalling an already-applied memory by keyword" | pass | duplicate/equivalent linked；conflict_recorded + knowledge_disputes；召回已有对象 |
| G13 | 原件更新触发 refresh 记录影响 | attention-gate.test.ts · "G13: a source revision update records the affected memories and they stop being active evidence" | pass | refresh_records(status=needs_review)，受影响记忆停用为 active evidence |
| G14 | agent original 入队、derived 不入队 | batch2-fixes.test.ts · "G14 original agent session enters extract_claims; derived does not" | pass | queueCaptureJob 只跳过 derived，不跳过 agent original |
| G15 | 图片/富文本群消息进入模型 | lark-rich-parts.test.ts · "post message parses title + paragraph text parts"、"image message downloads via fake transport and creates image part with asset"、"reply message sets replyTo/quoted provenance on all parts" | **pass（fake transport 验证）** | `realtime.ts` `buildCaptureParts()` 解析 post 富文本为标题 + 段落 text parts（text/a/at/img 展开）；image 消息经 `media.downloadImage(messageKey)` 下载字节存为 asset，创建 image part 带 mimeType/data/asset_ref；reply 消息填 `provenance.replyTo` + `quoted:true` + actorBindingVersion。均通过 fake transport 确定性验证，未跑真实飞书网络。 |
| G16 | 用户纠正后后续答案体现限定 scope | assistant-runtime.test.ts · "H-G16: correction in same scope reaches model; different scope does not leak"；proposal-policy.test.ts · A-F01/A-F03 | **pass** | `AssistantRuntime.turn` 从 `FeedbackService.recall(conversation.id)` 读取当前 scope 的 confirmed 纠正，作为 `trustedContext` 注入模型 prompt；同 scope 注入、跨 scope 不串。学习 pipeline 的 `confirmed_corrections` 注入（A-F01/A-F03）保持不变。 |
| G17 | 一次计划/变更影响多对象按总影响策略门禁 | learning-pipeline.test.ts · "G17 batch: 12 independent creates exceed impact gate, all deferred, zero applied"、"G17 batch: 12 same-entity creates fold to impact=1, one applied"；attention-gate.test.ts · "G17: evaluateBatch unions affected entities and gates the whole ChangeSet" | **pass** | `evaluateBatch()` 生产化：去重累计 impact = `affectedMemoryIds` 并集 ∪ `affectedEntities`（确定性键 `claim:ws:project:normalizedStmt`）；门禁先算后用，超 `maxAutoApply=10` 时全部 park 为 `awaiting_decision`（`batchDeferred=true`），0 receipt、0 active memory，建一张合并 AttentionCase（dedupeKey=`attention-batch:<ws>:<sorted-digests>`）。`pipeline.ts verify()` 已改调 `evaluateBatch(整份 entries)` 替代逐提案 `evaluate()`。12 条独立 create impact=12 全部门禁阻断；12 条同实体 impact=1 自动 apply。 |
| G18 | 停止后未发卡不发送 | annotation-cancel-delivery.test.ts · "cancel sweeps the queued intent in the same transaction; sender sends nothing"、"keeps delivered history and does not recall an in-flight send"、"sender suppresses a card even if a retry intent appears after cancellation" | pass | cancel 事务撤销 pending/retry_wait intent；已投递历史保留；在途不撤回 |
| G19 | 评测指标不把子串当支持满分 | quality-evaluation.test.ts · 9 项：reverse statement / empty answer null denominator / faithful paraphrase / dropped restrictive condition / dated quote time mismatch / negation flip / changed numeric bound / null rates / unnecessary interruption | pass | 六维 evidenceSupport 规则基线；空分母输出 null；反例不算支持成功 |
| G20 | 模型暂不可用/重启时降级不丢数据 | assistant-runtime.test.ts · "degrades honestly when the model errors instead of pretending"、"unavailable model reports honestly…"、"cancellation: a newer message interrupts the in-flight turn without a task"；lark-delivery-recovery.test.ts · "enqueue before finish survives crash"、"concurrent same event idempotent"、"ambiguous failure retries then succeeds" | **partial** | 模型异常/`ModelUnavailableError` → turn `failed` + 诚实错误、零假 citation、零任务（已测）；取消经 TurnCancelledError fence + withTimeout，新消息中断在途 turn（已测）；投递持久化：enqueue 先于 finish、同 event 并发幂等、per-turn provider_uuid、ambiguous 失败重试退避、`recoverUnfinishedTurns()` 清 stale pending（已测，5/5）。但「无语义检索后端时原件与已生效内容仍可查 + queue 可续 + 模型恢复后续跑」的端到端组合场景无单一断言；重启 pending turn 完整重放未实现（fence 保证已 committed 工具不重复执行）。 |

**统计：19 项 pass，1 项 partial（G20 端到端组合场景）。** G15 为 fake transport 验证（未跑真实飞书网络）；G20 的单维度降级/取消/投递恢复均已测，仅跨维度组合断言与重启 pending turn 完整重放未实现。

## 已知限制与环境问题（2026-09-27 实测）

- **osdk 验证全绿**：`osdk deps --frozen` exit 0；`osdk run check` exit 0（含 typecheck + 全量 vitest 176/176 + tsc/vite build）。信任门已由用户执行 `osdk --yes trust` 解决。
- **ACP 子进程清理已根治**：`agents.ts` 的 `acp()` 在 finally 中 `stop(child)` 后 `await Promise.race([child close, 5s timeout])`，Windows cwd 句柄释放后再返回；测试 cleanup 为单次 `rmSync`，不吞错不重试。连续 3 次 agents(6/6) + role-runtime(8/8) 全过。
- **refresh_dependents 重核验未实现（按设计 blocked）**：`learning/pipeline.ts` 该 job 只调 `recordSourceRefresh` 记录受影响记忆为 `needs_review`，随后**主动抛 `JobExecutionError("NOT_IMPLEMENTED")`** 失败——不谎报已完成重核验。完整 extractor+verifier 重跑 consolidation job 仍待实现。
- **Docker 未安装**：实测 `docker --version` 报「无法识别」，`osdk container doctor --json` 报 docker/containerd 均 `not-installed`。WeKnora/Hindsight 的 Docker 路径本机不可用。
- **无 traecli → 真实 ACP/飞书未端到端**：代码已接 AcpAssistantModel 真实 ACP adapter（含 fixture 解析/超时/取消测试），但本机无 traecli，真实 ACP 主助手对话与真实飞书 WebSocket 收发均未跑 live，仍为注入/fixture adapter 测试。
- **G20 端到端组合未实现**：模型不可用降级、取消中断、投递持久恢复各自已测；"无语义检索后端仍可查 + queue 续 + 模型恢复后续跑 + 重启 pending turn 完整重放"的跨维度组合无单一断言。
- **HTTP cancel 端点无独立 e2e 测试**：路由已在 app.ts 注册，`cancelTurn`/`shutdown` 已实现并经单元测试覆盖（含 hung model 不挂死故障注入），但 HTTP 层端到端取消未单独断言。
- **配置变通已全部撤销**：package-lock 的 npmmirror 改写、`package-lock.json.bak-batch2` 备份、osdk.toml 的 default_agents/npm.auto=true 临时改动均已还原；`git diff HEAD` 对这三个文件为零。

---

## 历史实现记录（Batch 2）

> **以下为历史记录，当前产品行为以本页「当前状态」与 assistant-v3 为准。** Batch 2 是 v3 之前的实现包；其中部分能力已被 v3 重构替代（如 quality dataset 守卫、provenance、检索端口），保留此处仅用于追溯，不作为当前已交付清单。

### Batch 2 进度概览

- **B2-01**：Proposal/ProposalBatch/AssessmentBatch/CorrectionProposal v1 严格合同、capture provenance、任务 CAS、SQLite v1→v2 事务迁移与回滚校验。A-M01～A-M04 用真实 SQLite 验证。
- **B2-02**：schema v3 job attempt/control/input batch；租约/心跳/fencing/有界重试/取消补偿；owner-only hook spool；chat/screen 静默窗与去重。A-J01～07、A-I01～03。
- **B2-03**：extractor/verifier/planner/feedback-curator role bundles、inline/native Skill、ContextManifest、隔离 workspace、结构化输出/修复上限、工具 allowlist、图片能力门。A-R01～08。历史曾用 `OMEM_LIVE_MODEL=gpt-5.4` 跑过一次真实 extractor+verifier smoke。
- **B2-04**：Proposal/assessment 持久化、Unicode quote/图片核验、策略（owner/转发/歧义/冲突/影响）、自动应用、CAS、来源刷新依赖失效。A-K01～10、A-F01～03。历史一次真实 capture→extractor→verifier→policy→应用闭环 smoke。
- **B2-05**：官方 Node SDK `registerApp()`、状态机、二维码/授权 URL、AES-256-GCM secret store、capability probe、pairing、botmux existing-app 复用。A-L01～07。
- **B2-06**：schema v8 飞书 target/lease/event inbox/delivery attempt/card 持久化；WebSocket adapter 单 lease owner；Card 2.0 intent 与 callback 严格校验。A-L08～14、A-N01～05。历史一次真实应用凭据/WebSocket/pairing/通知/callback live。
- **B2-07**：Vue 学习流程 UI（待判断页 diff/证据/三动作、通知详情、飞书绑定页）。A-U01～05 由 Chromium+Fastify+SQLite 浏览器检查覆盖。
- **B2-08**：持久两阶段 worker（extract_claims/verify_proposals 独立 job，lease/fencing，优雅停机重试）；生产 Lark host 装配；A-N04 短窗合并/定时汇总；schema v10 质量数据集/标注卡/冻结 manifest。历史一次真实持久 worker smoke。

### 已实现的基础能力（跨 Batch，仍有效）

- Node/TypeScript + Fastify HTTP API；SQLite + 图片对象目录；Vue 3 阅读台。
- CaptureEnvelope 文本/图片/链接 + 上下文；图片类型/预算校验。
- 文件、固定 Git commit、lark-cli 文档导入；主动 HTTP/CLI；opt-in TraeX hook 转发。
- 版本化材料与不可变片段；引用/反向引用；环跳回；恢复为新版本且拒绝覆盖后续修改。
- 持久变更/通知同事务；待办状态、关联证据、UTC 到期去重。
- 官方 ACP SDK initialize/new/config/prompt/update/cancel/close；动态模型/effort、固定证据、超时、输出预算、进程清理；过滤 thought chunks。
- Codex/TraeX/Claude CLI adapter 与显式 argv（不拼 shell）；CLI 图像不支持时明确报错。

### 明确的实现取舍

- 统一 TypeScript + SQLite 个人单用户实现；**不具备**多租户 ACL、分布式事务、pgvector。team scope 仅保留在架构设想中。
- 所有原件/回答可追溯，不等于每个 Claim 已由证据验证器证实；正式 supported_by 自动评估未实现。
- 跨 revision 语义 Fragment 身份续接、精确选区 selector、原生飞书 block 映射、原文刷新依赖自动重核验暂未实现。
