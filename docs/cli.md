# omem 命令行

`omem` 是同一套个人库的命令行入口。Web、CLI 和飞书机器人共享服务、材料、记忆与事项。CLI 不建立另一份数据库，也不要求用户克隆源码。

## 安装与第一次使用

发布后的安装命令（需要 Node.js 24+）：

```bash
npm install -g omem
omem init
omem service start
omem open
```

`open` 显示网页地址；默认 http://127.0.0.1:4317。`service start` 使用包内 PM2 管理进程；关闭终端后仍运行，进程异常退出会重启。**未安装系统开机自启动，电脑休眠期间也无法拉取消息。** 已有 systemd、容器或其他管理器时用 `omem serve` 前台运行，不再套一层 PM2。

基础保存、全文搜索和 Web 不需要 Bun、osdk、Python 或本地模型。AI 需要另行安装并登录 Agent CLI，默认配置为 Traex ACP / gpt-5.6-sol。初始化不自动运行模型、不订阅消息、不发送通知、不下载模型。`omem agent probe` 读取 ACP 的可选模型与思考强度；实际调用权限需使用 `agent check --test` 或网页的调用检查。

npm 安装会取得生产依赖，包含官方 lark-cli、PM2 和本地向量推理库；本人登录仍需 `omem lark login`。Docling 和模型权重按需准备，具体安装、下载体积、存储和升级见[依赖与模型](../skills/omem-cli/references/dependencies.md)。

发布包只包含运行代码、网页、角色资源、配置模板和使用技能；不包含本仓库的 `.repo-review`、个人配置、数据库、消息、原件、密钥与模型权重。许可证为 Apache-2.0。是否已实际发布、当前验收结果见[实施进度](reader-first/progress.md)；打包成功不代表 npm 已发布。

## 帮助、目录和连接

```bash
omem --help
omem import --help
omem messages watch --help
omem --version
omem config path
omem config show
omem config validate
omem doctor
omem doctor --local --verify-models --json
omem status --json
```

| 设置 | 已安装版本默认值 | 用途 |
| --- | --- | --- |
| `--data-dir` / `OMEM_DATA_DIR` | `~/.omem` | 数据库、原件、运行轨迹、PM2 状态和日志 |
| `--config` / `OMEM_CONFIG` | 个人库中的 `config.json` | Agent、学习处理、模型和机器人配置 |
| `--port` / `OMEM_PORT` | `4317` | 本地监听端口及默认连接端口 |
| `--url` / `OMEM_URL` | `http://127.0.0.1:4317` | CLI 连接现有服务，适合远程部署 |
| `OMEM_TOKEN` | 无 | 已有服务器访问令牌；CLI 放入 Authorization，不作为模型输入 |
| `OMEM_HOST` | `127.0.0.1` | 服务监听地址；对外部署仍需自行配置网络和访问控制 |

全局选项可放在子命令后，例如 `omem service status --json`。`init` 遇到已有配置会保留它，指定不存在的 `--config` 不会静默换成另一份配置。改变配置后用相同目录、配置、端口运行 `omem service restart`。`service` 管理本机实例，`--url` 只改变 API 连接目标，不能用它控制远程 PM2。

源码开发继续使用 `osdk run dev`，默认数据仍在仓库 `.omem`；开发配置仍为 `omem.local.json`，不迁移、不覆盖已有库。安装版从任意目录运行都使用固定的个人目录。想连接已有开发服务可显式指定 `omem --url http://127.0.0.1:65091 ...`；该端口以开发终端显示为准。

退出码：0 成功；1 执行失败或服务不健康；2 参数错误/未知命令；130 用户中断。普通数据命令支持 `--json`，stdout 为结果，stderr 为错误或进度。`setup --json` 成功后返回准备摘要，各安装工具的进度写 stderr；它不改变功能开关。`serve` 和交互登录直接显示运行输出，不作为 JSON 数据命令。`doctor` 不启动服务、不调用模型、不下载依赖；默认检查安装和文件元数据，`--local` 跳过 HTTP 服务检查，`--verify-models` 才完整读取已下载权重校验摘要，功能启用、安装与校验状态分别显示。

## 保存、搜索和提问

