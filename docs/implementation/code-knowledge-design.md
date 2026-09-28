# Code Knowledge 领域模型与第一纵向切片设计

> 状态：**设计文档，未实现任何生产代码**。
> 本文只新增本文件；不修改 `apps/server`、`packages`、`package.json`、`pnpm-workspace.yaml`、`osdk.toml`。
> 标注约定：
> - 【事实】= 已存在于当前代码库（HEAD `46d808a`），可被 grep/测试复核；
> - 【设计】= 本文提出、尚未实现的方案；
> - 【未实现】= 明确记录为缺口、不在本切片范围内。

---

## 1. 背景与目标

【事实】当前 repo-review（`apps/server/src/review/`）已经是一个"代码评审知识库"：
它把 omem 仓库本身扫描成不可变 revision + 固定 fragment，并通过**手维护的 seed**
（`docs/repo-review/associations.json`）建立 `code fragment → intent → requirement/decision/research/test`
的双向关系。但它的代码侧是**弱建模**：

- 代码文件只被正则切成 fragment（`sync.ts` 的 `CODE_BOUNDARY`），没有"符号"实体；
- 符号只是 `context.symbols: string[]` 字符串列表（`sync.ts:extractSymbols`），没有位置、类型、导出信息；
- 关系只有评审语义（`implements/requires/decided_by/researched_by/tested_by/candidate_for`），
  **没有代码结构语义**（imports/exports/calls/routes/tests/Vue 组件）；
- 符号定位靠 `matchSymbolFragment` 的正则在 fragment 文本里再猜一次（`sync.ts:581`）。

【设计】本文把 repo-review 的"评审关系层"下沉为一个**通用 Code Knowledge 领域模型**：
以确定性解析（不依赖大模型）先产出文件/符号/结构化边，再把评审 seed、LLM 派生理解挂在上面。
第一纵向切片（§11）只做 TS/Vue 确定性解析 + 存储 + 只读 API + 浏览器验证，
LLM 派生理解与 Lark/assistant 通路按阶段打开，模型不可用时系统仍可浏览/搜索/追溯。

---

## 2. 现状事实盘点（设计所依赖的既有机制）

【事实】以下机制是本设计要复用、不是新发明：

1. **不可变 revision + 固定 fragment**（`store.ts:capture`）：同一 `(namespace, external_id)` 的内容
   每次变化 append 一个新 revision（`version+1`、`previous_id` 链），`sources.head` 指向最新；
   text part 按空行切成固定 `fragments(id, revision_id, ordinal, text)`。
   外部身份 `external_id = "omem:<repo-relative-path>"`，编辑同一路径累积 revision，
   字节相同的两个文件仍是两个 source。
2. **快照诚实**（`sync.ts`）：每个 revision 的 `context` 记录真实 `gitCommit`、`dirty`、
   `contentHash(sha256)`、`syncedAt`，**从不记录 mtime**；dirty 树同步不推进 baseline，
   git 失败降级为全量重扫而非静默空集。
3. **隔离库**：review 用独立 SQLite（`.repo-review/data/omem.sqlite`，`createReviewStore`），
   不碰个人工作区 `.omem/`、不起 Lark/learning worker、不读 secrets。
   【事实】该 `.repo-review/data/omem.sqlite`（含 `-wal/-shm`）、`last-sync.*`、`migrated-v2.flag`
   等 8 个文件当前**已被 git 跟踪**（`git ls-files .repo-review`），不在 `.gitignore` 中。
4. **关系表与生命周期**（`review/store.ts`）：`review_relations(id, seed_identity UNIQUE,
   source_fragment_id, target_fragment_id, relation_type, status, evidence,
   source_revision_id, target_revision_id, created_at)`；
   `status ∈ confirmed/candidate/missing/stale`；反方向在查询时派生（`RELATION_INVERSES`）；
   确定性 id：`rel_<sha1(seedIdentity)[:24]>`、seed 身份 `assoc_<sha1(codePath:symbol)[:16]>`；
   失效：`invalidateStaleRelations`（任一侧离开 head 或 source 被删 → stale）、
   `invalidateRemovedSeeds`（seed 从 json 移除 → stale）。**从不 DELETE，只翻 stale。**
