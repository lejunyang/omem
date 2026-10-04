# 成熟方法如何进入现有代码

更新：2026-10-05。本文区分已经实现的方法、下一步接入的组件和仍待比较的后端，不把上游文档或榜单当 omem 已有能力。实际代码、文章和外部检索诊断见[整体复审](review.md)。

## 本次选择及替换位置

| 选择 | 具体进入现有项目的方式 | 替换什么／保留什么 | 状态 |
| --- | --- | --- | --- |
| DeepWiki 的页面地图与分层写作 | 在 `packages/contracts/src/knowledge.ts`、知识存储/API 中持久化页面目的、发布用途、目录关系；`writePage` 写正式文章，材料分析只产内部笔记，旧批次合成已移除 | 替换文件或计算批次直接进入目录；保留 Traex 自主调查和固定来源 | 核心实现和阅读界面已交付，三篇主题页已真实生成；最新实现变化后仍需维护正文 |
| Docling 解析组件 | 增加可选解析 worker，输出结构块、标题、表格、页码/位置及解析版本；由 Capture 适配层保存原件和派生文本，再进入 `knowledge/structure.ts` 与检索投影 | 替换 PDF/Office/OCR 自研清洗；TS/Vue 和已有 Markdown 解析继续使用 | 未安装、未接入；Python/解析模型由 osdk 显式管理 |
| Haystack 层级检索组件 | 通过 `RetrievalPort` 接组件适配，映射 `sourceId/revisionId/range/parentId`；候选只取叶子，回答上下文按父节点恢复 | 不复制另一套应用；SQLite 继续保存原件，组件索引是可重建投影 | 未安装该组件；已保存固定原文的父子结构和段落归属，助手补章节与上级引言，Agent 可按节点继续补读 |
| Hindsight 持续综合理解 | 先接可选记忆读取/整合后端；输入原件、事件时间与元数据，返回带来源的观察和主题视图，供 Agent 补查 | 比较替换分散 claim 整合；原件版本和 MemoryService 的事实/事项应用权保留 | 0.10.2 + Traex/Sol 的连续保存、召回、回答及综合视图刷新已跑通合成场景；适配稳定性、时间细节与长期效果未通过，生产未接入 |
| 公开评测实现 | MTRAG 用官方段落与标注，FreshStack 复用官方要点覆盖评价，LongMemEval 保留原始会话和 oracle 对照 | 替换“预期路径命中＝质量”的判断；工程 smoke 保留 | MTRAG Cloud、FreshStack Godot 和改造后完整中文 T2 词法已运行；LongMemEval 七类 oracle 小样本已比较直接 Sol 与 Hindsight，非长历史召回成绩 |

这些组件不必一次安装。第一个交付应先解决页面用途和更新生命周期，随后接父章节与简明检索策略；复杂文档解析和记忆后端按各自真实输入交付。

### 页面规划：借用流程，不能照搬篇幅配额

