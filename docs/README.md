# 系统方案、当前缺口与改造入口

omem 的目标是让个人材料被读懂、找回并用于行动。文档、代码、聊天、图片和经历共享来源体系；AST 帮助定位代码，不另建代码知识产品。之前的整体 review 与 ACP/harness 讨论在本目录正式保存，不再只留在聊天中。

核心结论：固定原文、引用和独立模型复核是有用的底座，但不足以产生好文章、有效检索或持续理解。质量需要同时检查事实、讲解、问题覆盖和行动效果。“检查通过”“有多少引用”“覆盖了多少文件”不能替代这些结果。

**当前方向：让文章持续可读，让搜索找到能回答问题的内容，再连接项目记忆与行动。** [2026-10-04 整体复审](reader-first/review.md)记录了改造前的诊断；其中“文件说明占据目录、指南全部待更新”不是今天的状态。正式文章已与内部笔记、参考分开，旧逐文件发布物已退出默认阅读，文章可按明确选材或项目范围持续维护。自主调查也已接通，当前瓶颈在内容组织、候选相关性、答案取舍与复杂项目理解。最新结果和失败见[实施进度](reader-first/progress.md)。

默认问答使用 Sol。Luna 没有明显收益后已停止反复比较；StartLux 2B/4B 已按本机负载辅助助手初始选材和材料用途建议，尚未接管请求路由或记忆写入。可选先读材料流程在少量合成短材料上有耗时收益，复杂仓库问题仍较慢。配置与测量边界见[中文快速决策](reader-first/fast-decisions.md)。

文件输入已有 Docling 文字 PDF/DOCX 解析、结构阅读和原件下载；飞书正文通过锁定的官方 lark-cli 项目依赖读取。OCR、复杂版式与本机飞书凭据访问的限制见[文档导入](reader-first/document-import.md)。

## 现在做到哪里

截至 2026-10-07，材料可以保存原件与历史版本，整理用途和概念，写成面向特定读者的文章，再用于检索、问答和事项。ACP Agent 在固定材料中自主搜索、补读、写作，独立会话补查；omem 不再规定固定三轮调查或宿主输入输出 token 配额。文章和材料用途都可按来源明确开启后续维护，生成中或失败时保留已有结果。项目归属、跨轮讨论对象和消息修订同一记忆已接通并用真实 Sol 验证短流程；这些结果不能代表大库可靠性或阅读质量已达标。

知识组织现在可以先保存可编辑的目录草案。Agent 在选定材料中调查，提出每篇文章的目的和问题；读者修改、重排或合并后确认，再由现有流程逐篇写作。目录调整与正文发表分别显示，旧文章仍能阅读。实际入口、保存字段和代码改造见[知识目录草案](reader-first/knowledge-outlines.md)。

| 用户结果 | 现有基础 | 当前主要不足 | 改造位置 |
| --- | --- | --- | --- |
| 材料完整、可读 | Capture、原文版本、Markdown/AST 结构、用途与概念、明确开启后的换版维护 | 混合文档的章节性质不够细，多模态解析较浅；未开启维护的说明仍可能断档 | store、knowledge/structure、source-profile/descriptions、description-worker |
| 找到相关内容 | ICU/FTS5 BM25、中文 BGE、标准 RRF、独立符号候选、用途过滤、完整父语境补读 | 主题相关仍可能答非所问，功能链不完整；重排对照未证明可默认开启 | retrieval/units、unified、knowledge/agent-research |
| 看懂陌生系统 | 正式页面计划、案例、自主调查/写作/复核、章节影响判断和持续维护 | 复杂文章仍有低价值细节；大型结构的复查范围可能过宽 | knowledge/pipeline、repository、maintenance、page-worker |
| 理解代码含义 | 符号、导入、候选调用和设计关联 | AST 结构不能解释业务因果、设计动机和完整功能链 | 原生读文件/搜索、MCP 代码导航、背景材料 |
| 记住并主动使用 | 项目材料范围、跨轮对象、事实修订、重核验、提醒 | 多项目混合、误归属纠正后的整体恢复、时间与持续理解仍有限 | contexts、learning、memory、assistant |

