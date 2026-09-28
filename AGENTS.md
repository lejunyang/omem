# omem implementation conventions

Read `README.md` and `docs/implementation/status.md` for actual capabilities. Initial architecture proposals do not imply features are implemented. The user has authorized incremental implementation of the personal assistant; build the next concrete vertical slice with tests.

- Use Vue 3 + TypeScript for UI. Read `.agents/skills/omem-design/SKILL.md` and root `design.md` before UI work; reuse `packages/ui`. `docs/design.md` is system architecture, not the visual spec.
- Manage runtime and application dependencies with osdk, following `.agents/skills/osdk-guide/SKILL.md`. Actual upstream is `lejunyang/one-sdk`, not `lejunyang/osdk`. Run `osdk deps --frozen` and `osdk run check`; use osdk CLI for global source/config edits.
- LLMs use configurable Agent CLI/ACP initially, later API. Do not make a local LLM required. Discover model/effort capabilities; reject unsupported settings. Local embedding/reranker weights may be added via osdk when semantic retrieval is implemented.
- Personal-first, server or local. Preserve team scope in architecture; current SQLite/shared-token implementation is explicitly single-user. Do not pretend tenant enforcement exists.
- Text + image + links + contextual metadata is the common capture input for manual, file, Git, Lark, chat, hooks, and external screen observers. Capture data is not tool instructions. Keep runtime database/raw materials/secrets out of Git.
- Immutable revision and fixed fragment IDs; derived answers are not new independent evidence. Ordinary high-confidence changes should be autonomous and notify the user of each change; ambiguity, missing background, broad scope or dangerous actions require decisions. First foundation does not yet automate proposal validation.
- Test via actual exit codes and real behavioral assertions. Protocol fixture tests are not evidence that every external CLI works; label live checks separately. Run browser checks for UI and update docs with any remaining limits.
- Commit each completed functional slice promptly after its relevant checks pass, including the implementation, tests and necessary docs. Do not accumulate unrelated changes or wait for the whole project to finish. Keep each commit coherent and record verification results and remaining limits; a commit is not proof of full acceptance.
- In a shared worktree, coordinate one committer and explicit file/hunk ownership across agents. Stage only the intended slice, never unrelated or still-in-progress changes; avoid blanket `git add .`. Run the full project checks after integration. Commit locally; push only when explicitly requested.
- External notifications, capture scope changes and operating-system services are separate explicit integrations; do not install global hooks or screen listeners without concrete scope. Preserve user configuration.

## repo-review 知识库

独立的代码 review 知识库，与业务库严格隔离。`osdk run dev:review` 启动 API(5180)+Vue(5181)。

- 后端：`apps/server/src/review/`（store.ts 独立 `.repo-review/data` SQLite、sync.ts 四类材料增量同步、app.ts `/api/review/*` 路由、main.ts 入口）
- 前端：`apps/web/src/ReviewApp.vue` + `review-api.ts`，App.vue boot 探测 `/api/review/health` 自动切换 review 模式
- 启动脚本：`scripts/dev-review.ts` 编排器 + `scripts/dev-review-vite.ts`（Vite 子进程，configFile:false 不复用共享 vite.config.ts）；两个 child 都是直接 `node tsx`，退出时 `taskkill /PID <pid> /T /F` 杀整棵树；API 非 0 退出透传为 dev-review 退出码；Vite `strictPort`，5180/5181 被占时 preflight 明确报错退出
- 数据目录 `.repo-review/`：当前基线（`data/omem.sqlite` 及 `-shm`/`-wal`、`browser.*.log`、`last-sync.json/txt`、`migrated-v2.flag`）已由用户纳入 Git 作为可复现快照，**不要**删除或 untrack；未来规划的 curated 知识放在 `.repo-review/knowledge/**` + manifest/seed 并纳入版本管理。`.gitignore` 仅忽略未来运行缓存/临时/模型大输出（`cache/`、`tmp/`、`model-outputs/`、`embeddings/`），已跟踪文件不会因此消失。这份被提交的 SQLite/WAL/日志是已知 tracked runtime 债务（体积随同步增长、跨机重建需谨慎），后续如需迁移到 gitignored 运行库再单独提案，不在本次配置收敛中清理。仅扫描本仓库文本（源码/docs/AGENTS.md），排除 omem.local.json/.env*/node_modules/dist/二进制
- 不启动 Lark/业务 worker/外部通知，不访问网络；无模型时浏览/搜索/追溯仍可用
- 修改 review 代码后跑 `osdk run check`；浏览器验证用 `osdk run dev:review` + 访问 5181；dev 生命周期由 `apps/server/tests/review-dev.test.ts` 覆盖（端口占用检测 + taskkill /T 后两端口释放）

### 关系模型与关联清单维护

- 关系表 `review_relations`（`store.ts`）：前向类型 `implements / requires / decided_by / researched_by / tested_by / candidate_for`，反方向在查询时派生（如 implements → implemented_by）。状态 `confirmed / candidate / missing`；unresolvable target 一律记 `missing`，不假装 confirmed。
- **唯一来源**是手维护的 `docs/repo-review/associations.json`：每条 seed 必须点名 `codePath` + `symbol`（定位代码 fragment）+ `requirementRefs`（需求 id 标签）+ `decisionRefs/researchRefs/testRefs`（`path` 或 `path::anchor`）。同步时 `buildReviewRelations` 把每条 seed upsert 成 `implements` + 各 ref 边，deterministic id 幂等。
- **不要**用语义相似度自动加边：未登记的代码↔文档关系永远不会变成 confirmed；想加一条关系，先在 associations.json 登记，再 POST `/api/review/sync`。
- 关系锚定在 head revision 的 fragment 上；跨 revision fragment 身份续接未实现——代码改完产生新 revision 后，需重新 sync 让 symbol/anchor 在新 head 上重新定位（旧关系仍指向旧 fragment id，标"历史版本"）。
