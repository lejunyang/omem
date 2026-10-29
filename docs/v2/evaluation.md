# v2 评测记录

数字只对应下面写明的数据、模型和日期，换模型或改检索后要重跑，不能沿用。

## 公开数据从哪来（2026-10-30）

调检索或记忆时手动跑，不设定时任务。数据清单在 `scripts/bench/datasets.json`（下载地址、SHA-256、许可、大小），`scripts/bench/fetch.ts` 下载到 `.scratch/bench/<名>/`（已在 .gitignore），校验哈希，再转换成评测脚本读的格式。仓库里只放脚本和清单，数字写在本页。

| 名称 | 测什么 | 规模 | 许可 | 转换后 | 指标 |
| --- | --- | --- | --- | --- | --- |
| `longmemeval_s` | 长期记忆：检索 + 作答 | 500 题，每题约 50 段会话，277 MB | MIT | 原 JSON | 会话级 Recall@5/@10、All@10、NDCG@10（`--recall`，不用模型）；按类准确率（模型作答 + 模型评判） |
| `longmemeval_oracle` | 只给证据会话，查作答链路 | 500 题，15 MB | MIT | 原 JSON | 准确率 |
| `t2retrieval` | 中文检索 | 400 问 + 相关文档 + 15,000 篇干扰 | Apache-2.0 | corpus.jsonl / queries.jsonl | nDCG@10、Recall@10/@50、MRR@10 |
| `duretrieval` | 中文检索，第二个对照集（百度搜索的真实问题） | 同上抽法，原始 10 万篇 / 2,000 问 | Apache-2.0（上游 DuReader-retrieval；Hugging Face 卡片没写，引用前再核） | 同上 | 同上 |
| `locomo` | 很长的双人对话、时间推理 | 10 段对话，约 2,000 问 | CC BY-NC 4.0，**只在本机跑，不分发数据和转换结果** | LongMemEval 的形状（`locomo_lme.json`，每段对话一个空间，evidence 的 `D<n>` 换成会话 id） | 会话级 Recall（同上）；作答准确率 |

```bash
node scripts/bench/fetch.ts                         # 列出清单
node scripts/bench/fetch.ts longmemeval_s           # 下载、校验
node scripts/eval-longmemeval.ts .scratch/bench/longmemeval_s/raw/longmemeval_s_cleaned.json --recall            # 全文
node scripts/eval-longmemeval.ts .scratch/bench/longmemeval_s/raw/longmemeval_s_cleaned.json --recall --vector   # 全文 + 向量
node scripts/bench/fetch.ts duretrieval             # 要 Python 的 pandas、pyarrow
node scripts/eval-retrieval.ts .scratch/bench/duretrieval/corpus.jsonl .scratch/bench/duretrieval/queries.jsonl --home .scratch/eval-du --vector
node scripts/bench/fetch.ts locomo --pin            # 上游没公布哈希：第一次下载后把哈希写进清单
node scripts/eval-longmemeval.ts .scratch/bench/locomo/locomo_lme.json --recall
```

会话级 Recall 只看检索：每题的历史会话各存成一个聊天原件，用 omem 的 `search`（每个原件取一个片段）对问题排序，看证据会话（`answer_session_ids`）进没进前 k。弃答题（`_abs`、LoCoMo 第 5 类）没有证据，不计。它不需要模型，换检索参数后先跑它，再决定要不要花钱跑作答。