5. **派生理解先例**（`source_profiles` 表，migrations v12）：按 `(source_revision_id,
   profile_generation)` 记录 profiler_version、carrier_type、languages、title_path、
   coverage_gaps、domain_candidates、`derived=1`、evidence_refs、`status ∈ ok/partial/failed`、error。
   注释明确：这不是已验证事实，可重派生、携带 unknowns，profiling 失败不阻塞原始证据读取。
6. **Agent 运行时**（`packages/agent-runtime/roles/` + `agent-runtime/gateway.ts`）：
   `RoleBundleRegistry` 加载 `<role>/<version>/{manifest.json,prompt.md,output.schema.json,skills/}`；
   manifest 经 zod（`roleManifestSchema`）校验；输出 schema 现为
   `ProposalBatch.v1 / AssessmentBatch.v1 / PlanProposal.v1 / CorrectionProposal.v1 / AnswerWithCitations.v1`；
   gateway 渲染"受信角色外壳 + 不可信材料"，输出经 zod 校验 + 最多 2 次 repair，
   trace 记录 bundleHash/promptHash/contextHash/skillHash/toolHash/fingerprint；
   模型经 ACP/CLI profile（`transport: acp|traex-cli|codex-cli|claude-cli`）。
7. **模型不可用的诚实失败**（`assistant/runtime.ts:ModelUnavailableError`）：
   无 profile / CLI 缺失 / 未登录 / 超时 / 输出非 JSON → 一律抛错，turn 记 failed、
   零 citation、零任务，**绝不编造回答**。
8. **检索端口**（`retrieval/port.ts` + `KeywordRetrieval`）：`searchSources/searchMemories/
   readEvidence/health`，候选全部指回不可变 fragment id；review app 另有自己的 SQL 搜索
   （category/removed 条件下推，`review/app.ts:reviewSearch`）。
9. **治理环**：proposals → policy_evaluations（auto_apply/awaiting_decision/reject/
   defer_until_use/retain_as_source/ignore_noise）→ decisions → memory_revisions；
   `memory_dependencies` 在 source 更新时翻 stale；`refresh_records` 记录受影响记忆。
10. **工具链现状**：`typescript@5.9.3`（devDep）与 `@vue/compiler-sfc`（随 `vue@3.5.43`）
    **已在 node_modules**；`ts-morph`、`tree-sitter`、SCIP **均未安装**。
    pnpm workspace 仅登记 `apps/web`、`packages/ui`；`packages/contracts`、`packages/agent-runtime`
    以相对路径被 `apps/server` 直接引用。

---

## 3. 领域模型

【设计】命名如下（可调整）：`CodeRepository / CodeSnapshot / CodeFile / CodeSymbol / CodeEdge / CodeUnderstanding`。
它们**不替换**既有 `sources/revisions/fragments`，而是叠加在其上：
`CodeFile` ≈ 一个 `sources` 行的代码侧投影；`CodeSymbol` 通过 `fragment_id` 锚定不可变证据。

### 3.1 CodeRepository（仓库）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `repo_id` | TEXT PK | 稳定 slug，如 `omem`。【设计】单仓 PoC 恒为一行 |
| `root_path` | TEXT | 仓库根（运行时解析，不入外部身份） |
| `remote` | TEXT NULL | `git remote get-url origin`；取不到为 NULL（不猜） |
| `default_branch` | TEXT NULL | 同上 |
| `created_at` / `updated_at` | TEXT | |

【设计】与既有隔离库约定一致：PoC 单仓、单用户、loopback；不假装多租户。

### 3.2 CodeSnapshot（一次同步快照）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `snapshot_id` | TEXT PK | `snap_<sha1(repo_id + commit + dirty + 全量contentHash列表)[:24]>`；同输入重算同 id，幂等 |
| `repo_id` | TEXT FK | |
| `commit` | TEXT NULL | `git rev-parse HEAD`；git 失败为 NULL 且 `partial=1` |
| `dirty` | INTEGER | 工作树含非 `.repo-review` 改动（复用 `sync.ts` 的 `isInternal` 排除） |
| `baseline_commit` | TEXT NULL | 上次成功推进的 baseline（对应 `last-sync.txt`） |
| `captured_at` | TEXT | ISO 时间 |
| `parser_version` | TEXT | 解析器版本钉版，如 `ts-ast@1 / vue-sfc@1 / regex-imports@1` |
| `file_count` / `changed_count` | INTEGER | |
| `partial` | INTEGER | git 失败/全量重扫时为 1 |

