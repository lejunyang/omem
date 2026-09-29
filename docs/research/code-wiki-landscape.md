# Code Wiki / Code Knowledge 开源技术 landscape 与 omem 适配判断

调研日期：2026-09-28。方法：第 1–5 节为只读公开官方文档 / GitHub README / 规范文件的网页检索；第 6 节为用户提供的字节内部飞书文档，经 lark-cli 以用户身份读取（非浏览器）。**未安装任何外部服务、未下载模型权重、未克隆被测仓库、未向外部发送 omem 数据**。本文所有 URL 访问日期均为 2026-09-28；凡标注「未实测」的结论都没有在本机跑过，不写成既有保证。

评估对象对齐 omem 当前约束（见 [implementation/status.md](../implementation/status.md) 与仓库 AGENTS.md）：

- TypeScript + Vue 3 UI、Fastify API、SQLite 单用户；依赖由 osdk 管理（node 24，python 3.12 可选，本机未装 Docker）。
- **固定 revision + 固定 fragment ID**：材料按不可变版本切片，引用锚在具体 fragment 上；repo-review 当前关系锚在 head revision 的 fragment 上，**跨 revision fragment 身份续接尚未实现**。
- RetrievalPort 是可替换接口（当前为 SQLite 关键词召回，CJK 2-gram）；语义/embedding 检索尚未接线。
- 关系边唯一来源是手维护的 `docs/repo-review/associations.json`；未登记的代码↔文档关系**永远不会自动变成 confirmed**。
- 本地隐私优先：不要求任何 SaaS，模型端点可本地。

## 0. 一页结论

| 结论 | 内容 |
| --- | --- |
| 可直接复用的**组件/协议**（不引入平台） | ① **SCIP protobuf 数据模型**（per-snapshot 的 def/reference/moniker）作为 omem 代码索引的落盘格式参考；② **Tree-sitter**（Node 绑定）做 TS/Vue 结构化 outline 与语法感知切片；③ **Aider repo-map 算法**（tree-sitter tags + def/ref 二部图 + PageRank + token 预算）作为 RetrievalPort 的候选上下文组装器；④ 本地 embedding（BGE-M3 优先，osdk 锁权重）做语义召回投影。 |
| 为何不直接引入平台 | DeepWiki-open / OpenDeepWiki 是自带 DB+UI+LLM 编排的完整应用，生成的 wiki 散文不绑定 omem fragment；Sourcegraph Cody 客户端 Apache-2.0 但服务端私有；Continue 官网确认已并入 Cursor（GitHub 仓库未归档、仍 Apache-2.0 活跃推送）；CodeQL 对私有仓库需 GitHub Code Security 商业授权；Joern 是 JVM 安全分析平台、无 Vue；Docusaurus/VitePress/MkDocs 是静态发布层，没有交互引用弹窗与 revision 图；GraphRAG 的 LLM 抽边若直接 confirmed 会违反 omem「未登记边不得 confirmed」规则。 |
| PoC 门（按顺序，全部本地进程内、不起 Docker） | P1：Tree-sitter 在本仓库 TS+Vue 上抽符号，对照 `associations.json` 种子测准确率；P2：在 HEAD snapshot 上建一份 SCIP 风格 occurrence 表，验证 fragment↔符号 range 双向回链；P3：相邻 commit 间用「同名符号 + range 重叠率」做跨 revision fragment 身份启发式，在真实历史上测续接率；P4：BGE-M3 经 osdk 拉权重，在 RetrievalPort 后做 holdout 召回对照关键词基线，断网可跑；P5：repo-map PageRank 上下文注入 ACP，测「被引符号真实存在于上下文」的精度。 |
| 主要风险 | scip-typescript 近一年未发新版、对 `.vue` SFC 支持未确认；CodeQL 私有仓库授权；LLM 生成 wiki 散文会被误当证据；GraphRAG 社区摘要随 revision 过时；embedding 权重许可与体积需在 osdk `[models]` 中显式锁。 |

---

## 1. 类别①：代码 Wiki / 自动文档

### 1.1 DeepWiki（deepwiki.com，Cognition）

- 事实：deepwiki.com 是托管 SaaS，「up-to-date documentation you can talk to, for every repo」，产品形态是 GitHub 仓库对话式文档站。来源：https://deepwiki.com/ （2026-09-28 访问）。
- 未开源、不可自托管；omem 不能把仓库内容推到外部 SaaS（用户隐私优先约束）。
- 可借鉴的是**产品 UX**：文件树导航 + 每文件一页说明 + 对话式追问；不是可复用代码。

### 1.2 deepwiki-open（AsyncFuncAI/deepwiki-open）

