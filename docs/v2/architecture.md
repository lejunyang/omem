# omem v2：精简重写方案

日期：2026-10-12，最后更新 2026-10-24。v1 的代码保留在 Git 历史中（`main` 分支 `12b4a55` 之前），本方案取代 `docs/archive/v1/reader-first/` 中的实施路线。

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
Channel（渠道）        Web、CLI、MCP、飞书机器人、飞书个人消息（只读；本人亲手发的私聊指令例外）、Telegram、OneBot（QQ/微信）
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

- **传输**：ACP 为主，`claude -p` / `codex exec` 作为无 ACP 时的后备；另有云端后端 `doubao`（豆包 OpenAPI 的 Managed Agent：设备码拿到用户 access_token 存 `secrets/doubao.json`，自动刷新；按 sessions / events / MessageStream 发消息读流式回复，会话保存在豆包，线程用 `resumeSessionId` 续聊；它在云端运行，用不了 omem 的 MCP 工具，适合问答写作）。飞书应用按 app 区分权限：`omem doubao status` 检查 omem 绑定的应用和 lark-cli 自己的应用各有哪些 `doubao:*` 用户权限，`omem doubao login` 以本人身份对指定应用做设备码授权。内置目录（`src/agents/catalog.ts`）列了 25 个 ACP Agent 的启动命令（Codex、Claude Code、Gemini、Copilot、Qwen、Cursor、OpenCode、goose、Kimi、Kilo、CodeBuddy、Qoder、iFlow、Droid…），PATH 里有就自动识别；其余从官方 ACP 注册表添加（npx / uvx，或下载对应平台的程序并校验 sha256 到 `~/.omem/agents/`）。模型与 effort 来自配置，启动时从 ACP 会话动态读取可选项：优先 session config options（model / thought_level），没有时用旧式 `session.models` + `session/set_model`。有的 Agent（TraeX）只在选中支持思考强度的模型后才给出 reasoning_effort，探测时逐个切换模型记下每个模型的强度（`effortsByModel`），选择界面按当前模型列出。服务端排队：TraeX 开 `headless_queue_status` 后用 `session_info_update._meta.trae.queueStatus` 报告排队（位置、提示），排队期间不计空闲超时（只受 `agents.queueTimeoutMinutes` 约束），思考气泡和进度卡片显示排队位置与等了多久。角色要求的权限模式按别名映射到各家的模式名（如 acceptEdits ↔ autoEdit、read-only ↔ ask）。Agent 返回的 JSON-RPC 错误把 `data`（如“未登录”“缺少 provider 配置”）带给用户并提示先在终端登录。
- **工具**：omem 自身以 MCP 服务暴露工具（`search`、`read_source`、`read_page`、`write_page`、`remember`、`forget`、`list_items`、`upsert_item`、`list_spaces` ……），通过 ACP `newSession.mcpServers` 注入。Agent 同时保有原生的文件读取与 shell（代码仓库只读）。
- **角色**由短技能文件定义（`roles/*.md`）：`assistant`（问答与交办）、`ingest`（新材料进来时更新记忆/页面/事项）、`memory-reviewer`（复核新记忆）、`wiki-planner` / `wiki-writer` / `wiki-linter`、`heartbeat`（巡检）、`brief`（简报）、`dreamer`（整理）、`curator`（筛选关注群）、`summarizer`（会话滚动摘要）、`coder`、`reviewer`、`tutor`（出卡）。共同约定在 `_common.md`。每个文件写目的、工具用法和质量标准，不写几十条禁令。可以按角色指定不同的 Agent 后端（`config.agents.roles`）。
- **Agent 档案与技能**：本人或助理建的专门 Agent（`library/_agents`，可指定后端、工具、写权限、技能、额外 MCP、工作目录）用 `run_agent` 或 `/as` 调用；技能（`library/_skills`）按名称列在提示里，Agent 需要时用 `read_skill` 读取。
- **会话**：`src/agents/threads.ts`、`sessions.ts`、`inbox.ts`。每个会话一次一轮，连发合并；Agent 会话在线保留 → 恢复 → 从摘要冷启动。只有材料没有话的消息（分享群、合并转发、图片、文件）多等 `contentWaitMs`。飞书机器人收到事件先应答、再处理，按消息 id 去重（`handled_messages`，channel `lark-bot`），飞书超时重推不会变成新的一轮。斜杠命令在 `commands.ts`，直接解析；`/new 任务`、`/topic 任务` 再把任务交给模型。`/topic` 接受飞书群聊或机器人私聊主界面中的消息，以该消息为根创建话题并取得真实 ID，再绑定独立会话；已有 `topicId` 的消息直接拒绝；`isolatedTopic` 保证后续消息不受整群 `mode=chat` 合并，进度与答案使用话题内消息作为回复锚点。
- **后台会话池**：`background-sessions.ts` 按角色说明（去除当前时间）、用户、可读写空间、工具/发消息权限、模型/强度、工作目录和额外 MCP 配置建立身份；同一实例只接一个任务，忙时另开。工具令牌逐轮指向当前运行。仅复用有本轮有效 `usage_update.used/size` 且占用不超过 `sessions.background.maxContextRatio`（默认 0.6）的在线 ACP 会话，缺用量、异常或取消即释放；空闲默认 60 分钟、最多 3 个进程，独立于聊天池。首次发送完整指令，后续只发时间和独立任务，说明变化另开。CLI 单次任务启用原生临时参数；ACP 临时会话释放时按声明能力调用 `session/delete`（Codex 实际归档，不能保证不落盘），普通聊天与显式续轮不调用。正常停服清理后台池，崩溃/强杀不保证清理。TraeX ACP 不支持 `--ephemeral`，也未声明 `session/delete`，由 catalog 的 `archiveArgs` 能力通过同一程序执行归档；其他后端可配置相同能力，无清理能力时明确提示。`traex-cli` 复用 exec 传输，单次任务带 `--ephemeral`。
- **多用户口子**：工具令牌带 userId，`scopeFor` / `accessibleSpaces` 决定能看哪些空间；非主人只有问答与自己的数据。
- **权限**：模型不直接写数据库，所有写入经 MCP 工具，工具层校验并记录到 Run。危险操作（发消息、应用补丁、删除）生成“待确认”事项。

## 五条主流程

### 1. 保存与问答
导入（文件/目录/URL/飞书文档/粘贴文本/聊天）→ 转文本（Markdown 直读；PDF/DOCX 调可选的 Docling 或 `pdftotext`；飞书走 `lark-cli`）→ 切片入索引 → 触发 `ingest` 角色：读新材料，查已有记忆与页面，决定新增/更新/作废记忆、更新相关 Wiki 页、建立或推进事项。

问答由 `assistant` 角色带工具调查后作答，答案带脚注引用。对话本身作为聊天原件保存，供后续“之前说过什么”。

### 2. 代码仓库 Wiki

聊天工具 `generate_wiki`、网页和 CLI 共用 `wiki/generate.ts` 入口。目标空间须可写，材料空间须可读，生成运行保存发起用户和只读范围；规划后每个写作子运行继承用户、材料范围和完整要求，不能扩大到新关联的空间。助手只负责发起与核验，正文由 Wiki 角色提交。当前实现以代码为准，文档补充背景和设计意图，冲突处标明过时说法。
1. `wiki-planner`：Agent 在仓库只读副本中自由浏览（原生工具），产出目录：每页的读者问题、类型（入门/机制/操作/参考）、入口文件。目录写入 `wiki/index.md`，人可在界面里改。
2. `wiki-writer`：逐页调查并写作，要求：先给一个真实例子走完整条路径，再讲概念和取舍，最后给“要改 X 去哪里”。引用落到文件行号。
3. `lint`：检查断链、引用失效、页面与代码不符（按 Git diff 找受影响页面），只重写受影响的页。

