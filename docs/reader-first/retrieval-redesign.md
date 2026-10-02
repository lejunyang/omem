# 检索的三项改造

这轮把三项作为同一条用户流程验收：先找到解释，再读实现和原件；按查找目的组织结果。不能分别通过几个排序测试就声称整体有效。

## 一、讲解本身成为结果

原来的 `knowledge/retrieval.ts` 虽然搜索文章段落，但返回的是引用对应的原始 Fragment。顶部搜索和助手因此失去已整理的解释。现在使用统一的 `RetrievalHit`：讲解命中保留原文段落、文章、章节、固定文章版本与原件引用；原件、记忆和事项分别保留自己的类型和入口。讲解是派生背景，不冒充第二份事实。

## 二、结构化原件检索单位

新增可重建的 SQLite 检索投影，不改 Capture、Revision 和历史 Fragment。Markdown 使用现有 marked，保留章节路径、段落、列表和表格；代码使用现有 TS/Vue AST，按符号范围组织，附签名、注释和模块背景；聊天保留参与者、事件时间及会话/回复关系。长单位可以向量化为多个窗口，但窗口不变成阅读目录。

先使用解析得到的背景和现有讲解；没有理解过的函数不凭空添加 AI 意图。跨文件调用和业务背景仍需 Agent 补查。

全文排序复用 SQLite FTS5 的 BM25，对中文先用 ICU 分词。语义检索沿用 osdk 管理的中文 BGE，结构预处理版本进入向量身份，与旧 Fragment 向量隔离。来源或文章当前版本变化时只替换对应投影；原始历史和固定引用保留。

## 三、用途驱动的共享策略

用途有综合、概念、实现、背景、事项跟进。读者和 Agent 可以明确指定；未指定时保留综合检索，不用仓库名称、目录和题集问法猜结果。概念/背景优先提供连贯说明，实现兼顾符号与原文，事项跟进纳入当前事项和事件时间。用途是结果组合的偏好，不用它排掉仍可能需要的其他材料。

`/api/search`、知识页搜索、Agent 的材料/知识工具、助手使用同一条 `RetrievalPort.search`。旧 `searchSources` 保留为需要固定原件锚点的兼容接口，不再作为解释的唯一表示。

## 如何判断是否做好

全部实现后，用真实中文问题检查：能否找到完整机制，能否定位到正确实现和对应行，旧材料是否误当当前状态，助手是否保留解释并能继续补读。比较原始结果与新结果，不把路径命中、独立复核通过或自动测试数当成理解质量。实际 HTTP、中文模型、阅读页面和受影响 `.repo-review` 产物一起验收。

借鉴方法来自 [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)、[LlamaIndex Recursive Retriever](https://developers.llamaindex.ai/python/framework/integrations/retrievers/recursive_retriever_nodes/) 与 [SQLite FTS5](https://www.sqlite.org/fts5.html)。这里复用它们的上下文、父子回读和成熟排序思路；效果必须在本项目材料上重新验证。
