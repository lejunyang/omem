# omem v2：精简重写方案

日期：2026-10-12。v1 的代码保留在 Git 历史中（`main` 分支 `12b4a55` 之前），本方案取代 `docs/reader-first/` 中的实施路线。

## 为什么重写

v1 在一年里接通了捕获、检索、Wiki、记忆、事项、飞书和编码交办，但效果差。根因不在某个权重或模型，而在三处设计：

1. **把智能放在宿主代码里。** 一次问答要宿主先检索、拼几十条规则的长 prompt、要求模型输出固定 JSON，再由宿主二次检索。模型只能在宿主给的片段里作答，读不到全貌；规则越加越多（`acp-model.ts` 一个 prompt 就有二十多条约束），彼此冲突。
2. **知识产物以文件为单位。** 每个源文件生成一篇“说明”，512 份 JSON 资产只有 6 份是面向读者的页面。读者想知道“一条消息进来后发生了什么”，得到的是“该文件以 0700 权限创建目录”。
3. **验证代替了效果。** 大量精力花在复核链、引用范围、快照副本、预算计时上，用户能读懂什么反而无人负责。

v2 的原则：**宿主只做数据、索引、调度和权限；理解和写作交给有工具的强 Agent。** 代码量目标是 v1 的五分之一以内。

## 外部参考与取舍

| 方案 | 借鉴 | 不照搬 |
| --- | --- | --- |
| Karpathy “LLM Wiki” 模式 | 原件（raw）只读；Wiki 是 LLM 维护的 Markdown；`ingest / query / lint` 三种操作；`index.md` + `log.md` | 只适合单一主题，v2 加“空间”隔离领域 |
| DeepWiki / deepwiki-open | 先规划整套目录（页面目的 + 相关文件），再逐页写；Mermaid 图 | 不限制图表配额 |
| OpenClaw / Hermes 类个人助理 | 记忆是可读文件；心跳（heartbeat）主动检查，无事时静默；技能文件；多渠道网关 | 不做屏幕监听等全局钩子 |
| 腾讯 Octop | 专家（agent）按工作区隔离；ACP 双向：外部 Agent 可调 omem，omem 可派活给 Codex/Claude Code；渠道网关统一消息 | 单用户，不做多租户 |
| Graphiti / Zep | 事实带有效期：新事实使旧事实失效（`valid_to`），而不是覆盖 | 不引入图数据库，SQLite 足够 |
| mem0 | 抽取后对已有记忆做 ADD / UPDATE / DELETE / NOOP 决策 | 由 Agent 调工具完成，不单独训练 |
| Letta sleep-time | “做梦”：空闲时整理记忆、合并重复、标记冲突与过期 | — |
| FSRS（ts-fsrs） | 学习卡片调度 | — |

## 核心概念

```
Space（空间/领域）
 ├─ Source（原件）     只读；文档、代码仓库、聊天、网页、图片
 │   └─ Chunk（片段） 检索单位：Markdown 按标题、代码按符号、聊天按会话窗口
 ├─ Page（Wiki 页）    Agent 维护的 Markdown；[[链接]] + 原件引用
 ├─ Memory（记忆）     一句话事实/约定/偏好/经验，带来源与有效期
 └─ Item（事项）       待办、等待回复、提醒、关注；状态机 + 时间线
Run（运行）            一次 Agent 执行：问答、整理、交办编码、评审、做梦
Channel（渠道）        Web、CLI、飞书机器人，后续 Telegram/QQ/微信
```

