# 系统方案、当前缺口与改造入口

omem 的目标是让个人材料被读懂、找回并用于行动。文档、代码、聊天、图片和经历共享来源体系；AST 帮助定位代码，不另建代码知识产品。之前的整体 review 与 ACP/harness 讨论在本目录正式保存，不再只留在聊天中。

核心结论：固定原文、引用和独立模型复核是有用的底座，但不足以产生好文章、有效检索或持续理解。质量需要同时检查事实、讲解、问题覆盖和行动效果。“检查通过”“有多少引用”“覆盖了多少文件”不能替代这些结果。

## 现在做到哪里

截至 2026-10-03，已有统一捕获和固定版本、TS/Vue 结构定位、带章节/函数背景的全文与中文向量召回、长期记忆抽取及来源更新重核验、持久事项和共享引用阅读。ACP Agent 能原生调查、继续写作和独立补查：固定材料目录、原生 skill、只读 MCP 与最终候选提交；不再固定三轮调查或限制宿主输入输出 token。普通助手已接同一调查能力，网页保留综合回答与实际命中。新增材料用途、适用范围和段落概念入口，可由 AI 整理、人工修正并进入共享检索。实际排序、复杂 Wiki 的讲解和长期综合理解仍是主要缺口，不能由这些流程接通推导为质量已解决。

| 用户结果 | 现有基础 | 当前主要不足 | 改造位置 |
| --- | --- | --- | --- |
| 材料完整、可读 | Capture、原文版本、Markdown/AST 结构、正式材料用途 | 混合文档的章节性质不够细，多模态解析较浅；用途整理仍需触发 | store、knowledge/structure、source-profile/descriptions |
| 找到相关内容 | ICU/FTS5 BM25、中文 BGE、讲解与记忆、用途过滤、段落概念入口 | 长问题可能漏函数，主题相关不等于能回答；重排对照未证明可默认开启 | retrieval/units、unified、knowledge/agent-research |
| 看懂陌生系统 | 页面目的、案例、研究/写作/复核角色 | 本轮已接原生自主调查；复杂文章的可理解性仍需真实读者验收 | knowledge/pipeline、agent-runtime、agents |
| 理解代码含义 | 符号、导入、候选调用和设计关联 | AST 结构不能解释业务因果、设计动机和完整功能链 | 原生读文件/搜索、MCP 代码导航、背景材料 |
| 记住并主动使用 | claim/episode/procedure/task、重核验、提醒 | 缺少项目/人物/主题整合、事件时间与价值选择 | learning、memory、assistant |

## 从哪里继续读

- [整体复审](reader-first/review.md)：以前为何产生“正确但没帮助”的内容，以及当时和今天的差别。
- [当前实现逐层审查](reader-first/current-system.md)：清洗、RAG、代码、记忆、Wiki、ACP 的实际链路及缺口。
- [成熟组件如何融入与代码改造](reader-first/component-integration.md)：具体采用什么、进入哪个适配层、哪些代码要替换、怎样判断收益。
- [Agent 自主研究方案](reader-first/agent-research.md)：工具、材料工作区、原生 skills、会话、最终产物与独立补查复核。
- [助手检索与真实命中](reader-first/assistant-search-research.md)：新问题搜出了什么，成熟方案的适配、局限及现有代码改造入口。
- [材料用途与概念入口](reader-first/material-understanding.md)：本轮如何保存、查看和修正材料性质，怎样融入全文、向量及 Agent 搜索，哪些问题还没有解决。
- [中文重排与成熟检索评估](reader-first/retrieval-evaluation.md)：独立符号候选和同库对照；BGE、RRF、Qwen3、Zoekt 的采用状态及具体改造位置。
- [个人记忆与跟进流程](reader-first/assistant-memory-flow.md)：保存、提问、换版、更新及持续跟进的真实成功与失败。
- [写作与学习路线](reader-first/writing.md)：人如何由一个案例理解概念、机制、取舍并开始修改。
- [当前进度](reader-first/progress.md)：本轮实际完成和真实验证；设计内容不代表已交付。

## 交付方向

保存单位、检索单位和讲解单位分别设计。原件保留固定版本；检索按章节/函数/会话保留背景；文章跨材料回答读者问题。派生解释可以作为回答背景，但不重复计算为独立事实。

先改善真实检索，再让 traex 在材料快照中使用原生读取及知识工具自主调查、写作，独立审阅者也能补查。Agent 自带 harness 负责调查循环和上下文管理；omem 负责来源、选材、工具、任务与发布。后续比较成熟记忆组件，而不是默认再造整个平台。

当前方案与实施进度统一维护在 [reader-first](reader-first/README.md)。先看 [整体复审](reader-first/review.md)，再看 [实施进度](reader-first/progress.md)；方案不代表已交付。

此前的方案、实现记录、调研、原型与旧 README/AGENTS 已原样归入 [2026-10-01 历史档案](archive/2026-10-01-baseline/)。其中的“当前”、通过率、环境状态均指当时，不用于判断今天的能力。历史技术依据仍可引用，但应说明时间。

`repo-review/associations.json` 是运行中的显式关联配置，继续留在原位置；其中旧文档定位已指向 archive。`.repo-review/knowledge` 是实际模型产物，不是本目录中的设计文档。
