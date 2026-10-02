# 长问题里明确点名的方法：冻结库定位实验

这是检索研究与人工验收资产，不是模型生成的知识正文，也不是本轮最终八题 HTTP 抽读。生产源码没有应用本实验；普通助手、Web 整合与六篇指南继续按已冻结实现验收。

**结论：应增加一个独立的代码标识候选入口，但不能把“问题中出现了标识”一律理解为“优先给这段代码”。** 当前实现已经识别部分命名定义，真正的漏召回发生在整句 BM25 排序之后、融合之前。限定到“找实现”用途可避免本实验里的概念阅读退步，却仍不能理解同一用途中的否定提及或解决同名定义歧义。它值得作为下一条小切片实现，不应在本轮资产生成过程中临时改变排名，然后把旧快照结果当作新验收。

## 范围与实际运行

- 检索实现快照：`9e9a7a731b6cf36190e7754475733f57382583e5`。
- 输入：2026-10-02 11:41:27 UTC 冻结库，对应此前 `68677fa` 语料；不是正在生成六指南的 canonical 库。
- 数据库以 `readOnly:true` 打开；不做采集、投影同步或向量写入，不接触个人库。
- 原有中文 BGE embedding：`structure-icu-v4:bge-zh-cls-q8-window400-v1:7556bde190512e88209bb701b889b797fcb0d9beb520b15352d0de4f59d9d2d3`。12,679 单元已索引，`ready`、`pending=0`，未启用 reranker。
- 第一次原型运行：2026-10-02 14:55:07–14:55:13 UTC，退出 0；随后补充候选截断诊断及否定/多标识对照，均退出 0。
- 每题只执行一次现有 lexical+dense 搜索。原型复用同一份候选与分数，加第三个标识候选分支，再调用现有用途排序与去重。没有人工改写原问题、目录优先规则、项目名特判或大模型生成。
- 原型及完整文字位于忽略的 `.repo-review/runtime/research/explicit-symbol-probe.ts`、`explicit-symbol-probe/report.json`、`explicit-symbol-extra/report.json`；候选截断补查在 `explicit-symbol-diagnostics.ts`。保留每题前 30 条原始与原型正文、代码候选的完整源文本、固定目标及真实排序。runtime 原始数据不会提交。

本实验中的 **13 个改善样本是冻结库上的符号查找样本**：1 条已有真实长问题，以及 12 条由不同 source owner 按单位 ID 哈希选出符号、再组成的定位问法。其中重复出现 `MemoryService.apply`，并抽到测试里的 `FakeProbe`、`FakeMessages`。它们不是 13 个互不重复的机制，也不是无偏自然问题评测，不能当整体相关性或回答质量评分。

## 漏在什么地方

[`relevance.ts`](../../../apps/server/src/retrieval/relevance.ts) 的 `exactLookup` 只在整个查询都是标识或路径时成立。长中文问题通常不走这条精确通道；`relevance` 又要求长问题至少命中三个词，单个标识不能独自满足覆盖要求。

不过 [`unified.ts`](../../../apps/server/src/retrieval/unified.ts) 已有 `namedDefinition`：匹配 AST 定义名称的单位可以绕过这条覆盖要求，最终排序还有定义加成。因此只放宽 `relevance` 并不能解决本次问题，反而可能放进更多无关片段。

`lexical()` 按整句 FTS BM25 排序，过滤后保留最多 250 个候选；`search()` 只把其中前 100 个送入 lexical/dense 融合。下面真实问题里的完整 `MemoryService.apply` 定义，原始 BM25 位于第 **950**，过滤后的 lexical 位于第 **162**，因此根本没有进入融合池。最后的定义加成无法恢复一个已经丢掉的候选。

## 真实前后文字与固定范围

原问题，原样保留，用途为 `implementation`：

> MemoryService.apply 如何把模型提案变成有效记忆？若要修改这条处理链，入口和后面的写入分别在哪里？

原检索前 30 条没有返回 `MemoryService.apply` 定义。原始前三名正文如下，均为实际返回文本，不是人工总结：

**1.《规则变了以后：原文、记忆与待办如何更新》／怎样判断下一步，以及当前边界**

> 若要修改机制，主要入口分别是：捕获与失效在 `store.ts`，重核验编排在 `learning/pipeline.ts` 与 `learning/refresh.ts`，应用策略在 `memory/service.ts`，事项时间与提醒在 `tasks/follow-up.ts`，Wiki 新鲜度与发布在 `knowledge/repository.ts` 和 `knowledge/pipeline.ts`。这些入口对应前述不同状态，不应合并成一条“处理完成”开关。延伸阅读：[[c26]]