- **空间**隔离不同领域，检索默认只在当前空间，跨空间要显式指定。“个人”是默认空间；一个代码仓库、一个项目、“英语学习”各自一个空间。
- **原件**按身份（路径/URL/会话 ID）只保留最新版；聊天和纠正是事件，保留原文。
- **Wiki 页**是派生知识，存为文件，整个库目录是一个 Git 仓库：页面历史、差异、回滚、“这份理解什么时候被谁改了”都直接来自 Git。
- **记忆**存在 SQLite，带 `valid_from / valid_to / superseded_by`。纠正不会删旧记忆，而是让它失效并链接到新记忆，因此问“之前怎么约定的”和“现在是什么”都能答。
- **引用**格式统一：`[^1]` 脚注指向 `source:<id>#L10-L20` 或 `memory:<id>`，界面可点开原文。

## 存储布局

```
~/.omem/                      （开发时为 ./.omem）
  config.json
  omem.db                     SQLite：sources/chunks/FTS/向量/memories/items/runs/messages
  library/                    Git 仓库
    <space>/
      wiki/index.md           空间首页与目录（Agent 维护）
      wiki/*.md               页面，frontmatter 含 title/summary/sources/updated
      log.md                  整理日志（追加）
      SPACE.md                空间说明：读者、范围、写作要求（人可编辑）
  sources/<space>/...         导入的原件副本（代码仓库只记录路径，不复制）
  runs/<run-id>/              Agent 运行记录（transcript.jsonl、diff、结果）
```

## 检索

一条路线，三个召回源，RRF 融合：

1. SQLite FTS5 全文（`trigram` 分词器，中文无需额外分词；短于 3 字的查询退回 LIKE）。
2. 向量（可选）：本地 `bge-small-zh-v1.5`（transformers.js）或 OpenAI 兼容接口；存 SQLite BLOB，暴力余弦（个人库规模足够）。
3. 符号名精确匹配（代码）。

结果携带父结构（章节标题路径/所在函数），并可按 `read_source(id, lines)` 补读。**检索只负责给 Agent 线索**，回答前由 Agent 自己决定继续搜、读全文还是看 Wiki——不再由宿主替它做多轮规划。

## Agent 运行时

- **传输**：ACP（Codex/traex、Claude Code ACP 适配器等，命令可配置）为主；`claude -p` / `codex exec` 作为无 ACP 时的后备。模型与 effort 来自配置，启动时从 ACP 会话动态读取可选项。
- **工具**：omem 自身以 MCP 服务暴露工具（`search`、`read_source`、`read_page`、`write_page`、`remember`、`forget`、`list_items`、`upsert_item`、`list_spaces` ……），通过 ACP `newSession.mcpServers` 注入。Agent 同时保有原生的文件读取与 shell（代码仓库只读）。
- **角色**由短技能文件定义（`roles/*.md`）：`assistant`（问答与交办）、`wiki-planner`、`wiki-writer`、`ingest`（新材料进来时更新记忆/页面/事项）、`dreamer`（整理）、`coder`、`reviewer`、`tutor`。每个文件写目的、工具用法和质量标准，不写几十条禁令。
- **权限**：模型不直接写数据库，所有写入经 MCP 工具，工具层校验并记录到 Run。危险操作（发消息、应用补丁、删除）生成“待确认”事项。

## 五条主流程

### 1. 保存与问答
导入（文件/目录/URL/飞书文档/粘贴文本/聊天）→ 转文本（Markdown 直读；PDF/DOCX 调可选的 Docling 或 `pdftotext`；飞书走 `lark-cli`）→ 切片入索引 → 触发 `ingest` 角色：读新材料，查已有记忆与页面，决定新增/更新/作废记忆、更新相关 Wiki 页、建立或推进事项。

问答由 `assistant` 角色带工具调查后作答，答案带脚注引用。对话本身作为聊天原件保存，供后续“之前说过什么”。

### 2. 代码仓库 Wiki
1. `wiki-planner`：Agent 在仓库只读副本中自由浏览（原生工具），产出目录：每页的读者问题、类型（入门/机制/操作/参考）、入口文件。目录写入 `wiki/index.md`，人可在界面里改。
2. `wiki-writer`：逐页调查并写作，要求：先给一个真实例子走完整条路径，再讲概念和取舍，最后给“要改 X 去哪里”。引用落到文件行号。
3. `lint`：检查断链、引用失效、页面与代码不符（按 Git diff 找受影响页面），只重写受影响的页。