### 3. 记忆与纠正
记忆只能经 `remember` / `supersede` / `forget` 工具写入。用户说“不对，是 120 元”时，Agent 找到旧记忆，调用 `supersede(old, new)`；旧记忆保留并标为失效。界面展示一条记忆的演变链。

记忆质量分三层，都不需要本人逐条看（`src/memory/quality.ts`）：

1. **写入检查**：`remember` / `supersede` 先过确定性规则——主体是免责/不确定、超长（默认 400 字以上；几条独立结论应拆开，整套规则或流程应写成页面）、转述原件（“截至…收录的《…》说明”）、“日期 + 某人说了什么”式事件复述、助理自己的汇报、运行流水、后台角色没有来源或来源不存在、与有效记忆几乎相同。不通过就把理由作为工具错误还给模型（该建事项、该 supersede、或者不记），并按模型记一笔拒绝。
2. **复核**：每小时 `memory-review` 运行把新写的 Agent 记忆交给 `memory-reviewer` 角色，盲评（看不到是哪个模型写的）后保留、改写（supersede）、拆分或撤回。复核的后端/模型在 `memory.review` 里单独配置，最好和写入的不是同一个。只有复核保留或本人写的经验、偏好会被放进每次运行的提示。
3. **按模型比较**：记忆记录写入它的后端、模型、强度和运行；`memory.compare` 让每次整理再用别的模型跑一遍（`ingest-shadow`），写入只记录到 `shadow_writes` 不生效，经过同样的检查和复核。网页“记忆 → 质量”和 `omem memories stats` 按模型给出写入、拒绝、复核结果，以及同一份材料各模型的写法对照。

记忆可以带标签（`tags`），Agent 档案写的经验和偏好默认只属于那个档案（`agent` 字段），其他档案看不到，助理能看到全部。主助手可用 `remember(agent="档案名")` 教任意档案、`recall(agent="…")` 查看该档案的专属记忆；网页档案详情可直接挂/卸技能、查看和撤回专属记忆。

### 4. 事项与跟进
事项类型：`todo`、`waiting`（等谁回复）、`reminder`、`watch`（关注某项目/群/文档）。心跳任务按配置周期运行：读关注对象的新增材料和到期事项，由 Agent 判断是否有需要本人知道/决定的变化；无变化输出 `QUIET`，不打扰。

通知的 `context` 保存事项、事件、运行和本次 `sourceRefs`，发送后不随事项引用增长而变化；定时提醒读取设定提醒时的来源。事项来源纠正必须有旧来源快照和原因，来源历史留在事件。跨空间发现单独使用 `itemDiscoverySpaces`，不扩展普通检索或 `writable`；`item_update_proposals` 保存待复核进展，主助手检查两边写权限后应用。历史关联维护保存 `item_repairs` 快照，在一个事务中移动明确事件、保留未迁移事件共用的来源、修正通知/交互及运行标注，旧交互先失效；原飞书卡片刷新成功且交互未变化才重新开放。详见 [维护步骤](item-maintenance.md)。

### 5. 交办 Agent
`coder` 在目标仓库的 Git worktree 中工作；一个需求要同时改几个仓库（前端和接口、SDK 和调用方）时，每个仓库各开一个 worktree，放在同一个工作目录下，由同一个 coder 一起改。完成后宿主在每个仓库运行各自的检查命令，`reviewer`（可配置为不同模型）评审全部 diff；Run 页面显示计划、实际命令、按仓库的检查输出和 diff、评审结论。应用补丁需本人确认，所有仓库先逐个检查能否干净应用，都能才一起应用，之后删除 worktree。

改过的文件（新增和修改的，不含删除）在 worktree 存在期间建索引，放在临时空间 `wt-<运行id>-<仓库空间>`（类型 `worktree`）里：评审和之后的问答能用 `search` / `find_symbol` 查到新代码，仓库自己的索引不受影响。临时空间不出现在空间列表、定时任务和 `omem pull` 里，只能读不能写；worktree 删除（应用、丢弃，或手动删掉后的下一次仓库同步）时连同索引一起删除。

### 5b. 多 Agent 协同与长任务
复杂的委派（要调查、产出较长、可能再交办、或中途要本人定夺）不再直接在主会话里跑：`run_agent` 带 `own_topic=true` 时建立一条“工作会话”（`src/agents/agent-work.ts`）——网页里是主会话的子会话，飞书里是由原消息开出的新话题；工作会话以发起的 ask 运行为锚，记录轮次（最多 8 轮）。专门 Agent 的完整产出只留在工作会话；每轮完成（或失败）后，报告作为该 Agent 的消息放进工作会话，并在工作会话的通道里排一个“协调”回合（`ask` 带 `coordinate`）：主助手作为这项工作的负责人读报告，决定继续交办（可以换 Agent）、整理结论给本人、或请本人决定；本人在话题里的新消息和报告合并成同一回合。本人上次说话以后最多自动推进 `MAX_AUTO_TURNS`（6）次，到上限时工具拒绝再交办、提示词要求汇报。回复只发一处：工作会话已经是飞书话题时发在话题里，各 Agent 的完整报告折叠在同一张卡片下面；没有话题（网页、私聊）时发回主会话。同一个 Agent 的下一轮接着它上一轮的会话（`persistSession` + `resumeSessionId`），任务前面附上这项工作到目前为止的经过（本人的话、其他 Agent 的报告）。Agent 之间可以 `ask_agent` 同步请教（在提问的工具调用里直接运行，是一条可见的子运行，被请教的不能再请教或交办）。飞书里每个 Agent 的回合、请教和协调回合都有自己的原生思考气泡，按顺序显示在话题里（`lark-agent-cot.ts`）。编码交办停下（通过、到自动轮数上限、失败、无改动）时，发起的主助手在原会话接手一回合（`handoff`），不给编码工具，避免绕过轮数上限。话题键沿用飞书的 `omt_…` 原样（迁移会把旧的去前缀键改回来，并把同一话题的重复会话并到最早那个），本人在话题里的回复因此落在同一个工作会话；在话题里再委派会续在同一项工作上。主助手据此判断继续推进（`continue_agent_work` 在原话题续轮，不新开）或请本人介入；在话题里本人直接回复即在工作会话里继续。简单一次性的委派仍直接回主会话。编码交办走自己的链和“编码交办”卡片（见 5）。

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

## 实现状态（2026-10-23）