首次启动网页提示设置主助手与工作 Agent。打开 `/#/settings`，检测服务机器可见的 Traex、Codex ACP、Claude ACP，选择实际支持的模型；切换模型后重新读取思考强度。可共用或分别选择主助手、材料与文章整理、记忆整理、编码和代码评审，保存后新任务立即使用，已排队编码保留原配置。设置不会开启采集或学习。`omem agent discover/settings/check/setup` 提供相同的检测和配置入口；命令可用、ACP 连接和模型实际调用分别显示，完整步骤及 JSON 示例见[Agent 设置](../skills/omem-cli/references/agents.md)。

新增 `omem data info/backup/restore/migrate/archive/prune` 管理本机个人库。`archive/prune` 默认预览，`--apply` 才执行；备份/归档前停止服务及前台开发进程。指定新目录恢复，不覆盖原库。冷存储保留固定 ID，消息游标和去重状态仍在热库。完整目录、保留内容及命令见[个人库与冷存储](reader-first/data-lifecycle.md)。

```bash
omem import file ./会议记录.md
omem import git ./project src/main.ts --ref HEAD
omem import lark https://example.feishu.cn/docx/TOKEN
omem import text '周五前补充上线方案' --title '项目安排' --source-id project-note
omem sources list --json
omem search '上线之前要完成什么'
omem search '入口函数' --purpose implementation
omem ask '项目的发布流程是什么？'
omem ask '需要谁确认？' --conversation 上次返回的会话ID
omem ask '解释实现过程' --research
```

文件/Git 从运行 CLI 的机器读取，再上传到服务；飞书链接由服务机器的官方 lark-cli 登录身份读取。PDF/DOCX 上传到服务端解析，因此解析器应在服务所在机器准备。输入路径是明确授权的单个文件，不递归扫描全部目录。同一个 `--source-id` 的文字记录可追加版本；未指定时每次新建来源。

`search` 直接返回检索结果，不调用大模型；目的支持 balanced、concept、implementation、background、follow-up。`ask` 让 Agent 自主检索和补读，普通模式可沿现有流程提出事项变更，`--research` 只调查作答。返回会话 ID 可继续追问。Ctrl+C 尝试取消本轮服务端调用；无法送达时明确提示，不能假装已停止。CLI 等待问答不设固定总时限，实际 Agent 由活动超时管理。

完整 Capture 可用 `omem import capture input.json` 或 stdin，最小示例：

```json
{"source":"file","externalId":"notes:release","title":"发布记录","parts":[{"type":"text","text":"发布前由负责人确认回滚方案。"}]}
```

`omem sources revision <revision-id>` 读取固定版本；`omem sources history <source-id>` 回看来源历史。来源、版本 ID 用于连接，不用文件名猜测。

## 写作、记忆与事项

```bash
omem knowledge list --json
omem knowledge show 'guide:release'
omem knowledge write page.json
omem memories list
omem tasks list
omem jobs list
omem jobs show JOB_ID
omem jobs retry JOB_ID
omem jobs cancel JOB_ID
```

`knowledge write` 复用网页的页面计划、原始快照调查、写作与独立补查流程。先从 `knowledge list` 的 materials 获取当前 revisionId，填入计划文件：

```json
{
  "brief": {
    "key": "guide:release", "title": "第一次发布项目", "order": 0,
    "kind": "tutorial", "reader": "第一次负责发布的同事",
    "goal": "能准备、执行并验证一次发布",
    "scenario": "准备将一个小改动发布到生产环境",
    "questions": ["发布前要准备什么？", "失败后如何回滚？"],
    "entryPaths": [], "topicPath": ["项目指南"]
  },
  "revisionIds": ["替换为实际的当前版本ID"]
}
```

成功响应表示写作已排队；用 `knowledge list` 查看 pages 的 maintenance 状态，失败不冒充已发布。记忆纠正继续使用 Web。CLI 不绕开 MemoryService 直接改事实。

需要先规划目录再生成多篇文章，用 `omem knowledge outline`。Web 的知识库也提供同一草案流程；保存草案不启动写作，提议可由已配置 Agent 调查材料，确认后才应用正式页面计划。完整 JSON 与命令步骤见[随包目录草案指引](../skills/omem-cli/references/knowledge-outlines.md)，实现与范围说明见[知识目录草案](reader-first/knowledge-outlines.md)。

