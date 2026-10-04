# 运行与维护

## 启动

使用 osdk 管理 Bun、Node、pnpm 与应用依赖：`osdk install`、`osdk deps --frozen`、`osdk run dev`。开发模式把本仓库与已提交知识接入同一个个人库，默认 API 4317 / web 5173，占用时选择空闲端口；以终端输出为准。`OMEM_PORT`、`OMEM_WEB_PORT` 可指定端口。正式构建 `osdk run build` 后 `osdk run start`：未设置 `OMEM_REPO_ROOT` 时不会在启动时导入仓库，但会保留并使用所选数据目录的已有内容，不能把它理解为每次启动都得到空库。

个人配置读取 `OMEM_CONFIG` 或忽略提交的 `omem.local.json`，没有时用 config/omem.example.json。profiles 配置 CLI/ACP 与模型；能力动态探测。启动不会自动生成整库知识。已启用的检索索引可后台补建。

## 模型与生成

仓库模型读取 config/review-code-model.json，REVIEW_CODE_MODEL_CONFIG 可覆盖；使用真实 traex ACP 的 gpt-5.6-sol。`osdk run review:generate <路径>` 只生成明确选中材料的内部分析笔记，不进入正式目录，也不自动按文件或模块拼出专题；读者指南用 `osdk run review:guides`，只更新一页可用 `osdk run review:guides retrieval`。页面计划在 config/wiki-pages.json；ACP 知识任务现用原生工具/skill/MCP 自主调查、补读、写作，再独立补查。没有宿主输入输出 token 预算或固定三轮研究限制。`--retry` 可重试失败任务。角色输出、目录、research.jsonl 与 trace 保存在 .repo-review/runtime/；原文和数据库快照是临时副本，角色结束后回收，原始版本仍由正式 Store 保存。发布的文章在 .repo-review/knowledge/。

本地中文 embedding 可选：`osdk model sync memory-zh` 下载 BGE-small-zh-v1.5，`osdk model verify memory-zh --json` 校验；应用不隐式下载。缺少模型保留全文检索并报告状态。`osdk run retrieval:index` / `osdk run retrieval:index --review` 补建索引。

材料用途整理：原始材料页展开“材料用途与适用范围”，可调用当前 Agent 阅读固定原文或人工填写。批量任务 `osdk run review:catalog docs --documents` 选择 Markdown，`osdk run review:catalog <文件或目录>` 也可分析代码；`--retry` 重做已有模型说明，人工修正始终保留。发布数据在 `.repo-review/knowledge/material-descriptions/`，按固定材料 digest 恢复；分类与概念变更后运行 `osdk run retrieval:index --review`。当前是主动触发，不是自动清洗所有新输入。细节及限制见 [材料用途与概念入口](material-understanding.md)。

## 检查

问答模型可以独立选择：个人配置的 `assistant.profileId` 指向调查用的 ACP profile，默认保持 `traex`（Sol）。可另外设置 `assistant.readingProfileId` 为 `traex-reader`（Sol / low），先读已有材料作答，需要深入调查时交回主 profile；省略就不增加这个阶段。它们不改变学习或知识写作模型。用 `osdk run assistant:compare --questions /absolute/path/questions.json --review --reading-model gpt-5.6-sol` 比较两条路径；配置、输入格式与报告边界见[中文快速决策](fast-decisions.md)。

`osdk deps --frozen`、`osdk run check`；UI 使用 `osdk run browser` 和 scripts/code-wiki-viewport.ts 检查实际页面。`osdk run retrieval:verify` 使用真实本地模型；`osdk run knowledge:native-verify` 用实际 Traex ACP 验证调查、写作和独立工具补查。`osdk run review:verify --full` 生成机器报告，不能代替阅读验收。

## 数据与连接

仓库验收清理：`osdk run review:prune` 预览，`osdk run review:prune --apply` 执行。自动检查只保留当前报告、最近两份成功与两份失败归档，以及当前文档直接引用的报告；`review:verify` 结束时自动执行这个保留规则。旧记录仍可从 Git 找回，不能用旧成功覆盖当前失败。

`assistant:compare` 结束时释放本次复制的数据库，保留答案、模型配置、意见和读取记录；只保留同一输出父目录最近三次已结束运行。自动检查日志也只保留最近三次。进行中的运行和没有归属标记的旧实验目录不会自动删除，需核对后清理。原件版本、材料说明历史、文章固定引用、正式 `.omem` 和 `.repo-review/runtime/data` 不在此清理范围。专项验收用一份现行简报和必要样例，不反复提交整库正文、重复 HTML 或临时调试日志。

个人数据库、资产与临时输出在 .omem/，可用 OMEM_DATA_DIR 覆盖。隔离仓库运行数据在 .repo-review/runtime/。保留旧引用依赖的历史，不删除 .repo-review/data/ 等既有档案。原件、会话、密钥、数据库与模型权重不提交 Git。

当前是 SQLite 单用户服务。默认仅 loopback；远程访问需 OMEM_HOST、OMEM_TOKEN 及适当的 TLS/隧道。浏览器令牌用于连接这台 omem 服务，不是模型令牌。飞书需单独启用、授权和配对；OMEM_SECRET_KEY 是加密 App Secret 的本地主密钥，不能入 Git。外部通知、全局 hooks 与屏幕监听需要独立明确范围。

日常消息支持交办、等待、改期、完成、取消与站内到期提醒；没有自动监听对方回复、周期回顾、日历或学习卡。通知已读不等于事项完成。

## 从普通材料整理文章

打开知识库的“全部分类”，展开“从材料整理文章”，选择相关原始材料，填写主题、阅读对象和想弄懂的问题。使用当前 Agent 配置，经历调查、写作和独立复核，完成后可直接阅读。分类由内容建议；在某一分类里发起时沿用该位置。固定材料在生成期间变化会阻止旧结果发布。失败显示原因，旧正文不被失败结果覆盖。

`config/wiki-pages.json` 是本仓库的实验选题数据，不是所有知识库必须使用的模板。分类和新文章存入个人数据目录；人工编写的跨领域验收输入放在隔离 runtime，不能冒充用户真实笔记。

中文专用重排器已由 osdk 锁定为 `relevance-zh`，目前不默认启用。可运行 `osdk run retrieval:verify --reranker` 检查真实权重；要在统一检索和知识调查中对照，在 retrieval 配置增加 `"reranker": "relevance-zh"` 后重启。它不改变 embedding 身份，不要求重建现有向量，但不能用四个小样例声称全库效果通过。

另一实验选项是 `relevance-zh-v2`（BGE reranker v2-m3 q8）：先执行 `osdk model sync relevance-zh-v2` 和 `osdk model verify relevance-zh-v2 --json`，再显式配置 `"reranker": "relevance-zh-v2"`。运行仍禁止下载。默认检索配置没有重排器；两个模型的本机收益与耗时应先看[同库评估](retrieval-evaluation.md)。Qwen3 和 Zoekt 尚未接入，不能把调研清单当成可用配置。