【设计】这是对 `sync.ts` 现有 `Snapshot = {commit, dirty}` 与 `last-sync.json` 的**表化**：
一次 run 一行；dirty 快照不推进 baseline 的既有规则不变。
【未实现】跨 snapshot 的文件级增量 diff（目前 sync 用 git diff --name-only，表层不重算）。

### 3.3 CodeFile（文件）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `file_id` | TEXT PK | `file_<sha1(repo_id + repo_rel_path)[:24]>`；路径稳定，跨编辑不变（对应 `external_id`） |
| `repo_id` | TEXT FK | |
| `path` | TEXT UNIQUE | POSIX 相对路径 |
| `language` | TEXT | `typescript / vue / markdown / json / toml ...`（由扩展名 + 内容探测） |
| `size_bytes` | INTEGER | |
| `content_hash` | TEXT | sha256（复用 `sync.ts:digest`） |
| `head_snapshot_id` | TEXT FK NULL | 当前 head 对应的 snapshot |
| `removed` | INTEGER | 文件从磁盘消失（复用 `reconcileSources`） |
| `moved_to` | TEXT NULL | rename 目标（复用 `review_source_meta.moved_to`） |

【设计】`CodeFile` 与 `sources(namespace='file', external_id='omem:<path>')` **一一对应**，
但不复制其正文：正文只存 `revisions/body`。`removed/moved_to` 直接投影自 `review_source_meta`。

### 3.4 CodeSymbol（符号）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `symbol_id` | TEXT PK | `sym_<sha1(repo_id + path + qualified_name + kind)[:24]>`；**不含 range**，重命名跟 qualified_name 走 |
| `file_id` | TEXT FK | |
| `snapshot_id` | TEXT FK | 本符号在哪个 snapshot 被解析出来（range 是 per-snapshot 的） |
| `name` | TEXT | 短名 |
| `qualified_name` | TEXT | 如 `Store.capture`、`ReviewApp`、`POST /api/review/sync` |
| `kind` | TEXT | `function / class / method / interface / type / enum / const / component / route / test / module` |
| `range_start` / `range_end` | TEXT | `{line,col}`（1-based 行、0-based 列）；per-snapshot，**不入身份** |
| `fragment_id` | TEXT FK NULL | 锚定到不可变 `fragments.id`（见 §3.7） |
| `exported` | INTEGER | |
| `signature` | TEXT NULL | 单行签名摘要（用于搜索/展示） |

【设计】符号身份 = 稳定逻辑名；range/位置只在当前 snapshot 有效。
这与既有"fragment 锚在 head revision、跨 revision fragment 身份续接未实现"的限制一致
（AGENTS.md 已声明：代码改动产生新 revision 后需重新 sync 让 symbol/anchor 在新 head 上重新定位）。

### 3.5 CodeEdge（typed 结构化边）

【设计】这是本模型相对 `review_relations` 的增量：**代码结构边**与**评审意图边**分开存。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `edge_id` | TEXT PK | `cedge_<sha1(seed)[:24]>`，seed = 规范化后的端点+kind |
| `snapshot_id` | TEXT FK | 在哪次解析中产生 |
| `edge_kind` | TEXT | 见下表 |
| `from_symbol_id` / `from_file_id` | TEXT | 端点之一（符号优先，否则文件） |
| `to_symbol_id` / `to_file_id` | TEXT | 另一端 |
| `status` | TEXT | `confirmed / candidate / stale / missing` |
| `origin` | TEXT | `parser / seed / llm`（确定性解析 / 手维护 seed / 模型派生） |
| `evidence` | TEXT NULL | 引用说明或 fragment id 列表（JSON） |

`edge_kind` 枚举（【设计】）：