安装入口已整理为可发布的 `omem` npm CLI（Apache-2.0），命令与网页共享个人库。见 [CLI 使用指南](cli.md)和根目录 [skills/omem-cli](../skills/omem-cli/SKILL.md)。Agent 已从固定总时限改为连续无活动超时；输出和工具进展会续期，仍可显式设置总上限。实际发布和安装验收状态见 progress。

## 从哪里继续读

- [需求跟进、编码与独立评审](reader-first/requirement-followup.md)：指定项目范围，综合消息、需求、纪要和代码持续整理；支持关联个人待办，并在独立仓库副本编码、检查和独立评审。
- [主助手与外部能力](reader-first/assistant-orchestration.md)：自然语言关注与交办，skill/CLI/MCP 通用装配、任务版本与评审补查，以及尚未接入的真实业务项目和其他编码提供方。
- [个人库与冷存储](reader-first/data-lifecycle.md)：消息缓存、备份恢复、迁移与归档；核心状态仍在 SQLite。

- [整体复审](reader-first/review.md)：实际正文为何仍难读、维护和检索怎样牵连，以及本次改造顺序。
- [当前实现逐层审查](reader-first/current-system.md)：清洗、RAG、代码、记忆、Wiki、ACP 的实际链路及缺口。
- [成熟组件如何融入与代码改造](reader-first/component-integration.md)：具体采用什么、进入哪个适配层、哪些代码要替换、怎样判断收益。
- [Agent 自主研究方案](reader-first/agent-research.md)：工具、材料工作区、原生 skills、会话、最终产物与独立补查复核。
- [助手检索与真实命中](reader-first/assistant-search-research.md)：新问题搜出了什么，成熟方案的适配、局限及现有代码改造入口。
- [材料用途与概念入口](reader-first/material-understanding.md)：本轮如何保存、查看和修正材料性质，怎样融入全文、向量及 Agent 搜索，哪些问题还没有解决。
- [中文重排与成熟检索评估](reader-first/retrieval-evaluation.md)：独立符号候选和同库对照；BGE、RRF、Qwen3、Zoekt 的采用状态及具体改造位置。
- [调用方导航与相关代码窗口](reader-first/code-navigation-and-passages.md)：把调用线索接入共享搜索，修正长方法重排只读开头的问题。
- [个人记忆与跟进流程](reader-first/assistant-memory-flow.md)：保存、提问、换版、更新及持续跟进的真实成功与失败。
- [写作与学习路线](reader-first/writing.md)：人如何由一个案例理解概念、机制、取舍并开始修改。
- [当前进度](reader-first/progress.md)：本轮实际完成和真实验证；设计内容不代表已交付。

## 交付方向

保存单位、检索单位和讲解单位分别设计。原件保留固定版本；检索按章节/函数/会话保留背景；文章跨材料回答读者问题。派生解释可以作为回答背景，但不重复计算为独立事实。

Traex 自带 harness 负责调查循环和上下文管理；omem 负责来源、选材、工具、任务与发布。当前继续改善前排材料的回答能力与文章可读性，再验证跨时间、跨材料的项目理解。外部中文与代码检索对照说明简化规则恢复了部分基线损失，未证明已优于成熟基线；Hindsight 对照未显示足够净收益，暂未替换默认记忆后端。详细方法分别见[外部评测](reader-first/external-evaluation.md)与[组件接入](reader-first/component-integration.md)。

当前方案与实施进度统一维护在 [reader-first](reader-first/README.md)。先看 [整体复审](reader-first/review.md)，再看 [实施进度](reader-first/progress.md)；方案不代表已交付。

此前的方案、实现记录、调研、原型与旧 README/AGENTS 已原样归入 [2026-10-01 历史档案](archive/2026-10-01-baseline/)。其中的“当前”、通过率、环境状态均指当时，不用于判断今天的能力。历史技术依据仍可引用，但应说明时间。

`repo-review/associations.json` 是运行中的显式关联配置，继续留在原位置；其中旧文档定位已指向 archive。`.repo-review/knowledge` 是实际模型产物，不是本目录中的设计文档。