固定文章：`guide:memory`，revision `d0ad8dd068c36e5cae43976a8a39eead349fff51f730cde1124090b93d54cebc`，section `actions-and-limits`。

**2.《从捕获材料到可信记忆的学习与重核验》／提取、独立复核与整批治理**

> 通过复核后，整份变更一次性交给记忆服务评估。服务先合并受影响记忆与新实体的去重集合；若超过自动应用预算，原本可自动应用的提案会整体停放，并只生成一次批量确认。其他策略还包括拒绝、延后到使用时处理、仅保留为可检索来源以及忽略噪声，因而“进入队列”或“模型支持”都不等于已经写入有效记忆。参考 [[c8]] [[c9]]

固定文章：`module:learning`，revision `5517362af3d08135ab4888751f3a61e542965fcdb122d2e58fc66342cd9e3e37`，section `flow`。

**3.《记忆提案治理、应用与反馈服务》／恢复、反馈学习与存储边界**

> 服务通过 Store 访问共享数据库和事务入口，但治理数据并不都成为记忆或任务修订：反馈及其约束分别保存在 `feedback`、`feedback_constraints`，争议、评估、策略和决定也有各自记录；只有实际调用 `applyMemory` 或 `applyTask` 的变更进入相应修订与应用链。[[c17]] 这替代了“所有治理结果最终都落入统一记忆或任务修订链”的过宽结论。

固定文章：`omem:apps/server/src/memory/service.ts`，revision `aa48dcecc158caea003683072a068d36f2fa81261625027eaed8520aff6a206a`，section `recovery_feedback`，`reviewState=needs-review`。这是可补读的待复核背景，不能称为当前重新验证的说明。

原型增加标识入口后，第一名变为 **`MemoryService → MemoryService.apply` 的定义**；原来前两篇解释顺延到第二、第三，仍可用来提供上下文。第一名实际返回的完整正文如下；它只是显示摘要，固定目标仍指向整段方法：

```ts
private apply(
    proposal: Proposal,
    proposalDigest: string,
    decision?: { id: string; requestId: string },
    approvedByOwner = false,
  ) {
    const metadata = {
      workspaceId: proposal.scope.workspace_id,
      applicationId: `proposal:${proposalDigest}:1`,
      proposalId: proposal.proposal_id,
      proposalDigest,
      generation: 1,
      title: `应用${proposal.kind}：${
        proposal.kind === "task" ? proposal.body.title : "新记忆"
      }`,
      details: proposal.reason,
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    };
    const hooks = {
      before: () => {
        this.assertCurrentReads(proposal.proposal_id);
        if (decision) {
          const current = this.db
```

结构与固定原件锚点：

```json
{
  "kind": "source",
  "key": "omem:apps/server/src/memory/service.ts",
  "revisionId": "3535d321-67e3-4de7-9130-a5fc17d0e749",
  "digest": "222f17c851155ae25feb7f1cf58323eacdaeaea81fb8d76a875a37852c315125",
  "startLine": 1176,
  "endLine": 1280,
  "headingPath": ["MemoryService", "MemoryService.apply"]
}
```

这些行属于冻结原件，不能静默跳到当前工作树相同行号。完整 105 行定义保存在原型报告的 `definitionCandidates[].candidates[].text`。**找到完整方法不等于已经解释调用入口、后面的写入或业务背景**；本实验只消除定位遗漏，不把一段代码当成足够好的 Wiki。

## 其他定位样本

十二条附加问题使用“请从实际实现解释……核心步骤及继续查阅的入口”与“负责什么、读取什么、改变什么状态”两种长问法。符号从已有 AST 结构选择，候选融合不读取这些预期名字以外的答案路径，更没有给某个目录加权。

| 明确标识 | 原 lexical 位次 | 原前30 | 原型定义位次 |
| --- | ---: | --- | ---: |
| `Runs.start` | 172 | 未返回 | 1 |
| `FakeProbe.probe` | 126 | 未返回 | 1 |
| `AssistantRuntime.cancelTurn` | 167 | 未返回 | 1 |
| `MemoryService.apply` | 154 | 未返回 | 1 |
| `RetrievalProjection.sync` | 150 | 未返回 | 1 |
| `FakeMessages.send` | 135（第一个同名定义） | 未返回 | 1–6，有歧义 |
| `ConversationRouter.markPending` | 161 | 未返回 | 1 |
| `HookSpool.path` | 127 | 未返回 | 1 |
| `QualityRepository.label` | 171 | 未返回 | 1 |
| `RoleBundleRegistry.prepareWorkspace` | 144 | 未返回 | 1 |
| `LarkCardActionService.enqueue` | 172 | 未返回 | 1 |
| `JobRepository.heartbeat` | 140 | 未返回 | 1 |