### 3. 记忆与纠正
记忆只能经 `remember` / `supersede` / `forget` 工具写入。用户说“不对，是 120 元”时，Agent 找到旧记忆，调用 `supersede(old, new)`；旧记忆保留并标为失效。界面展示一条记忆的演变链。

### 4. 事项与跟进
事项类型：`todo`、`waiting`（等谁回复）、`reminder`、`watch`（关注某项目/群/文档）。心跳任务按配置周期运行：读关注对象的新增材料和到期事项，由 Agent 判断是否有需要本人知道/决定的变化；无变化输出 `QUIET`，不打扰。

### 5. 交办 Agent
`coder` 在目标仓库的 Git worktree 中工作；完成后宿主运行项目检查命令，`reviewer`（可配置为不同模型）评审 diff；Run 页面显示计划、实际命令、检查输出、diff、评审结论。应用补丁需本人确认。

### 6. 学习
从材料或对话生成卡片（问答/完形/例句），FSRS 调度；每日到期卡片在 Web 与机器人里复习。

### 7. 做梦（整理）
每晚：合并重复记忆、标记冲突（两条同时有效又互相矛盾）、过期提醒、Wiki 断链与孤立页、从运行记录提炼可复用技能建议。结果写进“整理报告”，变更走工具并可回滚（Git）。

## 界面

Vue 3 + TypeScript，单页应用，信息架构：

- 左侧：空间切换 + 导航（问答 / 事项 / Wiki / 原件 / 记忆 / 运行 / 学习 / 设置）。
- 问答：对话 + 右侧引用面板（点击脚注即在右侧显示原文高亮）。
- Wiki：左目录、中正文（行宽受限，Mermaid 渲染）、右侧“本页引用 + 反向链接 + 相关页面”；页面可看 Git 历史与 diff。
- 事项：按“需要我决定 / 等待中 / 待办 / 已完成”分栏，时间线展示每次变化及来源。
- 运行：每次 Agent 执行的步骤、工具调用、diff、评审。

视觉沿用黑白灰阅读风格，但减少说明性文字和嵌套面板，信息靠排版层级而非边框。

## 验证

- **代码 Wiki**：以本仓库与一个陌生开源仓库生成，人工按“能否讲清流程、找到修改入口”打分；问答用一组真实问题（不进索引）。
- **检索**：公开集小样本（中文 T2Retrieval / 代码 CoSQA 子集），报告 Recall@10 与 MRR，与纯 BM25 对照。
- **记忆**：LongMemEval 的知识更新与时间推理子集抽样，比较答对率。
- 模型验证使用 Codex（gpt-6.1-sol / luna，低 effort）或 Claude Code，不为验证批量生成知识。

## 从 v1 迁移

保留：飞书接入（机器人、个人消息采集）、Docling 解析脚本、TS/Vue 解析思路、osdk 配置。其余模块退役。v1 数据库不自动迁移；`omem import-v1 <旧 omem.db>` 一次性导入原件最新版、有效记忆和未完成事项（代码评审材料跳过，改为重新建仓库空间）。