- 事实：MIT 许可证（仓库根 LICENSE）；架构为 Next.js 前端（3000）+ FastAPI 后端（8001），克隆仓库后用 LLM 分层生成 wiki 页面，RAG 侧用 FAISS 向量检索，Docker Compose 部署，本地数据卷 `~/.adalflow`。来源：
  - https://deepwiki.com/AsyncFuncAI/deepwiki-open/1-deepwiki-open-overview
  - https://deepwiki.com/AsyncFuncAI/deepwiki-open/1.3-quick-start-guide
  - https://github.com/AsyncFuncAI/deepwiki-open （MIT 由其 LICENSE 文件确认；第三方核验站 https://ai-heartland.com/tool/deepwiki-open/ 亦记 MIT）
- 与 omem 的差距：
  1. 它是**完整应用**：自带仓库管理、用户配置、LLM 编排、向量库、前端；omem 已有自己的 API/Vue/SQLite，fork 它等于维护第二个产品。
  2. 生成的 wiki 页面是 **LLM 散文**，没有绑定到 omem 不可变 fragment 的引用链——按 omem 规则，这类内容只能是「候选文章」，必须把句子级证据重新绑定回 fragment 后才能提交。
  3. 部署推荐 Docker（本机未装 Docker，见 [integration-readiness.md](integration-readiness.md) 第 0 节）。
- 可复用：分层生成流水线的**顺序**（先定目录树 → 再逐页生成 → 再 RAG 对话）作为 omem 未来「Agent 生成层」的参考；生成产物在 omem 里落为 Proposal，不直接落为知识。

### 1.3 OpenDeepWiki（AIDotNet/OpenDeepWiki）

- 事实：.NET 9/10 + Semantic Kernel，MIT，支持 GitHub/Gitee/GitLab 仓库，有多分支多语言管理与 Graphify 可视化。来源：
  - https://deepwiki.com/AIDotNet/OpenDeepWiki/11-deployment-and-operations
  - https://deepwiki.com/AIDotNet/OpenDeepWiki/3-repository-and-warehouse-management
  - https://gitee.com/kugouming/OpenDeepWiki （明确「本项目采用 MIT 许可证」）
- 技术栈是 .NET，与 omem TypeScript 主线不匹配；定位与 deepwiki-open 同类，结论同上，不引入。

### 1.4 类别①小结

| 项 | 判断 |
| --- | --- |
| 许可证 | 两个开源克隆均 MIT |
| TS/Vue 语言支持 | 依赖 LLM 泛读，不做精确符号分析 |
| 增量 / commit 身份 | 按仓库分支重新生成；**没有 per-commit snapshot 锚定**，没有跨 revision fragment 身份 |
| 符号/调用/引用图 | 无；LLM 自由总结 |
| Agent 生成层 | 就是它本身；可借鉴流水线顺序 |
| 证据引用 | 不满足 omem「点击引用回原文 fragment」硬门 |
| 可视化 | 文件树 + 对话；OpenDeepWiki 有 Graphify |
| 本地部署 | Docker 多容器；本机无 Docker |
| omem 适配 | **不引入平台**；只把「分层生成 wiki」当作未来 Agent 生成层的候选流水线，产物必须回绑 fragment 才允许提交 |

---

## 2. 类别②：代码图谱 / 索引

### 2.1 SCIP（Source Code Intelligence Protocol）

- 事实：语言无关的索引协议，protobuf schema，用于 go-to-definition / find-references；是 LSIF 的继任者。官网：https://scip-code.org/ ；规范文件：https://github.com/sourcegraph/scip/blob/main/scip.proto （2026-09-28 访问，`syntax = "proto3"; package scip;`）；发布博客：https://about.sourcegraph.com/blog/announcing-scip （2022-06-09）。
- 模型要点：一个 `Index` 对应**一个 workspace snapshot**（仓库某次 checkout），里面是 `Document` → `Occurrence`（range + symbol 唯一字符串 + roles: definition/reference/…）→ `SymbolInformation`（含 documentation、relationships: is_implementation/is_reference 等）。这种「一个 snapshot 一份索引」与 omem **固定 revision** 模型天然对齐。
- TypeScript 支持：`@sourcegraph/scip-typescript`，基于官方 TypeScript typechecker，编译器级精确，npm 包 Apache-2.0，当前 0.4.0（https://www.npmjs.com/package/@sourcegraph/scip-typescript ，2026-09-28 访问）；发布说明 https://about.sourcegraph.com/blog/announcing-scip-typescript 。
- 限制（未实测，仅文档事实）：
  - scip-typescript 定位为 TypeScript/JavaScript indexer；官方文档未确认对 `.vue` SFC 的支持，PoC 时需实测，**不假设其支持或不支持**；Vue 文件无论如何都要走 Tree-sitter 那条路径。
  - npm 显示该包近一年未发新版（「Last publish a year ago」），长期维护性需在 PoC 时确认是否需要 fork。
  - SCIP occurrence 主要覆盖定义/引用/实现关系；**调用边（call graph）不是它的强项**，tsc 层面也不完整。
- 许可证：scip 仓库本身 MIT（scip-code.org 与 pkg.go.dev 页面未单独标注相反许可证；scip-typescript 为 Apache-2.0）。PoC 时以届时 pinned commit 的 LICENSE 为准。