```bash
omem knowledge outline list --json
omem knowledge outline create outline.json --json
omem knowledge outline show OUTLINE_ID --json
omem knowledge outline propose OUTLINE_ID --version VERSION --json
omem knowledge outline save OUTLINE_ID edited-outline.json --json
omem knowledge outline apply OUTLINE_ID --version VERSION --json
omem knowledge outline delete OUTLINE_ID --version VERSION --json
```

create 文件是 `{title,reader,goal,topicPath,materialKeys,contextIds,pages}`；pages 可为空，后续让 Agent 拟目录。save 文件是 `{version,draft}`，draft 使用同一完整结构。来源 key 从 `knowledge list` 获取，项目/主题 ID 从 `contexts list` 获取；不要把 revisionId 填成 materialKey。propose 和 apply 是后台排队，随后读取 show 的 state、error 与 pageStatuses；ready 只代表草案可编辑，正文是否已发表要逐页检查。版本冲突后读取现状再合并修改。

若希望每份新材料自动整理记忆，将配置 `learning.enabled` 改为 true，确认 `learning.profileId` 后重启。这会使用 Agent；仅安装或 `init` 不默认启动这类调用。主动整理文章是单独的显式请求。

## 个人飞书消息和机器人

需求跟进可用 `contexts create/assign` 明确项目范围，然后 `requirements track '名称' --goal '交付目标' --context PROJECT_ID --watch`。`requirements list/show` 查看状态和正文，`handoff KEY --to NEW_DIRECTORY` 导出实现交接。`requirements board/follow/unfollow` 将明确行动关联到个人待办。`develop prepare/refresh/repository` 准备远端仓库并查询固定版本；`develop inspect/read/configure` 让 Agent 从项目原文补齐开发配置；`develop register/start/show/resume/diff/apply` 提供独立副本中的编码、项目规则、实际检查及独立评审；应用补丁不自动提交或发布。用法和当前限制见[需求跟进](reader-first/requirement-followup.md)。

```bash
omem lark login
omem lark status
omem messages discover --json
omem messages chats '会话名称' --json
omem messages watch CHAT_ID
omem messages status
omem messages enable
omem messages sync
omem messages inbox --json
omem messages pause
omem messages unwatch CHAT_ID
omem messages exclude CHAT_ID
omem messages configure messages.json
omem messages auto-watch status --json
omem messages auto-watch configure auto-watch.json --json
omem messages auto-watch run --json
omem bot setup
omem bot status
```

登录和采集需在服务所在机器完成；使用随包锁定的官方 lark-cli，不要求手动寻找 node_modules。discover 刷新最多300个最近活跃会话，不自动订阅；chats 按名称查询本地候选，同名群先消歧。watch 选择会话，enable 开启采集，pause 停止个人采集与自动发现并保留订阅和历史。unwatch 停止普通订阅，提及例外仍按原设置处理；exclude 明确排除的会话也不会被提及例外重新纳入。免打扰默认过滤；@自己/所有人由独立提及来源处理，实际限制仍见[个人消息](reader-first/personal-messages.md)。

`messages.json` 示例：

```json
{"enabled":false,"intervalMinutes":10,"historyHours":24,"mentionExceptions":true,"resources":true}
```

采集只读消息和资源，不改变未读状态，不发送、回复或删除消息。文档、图片与附件的读取/理解状态在 inbox 中区分，排队不代表已经理解。决策模型是可选分流，复杂理解仍交给 Agent。

本人可直接要求主助手「每半小时关注我参与的需求群，忽略推广群」，无需逐个指定 ID 或拉机器人进群。自动关注由 `auto-watch configure` 保存本人政策，未修改字段保留；自动关注和采集开关需同时开启。默认每30分钟查看最近100个候选、自动关注最多20个群。先排除人工设置和免打扰，再抽最近24小时最多6条文字，缓存30分钟，按快速模型的六个维度判断。模型不可用或含糊就待判断，来源、理由和是否模型判断都可查询；自动订阅从当前时刻增量读取。focus/ignore 变化先暂停旧自动群并重评，人工订阅优先；暂停自动发现仅停止新选择。字段范围与完整配置见随包的[会话关注与定时简报](../skills/omem-cli/references/schedules.md)。