另一个实际多标识问题询问 `RoleBundleRegistry.load` 与 `RoleBundleRegistry.prepareWorkspace` 的分工：前者从第 12 到第 2，后者保持第 1。这仍只说明两段定义可同时进入阅读窗口，不代表分工解释已完成。

无代码标识的朋友消息问题、日期问题、排除 URL 后的文档问题，以及不存在的 `NoSuchClassZyx.noSuchMethodAbc`，原型前 30 条 ID 顺序均未变化；直接搜索 `MemoryService.apply` 已经能定位方法，原型也未改变结果顺序。误写 `MemoryService.applyMemory` 没有得到新定义——实际写入方法属于 `ApplicationRepository.applyMemory`；原型没有把后缀相同的另一个类方法当成这个类方法。它的 AST 定义在固定的 `apps/server/src/storage/repository.ts` 中。

## 真实退步，不能省略

**概念用途。** 问题是“用 MemoryService.apply 这个例子解释什么叫记忆更新，先讲用户能看懂的概念，不需要先读源代码”。无用途限制的原型把该定义从第 14 推到第 1，首先展示应用 metadata 与 hooks 的代码，违背读者要求。原始结果第一名是 `config/wiki-pages.json`，也不好；两者都不应被称为概念回答已满足。

**否定提及。** “不要继续给我 MemoryService.apply 的代码，我想了解图片和中文段落在进入知识库之前如何清洗”，原来第一名是材料清洗说明：

> 这主要是接入、过滤和保存。它不等于完整清洗：历史方案与当前状态、正文与噪声、表格与段落、对话回复与转发还未形成统一结构。通用片段主要按空行切；中文向量对片段再用 400 字符窗口、80 字符重叠。已新增 marked/TS/Vue 的阅读结构投影，助手可补父章节与相邻片段，但结构尚未充分进入索引。

无用途限制的原型却把被明确排除的 `MemoryService.apply` 推到第一。限定 `purpose=implementation` 能保留这一条 `concept` 问题的原排序，但另一条同样设为 `implementation` 的“不要再看 MemoryService.apply 的实现，帮我找能清洗图片和文档的入口”，仍从第 24 错推到第 1。**用途限定只能减少影响，不能冒充否定理解已完成。** 不建议为本仓库这两个句子硬写特判；后续候选入口应区分“要定位的标识”和“顺带提及／排除的标识”，或保留为单独可见的定位候选而不压过整问主结果。

**同名歧义。** `FakeMessages.send` 在多个测试文件里都有 AST 定义，原型会把六个同名实现放到前六。当前按 source owner 的去重不会把跨文件同名定义当作同一个对象。缺少正式范围或调用上下文时，不能任选一个宣称正确；也不能把某个目录当作通用“真实现”规则。

## 可行的最小改造及交付边界

1. 在 `relevance.ts` 提供独立的明确标识提取：保留 `Class.method` / `Namespace.Class.method` 这类字面形式，排除 URL 和日期，仅匹配实际存在的代码定义。不要降低整句 `relevance` 覆盖门槛，也不要按路径猜读者目的。
2. 在 `UnifiedRetrieval.search` 中、lexical/dense 融合之前，增加标识候选分支。原型对每个标识复用精确 lexical 查询，再限定为 AST 定义名称匹配的 source/code 单位；现有 kinds、范围、可见性、时间条件都必须照常执行。原问仍参与原来的完整 lexical/dense 检索。
3. 候选按原有 reciprocal-rank 公式 `1/(61+rank)` 融合，随后仍经过现有用途、固定目标和去重。原型没有调现有用途加权。正式实现应记录 `code-symbol` 来源，让定义进入综合排序，并能查看它为何被后续筛掉；候选保护不代表定义一定相关，不应强制压过符合整问的内容。本实验未启用 reranker，不能把结果外推至该配置。
4. 最小入口先限定 `purpose=implementation`，纯标识短查询继续使用已有精确逻辑。需要另外明确无 embedding／embedding 失败时的分数处理；本次结果只验证 embedding ready 的融合，未验证把 BM25 原始分数与 RRF 数值直接相加的退化路径。
5. 定义定位只解决“有名字但搜不到”。跨文件功能链、真正的实现归属、概念别称、历史规则有效性、否定语义与同名歧义仍应单独改善。先按材料能否回答问题评估，而不是把第一个代码锚点视为整个流程通过。

当前保持生产源码冻结；本报告只交付诊断与具体候选方案。若后续实现，应提交相应源码、更新受影响的真实知识资产，再重新执行不指定预期路径的八题 HTTP 抽读。不能把这份旧冻结库定位实验计入本轮新指南覆盖或最终检索通过率。