| kind | 含义 | 端点 | 来源 |
| --- | --- | --- | --- |
| `module_of` | 文件属于哪个模块/目录 | file → module(file) | parser |
| `imports` | A import B | file/symbol → file/symbol | parser |
| `exports` | A 导出 B | file → symbol | parser |
| `defines` | file 定义 symbol | file → symbol | parser |
| `calls` | A 调用 B | symbol → symbol | parser（PoC 仅同文件内/名称级） |
| `route` | 注册了 HTTP 路由 | symbol → route 字符串 | parser（Fastify 正则） |
| `test_of` | 测试用例断言目标 | test symbol → file/symbol | parser（`it/test` 边界） |
| `vue_component` | .vue 文件即组件 | file → component symbol | parser |
| `uses_component` | 模板引用组件 | component → component | parser（PoC 轻量） |
| `implements` 等 6 种 | 评审意图链 | symbol/file → intent fragment | seed（复用现有逻辑） |

【设计】反方向（`imported_by / exported_by / called_by / tested_by`）**查询时派生**，
与 `RELATION_INVERSES` 同模式，不落库。

### 3.6 CodeUnderstanding（派生理解）

【设计】对应任务要求的 derived understanding；直接复用 §2.5 `source_profiles` 的"可重派生、
带 unknowns、不阻塞原始证据"模式，并吸收 `role_outputs` 的 trace 字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `understanding_id` | TEXT PK | `cu_<sha1(target+inputHash)[:24]>` |
| `target_type` | TEXT | `repository / file / symbol` |
| `target_id` | TEXT | 对应 repo_id/file_id/symbol_id |
| `snapshot_id` | TEXT FK | |
| `role_id` / `role_version` | TEXT | 哪个角色产出（PoC 可为 `deterministic@1`） |
| `prompt_hash` | TEXT | 受信提示词指纹（复用 `stableDigest`） |
| `input_hash` | TEXT | 材料+上下文指纹；输入变了即重算 |
| `output_schema` | TEXT | 如 `CodeUnderstanding.v1` |
| `output_json` | TEXT | 结构化产出摘要/职责/风险 |
| `confidence` | REAL NULL | 模型不可用或未知时为 NULL |
| `unknowns` | TEXT JSON | 显式列出"不知道什么"（对齐 `coverage_gaps`） |
| `evidence_refs` | TEXT JSON | 引用的 fragment id 列表（必须真实存在） |
| `status` | TEXT | `ok / partial / failed / model_unavailable / stale` |
| `model` / `effort` | TEXT NULL | 记录实际生效模型（确定性行为 NULL） |
| `generated_at` | TEXT | |
| `supersedes_id` | TEXT NULL | 同 target 新理解取代旧行 |

【设计】`producer_kind='derived'` 的理解**永不作为独立证据进 extract_claims 队列**
（复用 `store.ts:queueCaptureJob` 对 derived 的既有排除）。

### 3.7 固定 range / fragment 关联

【设计】现状 fragment 由正则边界切分；解析器产出精确 range 后：

1. 解析器按 `range_start.line` 找到该文件 head revision 中 ordinal 最匹配的 fragment，
   把 `symbol.fragment_id` 指向那个**不可变 fragment id**；
2. range（line/col）存在 `CodeSymbol` 上，仅当前 snapshot 有效；
3. 读取侧：展示 range → 但引用、关系、检索一律用 `fragment_id`（与 `review_relations` 一致）；
4. 文件内容变更 → 新 revision → 旧 `fragment_id` 随旧 revision 冻结，
   锚在其上的边按 §4 翻 stale，下一次 sync 在新 head 上重定位。
【未实现】跨 revision 的 fragment 身份续接（与 AGENTS.md 记录的限制一致）。

---

## 4. 生命周期与双向/版本失效

【设计】`status ∈ confirmed / candidate / stale / missing` 语义对齐现有 `review_relations`：

- `confirmed`：parser 确定性产出（imports/exports/defines/range）或 seed 显式登记且两端都解析成功；
- `candidate`：LLM/启发式提出、尚未人工确认的边；
- `missing`：seed 要求的端点解析不到（代码未入库/符号未定位）——**保留可见**，不静默丢弃；
- `stale`：以下任一发生即翻 stale（只翻转，不删除）：
  1. 文件 head snapshot 推进（content_hash 变），边锚在旧 fragment；
  2. 文件被删（`removed=1`）或 rename；
  3. seed 从 `associations.json` 移除；
  4. `CodeUnderstanding.input_hash` 变化 → 旧行 `stale`，新行 `supersedes_id` 指向旧行。

