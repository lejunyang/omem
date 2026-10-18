# omem v2：精简重写方案

日期：2026-10-12，最后更新 2026-10-14。v1 的代码保留在 Git 历史中（`main` 分支 `12b4a55` 之前），本方案取代 `docs/archive/v1/reader-first/` 中的实施路线。

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
| 腾讯 Octop | 专家（agent）按工作区隔离；ACP 双向：外部 Agent 可调 omem，omem 可派活给 Codex/Claude Code；渠道网关统一消息 | 不做多租户；只留了多用户的口子（用户、身份、空间成员、令牌） |
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
Conversation（会话）   网页对话、私聊、群、话题；绑定一个 Agent 会话，带滚动摘要
Run（运行）            一次 Agent 执行：问答、整理、交办编码、评审、做梦
Agent 档案 / 技能       library/_agents、library/_skills：可复用的专门 Agent 和做法
User（用户）           默认只有主人；登记的同事有自己的个人空间和可访问空间
Channel（渠道）        Web、CLI、MCP、飞书机器人、飞书个人消息（只读）、Telegram、OneBot（QQ/微信）
```

- **空间**隔离不同领域，检索默认在当前空间和它的相关空间，其他空间要显式指定。“个人”是默认空间；一个代码仓库、一个项目、“英语学习”各自一个空间。类型（个人 / 项目 / 代码仓库 / 学习 / 通用）只影响默认行为（代码仓库默认不自动整理）和给 Agent 的说明。
- **相关空间**（`space_relations`，无方向）：互相调用的仓库、同一项目的几个空间。只管一个空间的运行（整理、复核、Wiki、学习出卡）对相关空间只读；`search` / `scan` / `find_symbol` 不传 space 时连同相关空间一起查。关联由本人在设置或 CLI 里加，或由助理、定期整理用 `relate_spaces` 加；本人移除的记为 rejected，Agent 不能再加回。
- **原件**按身份（路径/URL/会话 ID）只保留最新版；聊天和纠正是事件，保留原文。
- **Wiki 页**是派生知识，存为文件，整个库目录是一个 Git 仓库：页面历史、差异、回滚、“这份理解什么时候被谁改了”都直接来自 Git。
- **记忆**存在 SQLite，带 `valid_from / valid_to / superseded_by`。纠正不会删旧记忆，而是让它失效并链接到新记忆，因此问“之前怎么约定的”和“现在是什么”都能答。
- **引用**格式统一：原件 `[文字](src:<原件id>#L10-L20)`，Wiki 页面 `[[slug]]`，记忆 `mem:<id>`；界面点击后在右侧抽屉显示原文并高亮。

## 存储布局

```
~/.omem/                      （开发时为 ./.omem）
  config.json
  omem.db                     SQLite：原件/片段/FTS/向量/记忆（含被退回的写入、对比运行）/事项/运行/会话/用户与令牌/卡片/飞书消息与游标
  library/                    Git 仓库
    <space>/
      wiki/index.md           空间首页与目录（Agent 维护）
      wiki/*.md               页面，frontmatter 含 title/summary/sources/updated
      log.md                  整理日志（追加）
      SPACE.md                空间说明：读者、范围、写作要求（人可编辑）
    _agents/*.md              Agent 档案
    _skills/<名称>/SKILL.md    技能（内置技能从 skills/library 播种）
  files/                      上传与采集的原始文件（代码仓库只记录路径，不复制）
  repos/                      对话接入 Git 链接后克隆的仓库（不在知识库 Git 中）
  runs/<run-id>/              交办编码的 worktree（work/<空间>/）与补丁（patches/<空间>.patch）
  agents/<id>/<版本>/          从 ACP 注册表下载的 Agent 程序
  secrets/                    lark.json（App Secret）、peers.json（同伴地址与令牌），均 0600
  service/                    后台服务的 PM2 数据与日志
```

## 检索

一条路线，三个召回源，RRF 融合：

1. SQLite FTS5 全文（unicode61；入库和查询时由 `src/search/tokenize.ts` 生成中文双字词和拆开的标识符，如 `upsertSource` → `upsert source`）。
2. 向量（可选）：本地 bge 中文模型（bge-small-zh / bge-base-zh / bge-m3，transformers.js，经 osdk 下载）或 OpenAI 兼容接口；SQLite 存原始向量，内存里按空间存 int8 量化矩阵做暴力余弦（17 万片段常驻约 0.4GB，见 evaluation.md）。
3. 符号名精确匹配（代码）。

结果携带父结构（章节标题路径/所在函数），并可按 `read_source(id, lines)` 补读。**检索只负责给 Agent 线索**，回答前由 Agent 自己决定继续搜、读全文还是看 Wiki——不再由宿主替它做多轮规划。

## Agent 运行时

- **传输**：ACP 为主，`claude -p` / `codex exec` 作为无 ACP 时的后备。内置目录（`src/agents/catalog.ts`）列了 25 个 ACP Agent 的启动命令（Codex、Claude Code、Gemini、Copilot、Qwen、Cursor、OpenCode、goose、Kimi、Kilo、CodeBuddy、Qoder、iFlow、Droid…），PATH 里有就自动识别；其余从官方 ACP 注册表添加（npx / uvx，或下载对应平台的程序并校验 sha256 到 `~/.omem/agents/`）。模型与 effort 来自配置，启动时从 ACP 会话动态读取可选项：优先 session config options（model / thought_level），没有时用旧式 `session.models` + `session/set_model`。角色要求的权限模式按别名映射到各家的模式名（如 acceptEdits ↔ autoEdit、read-only ↔ ask）。Agent 返回的 JSON-RPC 错误把 `data`（如“未登录”“缺少 provider 配置”）带给用户并提示先在终端登录。
- **工具**：omem 自身以 MCP 服务暴露工具（`search`、`read_source`、`read_page`、`write_page`、`remember`、`forget`、`list_items`、`upsert_item`、`list_spaces` ……），通过 ACP `newSession.mcpServers` 注入。Agent 同时保有原生的文件读取与 shell（代码仓库只读）。
- **角色**由短技能文件定义（`roles/*.md`）：`assistant`（问答与交办）、`ingest`（新材料进来时更新记忆/页面/事项）、`memory-reviewer`（复核新记忆）、`wiki-planner` / `wiki-writer` / `wiki-linter`、`heartbeat`（巡检）、`brief`（简报）、`dreamer`（整理）、`curator`（筛选关注群）、`summarizer`（会话滚动摘要）、`coder`、`reviewer`、`tutor`（出卡）。共同约定在 `_common.md`。每个文件写目的、工具用法和质量标准，不写几十条禁令。可以按角色指定不同的 Agent 后端（`config.agents.roles`）。
- **Agent 档案与技能**：本人或助理建的专门 Agent（`library/_agents`，可指定后端、工具、写权限、技能、额外 MCP、工作目录）用 `run_agent` 或 `/as` 调用；技能（`library/_skills`）按名称列在提示里，Agent 需要时用 `read_skill` 读取。
- **会话**：`src/agents/threads.ts`、`sessions.ts`、`inbox.ts`。每个会话一次一轮，连发合并；Agent 会话在线保留 → 恢复 → 从摘要冷启动。斜杠命令在 `commands.ts`，不经过模型。
- **多用户口子**：工具令牌带 userId，`scopeFor` / `accessibleSpaces` 决定能看哪些空间；非主人只有问答与自己的数据。
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

记忆质量分三层，都不需要本人逐条看（`src/memory/quality.ts`）：

1. **写入检查**：`remember` / `supersede` 先过确定性规则——主体是免责/不确定、超长（默认 400 字以上；几条独立结论应拆开，整套规则或流程应写成页面）、转述原件（“截至…收录的《…》说明”）、“日期 + 某人说了什么”式事件复述、助理自己的汇报、运行流水、后台角色没有来源或来源不存在、与有效记忆几乎相同。不通过就把理由作为工具错误还给模型（该建事项、该 supersede、或者不记），并按模型记一笔拒绝。
2. **复核**：每小时 `memory-review` 运行把新写的 Agent 记忆交给 `memory-reviewer` 角色，盲评（看不到是哪个模型写的）后保留、改写（supersede）、拆分或撤回。复核的后端/模型在 `memory.review` 里单独配置，最好和写入的不是同一个。只有复核保留或本人写的经验、偏好会被放进每次运行的提示。
3. **按模型比较**：记忆记录写入它的后端、模型、强度和运行；`memory.compare` 让每次整理再用别的模型跑一遍（`ingest-shadow`），写入只记录到 `shadow_writes` 不生效，经过同样的检查和复核。网页“记忆 → 质量”和 `omem memories stats` 按模型给出写入、拒绝、复核结果，以及同一份材料各模型的写法对照。

记忆可以带标签（`tags`），Agent 档案写的经验和偏好默认只属于那个档案（`agent` 字段），其他档案看不到，助理能看到全部。

### 4. 事项与跟进
事项类型：`todo`、`waiting`（等谁回复）、`reminder`、`watch`（关注某项目/群/文档）。心跳任务按配置周期运行：读关注对象的新增材料和到期事项，由 Agent 判断是否有需要本人知道/决定的变化；无变化输出 `QUIET`，不打扰。

### 5. 交办 Agent
`coder` 在目标仓库的 Git worktree 中工作；一个需求要同时改几个仓库（前端和接口、SDK 和调用方）时，每个仓库各开一个 worktree，放在同一个工作目录下，由同一个 coder 一起改。完成后宿主在每个仓库运行各自的检查命令，`reviewer`（可配置为不同模型）评审全部 diff；Run 页面显示计划、实际命令、按仓库的检查输出和 diff、评审结论。应用补丁需本人确认，所有仓库先逐个检查能否干净应用，都能才一起应用，之后删除 worktree。

改过的文件（新增和修改的，不含删除）在 worktree 存在期间建索引，放在临时空间 `wt-<运行id>-<仓库空间>`（类型 `worktree`）里：评审和之后的问答能用 `search` / `find_symbol` 查到新代码，仓库自己的索引不受影响。临时空间不出现在空间列表、定时任务和 `omem pull` 里，只能读不能写；worktree 删除（应用、丢弃，或手动删掉后的下一次仓库同步）时连同索引一起删除。

### 6. 学习
从材料或对话生成卡片（问答/完形/例句），FSRS 调度；每日到期卡片在 Web 与机器人里复习（聊天里 `/review` 逐张出题打分）。学习目标（`src/learn/goals.ts`）记录方向、每日张数和提醒时间：提醒前从该空间新材料出卡，反复忘的卡换角度补卡，统计记住率与连续天数。

### 7. 做梦（整理）
每晚：合并重复记忆、标记冲突（两条同时有效又互相矛盾）、过期提醒、Wiki 断链与孤立页、从运行记录提炼可复用技能建议。结果写进“整理报告”，变更走工具并可回滚（Git）。

## 界面

Vue 3 + TypeScript，单页应用，信息架构：

- 左侧：空间切换 + 导航（今日 / 问答 / Wiki / 事项 / 记忆 / 原件 / 学习 / Agent / 运行，另有设置、通知和关系图）。
- 原件：聊天类原件按聊天显示（发送人、引用、图片、卡片），长原件和长列表虚拟滚动。
- 记忆：列表、标签筛选、复核状态，“质量”页按模型统计。
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

## 多台设备

现在的做法是“一台常驻，其他来看”：常驻那台负责采集和定时任务，是唯一写入方；其他机器经 HTTP 读它的状态、拉快照、让它跑检查。配对码 = 对方地址 + 为本人生成的 API 令牌，所以同伴就是“拿着本人令牌的客户端”，权限与撤销都走已有的令牌表。中间节点转发 `/api/peers/<id>/…` 时换上自己保存的令牌，并用 `x-omem-hops` 限制层数。

远程命令刻意做成固定清单（`peerCommands`，每条有参数校验），而不是任意 shell：要核对的多是飞书原始返回、数据库内容、日志和版本，这些都能用只读命令覆盖；会改东西的只有采集、回溯、触发定时任务、`git pull --ff-only` 和重启。

以后要做持续同步（两台都写）时的方向，现在不实现：

- **变更日志**：记忆、事项、原件元数据各自已有 id 和时间，补一张按节点自增的变更表（节点 id + 序号 + 实体 + 操作），同伴按“我已看到对方的第几号”增量拉取，代替整库快照。
- **单写者的事归一台**：飞书采集、定时任务、发消息这类有外部副作用的事只在持有租约的节点上跑（租约存在常驻那台，过期可接管），避免两台同时采集或重复提醒。
- **冲突**：记忆本来就是版本链（新的使旧的失效），并发修改同一条时两条都保留、交给做梦整理合并；事项状态按最后修改时间。
- **按能力分派**：同伴上报自己有哪些 Agent / 工具（`diag` 里已有），跑不了的任务转给有的那台。
- **多用户**：配对码里的令牌目前固定是本人的；给同事的设备配对时换成他的用户令牌，同步时只带他能访问的空间。

## 实现状态（2026-10-18）

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| 主助手对话创建空间、关联本地 Git 仓库或 Git 链接（clone 到数据目录 repos/）；路径去重、冲突检查、仅本人全空间运行可用 | 已实现；2026-10-15 | `src/core/repositories.ts`、`src/agents/tools.ts`、`roles/assistant.md` |
| 空间、原件、切分、全文 + 符号 + 可选向量检索 | 已实现，测试覆盖 | `src/sources`、`src/search` |
| 原件列表：普通空间平铺，代码仓库空间按目录展示；网址与会话标识不拆成目录，目录/文件节点明确区分 | 已实现；2026-10-15 修复 URL 与超过 12 条数据导致的白屏 | `web/src/views/Sources.vue` |
| Agent 运行时（ACP、claude/codex 命令行后备）与 MCP 工具（HTTP 与 stdio 桥）；25 个内置 ACP Agent + 官方注册表添加 | 已实现；假 ACP Agent 端到端测试；真实 Claude Code、OpenCode（含 MCP 工具调用）已跑通，Gemini / Qwen / Copilot / goose 握手通过（需登录） | `src/agents/acp.ts`、`tools.ts` |
| 问答、记忆更正与版本链、事项与时间线 | 已实现，真实模型抽查通过 | `roles/assistant.md` |
| 新材料整理（记忆/事项/页面/通知） | 已实现，真实模型抽查通过 | `roles/ingest.md` |
| 记忆质量：写入检查（免责式、超长、转述原件、事件复述、助理汇报、运行流水、无来源、重复）退回并说明原因；每小时盲评复核（保留/改写/撤回，可用不同模型）；对比运行（其他模型的写入只记录）；按模型统计；记忆标签与档案专属记忆 | 已实现，测试覆盖；规则用一批真实运行产生的 Agent 记忆校准过；复核与对比运行待真实模型验收 | `src/memory/quality.ts`、`roles/memory-reviewer.md`、网页“记忆 → 质量”、`omem memories` |
| 代码仓库 Wiki：规划 → 逐页写作 → 原件变化后检查 | 已实现；zustand 12 页实测 | `roles/wiki-*.md` |
| 巡检（到期提醒不调模型；关注/等待有新材料时才调用） | 已实现 | `roles/heartbeat.md` |
| 简报、做梦整理、经验与偏好回灌到后续任务 | 已实现 | `roles/brief.md`、`dreamer.md`、`runner.ts` |
| 交办编码：worktree → 检查 → 独立评审 → 确认后应用 | 已实现，演示仓库实测 | `src/agents/code.ts` |
| 交办可同时改多个仓库（每个仓库一个 worktree，一起应用）；改过的文件在 worktree 存在期间可检索，删除时索引一起删 | 已实现，测试覆盖（`test/code-worktrees.test.ts`）；2026-10-19；真实 Agent 跨仓库交办待验 | `src/agents/code.ts`、`src/agents/worktree-index.ts` |
| 跨文件调用图：按导入绑定解析调用到具体定义（相对路径、index、`.js`→`.ts`、`@/` 别名、重导出、默认导出、命名空间、`this`/`self` 方法；Python 绝对/相对/包导入） | 已实现，测试覆盖；本仓库 4032 处调用中 1098 处解析到仓库内定义，其余多为标准库与对象方法 | `src/sources/callgraph.ts`、`find_symbol`、原件页“结构”栏 |
| Go / Rust / Java / Kotlin / Swift：tree-sitter（`web-tree-sitter` 0.25 + `tree-sitter-wasms`，WebAssembly，按需加载语法）切分符号、导入和调用；按包（Go 目录与导入路径、Java/Kotlin 包与静态导入、Rust `use`/`mod`/工作区 crate、Swift 整个模块）解析，隐式 this/self、接收者、扩展、伴生对象 | 已实现，测试覆盖；真实仓库抽查：cobra 31%、ripgrep 18%、gson 22%、moshi 18%、Alamofire 20% 的调用解析到仓库内定义（其余多为对变量调用方法和标准库/测试框架）；Swift 解析较慢（约 70 ms/千行，其余语言快一个数量级） | `src/sources/treesitter.ts`、`callgraph.ts` |
| C / C++ / Objective-C、C#、PHP、Ruby、Scala、Dart、Lua、Zig、Elixir、OCaml、ReScript、Solidity、Bash、Emacs Lisp：tree-sitter，按语言写成小规格（声明、成员、调用、导入节点）由 `treesitter-more.ts` 统一抽取；语法按需加载。调用解析按名称：本类型（含 C++ 类外定义、Ruby 重开类）→ 本文件 → 导入带进来的文件（`#include` 连同同名 .c/.cpp、`require`、`open`、不带别名的 `import`）→ `类型.成员` → 同语言里唯一的同名定义；C++/C# 命名空间里的函数只对同一命名空间内可见 | 已实现，多语言夹具测试覆盖；真实仓库解析率：cJSON 70%、fmt 31%、plug（Elixir）43%、MediatR（C#）16%、Slim（PHP）16%、sinatra 14%、os-lib（Scala）24%、dart-lang/http 24%、inspect.lua 25%。已知误连：用宏包起来的命名空间（如 fmt 的 `FMT_BEGIN_NAMESPACE`）被当成全局，`printf`/`size` 这类常见名会连到项目里同名的定义。Lua 用 vendor/ 里较新的语法（tree-sitter-wasms 里的 Lua 语法第二次解析起就出错）；Elm、QL 的语法与运行时不兼容，未接入 | `src/sources/treesitter-more.ts`、`callgraph.ts` 的 nameResolver |
| 汇总类问题：`scan` 穷举扫描所有命中行（可按时间段），助理先列清单再计数 | 已实现 | `tools.ts`、`roles/assistant.md` |
| 主动留意：问答时顺带记下本人透露的计划、承诺、等待和长期事实；做梦时复查这段时间本人说过的话补漏；聊天整理时同样关注本人自己的发言 | 已实现，真实模型抽查通过 | `roles/assistant.md`、`dreamer.md`、`ingest.md` |
| 会话线程：私聊 / 群 / 话题（飞书 thread_id、Telegram 论坛话题）各自一个会话；Agent 会话在线保持 → 恢复（ACP session/resume|load、`claude --resume`、`codex exec resume`）→ 从滚动摘要冷启动；连发合并；每会话串行、会话间并行；对话与后台分开的并发槽；空闲过期后新会话带上一段摘要；斜杠命令 | 已实现；假 ACP Agent 测试覆盖；真实 Claude Code ACP 验证了在线续聊和重启后恢复 | `src/agents/threads.ts`、`sessions.ts`、`inbox.ts`、`commands.ts` |
| 能力沉淀：Agent 档案（`library/_agents/*.md`：prompt、后端/模型、工具、写权限、技能、MCP、目录、AGENTS.md 式约定）与技能（`library/_skills/*/SKILL.md`）；助理可建、可委派（`run_agent`、`/as`），结果发回原会话；做梦起草草稿，本人 `/approve` | 已实现；真实模型建档案与技能已验 | `src/agents/specs.ts`、网页“Agent”页 |
| 注入标记（可选）：本地 StartLux-Decision 判官给别人写的群聊/网页/文档打标，提醒 Agent 只当材料；不拦截。omem 按需拉起 llama-server（osdk `conda:llama.cpp`）和模型自带的 Python 服务（`scripts/startlux`，uv 锁定），空闲 3 分钟关闭；也可指向自己运行的服务 | 已实现；macOS arm64 上 0.8B 端到端验证（首次启动约 15 秒，之后每段约 60ms）；评测见 judge-models.md | `src/sources/guard.ts`、`judge.ts` |
| 设置向导 `omem setup`：Agent、向量模型（osdk）、Docling 及其模型（osdk，uv 经 `osdk install conda:uv`（独立程序，不依赖 osdk 的 Python））、渠道、注入标记、会话、定时任务；结束时可启动/重启后台服务 | 已实现；osdk 安装 uv / llama.cpp、uv 解析 Docling 依赖在 macOS arm64 与 Linux x86_64 验证 | `src/setup.ts`、`src/core/tools.ts` |
| 飞书机器人接入：读 lark-cli 的应用与登录状态和 omem 已保存的应用；绑定已有应用或扫码新建（官方 SDK `registerApp`，同时申请权限、长连接事件和卡片回调）；校验凭据和机器人能力；扫码人 open_id 设为本人；App Secret 存 `secrets/lark.json`（0600）；lark-cli 未登录时就地扫码登录 | 已实现；SDK 注册流程真实发起到二维码一步，扫码确认待真实账号验收；其余假客户端测试覆盖 | `src/channels/lark-setup.ts` |
| 后台服务 `omem service`：自带 PM2（独立 PM2_HOME）、崩溃自动重启、pm2-logrotate 日志轮换；`enable` / `disable` 开机自启（macOS LaunchAgent、Linux systemd 用户服务 + linger 或 crontab `@reboot`、Windows 启动文件夹里的隐藏脚本） | 已实现；macOS 本机 start / restart / stop / status 验证；三个平台的自启文件与命令有单元测试，真机待验收 | `src/core/service.ts`、`src/core/autostart.ts` |
| 更新：`osdk run upgrade` / `scripts/upgrade.ts`（拉代码、装依赖、构建、`npm install -g .`、可选重启）；远程 `update` 命令复用它 | 已实现 | `scripts/upgrade.ts`、`osdk.toml` |
| 多台设备（同伴）：一行配对码配对（本机各网卡地址 + 本人 API 令牌，add 时挑能连上的，之后断线自动换地址）；`omem link` 给浏览器的带令牌链接；`omem peer open` 在本机转发同伴的整个网页（转发端点对 GET 也放行网页文件）；`omem user tokens|revoke`；经中间节点转发（`via`，最多 3 跳）；`/api/diag` 诊断；固定的远程命令（诊断、日志、配置、飞书只读查询、采集与回溯、记忆统计、运行记录、只读 SQL、git、更新并重启）；`omem pull <同伴>` 经 HTTP 拉快照；默认监听所有网卡，没有配置令牌时只信任本机请求（旧配置里写出的 `127.0.0.1` 视为未设置，`localhost` 表示只给本机） | 已实现，三节点（服务器、中间、笔记本）测试覆盖；真实设备待验收 | `src/core/peers.ts`、`peer-exec.ts`、`pull.ts` 的 `fetchPeer`、`omem peer` |
| 临时白名单转发 `scripts/relay.mjs`：文件收件箱 → 经 ssh（可多跳）执行允许的命令 → 结果写回 | 已实现；用假 ssh 验证了两跳下参数原样传递 | `scripts/relay.mjs` |
| 飞书机器人能力：回复/话题回复、表情、Markdown、图片文件、Card 2.0（按钮、下拉、输入、选人、日期、表单）、限定处理人、草稿确认、进度卡片实时更新；卡片回调回到原会话 | 已实现；假客户端测试覆盖，真实飞书待验收 | `src/channels/lark-send.ts`、`lark-actions.ts`、`lark-progress.ts`、技能 `lark-messaging` |
| 飞书个人采集（lark-cli）：全部或订阅会话增量拉取（每会话游标、话题回复）、附件与文档链接入库、日程、妙记 | 已实现；模拟 lark-cli 测试覆盖，真实账号待验收 | `src/channels/lark-personal.ts` |
| 飞书文档原件本地化：图片（Markdown 与 DocxXML 两种写法）、画板缩略图、视频和附件（`lark.capture.docMediaMaxMB`，默认 100 MB 以内）经 `docs +media-download` 存进 files/（下载被拒时改用 `+media-preview`，限流时退避重试），正文写 `omem-file:`（表格里的图片和视频用 HTML `<img>`/`<video>`，链接用 `<a href="src:…">`，网页渲染时换成本地地址），按素材 token 缓存；DocxXML 的分栏、高亮块、按钮、书签、勾选、子页面列表转成网页能显示的 HTML（分栏和高亮块前后留空行，里面的 Markdown 才会被解析）；内嵌电子表格经 `sheets +csv-get` 转成表格；同步块读源文档的对应块；`<cite>` 与正文里的文档链接导入同一空间（`docLinkDepth` 层，默认 2，从给 omem 的那篇算起，每篇记下自己还能跟几层，重新读取时不重新起算；每篇最多 `docMaxLinked` 篇，默认 30；链回上层的不重复读），换成 `src:` 链接，回指的链接在保存后补上；一次导入里读不到的合成一条通知；读不到的记在 kv `lark_doc_missing`，一次导入或一次重新读取汇总一条通知，按 `docRetryHours`（默认 6）重试至多 `docRetryMax`（默认 3）次后安静放弃（已删除、不存在、不是 docx 的直接放弃且不提醒，`isPermanent`），本人可 `--ignore`，读到后只改父文档里那条链接（父文档不再整理）；重新读取的进度存在 kv `lark_docs_refresh`，重启后接着读，本次已作为链接读过的跳过；更新检查（定时任务 `lark-docs-watch`，每天）按上次修改后 `docRecheckDays`（7/30/90/180/365 天）各查一次，用 `drive metas batch_query` 批量取最后修改时间，改过的才重读并整理；`omem lark docs-refresh` / 远程 `lark-docs-refresh`（进度 `lark-docs-status`）重读旧文档，远程 `lark-doc-import` 立即读一篇，只把飞书里内容变了的和新导入的交给整理；文件接口支持视频与 Range | 已实现，模拟 lark-cli 测试覆盖；`+media-download`、`+csv-get` 的真实返回待在常驻机器上用远程 `lark-doc-raw` 核对 | `src/channels/lark-docs.ts`、`/api/files/:name` |
| 飞书消息结构化与历史：每条消息另存 `lark_messages`（原始内容、回复对象、话题、图片文件、发送人类型、在原件中的行号）；被引用的消息不在库里时用 `+messages-mget` 补读；图片和文件经 `--download-resources` 保存；聊天行带“↩ 回复 X「…」”；历史回溯每次采集读几页，按月写入 `lark:<会话>@YYYY-MM` 原件（不在实时原件里插行，引用行号不变）；网页原件页用聊天视图显示 | 已实现，模拟 lark-cli 测试覆盖；已用真实账号核对：lark-cli 的引用回复字段是 `reply_to`（消息 id 字符串，不是开放平台的 `parent_id`），话题回复只有 `thread_id`，`--download-resources` 的 `resources`（`key`、`type`、`local_path`）解析正确 | `src/channels/lark-messages.ts`、`lark-personal.ts` 的 `backfillStep`、`web/src/components/ChatView.vue` |
| 飞书里的人：open_id 每个应用不同（lark-cli 与机器人不是同一个应用），人按邮箱对上——lark-cli 用 `contact +search-user --user-ids` 把自己的 open_id 批量换成名字和企业邮箱，机器人用 `contact.user.batchGetId` 把邮箱换成全企业通用的 user_id，自己收到的消息里的人直接记下 user_id 和邮箱；存在 `lark_people`。`lark_send` / `lark_card` 的 `mentions`（名字、邮箱、all）由宿主换成 `<at>` 标签；聊天原文和检索里去掉 `@名字(ou_…)` 的 id（消息记录里保留），网页在被 @ 的人后面显示邮箱；`omem lark bot-permissions` / 远程 `lark-bot-permissions` 检查机器人权限，给申请链接或扫码补齐；`lark-whois` 核对同一个人在两个应用里的 id | 已实现，测试覆盖；常驻服务器 上核对过：两个应用的 union_id 相同、open_id 不同，lark-cli 现有权限能按 open_id 取到邮箱，机器人按邮箱取 user_id 需要 `contact:user.id:readonly` | `src/channels/lark-people.ts`、`lark-messages.ts`、`lark-setup.ts`、`web/src/lib/chat.ts` |
| 飞书会话分类与采集方式：单聊（人）/ 机器人单聊 / 普通群 / 话题群 / omem 自己的机器人，免打扰状态；每类可设“保存并整理 / 与我有关时整理 / 只保存 / 不读取”，单个会话可覆盖；omem 机器人私聊和它在群里的发言不采集 | 已实现，模拟 lark-cli 测试覆盖；`p2p_target_type` 的取值待真实账号确认（另外按消息发送者是否为应用识别机器人单聊） | `lark-personal.ts`、设置 → 渠道、`set_lark_capture_policy` |
| 监听群：规则（档案、触发、回复方式 none/draft/auto），每条消息只处理一次，群/话题即处理会话 | 已实现 | `src/channels/lark-watch.ts`、`/watch`、`set_chat_watch` |
| 代码活动：仓库新提交与未提交改动，每仓库每天一份活动原件 | 已实现 | `src/sources/activity.ts` |
| 学习卡片（FSRS）、学习目标与主动提醒、聊天里复习 | 已实现，测试覆盖 | `src/learn` |
| 相关空间：`space_relations` 表（本人或 Agent 添加、本人移除后不再自动加回）；限定在一个空间的运行对相关空间只读（令牌分 `spaces` 与 `writable`）；运行环境列出相关空间与关系说明；`search`/`scan`/`find_symbol` 默认带上相关空间并标出命中所在空间；`remember` 返回相关空间里的相近记忆，记忆复核任务列出它们；定期整理从互相引用原件、页面互链、依赖清单（package.json、go.mod、pyproject、Cargo、pom）和共用标签找候选，交给 dreamer 用 `relate_spaces` 判断；`omem mcp` 按工作目录选默认空间；设置页和 `omem space relate` 管理 | 已实现，测试覆盖；真实 Agent 下的效果见验收 R1–R5 | `src/core/spaces.ts`、`src/core/space-candidates.ts`、`src/agents/runner.ts`、`tools.ts` 的 `relate_spaces`、`roles/dreamer.md` |
| 多用户口子：用户、渠道身份、空间成员、API 令牌；工具与接口按用户限定空间 | 已实现，测试覆盖；不做多租户隔离 | `src/core/users.ts`、`omem user` |
| 向量规模：按空间 int8 矩阵 | 已实现；17 万片段 nDCG 86.76 → 86.62，常驻 1.5GB → 0.42GB | `src/search/vectors.ts`、`scripts/bench-scale.ts` |
| 渠道：网页、CLI、MCP、飞书机器人、飞书个人消息（只读）、Telegram、OneBot（QQ/微信桥） | 已实现；OneBot 有模拟服务端测试；飞书与 Telegram 需真实账号验收 | `src/channels` |
| v1 导入 | 已实现，合成库测试 | `src/migrate-v1.ts` |

尚未做：扫描件 OCR；动态派发与依赖注入的调用无法静态解析（这些仍按名称列为候选）；tsconfig 的自定义 paths 只识别 `@/`、`~/`；多租户（只有多用户的口子）；微信官方接口（只能通过 OneBot 兼容桥）。评测数字见 [evaluation.md](evaluation.md)。
