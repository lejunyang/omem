# 调研：如何最大化复用，同时掌握自治记忆的核心

新增研究（2026-09-26）：[MemPalace 源码、公开结果复算与接入选择](research/mempalace/README.md)。在 CLI/ACP 优先的阶段，先验证其无生成式 LLM 本地检索 sidecar；不把下文早期 WeKnora/Hindsight 首选解释为已经完成生产选型。

> 实施更新（2026-09-26）：用户已确认个人助理、服务器/本地运行、Vue 和 CLI/ACP 优先。当前已实现能力见 [实施状态](implementation/status.md)，已确认需求见 [决策记录](decisions.md)，视觉规范见 [根 design.md](../design.md)。下文为第一轮架构/原型设计，不等于当前运行代码。

日期：2026-09-26。研究方法：完整读取两份用户提供的文档正文，检查旧库的关键契约和 HTML 原型；通过官方仓库固定 17 个 commit，阅读 README、许可证，并深入检查 WeKnora 的 Go 类型/HTTP handler 与 Hindsight 的 OpenAPI。详见 [核验索引](research/source-index.md) 和 [机器可读来源](research/sources.json)。**本轮是资料和源码核验，没有部署这些引擎，也没有复现其性能基准。**

## 1. 结论

推荐 omem 采用“统一证据与记忆内核 + 可替换检索/学习引擎”。WeKnora 是文档检索复用的首选 PoC，Hindsight 是经历巩固的首选 PoC；通过同一套验收再决定生产启用。若 WeKnora 的片段映射与部署成本不达标，切换 Docling/LlamaIndex + pgvector；数据模型与 UI 不改变。

不建议直接 fork 一个完整 RAG 产品，也不建议手写解析器、向量库、图数据库或任务队列。真正需要掌握的是材料和知识之间的版本化引用、知识变更的语义、自治风险策略、结果验证和外部 Agent 协议。

## 2. 对既有方案的取舍

| 参考方案中的观点 | 本次处理 | 原因 |
| --- | --- | --- |
| 自研治理、复用通用能力 | 保留 | 需求核心与组件通用能力边界清晰 |
| 记忆与材料检索并列 | 保留 | 任务经历、方法、偏好不能只靠文档问答表达 |
| 默认自动治理、风险项再问 | 保留 | 避免所有材料长期停在待审态 |
| Event Sourcing 替代审批即可任意精确回滚 | 修正 | 事件记录不自动具备事务、依赖重算和外部副作用恢复；用 ChangeSet+乐观并发+补偿事件 |
| 命中/点赞直接提高事实置信度 | 修正 | 热门错误会自我放大；utility 与 evidence/authority 分离 |
| LLM 直接决定 ADD/UPDATE/DELETE | 修正 | 让它提议；内核按类型/证据/影响范围执行。删除旧观点通常是 supersede/retract，不硬删证据 |
| 每次查询所有框架并交 LLM 排序 | 修正 | 增大延迟和费用；按问题路由、最多两条主要引擎，先 RRF+reranker，复杂情况才反思 |
| Knowledge 存在各 adapter | 修正 | 一份权威记录；各 adapter 返回 ID、证据候选和投影状态 |
| Semantic related 可当 references | 修正 | 显式链接与模型推断必须分类型；否则无法解释引用依据 |
| kind 全部换成自动 tag | 修正 | 保留少量类型决定更新/权限/评估规则；tag 负责导航 |
| 主流框架均 Apache-2.0 | 纠正 | Hindsight、LangMem、A-MEM 是 MIT；以固定 commit 许可证为准 |
| LlamaIndex 的解析等于全部本地开源 | 限定 | 开源库与 LlamaParse/LlamaCloud 服务分开，不能将托管能力算作自托管能力 |
| 超时默认执行不确定变更 | 不采用 | 超时只改变队列/通知状态，不产生用户确认 |

## 3. 记忆框架比较

下表的“适合”是本项目判断，非公开性能排名。源码/接口定位可从来源索引进入对应 commit。