【设计】双向失效：对 `invalidateStaleRelations` 做同构扩展——边的**任一端**
离开当前 head / source 被删 / 文件被移除，整条边翻 stale；查询默认隐藏 stale，
`include_stale=true` 看历史（对齐 `RelationReadOptions`）。
【设计】失效在一个事务内完成（`store.tx`），与既有 sync 重算幂等。

---

## 5. 存储表设计

【设计】全部为**新增、幂等 `CREATE TABLE IF NOT EXISTS`**，放在 review 侧新模块
（如 `apps/server/src/code-knowledge/store.ts`，本文不创建）。

【设计决策】**不**把这些表塞进 `storage/migrations.ts` 的 v15。理由：
【事实】`review_source_meta / review_relations` 也不在 migrations 里，而是运行时
`ensure*` 建在隔离的 `.repo-review/data/omem.sqlite` 中（`review/store.ts` 头注释：
side table 只活在 review 自己的 SQLite，永不改动共享业务 Store）。
Code Knowledge 表遵循同一隔离原则：它们服务的是隔离库，不进入个人工作区 schema 版本号。
【未实现/备选】将来若 Code Knowledge 要复用到个人工作区跨仓检索，再作为 migrations v15 上移。

```sql
-- 设计稿，非生产代码
CREATE TABLE IF NOT EXISTS code_repositories(
  repo_id TEXT PRIMARY KEY, root_path TEXT NOT NULL,
  remote TEXT, default_branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS code_snapshots(
  snapshot_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES code_repositories(repo_id),
  commit TEXT, dirty INTEGER NOT NULL DEFAULT 0, baseline_commit TEXT,
  captured_at TEXT NOT NULL, parser_version TEXT NOT NULL,
  file_count INTEGER, changed_count INTEGER, partial INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS code_files(
  file_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL REFERENCES code_repositories(repo_id),
  path TEXT NOT NULL UNIQUE, language TEXT, size_bytes INTEGER,
  content_hash TEXT, head_snapshot_id TEXT REFERENCES code_snapshots(snapshot_id),
  removed INTEGER NOT NULL DEFAULT 0, moved_to TEXT);

CREATE TABLE IF NOT EXISTS code_symbols(
  symbol_id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES code_files(file_id),
  snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
  name TEXT NOT NULL, qualified_name TEXT NOT NULL, kind TEXT NOT NULL,
  range_start TEXT, range_end TEXT, fragment_id TEXT,
  exported INTEGER NOT NULL DEFAULT 0, signature TEXT);
CREATE INDEX IF NOT EXISTS code_symbols_file_idx ON code_symbols(file_id, snapshot_id);
CREATE INDEX IF NOT EXISTS code_symbols_frag_idx ON code_symbols(fragment_id);

CREATE TABLE IF NOT EXISTS code_edges(
  edge_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
  edge_kind TEXT NOT NULL,
  from_symbol_id TEXT, from_file_id TEXT, to_symbol_id TEXT, to_file_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('confirmed','candidate','stale','missing')),
  origin TEXT NOT NULL CHECK(origin IN ('parser','seed','llm')),
  evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS code_edges_from_idx ON code_edges(from_symbol_id, from_file_id);
CREATE INDEX IF NOT EXISTS code_edges_to_idx ON code_edges(to_symbol_id, to_file_id);
CREATE INDEX IF NOT EXISTS code_edges_status_idx ON code_edges(status, edge_kind);

CREATE TABLE IF NOT EXISTS code_understandings(
  understanding_id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
  role_id TEXT NOT NULL, role_version TEXT NOT NULL,
  prompt_hash TEXT, input_hash TEXT NOT NULL, output_schema TEXT NOT NULL,
  output_json TEXT, confidence REAL, unknowns TEXT, evidence_refs TEXT,
  status TEXT NOT NULL CHECK(status IN ('ok','partial','failed','model_unavailable','stale')),
  model TEXT, effort TEXT, generated_at TEXT NOT NULL, supersedes_id TEXT);
CREATE INDEX IF NOT EXISTS code_understandings_target_idx ON code_understandings(target_type, target_id, snapshot_id);
```

