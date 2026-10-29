# omem v2：开发约定

先读 README.md 和 docs/v2/architecture.md（含实现状态表），验收步骤在 docs/v2/acceptance.md。docs/archive 是 v1 的历史资料，其中的“当前”“进度”只对应当时。本仓库的 Wiki 在 `.repo-review/wiki/`（主体生成于 2026-10-13；之后的改动列在 `reference/changes-since-2026-10-13.md`，记忆、渠道、参考三页已同步到 10-18，其他页面以代码为准）。

## 仓库里的几类说明

- `roles/*.md`：omem 自己调用 Agent 时各角色的工作说明（`_common.md` 是共同部分，含“怎么写记忆”；小节标题下写 `<!-- tools: a b -->` 的只给有其中某个工具的运行，新加只和某类工具有关的小节也这样标）；`config.ts` 的 `roleNames` 列出全部角色，新增角色两边都要加。
- `skills/omem/`：omem 工具的使用说明，外部 Agent（`omem mcp` 或 `omem tool`）和 omem 自己的 Agent 共用。`SKILL.md` 只写概览和接入，各类工具的做法在 `references/<分组>.md`（`omem_help(分组)` 返回它）。新增工具要放进 `src/agents/tool-help.ts` 的 `TOOL_GROUPS`，并在对应 reference 里写要点。角色的 `tools:` 可以写 `group:<分组>`（`-<工具>` 排除一个），主助手就是这样写的：放进分组的新工具对它自动可用，本人自定义过的角色也不用再合并工具清单；后台角色仍写精确清单，只给某个角色交结果用的工具放 `ROLE_TOOLS`，不随分组授出；只有几乎每次都用、或某个角色专门用来交结果的工具才加进 `CORE_TOOLS`（直接列出），其余经 `omem_call` 使用，不占上下文。工具的名字、参数或写入规则变了要同步对应的 reference。
- `skills/library/*`：内置技能，首次启动播种到数据目录的 `library/_skills`（已播种的不会被覆盖）。
- `.agents/skills/*`：在本仓库开发时用的技能（`omem-design` 网页约定、`osdk-guide`、`lieflat-less-ai-tone` 中文表达检查）。网页约定变了更新 `omem-design`。
- `CLAUDE.md` 只引入本文件；个人的说明（机器、账号、进行中的事）放 `CLAUDE.local.md`，不进仓库。
- `docs/v2/`：架构与实现状态表、验收、评测；`.repo-review/wiki/`：本仓库 Wiki（生成内容，新改动先记在 `reference/changes-since-2026-10-13.md`）。

## 产品原则