### 2.2 LSIF

- 事实：Language Server Index Format，社区站点 lsif.dev 已明确「This project is now archived. LSIF has been superseded by SCIP」。来源：https://lsif.dev/ （2026-09-28 访问）。
- 判断：新项目不再采用 LSIF；只需知道 GitLab 等老工具仍读 LSIF（https://docs.gitlab.com/ee/ 内 code_intelligence 文档提到 SCIP→LSIF 转换），omem 无此兼容负担。

### 2.3 Tree-sitter

- 事实：parser generator + 增量解析库，能在编辑时只重解析变化的子树，即使有语法错误也给出可用 CST。官方：https://tree-sitter.github.io/tree-sitter/ 。官方 upstream parser 列表含 TypeScript、TSX；**不含 Vue**（`https://api.github.com/repos/tree-sitter/tree-sitter-vue` 返回 404，2026-09-28 核验）。Vue grammar 实际由社区维护：https://github.com/tree-sitter-grammars/tree-sitter-vue —— 是 ikatyang/tree-sitter-vue 的 fork，MIT，`archived=false`，2026-09-13 仍有 push，**不是 tree-sitter 官方 grammar**。`tree-sitter-typescript` npm 包 MIT。
- 许可证：runtime 与官方 grammar 均 MIT；Vue grammar 为社区 MIT fork。
- 与 SCIP 对比：Tree-sitter 是**语法级**（CST，无类型解析），但胜在轻量、增量、多语言（Vue 走社区 grammar）、有 Node 绑定；SCIP 是**编译器级**（TS 精确类型），但重、快照式，且 `.vue` SFC 支持未确认。
- omem 适配点：
  - 在每个 revision 上对变化文件重跑 Tree-sitter，产出「类/函数/方法/import」outline 作为 fragment 分组依据（语法感知切片，不把一个函数切成两半）。
  - 本机无 Docker、osdk 管 node，Tree-sitter 原生 node 绑定可直接进依赖，符合「本地隐私优先」。

### 2.4 CodeQL

- 事实：GitHub 的语义代码分析平台，把代码抽成可查询数据库，跑 CodeQL 规则查漏洞/错误。支持语言含 JavaScript/TypeScript（官方支持页列 TypeScript 2.6–7.0，走标准 tsc）。来源：https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/ ；工具列表 https://codeql.github.com/docs/codeql-overview/codeql-tools/ 。
- 许可证关键事实（必须准确）：CodeQL CLI 对**公开仓库 / OSI 认证开源仓库**免费；**私有仓库**需要 GitHub Team / Enterprise Cloud 且购买 GitHub Code Security 授权。来源：https://docs.github.com/en/code-security/codeql-cli/using-the-codeql-cli/about-the-codeql-cli （2026-09-28 访问）。
- 2.22.2 changelog 提到 TypeScript extracter 不再填充 `Type`/`Symbol` 类（https://codeql.github.com/docs/codeql-overview/codeql-changelog/codeql-cli-2.22.2/ ）——即使付费，TS 侧的类型查询能力也在收缩。
- 判断：omem 是个人私有项目，**CodeQL 的授权模式与本地免费轻量需求不匹配**；它是安全扫描平台，不是给个人 wiki 做引用图的组件。不引入。

### 2.5 Joern

- 事实：开源代码分析平台，基于 Code Property Graph（CPG，2014 IEEE S&P 论文，2024 Test-of-Time），Apache-2.0，Scala DSL 查询。前端覆盖 C/C++/JVM 字节code/LLVM/x86/Ghidra/JavaScript；官网自述「Python, Java source, Kotlin, PHP support coming soon」。来源：https://joern.io/ 、https://docs.joern.io/code-property-graph/ 、https://github.com/joernio/joern （Apache-2.0，Homebrew formulae 亦印证）。
- 判断：定位是**漏洞挖掘/安全研究**，JVM 栈重，无 Vue，无 TS 精确类型；与 omem 个人知识库场景错配。不引入。

### 2.6 类别②小结

| 工具 | 许可证 | TS | Vue | 增量 | commit 快照身份 | 图类型 | omem 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SCIP | 规范 MIT / scip-typescript Apache-2.0 | 编译器级 | 未确认（TS/JS indexer，未实测 SFC） | 每 snapshot 全量重建（快） | **原生就是 per-snapshot** | def/ref/实现/moniker；调用边弱 | 数据模型可借；TS indexer 可 PoC |
| LSIF | 社区规范 | — | — | — | — | — | 已归档，不采用 |
| Tree-sitter | MIT | 官方 grammar | **社区 grammar**（tree-sitter-grammars/tree-sitter-vue，MIT fork，非官方） | **编辑级增量子树复用**（omem 用不到那么细） | 文件级重解析即可 | CST outline、可写自定义 query 抽 def/import | 首选轻量结构化层 |
| CodeQL | CLI 公开仓库免费；**私有仓库需商业授权** | 有（类型类在收缩） | 否 | per-commit 数据库 | per-commit 数据库 | 丰富查询图（安全导向） | 授权+栈错配，不引入 |
| Joern | Apache-2.0 | JS 前端 | 否 | CPG 全量 | per-project | AST+CFG+PDG 融合图 | 安全研究导向，不引入 |

