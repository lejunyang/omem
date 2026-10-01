# MemPalace 调研：本地检索值得复用，但先验证片段身份和中文效果

核验：2026-09-26。默认分支 **develop**，固定 commit `8c4865f70c49b6346c53474a9e5684c5f17d3fa9`，pyproject 自报 `3.10.0`，MIT。这里只证明该快照的接口/实现，不把 develop 当稳定发布版本。证据 URL/内容哈希见 [来源清单](../../implementation/batch2/research-sources.json)。

本轮做了源码/文档检查，并重新汇总仓库公开的 **1,450 条结果记录**；没有安装 MemPalace、下载 embedding 权重或重跑向量检索。结果复算见 [artifact-audit.json](artifact-audit.json)，可复现脚本见 [audit_artifacts.py](audit_artifacts.py)。本轮没有把 omem 原件发送给该项目或其他服务。

## 1. 结论与选择

**优先做 MemPalace 独立本地检索适配器 PoC，不 fork 整个平台，也暂不决定全部自建。** 它的无生成式 LLM 检索路径比需要内部 LLM 的完整记忆平台，更适合 omem“先用 CLI/ACP 处理理解与推理”的阶段。omem 继续掌握固定证据、主张有效性、审批例外、任务与通知；MemPalace 只保存可重建的检索投影，返回候选。

通过 PoC 则直接复用其 Python 搜索/后端能力，用薄适配器补身份和上下文；不通过时借鉴原文保留、两路召回、按需展开等方法，在 omem 自己的数据模型上组合现成 embedding/词检索组件。两条路线都不需要自研向量数据库或重写 embedding 模型。

这项 PoC 与 batch2 的自治主线可以独立推进，不能让等待检索引擎替换阻塞“提炼→验证→通知”。正式选择见第 7 节的硬门和退出条件。

## 2. 为什么不用本地大语言模型也能有较高检索分数

1. **原文不提前丢失**。raw 基准把会话内容保存后做向量查询，没有先让模型总结“哪些值得记”。事实如果被摘要删掉，后面检索再强也找不回。omem 应保留原始证据，同时建立派生知识视图，两者并存。
2. **Embedding 也是模型，但不是生成式 LLM**。基准默认用 Chroma 的 all-MiniLM-L6-v2（384 维）；能在 CPU 本地计算语义相似度，下载缓存后查询可无外部 API。不是“完全不用模型”或“零内存/零算力成本”。
3. **基准问题经过限定范围和粒度简化**。`build_palace_and_retrieve()` 每道题重建一次该题 haystack 的临时 collection，默认 session 粒度把各 session 的 **user turns** 拼接；不是在用户多年全部跨项目历史中一次搜索，也不是原文精确字符范围定位。
4. **关键词和时间补充了向量的弱点**。基准 hybrid 模式扩大候选集、关键词重排、相对时间距离等启发式，改善专名/日期问题。高分不必每轮调用生成式模型。
5. **分层组织便于限制范围与加载上下文**。wings/rooms/drawers 组织人/项目、主题和原文；wake-up、recall、search 渐进提供上下文。但原始 96.6% 基准并不能证明“宫殿目录”本身带来提升；该基准不依赖产品完整层级实现。

`benchmarks/BENCHMARKS.md` 还记录 AAAK 压缩 84.2%、rooms 89.4% 等旧实验，以及错误路由导致掉召回的案例。不能把目录、压缩、所有图谱特性都归为高分原因；默认保留原文，目录作为可退化的检索信号，避免模型错误分类把证据彻底过滤掉。

## 3. 高分到底测的是什么

`evaluate_retrieval()` 同时计算 any/all；对外常用 R@5 对应 `recall_any@5`：前 5 个 session 命中任一相关 session 即为成功。多证据问题找齐全部必要片段、正确回答、拒答、任务执行成功不是同一指标。`recall_all` 在脚本汇总中存在，但本次结果 JSONL 不包含完整 all 指标，不能凭 any 补出它。

| 仓库结果文件 | 行数 | 本轮对保存指标的复算 | 说明 |
| --- | ---: | --- | --- |
| `results_mempal_raw_session_20260414_1629.jsonl` | 500 | R@5 **483/500 = 96.6%**；R@1 80.6%；R@10 98.2% | raw baseline，无生成式 LLM；尚未重新执行检索 |
| `results_mempal_hybrid_v4_held_out_session_20260414_1634.jsonl` | 450 | R@5 **443/450 = 98.444%**；R@10 449/450 | 与 split 文件的 50 个 dev ID 不重合 |
| `results_mempal_hybrid_v4_llmrerank_session_20260414_1659.jsonl` | 500 | R@5 **496/500 = 99.2%**；R@10 100% | LLM rerank；文件本身不能证明调用位置/实际账单 |