| 能力 | 状态 | 入口 |
| --- | --- | --- |
| 空间上下文：问答、原件和运行按当前空间显示；任务规则保存所属空间与结果会话，主助手为默认执行者，执行空间按动作 → 档案 → 规则 → 触发空间解析；群会话与采集共用绑定解析，旧的无空间任务规则保持全局 | 已实现；专项测试、浏览器空间切换与真实 Agent 抽查通过 | `src/core/capture-space.ts`、`rules/`、`Ask.vue`、`Runs.vue` |
| 原件归档：手动指定 / 来源绑定 → 按创建顺序首条匹配的归档规则 → archivist 内容判断 → 不确定留个人；条件使用中文选项与目录名称；AI 通过 propose_archive_rule 写草稿，核对后保存；自动归档先于记忆整理，按最终空间分组 | 已实现；2026-10-23 专项测试与真实 Agent 归档、规则草稿匹配抽查通过 | `sources/archive.ts`、`roles/archivist.md`、`roles/archive-rule-writer.md`、`ArchiveRules.vue` |
| 原件迁移：保留原件、切片、消息位置与引用 ID，同步空间字段并失效向量缓存；原始入口别名防止重新采集另建副本；历史预览 / 应用校验 hash 和当前规则，冲突不合并覆盖；原件详情可指定归属及查看记录 | 已实现，专项测试覆盖；不自动移动已有记忆、事项和 Wiki | `source_routes`、`source_locations`、`source_moves`、`Sources.vue` |
| 主助手对话创建空间、关联本地 Git 仓库或 Git 链接（clone 到数据目录 repos/）；路径去重、冲突检查、仅本人全空间运行可用 | 已实现；2026-10-15 | `src/core/repositories.ts`、`src/agents/tools.ts`、`roles/assistant.md` |
| 空间、原件、切分、全文 + 符号 + 可选向量检索；`read_source` 可读普通原件，也可读 `msg:<id>` 聊天消息和 `mem:<id>` 记忆（复核记忆时消息来源不再报“找不到原件”） | 已实现，测试覆盖 | `src/sources`、`src/search`、`src/agents/tools.ts` |
| 原件列表：普通空间平铺，代码仓库空间按目录展示；网址与会话标识不拆成目录，目录/文件节点明确区分；文件夹默认折叠（展开后跨分页保留、搜索时全展开），虚拟滚动，每页 1000 份滚动分页加载 | 已实现；2026-10-15 修复 URL 与超过 12 条数据导致的白屏；2026-10-19 分页折叠 | `web/src/views/Sources.vue`、`src/sources/store.ts` |
| Agent 运行时（ACP、claude/codex 命令行后备、豆包 OpenAPI 云端后端）与 MCP 工具（HTTP 与 stdio 桥）；25 个内置 ACP Agent + 官方注册表添加 | 已实现；假 ACP Agent 端到端测试；真实 Claude Code、OpenCode（含 MCP 工具调用）已跑通，Gemini / Qwen / Copilot / goose 握手通过（需登录） | `src/agents/acp.ts`、`tools.ts` |
| 问答、记忆更正与版本链、事项与时间线 | 已实现，真实模型抽查通过 | `roles/assistant.md` |
| 回复只取最后一次工具调用之后的文字（中途的“我先…”留在运行事件里，不再拼进回答）；发往聊天的本机文件路径改写成“仓库 · 路径:行号”，生成的文件作为附件发、在话题里时附件也发进话题 | 已实现，测试覆盖；2026-10-20 | `src/agents/types.ts` 的 `replyFromSegments`、`src/channels/common.ts` 的 `localPathLinks`、`tools.ts` 的 `larkPost` |
| 运行详情：所在会话（飞书话题 / 工作会话 / 普通会话）、同一会话的各轮、多 Agent 工作的各轮、由哪次运行发起；任务全文可展开 | 已实现；2026-10-20 | `src/server/http.ts` 的 `runContext`、`web/src/views/Runs.vue` |
| 外部只读访问（分享链接、自定义域名） | 设计，未实现 | [external-access.md](external-access.md) |
| 分档、多角度评审与变更解读：档位（默认轻 / 标准 / 完整，条件、评审项、轮数可在 Agent 页“评审”标签改）与评审项（内置五项 + 本人新建的专项，都是 Agent 档案）、review-lead 判档协调与防死循环、结构化问题汇总、事项材料与业务简报、运行详情里的“本次评审”与变更视图 | 设计，未实现 | [review.md](review.md)、[界面原型](design/review-prototype.html) |
| 通知策略：只对未读 / 紧急 / 临期 / 未处理推送（飞书已读状态经 lark-cli 查询），22:00–09:00 静默（本人设定的定时提醒除外）；巡检对能自己查的事先查再报，并可直接开话题推进 | 已实现；2026-10-20 | `src/core/config.ts` 的 notify、`lark-read.ts`、`roles/heartbeat.md` |
| 规则：新消息（机器人实时 + 本人采集，按规则去重）/ 第一次看到的群 / 定时触发；条件是宿主求值的 JSON（群名、机器人、发送人、邮箱、正文、类型、@ 本人、卡片标题，all/any/not），判断方式 条件 / 条件 + 模型确认 / 模型（每规则每小时 60 次）；动作：交给 Agent（可在消息下处理，话题由它的气泡或回答开出，不发“规则触发”卡片；只能在这个群回复，回复方式 只告诉我/先给我看/直接回复/静默排查——静默时群里不出过程，它自己决定发不发、追问什么，发过言的话题跟进 24 小时，本人插话即停）；等几分钟再处理、本人已在讨论里/已有人回复就跳过（动手时读话题或前后半小时的讨论，`src/rules/context.ts`），模型判断带上讨论、持续监听、拉机器人进群（本人身份唯一的写操作）、优先采集、通知；模型从原话生成规则、试运行、触发记录；助理 `save_rule` 建的默认不启用 | 已实现，测试覆盖；2026-10-21，真机待验 | [rules.md](rules.md)、`src/rules/`、`web/src/views/Rules.vue` |
| 飞书思考过程原生气泡（`message_cot` + AG-UI，content 为 JSON 字符串）：发送期间的新事件持续补推，推理节点和工具结果齐备后收尾；缺失工具完成事件 30 秒后标记缺失并结束；请求和失败日志按运行、气泡、请求序号关联，不记正文 | 已实现；2026-10-22 收尾竞态、超时与诊断日志有假客户端回归，真实气泡展示待验 | `src/channels/lark-cot.ts`、`test/lark-cot.test.ts` |
| 前端路由 chunk 空闲预加载、菜单 hover 预取 | 已实现；2026-10-20 | `web/src/preload.ts`、`main.ts` |
| Agent 学习分层：档案=身份（Agent 写入限长）、技能=做法、档案记忆=偏好/经验（scope=agent） | 已实现；2026-10-20 | `src/agents/specs.ts`、`roles/_common.md` |
| 内置角色作为档案：Agent 页可见、可自定义（复制到 `library/_roles/`，记下基于的源码），源码更新后提示，可恢复源码版本或三方合并（`git merge-file`，冲突交给模型 `role-merge` 运行）；`omem roles`；内置角色也有专属记忆和挂载技能（`remember/save_skill(agent="reviewer")`），运行时注入；档案名不能与内置角色重名 | 已实现，测试覆盖；2026-10-21 | `src/agents/builtin-roles.ts`、`profile-jobs.ts`、`web/src/views/Agents.vue` |
| 档案进化：每晚 `profile-review` 挑最近有纠正或失败的档案/角色交给 coach 复盘（运行产出 + 之后本人在同一会话说的话），经验直接记成专属记忆，提示词/技能/设置的改动存为 `profile_proposals` 等本人采纳；档案页显示使用情况、待采纳建议（提示词给出差异）、历史，可立即复盘 | 已实现，测试覆盖；真实模型复盘待验 | `roles/coach.md`、`src/agents/proposals.ts`、`profiles.ts`、`components/ProfileLearning.vue` |
| 记忆召回与命中统计（recall 落账，回答/写入引用计为命中），网页“记忆 → 召回”治理 | 已实现；2026-10-20 | `src/memory/recall-stats.ts`、`web/src/views/Memory.vue` |
| 对话前带上相关记忆：本人新消息与记忆向量余弦过门槛（默认 0.6，最多 5 条）的事实、约定、人物、决定附在这一轮后面，同一 Agent 会话不重复；偏好与经验仍走每次运行的固定提示；访客不带；召回统计按 `via=passive` 单列 | 已实现；2026-10-22，门槛在 T2 正反例上校准，codex 真实抽查 | `src/memory/passive.ts`、`sessions.ts` 的 `passiveForTurn`、`scripts/eval-recall-gate.ts` |
| 写记忆前先对照已有的：整理新材料时任务里附上按向量找到的相近记忆；`remember` 遇到同一空间里相近的（向量 ≥ 0.75，或主题名相同）先不写、列出来，Agent 选择 supersede / 不写 / `distinct_from` 后再写，并提示沿用已有的主题名和标签；做梦整理时宿主列出可能重复的记忆对 | 已实现；2026-10-22，门槛在手写记忆对上校准 | `src/memory/passive.ts` 的 `memoriesNearWrite`、`sameTopicPairs`，`jobs.ts` 的 `knownNearMaterial` |
| 问本人、下一步按钮、工具审批（统一的 `asks`）：`ask_owner` 提问（选项按钮 + 文字），先等一会、`wait_answer` 每次最多 50 秒（低于各家 MCP 工具超时），没等到的回答在提问的运行结束后作为消息回到会话；`suggest_next` 在回答下附 1–3 个下一步按钮，点了替本人说出那句话；对话里直接回复或回编号也算回答，新话题让旧按钮失效；`approvals.tools` 列出的工具调用要本人批准（默认空），批准后按原上下文执行，拒绝理由回给 Agent。飞书卡片、网页（对话页与“今天”页）、文字渠道（编号列表）三处都能答 | 已实现；2026-10-23，测试覆盖，codex 真实抽查（提问后同一轮更正记忆） | `src/agents/asks.ts`、`src/channels/lark-asks.ts`、`web/src/components/AskCard.vue`、`tools.ts` 的 `ask_owner` / `wait_answer` / `suggest_next` / `held` |
| 工作文件：`write_file` 写原件 `kind=work`（`work/<路径>`，可追加、可设过期，过期由巡检转成墓碑），可挂到事项（详情和 `read_item` 列出）或规则（规则触发的运行里写的自动挂上，下次触发列给 Agent）；不进记忆整理。案例页：`write_page(kind=case)` 放 `cases/`，事项经过几轮进展后完成时工具提示写案例 | 已实现；2026-10-23，测试覆盖 | `src/sources/work.ts`、`tools.ts` 的 `write_file`、`rules/actions.ts` 的 `ruleFiles` |
| 定时 / 消息唤醒：`wake_later` 排一条带 `not_before` 的 `wake` 运行，`wake_on_message` 建一条临时规则（`rules.temporary`，动作只有 `wake`，触发一次或到期删除）；醒来时原会话的 Agent 接着原会话开一轮（无话可说回 QUIET 不发），或给指定档案开一次运行、结果发回原会话；档案从规则运行中唤醒自己时继承原空间、本人身份和投递范围（话题、草稿/静默模式），换档案不继承；QUIET 不投递。每处最多 5 个、最远 7 天；规则页“临时唤醒”可取消，确认弹窗的长说明自动换行、限高滚动，操作按钮始终可见 | 已实现；2026-10-23，测试覆盖（含假 ACP 会话延续） | `src/agents/wakes.ts`、`tools.ts`、`rules/actions.ts` 的 `wake`、`docs/v2/rules.md` |
| 日常不足信号：回答说没找到、本人纠正回答、失败运行、复核撤回、写入被拦、被动召回未用，确定性挑出；每晚做梦整理逐条判断能不能补；网页“记忆 → 不足” | 已实现；2026-10-23，测试覆盖；匹配规则是中文常见说法，会有漏判和误判 | `src/memory/gaps.ts`、`jobs.ts` 的 dream、`GET /api/shortcomings` |
| 新材料整理（记忆/事项/页面/通知） | 已实现；事项发现与写权限分离，只读跨空间进展经提案复核 | `roles/ingest.md` |
| 事项来源与历史关联维护 | 来源 merge / replace / remove、事件通知快照、整张卡片 URL 去重、受限维护审计与原卡片刷新；来源区与网页“相关依据”显示原件标题和所引行的摘要（`refExcerpt`），不再是“原文1/原文2”；假客户端回归覆盖 | `src/items/`、`docs/v2/item-maintenance.md` |
| 记忆质量：写入检查（免责式、超长、转述原件、事件复述、助理汇报、运行流水、无来源、重复）退回并说明原因；每小时盲评复核（保留/改写/撤回，可用不同模型）；对比运行（其他模型的写入只记录）；按模型统计；记忆标签与档案专属记忆 | 已实现，测试覆盖；规则用一批真实运行产生的 Agent 记忆校准过；复核与对比运行待真实模型验收 | `src/memory/quality.ts`、`roles/memory-reviewer.md`、网页“记忆 → 质量”、`omem memories` |
| 代码仓库 Wiki：规划 → 逐页写作 → 原件变化后检查 | 已实现；zustand 12 页实测 | `roles/wiki-*.md` |
| 巡检（到期提醒不调模型；关注/等待有新材料时才调用） | 已实现 | `roles/heartbeat.md` |
| 简报、做梦整理、经验与偏好回灌到后续任务 | 已实现 | `roles/brief.md`、`dreamer.md`、`runner.ts` |
| 交办编码：worktree → 检查 → 独立评审 → 确认后应用；评审不通过自动续轮（最多 3 轮），复用同一 worktree 和编码 Agent 会话；长任务 `run_agent(own_topic=true)` 开独立工作会话（飞书话题），digester 只把结论回主会话 | 已实现，演示仓库实测 | `src/agents/code.ts`、`code-chain.ts`、`agent-work.ts` |
| 编码进度卡片：已有话题解析真实消息锚点，原卡片跨轮更新；创建/更新失败持久记录脱敏错误、有限重试和重启恢复，显式 `retry_code_progress` 恢复；自动三轮上限后持久等待本人，手动继续可到第 4 轮及以后 | 假客户端和工具回归覆盖；真实飞书待应用后验收 | `src/channels/lark-code-progress.ts`、`src/agents/code-chain.ts`、`tools.ts` |
| 交办可同时改多个仓库（每个仓库一个 worktree，一起应用）；改过的文件在 worktree 存在期间可检索，删除时索引一起删 | 已实现，测试覆盖（`test/code-worktrees.test.ts`）；2026-10-19；真实 Agent 跨仓库交办待验 | `src/agents/code.ts`、`src/agents/worktree-index.ts` |
| 跨文件调用图：按导入绑定解析调用到具体定义（相对路径、index、`.js`→`.ts`、`@/` 别名、重导出、默认导出、命名空间、`this`/`self` 方法；Python 绝对/相对/包导入） | 已实现，测试覆盖；本仓库 4032 处调用中 1098 处解析到仓库内定义，其余多为标准库与对象方法 | `src/sources/callgraph.ts`、`find_symbol`、原件页“结构”栏 |
| Go / Rust / Java / Kotlin / Swift：tree-sitter（`web-tree-sitter` 0.25 + `tree-sitter-wasms`，WebAssembly，按需加载语法）切分符号、导入和调用；按包（Go 目录与导入路径、Java/Kotlin 包与静态导入、Rust `use`/`mod`/工作区 crate、Swift 整个模块）解析，隐式 this/self、接收者、扩展、伴生对象 | 已实现，测试覆盖；真实仓库抽查：cobra 31%、ripgrep 18%、gson 22%、moshi 18%、Alamofire 20% 的调用解析到仓库内定义（其余多为对变量调用方法和标准库/测试框架）；Swift 解析较慢（约 70 ms/千行，其余语言快一个数量级） | `src/sources/treesitter.ts`、`callgraph.ts` |
| C / C++ / Objective-C、C#、PHP、Ruby、Scala、Dart、Lua、Zig、Elixir、OCaml、ReScript、Solidity、Bash、Emacs Lisp：tree-sitter，按语言写成小规格（声明、成员、调用、导入节点）由 `treesitter-more.ts` 统一抽取；语法按需加载。调用解析按名称：本类型（含 C++ 类外定义、Ruby 重开类）→ 本文件 → 导入带进来的文件（`#include` 连同同名 .c/.cpp、`require`、`open`、不带别名的 `import`）→ `类型.成员` → 同语言里唯一的同名定义；C++/C# 命名空间里的函数只对同一命名空间内可见 | 已实现，多语言夹具测试覆盖；真实仓库解析率：cJSON 70%、fmt 31%、plug（Elixir）43%、MediatR（C#）16%、Slim（PHP）16%、sinatra 14%、os-lib（Scala）24%、dart-lang/http 24%、inspect.lua 25%。已知误连：用宏包起来的命名空间（如 fmt 的 `FMT_BEGIN_NAMESPACE`）被当成全局，`printf`/`size` 这类常见名会连到项目里同名的定义。Lua 用 vendor/ 里较新的语法（tree-sitter-wasms 里的 Lua 语法第二次解析起就出错）；Elm、QL 的语法与运行时不兼容，未接入 | `src/sources/treesitter-more.ts`、`callgraph.ts` 的 nameResolver |
| 汇总类问题：`scan` 穷举扫描所有命中行（可按时间段），助理先列清单再计数 | 已实现 | `tools.ts`、`roles/assistant.md` |
| 主动留意：问答时顺带记下本人透露的计划、承诺、等待和长期事实；做梦时复查这段时间本人说过的话补漏；聊天整理时同样关注本人自己的发言 | 已实现，真实模型抽查通过 | `roles/assistant.md`、`dreamer.md`、`ingest.md` |
| 会话线程：私聊 / 群 / 话题（飞书 thread_id、Telegram 论坛话题）各自一个会话；Agent 会话在线保持 → 恢复（ACP session/resume|load、`claude --resume`、`codex exec resume`）→ 从滚动摘要冷启动；连发合并；每会话串行、会话间并行；对话与后台分开的并发槽；空闲过期后新会话带上一段摘要；斜杠命令 | 已实现；假 ACP Agent 测试覆盖；真实 Claude Code ACP 验证了在线续聊和重启后恢复 | `src/agents/threads.ts`、`sessions.ts`、`inbox.ts`、`commands.ts` |
| `/new [任务]` 新会话立即执行；`/topic <任务>` 从飞书群聊或机器人私聊以指令消息为根开启独立话题，已有话题拒绝，先取得真实话题 ID 再排任务，开话题失败不启动 AI；保留空间、用户及发消息权限 | 已实现；假 ACP 与飞书客户端覆盖首轮、续聊、整群模式隔离、私聊开话题、已有话题拒绝和失败；真实 Codex 执行两条指令的任务通过，真实飞书待验 | `commands.ts`、`inbox.ts`、`threads.ts`、`lark-bot.ts`、`lark-send.ts` |
| 能力沉淀：Agent 档案（`library/_agents/*.md`：prompt、后端/模型、工具、写权限、技能、MCP、目录、AGENTS.md 式约定）与技能（`library/_skills/*/SKILL.md`）；助理可建、可委派（`run_agent`、`/as`），结果发回原会话；做梦起草草稿，本人 `/approve` | 已实现；真实模型建档案与技能已验 | `src/agents/specs.ts`、网页“Agent”页 |
| 技能目录编辑：递归列出技能目录及文件，网页切换、修改、新建附属文本文件和删除；SKILL.md 校验入口，修改保留 Git 历史；拒绝越界、符号链接、二进制和超过 2 MB 的文件 | 已实现，自动化及网页验收见 acceptance.md | `specs.ts`、`server/http.ts`、`web/src/views/Agents.vue` |
| 默认 AI 与任务选型：内置角色与自定义档案统一在 Agent 页配置；可用后端优先，模型/强度按检测结果选择。设置页维护自主选型开关、文字偏好与带适用说明的候选组合；交办、续轮、请教支持 execution，编码另有 review_execution；临时 assistant 任务继承调用者范围；切换 AI 不恢复不兼容会话 | 已实现，自动化及真实 Agent 验收见 acceptance.md | `execution.ts`、`runner.ts`、`agent-work.ts`、`code-chain.ts`、`AiDefaults.vue`、`AiRouting.vue` |
| 注入标记（可选）：本地 StartLux-Decision 判官给别人写的群聊/网页/文档打标，提醒 Agent 只当材料；不拦截。omem 按需拉起 llama-server（osdk `conda:llama.cpp`）和模型自带的 Python 服务（`scripts/startlux`，uv 锁定），空闲 3 分钟关闭；也可指向自己运行的服务 | 已实现；macOS arm64 上 0.8B 端到端验证（首次启动约 15 秒，之后每段约 60ms）；评测见 judge-models.md | `src/sources/guard.ts`、`judge.ts` |
| 设置向导 `omem setup`：Agent、向量模型（osdk）、Docling 及其模型（osdk，uv 经 `osdk install conda:uv`（独立程序，不依赖 osdk 的 Python））、渠道、注入标记、会话、定时任务；结束时可启动/重启后台服务 | 已实现；osdk 安装 uv / llama.cpp、uv 解析 Docling 依赖在 macOS arm64 与 Linux x86_64 验证 | `src/setup.ts`、`src/core/tools.ts` |
| 飞书机器人接入：读 lark-cli 的应用与登录状态和 omem 已保存的应用；绑定已有应用或扫码新建（官方 SDK `registerApp`，同时申请权限、长连接事件和卡片回调）；校验凭据和机器人能力；扫码人 open_id 设为本人；App Secret 存 `secrets/lark.json`（0600）；lark-cli 未登录时就地扫码登录 | 已实现；SDK 注册流程真实发起到二维码一步，扫码确认待真实账号验收；其余假客户端测试覆盖 | `src/channels/lark-setup.ts` |
| 后台服务 `omem service`：自带 PM2（独立 PM2_HOME）、崩溃自动重启、pm2-logrotate 日志轮换；`enable` / `disable` 开机自启（macOS LaunchAgent、Linux systemd 用户服务 + linger 或 crontab `@reboot`、Windows 启动文件夹里的隐藏脚本） | 已实现；macOS 本机 start / restart / stop / status 验证；三个平台的自启文件与命令有单元测试，真机待验收 | `src/core/service.ts`、`src/core/autostart.ts` |
| 更新：`osdk run upgrade` / `scripts/upgrade.ts`（拉代码、装依赖、构建、`npm install -g .`、可选重启）；远程 `update` 命令复用它 | 已实现 | `scripts/upgrade.ts`、`osdk.toml` |
| 多台设备（同伴）：一行配对码配对（本机各网卡地址 + 本人 API 令牌，add 时挑能连上的，之后断线自动换地址）；`omem link` 给浏览器的带令牌链接；`omem peer open` 在本机转发同伴的整个网页（转发端点对 GET 也放行网页文件）；`omem user tokens|revoke`；经中间节点转发（`via`，最多 3 跳）；`/api/diag` 诊断；固定的远程命令（诊断、日志、配置、飞书只读查询、采集与回溯、记忆统计、运行记录、只读 SQL、git、更新并重启）；`omem pull <同伴>` 经 HTTP 拉快照；默认监听所有网卡，没有配置令牌时只信任本机请求（旧配置里写出的 `127.0.0.1` 视为未设置，`localhost` 表示只给本机） | 已实现，三节点（服务器、中间、笔记本）测试覆盖；真实设备待验收 | `src/core/peers.ts`、`peer-exec.ts`、`pull.ts` 的 `fetchPeer`、`omem peer` |
| 临时白名单转发 `scripts/relay.mjs`：文件收件箱 → 经 ssh（可多跳）执行允许的命令 → 结果写回 | 已实现；用假 ssh 验证了两跳下参数原样传递 | `scripts/relay.mjs` |
| 飞书机器人能力：回复/话题回复、表情、Markdown、图片文件、Card 2.0（按钮、下拉、输入、选人、日期、表单）、限定处理人、草稿确认、原生思考气泡及状态兜底卡片（不再显示过程）；气泡投递失败尝试撤回并单独写 `output.thinkingDelivery`，不修改任务状态，超时不冷却后续轮次，权限拒绝只冷却当前群；卡片与表情的慢请求在回答收尾时等待并清理；卡片回调回到原会话；分享的群读出群名、chat_id 和是否已采集，合并转发读出其中的消息，引用助手自己的回复时取回答原文 | 已实现；假客户端测试覆盖，真实飞书待验收 | `src/channels/lark-send.ts`、`lark-actions.ts`、`lark-progress.ts`、技能 `lark-messaging` |
| 飞书个人采集（lark-cli）：全部或订阅会话增量拉取（每会话游标、话题回复）、附件与文档链接入库、日程、妙记 | 已实现；模拟 lark-cli 测试覆盖，真实账号待验收 | `src/channels/lark-personal.ts` |
| 飞书文档原件本地化：图片（Markdown 与 DocxXML 两种写法）、画板缩略图、视频和附件（`lark.capture.docMediaMaxMB`，默认 100 MB 以内）经 `docs +media-download` 存进 files/（下载被拒时改用 `+media-preview`，限流时退避重试），正文写 `omem-file:`（表格里的图片和视频用 HTML `<img>`/`<video>`，链接用 `<a href="src:…">`，网页渲染时换成本地地址），按素材 token 缓存；DocxXML 的分栏、高亮块、按钮、书签、勾选、子页面列表转成网页能显示的 HTML（分栏和高亮块前后留空行，里面的 Markdown 才会被解析）；内嵌电子表格经 `sheets +csv-get` 转成表格；同步块读源文档的对应块；`<cite>` 与正文里的文档链接导入同一空间（`docLinkDepth` 层，默认 2，从给 omem 的那篇算起，每篇记下自己还能跟几层，重新读取时不重新起算；每篇最多 `docMaxLinked` 篇，默认 30；链回上层的不重复读），换成 `src:` 链接，回指的链接在保存后补上；一次导入里读不到的合成一条通知；读不到的记在 kv `lark_doc_missing`，一次导入或一次重新读取汇总一条通知，按 `docRetryHours`（默认 6）重试至多 `docRetryMax`（默认 3）次后安静放弃（已删除、不存在、不是 docx 的直接放弃且不提醒，`isPermanent`），本人可 `--ignore`，读到后只改父文档里那条链接（父文档不再整理）；重新读取的进度存在 kv `lark_docs_refresh`，重启后接着读，本次已作为链接读过的跳过；更新检查（定时任务 `lark-docs-watch`，每天）按上次修改后 `docRecheckDays`（7/30/90/180/365 天）各查一次，用 `drive metas batch_query` 批量取最后修改时间，改过的才重读并整理；`omem lark docs-refresh` / 远程 `lark-docs-refresh`（进度 `lark-docs-status`）重读旧文档，远程 `lark-doc-import` 立即读一篇，只把飞书里内容变了的和新导入的交给整理；文件接口支持视频与 Range | 已实现，模拟 lark-cli 测试覆盖；`+media-download`、`+csv-get` 的真实返回待在常驻机器上用远程 `lark-doc-raw` 核对 | `src/channels/lark-docs.ts`、`/api/files/:name` |
| 飞书知识库：知识库页面的子节点（`wiki +node-get` / `+node-list`，本人身份）算作同一层的链接，层数从最先给的那篇算（`docLinkDepth`），每页最多 `docWikiChildren` 个，一次导入最多 `docMaxPerImport` 篇；正文没链到的子页面列在末尾。知识库爬取：队列存 kv（`lark_wiki_crawls`），按目录树广度优先，层数、总量（`wikiCrawlMaxDocs`）、每批篇数可设，一批读完暂停等继续，重启后接着读；读到的页面互相改成本地链接，交给整理；`lark_wiki_crawl` 工具、`omem lark wiki-crawl`、设置页 | 已实现；假 lark-cli 测试覆盖（层数、总量、分批、缺权限暂停），真实知识库待验收 | `src/channels/lark-wiki.ts`、`src/channels/lark-docs.ts` |
| 以本人身份写飞书文档：`lark_doc_create` / `lark_doc_update`（append、str_replace、overwrite）/ `lark_doc_move`（`docs +create`/`+update`、`wiki +move`/`+move-to-drive`）；个人文档库（`my_library`）和本人拥有的云空间文件夹、文档直接写，其余位置每次都经审批（问题里写明知识库、父页面），批准后带 `approved` 重跑；只在 omem 自己的运行里可用 | 已实现；假 lark-cli 测试覆盖，真实账号待验收 | `src/channels/lark-doc-write.ts`、`src/agents/tools.ts` |
| lark-cli 本人登录的权限：错误里的 `missing_scopes` 变成 `LarkScopeError`；`asOwner` 遇到时用 `auth login --scope … --no-wait` 发起只要那一项的授权，链接发给本人，后台 `--device-code` 等确认；`omem lark user-permissions`、设置页检查读知识库和写文档要的权限 | 已实现；假 lark-cli 测试覆盖 | `src/channels/lark-auth.ts`、`src/channels/lark-cli.ts` |
| 飞书加急与仅部分人可见：`lark_send` / `lark_card` 的 `urgent`（发出后 `im.message.urgentApp`，应用内加急）和 `only_to`（`/ephemeral/v1/send` 临时卡片，逐人发）；工具上下文 `larkPowers` 决定能不能用：规则 agent 动作的 `allowUrgent` / `allowPrivate`，或本人自己可往任何会话发的运行；草稿确认时照样带上 | 已实现；假客户端测试覆盖，临时卡片的卡片格式待真实租户验证 | `src/channels/lark-send.ts`、`src/agents/tools.ts`、`src/rules/actions.ts` |
| 飞书消息结构化与历史：每条消息另存 `lark_messages`（原始内容、回复对象、话题、图片文件、发送人类型、在原件中的行号）；被引用的消息不在库里时用 `+messages-mget` 补读；图片和文件经 `--download-resources` 保存；聊天行带“↩ 回复 X「…」”；历史回溯每次采集读几页，按月写入 `lark:<会话>@YYYY-MM` 原件（不在实时原件里插行，引用行号不变）；机器人实时写入和本人采集写同一个聊天原件，各自跳过对方已写的消息（按行尾消息 id，`linesWritten`）；缺图片或附件的旧消息可批量补拉（`fillResources`：CLI `lark fill-files`、远程 `lark-fill-files`、`set_lark_backfill files`）；网页原件页用聊天视图显示 | 已实现，模拟 lark-cli 测试覆盖；已用真实账号核对：lark-cli 的引用回复字段是 `reply_to`（消息 id 字符串，不是开放平台的 `parent_id`），话题回复只有 `thread_id`，`--download-resources` 的 `resources`（`key`、`type`、`local_path`）解析正确 | `src/channels/lark-messages.ts`、`lark-personal.ts` 的 `backfillStep`、`web/src/components/ChatView.vue` |
| 飞书里的人：open_id 每个应用不同（lark-cli 与机器人不是同一个应用），人按邮箱对上——lark-cli 用 `contact +search-user --user-ids` 把自己的 open_id 批量换成名字和企业邮箱，机器人用 `contact.user.batchGetId` 把邮箱换成全企业通用的 user_id，自己收到的消息里的人直接记下 user_id 和邮箱；存在 `lark_people`。`lark_send` / `lark_card` 的 `mentions`（名字、邮箱、已核实的机器人侧 ID、all）由宿主换成 `<at>` 标签；已知 open_id 可直接使用，姓名不明确时在授权目标群内完整分页核对成员（不按名字合并跨应用身份，重名或分页不完整拒绝），邮箱查询错误保留权限原因；机器人只用本应用已收到的 @ 中的 open_id，不用 app_id；聊天原文和检索里去掉 `@名字(ou_…)` 的 id（消息记录里保留），网页在被 @ 的人后面显示邮箱；`omem lark bot-permissions` / 远程 `lark-bot-permissions` 检查机器人权限，给申请链接或扫码补齐；`lark-whois` 核对同一个人在两个应用里的 id | 已实现，测试覆盖；常驻服务器 上核对过：两个应用的 union_id 相同、open_id 不同，lark-cli 现有权限能按 open_id 取到邮箱，机器人按邮箱取 user_id 需要 `contact:user.id:readonly` | `src/channels/lark-people.ts`、`lark-messages.ts`、`lark-setup.ts`、`web/src/lib/chat.ts` |
| 飞书会话分类与采集方式：单聊（人）/ 机器人单聊 / 普通群 / 话题群 / omem 自己的机器人，免打扰状态；每类可设“保存并整理 / 与我有关时整理 / 只保存 / 不读取”，单个会话可覆盖；omem 机器人私聊和它在群里的发言不采集 | 已实现，模拟 lark-cli 测试覆盖；`p2p_target_type` 的取值待真实账号确认（另外按消息发送者是否为应用识别机器人单聊） | `lark-personal.ts`、设置 → 渠道、`set_lark_capture_policy` |
| 监听群：规则（档案、触发、回复方式 none/draft/auto），每条消息只处理一次，群/话题即处理会话 | 已实现 | `src/channels/lark-watch.ts`、`/watch`、`set_chat_watch` |
| 代码活动：仓库新提交与未提交改动，每仓库每天一份活动原件 | 已实现 | `src/sources/activity.ts` |
| 学习卡片（FSRS）、学习目标与主动提醒、聊天里复习 | 已实现，测试覆盖 | `src/learn` |
| 相关空间：`space_relations` 表（本人或 Agent 添加、本人移除后不再自动加回）；限定在一个空间的运行对相关空间只读（令牌分 `spaces` 与 `writable`）；运行环境列出相关空间与关系说明；`search`/`scan`/`find_symbol` 默认带上相关空间并标出命中所在空间；`remember` 返回相关空间里的相近记忆，记忆复核任务列出它们；定期整理从互相引用原件、页面互链、依赖清单（package.json、go.mod、pyproject、Cargo、pom）和共用标签找候选，交给 dreamer 用 `relate_spaces` 判断；`omem mcp` 按工作目录选默认空间；设置页和 `omem space relate` 管理 | 已实现，测试覆盖；真实 Agent 下的效果见验收 R1–R5 | `src/core/spaces.ts`、`src/core/space-candidates.ts`、`src/agents/runner.ts`、`tools.ts` 的 `relate_spaces`、`roles/dreamer.md` |
| 多用户口子：用户、渠道身份、空间成员、API 令牌；工具与接口按用户限定空间 | 已实现，测试覆盖；不做多租户隔离 | `src/core/users.ts`、`omem user` |
| 飞书通知外链：普通通知与事项卡片保留 HTTP(S) 链接按钮；站内路由、无效地址和其他协议不变成按钮，事项已有同一外链时去重 | 已实现，假客户端回归覆盖 | `src/channels/item-notification.ts`、`lark-bot.ts`、`test/notification-card.test.ts` |
| 飞书引用：规则首次开话题回复、主动发消息/卡片、草稿与卡片更新统一转换原件引用；有外部地址则链接原文，内部引用退成文字，卡片回调数据保持原样 | 已实现，假客户端及真实 Agent 验证 | `src/channels/common.ts`、`src/agents/jobs.ts`、`src/agents/tools.ts` |
| 普通群内提及：完整成员列表无同名成员时跳过该对象，继续发送其余提及与正文；不回退全局同名记录或邮箱。群内重名、分页和权限错误仍保留；加急与限定收件人不静默降级，已知机器人身份继续按原方式使用 | 已实现，假客户端与真实只读成员核验 | `src/channels/lark-people.ts`、`src/agents/tools.ts` |
| 飞书附件：原文件先保存；文档解析作为持久化 `lark-resource-parse` 运行串行执行，失败独立重试，成功关联原消息并交给整理；异步解析不阻塞采集或交互。原视频必需，封面可选，外链副本不计入原附件。Docling 同时支持源码和构建路径，Office / CSV 按格式分流，旧版 Office 缺 LibreOffice 明确报错 | 已实现；下载、分页、解析失败与重试分别验证 | `lark-messages.ts`、`lark-resource-keys.ts`、`lark-resource-parse.ts`、`sources/import.ts`、`scripts/document-parser/convert.py` |
| 飞书实时消息的发送者：兼容事件 `bot` 与读取接口 `app`；用户查通讯录，机器人通过只读采集接口核对同一群、同一条消息的名称，只保存机器人应用侧 ID；成功名称缓存 10 分钟，失败不缓存；匹配规则前等待群名查询；入库保留机器人类型，后续采集修正旧类型 | 已实现；假客户端覆盖名称规则触发与去重，真实卡片仅判断验证通过 | `src/channels/lark-sender.ts`、`lark-bot.ts`、`lark-messages.ts` |
| 飞书访客：未登记的人 @ 机器人（或私聊它，可选）、别的机器人 @ 它（规则没接手时）→ `guest` 运行：`gatekeeper` 角色判断回答 / 拒绝 / 不理，`guest` 角色只读群所在空间（个人空间不开放）与 `lark.guests.spaces`，不给技能、相关空间、本人偏好和发消息工具；每人每小时上限；有人 @ 机器人时规则让开（`rule_handled` 里记 `@bot`） | 已实现，假 ACP Agent 测试覆盖；真实飞书待验 | `src/channels/lark-guest.ts`、`lark-bot.ts`、`roles/gatekeeper.md`、`roles/guest.md`、`rules/store.ts` 的 `markAddressed` |
| 访客在本人也在的群：`lark.guests.ownerPresent`——`guest` 照常；`gated` 把关（`gateOnly` 的 guest 运行）后交给主助手，按本人身份运行、消息带 `asker`（会话里显示“某某（群里的同事，不是本人）”）；`free` 不把关直接交给主助手。本人在不在群用机器人的群成员接口判断，缓存半小时 | 已实现，把关部分测试覆盖；群成员判断待真机验 | `lark-guest.ts` 的 `ownerInChat`、`lark-bot.ts`、`inbox.ts`、`sessions.ts` |
| 最近打开的飞书文档：每次采集先用 `drive +search --opened-since <recentDocsDays>d --sort open_time --doc-types docx,doc,wiki` 列出本人最近打开的文档，没存过的读进采集空间（每次最多 10 篇，kv `lark_recent_doc:<url>` 记已试过），之后交给文档更新检查；远程 `lark-recent-docs` 看原始返回 | 已实现，模拟 lark-cli 测试覆盖；返回字段待在常驻机器上核对 | `lark-personal.ts` 的 `captureRecentDocs`、`peer-exec.ts` |
| 聊天、网页、CLI 共用 Wiki 生成流程，逐页传递完整要求、用户和材料只读范围；代码优先、草稿回查原件 | 已实现，专项验证见 acceptance | `src/wiki/generate.ts`、`tools.ts` 的 `generate_wiki`、`jobs.ts`、`roles/wiki-*.md` |
| 后台 ACP 会话复用：完整权限与指令隔离，角色提示只发一次，真实上下文占用超过 60% 轮换，未知用量不复用；Codex/TraeX/Claude CLI 临时模式、ACP 按协议能力或目录中的归档命令清理，不支持时明确提示 | 已实现；假 ACP + MCP 覆盖阈值、权限、并发、归属、取消与释放；真实 Codex 两轮复用及归档已验证 | `src/agents/background-sessions.ts`、`acp.ts`、`cli.ts`、`test/background-sessions.test.ts` |
| 运行记录筛选：类型可多选，`agent:<档案名>` 单看某个 Agent 档案的运行；后台任务以 QUIET 结尾（前面带一句话也算，`isQuiet`）记为无事可报，默认不显示（迁移把以前漏判的补上） | 已实现，测试覆盖 | `runs.ts` 的 `runWhere`、`jobs.ts` 的 `isQuiet`、`web/src/views/Runs.vue` |
| 私聊指令：每分钟用 lark-cli 搜本人在单聊里发的消息，`/ai` → `lark-command` 运行：主助手读最近的私聊处理，以本人身份 `+messages-send --as user` 回在原私聊（署名，Markdown；本人身份发不了气泡和卡片），按私聊续 Agent 会话；`/ai拉群` → 以本人身份 `+chat-create`（对方 + omem 机器人），机器人在新群里用之前的私聊作上下文回答 | 已实现，模拟 lark-cli 测试覆盖；真实账号待验（建群需要 lark-cli 有建群权限） | `src/channels/lark-commands.ts`、`main.ts` |
| 向量规模：按空间 int8 矩阵 | 已实现；17 万片段 nDCG 86.76 → 86.62，常驻 1.5GB → 0.42GB | `src/search/vectors.ts`、`scripts/bench-scale.ts` |
| 渠道：网页、CLI、MCP、飞书机器人、飞书个人消息（只读）、Telegram、OneBot（QQ/微信桥） | 已实现；OneBot 有模拟服务端测试；飞书与 Telegram 需真实账号验收 | `src/channels` |
| v1 导入 | 已实现，合成库测试 | `src/migrate-v1.ts` |