---

## 3. 类别③：LLM 代码理解 / 代码 RAG

### 3.1 Sourcegraph Cody

- 事实：Cody 客户端 2023-03-28 以 Apache-2.0 开源（https://about.sourcegraph.com/blog/open-sourcing-cody ）；它的差异化是走 Sourcegraph **code graph**（符号级精确上下文），而不是 embed 代码片段。来源：https://learn.engineering.vips.edu/frameworks/cody-sourcegraph 。
- 现状（2026-09-28）：客户端仓库已转 public snapshot 归档（https://github.com/sourcegraph/cody-public-snapshot ，License Apache-2.0）；后端 Sourcegraph 平台对企业是私有授权。来源：https://recatools.com/ai-directory/sourcegraph-cody/ 。
- 判断：产品形态是 IDE 插件，不是可嵌入库；可借鉴的**设计原则**是「先取精确符号上下文，再喂模型」，而不是把整库切块 embed。

### 3.2 Continue

- 事实：VS Code / JetBrains 开源 AI 编程助手，Apache-2.0，模型无关（可接 Ollama 本地模型，代码不出本机），本地维护代码库 embedding 索引。来源：https://continue.dev/ 、https://aiwiki.ai/wiki/continue_dev 。
- 关键现状：官网首页明确「Continue has joined Cursor」（https://continue.dev ，2026-09-28 访问）；GitHub 仓库 continuedev/continue **未归档**（`archived=false`）、Apache-2.0，截至 2026-09-28 仍有 push（https://github.com/continuedev/continue ，API 核验 https://api.github.com/repos/continuedev/continue ）。无官方页面锚定具体收购月份，本文不断言收购发生在某月，也不断言开源仓库只读或商业 Hub 停售。
- 判断：参考实现价值仍在（local embedding index + context provider 架构）；被 Cursor 收购后的上游治理走向待观察，不作为长期依赖上游的库；不 fork。

### 3.3 Aider repo-map（最值得借的算法）

- 事实：Aider（Apache-2.0）用 Tree-sitter 抽每个文件的定义/引用 tags，构建 def↔ref 二部图，跑 **PageRank** 给全库符号排序，再按 token 预算二分裁剪成「repo map」塞进 system prompt。来源：
  - 官方博客 https://aider.chat/2023/10/22/repomap.html （2023-10-22）
  - 官方文档 https://aider.chat/docs/repomap.html
  - 实现剖析：https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping （tags.scm 按语言配置，`to_tree()` 输出层级树）
- 工程细节：tag 缓存按 mtime 落盘；130+ 语言复用同一 pipeline；Tree-sitter 增量且容错。
- 与 omem 的契合：
  - 输入就是「revision 快照」，输出是**带文件:行号的符号列表**——天然可映射回 omem fragment。
  - 不需要类型检查器，TS+Vue 都能跑；无 LLM 调用，完全本地。
  - 这正是 RetrievalPort 缺的那一层：当前 KeywordRetrieval 是词面召回，repo-map 提供「与当前任务相关的符号子图」候选。
- 判断：**移植算法思想（不 fork 代码）**到 omem：Tree-sitter 抽 tags → 本地 SQLite 邻接表 → PageRank → top-K 符号 fragment 注入 ACP 上下文。

### 3.4 类别③小结

| 工具 | 许可证 | 代码上下文策略 | omem 判断 |
| --- | --- | --- | --- |
| Cody | Apache-2.0 客户端 / 服务端私有 | code graph 精确符号检索 | 借鉴原则，不引入 |
| Continue | Apache-2.0（官网确认并入 Cursor；仓库未归档、仍活跃） | 本地 embedding index | 参考架构，不引入 |
| Aider repo-map | Apache-2.0 | Tree-sitter tags + PageRank + token 预算 | **移植算法到 RetrievalPort** |

---

## 4. 类别④：文档站与知识图谱

### 4.1 Docusaurus / VitePress / MkDocs

- 事实（均为静态站点生成器，构建期产物为纯 HTML）：
  - Docusaurus：Meta 维护，React，MIT，内置版本化文档/i18n/插件。官方 https://docusaurus.io/ 。
  - VitePress：Vue 3 + Vite，MIT，轻量、内置搜索。官方 https://vitepress.dev/ （经 https://vitepress.mosong.cc 等第三方对比页交叉确认 OSS）。
  - MkDocs：Python，BSD 许可证（Material for MkDocs 同生态）。对比见 https://docsio.co/blog/vitepress 、https://okidoki.dev/documentation-generator-comparison 。
