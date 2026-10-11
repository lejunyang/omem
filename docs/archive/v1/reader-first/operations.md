# 运行与维护

安装版从 `omem setup` 开始：多选需要的能力，按需选模型和启用方式，确认后准备资源、保存设置并选择是否启动服务；也可跳过可选能力，只初始化基础配置。数据默认 `~/.omem`，原有 `init`、`service start` 和 `status` 保留。npm 自动安装基础运行依赖，AI 另需登录 Agent CLI；Docling 与本地模型需要服务机器已安装 osdk。入口、存放位置和升级见[依赖与模型](../../skills/omem-cli/references/dependencies.md)。下文 osdk 任务用于源码开发。

Agent 的 `idleTimeoutMs` 现在表示连续无活动等待；真实 ACP 输出、工具进展和初始化响应会续期。Sol 默认 480000 ms，没有默认总时长限制。旧 `timeoutMs` 兼容为无活动时限，显式 `maxDurationMs` 才设置总上限。助手外层和独立补查同样续期，用户取消仍生效。

## 启动

使用 osdk 管理 Bun、Node、pnpm 与应用依赖：`osdk install`、`osdk deps --frozen`、`osdk run dev`。开发模式把本仓库与已提交知识接入同一个个人库，默认 API 4317 / web 5173，占用时选择空闲端口；以终端输出为准。`OMEM_PORT`、`OMEM_WEB_PORT` 可指定端口。正式构建 `osdk run build` 后 `osdk run start`：未设置 `OMEM_REPO_ROOT` 时不会在启动时导入仓库，但会保留并使用所选数据目录的已有内容，不能把它理解为每次启动都得到空库。

个人配置读取 `OMEM_CONFIG` 或忽略提交的 `omem.local.json`，没有时用 config/omem.example.json。profiles 配置 CLI/ACP 与模型；能力动态探测。启动不会自动生成整库知识。已启用的检索索引可后台补建。

首次打开网页提示进入「能力与连接」。Agent 设置按服务实际 PATH 检测命令，连接 ACP 后读取模型；切换模型后读取它的思考强度，可另发一句无个人材料的调用检查。五种工作可以分别配置，保存到原个人配置后新任务立即使用。未安装适配器、无法认证和不支持的选项会说明原因，不自动换提供方或开启后台处理。命令与使用范围见[Agent 设置](../../skills/omem-cli/references/agents.md)。手动编辑其他配置仍需重启服务。

