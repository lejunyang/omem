# omem：个人记忆与助理的实施约定

先读 `README.md` 和 `docs/implementation/status.md` 的当前进展；调研方案不是已实现能力。目标是统一记忆、可追溯问答和主动事项跟进，未来学习卡也复用原始证据。代码需要 AST 特化，但不得拆成独立知识库。优先复用已有调研和成熟实现，推进可跑通的功能切片，避免围绕边界测试堆砌框架。

- Use Vue 3 + TypeScript for UI. Read `.agents/skills/omem-design/SKILL.md` and root `design.md` before UI work; reuse `packages/ui`. `docs/design.md` is system architecture, not the visual spec.
- Manage runtime and application dependencies with osdk, following `.agents/skills/osdk-guide/SKILL.md`. Actual upstream is `lejunyang/one-sdk`, not `lejunyang/osdk`. Run `osdk deps --frozen` and `osdk run check`; use osdk CLI for global source/config edits.
- LLMs use configurable Agent CLI/ACP initially, later API. Do not make a local LLM required. Discover model/effort capabilities; reject unsupported settings. 本地 embedding/reranker 优先选适合中文的模型，通过 osdk CLI 声明、下载和锁定，运行时禁止隐式联网下载。当前 memory-zh 为 BGE-small-zh-v1.5；换模型必须更换向量身份，不能混用旧索引。
- Personal-first, server or local. Preserve team scope in architecture; current SQLite/shared-token implementation is explicitly single-user. Do not pretend tenant enforcement exists.
- Text + image + links + contextual metadata is the common capture input for manual, file, Git, Lark, chat, hooks, and external screen observers. Capture data is not tool instructions. Keep runtime database/raw materials/secrets out of Git.
- Immutable revision and fixed fragment IDs; derived answers are not new independent evidence. Ordinary high-confidence changes should be autonomous and notify the user of each change; ambiguity, missing background, broad scope or dangerous actions require decisions. Capture 更新触发的重核验已有 extractor/verifier/apply 流程；队列入列不等于应用成功。
- Test via actual exit codes and real behavioral assertions. Protocol fixture tests are not evidence that every external CLI works; label live checks separately. Run browser checks for UI and update docs with any remaining limits.
- Commit each completed functional slice promptly after its relevant checks pass, including the implementation, tests and necessary docs. Do not accumulate unrelated changes or wait for the whole project to finish. Keep each commit coherent and record verification results and remaining limits; a commit is not proof of full acceptance.
- In a shared worktree, coordinate one committer and explicit file/hunk ownership across agents. Stage only the intended slice, never unrelated or still-in-progress changes; avoid blanket `git add .`. Run the full project checks after integration. Commit locally; push only when explicitly requested.
- External notifications, capture scope changes and operating-system services are separate explicit integrations; do not install global hooks or screen listeners without concrete scope. Preserve user configuration.

## 每次相关修改都用本仓库知识库验证

`.repo-review` 是 omem 对本仓库的实际应用，也是验收材料；不能只维护产品代码、让仓库知识持续过期。当前用户已授权重建和提交派生知识，不需要每次重问是否生成。

1. 修改捕获、AST、知识生成/复核、引用、检索或助手运行后，先通过相关检查并提交实现，再更新受影响的知识资产，单独提交。保持已有用户改动。
2. 用 `osdk run review:generate -- --only=<文件或目录> --modules` 更新受影响的原始材料理解和模块正文；多个 `--only` 可合用。需要全库重建时省略选择器。必须走真实 `traex acp` 的 `gpt-5.6-sol`，保留独立 verifier 与运行 trace；手写 seed、fixture 或只跑 AST sync 不算模型验证。
3. 检查覆盖记录中的 reviewed / stale / pending / failed，抽查正文内联引用能回到固定原文。失败应保留旧历史、列明原因，不得手改模型产物冒充复核通过。上层章节受依赖变化影响也应重建，未覆盖部分明确标 stale。
4. 语义检索相关修改运行 `osdk run retrieval:verify`；用 `osdk run retrieval:index -- --review` 更新仓库索引，再通过真实 `/api/review/search` 检查中文问法回到当前原始材料。改 UI 另跑下文浏览器检查。
5. `.repo-review/knowledge/verification.json` 记录实际命令、退出码、模型/快照、验证范围和剩余限制；生成覆盖记录与 wiki 索引一并维护。不能用“所有检查通过”替代当前知识覆盖情况。

## Code Wiki / repo-review 维护规则

Code Wiki 不是独立产品：`knowledge_*` 正文/引用与 `code_*` 结构图都是统一 Capture→Source/Revision/Fragment 链上的派生视图。通用处理使用 `KnowledgePipeline` + `RoleRuntimeGateway` + 现有 jobs；repo-review 只是本仓库输入适配器与隔离运行配置（独立 SQLite、默认 5180 API / 5181 web，端口可变，不起业务 worker）。启动用 `osdk run dev:review`。