---

## 6. 端口与服务接口

【设计】保持与既有端口同构，不发明新风格：

```ts
// 伪代码，非生产实现
interface CodeKnowledgePort {
  /** 当前 head 快照与同步统计 */
  currentSnapshot(): CodeSnapshotView | null;
  /** 文件列表（复用 review 的 sourceList 形状，增加 language/removed） */
  listFiles(filter?: { language?: string; includeRemoved?: boolean }): CodeFileView[];
  /** 某文件的符号（head snapshot） */
  symbolsOfFile(fileId: string): CodeSymbolView[];
  /** 某符号/文件的双向边（默认隐藏 stale，同 relationsForFragment） */
  edgesOf(ref: { symbolId?: string; fileId?: string }, opts?: { includeStale?: boolean }): CodeEdgeView[];
  /** 某目标的派生理解（head） */
  understandingOf(target: { type: "file" | "symbol"; id: string }): CodeUnderstandingView | null;
  /** 触发增量解析+重建（幂等） */
  sync(opts?: { only?: string[] }): Promise<SyncResult>;
}
```

【设计】HTTP 表面挂在现有 `/api/review` 前缀下（不新开端口、不动鉴权）：
`GET /api/review/code/files`、`GET /api/review/code/files/:id/symbols`、
`GET /api/review/code/edges?symbolId=&fileId=`、`GET /api/review/code/understanding?...`、
`POST /api/review/code/sync`（与现有 `POST /api/review/sync` 并列，互不干扰）。

---

## 7. 与旧 repo-review 表的兼容迁移/投影（不得清空）

【设计】这是硬约束。现状：

- 【事实】`sources / revisions / fragments / review_source_meta / review_relations`
  以及 `.repo-review/data/omem.sqlite`（含已跟踪数据）都是**线上有效证据**；
- 【事实】`associations.json` 的 seed 是评审关系唯一来源；
- 【事实】`review_relations` 重建是幂等 upsert，从不 DELETE。

【设计】迁移/投影策略：

1. **只读投影，不搬数据**：`code_files` 由 `sources(namespace='file')` + `review_source_meta`
   投影生成（file_id 与 external_id 可互算）；`code_symbols.fragment_id` 直接引用既有 fragment。
   不复制正文、不改写既有行。
2. **既有 review_relations 保持权威**：评审意图链（implements/requires/...）仍由
   `buildReviewRelations` 写 `review_relations`；`code_edges` 的 `implements` 类边通过
   **桥接行**指向同一 fragment，不复制语义、不搞第二份真相。
3. **新增表全部 additive**：§5 的表只 `CREATE IF NOT EXISTS`；迁移测试断言
   "迁移前后 `sources/revisions/fragments/review_relations` 行数不变"。
4. **幂等重入**：重复 sync 用确定性 id upsert，不产生重复行（对齐 `relationId`）。
5. **脏/迁移标记**：沿用 `migrated-v2.flag` 模式；新投影无需一次性迁移脚本，
   第一次 sync 即投影，失败可安全重跑。
【未实现】无。本切片要求：任何 PR 不得 `DROP TABLE`/`DELETE FROM` 既有 review 表。

---

## 8. 确定性解析最小组合评估与 PoC 选择

【设计】评估维度：是否零新依赖、离线确定性、能否产出精确 range、TS+Vue 覆盖。

| 方案 | 现状 | 精确 range | TS | Vue SFC | 增量/跨文件类型 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **TS Compiler API**（`typescript.createSourceFile`） | 【事实】已装（devDep） | ✅ node.getStart/getEnd | ✅ | ❌（需另接） | AST-only 无类型；建 program 才有跨文件解析 | **PoC 首选** |
| ts-morph | 未安装 | ✅ | ✅ | ❌ | 封装更友好但新依赖、体积大 | 暂缓 |
| **@vue/compiler-sfc** | 【事实】已装（vue 依赖） | ✅ block 起止 | ❌ | ✅ | 模板 bindings 需额外分析 | **PoC 首选（配 TS）** |
| Tree-sitter | 未安装（native 绑定） | ✅ | ✅ | 需 grammar | 多语言/增量强 | 暂缓（新 native 依赖） |
| SCIP / indexer | 未安装（外部工具链） | ✅ | ✅ | 需 SCIP 索引器 | 跨仓跨语言最强 | 暂缓 |