## 实现状态（2026-10-12）

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| 空间、原件、切分、全文 + 符号 + 可选向量检索 | 已实现，测试覆盖 | `src/sources`、`src/search` |
| Agent 运行时（ACP、claude/codex 命令行后备）与 MCP 工具（HTTP 与 stdio 桥） | 已实现；假 ACP Agent 端到端测试；真实 Claude Code ACP 已跑通 | `src/agents/acp.ts`、`tools.ts` |
| 问答、记忆更正与版本链、事项与时间线 | 已实现，真实模型抽查通过 | `roles/assistant.md` |
| 新材料整理（记忆/事项/页面/通知） | 已实现，真实模型抽查通过 | `roles/ingest.md` |
| 代码仓库 Wiki：规划 → 逐页写作 → 原件变化后检查 | 已实现；zustand 12 页实测 | `roles/wiki-*.md` |
| 巡检（到期提醒不调模型；关注/等待有新材料时才调用） | 已实现 | `roles/heartbeat.md` |
| 简报、做梦整理、经验与偏好回灌到后续任务 | 已实现 | `roles/brief.md`、`dreamer.md`、`runner.ts` |
| 交办编码：worktree → 检查 → 独立评审 → 确认后应用 | 已实现，演示仓库实测 | `src/agents/code.ts` |
| 跨文件调用图：按导入绑定解析调用到具体定义（相对路径、index、`.js`→`.ts`、`@/` 别名、重导出、默认导出、命名空间、`this`/`self` 方法；Python 绝对/相对/包导入） | 已实现，测试覆盖；本仓库 4032 处调用中 1098 处解析到仓库内定义，其余多为标准库与对象方法 | `src/sources/callgraph.ts`、`find_symbol`、原件页“结构”栏 |
| 汇总类问题：`scan` 穷举扫描所有命中行（可按时间段），助理先列清单再计数 | 已实现 | `tools.ts`、`roles/assistant.md` |
| 主动留意：问答时顺带记下本人透露的计划、承诺、等待和长期事实；做梦时复查这段时间本人说过的话补漏；聊天整理时同样关注本人自己的发言 | 已实现，真实模型抽查通过 | `roles/assistant.md`、`dreamer.md`、`ingest.md` |
| 会话线程：私聊 / 群 / 话题（飞书 thread_id、Telegram 论坛话题）各自一个会话；Agent 会话在线保持 → 恢复（ACP session/resume|load、`claude --resume`、`codex exec resume`）→ 从滚动摘要冷启动；连发合并；每会话串行、会话间并行；对话与后台分开的并发槽；空闲过期后新会话带上一段摘要；斜杠命令 | 已实现；假 ACP Agent 测试覆盖；真实 Claude Code ACP 验证了在线续聊和重启后恢复 | `src/agents/threads.ts`、`sessions.ts`、`inbox.ts`、`commands.ts` |
| 能力沉淀：Agent 档案（`library/_agents/*.md`：prompt、后端/模型、工具、写权限、技能、MCP、目录、AGENTS.md 式约定）与技能（`library/_skills/*/SKILL.md`）；助理可建、可委派（`run_agent`、`/as`），结果发回原会话；做梦起草草稿，本人 `/approve` | 已实现；真实模型建档案与技能已验 | `src/agents/specs.ts`、网页“Agent”页 |
| 注入标记（可选）：本地 StartLux-Decision 判官给别人写的群聊/网页/文档打标，提醒 Agent 只当材料；不拦截 | 已实现（需本机开判官服务）；评测见 judge-models.md | `src/sources/guard.ts` |
| 设置向导 `omem setup`：Agent、向量模型（osdk）、Docling 及其模型（osdk）、渠道、注入标记、会话、定时任务 | 已实现；osdk 路径未在云端实测（云端无 osdk） | `src/setup.ts` |
| 学习卡片（FSRS） | 已实现 | `src/learn` |
| 渠道：网页、CLI、MCP、飞书机器人、飞书个人消息（只读）、Telegram、OneBot（QQ/微信桥） | 已实现；OneBot 有模拟服务端测试；飞书与 Telegram 需真实账号验收 | `src/channels` |
| v1 导入 | 已实现，合成库测试 | `src/migrate-v1.ts` |

尚未做：扫描件 OCR；动态派发与依赖注入的调用无法静态解析（这些仍按名称列为候选）；tsconfig 的自定义 paths 只识别 `@/`、`~/`；多用户；微信官方接口（只能通过 OneBot 兼容桥）。评测数字见 [evaluation.md](evaluation.md)。