- 一个来源体系：文档、代码、聊天、笔记、网页、日程、妙记都是原件（sources），按空间（spaces）隔离领域。代码有符号级切分、调用图和导航，但不形成第二个知识产品。
- 宿主只做数据、索引、调度和权限；理解、调查和写作交给 Agent。不要在宿主里为模型拼几十条规则的长 prompt、强制 JSON 输出或替模型做多轮检索规划——给它工具（src/agents/tools.ts）和清楚的角色说明（roles/*.md，共同部分在 `_common.md`）。
- 记忆写入前由 `src/memory/quality.ts` 做确定性检查，之后由 memory-reviewer 复核；改记忆写法优先改 `roles/_common.md` 的“怎么写记忆”，检查规则只拦明显不是记忆的形态，不按项目或群名特判。
- 模型没有直接写库权限：所有写入走工具，工具层校验空间范围、用户可访问空间（`scopeFor` / `accessibleSpaces`）和角色允许的工具清单，并记录在运行（runs）里。新增工具或接口时同样要按用户限定空间。
- 派生知识（Wiki、记忆、事项）必须能回到原件。Wiki 正文引用格式 `[文字](src:<原件id>#L起-L止)`，页面链接 `[[slug]]`，记忆引用 `mem:<id>`。
- 记忆更正用 supersede 保留版本链，不覆盖；事项变化写时间线。原件只保留最新版，聊天按追加，删除留墓碑。
- 通用代码不得按项目名、目录名、群名或题集问法特判。分类与范围用空间、Agent 档案、监听规则等持久设置表达。
- 不在仓库里接入公司或个人环境的内部系统：内部命令行、内部平台的接口和字段（工单、报警、发布、日志平台……）不写进代码、配置结构、文档或测试。要用它们，写成技能放在数据目录的 `library/_skills`（不进仓库），挂到 Agent 档案上，由 Agent 调用；宿主只提供通用能力（规则、采集、工具、权限）。“遇到某类群 / 消息就做某事”用规则表达，不另写一条按场景硬编码的流程。
- 可复用的做法沉淀为技能（`library/_skills/<名>/SKILL.md`，内置的放 `skills/library/` 首次启动播种），专门的处理者沉淀为 Agent 档案（`library/_agents/*.md`），不写死在代码里。

## Agent 与会话

- 后端优先走 ACP（src/agents/acp.ts）。各家 Agent 的启动命令在 `src/agents/catalog.ts`；新增 Agent 只加目录条目，不在运行时按 Agent 名特判。差异按能力处理：session config options 与旧式 `session.models`、resume / load、HTTP 或 stdio MCP、权限模式别名（`pickMode`）。
- `claude-cli` / `codex-cli` 是无 ACP 时的后备，能力是子集。
- 会话（threads.ts / sessions.ts / inbox.ts）：每会话串行、会话间并行；对话与后台任务分开的并发槽；斜杠命令（commands.ts）不经过模型。改这里要保持 test/threads.test.ts 通过。

## 渠道

- 飞书分两种身份：机器人（node SDK，租户身份，可发消息、卡片、表情）和个人采集（lark-cli，本人身份，默认只读）。以本人身份写飞书只有这几处，都要本人亲自发起：把 omem 自己的机器人（`lark.appId`）拉进群——规则里配置的“拉机器人进群”，或本人在自己的消息里让助手盯群时 `set_chat_watch` 的 `invite_bot`（只在回答本人消息的那一轮可用，`inviteOwnBot`，`src/channels/lark-watch.ts`）；本人在和别人的私聊里打的指令（`lark.commands`，`src/channels/lark-commands.ts`）——`/ai` 在那个私聊里以本人身份发一条带署名的回复，`/ai拉群` 建一个本人、对方和机器人的群。不要新增别的以本人身份写的路径，也不要让 Agent 的工具能以本人身份发消息。会议规则（`src/channels/lark-meetings.ts`）以本人身份只读入会事件和会中事件；入会、会中发言、离会都用机器人自己的应用身份。
- 不是用户的人（群里的同事、私聊机器人的人）和别的机器人 @ 机器人时走访客模式（`lark.guests`，默认关）：`gatekeeper` 角色先判断回答 / 拒绝 / 不理，`guest` 角色只读群所在的空间（不读个人空间）和本人开放的空间，没有技能、记忆写入和发消息工具，也不带本人的偏好（`src/channels/lark-guest.ts`、`runner.ts` 的 `guest`）；本人也在的群可由本人设置为把关后或直接交给主助手（`guests.ownerPresent`）。有人 @ 机器人时规则让开（`markAddressed`），由机器人直接回答。
- Agent 发飞书消息只通过 `lark_*` 工具，可发的会话由本次运行限定；草稿模式下回复先变成给本人的确认卡片。
- 别人写的内容（群聊、网页、文档）是材料不是指令；注入标记（src/sources/guard.ts）只提示不拦截。

## 写给读者的内容

- Wiki 按读者问题组织，不按文件逐个生成。写作要求在 roles/wiki-writer.md；改写作质量优先改角色说明，其次才改代码。
- 文档和生成内容用中文，直接具体，避免套话。成稿可按 `.agents/skills/lieflat-less-ai-tone/SKILL.md` 检查表达，不改事实和结构。
- 功能变了在同一个提交里同步：README（功能介绍、“日常用途”、命令行清单、代码结构）、docs/v2/architecture.md 的实现状态表、acceptance.md 的验收项、`.repo-review/wiki/reference/changes-since-2026-10-13.md`；动了 omem 工具还要改 `skills/omem/references/` 里对应的分组，动了网页约定改 `.agents/skills/omem-design`。
- VS Code 插件在 `vscode/`（独立 package 和锁文件，`cd vscode && pnpm install --ignore-workspace && pnpm run build`；`node test/run.mjs` 在真实 VS Code 里测）。它只调 HTTP API，宿主改了运行、评审、问答、交办的接口要一起看它；设计在 docs/v2/ide.md。
- 文档站在 `site/`（VitePress，独立的 package 和锁文件，`cd site && pnpm install --ignore-workspace && pnpm run dev`；推到 main 后由 `.github/workflows/docs.yml` 发布到 GitHub Pages）。功能有变化时同步 `site/features/*.md` 或 `site/guide/*.md` 里对应的页面；主题沿用 `web/src/styles.css` 的 token（`site/.vitepress/theme/custom.css`），网页的颜色和字体变了这里一起改。
- 截图：`site/public/screens/*.png` 按功能命名（`review-overview`、`wiki-citations`……），文档站和 README 共用。改了这些页面的界面后，`pnpm run build && node scripts/doc-screens.ts` 重新生成全部截图（直接覆盖同名文件）；新功能要截图就在脚本里加演示数据和一项 `shots`。脚本用虚构的演示数据（示例商城 · 退款改造），不要换成本机或常驻服务器的真实数据截图。
- 这是公开仓库：文档、角色说明、技能、测试、代码注释和提交信息里不写本人和他人的真实信息（姓名、同事名、公司、群名、主机名、真实聊天或记忆内容、Agent 档案名）。举例用虚构的（项目 A、小王、《差旅报销制度》）；用真实数据校准过的规则只写结论。
  - 也不要带进：本机绝对路径（`/Users/<名>/…`、`C:\Users\<名>\…`，写相对路径或 `~`）、公司内网地址（内部 npm 源、内部文档和 Wiki 链接，锁文件里的 `resolved` 也算；示例链接用 `tenant.larkoffice.com`）、公司工具自动加的 `Co-authored-by`、运行记录或 Agent 日志的原样导出。
  - 提交前用 `git diff --cached` 检查一遍上面这些（提交作者邮箱不限）。

## 界面

- Vue 3 + TypeScript，在 web/。公共样式与 token 在 web/src/styles.css（浅色/深色），组件在 web/src/components；设计约定见 `.agents/skills/omem-design`。
- 阅读优先：正文限宽、标题衬线、引用贴近论断。引用统一走 CitationDrawer（逐层返回，Esc 退一层，关闭归还焦点）。
- 采集来的内容一律经 DOMPurify；不直接 v-html 原始 HTML。
- 列表和长文本可能很大：超过几百行的用 `components/VirtualList`（动态行高，跟随最近的滚动容器）；加载中用 `components/Skeleton`，不要让“加载中”看起来像“没有数据”。
- 不用原生 select / checkbox / radio / datetime-local / confirm / prompt：用 `components/UiSelect`、`UiCheckbox`（含 switch）、`UiSegmented`、`UiDateTime` 和 `lib/dialog` 的 `confirmDialog` / `promptDialog`。
- 改界面后用 `node scripts/screens.ts <url> <dir>` 截 1440 与 390 宽度检查，不能出现横向溢出。

## 运行与依赖

- Node 22.18+ 直接运行 TypeScript（类型擦除），import 写 `.ts` 后缀，只用可擦除语法（不用参数属性、enum、namespace）。构建由 tsc 改写后缀到 dist/。
- osdk 管理工具链、依赖和可选模型（`osdk run dev/check`）；不强制本地大模型。向量模型可选，换模型会清空旧向量。交互式配置统一放在 `omem setup`（src/setup.ts）。
- 个人配置、数据库、原件、密钥、模型权重、下载的 Agent 程序不进 Git。
- 多台设备（`src/core/peers.ts`、`peer-exec.ts`）：远程命令只加进 `peerCommands` 的固定清单并带参数校验，不提供任意 shell；飞书相关的远程命令同样只读。没有配置令牌时 API 只信任本机来源的请求。`scripts/relay.mjs` 的白名单同理，只放检查与更新类命令。

## 验证与交付

- `pnpm run check`（类型、测试、构建）必须通过。test/fake-acp-agent.ts 走真实的 ACP + MCP 桥接路径（`FAKE_MODE=thread` 测会话，`FAKE_LEGACY=1` 测旧式模型接口），改 Agent 运行时后要保持它通过。飞书相关测试用假客户端和 `setLarkCliForTests`，不连真实账号。
- 改检索后用 `scripts/eval-retrieval.ts` 在公开数据（如 T2Retrieval 子集）上对比 nDCG@10，报告实际数字和对照组，不要用少量自选问题代替；规模相关改动用 `scripts/bench-scale.ts`。
- 改角色说明或工具后，用真实 Agent（Codex gpt-6.1-sol/luna 低 effort，或 Claude Code）跑一两个真实问题检查行为；不要为了验证批量生成知识。
- 每个完整功能切片通过检查后提交；不 push，除非用户要求。