- 判断：三者都是**人写 Markdown → 静态站**的发布层；omem 的阅读台是交互式「引用弹窗 → 跨 fragment 下钻 → 原位追问」（design.md 第 1 节），不是静态站。技术栈上 VitePress 与 Vue3 最近，但它 build 后无后端、无 revision 图、无引用回链。**不引入**；omem 现有 Vue 阅读台就是自己的「文档站」。

### 4.2 Microsoft GraphRAG

- 事实：MIT 许可证的 Python 数据管线，用 LLM 从非结构化文本抽实体/关系，做层次社区检测，为每个社区生成摘要（community report）；查询分 local search（实体邻域 + 原文 chunk）、global search（对社区摘要 map-reduce）、DRIFT search、basic vector RAG 基线。来源：
  - 仓库 https://github.com/microsoft/graphrag （MIT）
  - 论文 https://arxiv.org/pdf/2404.16130
  - 配置参考 https://github.com/microsoft/graphrag/blob/main/docs/config/yaml.md
- 与 omem 的关系：
  - GraphRAG 抽出来的实体/关系是 **LLM 判断**，按 omem 规则只能进 `candidate` 边，不能自动 `confirmed`——这正好对应 repo-review 已有的 `candidate_for`/`missing` 状态机与手维护 associations.json 流程。
  - 但它是 Python 管线，每次 revision bump 都要重跑 LLM 抽取，成本高；社区摘要会随原文版本过时。
- 判断：**延后**。未来若需要「跨文档主题概览」，把 GraphRAG 当作 candidate-edge 生成器，人工/Agent 复核后才进 associations.json；不做自动 confirmed。

### 4.3 类别④小结

静态站生成器解决「发布」，omem 解决「证据图 + 下钻」，不重叠；GraphRAG 解决「LLM 抽图」，但其产物必须过 omem 的 candidate 门禁，直接引入会违反既有关系治理规则。

---

## 5. 类别⑤：本地隐私优先的增量解析

### 5.1 增量解析粒度

- Tree-sitter 的增量是**编辑器按键级**（https://tree-sitter.github.io/tree-sitter/ 自述「efficiently update the syntax tree as the source file is edited」）。omem 的同步单位是 **git commit snapshot**，不存在按键编辑，所以「文件变了就重解析该文件」已足够；不需要引入编辑器级增量状态。
- omem 当前 repo-review sync 是对文本文件做 fragment 切分（apps/server/src/review/sync.ts）；Tree-sitter 能把切分边界对齐到函数/类节点，避免把一个函数切成两个不相邻 fragment——这是 P1 PoC 要量的收益。

### 5.2 本地 embedding

- BGE-M3：智源 BAAI 开源，支持 100+ 语言，同时输出 dense / multi-vector / sparse 三种向量，长上下文，代码仓库 `FlagOpen/FlagEmbedding`，免费商用许可。来源：https://arxiv.org/html/2402.03216v3/ 、https://bge.baai.ac.cn/ 。中文优先场景下比英文 MiniLM 基线更合适（MemPalace PoC 已指出默认 all-MiniLM 是英文训练，见 [mempalace/README.md](mempalace/README.md)）。
- nomic-embed-text：Apache-2.0，8192 上下文，英文为主，开放权重+开放数据+训练代码。来源：https://www.nomic.ai/news/nomic-embed-text-v1 、技术报告 https://arxiv.org/html/2402.01613 。
- 部署方式：通过 osdk `[models]` 拉不可变 HF 快照（osdk 能力见 [integration-readiness.md](integration-readiness.md) 第 5 节），进程内 ONNX/推理，**不需要 Docker、不需要外部 API**；这与 omem「本地隐私优先、断网可跑」一致。

### 5.3 跨 revision fragment 身份（omem 当前最大缺口）

- 现状：repo-review 关系锚在 head revision fragment；代码改完产生新 revision 后需重新 sync，旧关系指向旧 fragment id（AGENTS.md 已明确「跨 revision fragment 身份续接未实现」）。
- 可借鉴的启发式（不是某个开源产品的现成功能，而是组合）：
  1. 用 Tree-sitter 给每个顶层符号节点算 **AST 结构哈希 + 符号名**；
  2. 相邻 revision 间，同名 + 文本 range 重叠率超阈值即视为同一 fragment 的续接；
  3. 匹配不上的旧边标「历史版本」，不强行漂移（与 repo-review 现状一致）。
- 这与 SCIP moniker 的思路一致（SCIP 用稳定 symbol 字符串跨文件定位），但 omem 只需做到 fragment 级续接，不需要跨仓库 moniker。

---

## 6. 用户提供的内部架构材料： DeepWiki

> 本节来自用户提供的飞书文档，通过 `lark-cli docs +fetch --as user` 以用户身份读取（2026-09-28，revision 817）。**这是内部产品自述/设计稿，不是开源实现，未经公开代码核验；本节事实与第 1–5 节公开开源事实严格分开，不得互为佐证，也不进入第 7 节横向对比总表。**

### 6.1 问题与目标（原文）