机器人通知复用已有绑定、投递与重试流程；与个人登录是两套独立授权。首次接入按[机器人创建与绑定](../skills/omem-cli/references/lark-bot.md)操作。安装版 `omem bot setup --start` 准备个人配置、启用连接，并启动或重启服务。加密密钥自动保存在个人数据目录的 `secrets/master.key` 并复用；若设置了 `OMEM_SECRET_KEY` 则沿用环境密钥。已有凭据不能用新密钥替换，备份含本机文件密钥，需私密保管。

`bot setup` 不带 `--start` 时只准备本机配置并显示入口；连接 `--url` 远端时只显示入口，不改配置。`bot create/authorize/connect` 返回可恢复的 `setupUrl`；`pending/show/pair/confirm/cancel` 可继续同一次接入。`connect <json-file>` 接受 `{appId,source,clientSecret?,config}`，source 为 manual 时需 clientSecret，botmux 时由服务机器读取已有密钥。网页刷新后保留授权或配对；服务重启后的未完成平台授权需重新发起，已保存配对可继续。源码独立前端用 `--web-url` 指定网页地址。个人只读采集不因此获得消息写权限。

随包 skill 的读取与复制：

```bash
omem skills path
omem skills show
omem skills install /absolute/agent-skills
```

install 会复制 `omem-cli` 及其 references 到指定目录，不安装全局 hooks；目标已存在时拒绝覆盖。升级 omem 会更新包内 skill，但之前复制给其他 Agent 的副本不会自动同步。先比较定制内容，再安装到新目录或合并需要的更新。

## 定时任务与简报

网页「定时任务」与 `schedules` 共用保存的设置和运行记录。本人也可通过普通 ask 或机器人私聊要求「工作日九点整理等待回复和今天要做的事」，主助手先查同用途任务，再用 work_action 保存或调整。默认「发现飞书会话」和「每日简报」模板均暂停，不开启私人采集。

```bash
omem schedules list --json
omem schedules show TASK_ID --json
omem schedules configure TASK_ID brief.json --json
omem schedules add new-brief.json --json
omem schedules pause TASK_ID --json
omem schedules resume TASK_ID --json
omem schedules run TASK_ID --json
omem schedules delete TASK_ID --json
```

configure 的文件包含 kind、name、instruction、contextIds、enabled、timing 和 show 返回的实际 `expectedVersion`；add 用于没有对应任务的新用途，不需要版本。kind 为 `daily_brief` 或唯一的 `lark_discovery`。间隔格式为 `{"type":"interval","everyMinutes":30}`；简报还支持五字段 Cron，例如 `{"type":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}`。自动发现仅支持间隔，其启停和频率同步到 autoWatch 政策。

简报用主助手 research 模式读取实际事项、跟进需求、编码状态与已采集材料，不能修改事项或发起编码。同一天且状态未变保留旧结果，不重复通知；跨日可生成当天简报，未绑定机器人时保留站内结果。run 只安排一次执行，不改变周期或启用状态；暂停的简报可手动执行，自动发现仍须两个授权开关开启。queued 或通知入队不代表已生成或送达，show 返回实际结果、失败原因和通知状态。

服务停止、关机或休眠期间不运行；启动最多补一次到期任务，不补跑全部遗漏时段。暂停或删除停止旧执行，删除的模板不因重启恢复。完整文件示例、授权和恢复步骤见[随包指引](../skills/omem-cli/references/schedules.md)。

## 外部工具与技能装配

`omem capabilities` 登记已有的只读 CLI、MCP 和技能，不安装依赖或自动登录。它们保存在服务机器的个人目录，主助手按需发现和补读；编码任务固定选择，独立评审可读相同工具回执。

```bash
omem capabilities add ./capability.json
omem capabilities list --json
omem capabilities check CAPABILITY_ID --json
omem capabilities attach PROJECT_ALIAS CAPABILITY_ID
omem capabilities disable CAPABILITY_ID
```

实际任务仍由用户自然语言交办，命令供 Agent 配置与排障使用。使用与服务相同的 `--data-dir`；此组暂不支持 `--url` 操作远端配置。完整 JSON、MCP 连接类型、凭据引用和调用方式见随包的[能力装配技能](../skills/omem-cli/references/capabilities.md)。主助手可将选中的正文和图片保存为统一材料，当轮引用、后续找回；直接 CLI 读取后可用 `omem capabilities capture CAPABILITY_ID RECORD_ID --title "材料标题"` 保存。保存原件不等于已生成文章或应用记忆。真实 Figma、远程私有 Git 与 Claude 编码仍需分别验收。