注意事项：

- 上游旧文档有 **100% + Haiku/Sonnet rerank** 的实验，并明确承认针对已知失败题修补、再测同一组题，不等于无污染的泛化成绩。当前 curated benchmarks 页使用 99.2% 的较新 rerank 结果。
- 上游某表把 98.4% 写为 `442/450`；本轮检查的 April 14 文件是 **443/450**。两个日期文件不应混为同一次实验；442/450 的算术结果也不是 98.4%。本报告以明确文件名与哈希对应结果。
- 验证 held-out ID 不重合，只证明该文件的集合关系；不能独立认证研究者此前从未看过这些问题。要判断 omem 泛化，必须另建时间切分的真实中文 holdout。
- 同一 LLM rerank 文件 R@1 为 80.2%，没有高于 raw 的 80.6%；top-5 更高不代表所有检索指标都更好。应报告多指标及预算，而非单个最好数字。
- 旧 LoCoMo `top_k=50` 超过每个 conversation 的 19–32 sessions，等于把全部会话交给后续模型。上游现已指出这个局限。当前文档列 raw top-10 60.3%、hybrid v5 top-10 88.9%，这些是上游报告，本轮未重算。
- 脚本 `ndcg()` 的 ideal 从已返回 top-k relevance 排序构成；与按完整相关集合构造 IDCG 的标准定义不完全一样。omem 不复用其数值作为跨系统 NDCG 比较，改用独立指标实现。
- 本轮复算读取保存的 metrics，没有拿原始 gold labels 重新判定所有 ranked_items，更没有独立重跑 HNSW/embedding。复算 ≠ 基准复现。

README 明确仅 GitHub、PyPI、mempalaceofficial.com 为官方来源。搜索中出现的 `.tech` 等宣传页未作为事实依据。旧文章“100%/零 API/一切最强”的复合表述不采用。

## 4. 当前源码与历史 benchmark 的差别

| 能力 | 固定快照发现 | 对 omem 的意义 |
| --- | --- | --- |
| 普通检索 | `search_memories()` 默认 vector 候选 `n_results*4`，再 hybrid rank | 不能把 benchmark hybrid_v4 当当前产品默认算法 |
| 联合召回 | `candidate_strategy='union'` 可另取 lexical 候选 `n_results*3`，再合并 | 值得测专名/代码错误码；默认不是 union |
| 融合 | `_hybrid_rank` 默认 0.6 vector + 0.4 BM25；按候选集最大 BM25 归一化 | 与历史 benchmark 的 `distance*(1-.30*overlap)` 不同，也不是 RRF |
| 数据模型 | Palace/wing/room/drawer、知识图谱、原件 metadata、历史/维护能力 | 有大量可复用组织与检索功能，仍不等于 omem 的 ClaimRevision/权限合同 |
| 本地 embedding | config/工厂默认 minilm；onboarding 文档推荐 embeddinggemma | 不使用含糊的“默认模型”描述，分别记录入口和 profile |
| 多语言 | embeddinggemma-300m ONNX q8，768 输出截取前 384 维并归一化；MiniLM 英语训练 | 中文必须测试；同为384维也不能混用索引，需要 generation 重建 |
| 会话摄入 | convo_miner 按问答 exchange/段落切片，超长再切 | 与 benchmark 拼整 session/user-only 不同，真实迁移需要重新测 |
| 可选 LLM | general extraction、refine 等有 `ollama/openai-compat/anthropic` provider | 只启用无LLM摄入/检索路径；omem 语义判断走自己的 ACP |
| 插件 | `mempalace.backends`、`mempalace.sources` entry points；BaseCollection add/upsert/query/get/delete | 可写薄 adapter；source entry point 存在不等于所有第一方 miner 已迁过去 |
| 时间 | filed_at、authored_at、content_date 分开；部分时间过滤在候选后处理且有截断标志 | 不把文件入库时间当事件发生时间；截断要透传 |
| 替代后端 | Chroma 默认；sqlite_exact/rust_exact/Qdrant/pgvector/Milvus 为可选 | 默认本地无需 Docker；sqlite_exact 仍需 Python/NumPy，包核心仍依赖 Chroma |

基础包声明 Python>=3.9，但选择依赖轮子、二进制解析 extras 时需检查具体支持；PoC 建议 Python 3.12 独立环境，由 osdk 管理。主要依赖为 Chroma、NumPy、tokenizers、huggingface_hub、ONNX runtime 等实际解析闭包，不能沿用旧基准 README 的“唯一依赖 chromadb”作为现在的完整环境说明。

