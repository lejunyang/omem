# omem

把文档、代码、聊天、图片与个人经历组织成能读懂、找回并用于行动的记忆。代码使用 AST 帮助定位，与其他材料共享同一个知识库。

项目正在进行一次以阅读和实际问题为中心的重构。已有输入、检索、记忆、问答与事项基础；完整的高质量知识整理和主动助理仍在推进。当前能力与计划分开记录，测试通过不等于内容好用。

## 开始使用

```bash
osdk install
osdk deps --frozen
osdk run dev
```

打开终端打印的 web 地址。默认 API / web 为 4317 / 5173，占用时自动选择空闲端口；可用 `OMEM_PORT` / `OMEM_WEB_PORT` 指定。开发模式在统一界面中载入本仓库材料和已发布知识，保留已有个人数据。启动不自动调用生成式模型。

生产运行：`osdk run build`、`osdk run start`，默认 `http://127.0.0.1:4317`，从“输入材料”开始。需要已安装并登录的 Agent CLI；运行不强制依赖本地大语言模型、Docker 或 Python。

## 先读这些

- [本轮方案与文档入口](docs/reader-first/README.md)：整体复审、目标流程与写作方式。
- [当前实施进度](docs/reader-first/progress.md)：交付、真实验证、已知缺口。
- [运行与维护](docs/reader-first/operations.md)：Agent、模型、生成、检查、数据与连接。
- [视觉规范](design.md)：Vue 阅读界面、组件和间距。
- [历史档案](docs/archive/2026-10-01-baseline/)：旧设计、调研和验证，不能当当前能力说明。

## 当前基础

原始材料按来源保存固定版本，知识和代码引用可以回看当时原文。模型运行通过可配置 CLI/ACP；仓库生成使用 `config/review-code-model.json` 的 traex ACP / gpt-5.6-sol。生成与独立复核的实际产物在 `.repo-review/knowledge`，运行数据在 `.repo-review/runtime`。

检索已有全文、中文短词、符号、记忆和知识路径，可选本地 BGE-small-zh-v1.5。安装中文向量模型：

```bash
osdk model sync memory-zh
osdk model verify memory-zh --json
```

原文、检索片段与讲解章节是不同用途，不应该以同一种切分组织阅读。当前正统一搜索入口，并把 Wiki 从按文件汇总改为按读者问题调查、讲解。

日常助理支持持久会话、事项交办、等待、改期、完成、取消与站内提醒。来源更新后已有记忆重核验。持续项目理解、自动监听回复、周期回顾与英语卡片仍是后续能力。

## 开发

Vue 3 + TypeScript，公共组件在 `packages/ui`；Bun 执行 TypeScript 脚本，Node 执行构建产物，pnpm 管理工作区依赖，均由 osdk 管理。

```bash
osdk run check
osdk run browser
osdk run retrieval:verify
osdk run review:verify --full
```

个人数据在 `.omem/`。配置使用 `omem.local.json` 或 `OMEM_CONFIG`，不要提交真实会话、原件、数据库、密钥或模型权重。当前是单用户服务；飞书、外部通知和屏幕监听都是独立的显式集成。