- 「企业内部代码文档缺失/脱节极大影响了信息传递」；目标是「借助智能体技术，通过分析代码仓库的结构和功能，自动生成结构化的Wiki文档」，同时服务研发与非研发同学。
- 产品定位：「让读者更快了解一个代码库、模块，提供高维抽象后的知识总结；而对于代码细节的深究，则可以借助 Ask 继续深入了解」。
- 设计理念三条：突出重点由表及里（先整体概览再按关键主题分析，**明确不走传统静态代码分析生成文档的路线**）；千仓千面（应用框架→API/核心概念，应用服务→架构/模块/部署，插件→集成/安装/使用）；代码原生 & 有生命的 Wiki（以 Markdown 撰写，未来开放下载与开发者直接参与）。

### 6.2 Agent 分工与管线（原文组件名）

- 顶层代理 **RepoWikiAgent**：核心控制器，协调整个生成流程、管理阶段执行顺序与状态、对接 Git 仓库与 Wiki 平台。
- 专用代理：**ClassifierAgent**（分析仓库结构、代码分类、选 Wiki 模板）、**OverviewAgent**（生成概览与章节介绍、识别核心抽象概念）、**ChapterWriterAgent**（为每个抽象概念生成详细章节）。
- 工具层：ReadFileAction / ListDirectoryAction / GlobSearchAction / GrepSearchRangeAction / ExecuteCommandAction / CodebaseSearchAction（可选）/ Mermaid 图表工具（直接生成 mermaid 语法的 markdown 文本）。
- 知识库层：条目含 ID、名称、解释、匹配模式；支持精确匹配与正则匹配两种查找方式。
- 设计模式：串行阶段、Chapter 嵌套组合、按仓库类型（前端项目/Monorepo 等）策略、工厂创建代理与工具、Publisher 观察者报进度。
- 串行流程：准备项目环境 → 探索仓库 → 分类仓库 → 生成章节概述 → 生成章节详细内容 → 上传 Wiki 内容。

### 6.3 代码索引 / 知识生成 / 更新机制：文档说了什么、没说什么

**文档明确说了的**：仓库探索自动识别核心文件和目录；代码分类组织；概览含高级概述与组件关系图；逐核心组件章节写作；内容优化重写；Mermaid 可视化；前端/Monorepo 特殊处理（框架识别 React/Vue、构建工具 Webpack/Vite、包管理器 npm/yarn、Monorepo 子包关系）；可选 `getRelevantCode` / `NewCodebaseSearchAction` 补充相关代码片段。

**文档没说、必须标为未核验的缺口**：

- 未说明代码索引技术栈（AST？embedding？SCIP？）——可见的探索手段就是 ReadFile/Glob/Grep/可选 CodebaseSearch 这一类 agent 工具调用。
- 未说明 commit/snapshot 身份模型；只提「阶段性维持 Wiki 内容与代码一致」，无增量/重生成机制。
- 未说明符号/调用/引用图；「核心文件和目录怎么定义」在评论区被提问，正文未答。
- 知识库层内部实现被评论区追问，正文未答。
- 评测数据、资源占用、更新触发时机均未给出。
- 评论区作者（韩欣）补充：Wiki 存储「正在升级到 git」，之后开放下载/编辑，用户可改 `.wiki` 下配置引入扩展知识或直接改生成的 markdown；UI 已有 wiki clone 链接；字节云有 MCP 但「问答的能力尚未在 mcp 中提供，后续会开放」。

### 6.4 产品交互

高维 Wiki 阅读（文件树/章节/Mermaid 关系图）+ 「Ask」对仓库内问题下钻（原文示例：「xx 能力是如何实现的？」「xx 函数都在哪里被调用？」「如何使用 xx 功能/配置？」）。

### 6.5 omem 概念映射

| DeepWiki 自述 | omem 对应 | 判断 |
| --- | --- | --- |
| Git 仓库 → 仓库探索 | CodeRepository + 现有 file/Git connector | 概念一致 |
| （未说明） | Snapshot / 固定 revision / 不可变 fragment | **缺口**：它无 per-commit 锚定；omem 的固定 fragment 身份是它没有的硬约束 |
| 核心文件、抽象概念、组件关系图（Mermaid） | Symbol / Edge（repo-review 的 implements/requires/decided_by/researched_by/tested_by/candidate_for） | 它的关系是 LLM 生成的展示图，无 confirmed/candidate/missing 状态；omem 手维护 associations.json 的治理更严 |
| Wiki 章节（Markdown 散文） | Understanding / 候选文章 | **方向一致**：LLM 生成内容只能是候选，回绑 fragment 证据后才允许提交——与第 1.2 节对 deepwiki-open 的判断互相印证 |
| ClassifierAgent → OverviewAgent → ChapterWriterAgent | omem extractor/planner/writer role bundles | 分工流水线可借鉴：先分类选模板 → 再概览 → 再逐章写 |
| 知识库层（ID/名称/解释/匹配模式，精确+正则） | source-profile 确定性规则 / project_trusted 软过滤 | 可借鉴为注入领域术语表；但 omem 规则不冒充语义证据 |
| 千仓千面模板策略 | source-profile 规则分析 | 思路一致 |
| Ask 下钻 | Web 阅读台引用弹窗 + 原位追问 | 产品方向一致 |
| Wiki 迁 git、可 clone、可改 markdown | omem 导出带固定引用 ID 的 Markdown | 方向一致；omem 已把 Git 当导出目标而非在线写入协调器 |

