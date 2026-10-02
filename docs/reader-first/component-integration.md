# 成熟方法如何进入现有代码

本文是改造路线，不把外部产品文档或实验收益当 omem 已有能力。完整平台、可嵌入组件和可复用方法分开评估；先判断来源元数据能否衔接，不因缺少内部 Fragment 合同直接否决。

## 文档结构与上下文检索

[Docling](https://docling-project.github.io/docling/concepts/chunking/) 按结构切分并在长度预算下细化，能够保留标题等背景。对 omem：在 Capture 外加解析适配器输出块、标题路径、表格与定位；store 继续保存原件。`knowledge/structure.ts` 复用 marked/TS 已足够处理当前文本，PDF/Office 接 Docling 实际转换而不是再造布局解析。解析失败保留原件并说明降级。先验证双栏、表格和扫描材料，而非只看 Markdown 是否漂亮。

[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) 给每个片段补它在整份文档中的具体背景，再进入全文与向量索引。对 omem：`retrieval/semantic.ts` 的 title+400 字符输入改为结构背景+片段，`keyword.ts` 也索引背景；主体、人称、事件、章节、函数职责可来自可靠结构或模型理解。补充文字是派生投影，不能改原文；预处理更换必须更换向量身份。避免给每个块附同一段泛化文档摘要。

融合参考 [Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)，相关性重排参考 [BGE 作者实现](https://github.com/FlagOpen/FlagEmbedding)。改 `keyword.ts`、`semantic.ts` 和 `knowledge/retrieval.ts`：候选分别生成，先过滤正式范围和时效；正文匹配不搜索引用理由与 trace；按命中节回溯；记录词覆盖和原始分数；只做一次融合；重排后补父章节。RRF 把排名转成可融合分数，不自动判定相关；MMR 减少重复，不替代相关性判断。

本轮先消除可解释的噪声并做真实对照。中文 embedding/reranker 用 osdk 声明锁定、运行禁止下载；可比较 Qwen3/BGE，但不在没有问题集、时延和效果证据时换更大模型。没有直接搬 Elasticsearch 平台的必要，个人 SQLite 原件与检索接口可以保留。

## 代码调查与 Wiki

[Aider repo map](https://aider.chat/docs/repomap.html) 用关键符号和依赖选择有限上下文，并引导继续读文件。对 omem：AST 投影输出 outline/定义/引用工具，不再固定前四个 import 前 70 行。Agent 根据页面问题搜索和补读类型、调用者、配置、测试和设计材料；准确类型导航后续用 TypeScript Program 或 SCIP 对照，不需要先声称有完整 call graph。

[DeepWiki 官方规划](https://docs.devin.ai/work-with-devin/deepwiki) 支持页面 purpose、层级和重点，并结合 Wiki 与代码搜索。对 omem：持久页面计划保留读者、问题、前置概念、案例与读后行动；`KnowledgePipeline.writePage` 直接从调查原件生成。`analyze/synthesize` 可保留为内部笔记兼容，不把每个文件、12 个计算子项直接当产品目录。分类是 topicPath 正式数据；引用依赖不变成目录关系。

[Diátaxis](https://diataxis.fr/start-here/) 区分教程、how-to、解释和参考；[C4](https://c4model.com/diagrams) 提供从整体到局部的系统视角。对 omem：角色 skill 按任务选模板，配少量具体好例子；教程围绕一次完整旅程，机制篇解释输入输出和因果，决策篇区分历史记录与推断，参考便于查字段。图分别解释分工/顺序/状态，图后正文说明读者该注意什么；不强制每页都有所有栏目。

## Agent 自带 harness

[ACP turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) 可包含多个模型与工具交互。对 omem：改 `agents.ts` 的事件处理与 `agent-runtime/gateway.ts`，提供 MCP 和固定材料工作区；原生 skill 被 Agent 按需加载；中间说明与最终结果分开；研究不再固定三次新会话。writer 和独立 verifier 都可自主补读，发布仍由宿主完成。

提供知识搜索/读取、原件列表/章节/行段、图片路径、符号导航、相关知识与版本历史。能直接落盘的材料让原生文件工具读取；内部对象与统一搜索用 MCP。不要在 omem 重做 CLI 的计划、工具循环和压缩内核。`config/review-code-model.json` 使用真实配置，并去掉宿主输入/输出 token 限制；模型固有上下文与 CLI 的压缩管理仍存在。

Traex 的 [用户手册](https://bytedance.larkoffice.com/wiki/HWUPwVssCi0KSPkOCZtcwznmnYg) 写明 `exec --output-schema`；[ACP 指南](https://bytedance.larkoffice.com/wiki/DwxIwD5RtiF5LFk2MNvc853znmc) 写明 skills、MCP、权限、工具生命周期。目前不能把 exec 参数直接宣称是 ACP 扩展。实现先验证实际版本；原件全文留 runtime，不把内部手册或凭据复制进公开产物。

## 持续记忆与问题路由

[Hindsight mental models](https://hindsight.vectorize.io/developer/mental-models) 维护常用问题的综合理解；[Graphiti](https://github.com/getzep/graphiti) 维护随时间演化的关系。对 omem：在现有 MemoryService 之上接适配层，映射 source/revision/actor/eventAt，保留旧事实及当前状态；先拿一个项目的事件材料测试合并、更新、查历史和行动。不先手写它们整套事实管理框架。

[GraphRAG](https://microsoft.github.io/graphrag/query/overview/) 区分局部与整体问题。对 omem：`assistant/runtime.ts` 及统一搜索增加任务上下文策略：找符号取定义，问机制补链，问原因补决策，问进展取综合内容和变化。先利用已有文章与结构关系，不为所有问题强制 LLM 抽图和图数据库。

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) 的跨会话、更新、时间与信息缺失类别可用于真实题目。`scripts/live-retrieval-smoke.ts` 的“找到一个预期路径”不能代表排序干净或回答完整；对照应展示 top 结果相关与无关、必要背景是否齐、给齐原文是否能回答。问题集只用于验收，不把问法/答案/路径条件写进排序实现。

## 优先顺序与不做成前置门的事情

先文档还原决策和完整方案，再治理真实候选噪声，再把 Agent 工具研究贯穿调查/写作/独立补查，随后更新本仓库实际指南。持续记忆整合和复杂解析器另做完整切片。完整调用图、全库 100% 覆盖、换图数据库、更多角色和更复杂 schema 都不应阻塞一个真实流程。

## 本轮检索对照与配置决定

已把中文/英文 [BGE reranker](https://huggingface.co/Xenova/bge-reranker-base) 的 q8 权重经 osdk 下载、校验并锁定，`retrieval/reranker.ts` 用 Transformers.js 对问题与段落成对计算；不是对单段做分类。`factory.ts` 允许配置 `reranker: "relevance-zh"`，知识 Agent 使用同一配置。运行不下载，缺模型时保留词法结果并暴露降级状态。

实际仓库用六个未写进输入库的新问题做对照，涉及事实应用、旧版原文、重复导入、等待跟进、引用代码及 Agent 背景调查。专用重排仍会偏好旧方案、复述问题和主题近但不能回答的内容；没有足够证据默认启用它。当前 config/retrieval.json 保留中文 embedding，重排器是显式实验选项；不能把下载成功当搜索改进。少量同义词样例通过也不能覆盖这个问题。

已经实施的通用改进包括完整概念覆盖、按来源文档频率加权、限制标题扩散、按命中章节回溯知识、一次融合、向量弱尾部过滤、精确标识符要求实际命中。默认结果合并完全重复摘要，同一来源最多两个互补摘录，避免一个文件占满首屏；原文与其他摘录都保留，内部 raw 搜索可以关闭分组。

剩余工作不该只继续调权重：检索结构投影需加入章节/函数背景；已有解释应该作为独立的检索表示并带回原件；来源适用状态与时间需成为正式数据；真实评测要把主题相似与能回答问题分别标注。不要按 archive/test 路径直接降权，也不要把回归问法或预期路径写进排序。Agent 当前可在明确范围内检索、看目录、原生 Grep 与补读完整文件，能继续调查而不受首次排序限制。