还没有结果：清单和脚本 2026-10-30 加入，LongMemEval 会话级 Recall、DuRetrieval、LoCoMo 都还没在完整数据上跑过，下一次调检索时补上，并和 T2 一起列在这里。作答准确率按每类 10 题做日常对比，大改动再跑全量（全量 500 题模型费用在数十美元量级）。

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
node scripts/bench/fetch.ts t2retrieval    # 生成 .scratch/bench/t2retrieval/corpus.jsonl / queries.jsonl
node scripts/eval-retrieval.ts .scratch/bench/t2retrieval/corpus.jsonl .scratch/bench/t2retrieval/queries.jsonl --home .scratch/eval-t2            # 全文
node scripts/eval-retrieval.ts .scratch/bench/t2retrieval/corpus.jsonl .scratch/bench/t2retrieval/queries.jsonl --home .scratch/eval-t2 --vector   # 融合
node scripts/eval-retrieval.ts … --vector-only | --fts-weight 0.3
```

转换（`scripts/bench/cmteb_to_jsonl.py`，原来的 `prep-t2.py` 并进了这里）：读 `C-MTEB/T2Retrieval` 的 corpus/queries parquet 和 `C-MTEB/T2Retrieval-qrels` 的 dev，`random.seed(7)` 抽 400 个有正例的问题，加 15,000 篇随机干扰文档，写成 JSONL（`{"id","text"}` 与 `{"id","text","rels":{docId:grade}}`）。步骤和种子没变，抽出来的子集和上表一致。

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

## 对话前带上相关记忆：门槛校准（2026-10-22）

`src/memory/passive.ts`：本人发消息时，用这条消息的向量和记忆向量算余弦，过了门槛的最多 5 条附在消息后面。门槛要在“有相关记忆时带上”和“无关时不乱带”之间取舍，用 `scripts/eval-recall-gate.ts` 校准。

数据：T2Retrieval dev，`random.seed(7)` 抽 200 个问题作正例，语料是它们的全部相关文档加 4,000 篇随机干扰文档，共 5,089 篇；另抽 200 个问题作反例，它们的相关文档都不放进语料，代表“没有哪条记忆和这句话有关”。每篇文档取前 120 字当一条记忆（接近真实记忆的长度）。向量 bge-small-zh-v1.5 q8。这 120 字记忆上的纯向量排序 nDCG@10 88.08。

| 门槛 | 正例：带上了相关记忆 | 带上的记忆中相关的比例 | 正例平均带几条 | 反例：带上了任何记忆 | 反例平均带几条 |
| --- | --- | --- | --- | --- | --- |
| 0.50 | 96.0% | 77.7% | 4.24 | 71.0% | 2.56 |
| 0.55 | 91.5% | 88.8% | 3.45 | 35.0% | 0.88 |
| 0.575 | 86.5% | 93.0% | 3.08 | 20.0% | 0.45 |
| **0.60（默认）** | **79.5%** | **96.2%** | 2.74 | **10.5%** | 0.17 |
| 0.625 | 70.0% | 97.8% | 2.31 | 5.5% | 0.07 |
| 0.65 | 62.0% | 98.7% | 1.90 | 2.5% | 0.03 |
| 0.70 | 42.0% | 99.5% | 0.96 | 0.5% | 0.01 |

结论：默认 0.6。漏掉的那两成 Agent 仍可以自己 `recall`；带错的代价是每轮多几十个字，提示里写明“不相关就忽略”。反例也是问句，比日常闲聊（“好的”“帮我写句生日祝福”）更像有所求，实际误带率应更低。换向量模型后分数分布会变，要重跑再定门槛（设置 → 检索里可调）。

真实 Agent 抽查（codex-cli gpt-6.1-sol low，三条记忆）：“明天周二了，项目 A 发布前我要做些什么？”带上发布约定，回答照它列出两步并引用 `mem:`；“去上海出差住酒店，一晚上能报多少？”带上住宿标准；“帮我写一句生日祝福”什么都没带。两次被引用的都在召回统计里记为用上。

复现：

```bash
node scripts/eval-recall-gate.ts corpus.jsonl queries.jsonl neg_queries.jsonl --chars 120
```

### 写记忆前的近邻门槛（2026-10-22）

`remember` 写入前按记忆与记忆的向量余弦（passage 对 passage）找同一空间里相近的记忆，≥ 0.75 就先列出来让 Agent 决定（更正 / 不写 / 另一件事）。用 bge-small-zh 在 14 对手写的记忆上看分布：

- 同一件事有变化（改期、换负责人、改标准、新增环境、同一类故障的做法）：0.73、0.78、0.80、0.88、0.89、0.93。
- 不同的事：多在 0.43–0.67；同一个项目的两件事 0.62，同一个人的两件事 0.54；措辞几乎相同的两件事偏高（“小王负责支付 / 小李负责前端”0.77，“项目 A 周二发布 / 项目 B 周二开周会”0.89）。

取 0.75：同一件事 6 对拦下 5 对，不同的事 8 对误拦 2 对。误拦的代价是 Agent 多调用一次、填上 `distinct_from`。两字切分的相似度分不开这些对（同一件事 0.14–0.35，不同的事 0.05–0.44），所以没有向量时只按主题名相同（忽略空格和标点）或两字相似度 ≥ 0.3 判断。

### 对照：VCPToolBox 的日记检索（RiverMemo）

同一份 5,089 篇语料、200 个正例，所有方案用同一个向量模型（bge-small-zh-v1.5，经一个兼容 OpenAI 的本地接口提供给 VCP）。VCP 取 2026-10-21 的 main（2717df5），每篇写成日记本 `T2` 里的一个文件，末尾 `Tag:` 行用 jieba TF-IDF 取 5 个关键词代替 AI 写的标签；用它自己的 RAGDiaryPlugin + KnowledgeBaseManager 跑 `[[T2日记本:4]]`，按注入结果的顺序取前 10。

| 方案 | nDCG@10 | Recall@10 | MRR@10 |
| --- | --- | --- | --- |
| omem 全文 + 向量（默认） | 90.51 | 88.51 | 96.41 |
| omem 纯向量 | 91.17 | 90.23 | 95.69 |
| VCP 库里存的向量直接算余弦（不经 RiverMemo） | 92.04 | 91.57 | 95.88 |
| VCP `[[T2日记本:4]]`（RiverMemo，当前默认且唯一的引擎） | 80.97 | 82.66 | 88.39 |
| VCP `[[T2日记本:4::BM25]]` | 68.52 | 69.80 | 74.05 |

- RiverMemo 比同一批向量的直接余弦低 11 个点。看差得最多的题：“做梦长颈纹严重”直接余弦前 7 条都是解梦文章，RiverMemo 前 10 条全是“颈椎病”——标签共现图把查询拉向大的标签簇，压过了直接匹配。标签是关键词代替的，AI 写的标签可能好些，但大簇吞掉直接匹配的问题不会消失。
- VCP 的直接余弦略高于 omem 纯向量（92.04 对 91.17）：它默认一篇就是一个片段（切分上限 6,800 token），末尾还带标签行；omem 切得更细。差距在一个点以内，没有据此改切分。
- 结论：omem 不引入标签图联想；被动召回只用门槛过滤的直接余弦。

VCP 的门控（`《《日记本》》`）是整本日记本一个开关：查询向量和“某某的相关主题：标签列表”的向量余弦 ≥ 0.6 就检索整本、不过就跳过，过了以后注入的片段不再逐条过滤（除非另加 `::Truncate`）。omem 的记忆不按主题分本，所以门槛放在每条记忆上。

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