| 项目 | 核验许可 | 可复用能力 | 对本项目的边界 | 建议 |
| --- | --- | --- | --- | --- |
| Hindsight | MIT | retain/recall/reflect；world/experience/observation；多路检索、证据引用、mental models | bank 与标签不替代 omem ACL；反思结论须回原件校验；增加服务成本 | 首选经历学习 PoC，先 shadow 再启用候选 |
| Mem0 | Apache-2.0 | 会话事实提取、更新、个性化检索、provider 生态 | 内部 update/delete 不能成为 omem 的最终事实治理 | 个性化场景对照组；不与 Hindsight 默认同时常驻 |
| Graphiti | Apache-2.0 | episode→实体/关系、时间范围、增量图更新 | 是引擎而非完整 Zep 云；graph driver 与图库有额外运维/许可边界 | 多跳时序问题证明收益后接入 |
| Letta | Apache-2.0 | 有状态 Agent、记忆块、自编辑核心上下文、归档 | 是 Agent runtime，会与已有 Trae/Codex 等宿主重叠 | 借鉴方法，不设为全系统必选运行时 |
| Cognee | Apache-2.0 | 可组合图/向量知识处理与搜索 | ontology、底层存储、图生成成本需评估；不等于证据版本内核 | 图抽取候选，延后 |
| LangMem | MIT | 提取记忆、后台管理、提示/程序记忆优化；LangGraph store | 更接近算法工具库，权限、变更事务需上层提供 | 已使用 LangGraph 时选；不和所有记忆引擎叠加 |
| memU | Apache-2.0（LICENSE.txt） | 当前 README 强调宿主历史→self-evolve jobs→Markdown skills→commit/index | 当前 MemoryService 明确不负责 LLM/chat 调用；不能套用早期介绍宣称其内置全套自主推理 | 借鉴技能桥接和渐进召回；接口变化需锁版本 |
| A-MEM | MIT | 原子笔记、相邻记忆建链、上下文演化 | 研究实现，不替代并发事务/权限/删除协议 | 采用算法思想，自研极少量领域映射 |

### Hindsight 接入时发现的具体约束

已检查 `hindsight-clients/go/api/openapi.yaml`，而非只依靠博客：

- `POST /v1/default/banks/{bank_id}/memories` 接收 `items`，支持异步和 `operation_id`；回执有 operation IDs。异步成功不代表已可检索。
- `MemoryItem`/`RecallResult` 有 `document_id`，结果可带 `chunk_id`、`metadata` 和 `source_fact_ids`，可用于追到固定的 omem 原始片段版本。
- `RecallRequest` 有 `types`、`budget`、`max_tokens`、`temporal_window` 与 `include`。`tags_match=any/all` **包含未打标签的记忆**；作用域需求不能依赖默认值。即使使用 strict，也仍需网关身份/分 bank 和权威 ACL 校验。
- `source_facts` 能提供 observation 的支持事实，但仍需解析其 document 映射并核对原文。若证据为空，只进入待验证候选，不显示“已证实”。
- 框架可能演化其内部概念；omem 通过 `producer + producer_version + external_id + source_fragment_revision` 隔离变更。

## 4. RAG、解析与图能力比较

| 项目 | 核验许可 | 可复用部分 | 不宜直接继承的部分 | 选择 |
| --- | --- | --- | --- | --- |
| WeKnora | 项目核心 MIT；第三方 notices 另计 | 文档解析、混合召回、重排、source locators、Wiki 生成参考 | 完整前端/用户系统/渠道 Agent/内部记忆写入策略 | 文档引擎第一 PoC；headless 使用 |
| RAGFlow | Apache-2.0 | DeepDoc、复杂文档切分、检索和引用 | 大量平台功能与 omem 重叠；版面解析成本需测 | PDF/表格质量对照；非首版必选 |
| LlamaIndex | MIT（仓库核心） | readers、node parser、retriever 等细粒度库 | 托管 LlamaParse/LlamaCloud 非本地必选开源部分 | 轻量组合替代方案，按包引入 |
| Docling | MIT（代码） | 多格式结构化文档、表格/页面/定位数据 | OCR/模型权重需单独核验，版面输出不自动提供跨版本身份 | 本地 PDF 解析首选对照 |
| Haystack | Apache-2.0 | typed pipeline、组件化 retrieval/reranking | 再引入整套管线会与已有工作流重叠 | 作为可替换编排路线，第一版不同时引入 |
| LightRAG | MIT | 关系抽取与图增强检索 | 提取出的图不等于“原文明确引用” | 图问题 PoC，延后 |

### WeKnora 可以复用到什么程度

检查 commit `4364e61afa4bf1e086c34b4220bb21449aa15b25`：