尚未做：扫描件 OCR；动态派发与依赖注入的调用无法静态解析（这些仍按名称列为候选）；tsconfig 的自定义 paths 只识别 `@/`、`~/`；多租户（只有多用户的口子）；微信官方接口（只能通过 OneBot 兼容桥）。评测数字见 [evaluation.md](evaluation.md)。

### 编码交办的失败与恢复

发起 ask 的 `output.codeChain` 是轮次与卡片消息 ID 的主记录，同步到各轮；排下一轮前用 SQLite 写事务重新读主记录，旧自动回调不再排新轮次，手动请求遇到 queued/running 报具体运行和状态。每轮 `continueFrom` 指向首轮，`resumeSessionId` 取上一轮编码会话。自动推进最多 3 轮；到上限、无改动、失败或取消时写 `awaitingUser / waitReason`，完成结果以带运行 ID 的内部消息放回发起会话，并唤醒发起的主助手一回合（`handoff`）向本人说明结果和下一步；这一回合不给 `delegate_code` / `continue_code_run` / `apply_code_run`，避免绕过轮数限制。

飞书投递状态单独保存在 ask 的 `output.codeProgress`：操作阶段、失败次数、下次重试时间、脱敏错误、投递摘要指纹和租约。运行中的更新最多每 3 秒一次，同一检查点最多尝试 5 次；新轮次和最终结果有新的重试预算。重启恢复缺卡和未完成的最终更新：首次启动为从未创建成功、创建阶段重试耗尽的卡片补一次有限预算，轮询不重复补预算；明确调用 `retry_code_progress` 可重置失败预算，保留原卡片 ID。已有话题按 thread 查询真实消息，私聊按 `chat_mode=p2p` 使用普通回复；不修改原会话的 `lastMessageId`。创建带稳定 UUID；对于创建已被 API 接受但还没保存 ID 的中断，先按卡片中的交办标识查回已有卡片，查询不完整时保留失败而不重复创建。卡片最多展示最近三轮评审摘要，完整结论仍在运行记录中。没有提高通知优先级，也没有绕过通知时间偏好。