### 6.6 对本调研结论的影响

- 不改变第 1–5 节任何开源事实；该文档是内部产品自述，不进入横向总表。
- 两点反向印证：①「LLM 生成 Wiki 散文 + agent 工具探索式索引」是行业主流，但都未解决 omem 的「fragment 级证据回链 + 跨 revision 续接」——这仍是 omem 差异化内核；②「分类 → 概览 → 逐章写作」串行分工可作为 omem 未来 Agent 生成层的流水线参考。
- 风险提示：文档自述「发展初期」「Wiki 内容与问答能力仍有较大进步空间」，评论区暴露核心文件定义、知识库实现、问答 MCP 均未完成——**不得把文中能力当作已上线生产实现引用**。

---

## 7. 横向对比总表

| 维度 | DeepWiki/SaaS | deepwiki-open | OpenDeepWiki | SCIP | Tree-sitter | CodeQL | Joern | Cody | Continue | Aider repo-map | Docusaurus/VitePress/MkDocs | GraphRAG |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 许可证 | 私有 SaaS | MIT | MIT | 规范 MIT / indexer Apache-2.0 | MIT | 公开仓库免费；**私有需商业授权** | Apache-2.0 | Apache-2.0 客户端 | Apache-2.0（仓库未归档） | Apache-2.0 | MIT / MIT / BSD-2 | MIT |
| TS 精确 | n/a | LLM 泛读 | LLM 泛读 | **编译器级** | 语法级 | 编译器级 | JS 前端 | 编译器级 | embedding | 语法级 | n/a | 文本抽取 |
| Vue 支持 | n/a | 是（文件级） | 是 | 未确认（TS/JS indexer，未实测 SFC） | 社区 grammar（tree-sitter-grammars，MIT，非官方） | 否 | 否 | 否 | 是（文件级） | 是（grammar 生态） | n/a | 文本 |
| per-commit 锚定 | 否 | 否 | 多分支 | **原生** | 可按文件快照 | per-commit DB | per-project | 依赖后端 | 文件 mtime | mtime 缓存 | build 时 | 全量重抽 |
| 调用/引用图 | 无 | 无 | 无 | def/ref 强、调用弱 | 可自定义 query | 强（安全查询） | CPG 强 | 强 | 无 | def/ref 二部图 | 无 | LLM 实体关系 |
| Agent 生成层 | 产品本身 | **产品本身** | 产品本身 | 无 | 无 | 查询 DSL | Scala DSL | IDE 插件 | IDE 插件 | 上下文组装 | 无 | **LLM 抽图** |
| 证据引用回原文 | 否 | 否 | 部分 | 是（range） | 是（range） | 是 | 是 | 是 | 否 | 是（file:line） | 否 | chunk 引用 |
| 本地无 Docker 可跑 | 否 | 推荐 Docker | Docker | **是（node CLI）** | **是（node 原生）** | 需 CLI+构建 | JVM | 否 | IDE 插件 | **是（python）** | 是 | 是（python） |
| omem 处置 | 仅 UX 参考 | 不引入 | 不引入 | **借数据模型** | **引入依赖** | 不引入 | 不引入 | 原则参考 | 架构参考 | **移植算法** | 不引入 | 延后做 candidate 边 |

---

## 8. PoC 门与风险（按执行顺序）

所有 PoC 都在本机 node/python 进程内跑，不起 Docker、不连外部 LLM 做证据写入。

1. **P1 Tree-sitter outline（TS+Vue）**：osdk 加 node 依赖，对本仓库 `.ts/.vue` 抽函数/类/import；以 `docs/repo-review/associations.json` 的 23 个 seed 里点名的 codePath+symbol 为金标准，测抽出的 symbol 命中率与误报。门：命中 seed symbol ≥ 阈值且无崩溃。
2. **P2 SCIP 风格 occurrence 表**：参考 scip.proto 的 Document/Occurrence/SymbolInformation 字段，在 HEAD snapshot 上落一张 SQLite 表；验证「fragment → 它包含的 symbol → 该 symbol 的所有引用」一跳可查。门：range 双向回链一致，重建幂等。
3. **P3 跨 revision fragment 续接启发式**：取本仓库最近 N 个 commit，用「同名符号 + range 重叠率」匹配前后 revision 的 fragment，统计续接率；匹配不上的按现有逻辑标「历史版本」。门：误续接率可忽略（<5%），宁可断开不可错接。
4. **P4 本地 embedding RetrievalPort**：osdk `[models]` 锁 BGE-M3 快照，实现第二个 RetrievalPort 后端；在 repo-review 现有语料上与 KeywordRetrieval 做 holdout 对照；验证断网运行零外网请求。门：召回质量不低于关键词基线（否则不切），且缓存预热后离线可跑。
5. **P5 repo-map PageRank 上下文**：把 P1 的 tags 邻接表跑 PageRank，top-K 符号注入 ACP 上下文；测「模型实际引用的符号是否在注入集合内」。门：引用精确率达标，token 预算可控。