README 给首次权重体积估计 minilm ~80MB、embeddinggemma ~300MB，这是下载体积口径，不是运行内存测量。模型权重许可证单独核验；首次下载需要网络，热运行离线要实测。`hf_hub_download` 路径中没有默认固定 revision：omem PoC 必须锁权重 revision/hash、缓存与离线策略，不能因 osdk 下载过同名模型就声称 MemPalace 一定会用该快照。

## 5. 直接接入的关键障碍：身份不是只加个 ID 字段

MCP 的 `tool_add_drawer(wing, room, content, source_file, added_by)` **没有任意 metadata/external_id 参数**。其 `make_drawer_id_from_content(wing,room,content)` 会让同 wing/room 的相同正文得到相同 drawer ID；`source_file` 不在这个 ID 配方里。因此两个来源/版本有相同正文时，不能只按返回 ID 一对一绑定 omem 证据。

推荐 PoC 用 Python sidecar + 公共后端 API：自己指定投影 ID `omem:<fragmentRevisionId>`、写 namespace/generation/source_revision/text_hash metadata，再通过 search_memories 读取。需要验证它识别自定义 metadata 与父 chunk/group 的方式；不要直接写 Chroma/SQLite 内部表。

高层 search 可能按 source_file/父组归并，返回 source_file 也可能经过展示清理。为每个固定片段提供单独可映射的虚拟 source identity，或者用低层检索保留 ID 后自行融合；不依赖展示的 basename 还原真实证据。用相同内容不同来源、相同文件不同段、同名不同目录专门验收。

写操作仅由 omem projection worker 执行；提供给回答/提炼 Agent 的 MCP 只读，不把整个 MemPalace 管理/删除/挖掘工具集直接暴露出去。MemPalace 内部 KG/WAL 不能替代 omem 的审批和通知事务。

## 6. 薄适配器方案

```text
omem SourceRevision / FragmentRevision（权威）
  → 投影 outbox（幂等键、generation）
  → 独立 Python worker（MemPalace/可替换后端）
  → search 返回 candidate_id / rank / evidence mapping / truncation
  → omem 回查固定原件、有效性和 scope
  → Context Packet → TraeX/Codex/Claude ACP/CLI
```

omem 定义 `index(batch)`、`search(query,scope,k)`、`remove(ids)`、`health()`，Python sidecar 用 NDJSON 或 localhost HTTP；协议显式最大字节/超时/并发。读者进程与写者的锁/快照规则必须遵守上游，不在同 palace 下擅自并发打开多个写运行器。只读候选不会直接改正式事实。

证据仍保存在 omem；移除 sidecar 后原文、引用、已生效主张继续可读，检索降级为现有关键词路径。更换模型创建新索引 generation，对齐同一原件，构建完成后切换，旧 generation 可回退。

## 7. PoC 与明确的决策门

同一份本地脱敏中文语料和冻结问题集测试三条路线：A 当前关键词 baseline；B MemPalace 默认 vector/hybrid，再单列 union；C 同样 embedding+BM25 的薄组合。不要混用模型、切片、top-k/上下文预算后只比较最终最好分数。

先用 30 材料/20 轨迹/60 问题查正确性，再扩到 10k/100k 片段查资源。问题覆盖专名、错误码、时间变更、跨片段全证据、无答案和同名不同来源；中文英文混排单列。参数开发集与 holdout 按项目/时间隔开。

| 硬门 | 验收 |
| --- | --- |
| 证据映射 | 展示的每条候选100%能回查固定片段；同文不同源不得误合并 |
| 修改/删除 | 原件更新/撤回后旧候选可立即被 omem 过滤；侧边索引可以重建 |
| 离线 | 缓存预热后断网，普通摄入和检索不发外网请求；无 LLM provider 调用 |
| 可控性 | 不需要 fork 治理核心、侵入私有表或把 source_file basename 当 ID |
| 运维 | 独立环境可安装、关闭、重建；osdk 能复现 Python/权重，数据不进入依赖目录 |

软门：报告 Evidence Recall@10、All-support Recall@10、MRR、标准 NDCG、候选 token 数、p95、RSS、冷启动/下载、写入吞吐。项目初始目标 p95 检索≤2秒；质量需比 A 改善且无身份/权限回归。资源预算由真实机器测，不承诺“几分钟/几十MB就够”。

**采用规则**：硬门全通过且 B 质量/维护成本优于 C，使用 MemPalace sidecar；若只有高层 ID/去重不适配，先用其公开 BaseCollection 做最小封装再测；若需要持续 fork 大量治理/身份逻辑或中文收益不足，就选 C，并明确记录借鉴/复制代码的 MIT 归属。无论选择哪条，不把上游 R@5 承诺写成 omem 的服务指标。
