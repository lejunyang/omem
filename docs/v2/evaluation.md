# v2 评测记录

数字只对应下面写明的数据、模型和日期，换模型或改检索后要重跑，不能沿用。

## 检索：T2Retrieval 子集（中文）

2026-10-12。C-MTEB/T2Retrieval dev：随机 400 个问题，语料为这些问题的全部相关文档加 15,000 篇随机干扰文档，共 17,086 篇（平均 885 字）。文档级指标（同一文档的多个片段合并）。不是完整 118k 语料，不能和 MTEB 榜单直接比较。

| 检索方式 | nDCG@10 | Recall@10 | Recall@50 | MRR@10 | 平均耗时 |
| --- | --- | --- | --- | --- | --- |
| 全文（FTS5，中文双字 + 标识符拆分，BM25） | 69.01 | 67.47 | 78.17 | 79.78 | 41 ms |
| 向量（bge-small-zh-v1.5 q8，暴力余弦） | 87.25 | 85.42 | 94.95 | 94.65 | 66 ms |
| 全文 + 向量，等权 RRF | 84.90 | 83.35 | 94.53 | 92.89 | 110 ms |
| 全文 + 向量，全文权重 0.5（默认） | 86.76 | 85.62 | **95.57** | 93.96 | 109 ms |
| 全文 + 向量，全文权重 0.3 | 87.30 | 85.84 | 95.42 | 94.19 | 110 ms |

结论：自然语言问题上向量明显强于全文；等权融合会被较弱的全文拖低。默认取 0.5：Recall@50（交给 Agent 的候选覆盖）最好，nDCG 与纯向量接近，同时保留全文对精确名称、罕见词和代码标识符的作用（T2 不考这些，所以没有继续往下调）。符号路线始终全权重。

复现：

```bash
python3 scripts/prep-t2.py    # 见下文，生成 t2_corpus.jsonl / t2_queries.jsonl
node scripts/eval-retrieval.ts t2_corpus.jsonl t2_queries.jsonl --home .scratch/eval-t2            # 全文
node scripts/eval-retrieval.ts t2_corpus.jsonl t2_queries.jsonl --home .scratch/eval-t2 --vector   # 融合
node scripts/eval-retrieval.ts … --vector-only | --fts-weight 0.3
```

`prep_t2.py`：用 huggingface_hub 下载 `C-MTEB/T2Retrieval` 的 corpus/queries parquet 和 `C-MTEB/T2Retrieval-qrels` 的 dev，`random.seed(7)` 抽 400 个有正例的问题，加 15,000 篇随机干扰文档，写成 JSONL（`{"id","text"}` 与 `{"id","text","rels":{docId:grade}}`）。

## 长期记忆问答：LongMemEval_s（cleaned）小样本

2026-10-12。每类取前 3 题共 18 题；每题约 50 段历史会话作为聊天原件放进独立空间，由 assistant 角色（Claude Code ACP，haiku）用 omem 工具检索作答，没有预先抽取记忆。评判用 Claude Sonnet（haiku 当评判时对同一批答案给出 44%～50%，噪声太大，不采用）。

| 类别 | 正确 |
| --- | --- |
| knowledge-update | 3/3 |
| temporal-reasoning | 2/3 |
| multi-session | 1/3 |
| single-session-user | 2/3 |
| single-session-preference | 2/3 |
| single-session-assistant | 3/3 |
| 合计 | 13/18（72%） |

只有 18 题，置信区间很宽，只能说明链路可用、失败类型在哪：

- 跨会话计数（“我总共带过几个项目”）会漏掉分散在多段对话里的条目——这正是“整理新材料”角色把事实提前写成记忆要解决的，下一步应在开启 ingest 的条件下重跑对比。
- 一题时间推理没检索到第二个事件（换说法搜索仍未命中）。
- 一题答案在原文中只有间接线索（提到 Target 的应用），助理按“区分事实与推断”的要求没有下结论，被判错。这是有意的取舍。

### 改进后：跨会话汇总（2026-10-12）

针对计数题加了 `scan`（穷举列出所有命中行，可按时间段）并改写助理的汇总步骤：先列同义说法 → 扫描 → 逐条核对 → 列清单再计数，第一句给出最可能的数字、争议条目在清单里注明。multi-session 取前 6 题重跑（同样 haiku 作答、sonnet 评判）：**5/6**（原先前 3 题 1/3）。

- 失败的两题在第一版改动后都已找全了出处，错在过于保守（“如果把一双靴子算两件就是 3”“只按原文明确写的带领来数是 1 个”）；补上“给出最可能的数字”后，带项目题答对，衣物题仍判错。
- 样本只有 6 题，只说明方向有效，不代表整体准确率。

复现：`node scripts/eval-longmemeval.ts longmemeval_s_cleaned.json --per-type 3 --judge-model sonnet`（结果追加到 `--home` 下的 results.jsonl，可 `--rejudge`）。

## 真实流程抽查（Claude haiku，2026-10-12）

- 代码仓库 Wiki：zustand（128 个文件）规划 12 页并逐页写作，页面从具体例子出发、带 Mermaid 流程图和行级引用、末尾给修改入口；抽读 `flows/create-and-setstate` 质量明显好于 v1 的逐文件说明。
- 本仓库问答：问“纠正一条记忆时内部发生了什么”，回答准确串起 supersede 流程与版本链，并指出了工具层缺少空间校验的真实缺陷（已修复，见提交 042454a）。
- 聊天整理：一段项目群聊生成 1 条记忆、3 个事项（含待决定、等待回复）和 2 条通知；后续群聊把等待事项标为完成并记录需求变化。
- 交办编码：在演示仓库实现函数和测试，独立 worktree、检查命令、独立评审（结论通过）与 diff 均正常。

## 规模（2026-10-13）

`scripts/bench-scale.ts`：把 T2Retrieval 语料（17,086 篇）复制到 10 个空间，共 170,860 个原件 / 片段，库文件约 2GB；向量用随机 512 维（只测检索开销，不测质量）。云端 2 核 CPU。

| 操作 | 改动前 | 改动后 |
| --- | --- | --- |
| 全文检索，一个空间 | p50 38 ms / p90 124 ms | p50 38 ms / p90 100 ms |
| 全文检索，全部空间 | p50 57 ms / p90 236 ms | p50 58 ms / p90 221 ms |
| 向量检索，一个空间 | p50 32 ms | p50 22 ms |
| 向量检索，全部空间 | p50 408 ms | p50 374 ms |
| 向量常驻内存（全部空间加载后进程 RSS） | 1.5 GB | 0.42 GB |
| 新增材料后 | 清空缓存，下次查询全量重载（数秒） | 增量追加，不重载 |

改动：向量按空间存成一块 int8 量化矩阵（每个向量一个缩放系数），不同空间组合共用同一份；新嵌入的片段直接追加；删除的片段打标记，过多时惰性重建；服务启动后后台预加载。量化对质量的影响（T2 400 题）：纯向量 nDCG@10 87.25 → 87.13，默认融合 86.76 → 86.62。

判断：全文检索到百万级片段仍可用；暴力向量检索在约 50 万片段以内可接受（全空间查询约 1 秒）。再往上需要 ANN：`src/search/vectors.ts` 的 `VectorIndex` 接口就是为 sqlite-vec / Qdrant / pgvector 留的口子。日常检索默认只查当前空间，跨空间（`space: "*"`）才扫全部。
