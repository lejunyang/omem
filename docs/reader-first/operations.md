# 运行与维护

## 启动

使用 osdk 管理 Bun、Node、pnpm 与应用依赖：`osdk install`、`osdk deps --frozen`、`osdk run dev`。开发模式把本仓库与已提交知识接入同一个个人库，默认 API 4317 / web 5173，占用时选择空闲端口；以终端输出为准。`OMEM_PORT`、`OMEM_WEB_PORT` 可指定端口。正式构建 `osdk run build` 后 `osdk run start`，默认空工作区。

个人配置读取 `OMEM_CONFIG` 或忽略提交的 `omem.local.json`，没有时用 config/omem.example.json。profiles 配置 CLI/ACP 与模型；能力动态探测。启动不会自动生成整库知识。已启用的检索索引可后台补建。

## 模型与生成

仓库模型读取 config/review-code-model.json，REVIEW_CODE_MODEL_CONFIG 可覆盖；使用真实 traex ACP 的 gpt-5.6-sol。`osdk run review:generate <路径> --modules` 是已有材料说明流程；读者指南用 `osdk run review:guides`，只更新一页可用 `osdk run review:guides retrieval`。页面计划在 config/wiki-pages.json；模型按问题请求搜索/读取固定材料，再写作与独立检查。`--retry` 可重试失败任务。角色输出、任务和 trace 保存在 .repo-review/runtime/，发布的文章在 .repo-review/knowledge/。

本地中文 embedding 可选：`osdk model sync memory-zh` 下载 BGE-small-zh-v1.5，`osdk model verify memory-zh --json` 校验；应用不隐式下载。缺少模型保留全文检索并报告状态。`osdk run retrieval:index` / `osdk run retrieval:index --review` 补建索引。

## 检查

`osdk deps --frozen`、`osdk run check`；UI 使用 `osdk run browser` 和 scripts/code-wiki-viewport.ts 检查实际页面。`osdk run retrieval:verify` 使用真实本地模型。`osdk run review:verify --full` 生成机器报告，不能代替真实 ACP 写作及阅读验收。

## 数据与连接

个人数据库、资产与临时输出在 .omem/，可用 OMEM_DATA_DIR 覆盖。隔离仓库运行数据在 .repo-review/runtime/。保留旧引用依赖的历史，不删除 .repo-review/data/ 等既有档案。原件、会话、密钥、数据库与模型权重不提交 Git。

当前是 SQLite 单用户服务。默认仅 loopback；远程访问需 OMEM_HOST、OMEM_TOKEN 及适当的 TLS/隧道。浏览器令牌用于连接这台 omem 服务，不是模型令牌。飞书需单独启用、授权和配对；OMEM_SECRET_KEY 是加密 App Secret 的本地主密钥，不能入 Git。外部通知、全局 hooks 与屏幕监听需要独立明确范围。

日常消息支持交办、等待、改期、完成、取消与站内到期提醒；没有自动监听对方回复、周期回顾、日历或学习卡。通知已读不等于事项完成。