编码收尾的记账通过 `trySettleCodeChain` 隔离失败：记账异常只输出运行 ID 和错误类型，保留编码本身的 done/failed/cancelled 终态及原始错误，继续发出终态事件。进度监听器与恢复扫描也隔离异常，每条链独立恢复；最终卡片已送达但内部交接消息还未写成的链仍会补记。仅在运行 done 且评审通过时清除等待状态；取消或失败即使已有通过的评审输出，也仍按实际终态显示并等待处理。显式 `retry_code_progress` 会重新验证原卡片；更新明确返回已撤回或 HTTP 404 时，清除旧卡片 ID，按交办标识对账后在原话题补建，换用下一代 UUID，避免命中已撤回卡片的创建去重。权限、限流和普通网络失败保留原卡片 ID。

历史回溯完整性：`lark-history.ts` 持久化固定窗口、远端页令牌及话题位置，逐页保存正文和已知 ID 资源。`pending=false` 需要主列表与话题耗尽证据，整页已知消息不代表完成；旧队列按原目标重新核验。

### 原件归档的数据路径

自动采集在 `upsertSource(archive=true)` 进入归档路径；手动导入尊重指定空间。`archive_rules` 按行序排列（网页上移时重写行序，`PUT /api/archive-rules/order`），编辑不会改变顺序，首条命中即停止；未知元数据不匹配叶子条件。归档条件仅提供材料类型、标题 / 群名、网址 / 路径、正文、采集渠道、知识库名称、所在目录和上级目录路径。类型与渠道显示中文选项，渠道按采集记录和原件来源解析。飞书文档逐级查询父目录名称，保存不含当前文档标题的路径；祖先查询不完整、循环或失败时不生成路径，缺失字段即使取反也不命中。旧 ID、作者和父页面地址条件整条停用并提示重新编辑，不删除一个分支来放宽范围。原始 token 仍作为采集内部标识。旧文档可通过“更新飞书目录”仅刷新名称，不改正文、切片或已有引用；后台记录进度并可在重启后继续。归档规则页与任务规则页共用左列表、右编辑的布局，列表顶部切换两类规则，列表底部的“整理已有材料”在右侧打开历史材料预览。

未命中且有可选空间时，原件先存在个人空间，按来源空间合并成至多 40 份材料的归档运行。`archivist` 读空间说明和原件，通过 `classify_source` 写入判断。工具校验角色、本次原件清单、内容 hash、用户与运行空间权限，再检查设置和规则。拿不准时留个人，并记录已判断的内容版本；失败保留材料，在运行中可重试。需要记忆整理的材料按最终空间分组处理。

`source_routes` 保存归属依据、已判断版本与待整理状态；`source_locations` 保存原采集入口；`source_moves` 记迁移历史。迁移只改原件及索引的空间字段，不改正文、行号和已有派生知识。目标已有同 URI 原件时拒绝迁移，不覆盖或合并。历史应用校验预览时的 hash，规则变化或材料被手动指定后旧预览失效。
