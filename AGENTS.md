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
- 同步脚本：`scripts/dev-review.ts`（tsx watch + vite），同步逻辑在 `review/sync.ts`
- 数据目录 `.repo-review/` 已 gitignore；仅扫描本仓库文本（源码/docs/AGENTS.md），排除 omem.local.json/.env*/node_modules/dist/二进制
- 不启动 Lark/业务 worker/外部通知，不访问网络；无模型时浏览/搜索/追溯仍可用
- 修改 review 代码后跑 `osdk run check`；浏览器验证用 `osdk run dev:review` + 访问 5181