## 可选本地能力

先按 [one-sdk 官方安装说明](https://github.com/lejunyang/one-sdk#install) 安装 osdk，用 `osdk --version` 确认当前账户能找到命令。相应 setup 会准备 Python / uv，无需自行安装。以下命令在服务机器执行，`--url` 不支持远程准备：

```bash
omem setup documents
omem setup document-models
omem setup embedding
omem setup decisions
# 可选；默认只下载 2B
omem setup decisions --model 4b
omem setup decisions --model 9b
omem setup decisions --model both
omem setup decisions --model all
```

- documents 安装锁定的 Docling Python 环境；document-models 下载锁定的 PDF 布局和表格模型。
- embedding 下载中文向量模型，之后设置 `retrieval.enabled:true` 并重启。
- decisions 默认下载 StartLux 2B 并准备 MLX 环境，`--model 2b|4b|9b|both|all` 可选择；both 为 2B+4B，all 为三种。当前需要 Apple Silicon Mac。之后设置 `decisions.mode:"auto"`、`"2b"`、`"4b"` 或 `"9b"` 并重启；auto 只在已安装 2B/4B 中按内存和负载选择，不动态下载或自动加载 9B。9B 尚未实际推理验收。

可选运行环境与模型声明在个人库 `optional/`，模型字节由 osdk 的用户级数据与缓存目录保存，`--data-dir` 不自动迁移共享权重。普通服务启动不会隐式下载。重新 setup 更新未定制的包内资源，保留用户修改并说明冲突；不会自动开启功能。Windows Python 路径已适配，跨平台完整安装验收仍以 progress.md 为准；PDF OCR 尚未开启。下载来源、体积、诊断与升级操作见[依赖和模型](../skills/omem-cli/references/dependencies.md)。

## Agent 超时

编码和评审可通过 `development.codingProfileId` / `reviewProfileId` 分别选择；已交办任务保留原配置。提供方支持状态、探测与示例见 [Agent 提供方](reader-first/agent-providers.md)。发现模型列表不等于认证或编码已验证。

过去 `timeoutMs:480000` 是从启动开始计算的八分钟总时限，长调查即使持续调用工具也会被打断。现在：

```json
{"idleTimeoutMs":480000}
```

八分钟内有 ACP 初始化响应、有效会话更新、工具进展或模型输出就续期；思考片段只更新活动时间，不保存其内容。stderr 日志和宿主自己的轮询不会续期。完全静默八分钟才结束进程。工具正在执行但没有任何进展通知时同样可能超时，可按实际工具耗时提高 idleTimeoutMs。一般没有总时长上限；确实要限制成本时显式加入 `maxDurationMs`。

旧配置 `timeoutMs` 继续被接受，但语义改为无活动时限；同时填写时 idleTimeoutMs 优先。助手外层、独立复核及旧代码理解入口也接收活动续期。HTTP 单次非流式模型因为没有中途活动，仍按无响应等待限制处理。用户取消保持有效，不需要等超时。

## 让其他 Agent 使用

仓库根 `skills/omem-cli` 随 npm 包分发，内容包括如何挑选命令、材料/会话处理和诊断。查看或复制到用户指定的位置：

```bash
omem skills show
omem skills path
omem skills install ./my-agent-skills
```

不会擅自修改全局 Agent 配置。目标存在时拒绝覆盖，以保留定制。使用 Agent 自己支持的 skills 配置加载复制后的目录。

## 开发与发布

开发工具仍由 osdk 统一管理，用户安装包只需要 Node。正式发布前：

```bash
osdk deps --frozen
osdk run check
osdk run package
osdk run package:verify
```

package 输出到 Git 忽略的 `.release/`，先构建再打包；package:verify 在临时目录用 npm 正式安装依赖、运行包内 omem，检查帮助、初始化、服务、导入、搜索及技能资源。测试包不能借用源码 node_modules。加 `osdk run package:verify --agent` 会进一步调用已登录的 Traex/Sol 验证安装版问答，实际消耗模型调用。

核对 `.release/manifest.json` 中的包清单和 README 后，拥有 npm 包发布权限的账号执行 `npm publish .release/omem-0.1.0.tgz --access public`。发布是公开不可随意回收的版本操作，仓库任务不会自动发布。`omem` 名称当前查询未发现已发布版本，不等于已获得发布权限。