开发 API 使用项目内 [nodemon](https://github.com/remy/nodemon) 监测服务源码、合同、角色和配置变化，通过 SIGTERM 关闭旧进程后启动新的 Bun 进程；TypeScript 仍由 Bun 执行。这样不会在长期热重载的同一 Bun 进程中累积状态。前端仍由 Vite 热更新，个人数据库保留；原件按下文的正式保留策略管理。

## 常驻服务与状态命令

使用已锁定的项目依赖 PM2 7.0.4，不要求全局安装 PM2：

```bash
osdk run build
osdk run service:start
osdk run service:status
osdk run service:status --json
osdk run service:restart
osdk run service:stop
```

状态包括进程 PID、重启次数、API 健康和个人消息采集概况；服务没有运行、API 不健康时返回非零退出码。状态查询不会为了检查而启动服务。PM2 的进程列表、日志与配置放在所选 `OMEM_DATA_DIR/service`，不接管机器上的其他 PM2 项目。沿用 `OMEM_CONFIG`、`OMEM_DATA_DIR`、`OMEM_HOST`、`OMEM_PORT` 和进程启动时的环境；默认端口 4317。重启前先构建新的源码，避免以为源码修改会自动生效。

单实例运行，异常退出自动退避重启，短时间反复启动失败后停止。这里交付的是终端退出后继续运行的后台管理，没有安装 launchd/systemd 开机启动项，也不能在电脑休眠时拉消息。

服务启动和重启会准备随包锁定的 `pm2-logrotate`，使用这份个人库专属的 PM2 环境。默认日志每个文件达到 10 MB 后轮换，保留 7 份压缩归档，也每天轮换；大小每 10 秒检查一次，文件可能短暂超过阈值。轮换模块无法启动会阻止本次服务启动，错误会指向个人目录中的 PM2 日志。`service:status` 展示轮换是否运行和当前配置。

日志位于 `OMEM_DATA_DIR/service/pm2/logs`，包含 `omem-out.log` 和 `omem-error.log`。默认等级为 `info`，可在个人配置中设置 `logging`，或用 `OMEM_LOG_LEVEL` 覆盖等级；常驻服务改完配置后需重新启动。

```json
{ "logging": { "level": "info", "maxSizeMB": 10, "retain": 7 } }
```

结构化日志记录请求失败和任务阶段，带任务、来源或消息标识，便于对应重新处理记录；错误保留类别和代码位置。消息正文与模型输入输出会脱敏，完整原件仍在个人库；不能通过开启 debug 找回正文。需要排查一次重新处理，可先找到失败子任务 ID，再筛选本机日志。

```bash
omem service logs --lines 100 --level warn
omem service logs --job <任务ID>
omem service logs --source <来源ID>
```

该命令只读本机当前日志，不连接远端、不启动服务。每次最多 1000 条；旧日志中的非结构化文本不会复制到诊断输出。源码开发的终端输出不经过 PM2 文件轮换。

「飞书消息」页可配置定时只读采集。命令行调用同一服务 API，`OMEM_URL` 可指定开发时实际 API 地址：

```bash
osdk run messages status
osdk run messages discover
osdk run messages watch oc_会话标识
osdk run messages unwatch oc_会话标识
osdk run messages exclude oc_会话标识
osdk run messages configure /absolute/path/personal-messages.json
osdk run messages sync
osdk run messages inbox
```

设置文件示例：`{"enabled":true,"intervalMinutes":5,"historyHours":24,"mentionExceptions":true,"resources":true}`。保存配置才开启定时采集；discover 只发现、watch 只选定，不会替用户开启。`unwatch` 回到仅提及，`exclude` 连提及也排除。全部设置字段及媒体处理范围见[个人飞书消息](personal-messages.md)。机器人绑定继续使用现有「飞书机器人」页面与配对流程。

## 模型与生成

仓库模型读取 config/review-code-model.json，REVIEW_CODE_MODEL_CONFIG 可覆盖；使用真实 traex ACP 的 gpt-5.6-sol。`osdk run review:generate <路径>` 只生成明确选中材料的内部分析笔记，不进入正式目录，也不自动按文件或模块拼出专题；读者指南用 `osdk run review:guides`，只更新一页可用 `osdk run review:guides retrieval`。页面计划在 config/wiki-pages.json；ACP 知识任务现用原生工具/skill/MCP 自主调查、补读、写作，再独立补查。没有宿主输入输出 token 预算或固定三轮研究限制。`--retry` 可重试失败任务。角色输出、目录、research.jsonl 与 trace 保存在 .repo-review/runtime/；原文和数据库快照是临时副本，角色结束后回收。正式 Store 中的代码与文档保留最新版原件，不能靠临时工作区长期保留旧原文。发布的文章在 .repo-review/knowledge/。

本地中文 embedding 可选：`osdk model sync memory-zh` 下载 BGE-small-zh-v1.5，`osdk model verify memory-zh --json` 校验；应用不隐式下载。缺少模型保留全文检索并报告状态。`osdk run retrieval:index` / `osdk run retrieval:index --review` 补建索引。

如果服务启动时已经配置 `retrieval.enabled=true`，只是本地模型文件缺失，安装完成后后台会按 30 秒间隔重新尝试加载，不永久缓存失败结果。若刚把检索配置从关闭改为开启，或改了模型别名，需要重启服务：配置在启动时读取，模型加载重试不重新读取配置文件。默认示例启用中文向量检索；个人配置以实际文件为准。

实际服务的 `/api/health` 中 `retrieval.semantic` 区分关闭、补建、就绪与降级；隔离库检查通过不能代替这个运行状态。补建期间仍可搜索已有向量，未建部分保留全文检索。

材料用途整理：原始材料页展开“材料用途与适用范围”，可调用当前 Agent 阅读固定原文或人工填写。批量任务 `osdk run review:catalog docs --documents` 选择 Markdown，`osdk run review:catalog <文件或目录>` 也可分析代码；`--retry` 重做已有模型说明，人工修正始终保留。发布数据在 `.repo-review/knowledge/material-descriptions/`，按固定材料 digest 恢复；分类与概念变更后运行 `osdk run retrieval:index --review`。当前是主动触发，不是自动清洗所有新输入。细节及限制见 [材料用途与概念入口](material-understanding.md)。

## 检查

问答模型可以独立选择：个人配置的 `assistant.profileId` 指向调查用的 ACP profile，默认保持 `traex`（Sol）。可另外设置 `assistant.readingProfileId` 为 `traex-reader`（Sol / low），先读已有材料作答，需要深入调查时交回主 profile；省略就不增加这个阶段。它们不改变学习或知识写作模型。用 `osdk run assistant:compare --questions /absolute/path/questions.json --review --reading-model gpt-5.6-sol` 比较两条路径；配置、输入格式与报告边界见[中文快速决策](fast-decisions.md)。

`osdk deps --frozen`、`osdk run check`；UI 使用 `osdk run browser` 和 scripts/code-wiki-viewport.ts 检查实际页面。`osdk run retrieval:verify` 使用真实本地模型；`osdk run knowledge:native-verify` 用实际 Traex ACP 验证调查、写作和独立工具补查。`osdk run review:verify --full` 生成机器报告，不能代替阅读验收。

## 数据与连接

仓库验收清理：`osdk run review:prune` 预览，`osdk run review:prune --apply` 执行。自动检查只保留当前报告、最近两份成功与两份失败归档，以及当前文档直接引用的报告；`review:verify` 结束时自动执行这个保留规则。旧记录仍可从 Git 找回，不能用旧成功覆盖当前失败。

`assistant:compare` 结束时释放本次复制的数据库，保留答案、模型配置、意见和读取记录；只保留同一输出父目录最近三次已结束运行。自动检查日志也只保留最近三次。进行中的运行和没有归属标记的旧实验目录不会自动删除，需核对后清理。正式 `.omem` 和 `.repo-review/runtime/data` 不属于实验副本清理范围；它们内部的原件和派生成果仍执行正式保留规则。专项验收用一份现行简报和必要样例，不反复提交整库正文、重复 HTML 或临时调试日志。

个人数据库、资产与临时输出在 .omem/，可用 OMEM_DATA_DIR 覆盖。隔离仓库运行数据在 .repo-review/runtime/。不自行清理 `.repo-review/data/` 等未知既有档案；原件、会话、密钥、数据库与模型权重不提交 Git。

代码和文档默认使用 `latest` 保留策略，同一来源更新后只保留当前正文和原件。聊天、hook 和手动反馈使用 `event` 策略，保留事件与更正。策略是持久数据，不由前端目录或文件名决定；来源读取接口会返回当前策略。启动时也会整理已有代码和文档的旧版本，不能继续假设老库保存全部旧正文。

旧版本移除后留下版本身份及原因，原正文、检索片段和不再被使用的资源会回收。读取已移除的原文、证据或文档原件返回 410，真正不存在的对象返回 404；引用不会跳到最新版。导入失败记录的原文件、运行任务仍需读取的字节，以及消息资源清单引用的原件会保留，不能因为未解析成功就当作垃圾清理。

「重新处理」中的“删除旧成果后重新生成”会按处理方式清除对应派生成果，原件保留。例如重新理解会清除该材料的模型记忆和未被人工调整的待办；重写用途会清除模型用途说明；删除文章会清除该文章的全部正文历史并保留阅读目标。人工调整的记忆、用途说明与已处理事项会保留；被清除的旧文章不会因重启恢复已提交资产而重新出现。后续失败可以用原件重试，失败不会自动恢复被删成果。不同处理方式和原件恢复入口见[飞书与文档导入](document-import.md)。

当前是 SQLite 单用户服务。默认仅 loopback；远程访问需 OMEM_HOST、OMEM_TOKEN 及适当的 TLS/隧道。浏览器令牌用于连接这台 omem 服务，不是模型令牌。飞书用 `omem bot setup --start` 准备本机配置，再授权和配对。App Secret 的加密密钥保存在个人目录 `secrets/master.key`，或沿用显式 `OMEM_SECRET_KEY`；密钥与含密钥的备份都需私密保管，不入 Git。外部通知、全局 hooks 与屏幕监听需要独立明确范围。

日常消息支持交办、等待、改期、完成、取消与站内到期提醒；个人消息采集已可定时读取订阅与提及，但对方的回复是否完成已有事项仍需 Agent 调查，尚未验证自动判断的可靠性；周期回顾、日历或学习卡尚未实现。通知已读不等于事项完成。

## 从普通材料整理文章

打开知识库的分类页，点击“整理文章”。第一步选择相关原始材料，第二步填写主题、阅读对象和想弄懂的问题。使用当前 Agent 配置，经历调查、写作和独立复核，完成后可直接阅读。分类由内容建议；在某一分类里发起时沿用该位置。固定材料在生成期间变化会阻止旧结果发布。失败显示原因，旧正文不被失败结果覆盖。

`config/wiki-pages.json` 是本仓库的实验选题数据，不是所有知识库必须使用的模板。分类和新文章存入个人数据目录；人工编写的跨领域验收输入放在隔离 runtime，不能冒充用户真实笔记。

中文专用重排器已由 osdk 锁定为 `relevance-zh`，目前不默认启用。可运行 `osdk run retrieval:verify --reranker` 检查真实权重；要在统一检索和知识调查中对照，在 retrieval 配置增加 `"reranker": "relevance-zh"` 后重启。它不改变 embedding 身份，不要求重建现有向量，但不能用四个小样例声称全库效果通过。

另一实验选项是 `relevance-zh-v2`（BGE reranker v2-m3 q8）：先执行 `osdk model sync relevance-zh-v2` 和 `osdk model verify relevance-zh-v2 --json`，再显式配置 `"reranker": "relevance-zh-v2"`。运行仍禁止下载。默认检索配置没有重排器；两个模型的本机收益与耗时应先看[同库评估](retrieval-evaluation.md)。Qwen3 和 Zoekt 尚未接入，不能把调研清单当成可用配置。