> 说明：P1–P3（Tree-sitter outline、SCIP 风格 occurrence、跨 revision fragment 续接）是当前代码索引主线，**不依赖 embedding，可独立完成**；P4 语义召回是平行的独立项，不是 P1–P3 的前置门，按语料需要再排期。

风险：

- scip-typescript 维护节奏不明（近一年未发新版）；若 P2 需要 TS 精确语义，要预留 fork/pin 时间。
- Vue SFC 里 `<script setup>`/`<template>` 的符号解析依赖社区维护的 tree-sitter-grammars/tree-sitter-vue（非 tree-sitter 官方 grammar，fork 自 ikatyang/tree-sitter-vue），其成熟度与 `<script setup>` 覆盖度 P1 必须实测，不能假设。
- LLM 生成的 wiki 散文（deepwiki-open 那类）若被误存为 evidence，会污染引用链——治理上必须落在 Proposal/candidate 层。
- GraphRAG/社区摘要随 revision 过时，且 LLM 调用成本在个人机器上不可忽略；只在 candidate 边需求被验证后再上。
- embedding 权重许可与体积必须在 osdk `[models]` 里显式 pin，不允许运行时隐式下载。
- 本机无 Docker：任何 PoC 都不能假设 compose 环境；与 [integration-readiness.md](integration-readiness.md) 第 0 节结论一致。

---

## 9. 来源清单（访问日期均为 2026-09-28）

- DeepWiki SaaS：https://deepwiki.com/
- deepwiki-open 概述：https://deepwiki.com/AsyncFuncAI/deepwiki-open/1-deepwiki-open-overview ；Quick Start：https://deepwiki.com/AsyncFuncAI/deepwiki-open/1.3-quick-start-guide
- OpenDeepWiki 部署：https://deepwiki.com/AIDotNet/OpenDeepWiki/11-deployment-and-operations ；架构：https://deepwiki.com/AIDotNet/OpenDeepWiki/3-repository-and-warehouse-management ；Gitee 镜像（MIT 声明）：https://gitee.com/kugouming/OpenDeepWiki
- SCIP 官网：https://scip-code.org/ ；proto：https://github.com/sourcegraph/scip/blob/main/scip.proto ；发布博客：https://about.sourcegraph.com/blog/announcing-scip
- scip-typescript npm：https://www.npmjs.com/package/@sourcegraph/scip-typescript ；发布博客：https://about.sourcegraph.com/blog/announcing-scip-typescript
- LSIF 归档说明：https://lsif.dev/
- Tree-sitter 官网与 parser 列表：https://tree-sitter.github.io/tree-sitter/ ；Vue grammar 为社区 fork（非官方）：https://github.com/tree-sitter-grammars/tree-sitter-vue ；官方路径 404 核验：https://api.github.com/repos/tree-sitter/tree-sitter-vue
- CodeQL 支持语言：https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/ ；CLI 授权：https://docs.github.com/en/code-security/codeql-cli/using-the-codeql-cli/about-the-codeql-cli ；TS extractor 变更：https://codeql.github.com/docs/codeql-overview/codeql-changelog/codeql-cli-2.22.2/
- Joern 官网：https://joern.io/ ；CPG 文档：https://docs.joern.io/code-property-graph/
- Cody 开源公告：https://about.sourcegraph.com/blog/open-sourcing-cody ；仓库快照：https://github.com/sourcegraph/cody-public-snapshot
- Continue 官网与收购公告：https://continue.dev/ ；仓库状态核验：https://github.com/continuedev/continue （API https://api.github.com/repos/continuedev/continue ：archived=false、Apache-2.0、2026-09-28 仍有 push）
- Aider repo-map 博客：https://aider.chat/2023/10/22/repomap.html ；文档：https://aider.chat/docs/repomap.html ；实现剖析：https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping
- Docusaurus：https://docusaurus.io/ ；VitePress/MkDocs 对比：https://docsio.co/blog/vitepress 、https://okidoki.dev/documentation-generator-comparison
- GraphRAG 仓库：https://github.com/microsoft/graphrag ；论文：https://arxiv.org/pdf/2404.16130 ；配置：https://github.com/microsoft/graphrag/blob/main/docs/config/yaml.md
- BGE-M3：https://arxiv.org/html/2402.03216v3/ ；官网 https://bge.baai.ac.cn/ ；nomic-embed-text：https://www.nomic.ai/news/nomic-embed-text-v1
- 内部材料（非公开源事实，见第 6 节）：《DeepWiki：基于智能体深度理解的代码知识库》 