1. `internal/handler/knowledgebase.go` 的 `HybridSearch` 提供 `POST /knowledge-bases/{id}/hybrid-search`；路由实际前缀在集成 PoC 确认。handler 返回 `{success, data, meta?}`，默认是底层召回，不默认 rerank。
2. `SearchParams` 有 `query_text`、`match_count`、`knowledge_ids`、`skip_context_enrichment`、`rerank`。适配器用 `skip_context_enrichment=true` 降低扩展正文造成锚点歧义，并明确决定重排在引擎还是 omem 层做一次。
3. `SearchResult` 有 `id`、`knowledge_id`、`start_at/end_at`、`source_locators`。`ContentRevision` 与 `ContentRewritten` 是内部字段，**不会 JSON 序列化**，所以不能仅靠返回文本的范围就声称证据未改。
4. `internal/handler/chunk.go` 有按 ID 取 chunk、分页取文档 chunks 的端点。导入完成后可建立外部 chunk→omem fragment revision 映射。
5. `ManualKnowledgePayload` 当前并没有直接传任意 `external_id` 字段。不可假设 SDK 会回传 omem ID；用自己的 `adapter_bindings` 记录导入返回的 knowledge ID，再基于规范化文本/定位信息进行匹配。
6. 每个源版本创建新的引擎文档绑定，老版本可保留或按策略移出索引；不要原地覆盖导致旧引用漂移。AI Wiki 只能作为候选文章，重新绑定句子级证据后再提交 omem。

由此选择“API 边界复用”，不承诺插件零改码就覆盖全部需求。若解析产物没有完整导出/锚点无法可靠映射，WeKnora 降为仅召回侧引擎，omem 用 Docling/native parser 建立原始片段。PoC 必须量出映射率、失败处理和运维成本。

## 5. 基础设施的收敛

| 领域 | 建议 | 为什么 | 扩展触发 |
| --- | --- | --- | --- |
| 权威数据 | PostgreSQL | 事务、JSON、行权限、版本指针和引用边可同事务更新 | 按 tenant/时间分区，不先换数据库 |
| 向量基线 | pgvector（PostgreSQL 许可） | 同 PG 部署、保留降级和重建路径 | 过滤后召回/延迟不达标再选 Qdrant |
| 中文词检索 | 引擎提供 BM25；内核轻量 token/精确检索兜底 | PG 内置分词不等于优质中文 BM25 | 中文评测证明需要才上 OpenSearch |
| 图 | PG 关系边 + 一跳索引查询 | UI 的引用图是确定性邻接关系，不先需要专用 GraphRAG | 大规模路径/时序运算再选独立图库 |
| 对象存储 | 本地文件适配器→标准 S3 API | 原件、规范化结构、快照分离；服务商可替换 | 多实例需共享对象存储；凭据只用 secret ref |
| 后台任务 | Celery + Valkey + PG job/outbox | 复用队列/重试/调度；PG 保存业务状态 | 长期等待/复杂补偿占主导时评估 Temporal（MIT） |
| 模型循环 | 明确步骤的 Python worker；复杂处可引 LangGraph（MIT） | 模型只处理认知步骤，限定循环/预算 | 有多步推理实际需求才接图式编排 |
| Web | React/TypeScript、Radix、TanStack、Tiptap 扩展 | 复用无障碍弹窗、数据缓存、编辑器文档模型 | 需协同编辑时再评估 Yjs |

Celery/Valkey/Web 库是工程建议，本轮未逐一进行源码与依赖清单审计；最终版本与传递依赖在 P0 确认。不将“顶层许可证开放”扩写成“所有模型、插件、托管服务都无限制”。

## 6. 选型评分与翻转条件

评分不是伪装实测的数字。先给权重，再用同一 PoC 测：证据/版本映射 30%、二次开发边界 25%、自治记忆质量 20%、部署与成本 15%、维护与迁移 10%。任一硬门失败不能靠总分补偿：无原文导出、无法隔离权限、删除后仍能注入、索引不可重建。

| 路线 | 优点 | 代价 | 采用条件 |
| --- | --- | --- | --- |
| A：omem + WeKnora + Hindsight | 复用通用能力最多，贴近中文材料与经历学习 | 两个引擎、映射与重复存储成本 | 首选；两者各自通过 PoC；不要求同一周全部上线 |
| B：omem + Docling/LlamaIndex + pgvector + Hindsight | 内核与锚点更直接，文档组件细粒度 | 需要组装更多检索代码 | WeKnora 锚点/导出/资源开销不达标时切换 |
| C：直接 fork WeKnora 全栈 | 初期有完整应用 | 领域 schema、前端交互、自治策略与上游冲突 | 不推荐作为主路线 |

对照任务必须来自本项目真实需求：中文术语/错误码，历史与现行制度，跨材料片段链，失败纠正后的再次任务，冲突、撤权、无答案；不以英文单轮问答排行榜决定系统选型。

## 7. 研究仍未解决的事实问题

当前上游源码证明“字段与接口存在”，尚不能证明本项目数据上的解析质量、推理正确率、可部署资源上限和模型费用。P0 要验证：WeKnora 原始结构导出和异步导入的重放；Hindsight 巩固结果的全部证据映射与删除传播；中文切片与精确定位；本地模型是否满足提取/重排；许可证与模型权重的最终组合。不要将这些写成已经通过的生产保证。