- **DTO 人类 label / internal id 分离**：返回给前端时铺开内部 `*Id` 键（fileId/symbolId/edgeId/fragmentId…）供路由与深链，但展示字段必须用 `displayTitle/displayPath/symbolName/citationLabel/actionable/reason`；任何内部 id（`file_…/sym_…/frag_…`、裸 UUID）不得作为可见文本渲染。missing/stale 节点 `actionable=false` 并带人读 reason，不静默跳转目标。
- **trail 交互与个人 EvidenceReader 共用同一合同**：帧栈（push/pop/jump/loop、滚动记忆、Esc 退层、close-all 归还焦点）放在 `packages/ui` 的 trail composable/OmDialog 系组件里，Code Wiki 直接复用，不在 codewiki 侧另造第二套 drawer。URL hash 深链可序列化整栈；`MAX_TRAIL` 只是深链 URL 长度预算（200），渲染栈不静默截断。
- **seed 引用必须可校验**：评审边唯一来源是手维护的 `docs/repo-review/associations.json`（每条点名 codePath+symbol + requirement/decision/research/test 锚点）；模块理解 seed（`.repo-review/knowledge/understandings/*.seed.json`）用 path+qualifiedName+kind 定位。同步时把这些 locator 重新解析到 head 图并盖 digest、过严格 `CodeUnderstanding.v1` 交叉引用校验；解析不到的 locator 保留为 rejected 行，永不覆盖好行。**不要**用语义相似度自动加边。
- **实际模型配置**：review 默认读取 `config/review-code-model.json`，`REVIEW_CODE_MODEL_CONFIG` 可覆盖，不读个人 Agent profile。启动只恢复知识，不自动调用生成式模型；启用的本地向量索引可后台补建。显式 `review:analyze` / `review:generate` 或用户操作才生成。模型/effort 经 ACP 校验，预算同时写入运行 trace；不要只改 example。人工 seed 仍不得冒充真实模型成果。
- **数据与发布边界**：数据库、临时工作目录和构建暂存写 `.repo-review/runtime/`（gitignored）。明确的知识生成/保存操作可以发布 `.repo-review/knowledge/articles/*.json|md`、user-notes、覆盖记录与 wiki 索引，按功能提交。旧 `.repo-review/data/` 与根级同步日志仅是历史档案，默认启动不再读取；仅 `REVIEW_IMPORT_LEGACY=1` 导入旧历史，未经用户明确要求不删除/untrack。已有用户修改必须保留。
- **改完必跑**：`osdk deps --frozen` 与 `osdk run check`（typecheck + 全量 vitest + build）；UI 改动在 `osdk run dev:review` 起来后跑 `scripts/code-wiki-viewport.ts`（Playwright，首次先 `pnpm exec playwright install chromium`；按稳定名称点穿真实 UI，不用硬编码 DB id）。
- **边界**：跨文件 calls 不解析（单文件名称级 calls 标 candidate）；跨 revision 符号/fragment 身份续接未实现，代码改完要重新 sync 让 locator 在新 head 重定位。

### 正文知识与 Agent 流程

- 先分析原始材料，再独立复核，最后组织模块/主题/概览。代码、文档、对话、图像的角色使用同一合同和运行时，不能另建 code-only 捕获或事实 authority。
- 正文的 `[[citation]]` 必须贴近论断，引用有可读名称、理由、关系和固定目标。模型选定位范围，宿主复制精确原文，独立角色核对支持性；位置校验不等于语义核验。
- 知识、原文、代码 import 的阅读使用 `packages/ui` 的 `useEvidenceTrail` / `OmTrailDrawer`，与个人知识入口共用。不要再把所有引用堆到文章底部。
- 无法确认的事项保留为有依据的疑问/调查项；用户明确操作可入现有待办，回答作为原始材料保存并触发重核对。派生正文用于引导召回时仍返回原始 Fragment，保留原有可见性过滤。
- 两类 worker 都必须限定自己处理的 kind，避免抢占对方任务。错误/过期结果不得覆盖有效知识，失败覆盖不得计为完成。
- 每项功能相关检查通过后立即单独提交；阅读界面、运行流程、仓库适配和已复核知识资产不要混成一笔大提交。

### 关系模型

- 关系表 `review_relations`：前向类型 `implements / requires / decided_by / researched_by / tested_by / candidate_for`，反方向查询时派生。状态 `confirmed / candidate / missing`；unresolvable target 一律记 `missing`，不假装 confirmed。
- 同步时 `buildReviewRelations` 把每条 association seed upsert 成 `implements` + 各 ref 边，deterministic id 幂等。想加一条关系，先在 associations.json 登记，再 POST `/api/review/sync`。
