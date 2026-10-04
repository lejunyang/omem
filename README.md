# omem

把文档、代码、聊天、图片与个人经历组织成能读懂、找回并用于行动的记忆。代码使用 AST 帮助定位，与其他材料共享同一个知识库。

项目正在进行一次以阅读和实际问题为中心的重构。已有输入、检索、记忆、问答与事项基础；完整的高质量知识整理和主动助理仍在推进。当前能力与计划分开记录，测试通过不等于内容好用。

## 开始使用

```bash
osdk install
osdk deps --frozen
osdk run dev
```

打开终端打印的 web 地址。默认 API / web 为 4317 / 5173，占用时自动选择空闲端口；可用 `OMEM_PORT` / `OMEM_WEB_PORT` 指定。开发模式在统一界面中载入本仓库材料和已发布知识，保留已有个人数据。启动不自动生成整库 Wiki；若已启用后台材料处理，待处理任务会继续使用对应 Agent。

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

原文、检索片段与讲解章节是不同用途，不应该以同一种切分组织阅读。顶部搜索、知识检索与助手已共用召回基础；助手补读原始章节与相邻上下文。完整意图路由和跨文件功能链扩展仍待实现。

原始材料现在可以让 AI 阅读并整理用途、适用状态和概念别称，随后人工修正。搜索用保存的分类减少旧计划和调研噪声，概念按对应原文行进入全文和中文向量索引。入口在原文的“材料用途与适用范围”；仓库批量使用 `osdk run review:catalog docs --documents`。这是明确触发的整理，不会在每次捕获后自动调用模型；分类并不证明内容正确。详见 [材料用途与概念入口](docs/reader-first/material-understanding.md)。

Wiki 按读者问题调查、讲解：页面计划规定阅读目标和真实案例，模型在已捕获材料中搜索、补读，撰写后由独立角色复核。运行 `osdk run review:guides` 按 `config/wiki-pages.json` 的页面计划生成和维护指南（实际调用 traex ACP / gpt-5.6-sol）；局部重跑可用 `osdk run review:guides retrieval`。这些页面用于本仓库实验，不决定产品目录。知识库先展示分类与文章；点击“整理文章”，在两步弹窗中选择原始材料、填写阅读目标。分类路径随文章保存，按领域组织，引用不充当目录。生成通过不代表阅读质量已经验收。

文章末尾可开启“随所选材料自动更新”：材料换版后自动排队调查、更新与独立复核，更新期间和失败后仍可阅读旧版，重启可继续。选材可以是明确材料，也可以持续跟踪一个项目或主题。保存新材料时可选择归属；未指定时，后台原生 ACP 可结合已有项目和原文调查归属，再独立补查。含糊材料显示待补充的问题，手动选择优先。新流程真实效果仍在验证，详见[文章持续维护](docs/reader-first/publication-lifecycle.md)与[项目材料](docs/reader-first/project-contexts.md)。

个人助手调查时也可查看这些项目/主题，按归属搜索和补读，找到正文没有重复项目名的后续记录。辨认项目后，会话保存正式项目身份，后续初始检索按已归属材料筛选；Agent 仍可查其他范围、切换或清空讨论对象。新事项保存该项目，已有事项变更保留原归属。后台记忆整理也已接入正式项目和原生自主补读，可调查新消息是否修订旧记忆，再独立复核后应用。真实 Sol 已跑通明确归属的负责人变更、保留截止和规则，以及同名项目分别问答；复杂归属与时间有效性仍有限。未指定归属时的调查已接入，真实效果仍待验证，详见[项目材料](docs/reader-first/project-contexts.md)。

日常助理支持持久会话、事项交办、等待、改期、完成、取消与站内提醒。来源更新后已有记忆重核验。新增材料归属调查正在验证；完整持续项目理解、自动监听回复、周期回顾与英语卡片仍是后续能力。

中文本地快速决策目前处于实验阶段：已实跑 GLiClass、Qwen3.5-4B 和 Plumb-4B，提供 `decision:evaluate` 与搜索前后对照的 `decision:inspect`。它们尚未接管默认助手或记忆写入。助手可另配 `assistant.readingProfileId`，先读召回正文作答，需要深入调查时转回常规 profile，并保留同一材料快照和事实笔记；默认仍用 Sol 常规调查。效果、配置和资源占用见[中文快速决策](docs/reader-first/fast-decisions.md)。

普通助手现已接入原生自主调查：按问题选择搜索、补读、记忆、历史或代码导航，再提交答案与行动候选。预算80元换为120元、更新同一记忆、创建跟进、重启提醒、延后及完成的真实Traex流程已通过。搜索页同时提供综合回答与实际命中，真实网页首题与追问均完成；基础排序仍会把计划和旧说明排在实现前，不能用Agent补查成功代替检索质量。具体实际内容与成熟方案见 [助手检索调研](docs/reader-first/assistant-search-research.md)，保存、换版、记忆更新和跟进的成功/失败见 [个人全流程](docs/reader-first/assistant-memory-flow.md)。

## 开发

Vue 3 + TypeScript，公共组件在 `packages/ui`；Bun 执行 TypeScript 脚本，Node 执行构建产物，pnpm 管理工作区依赖，均由 osdk 管理。

```bash
osdk run check
osdk run browser
osdk run retrieval:verify
osdk run review:verify --full
```

个人数据在 `.omem/`。配置使用 `omem.local.json` 或 `OMEM_CONFIG`，不要提交真实会话、原件、数据库、密钥或模型权重。当前是单用户服务；飞书、外部通知和屏幕监听都是独立的显式集成。