本次检查 [deepwiki-open 的结构规划](https://github.com/AsyncFuncAI/deepwiki-open/blob/d92819a9c9f3b99416e3580ff235fc9d3adf8b89/api/services/wiki/structure.py)、[页面提示](https://github.com/AsyncFuncAI/deepwiki-open/blob/d92819a9c9f3b99416e3580ff235fc9d3adf8b89/api/services/wiki/prompts.py) 与[内容生成](https://github.com/AsyncFuncAI/deepwiki-open/blob/d92819a9c9f3b99416e3580ff235fc9d3adf8b89/api/services/wiki/content.py)：先规划页面层级和相关原件，再写页面。这与逐文件摘要再批量汇总有实质区别。它的一些来源数量/图表要求不适合小主题，不照抄；仓库分支链接也不能替代 omem 的固定版本引用。它是独立开源实现，不是商业 DeepWiki 的源码。

omem 已有 `WikiPageBrief`，缺的不是继续加提示字段，而是让计划决定正式发布。发布用途必须随产物保存；迁移保留旧资产和引用，不能靠某个 key 前缀临时过滤。独立复核分别判断事实与页面任务，不能因为一行转导出解释没有错就把它升级成完整教程。

### 结构解析与检索：先把适配数据说清楚

[Docling chunking](https://docling-project.github.io/docling/concepts/chunking/) 能从结构文档产生带上下文的分块。适配器同时保存原件定位与派生文字定位；扫描文本不能伪造源码行号。解析配置和版本进入投影身份，重新解析不改旧引用。异步 worker 可独立重试，解析失败仍能查看原件，不要求全部用户安装这个可选能力。

[Haystack HierarchicalDocumentSplitter](https://docs.haystack.deepset.ai/docs/hierarchicaldocumentsplitter) 与 [AutoMergingRetriever](https://docs.haystack.deepset.ai/docs/automergingretriever) 依赖明确父子 ID：若多个子块命中，可取父块作为完整语境。应先把这些元数据带入 `retrieval/units.ts` 的持久投影，保持完整章节/函数边界；通过组件适配返回候选后，再由 omem 校验原件身份与可见范围。不是在向量结果后随意多拼几行，也不要求为了使用组件先丢弃现有 SQLite。实际兼容的 DocumentStore 和组件版本要随适配锁定。

### 持续记忆：要比较可运行的后端，而非只借术语

[Hindsight mental models](https://hindsight.vectorize.io/developer/mental-models) 是围绕常用问题维护的综合视图；来源变化后可更新视图，过期视图仍可见，但不直接替代底层查证。借鉴点是“持续维护已有理解”，不只是再加一个摘要表。

先通过后端接口导入一个隔离主题：每条输入带原件版本、事件时间、人物/项目标识；Hindsight 的 retain/recall/reflect 结果带原始定位回到 omem。用户问题仍由现有 Agent 阅读；事实应用、提醒与任务状态仍经 MemoryService。比较后再替换当前整合逻辑，避免两个后端各自宣称同一当前事实。

[官方部署](https://github.com/vectorize-io/hindsight#quick-start) 需要额外服务/存储和模型配置，不是一个零成本 TypeScript 依赖。Traex ACP 也不能直接冒充它的普通 HTTP 模型端点；接入时应检查其 provider 扩展，或在明确配置的受支持 provider 上做隔离对照，不能隐式要求另一份付费密钥。采用它的理由必须是长期更新与跨会话效果、维护成本的净收益，而不是某个排行榜总分。

当前隔离试验使用 osdk 管理的 Python/uv，锁定 `hindsight-api-slim[embedded-db]==0.10.2`，由 pg0 启动仅本机访问的 PostgreSQL。模型仍是仓库实际配置的 Traex ACP / gpt-5.6-sol，已有中文 BGE 提供向量，没有安装本地大语言模型或要求另一份模型密钥。临时 HTTP 适配器把结构化输出与工具选择转换为 ACP/MCP；Hindsight 执行自己选择的记忆工具，再带结果请求下一轮，适配器不伪造工具结果。已实跑中文向量和结构化输出，并完成下述小型连续记忆试验；长期效果仍需单独验证。首次启动发现上游不支持 `none` 重排配置，已改用上游提供的 RRF 直通模式。

三条明确标注的合成项目材料覆盖改期、负责人交接、预算包含关系和未约定的付款时间。修正 ACP 提交后的收尾交互后，三次 retain、recall 和两次 reflect 已完成；模型正确区分最新日期、负责人与预算包含关系，付款日回答“未约定”。保存每条材料约 54～75 秒，召回 0.21 秒，两次调查回答约 159/112 秒。随后把真实生成的回答保存为综合视图，加入第四条变更，再显式调用 refresh：视图更新为 10 月 20 日上线、总预算 9000 元且包含云费用 3500 元、付款日 10 月 15 日，并保留负责人和历史。新材料保存约 74 秒，刷新约 177 秒。这证明调用与更新流程可运行，尚不构成快速问答或质量优势。

仍有实际问题：两轮合成调查各出现一次“Agent 未提交响应或工具选择”，上游继续调查后得到结果；早期另有两次 Traex 空响应流失败。观察合并把 9 月 5 日才补充的云预算与 9 月 3 日的预算变更写到一起，综合视图也沿用了这个时间归属，不能认为时间推理已经正确。部分观察的事件结束时间仍带原定上线日期；还需要从观察回查源事实及 omem 固定行范围，不能直接把返回的观察当最终引用。

随后调整工具选择适配，完成 LongMemEval 七类预选 oracle 案例：12 段原始相关会话按日期整理，逐题独立 bank，七题均完成；与同一 Sol 直接阅读这些会话对照。Hindsight 回答中位约 125 秒，直接阅读约 12 秒，另有累计约 38 分钟的整理成本；能合并金额、找回名称和比较先后，但也有冗长回答、额外细化年份和含糊更新的分歧。没有证明净收益，不能作为正式长历史检索成绩。方法、限制和逐类结论见[外部评测](external-evaluation.md#longmemeval给足相关会话后的七类诊断)。

运行目录、数据库、临时令牌和原始 trace 均在被忽略的 `.repo-review/runtime/experiments/hindsight`；七题实验结束已停止 PostgreSQL 和专用适配服务。尚未成为正式可复用适配器，也未写入个人库。根据下面的补充对照，当前选择先复用 omem 已有的文章维护，不把完整 Hindsight 整理与 reflect 设为默认链路。

本次也读了 [Hindsight benchmark](https://github.com/vectorize-io/hindsight-benchmarks) 和 [Mem0 benchmark](https://github.com/mem0ai/memory-benchmarks) 的运行设计：可参考摄取/检索/回答分阶段和逐题输出。用相同的历史、回答模型与评价条件比较，保留准备记忆所花的成本；不能把不同模型的分数相减说成架构收益。数据选择与本轮实际运行边界见[外部评测](external-evaluation.md)。

### 持续视图的取舍：先复用已有文章维护

10 月 5 日用上面同一组四条合成项目记录，实际运行当前 `KnowledgePipeline.writePage`：先将前三条整理为项目概况，再把第四条纳入同一页面计划并维护。两轮均经过真实 Traex/Sol 研究、写作和独立复核，约 208/223 秒；原始事件时间同时保存在 Capture 元数据。生成期间另有指南任务并行，不能把耗时差直接归因于架构。

最终视图把当前安排与变化时间线分开：上线 10 月 20 日，小周实施、小林验收，总预算 9000 元内含 3500 元云费用，付款日 10 月 15 日。历史部分保留 9 月 3 日的 8000 元调整，以及 9 月 5 日才补充的 3000 元云费用，没有重现前述 Hindsight 观察合并的日期混合。它也区分了第一次外部接口延期、第二次为完成验收而改期。旧视图及固定来源仍能回读，没有写入 memories 或 tasks；临时数据库已释放。

这证明现有统一知识管线能够维护这种综合解释，不能证明已经具备持续项目记忆：本次选材和更新由实验显式触发，没有测试新记录自动归入项目，也没有测长历史召回或回答时延。正文仍额外罗列收款对象、付款方式和模型硬件等未知，并把付款日期已解决的问题扩展为付款条款问题；这些不属于“了解项目概况”的必要前提，不能当作主动助理的有用成果。完整结果保存在同一份 `omem-view-result.json`，不另存一套文章到正式知识目录。

下一段实现应接现有流程的缺口，而不是再造第二套事实库：

1. 在页面计划中明确它是否需要持续维护，以及哪些原始来源属于这个主题。先支持用户选定来源的后续版本；新来源归属必须依据正式保存的关联或用户选材，不能用名称相似、目录或引用关系自动扩大范围。
2. `knowledge/repository.ts` 保留计划与当前视图，`knowledge/pipeline.ts` 继续携带旧稿、材料差异、时间和固定引用。来源换版后，经现有 durable jobs 排队维护同一页面；合并尚未处理的连续变化，失败保留旧文并显示原因，不因读取页面就反复调用模型。需接通 `store.ts` 的来源更新、任务 worker、知识 API 与阅读页面，当前尚未实现。
3. 阅读和问答先利用适用的视图，关键冲突再补读原文。视图是派生解释，原件历史和 MemoryService 的事实、事项应用权保持独立；自动更新视图不等于自动新增待办。按同一真实项目的多次变化检查日期、条件、遗漏和读者用途，不能仅以维护任务成功计数验收。

## 文档结构与上下文检索

[Docling](https://docling-project.github.io/docling/concepts/chunking/) 按结构切分并在长度预算下细化，能够保留标题等背景。对 omem：在 Capture 外加解析适配器输出块、标题路径、表格与定位；store 继续保存原件。`knowledge/structure.ts` 复用 marked/TS 已足够处理当前文本，PDF/Office 接 Docling 实际转换而不是再造布局解析。解析失败保留原件并说明降级。先验证双栏、表格和扫描材料，而非只看 Markdown 是否漂亮。

[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) 给每个片段补它在整份文档中的具体背景，再进入全文与向量索引。omem 已在 `retrieval/units.ts` / `unified.ts` 用结构背景+片段替代旧 title+字符窗口主入口，FTS5 与 BGE 共用；本轮进一步把模型阅读得到的概念别称仅附在其原文范围。补充文字是派生投影，不能改原文；预处理更换必须更换向量身份。没有给每个块附同一段泛化摘要，也尚未实现完整的逐块语境生成。

[Haystack metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering) 把正式属性过滤与内容召回分开。本轮在现有 SQLite 上保存每版材料的用途、状态和明确有效期，由原生 `material-cataloger` 分析，页面可修正；`UnifiedRetrieval` 在截断候选前执行明确条件，默认排序减少计划、调研和旧状态的干扰。未知分类仍可见，背景查询保留历史内容。没有把目录、保存时间或题集问题当作分类。这是方法适配，没有安装 Haystack 平台；具体代码与边界见 [材料用途与概念入口](material-understanding.md)。

融合参考 [Elasticsearch RRF](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion)，相关性重排参考 [BGE 作者实现](https://github.com/FlagOpen/FlagEmbedding)。现在共享入口已在 `retrieval/unified.ts`，新增独立符号候选及集中融合，`keyword.ts`、`semantic.ts` 和 `knowledge/retrieval.ts` 保留兼容用途。继续在共享入口比较候选和排序，不能再分别改几条旧搜索路线。RRF 把排名转成可融合分数，不自动判定相关；MMR 减少重复，不替代相关性判断。

本轮先消除可解释的噪声并做真实对照。中文 embedding/reranker 用 osdk 声明锁定、运行禁止下载；可比较 Qwen3/BGE，但不在没有问题集、时延和效果证据时换更大模型。没有直接搬 Elasticsearch 平台的必要，个人 SQLite 原件与检索接口可以保留。

## 代码调查与 Wiki

[Aider repo map](https://aider.chat/docs/repomap.html) 用关键符号和依赖选择有限上下文，并引导继续读文件。对 omem：AST 投影输出 outline/定义/引用工具，不再固定前四个 import 前 70 行。Agent 根据页面问题搜索和补读类型、调用者、配置、测试和设计材料；准确类型导航后续用 TypeScript Program 或 SCIP 对照，不需要先声称有完整 call graph。

[DeepWiki 官方规划](https://docs.devin.ai/work-with-devin/deepwiki) 支持页面 purpose、层级和重点，并结合 Wiki 与代码搜索。对 omem：持久页面计划保留读者、问题、前置概念、案例与读后行动；`KnowledgePipeline.writePage` 直接从调查原件生成。`analyze/synthesize` 可保留为内部笔记兼容，不把每个文件、12 个计算子项直接当产品目录。分类是 topicPath 正式数据；引用依赖不变成目录关系。

[Diátaxis](https://diataxis.fr/start-here/) 区分教程、how-to、解释和参考；[C4](https://c4model.com/diagrams) 提供从整体到局部的系统视角。对 omem：角色 skill 按任务选模板，配少量具体好例子；教程围绕一次完整旅程，机制篇解释输入输出和因果，决策篇区分历史记录与推断，参考便于查字段。图分别解释分工/顺序/状态，图后正文说明读者该注意什么；不强制每页都有所有栏目。

## Agent 自带 harness

[ACP turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) 可包含多个模型与工具交互。omem 的 `agents.ts` 与 `agent-runtime/gateway.ts` 已处理这条链路：提供 MCP 和固定材料工作区，原生 skill 按需加载，中间说明与最终结果分开；研究不再固定三次新会话。writer 和独立 verifier 都可自主补读，发布仍由宿主完成。接下来复用这些能力，不重做一套 Agent 工具循环。

提供知识搜索/读取、原件列表/章节/行段、图片路径、符号导航、相关知识与版本历史。能直接落盘的材料让原生文件工具读取；内部对象与统一搜索用 MCP。不要在 omem 重做 CLI 的计划、工具循环和压缩内核。`config/review-code-model.json` 使用真实配置，并去掉宿主输入/输出 token 限制；模型固有上下文与 CLI 的压缩管理仍存在。

Traex 的 [用户手册](https://bytedance.larkoffice.com/wiki/HWUPwVssCi0KSPkOCZtcwznmnYg) 写明 `exec --output-schema`；[ACP 指南](https://bytedance.larkoffice.com/wiki/DwxIwD5RtiF5LFk2MNvc853znmc) 写明 skills、MCP、权限、工具生命周期。目前不能把 exec 参数直接宣称是 ACP 扩展。实现先验证实际版本；原件全文留 runtime，不把内部手册或凭据复制进公开产物。

## 持续记忆与问题路由

[Hindsight mental models](https://hindsight.vectorize.io/developer/mental-models) 维护常用问题的综合理解；[Graphiti](https://github.com/getzep/graphiti) 维护随时间演化的关系。对 omem：在现有 MemoryService 之上接适配层，映射 source/revision/actor/eventAt，保留旧事实及当前状态；先拿一个项目的事件材料测试合并、更新、查历史和行动。不先手写它们整套事实管理框架。

[GraphRAG](https://microsoft.github.io/graphrag/query/overview/) 区分局部与整体问题。对 omem：`assistant/runtime.ts` 及统一搜索增加任务上下文策略：找符号取定义，问机制补链，问原因补决策，问进展取综合内容和变化。先利用已有文章与结构关系，不为所有问题强制 LLM 抽图和图数据库。

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) 的跨会话、更新、时间与信息缺失类别可用于真实题目。`scripts/live-retrieval-smoke.ts` 的“找到一个预期路径”不能代表排序干净或回答完整；对照应展示 top 结果相关与无关、必要背景是否齐、给齐原文是否能回答。问题集只用于验收，不把问法/答案/路径条件写进排序实现。

## 优先顺序与不做成前置门的事情

Agent 自主调查已经接通，下一步不再重做这项前置条件。先改变正式文章的发布与更新生命周期，再把候选检索和回答上下文拆开，随后对照持续记忆后端。完整调用图、全库 100% 覆盖、更多角色和更复杂 schema 都不应阻塞一个真实流程。

## 此前检索实现与配置依据（2026-10-03）

下列规则是已有实现，不代表已经证明可泛化；2026-10-04 的外部词法对照没有显示稳定胜过简单基线。后续应拆分召回、上下文与界面去重，不能照此继续叠加权重。

2026-10-03 的后续对照增加了独立符号候选、RRF 融合和 BGE v2-m3，与旧实现和 base 使用同一冻结库。详细方法、上游方案和后续代码改造在[中文重排评估](retrieval-evaluation.md)，逐题结果在[当前对照](../../.repo-review/knowledge/verification/symbol-reranking.md)。下面的六题实验是此前依据，不应混计成新一轮样本。

已把中文/英文 [BGE reranker](https://huggingface.co/Xenova/bge-reranker-base) 的 q8 权重经 osdk 下载、校验并锁定，`retrieval/reranker.ts` 用 Transformers.js 对问题与段落成对计算；不是对单段做分类。`factory.ts` 允许配置 `reranker: "relevance-zh"`，知识 Agent 使用同一配置。运行不下载，缺模型时保留词法结果并暴露降级状态。

实际仓库用六个未写进输入库的新问题做对照，涉及事实应用、旧版原文、重复导入、等待跟进、引用代码及 Agent 背景调查。专用重排仍会偏好旧方案、复述问题和主题近但不能回答的内容；没有足够证据默认启用它。当前 config/retrieval.json 保留中文 embedding，重排器是显式实验选项；不能把下载成功当搜索改进。少量同义词样例通过也不能覆盖这个问题。

已经实施的通用改进包括完整概念覆盖、按来源文档频率加权、限制标题扩散、按命中章节回溯知识、一次融合、向量弱尾部过滤、精确标识符要求实际命中。词法相关性在一个连贯的局部段落内计算，避免把大文件中相隔很远的词拼成高分命中；这仍不能替代结构背景与语义理解。默认结果合并完全重复摘要，同一来源最多两个互补摘录，避免一个文件占满首屏；原文与其他摘录都保留，内部 raw 搜索可以关闭分组。

结构投影、可独立检索的讲解及正式材料说明已进入共享检索。剩余工作不该只继续调权重：混合文档需要更细的适用说明，长问题要保留明确符号入口，业务机制需要连贯补读；真实评测必须把主题相似与能回答问题分别标注。不要按 archive/test 路径直接降权，也不要把回归问法或预期路径写进排序。Agent 当前可在明确范围内检索、看目录、原生 Grep 与补读完整文件，能继续调查而不受首次排序限制。

真实 HTTP 抽查进一步发现章节级引用扩散。现用 marked 解析读者段落、列表项和表格行，仅从实际匹配的文字回溯其引用；代码块/图与同章无关段落不继承分数。跨文章引用有明确章节时保留该章背景，未指定章节则继续找相关段落。这个修复处理了别名回原件的错误扩散，不宣称已解决中文语义、当前/历史适用性和跨文件功能理解。