【设计】**首个 TS/Vue PoC 选择**：TS Compiler API（单文件 AST，不建 program）+
`@vue/compiler-sfc`（parse 出 script/template/style block）+ 轻量正则补 imports/routes/tests。
理由：零新 pnpm 依赖、离线、确定性、与现有 `tsx` 运行时一致。

PoC 解析范围（第一切片）：

- TS：`import/export` 语句（imports/exports）、顶层 `function/class/const/interface/type/enum`
  声明（defines + range）、同文件内同名调用（calls，名称级、标 candidate）；
- Vue：`.vue` → `vue_component` 符号；`<script setup>` 里 `defineProps/defineEmits` 轻量提取；
  模板里组件标签 → `uses_component`（轻量，candidate）；
- 路由：`app.(get|post|put|delete|patch)(...)` 正则 → `route` 符号（PoC 正则，标注 origin=parser 但 kind=route）；
- 测试：复用现有 `TEST_BOUNDARY`（`it/test/describe`）→ `test_of`。

【未实现】跨文件类型感知 calls、完整 SCIP 跨仓索引、Tree-sitter 多语言。

---

## 9. Agent 角色 / skill 与严格输出 schema / 引用验证

【设计】新增理解角色（如 `code-explainer@1`），但**本切片不落地角色目录**：

- 【事实】`roleIdSchema`（contracts）是闭合枚举 `[extractor, verifier, planner,
  feedback-curator, answerer]`；加角色要改 contracts 包（生产代码），超出本文范围。
- 【设计】后续步骤：在 contracts 增加 `code-explainer` 与输出 schema `CodeUnderstanding.v1`
  （新 JSON schema，字段含 `summary / responsibilities / risks / unknowns / citation_refs`），
  再建 `packages/agent-runtime/roles/code-explainer/1/{manifest.json,prompt.md,output.schema.json}`。
- 【设计】引用验证：`citation_refs` 中的每个 fragment id 必须在 DB 中真实存在且属于
  对应 target 文件；gateway 解析后由服务端二次校验（对齐 verifier 的 exact_quote 校验），
  不存在即整行拒绝、记 `status=failed`，不接受模型编造的引用。
- 【设计】确定性行为先行：PoC 的 `CodeUnderstanding.status=ok` 由确定性 profiler 产出
  （文件语言/符号数/导出数/coverage_gaps），**不需要模型**；LLM 理解作为可选增强。

---

## 10. 模型不可用降级

【设计】对齐 §2.7 的诚实失败原则：

1. **结构层永不需要模型**：imports/exports/defines/routes/tests/components/ranges 全部
   确定性解析，无模型时照样建库、浏览、搜索、追溯；
2. **派生理解**：无模型时写一行 `status=model_unavailable`、`confidence=NULL`、
   `unknowns=["model unavailable"]`，不写假摘要；
3. **不自动降级为 canned answer**：助手侧若引用代码理解，模型不可用就抛
   `ModelUnavailableError`（既有模式），turn failed、零引用；
4. UI 显示"结构边可用、AI 理解暂缺"，不隐藏缺口。

---

## 11. pnpm / osdk 迁移约束

【设计】本切片**零新依赖**（§8）。后续若引入 ts-morph/tree-sitter：

- 【事实】`osdk.toml`：node 24.18.1、pnpm 11，`tasks.check = [typecheck, test, build]`，
  上游 `lejunyang/one-sdk`；`pnpm-workspace.yaml` 仅 allowBuilds。
- 【设计】任何新依赖走 `pnpm add -D <pkg> -w`，必须通过 `osdk deps --frozen` 与
  `osdk run check`（typecheck + vitest + build）；native 绑定（tree-sitter）需在
  `pnpm-workspace.yaml:allowBuilds` 登记并在 PR 说明 Windows 行为。
- 【设计】不改 `package.json` scripts 语义；review 开发仍用 `osdk run dev:review`
  （5180 API + 5181 Vite，`scripts/dev-review.ts` 的 taskkill /T /F 生命周期不变）。
- 【未实现】无。

---

