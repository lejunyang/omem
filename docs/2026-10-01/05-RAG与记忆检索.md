# 五、RAG与超强记忆检索

## 5.1 先修正确性，再增加模型

事实与风险依据：[引用quote映射与图预算](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/knowledge/retrieval.ts#L8-L57)、[助手召回/旧working context](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/assistant/runtime.ts#L604-L698)、[timeRange合同](https://github.com/lejunyang/omem/blob/94aafe934c6734aab346c6d73cf51dcec0c78d26/apps/server/src/retrieval/port.ts#L25-L37)。跨段、时间和历史import的本轮复现见附录一。

主线始终是超强记忆：来源保真→精确找回→支持完整→跨时间更新→日常使用反馈。当前关键词和知识导航保留为baseline和离线兜底。优先修引用范围跨多个fragment映射、旧working context过期检查、timeRange实际执行、caller归属和历史import版本一致性。否则新向量模型只会让错误候选更容易被命中。

统一EvidenceResolver读取固定版本原文、判断当前有效/历史/撤权、验证selector，所有入口包括主助手、Knowledge API、Code Wiki、学习卡和导出都调用它。主助手不能只searchSources而长期memory永远不入检索；应让Memory/Claim检索与原件检索并行，但把命中memory回查到原证据。

## 5.2 查询规划

使用轻量规则+有界模型规划，输出可记录的QueryPlan，而不是无约束Agent反复搜：

1. 明确目标：事实查找、现行规则、历史时点、跨会话回忆、代码定位/调用解释、设计与实现对照、事项状态、学习提问
2. 识别实体、精确符号/路径/错误码、项目候选、时间口径、用户指代、当前焦点与授权scope
3. 选择召回支路和最小证据需求，复杂问题拆成有限子问；简单定位不先付一次大模型planning成本
4. 为每个子问记录缺口、候选与预算；停止条件是支持覆盖充分/预算耗尽/仍需真实用户参数，不是“搜了一次”

输入时间有四种：发生时间、采集时间、来源版本、生效时间。比如“五月当时决定什么”和“现在执行哪版”是不同过滤策略。默认现行回答不默默拼进旧版本；历史回答使用as_of并保留当时不知未来的信息。

## 5.3 混合召回方案

通过RetrievalPort演进适配器，而非业务调用方散落向量SDK：

- 稀疏/关键词：SQLite FTS/BM25候选，中文分词与二元gram/代码标识符分词比较验证；FTS5 trigram不命中不足三字的MATCH，当前LIKE带ESCAPE也不能直接利用其对应优化，不能只换表就宣布中文检索升级；路径、符号、错误码精确召回单独保底。当前LIKE仅作可比较baseline
- dense：选择中文/英文/代码混合样本表现及机器资源适配的embedding，本地embedding/reranker小模型符合仓库历史决策记录（不是本次新推断的个人偏好）；模型/维度/归一化/版本/内容hash记录到索引generation，支持重建。文档有title/heading/邻接摘要的上下文，但不要把派生描述当原文引用
- 结构：明确链接、AST imports/可靠calls、需求-实现-测试关联、消息reply以及实体/时间联系作为有依据的扩展，不将相似度边当支持边
- 记忆：活跃claim/episode/procedure和当前事项做独立支路，保留限制/attribution及有效时间
- 知识正文：Wiki/专题做路由和候选扩展，最终回查原片段；正文摘要命中不能导致虚构原文关键词

先用rank融合（如RRF）消除不同分数尺度问题，再用小型reranker精排授权候选。禁止简单把BM25、cosine和图距离的裸分数直接相加。reranker不能挽救未召回证据，所以分别测candidate recall与top-k质量。

建议初始实验预算而非生产承诺：每支路50–100条候选、合并后100–200条去重、rerank 30–60条、最终8–16个证据单元，重要复杂问题可适度扩大。用真实问题集和机器延迟决定，不以“最多”当越多越好。

## 5.4 选择上下文与生成答案

去重按证据根源/版本/相邻范围，不只按文本。对同一材料相邻命中合并为有边界的上下文包；表格必须带表头，代码带所属符号/类型/必要import，群聊带说话人和必要reply上下文。MMR/配额用于降低十条同义摘要占满context，优先保留不同独立证据和反例。

ContextManifest必须含：固定revision和selector、来源时间与状态、可见性决策、检索原因/分支、原文与派生分区、覆盖缺口、输入预算。回答主张贴近引用；先核验定位与版本，再核验支持/范围/否定/数值，缺证据的部分显式保留不确定性。禁止为了回答完整而把背景资料当直接支持。

历史片段可以被用户显式查看或用于历史回答；不应因“能读到”就作为当前有效依据。先前轮次selectedEvidence也必须重新验证状态，不能绕开新版召回过滤。

## 5.5 权限与索引边界

当前系统个人模式不代表已经完成tenant ACL。建议在扩展前设计AccessContext并落到同一resolver：workspace/principal/channel/audience/source policy/acl epoch。候选召回前可见性过滤，模型重排前不得把不可见正文送出，最终输出/引用再次检查。现有主助手先top20再filter会让无权候选挤占配额，虽有安全过滤仍损害召回。

派生物权限取必要支持集的交集，不能因为同时引用一份公开资料就公开由私密信息生成的结论。撤权使向量、全文、缓存、生成上下文、导出等投影失效；链接和hash不是访问令牌。既有对外消息无法靠内部回滚保证撤回。

## 5.6 RetrievalPort演进合同与性能边界

当前Port是同步接口，适合本地SQLite，不应为了接远程embedding或reranker在事件循环里阻塞等待。新增v2异步接口并提供现有KeywordRetrieval适配器，支持AbortSignal、deadline、partial/failed支路状态与流式候选；调用方一次传AccessContext、as_of、query plan和预算，不在各分支重猜权限。

SearchResponse至少包含EvidenceRef、原始/派生类型、source状态、各支路排名与融合/重排理由、查询范围、index_generation、coverage_gaps和truncated/continuation。embedding score不是支持概率；检索排名、解析置信和语义支持评估分别保存。模型回答被中止时取消后续检索/重排，晚到结果不能写进新turn。

索引健康不只返回available=true：报告source head与indexed revision差距、队列滞后、失败材料/语言覆盖、模型版本和上次成功时间。某支路失效可退回关键词并清楚显示能力下降，但不能以“无结果”隐藏整条向量链未运行。

---

[返回目录](README.md) · [上一篇](04-端到端数据流与多模态接入.md) · [下一篇](06-代码AST与Code-Wiki.md)
