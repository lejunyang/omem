# 上游源码核验索引

核验日期：2026-09-26。以下为研究时的源码快照，不是生产依赖锁定文件；正式接入选择 release/digest 并重跑契约测试。完整文件 URL 和内容 SHA-256 见 [sources.json](sources.json)。

| 项目 | 核验 commit | 许可证（正文核验） | 检查内容 |
| --- | --- | --- | --- |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | [`4a319ecdc14f`](https://github.com/HKUDS/LightRAG/tree/4a319ecdc14f36446ae98b34952ab6719b2c322b) | MIT | LICENSE, README.md |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | [`2c050bc9681a`](https://github.com/NevaMind-AI/memU/tree/2c050bc9681a4c0aff1af211a000e73d14f33356) | Apache-2.0 (LICENSE.txt) | LICENSE.txt, README.md |
| [Tencent/WeKnora](https://github.com/Tencent/WeKnora) | [`4364e61afa4b`](https://github.com/Tencent/WeKnora/tree/4364e61afa4bf1e086c34b4220bb21449aa15b25) | MIT (project core; third-party notices apply) | LICENSE, README.md, internal/handler/chunk.go, internal/handler/knowledge.go, internal/handler/knowledgebase.go, internal/router/router.go, internal/types/chunk.go, internal/types/knowledge.go, internal/types/knowledge_span.go, internal/types/search.go |
| [WujiangXu/A-mem](https://github.com/WujiangXu/A-mem) | [`0c8039f28fdc`](https://github.com/WujiangXu/A-mem/tree/0c8039f28fdcc08189a23c07a3437d9d2482f9c2) | MIT | LICENSE, README.md |
| [deepset-ai/haystack](https://github.com/deepset-ai/haystack) | [`8a5406eea71a`](https://github.com/deepset-ai/haystack/tree/8a5406eea71a0fc19e94c4b9a5cd96df2158a45a) | Apache-2.0 | LICENSE, README.md |
| [docling-project/docling](https://github.com/docling-project/docling) | [`2d5c590c34b6`](https://github.com/docling-project/docling/tree/2d5c590c34b6378fd8a47c65b534b280aa40c93c) | MIT | LICENSE, README.md |
| [getzep/graphiti](https://github.com/getzep/graphiti) | [`92de3ac15cd4`](https://github.com/getzep/graphiti/tree/92de3ac15cd40295f69f311b6f3674c5cc634b48) | Apache-2.0 | LICENSE, README.md |
| [infiniflow/ragflow](https://github.com/infiniflow/ragflow) | [`313ca90f6abd`](https://github.com/infiniflow/ragflow/tree/313ca90f6abd7682fe8523e16fd67b3653a3fa84) | Apache-2.0 | LICENSE, README.md |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | [`7daa3ab49d67`](https://github.com/langchain-ai/langgraph/tree/7daa3ab49d678a5da75edb08baa87db4a2be52c3) | MIT | LICENSE, README.md |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | [`9d033b47d9ce`](https://github.com/langchain-ai/langmem/tree/9d033b47d9ce53e37e92c92241b0496c0278932e) | MIT | LICENSE, README.md, docs/docs/concepts/conceptual_guide.md |
| [letta-ai/letta](https://github.com/letta-ai/letta) | [`5bcdd177d70f`](https://github.com/letta-ai/letta/tree/5bcdd177d70fa2b31a754cfcd801e77b2e1ab16a) | Apache-2.0 | LICENSE, README.md |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | [`94c3fe9f238f`](https://github.com/mem0ai/mem0/tree/94c3fe9f238f3dbf29c9ce98643bd71eb13077cd) | Apache-2.0 | LICENSE, README.md |
| [pgvector/pgvector](https://github.com/pgvector/pgvector) | [`7db2345ed99b`](https://github.com/pgvector/pgvector/tree/7db2345ed99bc77bf33cbdc8b12bd1973210dc81) | PostgreSQL | LICENSE, README.md |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | [`cf8311c42dfe`](https://github.com/run-llama/llama_index/tree/cf8311c42dfe57bcd6bf106424481c808307ee61) | MIT | LICENSE, README.md |
| [temporalio/temporal](https://github.com/temporalio/temporal) | [`d8f9c6d86b2c`](https://github.com/temporalio/temporal/tree/d8f9c6d86b2cd0ea5c27d0694a598da84c6d337d) | MIT | LICENSE, README.md |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | [`eb90d0374075`](https://github.com/topoteretes/cognee/tree/eb90d03740755f5252b8b12cce91fd09970f2d81) | Apache-2.0 | LICENSE, README.md |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | [`a921929a0e0e`](https://github.com/vectorize-io/hindsight/tree/a921929a0e0ea82fb49da1daa0ca3e152e41fcc1) | MIT | LICENSE, README.md, hindsight-clients/go/api/openapi.yaml |

GitHub SPDX 对 WeKnora、memU、pgvector 返回 NOASSERTION；已分别读取 LICENSE、LICENSE.txt、LICENSE 正文。NOASSERTION 不代表闭源。没有依据 star 数或供应商宣称的 benchmark 做选型。

输入材料：

- [用户参考架构](https://bytedance.larkoffice.com/docx/IE9MdkecjoeQJMxguhPcEEGonle)，读取 revision 19。
- [用户参考调研](https://bytedance.larkoffice.com/docx/Xgu9dO86aosrGrx7xVrcl6xbnif)，读取 revision 18，并下载查看其中两张架构画板。
- 旧 agent-knowledge 只读抽查：commit `f7cd0dd186779c56e7d672f358b08e59d5771f79`；README、AGENTS、src/retrieval/contextPacket.ts、src/ingestion/types.ts、web 页面与目录。没有运行旧项目测试，也没有把旧实现问题判定为已复现 bug。
- 用户附件《企业知识管理系统-前端设计稿.html》：黑白灰、目录/阅读/问答三栏、层叠弹窗、圈选提问。示例里的企业政策与 Gartner 数字是演示素材，不作为本项目事实依据。

原始内部文档响应保留在本机临时研究目录，不复制到本仓库；这里保留来源和读取版本以便重查。
