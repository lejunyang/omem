# omem 仓库 Wiki

由固定 Capture 版本派生；结构信息来自解析器，模型说明是可追溯的派生材料。源码与设计文档仍是证据来源。

运行 `osdk run review:build` 更新本文与索引；启动 `osdk run dev:review` 可自动重建本地索引并浏览引用。

## 模块目录

| 模块 | 文件数 |
| --- | ---: |
| [agent-runtime](#agent-runtime) | 37 |
| [assistant](#assistant) | 3 |
| [code](#code) | 8 |
| [contracts](#contracts) | 2 |
| [conversation](#conversation) | 1 |
| [inputs](#inputs) | 2 |
| [jobs](#jobs) | 2 |
| [lark](#lark) | 9 |
| [learning](#learning) | 2 |
| [memory](#memory) | 1 |
| [other](#other) | 45 |
| [quality](#quality) | 4 |
| [retrieval](#retrieval) | 2 |
| [review](#review) | 6 |
| [scripts](#scripts) | 17 |
| [server-root](#server-root) | 10 |
| [source-profile](#source-profile) | 1 |
| [storage](#storage) | 3 |
| [ui](#ui) | 19 |
| [web](#web) | 26 |

## agent-runtime

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/agent-runtime/bundles.ts](../apps/server/src/agent-runtime/bundles.ts)
- [apps/server/src/agent-runtime/gateway.ts](../apps/server/src/agent-runtime/gateway.ts)
- [apps/server/src/agent-runtime/job-handler.ts](../apps/server/src/agent-runtime/job-handler.ts)
- [apps/server/src/agent-runtime/requests.ts](../apps/server/src/agent-runtime/requests.ts)
- [packages/agent-runtime/roles/extractor/1/manifest.json](../packages/agent-runtime/roles/extractor/1/manifest.json)
- [packages/agent-runtime/roles/extractor/1/output.schema.json](../packages/agent-runtime/roles/extractor/1/output.schema.json)
- [packages/agent-runtime/roles/extractor/1/prompt.md](../packages/agent-runtime/roles/extractor/1/prompt.md)
- [packages/agent-runtime/roles/extractor/1/skills/omem-extract/SKILL.md](../packages/agent-runtime/roles/extractor/1/skills/omem-extract/SKILL.md)
- [packages/agent-runtime/roles/feedback-curator/1/manifest.json](../packages/agent-runtime/roles/feedback-curator/1/manifest.json)
- [packages/agent-runtime/roles/feedback-curator/1/output.schema.json](../packages/agent-runtime/roles/feedback-curator/1/output.schema.json)
- [packages/agent-runtime/roles/feedback-curator/1/prompt.md](../packages/agent-runtime/roles/feedback-curator/1/prompt.md)
- [packages/agent-runtime/roles/feedback-curator/1/skills/omem-feedback-curation/SKILL.md](../packages/agent-runtime/roles/feedback-curator/1/skills/omem-feedback-curation/SKILL.md)
- [packages/agent-runtime/roles/module-architect/1/manifest.json](../packages/agent-runtime/roles/module-architect/1/manifest.json)
- [packages/agent-runtime/roles/module-architect/1/output.schema.json](../packages/agent-runtime/roles/module-architect/1/output.schema.json)
- [packages/agent-runtime/roles/module-architect/1/prompt.md](../packages/agent-runtime/roles/module-architect/1/prompt.md)
- [packages/agent-runtime/roles/module-architect/1/skills/omem-code-module-architect/SKILL.md](../packages/agent-runtime/roles/module-architect/1/skills/omem-code-module-architect/SKILL.md)
- [packages/agent-runtime/roles/planner/1/manifest.json](../packages/agent-runtime/roles/planner/1/manifest.json)
- [packages/agent-runtime/roles/planner/1/output.schema.json](../packages/agent-runtime/roles/planner/1/output.schema.json)
- [packages/agent-runtime/roles/planner/1/prompt.md](../packages/agent-runtime/roles/planner/1/prompt.md)
- [packages/agent-runtime/roles/planner/1/skills/omem-task-planning/SKILL.md](../packages/agent-runtime/roles/planner/1/skills/omem-task-planning/SKILL.md)
- [packages/agent-runtime/roles/relation-verifier/1/manifest.json](../packages/agent-runtime/roles/relation-verifier/1/manifest.json)
- [packages/agent-runtime/roles/relation-verifier/1/output.schema.json](../packages/agent-runtime/roles/relation-verifier/1/output.schema.json)
- [packages/agent-runtime/roles/relation-verifier/1/prompt.md](../packages/agent-runtime/roles/relation-verifier/1/prompt.md)
- [packages/agent-runtime/roles/relation-verifier/1/skills/omem-code-relation-verifier/SKILL.md](../packages/agent-runtime/roles/relation-verifier/1/skills/omem-code-relation-verifier/SKILL.md)
- [packages/agent-runtime/roles/repo-profiler/1/manifest.json](../packages/agent-runtime/roles/repo-profiler/1/manifest.json)
- [packages/agent-runtime/roles/repo-profiler/1/output.schema.json](../packages/agent-runtime/roles/repo-profiler/1/output.schema.json)
- [packages/agent-runtime/roles/repo-profiler/1/prompt.md](../packages/agent-runtime/roles/repo-profiler/1/prompt.md)
- [packages/agent-runtime/roles/repo-profiler/1/skills/omem-code-repo-profiler/SKILL.md](../packages/agent-runtime/roles/repo-profiler/1/skills/omem-code-repo-profiler/SKILL.md)
- [packages/agent-runtime/roles/symbol-explainer/1/manifest.json](../packages/agent-runtime/roles/symbol-explainer/1/manifest.json)
- [packages/agent-runtime/roles/symbol-explainer/1/output.schema.json](../packages/agent-runtime/roles/symbol-explainer/1/output.schema.json)
- [packages/agent-runtime/roles/symbol-explainer/1/prompt.md](../packages/agent-runtime/roles/symbol-explainer/1/prompt.md)
- [packages/agent-runtime/roles/symbol-explainer/1/skills/omem-code-symbol-explainer/SKILL.md](../packages/agent-runtime/roles/symbol-explainer/1/skills/omem-code-symbol-explainer/SKILL.md)
- [packages/agent-runtime/roles/verifier/1/manifest.json](../packages/agent-runtime/roles/verifier/1/manifest.json)
- [packages/agent-runtime/roles/verifier/1/output.schema.json](../packages/agent-runtime/roles/verifier/1/output.schema.json)
- [packages/agent-runtime/roles/verifier/1/prompt.md](../packages/agent-runtime/roles/verifier/1/prompt.md)
- [packages/agent-runtime/roles/verifier/1/skills/omem-evidence-review/SKILL.md](../packages/agent-runtime/roles/verifier/1/skills/omem-evidence-review/SKILL.md)
- [packages/agent-runtime/src/code-understanding.ts](../packages/agent-runtime/src/code-understanding.ts)

## assistant

### apps/server/src/assistant/runtime.ts

来源：gpt-5.6-sol · 2026-09-29T10:55:03.575Z；通过结构与引用校验，未经独立语义复核。

- 作为 Web 与 Lark 共用的主助手运行时，统一编排对话轮次、上下文组装、证据检索、模型调用、受治理的任务创建、结果持久化、取消、重试与崩溃恢复。
- 在模型边界外执行可见性、引用、用户意图和写入治理校验，使模型只能基于运行时提供的证据回答，且不能自行取得写权限。
- 维护每个会话的串行执行链；新消息会中断同一会话中较早的在途轮次，不同会话则由各自的链独立处理。
- 将模型不可用、普通模型错误、取消和超时映射为不同的轮次状态或降级结果。

边界：

- 上游边界是调用 turn、cancelTurn、retryTurn、recoverUnfinishedTurns 和 shutdown 的 Web、Lark 或宿主生命周期代码；传输层事件标识仅作为投递幂等与任务提案幂等的输入。
- 对话状态边界由 ConversationRouter 承担；本模块负责编排 enqueue、start、complete、pending、failed、cancelled 等状态转换。
- 模型边界由注入的 AssistantModelPort 隔离；本模块传入会话历史、可见证据、可见性和所有者纠正，并接收自然语言答复、引用及结构化工具请求。
- 检索边界优先使用注入的 RetrievalPort，未注入时退回 Store.search；候选项仍需通过 Store.evidence 补全并接受可见性过滤。
- 写入边界由 MemoryService.evaluate 执行治理；本模块只在确定性意图检测通过后提交 create_task 提案，并通过 application_receipts 判断任务工具是否已经提交。
- 反馈边界由 FeedbackService.recall 提供按会话限定的所有者纠正；读取失败被折叠为空上下文。
- 默认可见性策略只允许私聊证据；群聊若未注入基于来源和范围的策略，则拒绝全部证据。

关键流程：

- **新轮次入队与同会话抢占**：turn 先确认会话存在并持久化输入，以 transportEventId 去重；重复投递直接返回已有轮次。非重复输入会中断同一会话的旧控制器、取消其运行中轮次，并把新执行追加到该会话的 Promise 链。
- **上下文组装与模型生成**：executeTurn 读取本会话最近的已完成轮次，合并上一轮选中证据与本轮检索证据，读取会话范围内的所有者纠正，然后在合并取消信号和硬超时约束下调用模型。
- **证据检索与可见性收口**：检索优先通过 RetrievalPort 获取候选 fragmentId，再从 Store 读取完整 revision 和 fragment；旧调用方可退回 Store.search。无论来源为何，证据都经过统一的可见性判定，群聊默认无证据。
- **任务工具治理**：运行时先用固定模式判断用户是否明确要求记录或分配任务；咨询型输入会拒绝模型发出的 create_task。通过意图门后，运行时校验引用，必要时把所有者本轮原话捕获为证据，再把提案交给 MemoryService.evaluate，并根据治理回执生成工具动作和面向用户的最终说明。
- **引用约束与轮次提交**：模型返回的 citationIds 会被限制在本轮实际提供的证据集合内；只有匹配证据进入 selectedEvidence。最终持久化前再次检查取消信号，随后提交答案、证据、工具动作和降级标记。
- **重试与崩溃恢复**：retryTurn 只重跑 pending 轮次；recoverUnfinishedTurns 扫描 pending 或 running 轮次。两条路径都会先查询真实 application_receipts：已有提交回执时直接补齐完成状态，否则重新执行轮次。
- **取消与关闭**：公开取消入口会中断对应会话的在途控制器并标记指定轮次；shutdown 会中断所有在途控制器，将各会话仍为 running 或 pending 的轮次标记为取消，然后清空内存状态。

限制与未决：

- 任务意图判断依赖有限的中英文正则模式；它是确定性安全门，但无法覆盖所有自然语言表达，也可能把含咨询词尾的真实交办判为咨询。
- 未注入可见性策略时，群聊证据全部拒绝；这是安全默认值，也意味着群聊回答可能缺少本可用的上下文。
- 未注入 RetrievalPort 时仍存在旧式 Store.search 路径，因此实际检索质量和统一检索合同取决于宿主是否完成注入。
- FeedbackService 读取异常和直接证据 capture 异常均被静默吞掉，调用方无法从轮次结果区分没有数据与依赖故障。
- 模型明确不可用时轮次保持 pending；其他模型异常则生成固定的中文降级回答并完成轮次，两类失败的恢复语义不同。
- 恢复循环捕获重新执行的全部异常并继续，只通过计数返回结果；失败细节不在该返回值中呈现。
- 任务提案在有 transportEventId 时具有稳定标识；没有该标识时使用随机 UUID，因此跨调用的提案级幂等依赖 MemoryService 自身的摘要去重。
- 上一轮工作上下文只取最近一个包含 selectedEvidence 的已完成轮次，并受可见性重新过滤；更早或未被引用的证据不会进入该通道。
- 当前快照只展示运行时与邻接接口的使用点，未提供 ConversationRouter、RetrievalPort、FeedbackService 和 MemoryService.evaluate 的完整实现，无法证明其事务性、并发隔离或底层授权细节。
- 快照未提供 ConversationRouter 的实现，无法验证轮次状态转换是否位于单一数据库事务内。
- 快照未提供 RetrievalPort、Store.search 与 Store.evidence 的完整实现，无法判断排序、召回质量、索引一致性或候选上限之外的行为。
- 快照仅展示 MemoryService 类声明和调用点，无法证明 evaluate 的具体策略、事务边界、权限校验及摘要去重算法。
- 快照未给出 FeedbackService.recall 的数据模型与授权实现，无法验证 owner-scoped 约束是否由存储层强制。
- 快照未提供 AssistantModelPort 的实际 ACP 适配器，无法验证模型和 effort 能力发现、拒绝不支持设置及传输取消的实际效果。
- 快照没有测试结果或运行日志，无法确认超时、抢占、崩溃窗口和重复投递路径已通过真实行为验证。
- 快照未说明 Web 调用该运行时的具体适配入口，也未展示 HTTP 取消与重试路由。
- 提供的检索 tokenize 文档说明关键词切分策略，但无法确认当前注入的 RetrievalPort 必然使用该实现。

代码引用：

- [apps/server/src/assistant/runtime.ts · AssistantEvidence](../apps/server/src/assistant/runtime.ts#L13)
- [apps/server/src/assistant/runtime.ts · ModelUnavailableError](../apps/server/src/assistant/runtime.ts#L45)
- [apps/server/src/assistant/runtime.ts · TurnCancelledError](../apps/server/src/assistant/runtime.ts#L53)
- [apps/server/src/assistant/runtime.ts · AssistantModelPort](../apps/server/src/assistant/runtime.ts#L60)
- [apps/server/src/assistant/runtime.ts · VisibilityPolicy](../apps/server/src/assistant/runtime.ts#L96)
- [apps/server/src/assistant/runtime.ts · TASK_INTENT_PATTERNS](../apps/server/src/assistant/runtime.ts#L106)
- [apps/server/src/assistant/runtime.ts · CONSULTATION_PATTERNS](../apps/server/src/assistant/runtime.ts#L130)
- [apps/server/src/assistant/runtime.ts · detectTaskIntent](../apps/server/src/assistant/runtime.ts#L144)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime](../apps/server/src/assistant/runtime.ts#L168)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.constructor](../apps/server/src/assistant/runtime.ts#L176)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.turn](../apps/server/src/assistant/runtime.ts#L198)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.cancelTurn](../apps/server/src/assistant/runtime.ts#L266)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.hasCommittedReceipt](../apps/server/src/assistant/runtime.ts#L280)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.retryTurn](../apps/server/src/assistant/runtime.ts#L293)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.shutdown](../apps/server/src/assistant/runtime.ts#L323)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.recoverUnfinishedTurns](../apps/server/src/assistant/runtime.ts#L347)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.cancelInFlightTurn](../apps/server/src/assistant/runtime.ts#L386)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.deriveSignal](../apps/server/src/assistant/runtime.ts#L393)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.assertNotCancelled](../apps/server/src/assistant/runtime.ts#L417)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.executeTurn](../apps/server/src/assistant/runtime.ts#L421)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.withTimeout](../apps/server/src/assistant/runtime.ts#L580)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.retrieveEvidence](../apps/server/src/assistant/runtime.ts#L604)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.readScopedCorrections](../apps/server/src/assistant/runtime.ts#L639)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.priorWorkingContext](../apps/server/src/assistant/runtime.ts#L667)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.enrichEvidence](../apps/server/src/assistant/runtime.ts#L682)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.isVisible](../apps/server/src/assistant/runtime.ts#L693)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.governCreateTask](../apps/server/src/assistant/runtime.ts#L715)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.toResult](../apps/server/src/assistant/runtime.ts#L876)
- [apps/server/src/assistant/runtime.ts · enqueued](../apps/server/src/assistant/runtime.ts#L209)
- [apps/server/src/assistant/runtime.ts · prior](../apps/server/src/assistant/runtime.ts#L219)
- [apps/server/src/assistant/runtime.ts · run](../apps/server/src/assistant/runtime.ts#L233)
- [apps/server/src/assistant/runtime.ts · priorTurns](../apps/server/src/assistant/runtime.ts#L433)
- [apps/server/src/assistant/runtime.ts · evidence](../apps/server/src/assistant/runtime.ts#L451)
- [apps/server/src/assistant/runtime.ts · trustedContext](../apps/server/src/assistant/runtime.ts#L456)
- [apps/server/src/assistant/runtime.ts · candidates](../apps/server/src/assistant/runtime.ts#L613)
- [apps/server/src/assistant/runtime.ts · intent](../apps/server/src/assistant/runtime.ts#L502)
- [apps/server/src/assistant/runtime.ts · cited](../apps/server/src/assistant/runtime.ts#L732)
- [apps/server/src/assistant/runtime.ts · contextCited](../apps/server/src/assistant/runtime.ts#L739)
- [apps/server/src/assistant/runtime.ts · rev](../apps/server/src/assistant/runtime.ts#L761)
- [apps/server/src/assistant/runtime.ts · result](../apps/server/src/assistant/runtime.ts#L803)
- [apps/server/src/assistant/runtime.ts · finalAnswer](../apps/server/src/assistant/runtime.ts#L536)
- [apps/server/src/assistant/runtime.ts · allowed](../apps/server/src/assistant/runtime.ts#L544)
- [apps/server/src/assistant/runtime.ts · citationIds](../apps/server/src/assistant/runtime.ts#L545)
- [apps/server/src/assistant/runtime.ts · selectedEvidence](../apps/server/src/assistant/runtime.ts#L548)
- [apps/server/src/assistant/runtime.ts · unfinished](../apps/server/src/assistant/runtime.ts#L348)
- [apps/server/src/assistant/runtime.ts · taskRejectedReason](../apps/server/src/assistant/runtime.ts#L505)
- [apps/server/src/assistant/runtime.ts · directEvidence](../apps/server/src/assistant/runtime.ts#L757)
- [apps/server/src/assistant/runtime.ts · extId](../apps/server/src/assistant/runtime.ts#L760)
- [apps/server/src/assistant/runtime.ts · allEvidence](../apps/server/src/assistant/runtime.ts#L793)
- [apps/server/src/assistant/runtime.ts · unavailable](../apps/server/src/assistant/runtime.ts#L481)
- [apps/server/src/assistant/runtime.ts · degraded](../apps/server/src/assistant/runtime.ts#L462)
- [apps/server/src/assistant/runtime.ts · row](../apps/server/src/assistant/runtime.ts#L284)
### apps/server/src/assistant

来源：人工整理；未执行模型语义复核。

- Owns one-turn execution for the personal assistant: accepts a user turn, scopes prior evidence, calls the model port, and governs create-task side effects.
- Surfaces ModelUnavailableError / TurnCancelledError explicitly instead of fabricating a model reply, and recovers in-flight turns on restart.

边界：

- Does not persist memory or decisions itself; it reads evidence and hands governed results to MemoryService.
- Does not call a local LLM directly: the model is a pluggable AssistantModelPort (Agent CLI/ACP first).

关键流程：

- **turn**：turn() enqueues the turn, wires cancellation, runs executeTurn, and reduces to a turn result.
- **intent**：detectTaskIntent classifies whether the user request asks for a task or is a consultation before governance.

限制与未决：

- No production model is wired in review mode; narrative here is curated, not model-generated.
- Call edges are name-level within one file; cross-file calls are not resolved.
- Actual model output quality, prompt coverage, and production task-governance decisions are undetermined without a live model run.

代码引用：

- [apps/server/src/assistant/runtime.ts · AssistantRuntime](../apps/server/src/assistant/runtime.ts#L168)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.turn](../apps/server/src/assistant/runtime.ts#L198)
- [apps/server/src/assistant/runtime.ts · ModelUnavailableError](../apps/server/src/assistant/runtime.ts#L45)
- [apps/server/src/assistant/runtime.ts · AssistantRuntime.executeTurn](../apps/server/src/assistant/runtime.ts#L421)
- [apps/server/src/assistant/runtime.ts · detectTaskIntent](../apps/server/src/assistant/runtime.ts#L144)
- [apps/server/src/assistant/acp-model.ts](../apps/server/src/assistant/acp-model.ts)
- [apps/server/src/assistant/default-model.ts](../apps/server/src/assistant/default-model.ts)
- [apps/server/src/assistant/runtime.ts](../apps/server/src/assistant/runtime.ts)

## code

### apps/server/src/code/sync.ts

来源：gpt-5.6-sol · 2026-09-29T10:56:56.345Z；通过结构与引用校验，未经独立语义复核。

- 将 Capture 链中当前 head revision 的受支持文件确定性解析为代码文件、符号、关系和文件级理解，并写入隔离的 Code Knowledge 投影表。
- 根据仓库标识、Git 提交、工作区脏状态及已捕获 revision 的排序内容哈希生成快照身份，使相同输入复用快照，并在每次同步时重新协调当前投影。
- 提供 CodeKnowledgePort 的查询与同步门面，向调用方暴露仓库、快照、文件、符号、边、图和理解查询。
- 把符号声明尽力绑定到 Capture head revision 的既有 fragment，而不从实时文件系统读取或保存文件正文。
- 同步结束后处理消失文件、陈旧边、陈旧模型理解、curated seed 投影和已生成理解恢复。

边界：

- 上游数据边界是 Store 中 namespace 为 file、external_id 以 omem: 开头且未标记 removed 的 Capture head revisions；源码字节通过 revisionText 读取。
- Git 仅提供 commit、remote、branch 和 dirty 元数据；Git 命令失败被折叠为 null，不会阻止同步。
- 语法分析委托给 parseFile；本模块负责筛选输入、建立稳定标识、解析有限的文件关系并持久化投影。
- 持久化边界由 code/store.ts、review/store.ts、understanding-store.ts 和 artifacts.ts 提供的函数及 Store 数据库承担。
- 导入解析只在本次已捕获文件集合内处理相对路径；非相对导入或无法命中的路径不会访问实时磁盘。
- 本模块不承担 AssistantRuntime、Lark 集成或 MemoryService 的运行职责；快照中相关规则只能说明相邻系统，不能证明这些系统参与代码同步。

关键流程：

- **查询门面**：CodeKnowledgeService 将当前快照、仓库、快照列表、文件、符号、关系、图和理解查询直接委托给存储层；sync 方法进入完整同步流程。
- **捕获输入装载与解析**：runCodeSync 初始化表和仓库记录，从 Capture head revisions 查询未移除文件，筛选 apps、packages、scripts 下的支持扩展名，读取不可变 revision 文本，计算哈希、大小并调用 parseFile。
- **快照识别与复用**：同步读取 Git 元数据，以仓库、commit、dirty 和捕获 revision 的排序内容哈希生成 snapId；已有同 id 快照被标记为 reused，但仍继续执行投影协调。
- **文件、符号与 fragment 投影**：事务中记录 snapshot-source 绑定，upsert 文件及 snapshot-file；每个解析符号获得稳定 id，并用声明行前 60 个字符在该文件 head revision 的 fragments 中寻找包含匹配，以填充 fragmentId。
- **关系和派生节点投影**：模块生成 confirmed 的 defines、可解析相对导入对应的 confirmed imports、不可解析导入对应的 missing imports、同文件名称级 candidate calls、confirmed route、confirmed test_of，以及未解析目标的 candidate uses_component。
- **失效、当前指针与恢复**：事务内将未出现在当前解析集合中的既有文件标记 removed；事务后根据 liveSeeds 失效旧边，将已移除文件及非当前快照的模型理解标记 stale，设置显式当前快照，再投影 curated seeds 并恢复生成理解。

限制与未决：

- sync 的 only 参数没有生效，因此调用方无法依靠该参数执行局部同步。
- Git 调用捕获所有错误并返回 null；Git 不可用、超时或命令失败不会显式传播，且 status 为 null 时 dirty 会成为 false。
- fragment 绑定采用声明行截断后的文本包含匹配；重复文本、格式差异或空声明可能导致错误匹配或 fragmentId 为空。
- 导入解析仅支持相对 specifier 和有限扩展候选，不解析包导入、路径别名或完整模块解析规则。
- 调用关系只按同文件名称映射，无法解析跨文件调用、类型、重载或可靠作用域，因此被标记为 candidate。
- Vue 组件使用关系不解析目标节点，只生成 candidate 边。
- 消失文件统一标记 removed，movedTo 始终为 null，因此不提供移动检测或跨 revision 身份续接。
- 快照的 changedCount 总是等于当前 files.length 且 partial 固定为 false，不能表达真实增量变化数量或局部扫描。
- 核心 upsert 位于事务中，但 stale 边处理、理解失效、当前指针、seed 投影和 artifact 恢复位于该事务之后；若尾部阶段失败，整体同步可能留下部分完成状态。
- 实现遵循从不可变 Capture revision 读取正文的边界；但仅凭该文件无法验证上游 Capture 数据是否完整、fragment 是否稳定，或所有存储函数是否具备预期约束。
- 快照未提供 code/store.ts 的实现，无法确认各 upsert、失效和查询函数的数据库约束、事务语义及并发行为。
- 快照未提供 parseFile 实现，无法验证符号、导入、调用、路由、测试和 Vue 组件抽取的完整语法覆盖范围。
- 快照未提供 snapshotIdFor、fileIdFor、symbolIdFor 的实现，无法验证稳定标识的具体编码、碰撞策略或跨版本兼容性。
- 无法仅凭该文件确认 code_snapshot_sources 表约束以及 INSERT OR IGNORE 在复用快照时是否可能保留与预期不同的既有行。
- 无法确认 projectCuratedSeeds 与 restoreGeneratedUnderstandings 的校验、覆盖和失败原子性。
- 无法确认上游 review sync 如何创建 fragments，以及文本包含匹配在真实 fragment 切分策略下的成功率。
- 没有提供关系边节点，因此不能引用调用图来证明本模块在服务器路由或应用启动过程中的实际装配位置。
- 无法从当前快照判断 runCodeSync 是否存在并发调用，以及并发同步时 current snapshot 指针和 stale 状态是否安全。

代码引用：

- [apps/server/src/code/sync.ts · execFileAsync](../apps/server/src/code/sync.ts#L59)
- [apps/server/src/code/sync.ts · git](../apps/server/src/code/sync.ts#L61)
- [apps/server/src/code/sync.ts · sha256](../apps/server/src/code/sync.ts#L73)
- [apps/server/src/code/sync.ts · resolveImport](../apps/server/src/code/sync.ts#L78)
- [apps/server/src/code/sync.ts · target](../apps/server/src/code/sync.ts#L293)
- [apps/server/src/code/sync.ts · base](../apps/server/src/code/sync.ts#L81)
- [apps/server/src/code/sync.ts · BoundFile](../apps/server/src/code/sync.ts#L85)
- [apps/server/src/code/sync.ts · bindFile](../apps/server/src/code/sync.ts#L87)
- [apps/server/src/code/sync.ts · sid](../apps/server/src/code/sync.ts#L253)
- [apps/server/src/code/sync.ts · pickFragment](../apps/server/src/code/sync.ts#L97)
- [apps/server/src/code/sync.ts · needle](../apps/server/src/code/sync.ts#L100)
- [apps/server/src/code/sync.ts · hit](../apps/server/src/code/sync.ts#L101)
- [apps/server/src/code/sync.ts · CodeKnowledgeService](../apps/server/src/code/sync.ts#L107)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.currentSnapshot](../apps/server/src/code/sync.ts#L113)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.listRepositories](../apps/server/src/code/sync.ts#L116)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.listSnapshots](../apps/server/src/code/sync.ts#L119)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.listFiles](../apps/server/src/code/sync.ts#L122)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.fileById](../apps/server/src/code/sync.ts#L125)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.symbolsOfFile](../apps/server/src/code/sync.ts#L128)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.symbolsOfSnapshot](../apps/server/src/code/sync.ts#L131)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.edgesOf](../apps/server/src/code/sync.ts#L134)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.graph](../apps/server/src/code/sync.ts#L140)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.understandingOf](../apps/server/src/code/sync.ts#L143)
- [apps/server/src/code/sync.ts · CodeKnowledgeService.sync](../apps/server/src/code/sync.ts#L147)
- [apps/server/src/code/sync.ts · runCodeSync](../apps/server/src/code/sync.ts#L152)
- [apps/server/src/code/sync.ts · repoId](../apps/server/src/code/sync.ts#L159)
- [apps/server/src/code/sync.ts · commit](../apps/server/src/code/sync.ts#L160)
- [apps/server/src/code/sync.ts · remote](../apps/server/src/code/sync.ts#L161)
- [apps/server/src/code/sync.ts · branch](../apps/server/src/code/sync.ts#L162)
- [apps/server/src/code/sync.ts · captured](../apps/server/src/code/sync.ts#L172)
- [apps/server/src/code/sync.ts · FileRec](../apps/server/src/code/sync.ts#L177)
- [apps/server/src/code/sync.ts · files](../apps/server/src/code/sync.ts#L178)
- [apps/server/src/code/sync.ts · text](../apps/server/src/code/sync.ts#L223)
- [apps/server/src/code/sync.ts · knownPaths](../apps/server/src/code/sync.ts#L186)
- [apps/server/src/code/sync.ts · status](../apps/server/src/code/sync.ts#L189)
- [apps/server/src/code/sync.ts · dirty](../apps/server/src/code/sync.ts#L190)
- [apps/server/src/code/sync.ts · snapId](../apps/server/src/code/sync.ts#L191)
- [apps/server/src/code/sync.ts · existing](../apps/server/src/code/sync.ts#L197)
- [apps/server/src/code/sync.ts · reused](../apps/server/src/code/sync.ts#L214)
- [apps/server/src/code/sync.ts · liveSeeds](../apps/server/src/code/sync.ts#L218)
- [apps/server/src/code/sync.ts · fileId](../apps/server/src/code/sync.ts#L228)
- [apps/server/src/code/sync.ts · bf](../apps/server/src/code/sync.ts#L229)
- [apps/server/src/code/sync.ts · localQNames](../apps/server/src/code/sync.ts#L251)
- [apps/server/src/code/sync.ts · declLine](../apps/server/src/code/sync.ts#L254)
- [apps/server/src/code/sync.ts · toSym](../apps/server/src/code/sync.ts#L314)
- [apps/server/src/code/sync.ts · seed](../apps/server/src/code/sync.ts#L402)
- [apps/server/src/code/sync.ts · toFile](../apps/server/src/code/sync.ts#L294)
- [apps/server/src/code/sync.ts · fromSym](../apps/server/src/code/sync.ts#L313)
- [apps/server/src/code/sync.ts · qname](../apps/server/src/code/sync.ts#L367)
- [apps/server/src/code/sync.ts · rid](../apps/server/src/code/sync.ts#L335)
- [apps/server/src/code/sync.ts · tid](../apps/server/src/code/sync.ts#L368)
- [apps/server/src/code/sync.ts · compSym](../apps/server/src/code/sync.ts#L400)
- [apps/server/src/code/sync.ts · known](../apps/server/src/code/sync.ts#L436)
- [apps/server/src/code/sync.ts · existingRows](../apps/server/src/code/sync.ts#L437)
- [apps/server/src/code/sync.ts · stale](../apps/server/src/code/sync.ts#L457)
- [apps/server/src/code/sync.ts · restored](../apps/server/src/code/sync.ts#L472)
- [apps/server/src/code/artifacts.ts](../apps/server/src/code/artifacts.ts)
- [apps/server/src/code/budget.ts](../apps/server/src/code/budget.ts)
- [apps/server/src/code/dto.ts](../apps/server/src/code/dto.ts)
- [apps/server/src/code/parse.ts](../apps/server/src/code/parse.ts)
- [apps/server/src/code/store.ts](../apps/server/src/code/store.ts)
- [apps/server/src/code/sync.ts](../apps/server/src/code/sync.ts)
- [apps/server/src/code/understanding-model.ts](../apps/server/src/code/understanding-model.ts)
- [apps/server/src/code/understanding-store.ts](../apps/server/src/code/understanding-store.ts)

## contracts

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [packages/contracts/src/code-modules.ts](../packages/contracts/src/code-modules.ts)
- [packages/contracts/src/index.ts](../packages/contracts/src/index.ts)

## conversation

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/conversation/router.ts](../apps/server/src/conversation/router.ts)

## inputs

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/inputs/aggregator.ts](../apps/server/src/inputs/aggregator.ts)
- [apps/server/src/inputs/spool.ts](../apps/server/src/inputs/spool.ts)

## jobs

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/jobs/repository.ts](../apps/server/src/jobs/repository.ts)
- [apps/server/src/jobs/worker.ts](../apps/server/src/jobs/worker.ts)

## lark

### apps/server/src/integrations/lark

来源：人工整理；未执行模型语义复核。

- Owns the long-running Lark host loop: syncs connection state, processes due turns, and recovers unfinished assistant turns.
- Binds chat visibility policy and hands inbound conversations to the AssistantRuntime.

边界：

- Does not itself parse webhook events (that is realtime.ts) or deliver cards (delivery.ts).
- Read in review mode only: it is not started by the review app and needs credentials.

关键流程：

- **host-loop**：start() launches loop(); processOnce() runs syncConnections and then processes due turns.

限制与未决：

- Requires Lark app credentials and network; review mode never starts this host.
- Connection sync state is persisted externally and not modeled as raw graph here.
- Real webhook traffic, token refresh and retry behavior are not exercised offline.

代码引用：

- [apps/server/src/integrations/lark/runtime.ts · LarkRuntimeHost](../apps/server/src/integrations/lark/runtime.ts#L35)
- [apps/server/src/integrations/lark/runtime.ts · LarkRuntimeHost.syncConnections](../apps/server/src/integrations/lark/runtime.ts#L117)
- [apps/server/src/integrations/lark/runtime.ts · LarkRuntimeHost.processOnce](../apps/server/src/integrations/lark/runtime.ts#L193)
- [apps/server/src/integrations/lark/card-actions.ts](../apps/server/src/integrations/lark/card-actions.ts)
- [apps/server/src/integrations/lark/defaults.ts](../apps/server/src/integrations/lark/defaults.ts)
- [apps/server/src/integrations/lark/delivery.ts](../apps/server/src/integrations/lark/delivery.ts)
- [apps/server/src/integrations/lark/existing-apps.ts](../apps/server/src/integrations/lark/existing-apps.ts)
- [apps/server/src/integrations/lark/onboarding.ts](../apps/server/src/integrations/lark/onboarding.ts)
- [apps/server/src/integrations/lark/realtime.ts](../apps/server/src/integrations/lark/realtime.ts)
- [apps/server/src/integrations/lark/registration.ts](../apps/server/src/integrations/lark/registration.ts)
- [apps/server/src/integrations/lark/runtime.ts](../apps/server/src/integrations/lark/runtime.ts)
- [apps/server/src/integrations/lark/secret-store.ts](../apps/server/src/integrations/lark/secret-store.ts)

## learning

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/learning/pipeline.ts](../apps/server/src/learning/pipeline.ts)
- [apps/server/src/learning/refresh.ts](../apps/server/src/learning/refresh.ts)

## memory

### apps/server/src/memory/service.ts

来源：gpt-5.6-sol · 2026-09-29T11:05:25.692Z；通过结构与引用校验，未经独立语义复核。

- 该模块实现记忆提案的治理与落库协调：解析提案和评估输入、持久化提案及证据读取快照、验证证据、计算影响范围、选择治理结果，并在允许时调用 Store 的应用接口生成记忆或任务修订。
- 该模块负责新建 claim 与现有活跃知识之间的确定性匹配，区分同源重复、独立来源等价和具有相反谓词极性的冲突，并持久化等价关系或争议记录。
- 该模块实现 AttentionGate：只有影响超限或触及当前任务、活跃知识的跨来源冲突才创建待用户裁决的决策；证据错误、噪声、低价值不确定性及未经验证的他人任务分别进入拒绝、忽略、延后或仅保留来源等内部状态。
- 该模块实现批量 ChangeSet 的去重影响预算，以受影响记忆并集和新实体键并集计算总影响，并把原本会自动应用的提案统一停放后创建一个批量决策。
- 该模块负责决策执行、来源读取的新鲜度检查、历史记忆恢复，以及提案、决策、记忆和等价关系的查询视图。
- 同文件中的 FeedbackService 负责反馈事件幂等记录、约束强度分级、已确认约束召回，以及在任务提案进入后续治理前改写已确认的任务负责人。

边界：

- 输入合同边界由 proposalSchema、proposalAssessmentInputSchema、decisionActionSchema 和 feedbackInputSchema 的 parse 调用承担；本模块不接受未经合同解析的数据直接进入核心流程。
- 持久化边界是注入的 Store 及其 SQLite 数据库：本模块直接维护 proposals、evidence_assessments、policy_evaluations、decisions、knowledge_disputes、memory_equivalences、feedback 等治理表，但把正式记忆和任务的应用交给 Store.applications。
- 证据边界由 Store.evidence、Store.revision、Store.fragments 和 Store.asset 提供；本模块验证引用与当前材料的一致性，但不负责采集、切分或检索材料。
- AssistantRuntime 的声明设计把 MemoryService 定位为服务器强制执行的低风险治理工具；模型调用、上下文组装和可见性过滤检索属于 AssistantRuntime 及其端口，而非本模块。
- Lark 是显式外部集成边界：MemoryService 只在已有活跃连接、绑定和决策目标时写入卡片动作及 delivery_intents，不在此处建立连接或直接发送网络请求。
- FeedbackService 与 MemoryService 位于同一文件但流程松耦合；前者可以返回修正后的任务提案，后者并未在 evaluate 或 evaluateBatch 内自动调用该修正步骤。

关键流程：

- **单提案治理**：evaluate 先用合同解析输入，再进入 evaluateCore。核心流程计算内部影响、幂等持久化提案、复用已有应用回执、验证和记录证据评估、执行新建 claim 匹配、计算治理策略并持久化状态；最终可能拒绝、内部保留、创建决策，或通过 Store 应用记忆/任务。
- **证据快照与陈旧性保护**：persistProposal 在证据引用可解析且来源修订匹配时记录 source_id、source_revision_id 和 validity_epoch。应用或处理决策前，assertCurrentReads 比较当前 head 与 epoch；变化会产生 STALE_DECISION，避免基于旧材料应用。
- **新建 claim 的知识匹配**：对证据有效的新建 claim，detectCreateMatch 仅查询同 workspace、同 project 的活跃 claim。规范化文本完全相同且来源重叠时判为重复；文本相同但来源独立时判为等价；评估 reason_code 为 contradicts_existing 时，按有效期重叠、实体词交集和相反极性选择得分最高的冲突候选。
- **重复、等价与冲突分流**：冲突会写入 knowledge_disputes、把提案标记为 disputed 并 defer_until_use；独立来源等价项通常应用为新的活跃记忆并写入可查询的 memory_equivalences；同源重复不新建第二条活跃记忆，而将提案保留。
- **治理策略与 AttentionGate**：policy 汇总语义评估、证据类型、负责人来源、时间歧义、procedure 类型、跨来源更新和影响预算等原因。无效证据或语义矛盾直接拒绝；噪声忽略；只有影响超限，或跨来源更新同时触及活跃目标或阻塞当前任务时升级为 awaiting_decision；其余问题按规则延后或仅保留来源。
- **单提案决策与通知意图**：createDecision 固化来源和目标预期版本、七天有效期及结构化 AttentionCase；如果数据库中存在活跃 Lark 决策目标，还会生成一次性 nonce 的卡片动作、通知记录和待投递意图。实际外发由邻接的 Lark 运行时和投递工作者承担。
- **批量影响门控**：evaluateBatch 解析全部条目，合并更新所触及的活跃记忆 ID，并以 workspace、project 和实体内容生成新建项去重键。总影响超过 maxAutoApply 时，evaluateCore 将原本可自动应用的项标记为 batchDeferred，最后 createBatchDecision 创建单个批量 AttentionCase。
- **用户决策执行**：decide 校验动作合同、摘要、负责人、requestId 幂等性、状态和过期时间，随后再次检查来源读取是否仍为当前版本。拒绝或请求背景只更新决策和提案状态；批准则通过 apply 生成正式修订，并原子更新决策状态。
- **历史记忆恢复**：restoreMemory 校验当前版本、目标历史修订及其依赖状态，然后以相同 memoryId 应用一个新的 active 修订；恢复不覆盖历史记录，并在应用前再次检查依赖是否陈旧。
- **反馈约束学习**：FeedbackService.record 以 workspace、producer 和 eventId 做事件幂等，校验证据与行为者来源后把反馈分成 confirmed、weak 或 shadow，并写入反馈及约束。recall 只返回作用域完全匹配、active 且 confirmed 的约束；applyConfirmedCorrections 目前只将 task_assignment 约束应用到任务 owner_id。

限制与未决：

- 批量决策只以第一条停放提案的 digest 关联 decisions；当前 decide 路径重建并应用该单个提案，没有读取 attention_case.batchProposalDigests 并整体应用全部停放提案，因此“整体按提案应用”的批量选项与实际批准路径之间存在实现缺口。
- evaluateBatch 的总体 outcome 只区分是否门控且是否存在 parked 项；当所有逐项结果均为 reject、ignore、defer 或 retain 时仍可能返回 auto_apply，调用方必须查看 results 才能获得真实逐项状态。
- 新建 claim 的冲突发现是确定性词项和极性启发式：英文按 token、中文按去停用字符后的二元组，并用有限否定正则判断极性；它可能漏掉同义表达、复杂否定和无需显式否定词的互斥事实。
- 冲突匹配仅在 assessment.reason_code 等于 contradicts_existing 时启动；本模块不会自行通过语义推理发现所有冲突。
- 跨文件或外部检索语义不属于此模块；提供的检索文档显示邻接检索器使用另一套 tokenize 规则，本模块的 contentTokens 是独立实现，两者的词项行为可能不同。
- 证据验证只检查引用、文本选择器或图片资产是否一致；语义支持度来自外部 assessment。本模块虽然持久化评估，却不运行模型或外部验证器。
- 代码注释和实现已经执行一部分自动证据校验与政策判定，而规则材料仍声明“第一基础尚未自动化提案验证”；该规则可能是较早的能力描述，不能据此否定快照中的已实现行为。
- 同一文件同时承载记忆治理、决策通知编排和反馈约束，职责跨度较大，并直接依赖多张 SQLite 表的字段约定。
- Lark 决策创建依赖数据库中预先存在的活跃连接、绑定与目标；没有目标时仍会创建决策，但不会产生外部通知意图。
- FeedbackService 只激活证据有效、行为者已验证、producerKind 为 original 且不是弱反馈的约束；涉及 ACL、权限、预算或自动批准的建议始终进入 shadow，不会自动生效。
- applyConfirmedCorrections 只支持 task_assignment 对 owner_id 的顺序改写；其他已确认约束类型虽然可被 recall 返回，但在该方法中不会改变提案。
- 模块按 workspace 和部分 project 条件隔离匹配与影响计算，但快照没有提供数据库约束、认证入口或完整租户执行链，无法据此证明多租户安全隔离。
- procedure 在普通自动应用路径中被策略保留为来源，apply 也禁止未经 owner 批准的 procedure；只有决策批准路径显式传入 approvedByOwner=true。
- 快照未提供调用 evaluate、evaluateBatch、decide、restoreMemory 和 FeedbackService 的路由或运行时代码节点，无法确定所有实际调用者及其认证层。
- 快照未提供 Store、applications.applyMemory、applications.applyTask 和 tx 的实现，无法验证跨治理表与正式实体表的完整事务范围、通知生成细节及数据库约束。
- 快照没有提供 schema 定义的完整字段约束，无法列出 Proposal、Assessment、DecisionAction 和 FeedbackInput 的所有可接受形态。
- 没有提供数据库 migration 或索引，无法确认 workspace 隔离是否有数据库级约束、各幂等查询是否受唯一索引保护，以及动态 IN 查询的规模上限。
- 没有提供批量决策的其他处理器；虽然本文件的 decide 只应用代表提案，但无法排除快照之外存在专门批量批准入口。
- 没有提供 delivery worker 的具体实现，无法确认卡片发送重试、卡片消费、nonce 校验和聚合行为。
- 没有测试证据，无法判断本快照中各错误分支、并发决策、批量门控和冲突启发式的实际覆盖程度。
- 未提供 snapshot digest、prompt_digest、schema_digest 或模型标识；按最终输出合同未生成 seal 或其他 provenance 字段。
- 没有关系 edge ID，因此本理解只能引用文件内 symbol node 和给定 evidence，不能陈述静态调用图边。
- review app、Lark 事件规范化和 Code Wiki 启动材料与目标模块没有足够直接联系，未据此扩展本模块职责。

代码引用：

- [apps/server/src/memory/service.ts · MemoryService](../apps/server/src/memory/service.ts#L74)
- [apps/server/src/memory/service.ts · MemoryService.constructor](../apps/server/src/memory/service.ts#L75)
- [apps/server/src/memory/service.ts · AssessmentInput](../apps/server/src/memory/service.ts#L14)
- [apps/server/src/memory/service.ts · KnowledgeMatch](../apps/server/src/memory/service.ts#L24)
- [apps/server/src/memory/service.ts · EvaluationResult](../apps/server/src/memory/service.ts#L43)
- [apps/server/src/memory/service.ts · occurrences](../apps/server/src/memory/service.ts#L63)
- [apps/server/src/memory/service.ts · MemoryService.transaction](../apps/server/src/memory/service.ts#L88)
- [apps/server/src/memory/service.ts · MemoryService.proposalRow](../apps/server/src/memory/service.ts#L92)
- [apps/server/src/memory/service.ts · MemoryService.proposalView](../apps/server/src/memory/service.ts#L98)
- [apps/server/src/memory/service.ts · MemoryService.persistProposal](../apps/server/src/memory/service.ts#L135)
- [apps/server/src/memory/service.ts · MemoryService.validateEvidence](../apps/server/src/memory/service.ts#L201)
- [apps/server/src/memory/service.ts · MemoryService.sourceReads](../apps/server/src/memory/service.ts#L255)
- [apps/server/src/memory/service.ts · MemoryService.assertCurrentReads](../apps/server/src/memory/service.ts#L267)
- [apps/server/src/memory/service.ts · MemoryService.evidenceDependencies](../apps/server/src/memory/service.ts#L276)
- [apps/server/src/memory/service.ts · MemoryService.actorIsVerifiedOwner](../apps/server/src/memory/service.ts#L284)
- [apps/server/src/memory/service.ts · MemoryService.hasCrossSourceUpdate](../apps/server/src/memory/service.ts#L302)
- [apps/server/src/memory/service.ts · MemoryService.normalizeStatement](../apps/server/src/memory/service.ts#L348)
- [apps/server/src/memory/service.ts · MemoryService.contentTokens](../apps/server/src/memory/service.ts#L358)
- [apps/server/src/memory/service.ts · MemoryService.isNegativePolarity](../apps/server/src/memory/service.ts#L374)
- [apps/server/src/memory/service.ts · MemoryService.memoryEvidenceRefs](../apps/server/src/memory/service.ts#L379)
- [apps/server/src/memory/service.ts · MemoryService.sameProject](../apps/server/src/memory/service.ts#L392)
- [apps/server/src/memory/service.ts · MemoryService.timesOverlap](../apps/server/src/memory/service.ts#L404)
- [apps/server/src/memory/service.ts · MemoryService.detectCreateMatch](../apps/server/src/memory/service.ts#L423)
- [apps/server/src/memory/service.ts · MemoryService.affectedMemoryIds](../apps/server/src/memory/service.ts#L543)
- [apps/server/src/memory/service.ts · MemoryService.computeInternalImpact](../apps/server/src/memory/service.ts#L573)
- [apps/server/src/memory/service.ts · MemoryService.newEntityKey](../apps/server/src/memory/service.ts#L585)
- [apps/server/src/memory/service.ts · MemoryService.recordDispute](../apps/server/src/memory/service.ts#L597)
- [apps/server/src/memory/service.ts · MemoryService.recordEquivalence](../apps/server/src/memory/service.ts#L646)
- [apps/server/src/memory/service.ts · MemoryService.equivalencesOf](../apps/server/src/memory/service.ts#L685)
- [apps/server/src/memory/service.ts · MemoryService.policy](../apps/server/src/memory/service.ts#L712)
- [apps/server/src/memory/service.ts · MemoryService.persistAssessment](../apps/server/src/memory/service.ts#L812)
- [apps/server/src/memory/service.ts · MemoryService.persistPolicy](../apps/server/src/memory/service.ts#L843)
- [apps/server/src/memory/service.ts · MemoryService.createDecision](../apps/server/src/memory/service.ts#L892)
- [apps/server/src/memory/service.ts · MemoryService.apply](../apps/server/src/memory/service.ts#L1141)
- [apps/server/src/memory/service.ts · MemoryService.evaluate](../apps/server/src/memory/service.ts#L1245)
- [apps/server/src/memory/service.ts · MemoryService.evaluateCore](../apps/server/src/memory/service.ts#L1266)
- [apps/server/src/memory/service.ts · MemoryService.targetIsActiveKnowledge](../apps/server/src/memory/service.ts#L1395)
- [apps/server/src/memory/service.ts · MemoryService.evaluateBatch](../apps/server/src/memory/service.ts#L1425)
- [apps/server/src/memory/service.ts · MemoryService.createBatchDecision](../apps/server/src/memory/service.ts#L1491)
- [apps/server/src/memory/service.ts · MemoryService.handleCreateMatch](../apps/server/src/memory/service.ts#L1562)
- [apps/server/src/memory/service.ts · MemoryService.decide](../apps/server/src/memory/service.ts#L1660)
- [apps/server/src/memory/service.ts · MemoryService.restoreMemory](../apps/server/src/memory/service.ts#L1752)
- [apps/server/src/memory/service.ts · MemoryService.proposals](../apps/server/src/memory/service.ts#L1818)
- [apps/server/src/memory/service.ts · MemoryService.proposal](../apps/server/src/memory/service.ts#L1826)
- [apps/server/src/memory/service.ts · MemoryService.decisions](../apps/server/src/memory/service.ts#L1831)
- [apps/server/src/memory/service.ts · MemoryService.memories](../apps/server/src/memory/service.ts#L1862)
- [apps/server/src/memory/service.ts · assessments](../apps/server/src/memory/service.ts#L99)
- [apps/server/src/memory/service.ts · byId](../apps/server/src/memory/service.ts#L138)
- [apps/server/src/memory/service.ts · byDigest](../apps/server/src/memory/service.ts#L140)
- [apps/server/src/memory/service.ts · evidenceRecord](../apps/server/src/memory/service.ts#L173)
- [apps/server/src/memory/service.ts · record](../apps/server/src/memory/service.ts#L205)
- [apps/server/src/memory/service.ts · selected](../apps/server/src/memory/service.ts#L218)
- [apps/server/src/memory/service.ts · locations](../apps/server/src/memory/service.ts#L227)
- [apps/server/src/memory/service.ts · image](../apps/server/src/memory/service.ts#L239)
- [apps/server/src/memory/service.ts · ownerId](../apps/server/src/memory/service.ts#L285)
- [apps/server/src/memory/service.ts · provenance](../apps/server/src/memory/service.ts#L290)
- [apps/server/src/memory/service.ts · principal](../apps/server/src/memory/service.ts#L293)
- [apps/server/src/memory/service.ts · priorSources](../apps/server/src/memory/service.ts#L313)
- [apps/server/src/memory/service.ts · nextSources](../apps/server/src/memory/service.ts#L322)
- [apps/server/src/memory/service.ts · stop](../apps/server/src/memory/service.ts#L363)
- [apps/server/src/memory/service.ts · chars](../apps/server/src/memory/service.ts#L366)
- [apps/server/src/memory/service.ts · exact](../apps/server/src/memory/service.ts#L470)
- [apps/server/src/memory/service.ts · duplicate](../apps/server/src/memory/service.ts#L474)
- [apps/server/src/memory/service.ts · best](../apps/server/src/memory/service.ts#L494)
- [apps/server/src/memory/service.ts · touched](../apps/server/src/memory/service.ts#L544)
- [apps/server/src/memory/service.ts · targetSources](../apps/server/src/memory/service.ts#L553)
- [apps/server/src/memory/service.ts · scope](../apps/server/src/memory/service.ts#L587)
- [apps/server/src/memory/service.ts · impactEscalates](../apps/server/src/memory/service.ts#L772)
- [apps/server/src/memory/service.ts · crossSourceEscalates](../apps/server/src/memory/service.ts#L773)
- [apps/server/src/memory/service.ts · softUncertainty](../apps/server/src/memory/service.ts#L801)
- [apps/server/src/memory/service.ts · policyVersion](../apps/server/src/memory/service.ts#L850)
- [apps/server/src/memory/service.ts · stateFor](../apps/server/src/memory/service.ts#L868)
- [apps/server/src/memory/service.ts · sources](../apps/server/src/memory/service.ts#L905)
- [apps/server/src/memory/service.ts · expectedVersions](../apps/server/src/memory/service.ts#L914)
- [apps/server/src/memory/service.ts · expiresAt](../apps/server/src/memory/service.ts#L1519)
- [apps/server/src/memory/service.ts · attentionCase](../apps/server/src/memory/service.ts#L1521)
- [apps/server/src/memory/service.ts · targets](../apps/server/src/memory/service.ts#L970)
- [apps/server/src/memory/service.ts · cardActionId](../apps/server/src/memory/service.ts#L1002)
- [apps/server/src/memory/service.ts · nonce](../apps/server/src/memory/service.ts#L1003)
- [apps/server/src/memory/service.ts · nonceHash](../apps/server/src/memory/service.ts#L1004)
- [apps/server/src/memory/service.ts · commonValue](../apps/server/src/memory/service.ts#L1005)
- [apps/server/src/memory/service.ts · button](../apps/server/src/memory/service.ts#L1013)
- [apps/server/src/memory/service.ts · card](../apps/server/src/memory/service.ts#L1023)
- [apps/server/src/memory/service.ts · payloadJson](../apps/server/src/memory/service.ts#L1065)
- [apps/server/src/memory/service.ts · intent](../apps/server/src/memory/service.ts#L1119)
- [apps/server/src/memory/service.ts · metadata](../apps/server/src/memory/service.ts#L1147)
- [apps/server/src/memory/service.ts · hooks](../apps/server/src/memory/service.ts#L1163)
- [apps/server/src/memory/service.ts · current](../apps/server/src/memory/service.ts#L1167)
- [apps/server/src/memory/service.ts · updated](../apps/server/src/memory/service.ts#L1188)
- [apps/server/src/memory/service.ts · assessment](../apps/server/src/memory/service.ts#L1254)
- [apps/server/src/memory/service.ts · existingReceipt](../apps/server/src/memory/service.ts#L1282)
- [apps/server/src/memory/service.ts · batchDeferred](../apps/server/src/memory/service.ts#L1348)
- [apps/server/src/memory/service.ts · memoryIds](../apps/server/src/memory/service.ts#L1446)
- [apps/server/src/memory/service.ts · memoryIds](../apps/server/src/memory/service.ts#L1446)
- [apps/server/src/memory/service.ts · entityKeys](../apps/server/src/memory/service.ts#L1447)
- [apps/server/src/memory/service.ts · totalImpact](../apps/server/src/memory/service.ts#L1453)
- [apps/server/src/memory/service.ts · gated](../apps/server/src/memory/service.ts#L1454)
- [apps/server/src/memory/service.ts · parked](../apps/server/src/memory/service.ts#L1460)
- [apps/server/src/memory/service.ts · representative](../apps/server/src/memory/service.ts#L1493)
- [apps/server/src/memory/service.ts · proposalDigests](../apps/server/src/memory/service.ts#L1495)
- [apps/server/src/memory/service.ts · anchorDigest](../apps/server/src/memory/service.ts#L1512)
- [apps/server/src/memory/service.ts · action](../apps/server/src/memory/service.ts#L1661)
- [apps/server/src/memory/service.ts · decision](../apps/server/src/memory/service.ts#L1662)
- [apps/server/src/memory/service.ts · proposalRow](../apps/server/src/memory/service.ts#L1685)
- [apps/server/src/memory/service.ts · receipt](../apps/server/src/memory/service.ts#L1743)
- [apps/server/src/memory/service.ts · memory](../apps/server/src/memory/service.ts#L1758)
- [apps/server/src/memory/service.ts · target](../apps/server/src/memory/service.ts#L1764)
- [apps/server/src/memory/service.ts · dependencies](../apps/server/src/memory/service.ts#L1768)
- [apps/server/src/memory/service.ts · stale](../apps/server/src/memory/service.ts#L1806)
- [apps/server/src/memory/service.ts · FeedbackService](../apps/server/src/memory/service.ts#L1869)
- [apps/server/src/memory/service.ts · FeedbackService.record](../apps/server/src/memory/service.ts#L1872)
- [apps/server/src/memory/service.ts · FeedbackService.recall](../apps/server/src/memory/service.ts#L1957)
- [apps/server/src/memory/service.ts · FeedbackService.applyConfirmedCorrections](../apps/server/src/memory/service.ts#L1968)
- [apps/server/src/memory/service.ts · payloadDigest](../apps/server/src/memory/service.ts#L1874)
- [apps/server/src/memory/service.ts · existing](../apps/server/src/memory/service.ts#L1876)
- [apps/server/src/memory/service.ts · protectedPolicy](../apps/server/src/memory/service.ts#L1889)
- [apps/server/src/memory/service.ts · evidenceValid](../apps/server/src/memory/service.ts#L1892)
- [apps/server/src/memory/service.ts · confirmed](../apps/server/src/memory/service.ts#L1895)
- [apps/server/src/memory/service.ts · weak](../apps/server/src/memory/service.ts#L1899)
- [apps/server/src/memory/service.ts · strength](../apps/server/src/memory/service.ts#L1900)
- [apps/server/src/memory/service.ts · constraints](../apps/server/src/memory/service.ts#L1971)
- [apps/server/src/memory/service.ts · owner](../apps/server/src/memory/service.ts#L1972)
- [apps/server/src/memory/service.ts · applied](../apps/server/src/memory/service.ts#L1973)
### apps/server/src/memory

来源：人工整理；未执行模型语义复核。

- Validates evidence and assesses proposed statements against existing knowledge, then applies or gates decisions deterministically.
- Owns proposals, assessments, decisions, disputes and equivalences as immutable revisions keyed by content digest.

边界：

- Does not call a model; all policy decisions (create/update/dispute/escalate) are code.
- Does not capture raw sources itself; it consumes fragments/evidence refs supplied by callers.

关键流程：

- **evaluate**：evaluateCore scores a proposal against active knowledge and applies the deterministic policy.
- **persist-decision**：createDecision writes an immutable decision row and its receipts.

限制与未决：

- Proposal matching is token/overlap based, not semantic; ambiguous matches are escalated, not auto-applied.
- Curated narrative only; confidence is intentionally <=0.1.
- Real decision distribution and edge-case policy outcomes are not exercised here.

代码引用：

- [apps/server/src/memory/service.ts · MemoryService](../apps/server/src/memory/service.ts#L74)
- [apps/server/src/memory/service.ts · MemoryService.evaluateCore](../apps/server/src/memory/service.ts#L1266)
- [apps/server/src/memory/service.ts · MemoryService.validateEvidence](../apps/server/src/memory/service.ts#L201)
- [apps/server/src/memory/service.ts · MemoryService.createDecision](../apps/server/src/memory/service.ts#L892)
- [apps/server/src/memory/service.ts](../apps/server/src/memory/service.ts)

## other

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/tests/acp-model.test.ts](../apps/server/tests/acp-model.test.ts)
- [apps/server/tests/agents.test.ts](../apps/server/tests/agents.test.ts)
- [apps/server/tests/annotation-cancel-delivery.test.ts](../apps/server/tests/annotation-cancel-delivery.test.ts)
- [apps/server/tests/app.test.ts](../apps/server/tests/app.test.ts)
- [apps/server/tests/assistant-runtime.test.ts](../apps/server/tests/assistant-runtime.test.ts)
- [apps/server/tests/attention-gate.test.ts](../apps/server/tests/attention-gate.test.ts)
- [apps/server/tests/batch2-fixes.test.ts](../apps/server/tests/batch2-fixes.test.ts)
- [apps/server/tests/code-artifacts.test.ts](../apps/server/tests/code-artifacts.test.ts)
- [apps/server/tests/code-budget.test.ts](../apps/server/tests/code-budget.test.ts)
- [apps/server/tests/code-knowledge-dto.test.ts](../apps/server/tests/code-knowledge-dto.test.ts)
- [apps/server/tests/code-knowledge-migration.test.ts](../apps/server/tests/code-knowledge-migration.test.ts)
- [apps/server/tests/code-knowledge-snapshot.test.ts](../apps/server/tests/code-knowledge-snapshot.test.ts)
- [apps/server/tests/code-knowledge.test.ts](../apps/server/tests/code-knowledge.test.ts)
- [apps/server/tests/code-understanding-integration.test.ts](../apps/server/tests/code-understanding-integration.test.ts)
- [apps/server/tests/code-understanding-model.test.ts](../apps/server/tests/code-understanding-model.test.ts)
- [apps/server/tests/code-understanding.test.ts](../apps/server/tests/code-understanding.test.ts)
- [apps/server/tests/connectors.test.ts](../apps/server/tests/connectors.test.ts)
- [apps/server/tests/contracts.test.ts](../apps/server/tests/contracts.test.ts)
- [apps/server/tests/conversation-router.test.ts](../apps/server/tests/conversation-router.test.ts)
- [apps/server/tests/conversation-security.test.ts](../apps/server/tests/conversation-security.test.ts)
- [apps/server/tests/dev-ports.test.ts](../apps/server/tests/dev-ports.test.ts)
- [apps/server/tests/import-quality-isolation.test.ts](../apps/server/tests/import-quality-isolation.test.ts)
- [apps/server/tests/inputs.test.ts](../apps/server/tests/inputs.test.ts)
- [apps/server/tests/jobs.test.ts](../apps/server/tests/jobs.test.ts)
- [apps/server/tests/lark-delivery-recovery.test.ts](../apps/server/tests/lark-delivery-recovery.test.ts)
- [apps/server/tests/lark-delivery.test.ts](../apps/server/tests/lark-delivery.test.ts)
- [apps/server/tests/lark-onboarding.test.ts](../apps/server/tests/lark-onboarding.test.ts)
- [apps/server/tests/lark-realtime.test.ts](../apps/server/tests/lark-realtime.test.ts)
- [apps/server/tests/lark-rich-parts.test.ts](../apps/server/tests/lark-rich-parts.test.ts)
- [apps/server/tests/lark-runtime.test.ts](../apps/server/tests/lark-runtime.test.ts)
- [apps/server/tests/learning-pipeline.test.ts](../apps/server/tests/learning-pipeline.test.ts)
- [apps/server/tests/learning-refresh.test.ts](../apps/server/tests/learning-refresh.test.ts)
- [apps/server/tests/migrations.test.ts](../apps/server/tests/migrations.test.ts)
- [apps/server/tests/proposal-policy.test.ts](../apps/server/tests/proposal-policy.test.ts)
- [apps/server/tests/quality-annotation.test.ts](../apps/server/tests/quality-annotation.test.ts)
- [apps/server/tests/quality-evaluation.test.ts](../apps/server/tests/quality-evaluation.test.ts)
- [apps/server/tests/retrieval-keyword.test.ts](../apps/server/tests/retrieval-keyword.test.ts)
- [apps/server/tests/retrieval-source-profile.test.ts](../apps/server/tests/retrieval-source-profile.test.ts)
- [apps/server/tests/review-dev.test.ts](../apps/server/tests/review-dev.test.ts)
- [apps/server/tests/review-migration.test.ts](../apps/server/tests/review-migration.test.ts)
- [apps/server/tests/review-relations.test.ts](../apps/server/tests/review-relations.test.ts)
- [apps/server/tests/review-runtime-seed.test.ts](../apps/server/tests/review-runtime-seed.test.ts)
- [apps/server/tests/review-sync.test.ts](../apps/server/tests/review-sync.test.ts)
- [apps/server/tests/role-runtime.test.ts](../apps/server/tests/role-runtime.test.ts)
- [apps/server/tests/store.test.ts](../apps/server/tests/store.test.ts)

## quality

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/quality/evaluator.ts](../apps/server/src/quality/evaluator.ts)
- [apps/server/src/quality/import.ts](../apps/server/src/quality/import.ts)
- [apps/server/src/quality/lark-annotations.ts](../apps/server/src/quality/lark-annotations.ts)
- [apps/server/src/quality/repository.ts](../apps/server/src/quality/repository.ts)

## retrieval

### apps/server/src/retrieval/keyword.ts

来源：gpt-5.6-sol · 2026-09-29T10:54:17.615Z；通过结构与引用校验，未经独立语义复核。

- 实现 RetrievalPort 的 SQLite 关键词检索基线，为固定证据片段和已应用记忆提供健康检查、证据读取、来源检索与记忆检索。
- 将中英文查询拆分为可匹配词项，对中文连续文本额外生成去除常见停用组合的二元组，并据命中词项长度计算相关性分数。
- 把数据库记录映射为带摘要、来源修订标识和来源信息的候选结果；该模块只读取检索数据，不负责模型调用、记忆写入或外部集成。

边界：

- 上游边界是 RetrievalPort 合同及其 SearchQuery、RetrievalHealth、EvidenceFragment、SourceCandidate、MemoryCandidate 等数据类型；KeywordRetrieval 通过构造函数接收 DatabaseSync。
- 下游边界是 SQLite 中的 fragments、revisions、sources、memories 和 memory_revisions 表；模块直接执行同步 SQL 查询。
- 与助手运行时的边界是只读证据检索：AssistantRuntime 声明负责上下文组装并通过 RetrievalPort 获取可见证据，而模型端口独立注入。
- 与 MemoryService 的边界是只读取 active 记忆及其头修订，不执行治理动作或记忆变更。
- 与未来语义检索的边界是维持同一检索接口，但当前实现刻意不依赖嵌入模型或第三方检索引擎。
- 来源检索当前没有可信项目关联可供过滤，因此返回工作区范围结果；记忆检索仅在查询明确携带可信项目标记、且记忆自身声明不同项目时排除该记忆。

关键流程：

- **读取固定证据**：调用方提供修订标识，并可选提供片段标识；实现按修订与片段精确查询，未指定片段时按 ordinal 读取首个片段，随后映射为 EvidenceFragment，无记录时返回 null。
- **检索来源片段**：查询先被分词并限制返回数量；每个词项通过转义后的 LIKE 子串查询当前 source head 所连接的修订片段，每个片段按不同命中词项累计长度权重，最终按分数降序截断并生成摘要与来源信息。
- **检索已激活记忆**：实现读取 active 记忆及其头修订，安全解析 scope，在可信项目条件成立时应用项目排除规则，再把记忆正文序列化后做不区分大小写的词项包含匹配，排序、截断并映射为 MemoryCandidate。
- **中英文查询分词**：输入按空白与常见中英文标点切块；ASCII 词转为小写并去重，中文连续串保留全文，同时生成相邻二元组并过滤常见停用二元组。
- **生成命中摘要**：正文先压平空白，再寻找分词结果中的首个可见命中；命中时截取其附近文本并在前方被截断时添加省略号，未命中时返回开头固定窗口。

限制与未决：

- 来源检索没有应用项目过滤，因为片段上尚无持久化且可信的项目关联；在多项目工作区中可能返回跨项目候选。
- 每个来源词项的 SQL 查询最多读取 200 行，最终全局排序之前已经发生单词项截断，可能遗漏本应进入高分组合的片段。
- 关键词方案只做子串匹配和启发式长度计分，不提供语义相似度、嵌入召回或重排能力。
- 来源 SQL 只连接 sources.head 对应的修订，因此 searchSources 面向当前来源头；readEvidence 则可按给定 revisionId 读取固定修订，两者覆盖范围不同。
- 记忆项目过滤仅排除具有字符串 project_id 且与可信查询项目不同的记忆；无项目关联、scope 无法解析或项目字段非字符串的记忆仍保持工作区可见。
- 记忆正文通过 JSON.stringify 转成检索文本，匹配可能覆盖结构键和序列化标点，摘要也可能呈现序列化 JSON，而不是专门的人类可读正文。
- 分数只统计每个不同词项一次；多个候选同分时没有显式次级排序规则。
- health 固定报告可用，代码中没有执行数据库探测，因此它表达的是后端实现已配置，而非数据库查询已经成功验证。
- 中文二元组停用表是固定枚举，未覆盖的高频组合仍可能扩大召回，命中全文词项与二元组也可能同时累计分数。
- 快照没有给出 RetrievalPort 的完整定义、数据库模式约束、调用方传入 project_trusted 的建立过程或实际运行测试，因此这些合同与运行保证无法进一步确认。
- 快照未提供 RetrievalPort、SearchQuery 和各候选 DTO 的完整定义，无法确认接口层面的全部可见性前置条件与字段不变量。
- 快照未提供数据库建表语句、索引、排序规则或 SQLite LIKE 配置，无法确认查询性能及所有 Unicode 大小写行为。
- 快照未说明 project_trusted 由哪个组件建立、如何验证，也未展示未来 ContextLink 表的具体合同。
- 快照未包含该模块的单元测试或运行结果，无法确认边界输入、同分排序及异常传播的已验证行为。
- 快照未展示 KeywordRetrieval 的实例化位置，无法确认生产环境数据库生命周期、错误处理方式和具体调用频率。
- 快照未说明 source head 之外的历史修订是否应由 searchSources 检索；只能确认当前 SQL 不会从该路径召回它们。

代码引用：

- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval](../apps/server/src/retrieval/keyword.ts#L20)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.constructor](../apps/server/src/retrieval/keyword.ts#L21)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.health](../apps/server/src/retrieval/keyword.ts#L23)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.readEvidence](../apps/server/src/retrieval/keyword.ts#L27)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.searchSources](../apps/server/src/retrieval/keyword.ts#L51)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.searchFragmentsForTerm](../apps/server/src/retrieval/keyword.ts#L97)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.searchMemories](../apps/server/src/retrieval/keyword.ts#L114)
- [apps/server/src/retrieval/keyword.ts · row](../apps/server/src/retrieval/keyword.ts#L31)
- [apps/server/src/retrieval/keyword.ts · limit](../apps/server/src/retrieval/keyword.ts#L115)
- [apps/server/src/retrieval/keyword.ts · best](../apps/server/src/retrieval/keyword.ts#L55)
- [apps/server/src/retrieval/keyword.ts · rows](../apps/server/src/retrieval/keyword.ts#L118)
- [apps/server/src/retrieval/keyword.ts · id](../apps/server/src/retrieval/keyword.ts#L67)
- [apps/server/src/retrieval/keyword.ts · current](../apps/server/src/retrieval/keyword.ts#L68)
- [apps/server/src/retrieval/keyword.ts · escaped](../apps/server/src/retrieval/keyword.ts#L98)
- [apps/server/src/retrieval/keyword.ts · scored](../apps/server/src/retrieval/keyword.ts#L126)
- [apps/server/src/retrieval/keyword.ts · scope](../apps/server/src/retrieval/keyword.ts#L128)
- [apps/server/src/retrieval/keyword.ts · bodyText](../apps/server/src/retrieval/keyword.ts#L140)
- [apps/server/src/retrieval/keyword.ts · score](../apps/server/src/retrieval/keyword.ts#L141)
- [apps/server/src/retrieval/keyword.ts · safeJson](../apps/server/src/retrieval/keyword.ts#L170)
- [apps/server/src/retrieval/keyword.ts · tokenize](../apps/server/src/retrieval/keyword.ts#L184)
- [apps/server/src/retrieval/keyword.ts · ascii](../apps/server/src/retrieval/keyword.ts#L188)
- [apps/server/src/retrieval/keyword.ts · cjk](../apps/server/src/retrieval/keyword.ts#L190)
- [apps/server/src/retrieval/keyword.ts · cleaned](../apps/server/src/retrieval/keyword.ts#L198)
- [apps/server/src/retrieval/keyword.ts · gram](../apps/server/src/retrieval/keyword.ts#L201)
- [apps/server/src/retrieval/keyword.ts · STOP_BIGRAMS](../apps/server/src/retrieval/keyword.ts#L212)
- [apps/server/src/retrieval/keyword.ts · snippetFor](../apps/server/src/retrieval/keyword.ts#L220)
- [apps/server/src/retrieval/keyword.ts · flat](../apps/server/src/retrieval/keyword.ts#L221)
- [apps/server/src/retrieval/keyword.ts · hit](../apps/server/src/retrieval/keyword.ts#L223)
- [apps/server/src/retrieval/keyword.ts · start](../apps/server/src/retrieval/keyword.ts#L227)
### apps/server/src/retrieval

来源：人工整理；未执行模型语义复核。

- Performs offline keyword/bi-gram retrieval over captured fragments and memories with per-term scoring and snippets.
- Tokenizes both ASCII words and CJK, and is the only retrieval backend used in review mode (no embeddings).

边界：

- No embeddings / vector search; matching is literal LIKE after tokenization.
- Read-only over the review DB; it never writes memory rows.

关键流程：

- **search**：searchSources tokenizes the query, ORs per-term fragment matches, and ranks by term weight.

限制与未决：

- Per-term LIMIT and top-N are callers' responsibility; this module cannot rank across categories.
- Literal tokenization misses synonyms and semantic similarity.
- Recall/precision on the real corpus is not measured here.

代码引用：

- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval](../apps/server/src/retrieval/keyword.ts#L20)
- [apps/server/src/retrieval/keyword.ts · tokenize](../apps/server/src/retrieval/keyword.ts#L184)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.searchFragmentsForTerm](../apps/server/src/retrieval/keyword.ts#L97)
- [apps/server/src/retrieval/keyword.ts · KeywordRetrieval.searchSources](../apps/server/src/retrieval/keyword.ts#L51)
- [apps/server/src/retrieval/keyword.ts](../apps/server/src/retrieval/keyword.ts)
- [apps/server/src/retrieval/port.ts](../apps/server/src/retrieval/port.ts)

## review

### apps/server/src/review/sync.ts

来源：gpt-5.6-sol · 2026-09-29T10:57:51.118Z；通过结构与引用校验，未经独立语义复核。

- 把仓库白名单内的文本文件增量同步为按路径标识的来源、不可变修订与稳定分片。
- 记录同步时的 HEAD、工作树脏状态、内容摘要、失败项、告警和基线状态。
- 根据人工维护的关联种子构建代码、实现意图、需求、决策、调研与测试之间的评审关系。
- 协调已删除、恢复、重命名及虚拟派生来源的元数据状态。

边界：

- 上游输入边界是仓库根目录、Store 实例、可选同步路径及磁盘上的人工关联种子。
- 文件读取限制在固定扫描根和根级白名单中，并排除内部状态、依赖、构建产物、环境配置、测试夹具、符号链接、非 UTF-8 与超大文件。
- 版本变化检测依赖 Git 子进程；Git 查询失败时退化为全量扫描，并阻止基线推进。
- 持久化边界由 Store 的捕获、数据库查询和评审关系写入，以及运行时同步状态文件组成。
- 本模块只把材料作为捕获数据解析和存储，不承担助手模型调用、外部通知或业务 worker 的职责。

关键流程：

- **候选发现与分类**：遍历固定目录和根级文件白名单，过滤排除项与不安全链接，再把可接受路径分类为架构、进度、决策或调研材料。
- **增量目标计算**：读取 HEAD、历史基线和上次脏状态，合并工作树状态与提交间差异；首次运行、基线失效、旧捕获格式、Git 失败或上次脏同步会触发全量扫描。
- **单文件捕获**：校验路径和文件内容，按内容摘要跳过未变化修订，按代码声明、测试用例或 Markdown 标题切分文本，补充快照上下文后调用 Store 捕获。
- **来源状态协调**：扫描已有路径来源，依据文件存在性设置 removed 状态，为重命名旧来源设置 movedTo，并持续修复虚拟派生来源的误删除标记。
- **人工关联投影**：把每条人工关联种子捕获为独立实现意图片段，定位代码符号和证据锚点，写入 implements、requires、decided_by、researched_by、tested_by 关系；无法解析的端点保留为 missing，移除的种子转为失效状态。
- **结果与基线提交**：汇总捕获与关系统计；脏工作树或文件失败时不推进提交基线，但仍写入同步结果元数据。

限制与未决：

- 符号定位是基于正则与最早匹配片段的启发式过程，无法保证理解 TypeScript 语法、重载、同名符号或跨文件调用。
- 普通引用锚点使用片段文本包含匹配；缺少锚点时选择首片段，因此定位精度依赖人工种子的质量。
- 需求定位仅搜索两个硬编码文档，并拒绝只出现在共享概览表中的需求编号。
- 单文件读取、捕获和关系构建未在该快照中显示统一事务；中途异常可能留下部分更新。
- only 模式绕过 Git 增量逻辑、来源协调、关系重建和磁盘同步状态更新，因此不代表完整仓库同步。
- 关系构建异常只转为告警，主同步仍可返回结果；调用者必须检查 warnings 才能识别投影不完整。
- 内容相同只通过当前 head 的 verbatim-v1 内容摘要判定不变；上下文时间变化不会单独产生新修订。
- Store.capture、setSourceMeta、upsertReviewRelation 与 invalidateRemovedSeeds 的事务边界和失败回滚语义未包含在快照中。
- loadAssociations 与 parseRef 对关联种子的结构校验、路径规范化和错误处理细节未包含在快照中。
- runReviewSync 的具体 HTTP、CLI 或定时调用方及并发互斥策略未包含在快照中。
- review_relations 的唯一约束、空端点存储方式及 stale 的读取时派生规则未包含在快照中。
- 分片固定 ID 的具体生成算法和 Store 对超长 parts 的进一步处理未包含在快照中。
- Git rename 检测是否依赖调用前的仓库配置或额外参数，以及复制状态的完整行为，没有从该快照得到验证。
- 同步状态写入与数据库写入之间是否存在跨介质原子性保障未知。

代码引用：

- [apps/server/src/review/sync.ts · collectCandidates](../apps/server/src/review/sync.ts#L193)
- [apps/server/src/review/sync.ts · walk](../apps/server/src/review/sync.ts#L172)
- [apps/server/src/review/sync.ts · classify](../apps/server/src/review/sync.ts#L126)
- [apps/server/src/review/sync.ts · isExcluded](../apps/server/src/review/sync.ts#L117)
- [apps/server/src/review/sync.ts · isUnsafeLink](../apps/server/src/review/sync.ts#L154)
- [apps/server/src/review/sync.ts · runReviewSync](../apps/server/src/review/sync.ts#L838)
- [apps/server/src/review/sync.ts · git](../apps/server/src/review/sync.ts#L268)
- [apps/server/src/review/sync.ts · parsePorcelain](../apps/server/src/review/sync.ts#L287)
- [apps/server/src/review/sync.ts · readLastCommit](../apps/server/src/review/sync.ts#L327)
- [apps/server/src/review/sync.ts · readPrevDirty](../apps/server/src/review/sync.ts#L337)
- [apps/server/src/review/sync.ts · captureOne](../apps/server/src/review/sync.ts#L427)
- [apps/server/src/review/sync.ts · headContentHash](../apps/server/src/review/sync.ts#L409)
- [apps/server/src/review/sync.ts · splitByBoundary](../apps/server/src/review/sync.ts#L234)
- [apps/server/src/review/sync.ts · splitCodeFragments](../apps/server/src/review/sync.ts#L226)
- [apps/server/src/review/sync.ts · splitMarkdownFragments](../apps/server/src/review/sync.ts#L230)
- [apps/server/src/review/sync.ts · extractSymbols](../apps/server/src/review/sync.ts#L251)
- [apps/server/src/review/sync.ts · extractDecisionDate](../apps/server/src/review/sync.ts#L404)
- [apps/server/src/review/sync.ts · reconcileSources](../apps/server/src/review/sync.ts#L515)
- [apps/server/src/review/sync.ts · VIRTUAL_SOURCE_PREFIX](../apps/server/src/review/sync.ts#L513)
- [apps/server/src/review/sync.ts · buildReviewRelations](../apps/server/src/review/sync.ts#L709)
- [apps/server/src/review/sync.ts · assocSeedId](../apps/server/src/review/sync.ts#L692)
- [apps/server/src/review/sync.ts · headFragments](../apps/server/src/review/sync.ts#L566)
- [apps/server/src/review/sync.ts · matchSymbolFragment](../apps/server/src/review/sync.ts#L583)
- [apps/server/src/review/sync.ts · resolveRef](../apps/server/src/review/sync.ts#L607)
- [apps/server/src/review/sync.ts · resolveRequirementFragment](../apps/server/src/review/sync.ts#L655)
- [apps/server/src/review/sync.ts · edge](../apps/server/src/review/sync.ts#L796)
- [apps/server/src/review/sync.ts · persistState](../apps/server/src/review/sync.ts#L348)
- [apps/server/src/review/sync.ts · SyncResult](../apps/server/src/review/sync.ts#L60)
- [apps/server/src/review/sync.ts · SCAN_ROOTS](../apps/server/src/review/sync.ts#L96)
- [apps/server/src/review/sync.ts · ROOT_FILES](../apps/server/src/review/sync.ts#L99)
- [apps/server/src/review/sync.ts · EXCLUDED_DIR_SEGMENTS](../apps/server/src/review/sync.ts#L107)
- [apps/server/src/review/sync.ts · ReviewCategory](../apps/server/src/review/sync.ts#L47)
- [apps/server/src/review/sync.ts · MAX_FILE_BYTES](../apps/server/src/review/sync.ts#L115)
- [apps/server/src/review/sync.ts · recordFailed](../apps/server/src/review/sync.ts#L858)
- [apps/server/src/review/sync.ts · digest](../apps/server/src/review/sync.ts#L460)
- [apps/server/src/review/sync.ts · externalId](../apps/server/src/review/sync.ts#L461)
- [apps/server/src/review/sync.ts · CODE_BOUNDARY](../apps/server/src/review/sync.ts#L215)
- [apps/server/src/review/sync.ts · TEST_BOUNDARY](../apps/server/src/review/sync.ts#L220)
- [apps/server/src/review/sync.ts · context](../apps/server/src/review/sync.ts#L479)
- [apps/server/src/review/sync.ts · Snapshot](../apps/server/src/review/sync.ts#L399)
- [apps/server/src/review/sync.ts · GitOutcome](../apps/server/src/review/sync.ts#L266)
- [apps/server/src/review/sync.ts · status](../apps/server/src/review/sync.ts#L892)
- [apps/server/src/review/sync.ts · diff](../apps/server/src/review/sync.ts#L934)
- [apps/server/src/review/sync.ts · advanceBaseline](../apps/server/src/review/sync.ts#L865)
- [apps/server/src/review/sync.ts · prevDirty](../apps/server/src/review/sync.ts#L886)
- [apps/server/src/review/sync.ts · sid](../apps/server/src/review/sync.ts#L542)
- [apps/server/src/review/sync.ts · seeds](../apps/server/src/review/sync.ts#L714)
- [apps/server/src/review/sync.ts · INTENT_INDEX_EXTERNAL_ID](../apps/server/src/review/sync.ts#L686)
- [apps/server/src/review/sync.ts · declRe](../apps/server/src/review/sync.ts#L588)
- [apps/server/src/review/sync.ts · methodRe](../apps/server/src/review/sync.ts#L594)
- [apps/server/src/review/sync.ts · tokenRe](../apps/server/src/review/sync.ts#L598)
- [apps/server/src/review/sync.ts · fragmentAnchoredTo](../apps/server/src/review/sync.ts#L633)
- [apps/server/src/review/sync.ts · REQUIREMENT_ID](../apps/server/src/review/sync.ts#L631)
- [apps/server/src/review/sync.ts · effective](../apps/server/src/review/sync.ts#L805)
- [apps/server/src/review/sync.ts · SyncOptions](../apps/server/src/review/sync.ts#L73)
- [apps/server/src/review/sync.ts · normalized](../apps/server/src/review/sync.ts#L870)
- [apps/server/src/review/sync.ts · relations](../apps/server/src/review/sync.ts#L992)
- [apps/server/src/review/sync.ts · categoryName](../apps/server/src/review/sync.ts#L88)
- [apps/server/src/review/sync.ts · readSyncStatus](../apps/server/src/review/sync.ts#L356)
- [apps/server/src/review/app.ts](../apps/server/src/review/app.ts)
- [apps/server/src/review/associations.ts](../apps/server/src/review/associations.ts)
- [apps/server/src/review/main.ts](../apps/server/src/review/main.ts)
- [apps/server/src/review/model-config.ts](../apps/server/src/review/model-config.ts)
- [apps/server/src/review/store.ts](../apps/server/src/review/store.ts)
- [apps/server/src/review/sync.ts](../apps/server/src/review/sync.ts)

## scripts

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [scripts/browser-smoke.ts](../scripts/browser-smoke.ts)
- [scripts/code-wiki-viewport.ts](../scripts/code-wiki-viewport.ts)
- [scripts/dev-ports.ts](../scripts/dev-ports.ts)
- [scripts/dev-review-vite.ts](../scripts/dev-review-vite.ts)
- [scripts/dev-review.ts](../scripts/dev-review.ts)
- [scripts/dev.ts](../scripts/dev.ts)
- [scripts/live-acp-smoke.ts](../scripts/live-acp-smoke.ts)
- [scripts/live-connectors-smoke.ts](../scripts/live-connectors-smoke.ts)
- [scripts/live-lark-host-smoke.ts](../scripts/live-lark-host-smoke.ts)
- [scripts/live-learning-smoke.ts](../scripts/live-learning-smoke.ts)
- [scripts/live-model.ts](../scripts/live-model.ts)
- [scripts/live-pipeline-smoke.ts](../scripts/live-pipeline-smoke.ts)
- [scripts/live-role-smoke.ts](../scripts/live-role-smoke.ts)
- [scripts/quality-evaluate.ts](../scripts/quality-evaluate.ts)
- [scripts/quality-lark-annotate.ts](../scripts/quality-lark-annotate.ts)
- [scripts/quality-run.ts](../scripts/quality-run.ts)
- [scripts/review-wiki.ts](../scripts/review-wiki.ts)

## server-root

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/agents.ts](../apps/server/src/agents.ts)
- [apps/server/src/app.ts](../apps/server/src/app.ts)
- [apps/server/src/cli.ts](../apps/server/src/cli.ts)
- [apps/server/src/config.ts](../apps/server/src/config.ts)
- [apps/server/src/connectors.ts](../apps/server/src/connectors.ts)
- [apps/server/src/hook-forward.ts](../apps/server/src/hook-forward.ts)
- [apps/server/src/main.ts](../apps/server/src/main.ts)
- [apps/server/src/runs.ts](../apps/server/src/runs.ts)
- [apps/server/src/source-text.ts](../apps/server/src/source-text.ts)
- [apps/server/src/store.ts](../apps/server/src/store.ts)

## source-profile

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/source-profile/service.ts](../apps/server/src/source-profile/service.ts)

## storage

暂无经过来源校验的模块说明，以下为确定性文件目录。

- [apps/server/src/storage/digest.ts](../apps/server/src/storage/digest.ts)
- [apps/server/src/storage/migrations.ts](../apps/server/src/storage/migrations.ts)
- [apps/server/src/storage/repository.ts](../apps/server/src/storage/repository.ts)

## ui

### packages/ui/src/components/OmCodeViewer.vue

来源：gpt-5.6-sol · 2026-09-29T10:58:44.056Z；通过结构与引用校验，未经独立语义复核。

- 将传入的源码文本按行展示，并提供带稳定行号的数据锚点。
- 异步生成整份源码的语法高亮结果；高亮失败或尚未完成时使用转义后的原始文本。
- 根据指定行号或范围呈现命中状态、锚点闪烁和范围提示。
- 在锚点变化后滚动到对应行，并在用户点击属于某个范围的代码行时发出导航事件。

边界：

- 输入边界是组件属性：源码、语言、起始行号、锚点行、额外高亮行和范围标记。
- 语法处理委托给外部的 highlightCode、highlightedLines 和 escapeCode；本模块只管理异步结果及渲染状态。
- 导航边界是 navigate 事件；本模块仅输出被点击的行号，不负责路由、文件解析或符号解析。
- DOM 交互局限于组件根元素内按 data-line 查找目标行并滚动。

关键流程：

- **源码分行与编号**：源码按换行符拆分，显示行号由可选起始行号加零基索引计算；每一行同时获得对应的 data-line 锚点。
- **异步语法高亮**：源码或语言变化时清空旧结果并进入加载状态，异步高亮整份文本后按行保存 HTML；代际计数阻止较旧请求覆盖较新的结果，失败时保留空高亮映射。
- **锚点定位与反馈**：锚点行变化且值有效时，组件等待 DOM 更新，开启三秒闪烁状态，在根元素内查找对应 data-line 行并将其滚动到视口中央。
- **范围命中与行导航**：组件以首个覆盖当前行的范围作为命中范围；只有点击命中范围的代码单元格时才发出包含行号的 navigate 事件。

限制与未决：

- 范围查找对每一行使用顺序 find；范围较多或文件较大时，渲染成本可能随行数与范围数的乘积增长。
- 重叠范围只采用数组中的首个匹配项，组件没有冲突合并或优先级规则。
- navigate 类型允许 filePath 和 symbol，但当前点击流程只提供 line，跨文件或符号导航必须由上层补充。
- 锚点值为 0 时会被视为无效；组件实际行号通常从 1 开始，但未显式校验 startLine。
- 闪烁复位计时器未被记录或取消；锚点快速变化时，较早的计时器可能提前清除较新的闪烁状态。
- 语法高亮异常被静默降级为空映射，没有向上层暴露错误原因。
- 代码单元格使用 v-html，因此安全性依赖外部高亮函数返回可信或已转义的 HTML；当前快照未提供该函数的实现合同。
- 范围的 id 和 kind 在当前组件逻辑中未参与渲染或导航。
- 快照未提供 ../highlight 的实现，无法确认高亮 HTML 的转义与安全保证。
- 快照未提供父组件，无法确认 navigate 事件如何转换为文件、符号或路由导航。
- 快照未提供范围数据生产方，无法确认 ranges 是否可能重叠、乱序或包含无效行号。
- 快照未提供组件测试，无法确认超大文件、快速属性切换和卸载后的计时器行为。
- 所列规则和文档证据涉及助手运行时、检索、Lark、存储及 review 应用边界，与该源码查看组件没有可验证的直接关系，因此未用于架构结论。

代码引用：

- [packages/ui/src/components/OmCodeViewer.vue · CodeRangeMark](../packages/ui/src/components/OmCodeViewer.vue#L6)
- [packages/ui/src/components/OmCodeViewer.vue · props](../packages/ui/src/components/OmCodeViewer.vue#L14)
- [packages/ui/src/components/OmCodeViewer.vue · emit](../packages/ui/src/components/OmCodeViewer.vue#L23)
- [packages/ui/src/components/OmCodeViewer.vue · hl](../packages/ui/src/components/OmCodeViewer.vue#L27)
- [packages/ui/src/components/OmCodeViewer.vue · loading](../packages/ui/src/components/OmCodeViewer.vue#L28)
- [packages/ui/src/components/OmCodeViewer.vue · root](../packages/ui/src/components/OmCodeViewer.vue#L29)
- [packages/ui/src/components/OmCodeViewer.vue · flashed](../packages/ui/src/components/OmCodeViewer.vue#L30)
- [packages/ui/src/components/OmCodeViewer.vue · lines](../packages/ui/src/components/OmCodeViewer.vue#L32)
- [packages/ui/src/components/OmCodeViewer.vue · lineNumber](../packages/ui/src/components/OmCodeViewer.vue#L33)
- [packages/ui/src/components/OmCodeViewer.vue · generation](../packages/ui/src/components/OmCodeViewer.vue#L34)
- [packages/ui/src/components/OmCodeViewer.vue · current](../packages/ui/src/components/OmCodeViewer.vue#L36)
- [packages/ui/src/components/OmCodeViewer.vue · rows](../packages/ui/src/components/OmCodeViewer.vue#L40)
- [packages/ui/src/components/OmCodeViewer.vue · el](../packages/ui/src/components/OmCodeViewer.vue#L56)
- [packages/ui/src/components/OmCodeViewer.vue · isHighlighted](../packages/ui/src/components/OmCodeViewer.vue#L62)
- [packages/ui/src/components/OmCodeViewer.vue · rangeForLine](../packages/ui/src/components/OmCodeViewer.vue#L66)
- [packages/ui/src/components/OmCodeViewer.vue · onLineClick](../packages/ui/src/components/OmCodeViewer.vue#L70)
- [packages/ui/src/components/OmCodeViewer.vue · r](../packages/ui/src/components/OmCodeViewer.vue#L71)
- [packages/ui/package.json](../packages/ui/package.json)
- [packages/ui/src/OmHashRoute.ts](../packages/ui/src/OmHashRoute.ts)
- [packages/ui/src/components/OmBadge.vue](../packages/ui/src/components/OmBadge.vue)
- [packages/ui/src/components/OmButton.vue](../packages/ui/src/components/OmButton.vue)
- [packages/ui/src/components/OmCitation.vue](../packages/ui/src/components/OmCitation.vue)
- [packages/ui/src/components/OmCodeViewer.vue](../packages/ui/src/components/OmCodeViewer.vue)
- [packages/ui/src/components/OmDialog.vue](../packages/ui/src/components/OmDialog.vue)
- [packages/ui/src/components/OmEmpty.vue](../packages/ui/src/components/OmEmpty.vue)
- [packages/ui/src/components/OmIcon.vue](../packages/ui/src/components/OmIcon.vue)
- [packages/ui/src/components/OmMarkdown.vue](../packages/ui/src/components/OmMarkdown.vue)
- [packages/ui/src/components/OmPanel.vue](../packages/ui/src/components/OmPanel.vue)
- [packages/ui/src/components/OmRelationGraph.vue](../packages/ui/src/components/OmRelationGraph.vue)
- [packages/ui/src/components/OmShell.vue](../packages/ui/src/components/OmShell.vue)
- [packages/ui/src/components/OmStatusLine.vue](../packages/ui/src/components/OmStatusLine.vue)
- [packages/ui/src/components/OmTrailDrawer.vue](../packages/ui/src/components/OmTrailDrawer.vue)
- [packages/ui/src/highlight.test.ts](../packages/ui/src/highlight.test.ts)
- [packages/ui/src/highlight.ts](../packages/ui/src/highlight.ts)
- [packages/ui/src/index.ts](../packages/ui/src/index.ts)
- [packages/ui/src/trail.ts](../packages/ui/src/trail.ts)

## web

### apps/web/src

来源：人工整理；未执行模型语义复核。

- Single-file Vue SFC front-end for the review knowledge base: loads categories/sources, opens revisions and fragments, runs search and relation tracing.
- Boot detects /api/review/health and switches the app into review mode; it owns no business state.

边界：

- Pure presentation: every read goes through review-api.ts to the loopback review API.
- Never talks to Lark, the personal-assistant runtime or external services.

关键流程：

- **boot**：boot() refreshes health, loads categories and sources on mount.
- **search-trace**：runSearch queries the API; runTrace follows a fragment's relation graph.

限制与未决：

- The component symbol itself is not modeled by the code-understanding snapshot (component kind); only <script setup> functions are cited.
- No automated browser check in this slice; UI rendering is not asserted.
- Real layout, empty states and relation-trace UX are not verified here.

代码引用：

- [apps/web/src/ReviewApp.vue · boot](../apps/web/src/ReviewApp.vue#L390)
- [apps/web/src/ReviewApp.vue · runSearch](../apps/web/src/ReviewApp.vue#L290)
- [apps/web/src/ReviewApp.vue · openRevision](../apps/web/src/ReviewApp.vue#L219)
- [apps/web/src/ReviewApp.vue · runTrace](../apps/web/src/ReviewApp.vue#L319)
- [apps/web/package.json](../apps/web/package.json)
- [apps/web/src/App.vue](../apps/web/src/App.vue)
- [apps/web/src/AssetImage.vue](../apps/web/src/AssetImage.vue)
- [apps/web/src/ChatPane.vue](../apps/web/src/ChatPane.vue)
- [apps/web/src/DecisionsView.vue](../apps/web/src/DecisionsView.vue)
- [apps/web/src/EvidenceReader.vue](../apps/web/src/EvidenceReader.vue)
- [apps/web/src/LarkSetup.vue](../apps/web/src/LarkSetup.vue)
- [apps/web/src/LearningView.vue](../apps/web/src/LearningView.vue)
- [apps/web/src/NotificationDetail.vue](../apps/web/src/NotificationDetail.vue)
- [apps/web/src/ReviewApp.vue](../apps/web/src/ReviewApp.vue)
- [apps/web/src/api.ts](../apps/web/src/api.ts)
- [apps/web/src/codewiki/CodeWiki.vue](../apps/web/src/codewiki/CodeWiki.vue)
- [apps/web/src/codewiki/FileFrame.vue](../apps/web/src/codewiki/FileFrame.vue)
- [apps/web/src/codewiki/FragmentFrame.vue](../apps/web/src/codewiki/FragmentFrame.vue)
- [apps/web/src/codewiki/ModuleFrame.vue](../apps/web/src/codewiki/ModuleFrame.vue)
- [apps/web/src/codewiki/SymbolFrame.vue](../apps/web/src/codewiki/SymbolFrame.vue)
- [apps/web/src/codewiki/edges.test.ts](../apps/web/src/codewiki/edges.test.ts)
- [apps/web/src/codewiki/hashroute.test.ts](../apps/web/src/codewiki/hashroute.test.ts)
- [apps/web/src/codewiki/labels.test.ts](../apps/web/src/codewiki/labels.test.ts)
- [apps/web/src/codewiki/modules.test.ts](../apps/web/src/codewiki/modules.test.ts)
- [apps/web/src/codewiki/modules.ts](../apps/web/src/codewiki/modules.ts)
- [apps/web/src/codewiki/trail.test.ts](../apps/web/src/codewiki/trail.test.ts)
- [apps/web/src/main.ts](../apps/web/src/main.ts)
- [apps/web/src/review-api.ts](../apps/web/src/review-api.ts)
- [apps/web/tsconfig.json](../apps/web/tsconfig.json)
- [apps/web/vite.config.ts](../apps/web/vite.config.ts)