## 12. 第一纵向切片：assistant → memory → retrieval → Lark → web

【设计】按阶段打开，每阶段独立可验收、可独立提交（对齐 AGENTS.md "每个完成的功能切片
及时提交"）。注意：完整 `assistant→memory→Lark` 通路在本切片**只到 web + 只读 API**；
Lark/assistant 接入列为后续阶段，避免一次性大改。

### Stage 0（本文档）
- 交付：本设计文档；验收：文档入库、事实点可被 grep 复核、无生产代码改动。

### Stage 1 — 确定性解析与存储（后端，无 UI/无 LLM）
- 新增 `apps/server/src/code-knowledge/{store.ts,parse.ts,sync}.ts`（设计，非本文创建）；
- TS/Vue 解析器产出 code_files/code_symbols/code_edges（imports/exports/defines/routes/tests/components）；
- 幂等 sync、dirty/removed/rename 失效、既有表行数不变；
- 测试：`apps/server/tests/code-knowledge-*.test.ts`。

### Stage 2 — 只读 API
- `/api/review/code/*`（§6）；复用既有 loopback 鉴权；
- 测试：API 级（fastify inject）。

### Stage 3 — web 视图
- `ReviewApp.vue` 增加符号/边面板；`review-api.ts` 加类型；
- 浏览器验证：`osdk run dev:review` 访问 5181，人工/Playwright 冒烟。

### Stage 4 — 派生理解（确定性 profiler 先，LLM 后）
- 确定性 CodeUnderstanding（无模型）；随后可选 `code-explainer` 角色；
- 模型不可用降级（§10）。

### Stage 5 — assistant → retrieval → Lark（后续，不在本切片）
- retrieval port 暴露 code 边；助手引用代码片段；stale/缺失边生成治理卡片走既有
  proposal→policy→decision→Lark delivery 环。【未实现】

### 12.1 测试矩阵

| # | 用例 | 层 | 类型 | 通过标准 |
| --- | --- | --- | --- | --- |
| T1 | TS 文件解析出 function/class/range | 解析器 | 确定性单测 | symbol_id 稳定、range 正确 |
| T2 | .vue 解析出 component + props/emits | 解析器 | 确定性单测 | 不崩溃、轻量提取 |
| T3 | imports/exports/defines 边 upsert 幂等 | sync | 确定性 | 重复 sync 不增行 |
| T4 | dirty 快照不推进 baseline | sync | 确定性 | 对齐现有 dirty 行为 |
| T5 | 文件删除 → 边翻 stale、不删行 | 失效 | 确定性 | status=stale，行数不变 |
| T6 | seed 移除 → 关联边 stale | 失效 | 确定性 | 对齐 invalidateRemovedSeeds |
| T7 | 既有 review 表迁移前后行数不变 | 迁移 | 确定性 | sources/revisions/fragments/review_relations count 相等 |
| T8 | fragment_id 锚定真实 fragment | 集成 | 确定性 | 外键可 join |
| T9 | 无模型时 CodeUnderstanding=model_unavailable | 降级 | 确定性 | 不造假摘要 |
| T10 | LLM 编造 citation_refs 被拒绝 | 验证 | 确定性（fixture） | 整行 failed |
| T11 | API `/code/files` 返回 head 文件 | API | fastify inject | 200 + shape |
| T12 | web 5181 展示符号/边 | 浏览器 | 手动/Playwright | 无 console error |
| T13 | 真实 ACP 模型端到端理解 | live | 单独标注 | 需本机 CLI，默认跳过 |

【事实】测试约定：vitest、mkdtemp 隔离库、真实 `git init` fixture（对齐
`review-relations.test.ts`）、live 检查单独标注（对齐 AGENTS.md "Protocol fixture tests
are not evidence…label live checks separately"）。

---

## 13. 明确不做（本切片边界）

- 不改共享 `storage/migrations.ts` schema 版本号；
- 不改 `packages/contracts` 角色枚举（Stage 4 才动）；
- 不引入 ts-morph / tree-sitter / SCIP；
- 不清空/迁移/重写既有 `.repo-review` 数据；
- 不接 Lark/assistant 生产通路（Stage 5 后续）；
- 不把代码数据进个人工作区 `.omem/`。
