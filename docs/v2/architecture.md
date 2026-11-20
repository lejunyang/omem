# omem v2：精简重写方案

日期：2026-10-12，最后更新 2026-10-24。v1 的代码保留在 Git 历史中（`main` 分支 `12b4a55` 之前），本方案取代 `docs/archive/v1/reader-first/` 中的实施路线。

## 为什么重写

v1 在一年里接通了捕获、检索、Wiki、记忆、事项、飞书和编码交办，但效果差。根因不在某个权重或模型，而在三处设计：

1. **把智能放在宿主代码里。** 一次问答要宿主先检索、拼几十条规则的长 prompt、要求模型输出固定 JSON，再由宿主二次检索。模型只能在宿主给的片段里作答，读不到全貌；规则越加越多（`acp-model.ts` 一个 prompt 就有二十多条约束），彼此冲突。
2. **知识产物以文件为单位。** 每个源文件生成一篇“说明”，512 份 JSON 资产只有 6 份是面向用户的页面。用户想知道“一条消息进来后发生了什么”，得到的是“该文件以 0700 权限创建目录”。
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
Plugin（插件）         plugins/<id>：档案、技能、工具、内容块、插件记录和独立页面（docs/v2/plugins.md）
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
      wiki/**/*.md            页面，路径就是目录（a/b/c.md 是目录 a/b 里的页面 c），frontmatter 含 title/summary/kind/updated，移动过的页面还有 aliases（旧路径）
      log.md                  整理日志（追加）
      SPACE.md                空间说明：用户、范围、写作要求（人可编辑）
    _agents/*.md              Agent 档案
    _skills/<名称>/SKILL.md    技能（内置技能从 skills/library 播种）
  files/                      上传与采集的原始文件（代码仓库只记录路径，不复制）
  repos/                      对话接入 Git 链接后克隆的仓库（不在知识库 Git 中）
  runs/<run-id>/              交办编码的 worktree（work/<空间>/，借用工作区时是指向它的链接）与补丁（patches/<空间>.patch）
  workspaces/<空间>/<n>/       omem 按需建的交办工作区，每个仓库最多 4 个（docs/v2/ide.md）
  agents/<id>/<版本>/          从 ACP 注册表下载的 Agent 程序
  （插件页面构建在包内 web/dist/plugins/<id>/，插件记录在 omem.db 的 plugin_records / plugin_blocks）
  secrets/                    lark.json（App Secret）、peers.json（设备地址与令牌），均 0600
  service/                    后台服务的 PM2 数据与日志
```

## 检索

一条路线，三个召回源，RRF 融合：

1. SQLite FTS5 全文（unicode61；入库和查询时由 `src/search/tokenize.ts` 生成中文双字词和拆开的标识符，如 `upsertSource` → `upsert source`）。
2. 向量（可选）：本地 bge 中文模型（bge-small-zh / bge-base-zh / bge-m3，transformers.js，经 osdk 下载）或 OpenAI 兼容接口；SQLite 存原始向量，内存里按空间存 int8 量化矩阵做暴力余弦（17 万片段常驻约 0.4GB，见 evaluation.md）。
3. 符号名精确匹配（代码）。

融合后可选重排（`src/search/rerank.ts`，默认关）：本地交叉编码器 bge-reranker-v2-m3（ONNX q8，transformers.js，经 osdk 别名 `rerank-m3` 下载）把问题和前 `rerank.top`（默认 20）条逐条打分重新排序，片段读整块（标题路径 + 正文，截到 `maxTokens`）。调用一个接一个排队，超过 `timeoutMs`（含排队）就在下一批前停下、保持融合顺序；模型按需加载，改模型、线程或长度后下一次调用重新加载，不用重启。T2Retrieval 子集 nDCG@10 86.61 → 91.58（evaluation.md）。开着重排时，对话前带上记忆改为：余弦 ≥ 0.4 的最近 20 条交给重排，打分过 `rerank.passiveThreshold`（默认 0.5）的才带上；这一轮最多等重排 3 秒，没结果就按余弦门槛。

结果携带父结构（章节标题路径/所在函数），并可按 `read_source(id, lines)` 补读。

**关注程度与标注**（`src/sources/attention.ts`）。原件分四档：重点关注（检索权重 ×1.6，整理时先读）、一般（默认）、仅检索（×0.55，不交给整理）、忽略（不进检索、不整理，按 id 仍能读）。谁定的有先后：本人 > Agent > 规则，低的不覆盖高的。关注程度规则（条件和归档规则同一套写法）给新材料定级，也能用到已入库的材料。一份文档部分过时时，在行上加标注（已过时 / 有误 / 关键 / 备注 / 不检索，可写“以哪份为准”），标注随命中和 `read_source` 一起给出，过时和有误的命中附上 ref 指向的那几行（可读空间内，前 200 字）。系数按标注盖住命中片段的比例生效：`w ^ (强度 × 比例)`，w 为过时 0.5、有误 0.35、不检索 0.2、关键 1.3，比例 = 重叠行数 / 片段行数，至少 0.25，整份标注为 1；强度：本人的和本人确认过的 1，Agent 的待确认 0.5，被否定或失效的 0。本人的（或确认过的）“有误”“不检索”盖住片段一半以上（或整份）时片段直接不进结果。标注存 `quote`（被标段落，前 200 字）和 `quote_hash`：文档重读（`upsertSource`）后在新正文里找回这段（`anchor.ts` 的 `locate`，最近的同一段，其次以 quote 开头的窗口），找不到就记 `stale_at`，不参与排序，列进复核；聊天只追加，不处理。本人否定的标注 Agent 不能再加同一条。每次检索记下哪些标注影响了返回的结果（`source_note_hits`，本机统计），“待复核”（`GET /api/sources/review`）按它和目录下的份数排序。被引用次数（回答里的 `src:`，`source_cites`，加上引用它的 Wiki 页面数）给一点加分：`1 + 0.1 × min(1, ln(1+n) / ln(21))`，最多 ×1.1。没有定级、标注和引用时排序不变。

**原件目录**（`src/sources/catalog.ts`）。每份原件按种类有一条节点链，节点 key 稳定、标题可变：仓库路径 `dir:`；飞书知识库 `wiki:<知识库>` → `wn:<节点>`…（文档本身就是节点）；知识库外的云文档 `lark-drive` → `from:<链接它的原件>` 或“直接导入”；聊天 `chat:<类型>` → `chat:<会话>` → 各月份，会话的图片在 `chat:<会话>:images`；网页 `site:<域名>` → 路径首段；会议、日程按年月，笔记、工作文件、对话按月。知识库的层级存在 `wiki_nodes` / `wiki_spaces`：采集和只读目录的刷新（`lark-docs-refresh` 的 `metadataOnly`，`unchecked` 只挑没读过位置的）把读到的节点和全部祖先写进去，列子页面时看到的子节点也写进去；没采集的节点 `source_id` 为空，原件页显示为灰色，点“采集”走普通导入。迁移只用已有 meta 填表，不联网。一个空间的树在内存里一次建好并缓存，原件变化时作废；`GET /api/sources/tree?space=&node=` 每次返回一层（份数、各档数量、标注数），`list_sources(under, depth)`、`search(under)` 用同一棵树。关注程度可以设在节点上（`source_node_levels`，`setNodeLevel`）：子树里的原件和以后进来的都按最近的节点档，写进 `sources.node_level` 供检索在 SQL 里过滤；原件自己的档在同级或更高的人定时优先（本人的目录档压过 Agent 给单份定的档，本人给单份定的档压过目录档）。Agent 设的目录档本人可以确认或否定，否定后 Agent 不能再设同一档。

**重复原件**（`src/sources/duplicates.ts`）。同一篇飞书文档以 /docx/ 和 /wiki/ 两个链接各存了一份时，知识库那份留下：采集时 `importLarkDocument` 读到文档在知识库里就按 /wiki/ 链接保存，从知识库链接读到的文档若已有同一 document id 的 /docx/ 副本，就把那份的 uri 改成 /wiki/ 链接接着用（不新建）。以前留下的成对副本由显式任务合并（`mergeDuplicateDocs`，`omem lark docs-dedupe`、远程 `sources-merge-duplicates`，默认只列出）：每对一个事务，docx 那份的标注按段落移到知识库那份（找不到的记失效）、关注程度在更高的人定时带过去、其他表里指向它的 `source_id` 改过去，自身变成保留正文的墓碑（索引删掉），`source_aliases` 记下旧 id → 新 id 和移动了什么（`detail`）。旧 id 由 `getSource`、`read_source`、引用抽屉、分享快照、飞书引用链接和 Wiki 引用解析到新 id；正文里的 `src:<旧id>` 不改写。合并过的不再成对，重复执行没有影响。内容完全相同的不同文档不合并：检索时同一段只留排名最高的一份，`sameAs` 列出其余几份（命令面板可展开，工具输出“另有 N 份相同内容”）。同一个聊天或文档在几个空间各有一份（各人的副本、镜像）时按 `origin_key` 只显示一条，`elsewhere` 列出其余（“同一个聊天或文档另有 N 处”）；读者看不到的副本先去掉（`SearchOptions.visible`）。

**检索只负责给 Agent 线索**，回答前由 Agent 自己决定继续搜、读全文还是看 Wiki——不再由宿主替它做多轮规划。

## Agent 运行时

- **传输**：ACP 为主，`claude -p` / `codex exec` 作为无 ACP 时的后备；另有云端后端 `doubao`（豆包 OpenAPI 的 Managed Agent：设备码拿到用户 access_token 存 `secrets/doubao.json`，自动刷新；按 sessions / events / MessageStream 发消息读流式回复，会话保存在豆包，线程用 `resumeSessionId` 续聊；它在云端运行，用不了 omem 的 MCP 工具，适合问答写作）。本机的豆包 CLI 是另一个后端 `doubao-cli`（`src/agents/doubao-cli.ts`）：没有 ACP、MCP 和事件流，`doubao -p` 跑完整轮只在 stdout 输出最终回复，stderr 给会话 id，`--resume` 续聊；以忽略 stdin 的方式启动（2.31.2 无法接入 Node 子进程默认的 socket stdin）；omem 工具经它 shell 里的 `omem tool`（运行的令牌和 PATH 会传到它执行的命令），说明里补一段怎么调；它不报过程，运行期间工具接口把它的每次 omem 调用记成过程步骤（`tool` 事件），思考气泡和运行页靠这个显示进度；没有 stdin，长提示写进临时文件让它读；直接调用 npm 包解压的原生程序（绕开会问更新的 node 包装和 Windows 上会重新解析参数的 cmd）；没有只读模式，非编码运行用 `ask_risky`。模型和每个模型的强度从它的参数错误里读（`--resume` 一个不存在的会话，合法组合也不会新建对话）。它的对话存在豆包账号里，CLI 没有删除或归档：这台机器上授权了豆包 OpenAPI 时，omem 用 `DELETE /v1/sessions/:id` 删除自己建的、不再需要的会话（单次运行结束后、聊天换成新会话时；豆包 OpenAPI 后端的会话同样处理；创建成功就发出 `session` 事件，读取回复失败也能清理），只删 omem 从 CLI 或 OpenAPI 拿到的会话 id；会话拿到 ID 就写入统一的 `session_cleanup`（续聊会话标为保留），正常结束删除成功后移除记录，重启或删除失败后由启动时及每分钟的恢复检查续做。恢复只处理登记过的临时会话和明确退役的会话，使用登记时选用的应用；原 omem 进程仍活着的运行让开，进程已退出但豆包任务仍在执行时等到 idle 再删，404 视为已清理，不扫描或推断账号历史。没有授权时运行里提示会话留在豆包历史里并保留待重试记录。飞书应用按 app 区分权限：`omem doubao status` 检查 omem 绑定的应用和 lark-cli 自己的应用各有哪些 `doubao:*` 用户权限，`omem doubao login` 以本人身份对指定应用做设备码授权。内置目录（`src/agents/catalog.ts`）列了 25 个 ACP Agent 的启动命令（Codex、Claude Code、Gemini、Copilot、Qwen、Cursor、OpenCode、goose、Kimi、Kilo、CodeBuddy、Qoder、iFlow、Droid…），PATH 里有就自动识别；其余从官方 ACP 注册表添加（npx / uvx，或下载对应平台的程序并校验 sha256 到 `~/.omem/agents/`）。模型与 effort 来自配置，启动时从 ACP 会话动态读取可选项：优先 session config options（model / thought_level），没有时用旧式 `session.models` + `session/set_model`。有的 Agent（TraeX）只在选中支持思考强度的模型后才给出 reasoning_effort，探测时逐个切换模型记下每个模型的强度（`effortsByModel`），选择界面按当前模型列出。服务端排队：TraeX 开 `headless_queue_status` 后用 `session_info_update._meta.trae.queueStatus` 报告排队（位置、提示），排队期间不计空闲超时（只受 `agents.queueTimeoutMinutes` 约束），思考气泡和进度卡片显示排队位置与等了多久。角色要求的权限模式按别名映射到各家的模式名（如 acceptEdits ↔ autoEdit、read-only ↔ ask）。Agent 返回的 JSON-RPC 错误把 `data`（如“未登录”“缺少 provider 配置”）带给用户并提示先在终端登录。
- **工具**：omem 自身以 MCP 服务暴露工具（`search`、`read_source`、`read_page`、`write_page`、`remember`、`forget`、`list_items`、`upsert_item`、`list_spaces` ……），通过 ACP `newSession.mcpServers` 注入。一次运行能用的工具超过 20 个时只直接列出常用的（`tool-help.ts` 的 `CORE_TOOLS`，含各后台角色交结果的工具），其余经 `omem_help` / `omem_call` 两个工具使用，`omem_call` 的说明里按分组列着本次能用的名字；权限仍由令牌在 `callTool` 里检查。Agent 进程还带着 `OMEM_URL`、`OMEM_TOKEN`，PATH 上有指向本服务的 `omem`（`<数据目录>/bin`），shell 里的 `omem tool` 走同一个 `/api/tools/<名>`。各分组的做法在 `skills/omem/references/<分组>.md`，`omem_help(分组)` 返回它。Agent 同时保有原生的文件读取与 shell（代码仓库只读）。
- **角色**由短技能文件定义（`roles/*.md`）：`assistant`（问答与交办）、`ingest`（新材料进来时更新记忆/页面/事项）、`memory-reviewer`（复核新记忆）、`memory-organizer`（整理记忆目录）、`item-keeper`（判断事项是否已办）、`wiki-planner` / `wiki-writer` / `wiki-linter` / `wiki-organizer`（整理 Wiki 目录）/ `wiki-checker`（Wiki 发布前核对）、`heartbeat`（巡检）、`brief`（简报）、`dreamer`（整理）、`curator`（筛选关注群）、`summarizer`（会话滚动摘要）、`coder`、`reviewer`、`tutor`（出卡）。共同约定在 `_common.md`。每个文件写目的、工具用法和质量标准，不写几十条禁令。可以按角色指定不同的 Agent 后端（`config.agents.roles`）。
- **Agent 档案与技能**：本人或助理建的专门 Agent（`library/_agents`，可指定后端、工具、写权限、技能、额外 MCP、工作目录）用 `run_agent` 或 `/as` 调用；技能（`library/_skills`）按名称列在提示里，Agent 需要时用 `read_skill` 读取。
- **会话**：`src/agents/threads.ts`、`sessions.ts`、`inbox.ts`。每个会话一次一轮，连发合并；Agent 会话在线保留 → 恢复 → 从摘要冷启动。只有材料没有话的消息（分享群、合并转发、图片、文件）多等 `contentWaitMs`。飞书机器人收到事件先应答、再处理，按消息 id 去重（`handled_messages`，channel `lark-bot`），飞书超时重推不会变成新的一轮。斜杠命令在 `commands.ts`，直接解析；`/new 任务`、`/topic 任务` 再把任务交给模型。`/topic` 接受飞书群聊或机器人私聊主界面中的消息，以该消息为根创建话题并取得真实 ID，再绑定独立会话；已有 `topicId` 的消息直接拒绝；`isolatedTopic` 保证后续消息不受整群 `mode=chat` 合并，进度与答案使用话题内消息作为回复锚点。
- **后台会话池**：`background-sessions.ts` 按角色说明（去除当前时间）、用户、可读写空间、工具/发消息权限、模型/强度、工作目录和额外 MCP 配置建立身份；同一实例只接一个任务，忙时另开。工具令牌逐轮指向当前运行。仅复用有本轮有效 `usage_update.used/size` 且占用不超过 `sessions.background.maxContextRatio`（默认 0.6）、也不超过 `maxContextTokens`（默认 120K，0 只看比例）的在线 ACP 会话，缺用量、异常或取消即释放；空闲默认 60 分钟、最多 3 个进程，独立于聊天池。首次发送完整指令，后续只发时间和独立任务，说明变化另开。CLI 单次任务启用原生临时参数；ACP 临时会话释放时按声明能力调用 `session/delete`（Codex 实际归档，不能保证不落盘），普通聊天与显式续轮不调用；原来的连接已断（进程退出，或在池里闲置期间连接关闭）时另起一个进程只做 `session/delete`（`deleteAcpSession`）。聊天会话换成新会话（超过轮数、换模型、旧会话恢复不了）时，旧会话同样清理（`dispatch.ts` 的 `retireSession`：归档命令、`session/delete` 或豆包删除）。正常停服清理后台池。ACP 和豆包共用 `session-cleanup.ts` 的持久登记、重启恢复和失败重试：临时会话在 ID 返回时登记，池内复用期间不清理，原宿主进程退出后按记录恢复；保留的聊天、编码和评审会话不会因宿主退出而自动清理，编码或评审换新会话时明确退役旧的。ACP 正常清理和恢复清理都优先检查 `sessionCapabilities.delete`，仅未声明时使用配置的归档命令，协议删除失败不冒充成功；失败仍登记待重试。后端配置只记录指纹，命令或身份配置变更时不换新身份处理旧会话；登记表是设备本地状态，不随快照同步。尚未拿到 ID 就退出的会话无法恢复清理。TraeX ACP 不支持 `--ephemeral`，也未声明 `session/delete`，由 catalog 的 `archiveArgs` 能力通过同一程序执行归档；其他后端可配置相同能力，无清理能力时明确提示。`traex-cli` 复用 exec 传输，单次任务带 `--ephemeral`。
- **多用户**：工具令牌带 userId，`scopeFor` / `accessibleSpaces` 决定能看哪些空间；非主人只有问答与自己的数据。别人从其他机器登录（`src/auth`，设计与分期在 [multi-user.md](multi-user.md)）。
- **权限**：模型不直接写数据库，所有写入经 MCP 工具，工具层校验并记录到 Run。危险操作（发消息、应用补丁、删除）生成“待确认”事项。

## 五条主流程

### 1. 保存与问答
导入（文件/目录/URL/飞书文档/粘贴文本/聊天）→ 转文本（Markdown 直读；PDF/DOCX 调可选的 Docling 或 `pdftotext`；飞书走 `lark-cli`）→ 切片入索引 → 触发 `ingest` 角色：读新材料，查已有记忆与页面，决定新增/更新/作废记忆、更新相关 Wiki 页、建立或推进事项。

问答由 `assistant` 角色带工具调查后作答，答案带脚注引用。对话本身作为聊天原件保存，供后续“之前说过什么”。

### 2. 代码仓库 Wiki

聊天工具 `generate_wiki`、网页和 CLI 共用 `wiki/generate.ts` 入口。目标空间须可写，材料空间须可读，生成运行保存发起用户和只读范围；规划后每个写作子运行继承用户、材料范围和完整要求，不能扩大到新关联的空间。助手只负责发起与核验，正文由 Wiki 角色提交。当前实现以代码为准，文档补充背景和设计意图，冲突处标明过时说法。
1. `wiki-planner`：Agent 在仓库只读副本中自由浏览（原生工具），产出目录：每页的用户问题、类型（入门/机制/操作/参考）、入口文件。目录写入 `wiki/index.md`，人可在界面里改。
2. `wiki-writer`：逐页调查并写作，要求：先给一个真实例子走完整条路径，再讲概念和取舍，最后给“要改 X 去哪里”。引用落到文件行号。
3. `wiki-linter`：原件变化后检查受影响的页面（页面引用的原件哈希与写作时不同，或原件已删除），只改受影响的部分，仍然成立的用 `confirm_page` 记一笔。
4. `wiki-organizer`：把顶层散落的页面和直接放了 40 页以上的目录整理进目录（`move_page`，必要时给新目录写一页 `<目录>/index`）。
5. `wiki-checker`：写作运行里的页面发布前逐条核对（论断与引用、流程与代码、否定说法、相关空间的重复与冲突、写法和篇幅），结论交回写作者，最多 3 轮；写入时的确定性检查由宿主做（docs/v2/wiki-verify.md）。

**目录**：页面的路径就是目录，没有单独的目录表。网页的目录树由 `buildNav`（`wiki/store.ts`）从路径生成，目录名取自它自己的 `index` 页标题（点目录名打开这页），没有就用路径最后一段；空间的 `index` 是首页，不进树。`move_page`（`movePages`）移动页面或整个目录：内容和“引用的原件在写作时是什么状态”不变，旧路径写进页面的 `aliases` 并进 `page_aliases` 表（可从文件重建），其他页面里的 `[[链接]]` 和 `](wiki:…)` 改成新路径，`readPage` / `pageContext` 对旧路径也能打开，一次一个提交。重写页面（`writePage`）保留文件里已有的 `aliases`，写作者只给标题、摘要和类型时旧路径也不会丢；之前因重写丢掉的旧路径用 `restoreAliases` 从知识库的 Git 历史补回（远程 `wiki-restore-aliases`，默认只列出）。规划和写作角色按“页面按用户问题分目录、顶层只放总览入门”写 slug。

**原件变化后的自动检查**（`wiki/upkeep.ts`）：宿主只决定什么时候、多少。每次有原件变化时开一个 30 分钟的防抖计时，另有启动 3 分钟后和每小时各看一次：某页引用的原件变了或被删，原件已安静 30 分钟，该页 24 小时内没被检查过，空间 3 小时内没跑过检查，就为这个空间排一个 `wiki-linter` 运行，一次最多 10 页（最久没处理的先）；聊天、会话、动态、会议这类只追加的原件变化不触发；空间设置 `autoLint: false` 关闭。顶层页面 ≥ 6 页或某目录直接页面 > 40 页时同样排 `wiki-organize`（6 小时一次，一轮没移动任何页面则一周后再看，`autoOrganize: false` 关闭）。手动检查（网页“现在检查全部”、`omem wiki lint`）不受这些限制。

### 3. 记忆与纠正
记忆只能经 `remember` / `supersede` / `forget` 工具写入。用户说“不对，是 120 元”时，Agent 找到旧记忆，调用 `supersede(old, new)`；旧记忆保留并标为失效。界面展示一条记忆的演变链。

记忆质量分三层，都不需要本人逐条看（`src/memory/quality.ts`）：

1. **写入检查**：`remember` / `supersede` 先过确定性规则——主体是免责/不确定、超长（默认 400 字以上；几条独立结论应拆开，整套规则或流程应写成页面）、转述原件（“截至…收录的《…》说明”）、“日期 + 某人说了什么”式事件复述、助理自己的汇报、运行流水、后台角色没有来源或来源不存在、与有效记忆几乎相同。不通过就把理由作为工具错误还给模型（该建事项、该 supersede、或者不记），并按模型记一笔拒绝。
2. **复核**：每小时 `memory-review` 运行把新写的 Agent 记忆交给 `memory-reviewer` 角色，盲评（看不到是哪个模型写的）后保留、改写（supersede）、拆分或撤回。复核的后端/模型在 `memory.review` 里单独配置，最好和写入的不是同一个。只有复核保留或本人写的经验、偏好会被放进每次运行的提示。
3. **按模型比较**：记忆记录写入它的后端、模型、强度和运行；`memory.compare` 让每次整理再用别的模型跑一遍（`ingest-shadow`），写入只记录到 `shadow_writes` 不生效，经过同样的检查和复核。网页“记忆 → 质量”和 `omem memories stats` 按模型给出写入、拒绝、复核结果，以及同一份材料各模型的写法对照。

记忆有目录（`memories.folder`，空间内的路径，最多三层，空字符串表示未归档），`memory_folders` 存每个目录的说明和暂时为空的目录（`src/memory/folders.ts`）。目录回答“这条属于哪个领域”，给人按层翻；标签只表达跨目录的人、项目、时期；类型（kind）是记忆的形态。`remember(folder, folder_description)` 写入时选目录，Agent 新建目录必须写说明，与同级目录只差空格或标点、超过三层、名字过长的会被拒绝；更正沿用原目录。`list_memory_folders` 查看目录树，`organize_memories` 新建、改说明、移动（连同版本链）、改名或合并、删除（内容上移一层）。`memory-organize` 运行每两小时把上次之后新出现的未归档记忆交给 `memory-organizer` 归档，每周看一遍整体结构；旧记忆一批 60 条接续处理。

记忆可以带标签（`tags`），Agent 档案写的经验和偏好默认只属于那个档案（`agent` 字段），其他档案看不到，助理能看到全部。主助手可用 `remember(agent="档案名")` 教任意档案、`recall(agent="…")` 查看该档案的专属记忆；网页档案详情可直接挂/卸技能、查看和撤回专属记忆。

### 4. 事项与跟进
事项类型：`todo`、`waiting`（等谁回复）、`reminder`、`watch`（关注某项目/群/文档）。心跳任务按配置周期运行：读关注对象的新增材料和到期事项，由 Agent 判断是否有需要本人知道/决定的变化；无变化调用 `stay_quiet`，不打扰。

事项自己收尾（`src/items/expiry.ts`），本人不用回来点完成。一件打开的事项在按类型的期限里（`config.items.days`：待办 14 天、待决定 7、关注 7、等待回复 14）没有进展就变成 `expired`：进展指本人改动它、或时间线记进了带来源的新事件，Agent 不带依据的备注不算；截止或提醒时间还没到的不过期，提醒在时间过后 `days.reminder` 天过期。`expired` 不算完成，有新依据或备注时自动重新打开，本人“保留”会让期限重新计算。另一条路是推断已办：事项引用的聊天原件里，本人在触发消息之后的同一会话/话题里说过话或回了表情（复用通知闸门的行解析，`notify-gate.ts` 的 `ownerFollowUp` / `ownerReactions`），DONE 表情直接关；其余交给 `item-keeper` 角色用 `settle_items` 判 done / cancelled / keep 并写理由，`item_checks` 记下看到哪一行，同一段证据只判一次。`item-sweep` 每小时执行两步，`item-digest` 每天发一张清点卡片（自动收尾的可“恢复”、明天过期的可“保留”）。功能上线时已经过期的事项是积压：小时任务不碰，事项页给出预览，本人勾掉要留下的再一次收尾（`POST /api/items-expiry/backlog`），之后才全部交给定时任务。

通知的 `context` 保存事项、事件、运行和本次 `sourceRefs`，发送后不随事项引用增长而变化；定时提醒读取设定提醒时的来源。事项来源纠正必须有旧来源快照和原因，来源历史留在事件。跨空间发现单独使用 `itemDiscoverySpaces`，不扩展普通检索或 `writable`；`item_update_proposals` 保存待复核进展，主助手检查两边写权限后应用。历史关联维护保存 `item_repairs` 快照，在一个事务中移动明确事件、保留未迁移事件共用的来源、修正通知/交互及运行标注，旧交互先失效；原飞书卡片刷新成功且交互未变化才重新开放。详见 [维护步骤](item-maintenance.md)。

### 5. 交办 Agent
`coder` 在目标仓库的 Git worktree 中工作；一个需求要同时改几个仓库（前端和接口、SDK 和调用方）时，每个仓库各开一个 worktree，放在同一个工作目录下，由同一个 coder 一起改。完成后宿主在每个仓库运行各自的检查命令，`reviewer`（可配置为不同模型）评审全部 diff；Run 页面显示计划、实际命令、按仓库的检查输出和 diff、评审结论。应用补丁需本人确认，所有仓库先逐个检查能否干净应用，都能才一起应用，之后删除 worktree。

改过的文件（新增和修改的，不含删除）在 worktree 存在期间建索引，放在临时空间 `wt-<运行id>-<仓库空间>`（类型 `worktree`）里：评审和之后的问答能用 `search` / `find_symbol` 查到新代码，仓库自己的索引不受影响。临时空间不出现在空间列表和定时任务里，只能读不能写；`omem peer pull` 会随可恢复的编码工作区拉取它的原件，避免评审引用丢失。worktree 删除（应用、丢弃，或手动删掉后的下一次仓库同步）时连同索引一起删除。

**分支。** 仓库空间的索引可以按基线（默认远端默认分支的提交，不受目录检出影响）或按目录现状建，见 [code-index.md](code-index.md)；其他分支用同样的临时空间叠在仓库上：

- **评审已有分支**（`review_branch`、`POST /api/review-branch`、`omem review-branch`）：仍是一条 `code` 运行，输入带 `branches`（每个仓库的分支和基线，基线默认 origin 的默认分支）。每个仓库把分支 `--detach` 检出成 worktree，再 `reset --soft` 到它和基线的分叉点，于是分支自己的改动就是“暂存的改动”，diff、规模指标、改动索引、文件视图和评审链都不用改；没有编码这一步，评审项读到的“要评审的分支”是提交列表。评审只出意见：不续轮、不升级到本人决定、不能应用，清理工作区不动原分支。评审者默认只能读运行所在空间和这几个仓库；需求文档在别的空间、迁移需求要对照源仓库时，用 `read_spaces`（`readSpaces`，按发起人可访问的空间校验）把它们加进可读范围，编码交办同样认这个字段。要按意见改，`delegate_code` 传 `from_branch`（`fromBranches`），worktree 从该分支最新提交开始，补丁相对该分支。
- **按分支检索**（`search` / `find_symbol` 的 `branch`、`/api/search?branch=`、`omem search --branch`）：`indexBranch` 用 `git show` 读分支相对基线新增和修改的文件（不检出），记下删除的文件，建分支索引空间 `br-<仓库>-<分支>`；分支或基线没动就不重读，仓库同步时更新，分支删了随清理删除。
- **叠加规则**：检索的空间里同时有仓库和它的工作区 / 分支索引时，仓库里被改过或删掉的同名文件不出现（`shadowedFiles`），读到的就是分支上的样子；只在明确列出这些空间时生效。不指定分支时检索只看仓库的基线：`space: "*"` 或不限空间的检索排除所有叠加索引，只有属于那次交办或分支评审的运行自动带上它自己的工作区索引（`withOverlays`、`runOverlaySpaces`）。工作区和分支索引跟着仓库的读权限走：能读仓库就能读它们。
- **过期**：交办结束（应用、确认、丢弃、被接替）时删掉它每一轮的工作区索引，14 天没动静的也删；按提交 sha 建的分支索引 3 天没用就删，没登记为“跟的分支”的 14 天；`repo-sync` 每小时和启动时清理。

### 5b. 多 Agent 协同与长任务
复杂的委派（要调查、产出较长、可能再交办、或中途要本人定夺）不再直接在主会话里跑：`run_agent` 带 `own_topic=true` 时建立一条“工作会话”（`src/agents/agent-work.ts`）——网页里是主会话的子会话，飞书里是由原消息开出的新话题；工作会话以发起的 ask 运行为锚，记录轮次（累计最多 30 轮）。专门 Agent 的完整产出只留在工作会话；每轮完成（或失败）后，报告作为该 Agent 的消息放进工作会话，并在工作会话的通道里排一个“协调”回合（`ask` 带 `coordinate`）：主助手作为这项工作的负责人读报告，决定继续交办（可以换 Agent）、整理结论给本人、或请本人决定；本人在话题里的新消息和报告合并成同一回合。本人上次说话以后最多自动推进 `agents.autoAdvance.turns` 次（默认 6），到上限时工具拒绝再交办、提示词要求汇报。回复只发一处：工作会话已经是飞书话题时发在话题里，各 Agent 的完整报告折叠在同一张卡片下面；没有话题（网页、私聊）时发回主会话。同一个 Agent 的下一轮接着它上一轮的会话（`persistSession` + `resumeSessionId`），任务前面附上这项工作到目前为止的经过（本人的话、其他 Agent 的报告）。Agent 之间可以 `ask_agent` 同步请教（在提问的工具调用里直接运行，是一条可见的子运行，被请教的不能再请教或交办）。飞书里每个 Agent 的回合、请教和协调回合都有自己的原生思考气泡，按顺序显示在话题里（`lark-agent-cot.ts`）。编码交办停下（通过、到自动轮数上限、失败、无改动）时，发起的主助手在原会话接手一回合（`handoff`），不给编码工具，避免绕过轮数上限。话题键沿用飞书的 `omt_…` 原样（迁移会把旧的去前缀键改回来，并把同一话题的重复会话并到最早那个），本人在话题里的回复因此落在同一个工作会话；在话题里再委派会续在同一项工作上。主助手据此判断继续推进（`run_agent` 带 `work_id`，或 `own_topic=true` 不带 `name`，在原话题续轮，不新开）或请本人介入；在话题里本人直接回复即在工作会话里继续。简单一次性的委派仍直接回主会话。编码交办走自己的链和“编码交办”卡片（见 5）。

并行调查用 `dispatch_work` 把 2～6 个有独立验收条件的子任务挂到同一个工作会话。每块有稳定的 id，运行只是一次尝试。运行队列同时遵守会话、模型容量和每板并发限制（`agents.workBoard.concurrency` 默认 3）。主助手派出后结束回合。必选块全部交回报告、失败或取消后，宿主在原工作通道排一次验收；可选块晚到时更新任务板。主助手用 `work_review` 接受、标阻塞或退回，退回沿用原 id，可以换模型，每块最多重做两次。截止时间从每次派出算起，默认 30 分钟。运行超时或服务重启中断时记录失败原因，照常收齐验收。执行记录保存在本机的 `agent_work_tasks`，从 `src/agents/work-board.ts` 读起。

运行详情顶层的 `board: { workId, taskId? }` 连接到 `GET /api/agent-work/:id/board`。任务板返回标题、发起运行、原会话、工作会话及按序排列的 `tasks`。每块的 `attempts` 按尝试时间排列，`backend` 和 `model` 记录实际执行配置，`device` 标识设备，`queuedMs` 和 `executionMs` 以毫秒计，`used` 取该运行最后一条上下文用量事件。整体 `status` 依次为 `running`、`review`、`summarized`，退回时重新进入执行阶段。必选块及已退回的块都已接受、阻塞或取消时即显示已汇总。订阅 `/api/events` 的 `{type:"work", workId}` 可刷新任务板，事件和查询均按发起运行的可见范围过滤。

过程消息（`agents.progress`，设置 → 通知与打扰 → 过程消息）：`messages` 默认 `milestones`。这一档下，协调回合（以及工作会话里的唤醒回合）若“只是接着推进”——这一轮里有运行以它的 id 排出下一轮（`queueAgentRound` 的 `queuedBy`，`run_agent` 新开和续轮都会带上）、这一轮没有给本人的提问或审批（`asks.run_id`）、回答的消息里没有本人自己的话、工作也不在等本人——回复只存进工作会话（`meta.progressOnly`），不发到飞书（`agent-work.ts` 的 `onlyMovedOn`，`jobs.ts` 的 `deliverCoordination`）。话题里改为一张原地更新的进度卡（`src/channels/lark-work-progress.ts`：第几轮、谁在做什么、最近一步、运行记录链接，卡片消息 id 存在发起 ask 运行的 `output.workProgress`）。做完（这一轮没排出下一轮）、问本人、交办失败或到上限、回答本人在话题里的话，照常发消息。`all` 保持每个协调回复都发。`thinking` 三档（`all` / `own` / `off`，默认 `own`）统一管两处起气泡的地方：回答消息的那一轮（`lark-progress.ts` 的 `startReplyProgress`，`bubble: false` 时只加“处理中”表情，不起气泡也不发兜底卡片）和后台运行（`lark-agent-cot.ts`）；`own` 只给回答本人自己消息的那一轮。交办时可借工具：`run_agent` 的 `extra_tools` 只能是发起这次交办的运行自己能用的工具（令牌里的工具清单，已去掉它被禁用的），以本人身份写飞书、在群里发消息、再交办和 `ROLE_TOOLS` 一律不借（`tools.ts` 的 `lendTools`）；借出的工具记在这一轮运行的 `input.extraTools`，运行时去掉这次运行被禁用的再作为 `addTools` 交给 `prepareRun`，之后照常按本人权限裁剪，空间范围不变。

### 6. 学习
从材料或对话生成卡片（问答/完形/例句），FSRS 调度；每日到期卡片在 Web 与机器人里复习（聊天里 `/review` 逐张出题打分）。学习目标（`src/learn/goals.ts`）记录方向、每日张数和提醒时间：提醒前从该空间新材料出卡，反复忘的卡换角度补卡，统计记住率与连续天数。

### 6b. 存量材料的整理
新材料由 `ingest` 随到随整理；整批回溯的群、一次导入的知识库是存量，由本人开的整理任务（`digest_jobs`，`src/agents/digest.ts`）一批一批地做：`triage` 交给 `triager` 按标题、目录和开头定级（默认每批 150 份），`digest` 交给 `distiller` 精读重点和一般的材料（默认每批最多 40 份、约 15 万字，重点在前，正文带行号直接附在任务里），写主题页、案例页、原件标注和必要的记忆；任务可指定一个 Agent 档案，排查经验写成它的专属记忆。每个任务同时跑 `parallel` 批（默认 1，可随时调），各批材料不重叠；`after` 让任务等另一个任务做完再开始（先分级、再精读同一批）；进度里做过后被降档的材料仍算已做，批次结束和定时任务 `digest`（每 10 分钟）补排；做过的原件按 hash 记下，内容变了会重做；连续 3 批失败自动暂停并通知。入口：`digest_sources` 工具、原件页“整理”、`omem digest`、远程 `digest-status`。`ingest` 同样会写主题页和标注、跳过仅检索和忽略的材料。

### 7. 做梦（整理）
每晚（定时 `dream`，3:30；新库默认开，已有的库保持原来的开关）：合并重复记忆、标记冲突（两条同时有效又互相矛盾）、过期提醒、Wiki 断链与孤立页、从运行记录提炼可复用技能建议。从上次整理（kv `dream_at`）看起，第一次只看最近 7 天。存量整理（digest）写下的大批 experience 记忆按“同一空间与档案、向量相近”分组（每组成员都和组里第一条相近，不顺着近邻串成大组；没有向量时按同一原件），每晚先处理最大的几组（`src/memory/digest-merge.ts`），合并成一条可复用的结论或撤回，逐步消化。其余较早的有效记忆每晚轮到一批（`DREAM_STOCK_BATCH` = 80 条，位置记在 kv `dream_stock_cursor`，轮完从头再来），和当天变化的记忆一样找相近的对交给 dreamer 判断重复和冲突。空间关联候选的依赖迹象按依赖名整词匹配（package.json 看依赖字段，go.mod、Cargo.toml、pyproject、pom、gradle 各按自己的写法），多个空间发布同名包时不算；dreamer 判断无关的用 `relate_spaces` 的 `decline` 记下（表 `space_relation_declines`，记依据的类型、不计数字），之后只有出现新一类依据才再列出。报告取 Agent 的最后一条消息。定时任务的计时器错过了某次（或服务当时没在运行）：每分钟检查一次，上一个时间点过去 90 秒到 6 小时内还没跑的补跑一次并写日志，一小时内会再跑的高频任务和从没跑过的不补（`catchUpSchedules`）。后台任务的 Agent 刚启动就断开（EPIPE、connection closed，两分钟内、还没调用工具）时重试一次。记忆页“不足”一栏显示开关、上次整理时间和待合并条数，关着且有不足时提示一次。结果写进“整理报告”，变更走工具并可回滚（Git）。

## 界面

Vue 3 + TypeScript，单页应用，信息架构：

- 左侧：空间切换 + 导航（今日 / 问答 / Wiki / 事项 / 记忆 / 原件 / 学习 / Agent / 运行，另有设置、通知和关系图）。
- 原件：聊天类原件按聊天显示（发送人、引用、图片、卡片），长原件和长列表虚拟滚动。
- 记忆：左侧目录树（拖放移动、目录维护、一键整理），列表按目录分组，标签筛选、复核状态，“质量”页按模型统计。
- 问答：对话 + 右侧引用面板（点击脚注即在右侧显示原文高亮）。
- Wiki：左目录、中正文（行宽受限，Mermaid 渲染）、右侧“本页引用 + 反向链接 + 相关页面”；页面可看 Git 历史与 diff。
- 事项：按“需要我决定 / 等待中 / 待办 / 已完成”分栏，时间线展示每次变化及来源；三天内会自动过期的标出来，详情里显示期限和“保留 / 恢复”，积压的旧事项在顶部提示并可预览后收尾。
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

现在的做法是“一台常驻，其他来看”：常驻那台负责采集和定时任务，是唯一写入方；其他机器经 HTTP 读它的状态、拉快照、让它跑检查。配对码 = 对方地址 + 为本人生成的 API 令牌，所以设备就是“拿着本人令牌的客户端”，权限与撤销都走已有的令牌表。中间节点转发 `/api/peers/<id>/…` 时换上自己保存的令牌，并用 `x-omem-hops` 限制层数。

远程命令刻意做成固定清单（`peerCommands`，每条有参数校验），而不是任意 shell：要核对的多是飞书原始返回、数据库内容、日志和版本，这些都能用只读命令覆盖；会改东西的只有采集、回溯、触发定时任务、`git pull --ff-only` 和重启。

**外部 Agent 用设备的库**（`src/agents/peer-agent.ts`）：本机的 Claude Code / Codex 想用本机的模型整理常驻服务器的数据时，`omem tool --peer <id>` / `omem mcp --peer <id>` 调目标节点的 `GET /api/peer/tools` 和 `POST /api/peer/tool`（本人令牌，成员令牌 403）。客户端走和 `omem peer call` 一样的 `peerJson`，直接读本机的 peers.json，所以本机服务不必运行；经中间节点时中间节点只转发 `/api/` 请求，不用更新。目标节点上，一次调用是“本人、`actor: agent`、工具集 = 内置分组里的工具去掉角色交结果的工具、插件工具和 `PEER_DENY`”：`PEER_DENY` 是会对外发消息或动手的——飞书发送、卡片、文档写入、采集设置，`notify`，问本人和等回答，唤醒，`generate_wiki` / `digest_sources` 这类批量用目标机器模型的，交办编码与评审、Git 动作，改档案、技能、规则和仓库关联。读取与整理类写入（记忆、页面、原件关注度与标注、事项、记忆目录、导入网页和笔记）保留。`test/peer-tools.test.ts` 要求每个内置工具都在某个分组里，新增工具默认放行，要对外或交办的必须加进 `PEER_DENY`。每次调用都记在一条 `peer-agent` 运行里：调用方的本机名 + 会话名对应一条运行（第一次用时创建，闲置 15 分钟收尾，之后再用会重新打开；服务重启时由处理器直接结束），每次调用一条 `tool` 事件（被拒的带 `refused`），写入工具自己再记 `tool-write`，写入的记忆等带这条运行和 `peer:<调用方>` 作为来源档案、调用方告知的模型和强度；调用方给了 Agent、模型或强度（`--agent` / `--model` / `--effort`，或 `OMEM_PEER_AGENT` / `OMEM_PEER_MODEL` / `OMEM_PEER_EFFORT`）时，这条运行的 AI 记成 `peer:<调用方>:<Agent> · 模型 · 强度`，运行页和其他运行一样显示。`omem_help` 不新建运行。`run_agent` / `ask_agent` 也放行：经 `--peer` 调用时排成一个 `agent` 运行（父运行是这个会话的 `peer-agent` 运行，`fromPeer` 记调用方），立即返回运行 id，调用方用 `read_run` 取结果（`ask_agent` 也这样，不同步等，转发请求有超时）；交给主助手时它的工具限于调用方这一套。例外是 `review_branch`：经 `--peer` 调用时（工具上下文带 `peer`）建的分支评审带 `peerReviewer`，编码运行照常检出、取 diff、建索引、定计划（不预判、不精调、不用负责人、不等确认），然后以 `awaiting-peer` / `reviewStage: peer` 结束，不占并发槽；调用方用 `review_task` 取材料（`peerReviewTask`，diff 分页），用带 `run_id` / `check` 的 `submit_review`、`submit_change_points` 交结果（`PEER_REVIEW_TOOLS`，只认发起的那台设备）；最后一项交齐时 `peerSubmitted` 排一个 `review` 运行，`reviewRound` 读已交的结论代替跑评审项，按宿主规则汇总。`delegate_code` 同理：经 `--peer` 调用时交办带 `peerCoder`，第一轮照常建工作分支、工作区、装依赖，以 `awaiting-peer-code` 结束；调用方用 `code_workspace`（`src/agents/peer-code.ts`，只认发起的设备）在工作区里读、写、grep、提交，运行仓库设置里允许的命令（检查、准备和 `peerCommands` 里的“名字: 命令”，参数只能是不带 shell 符号的词，异步执行可轮询）；`finish` 用 `queueStandaloneFix` 排一轮带 `peerFinished` 的交办，跳过同步和编码，把 summary 当编码说明，照常提交、检查、取 diff、建索引，再交给调用方（`peerReviewer`）或本机的评审。`space`（默认空间，缺省 personal，不看调用方的当前目录）、`spaces`（限定可读写的空间）、`readOnly` 由调用方给，仍走 `callTool` 里的空间检查。

`omem peer pull` 仍是手动单向拉取。HTTP 与 SSH 共用 `pull-snapshot.ts` 的快照程序：SQLite 一致性副本、`library/`、运行补丁、仓库 Git bundle 与非忽略工作文件；已检出的子模块和编码 worktree 各自保存为可独立恢复的仓库，不传 `.git` 中的凭据配置与 hooks。HTTP 下载落到临时文件，不把完整快照放进内存。只允许本人下载快照。

拉取内容可选（`pull-transfer.ts` 的 `PULL_PARTS`）：数据库总会拉，`library`、`files`、`repos`、`runs` 由调用方选（`--only`，终端里逐项询问），结果合并进 `--to` 指定的数据目录。选择经 `GET /api/peer/snapshot?parts=…&strip=1&files=separate` 或 SSH 快照程序的第三个参数传给对方：没选的仓库和工作区不打包；合并模式（`strip`）在快照里清空 `chunks`、`chunks_fts`、`symbols`、`code_refs`，它们由合并时的 `reindexSource` 重建（常驻服务器上占数据库约四分之三）。附件单独传：先取对方的文件名（`GET /api/peer/files`；SSH 下 `ls`），只请求本机没有的，每批 500 个（`POST /api/peer/files` 返回 tar；SSH 下 `tar -T -`）；`--overwrite` 时没传的附件从备份里复制回来（`Fetched.reused`）。对方版本较旧时忽略这些参数、发来全部内容，`mergeLibrary` 先按选择删掉没选的部分（`narrow`）。数据库和仓库每次仍整份传，合并本身按记录增量。

`pull-data.ts` 明确列出全部业务表：除了原件、记忆、事项、会话和运行，还合并规则、定时任务、归档和标注、结构化聊天、学习、记忆质量与召回、材料关联、评审与问题等记录。自增主键表使用 `sync_key` / `sync_updated_at` 跨设备识别与比较；导入时重新分配本地主键，换算问题合并关系和可操作的问题编号。旧副本按自然键对上后，设备本地 `pull_aliases` 保留标识映射。原件按空间和 URI 对上，普通正文取较新版本，聊天保留本机行号并追加远端缺行，远端的原件 ID、引用和结构化行号在临时副本中换成本地值；Wiki 文件同样换算引用。物理删除不传播，已有墓碑和撤回状态按记录更新。

`pull-repos.ts` 把新仓库放到 `repos/pulled/`，关联空间并换算运行和档案中的路径；已有仓库只在干净、同分支且可快进时更新，否则保留本机和远端分支、工作区副本。Wiki 和档案等走 Git 合并，冲突留本地并保存 `.remote` 文件。`--overwrite` 备份数据库、知识库、附件、运行目录和托管仓库，恢复失败则回滚；附件已在本机也会进入新库。配置、密钥、采集游标和服务状态不参与合并；检索索引重建，向量由本机补齐。新导入的任务规则、定时任务停用，存量整理暂停，排队和运行中的远端任务取消，不覆盖本机活跃任务的进程状态。覆盖模式同样停用任务规则和定时任务。

以后要做持续同步（两台都写）时的方向，现在不实现：

- **变更日志**：记忆、事项、原件元数据各自已有 id 和时间，补一张按节点自增的变更表（节点 id + 序号 + 实体 + 操作），设备按“我已看到对方的第几号”增量拉取，代替整库快照。
- **单写者的事归一台**：飞书采集、定时任务、发消息这类有外部副作用的事只在持有租约的节点上跑（租约存在常驻那台，过期可接管），避免两台同时采集或重复提醒。
- **冲突**：记忆本来就是版本链（新的使旧的失效），并发修改同一条时两条都保留、交给做梦整理合并；事项状态按最后修改时间。
- **按能力分派**：设备上报自己有哪些 Agent / 工具（`diag` 里已有），跑不了的任务转给有的那台。
- **多用户**：本人的设备拿本人令牌；别人的服务用服务账号和按空间的共享授权，检索、引用时落地、按变更日志单向同步已经实现（`src/core/federation.ts`，见 multi-user.md）。

## 实现状态

每项能力做到哪一步、入口文件在哪，在 [status.md](status.md)。那张表很长，按关键词搜对应的行，不用整份读；编码交办的失败与恢复、原件归档的数据路径两节也在那里。
