> **2026-10-01 中文语义检索**：osdk 已下载并校验固定版 `Xenova/bge-small-zh-v1.5` q8（权重 24,010,842 字节）。SQLite schema 17 保存按模型身份隔离的原片段分窗向量；个人助手、飞书助手和 repo-review 搜索共用检索，后台补建新材料，模型缺失时保留词法结果并报告 degraded。真实四条中文同义问法 top-1 为 4/4，词法基线为 0/4；这是小样本，不是整体检索质量结论。`osdk deps --frozen` 与全量 `osdk run check` 通过（57 文件 / 343 用例、typecheck、build）；首轮真实仓库向量索引为 9,613 个片段。仍未实现 reranker / ANN / 历史时点检索。`.repo-review` 的当次更新与实际覆盖见 `knowledge/verification.json`，不能沿用旧统计。

> **2026-10-01 来源更新闭环**：`refresh_dependents` 不再是 NOT_IMPLEMENTED 占位。Capture 同事务记录失效范围，调度复用已有 extractor job，独立 verifier 后由 MemoryService 原子更新同一记忆；失败/缺证据维持 `needs_review`，只有全部受影响记忆真正应用才记 `applied`。`/api/memory-refreshes` 提供状态和结果。模型 schema 从宿主 Zod 合同生成，修正原先 body 空定义及把可空元数据误当事实歧义的问题。全量 `osdk run check` exit 0（56 文件 / 341 用例 + typecheck/build）；真实 **traex / gpt-5.6-sol / medium** 验证“3 次→5 次”同 ID 第二版、旧原文保留、五个 jobs 全部成功。报告为忽略提交的 `.omem/verification/live-refresh.json`。周期全库巡检、跨来源冲突自动修订和学习卡仍未实现。下文旧的 NOT_IMPLEMENTED 说明保留作历史记录。

> **2026-10-01 日常助手闭环**：补搜一次（最多三个查询）、现有事项上下文、用户时区、带时间创建/改期/完成/重新打开，以及由真实回执生成的动作回复。`osdk run check` 通过：56 文件 / 340 用例 + typecheck/build。`scripts/live-assistant-smoke.ts` 用真实 **traex / gpt-5.6-sol / medium** 验证了中文召回英文原文及创建→改期→完成（隔离数据库、合成材料，无外部发送）。一次性到期站内提醒仍复用已有轮询；独立日程、重复提醒、外部到期投递及取消状态未实现。

> **2026-10-01 新进展**：统一检索已接 SQLite FTS5/BM25 + 中文短词 + 活跃记忆原证据 + 知识正文引用的 RRF 融合。跨段引用返回涉及的原片段；时间过滤按采集时间执行；助手旧轮次证据重新检查 source head。以下旧记录中的“只有 LIKE”“本机无 CLI”已经过时。全量 `osdk run check` 通过（56 文件 / 338 用例，含 build），`osdk deps --frozen` 通过。真实 `traex acp` + `gpt-5.6-sol` / `medium` 已完成能力校验与问答；这次仅证明 ACP 连通，不代替生成知识或主助手端到端验收。检索仍没有向量、语义重排和历史时点查询。

> **当前新增能力以本段与 [通用知识流程](knowledge-pipeline.md) 为准。** 已接入共用正文/引用合同、八种知识角色、持久分析与独立复核、仓库全材料适配、个人知识入口、正文多层引用、问题/待办、知识引导原始证据召回。所有实现按功能分项提交。全仓 AI 处理与章节生成的逐文件结果见 `.repo-review/knowledge/coverage.json`；没有把未通过、过期或未生成的材料算作完成。下方 Code Wiki 200 文件/6 份说明等统计保留为此前切片的历史记录。

> 本轮后续：实际 Agent 配置改为 `config/review-code-model.json`，生成及 review 服务默认读取它，环境变量仍可覆盖。启动默认直接重建 runtime，不依赖旧 `.repo-review/data/`；旧历史导入改为 `REVIEW_IMPORT_LEGACY=1` 显式选择。后续正文知识管线的进度与验收将另行补充。

> 2026-09-29 Linux 本机复审：见 [方案与实现复审](code-wiki-review-2026-09-29.md)。Code Wiki 已改为从精确 Capture 文本派生；启动自动完成材料/代码/版本化知识恢复；开发端口可配置且默认冲突自动选择；共享语法高亮与符号源行号已修复。仓库 Wiki 入口为 [`.repo-review/wiki.md`](../../.repo-review/wiki.md)，更新命令 `osdk run review:build`。本机 traecli 0.207.1 的 GPT-5.6-Sol 已真实生成模块说明，默认启动仍不调用模型。下文较早的“本机无 traecli”“没有模型 live”“固定端口”记录属于先前环境，不代表此次状态。当前预算示例 96000 输入 / 24000 输出 / 16000 Agent 预留，完整提示词按 UTF-8 bytes/3 + 25% 余量估算，另检查模型声明窗口。

## 本轮复审验证（Linux / 2026-09-29）

- `osdk deps --frozen` exit 0；完整 `osdk run check` 已通过（51 个测试文件 / 312 用例，含 typecheck + build）。
- `osdk run browser` exit 0：个人阅读、递归证据、学习任务、当前 AttentionGate 的跨源 claim 决策、通知、768/390、100 层固定证据、失败与重启诚实性。修复初始化导航竞态；旧的“未知转述自动提请用户判断”fixture 已改为当前策略认可的 active claim 跨源冲突。
- 最终 `dev:review` 实例自动重建，实际端口 26003/32395；`scripts/code-wiki-viewport.ts` exit 0，1440/768/390、真实高亮样式、模型说明、引用栈与深链、XSS、焦点通过。默认用户端口被占用时选择新端口，原有服务不被终止。
- 6 份真实 `gpt-5.6-sol` 说明：检索、助手 runtime、MemoryService、代码投影、仓库材料同步、共享代码阅读器。均 `seed=false / verified_by_agent=false`，6 份人工 seed 仍独立保留。当前 Wiki 目录覆盖 200 文件、20 模块；模型说明仅覆盖明确列出的目标范围。
- MemoryService 按扩大后的预算成功：完整提示词 110183 字符、111585 UTF-8 字节，估计 37195 tokens，加 25% 余量后计 46494；本次上限 96000 输入 / 24000 输出 / 16000 Agent 预留。先前输入/输出超限记录保留为失败；不把估算当实际计费 tokens。
- 全新临时 SQLite 重建实测 exit 0：捕获 237 份材料、投影 200 文件，恢复 6 份真实模型说明 + 6 份人工 seed；未复制旧 runtime、未调用模型。
- 当前真实模型结果不等于独立语义核验；跨文件调用、embedding、统一跨输入渠道的代码角色 worker 和下游重核验仍未交付，详见复审记录。



# 实现状态

> 本页为唯一当前状态来源。文档最后更新：2026-09-29（通用 Code Knowledge / Code Wiki 纵向切片完成后）。**运行时权威**：当前 commit / 工作树状态以 `git rev-parse --short HEAD`、`git status --short` 为准，代码 snapshot 以运行中 `GET /api/review/code/current-snapshot` 为准；本静态页只记录最后一次验证命令与历史证据，不固化任何 commit id、snapshot id 或本地提交数。

## 当前状态

- **代码基线**：`16d3aa6` 之后叠加 assistant-v3（V3-01～V3-06）六组修复、v14 治理增量（memory_equivalences 关系表、decisions.attention_case/dedupe_key、AcpAssistantModel 生产接线），以及通用 Code Knowledge 纵向切片（确定性 TS/Vue 代码图、curated seed 投影、Code Wiki web 与 trail 对齐）。
- **Schema 版本**：SQLite `SUPPORTED_SCHEMA_VERSION = 14`（`apps/server/src/storage/migrations.ts`；v14 新增 `memory_equivalences` 表 + `decisions.attention_case`/`dedupe_key` 列与去重索引）。Code Knowledge 的 `code_*` 表不进业务 schema 版本号，运行时 `ensure*` 建在隔离的 `.repo-review/runtime/` SQLite 里。
- **测试**：`osdk run check`（typecheck [tsc + vue-tsc] + 全量 vitest + vite build）为 **47 个测试文件 / 306 个用例**，连续 2 轮 exit 0（2026-09-29）。A-R07 timeout 事件已闭环：本轮 MainAgent 首次全量 check 失败、第二次通过——根因是 ACP 全局 timeout 在 prompt 成功后仍挂着、覆盖了 closeSession 拆除，叠加 role fixture 3s 预算在 Windows 并行 spawn 下不足；af77ca6 修复为 prompt 成功即 clearTimeout、普通 fixture 有界 10s（A-R05 hung 超时仍保持 1s）。修复后 role-runtime 独立连续 5 轮 40/40、全量 vitest 连续 2 轮、`osdk run check` 连续 2 轮 exit 0：已复现根因并回归稳定，但不外推为「所有 timeout 根治」。早期 182/30 等数字已随切片推进过期。
- **包管理**：pnpm workspace（`pnpm-workspace.yaml` 声明 `apps/*`、`packages/*`），锁文件 `pnpm-lock.yaml`；`osdk deps --frozen` 即 `pnpm install --frozen-lockfile`。历史 npm/package-lock npmmirror 临时改动已清理（见本节末尾旧记录）。
- **主助手模型接线**：生产装配 `apps/server/src/app.ts`（Web 路径）和 `apps/server/src/integrations/lark/runtime.ts`（飞书路径）均已 `new AssistantRuntime({ store, model: new AcpAssistantModel({ profile, workspaceRoot }), retrieval: new KeywordRetrieval(store.db), feedback: new FeedbackService(store), ... })` —— **Web 和飞书主助手生产路径均接真实 ACP adapter + RetrievalPort + scoped 纠正**。`DeterministicAssistantModel`（`assistant/default-model.ts`）**仅用于测试注入**。生产不存在"无模型配置时的假回答降级"：`AcpAssistantModel` 在无 profile / CLI transport / 未授权 / 超时 / 输出非 JSON 时一律抛 `ModelUnavailableError`，runtime 记 `failed` turn + `error=model_unavailable:*`，零 citation、零任务，绝不产出编造回答。任务创建经 `detectTaskIntent()`（21 祈使模式 + 11 咨询模式）确定性门控：咨询类即使模型发出 create_task 也被拒绝零写入；直接交办时 capture owner 消息为真实 source 证据后经 `MemoryService.evaluate()` 治理。取消经 `TurnCancelledError` fence 在 govern/complete 前检查，`withTimeout` Promise.race 主动 abort。
- **外部验证状态**：`AcpAssistantModel` 已复用真实 `acp()` 传输（`agents.ts`），并有 fixture agent（`tests/fixtures/acp-agent.mjs`）解析/超时/取消测试覆盖；但本机无 traecli/Codex 等真实 CLI，**真实 ACP 主助手端到端与真实飞书 WebSocket 收发仍未跑过 live**（均为注入/fixture adapter 测试）；语义检索（embedding）未接入，当前为 SQLite 关键词召回。

## Code Wiki（通用代码知识纵向切片）实测

> 定位：Code Wiki 不是独立产品，是同一 Capture→Source/Revision/Fragment→Relation/Retrieval 证据链在代码域上的确定性 typed projection；repo-review 只是隔离 dev 配置/视图（5180 API + 5181 web、独立 SQLite、不起业务 worker）。以下数字为 2026-09-29 对运行中 `osdk run dev:review` 实例的实测（`/api/review/*` 直接查询），非设计目标。

- **确定性代码图（无模型）**：TS Compiler AST（单文件、不建 Program）+ `@vue/compiler-sfc` + 保守正则（Fastify 路由 / `it/test`），零新依赖；parser 版本 `ts-ast@1+vue-sfc@1+regex@1`。snapshot id / 解析时 commit / dirty 标记以运行时 `GET /api/review/code/current-snapshot` 为准，本文不固化。上次验证（2026-09-29）时图为 **190 个文件**、四类材料库 **163 sources / 11940 fragments**——这些数字随仓库增长，仅作历史证据。
- **评审关系**：23 条手维护 seed（`docs/repo-review/associations.json`）→ 123 条边：**90 confirmed / 3 candidate / 30 missing**（byType：implements 23、requires 40、decided_by 22、researched_by 4、tested_by 34）。词相似未登记的片段不自动 confirmed；解析不到的锚点保留为 missing 可见。
- **curated 模块理解**：6 个 committed seed（`.repo-review/knowledge/understandings/*.seed.json`，module-architect@1）同步时把 path+qualifiedName locator 解析到 head 图、盖 digest、过严格 `CodeUnderstanding.v1` 交叉引用校验后投影为 current；共 12 行理解（含历史行），全部 `seed=true / source=curated-seed / verified_by_agent=false`。另有一份 agent 引用核验记录（`knowledge/verification/code-seeds-verification.json`）：人工/agent 逐条核对 42 个 locator 与证据原文引用，发现并修正 6 处 selector/ref 错配——**那是引用一致性审核，不是模型运行、不是语义评审、不是产品验收**。
- **模型 opt-in 与降级**：review 只读可选 env `REVIEW_CODE_MODEL_CONFIG`（JSON 文件），不读个人 Agent profile；未配置时 `GET /api/review/code/model-status` 返回 `available=false`，图与 curated seed 照常浏览，`POST .../understandings/generate` 503 `model_unavailable`，UI 诚实标注。**真实模型生成理解在本机从未 live 跑过**（只有 fixture model 与 schema 校验测试）。
- **真实 P0 UI 浏览器验收**：`scripts/code-wiki-viewport.ts`（Playwright 对运行中 5181，按稳定名称点穿真实 UI、不硬编码 DB id；首次需 `pnpm exec playwright install chromium`）已通过，证据截图 `docs/implementation/screenshots/wiki-*.png`（gitignored）：视口 1440/768/390 均无横向溢出；module→file→symbol→file→fragment **5 层下钻** + Esc 逐层退栈 + 面包屑跳回；UI 生成的 `/trail/` URL 刷新后整栈恢复；关闭全部后焦点归还到触发按钮；可见文本不含任何 `sym_/file_/fragment_` 裸 id 或 UUID；Markdown 经挂载态 `<OmMarkdown>`（DOMPurify）验证剥离 `<script>`/`onerror`/`javascript:`/`<svg>`/`<iframe>` 载荷。本机本次复核时 Playwright chromium 未安装，未重跑，以上为 2026-09-29 早前对同一脚本的执行记录。
- **runtime 隔离**：运行库在 `.repo-review/runtime/`（gitignored，唯一写入处）；tracked 的 `.repo-review/data/*.sqlite*`、`last-sync.*`、`browser.*.log`、`migrated-v2.flag` 是首启投影用的冻结种子；curated `.repo-review/knowledge/**` 入库。首启 readOnly `VACUUM INTO` 投影，绝不动种子。
- **调研**：公开 landscape（SCIP/Tree-sitter/deepwiki-open/OpenDeepWiki/CodeQL/Joern/Cody/Continue/Aider repo-map/GraphRAG/BGE-M3）与**内部 DeepWiki** 材料分节严格分开：后者是通过当前用户可访问的企业知识检索读取的内部文档，属内部产品自述、非公开开源事实，不进入横向对比总表，结论见 `docs/research/code-wiki-landscape.md`。
- **本切片未做/边界**：跨文件 calls 不解析（单文件名称级 calls 标 candidate）；跨 revision 符号/fragment 身份续接未实现（代码改完需重新 sync 让 locator 在新 head 重定位，旧边标历史版本）；无 embedding 语义检索；`refreshDependents` 下游重核验仍按设计 blocked。

## 能力矩阵

| 能力域 | 代码已实现 | 本地测试通过 | 真实 ACP 验证 | 真实飞书验证 | 剩余缺口 |
| --- | --- | --- | --- | --- | --- |
| 主助手对话 | 会话路由/turn 持久化与幂等排队（同 transport_event_id 不重复建 turn/task）、RetrievalPort 注入（Web+飞书均接 KeywordRetrieval 中文 2-gram 召回）、create_task 经 MemoryService + detectTaskIntent 意图门控（咨询类零写入）、多轮回指（priorWorkingContext 携带前轮 selected evidence）、群可见性 deny-by-default + 注入 policy、模型异常诚实失败（ModelUnavailableError→failed turn，不造假）、取消 TurnCancelledError fence + withTimeout（hung model 不挂死）、pending turn 持久恢复（recoverUnfinishedTurns，已 committed 工具不重做）、scoped 纠正注入（Web+飞书）、AcpAssistantModel 接真实 acp() 传输 + transport 路由 | 是（assistant-runtime 24、acp-model 9、app 8、conversation-router 3、conversation-security 3、lark-delivery-recovery 5） | 否（已接真实 acp() 传输 + fixture 解析测试；本机无 traecli，未 live） | 否（WebSocket 收发为注入 adapter） | 真实 ACP 端到端；进程级真实重启恢复（当前用同 DB 新 runtime 实例模拟） |
| 检索 | RetrievalPort 接口 + KeywordRetrieval（SQLite LIKE + CJK 2-gram 分词 + 停用词 + 长度加权打分）；source-profile 确定性规则分析；project_trusted 软过滤（未确认不过滤） | 是（retrieval-source-profile 6、retrieval-keyword 3） | 不适用 | 不适用 | embedding/语义检索；MemPalace sidecar；跨版本 Fragment 身份续接 |
| 知识治理 | AttentionGate 六态 + 四条件门控、memory_equivalences 等价关系表、decisions.attention_case/dedupe_key 去重、**evaluateBatch 生产化接入 pipeline verify()**（整 ChangeSet 去重累计 impact，超限全部 park 不 apply）、冲突记录、refresh_records、proposal/policy/receipt 原子应用 | 是（attention-gate、proposal-policy、learning-pipeline G17 批量） | 部分（历史一次 live smoke，`.omem/verification/`） | 否 | 完整重核验（extractor+verifier 重跑）consolidation job；真实模型语义冲突判断 |
| 输入保真 | per-part provenance、canonical principal 映射、owner/非owner 区分、agent/derived 入队区分、**飞书富文本/图片/reply 解析为统一 parts**（post→标题+段落，image→asset download，reply→replyTo/quoted） | 是（batch2-fixes G04–G07/G14、lark-rich-parts 3） | 否 | 否（open_id 绑定全链路；图片为 fake transport 验证） | 飞书真实网络图片下载；reply_to 真实引用关系解析 |
| 通知/投递 | outbox、投递幂等/重试/退避、卡片 callback 校验、cancel 撤销未发卡、短窗合并/定时汇总 | 是（lark-delivery、lark-realtime、annotation-cancel-delivery） | 否 | 部分（历史一次真实应用配对/通知/callback live） | 断网恢复、移群、secret 轮换、429 真实窗口 |
| 质量评估 | 证据支持六维拆分、规则基线语义判断、空分母 null、标注卡/冻结 manifest | 是（quality-evaluation、quality-annotation、import-quality-isolation） | 否 | 否 | 120 条 holdout 未建立；真实模型预测的语义评估效果 |
| 外部集成 | lark registration/pairing/加密 secret store、ACP adapter（Codex/TraeX/Claude）、Git/file 连接器 | 是 | 部分（TraeX 一次） | 部分（lark 一次） | MemPalace/WeKnora/Hindsight sidecar；无 Docker（见下） |

## G01–G20 验收场景逐项覆盖

来源：[assistant-v3/migration-and-acceptance.md](assistant-v3/migration-and-acceptance.md) 第 88–109 行。测试名均为 `apps/server/tests/` 下实际存在的用例，未重新编号。

| ID | 场景简述 | 对应测试文件 · 用例名 | 状态 | 证据/断言要点 |
| --- | --- | --- | --- | --- |
| G01 | 导入 40 段业务说明，无逐句确认卡 | retrieval-source-profile.test.ts · "G01: importing a business doc profiles it…asks zero per-sentence confirmations"；import-quality-isolation.test.ts · "G01 ordinary import does not create quality annotation work" | pass | 导入即生成 source-profile 且可关键词检索；普通 capture 零 quality dataset/sample/card |
| G02 | 保留父上下文，区分现状与规划 | retrieval-source-profile.test.ts · "G02: keeps parent context for anaphora and separates present-state from planning discourse" | pass | 回指「上述三种」保留父句；「当前…未来可能…」不统一标 verified fact |
| G03 | 代码/TODO/SQL 示例当示例非指令 | retrieval-source-profile.test.ts · "G03: code, SQL examples and TODOs are parsed as code examples, not owner instructions" | pass | 符号/commit 保留；不当成 owner 交办或执行命令 |
| G04 | 逐句 actor/time 保留 | batch2-fixes.test.ts · "G04 keeps each speaker's actor/time on its own part (top-level actorId null)" | pass | per-part provenance，不拍平为 actor=null |
| G05 | 两人同说保留两份 | batch2-fixes.test.ts · "G05 keeps both speakers when two actors say the same thing" | pass | 去重键 content_digest::actorId，两份参与者记录都保留 |
| G06 | 绑定 owner 的 ou_* 自动 apply | batch2-fixes.test.ts · "G06 bound owner's ou_* message maps to canonical owner and auto-applies" | pass | canonical principal 比较，不反复要求认领 |
| G07 | 非 owner 群消息不自动建 owner task | batch2-fixes.test.ts · "G07 a non-owner group member's task clue is NOT treated as owner's own task" | pass | 留为他人活动线索，不自动建 owner Task |
| G08 | owner 明确交办时经 MemoryService 建任务；咨询类不建任务；多轮回指 | assistant-runtime.test.ts · "G08: owner-verified task is created through MemoryService"、"governance: consultative query does not create task"、"governance: group-member material cannot be turned into an owner task"、"G08: two-turn anaphora — Turn1 consults, Turn2 reuses Turn1 evidence for task"、"G08 negative: Turn1 has no fragments, Turn2 cites nonexistent fragment -> rejected, zero writes" | **pass** | `detectTaskIntent()`（21 祈使 + 11 咨询模式）；直接交办 → capture 消息为真实 source 证据 → `MemoryService.evaluate()` → auto_apply receipt；咨询类零写入；群成员材料 → `retain_as_source`；**多轮回指（生产 call site）**：`governCreateTask` 调 `priorWorkingContext(conversation)` 取最近 done turn 的 selectedEvidence，合并到模型输入 evidence（runtime.ts:508）；Turn1 "找下接口说明" → citations 存入 working context，Turn2 "按这个整理下一步" 模型输入断言含 Turn1 fragment，receipt evidence_refs 可查回；Turn1 空证据时 Turn2 拒绝（no_prior_evidence），`tasks.length === 0`。 |
| G09 | 群内不泄漏私密证据 | assistant-runtime.test.ts · "G09: group conversations deny evidence by default when no policy is injected"、"G09: injected policy hides private evidence in group; p2p history does not leak" | pass | 群会话无 policy 时默认 deny-by-default；注入 policy 隐藏私密证据；p2p 历史不向群泄漏 |
| G10 | 无关材料 defer 不建 decision | attention-gate.test.ts · "G10: off-task material with missing time/scope is deferred, retrievable, never a decision card" | pass | ignore_noise/defer_until_use 态，不创建 decision card |
| G11 | 冲突→一个有背景的问题 | attention-gate.test.ts · "G11: a conflict that overwrites existing knowledge becomes one contextual decision, not a JSON blob" | pass | awaiting_decision 态，decision 带背景/证据/选择 |
| G12 | 重复/矛盾不新增 active | attention-gate.test.ts · "G12a: same statement links existing memory"、"G12b: opposite claims keep both as dispute"；retrieval-source-profile.test.ts · "G12: recalling an already-applied memory by keyword" | pass | duplicate/equivalent linked；conflict_recorded + knowledge_disputes；召回已有对象 |
| G13 | 原件更新触发 refresh 记录影响 | attention-gate.test.ts · "G13: a source revision update records the affected memories and they stop being active evidence" | pass | refresh_records(status=needs_review)，受影响记忆停用为 active evidence |
| G14 | agent original 入队、derived 不入队 | batch2-fixes.test.ts · "G14 original agent session enters extract_claims; derived does not" | pass | queueCaptureJob 只跳过 derived，不跳过 agent original |
| G15 | 图片/富文本群消息进入模型 | lark-rich-parts.test.ts · "post message parses title + paragraph text parts"、"image message downloads via fake transport and creates image part with asset"、"reply message sets replyTo/quoted provenance on all parts" | **pass（fake transport 验证）** | `realtime.ts` `buildCaptureParts()` 解析 post 富文本为标题 + 段落 text parts（text/a/at/img 展开）；image 消息经 `media.downloadImage(messageKey)` 下载字节存为 asset，创建 image part 带 mimeType/data/asset_ref；reply 消息填 `provenance.replyTo` + `quoted:true` + actorBindingVersion。均通过 fake transport 确定性验证，未跑真实飞书网络。 |
| G16 | 用户纠正后后续答案体现限定 scope | assistant-runtime.test.ts · "H-G16: correction in same scope reaches model; different scope does not leak"；proposal-policy.test.ts · A-F01/A-F03 | **pass** | `AssistantRuntime.turn` 从 `FeedbackService.recall(conversation.id)` 读取当前 scope 的 confirmed 纠正，作为 `trustedContext` 注入模型 prompt；同 scope 注入、跨 scope 不串。学习 pipeline 的 `confirmed_corrections` 注入（A-F01/A-F03）保持不变。 |
| G17 | 一次计划/变更影响多对象按总影响策略门禁 | learning-pipeline.test.ts · "G17 batch: 12 independent creates exceed impact gate, all deferred, zero applied"、"G17 batch: 12 same-entity creates fold to impact=1, one applied"；attention-gate.test.ts · "G17: evaluateBatch unions affected entities and gates the whole ChangeSet" | **pass** | `evaluateBatch()` 生产化：去重累计 impact = `affectedMemoryIds` 并集 ∪ `affectedEntities`（确定性键 `claim:ws:project:normalizedStmt`）；门禁先算后用，超 `maxAutoApply=10` 时全部 park 为 `awaiting_decision`（`batchDeferred=true`），0 receipt、0 active memory，建一张合并 AttentionCase（dedupeKey=`attention-batch:<ws>:<sorted-digests>`）。`pipeline.ts verify()` 已改调 `evaluateBatch(整份 entries)` 替代逐提案 `evaluate()`。12 条独立 create impact=12 全部门禁阻断；12 条同实体 impact=1 自动 apply。 |
| G18 | 停止后未发卡不发送 | annotation-cancel-delivery.test.ts · "cancel sweeps the queued intent in the same transaction; sender sends nothing"、"keeps delivered history and does not recall an in-flight send"、"sender suppresses a card even if a retry intent appears after cancellation" | pass | cancel 事务撤销 pending/retry_wait intent；已投递历史保留；在途不撤回 |
| G19 | 评测指标不把子串当支持满分 | quality-evaluation.test.ts · 9 项：reverse statement / empty answer null denominator / faithful paraphrase / dropped restrictive condition / dated quote time mismatch / negation flip / changed numeric bound / null rates / unnecessary interruption | pass | 六维 evidenceSupport 规则基线；空分母输出 null；反例不算支持成功 |
| G20 | 模型暂不可用/重启时降级不丢数据 | assistant-runtime.test.ts · "degrades honestly"、"ModelUnavailableError marks turn pending for retry"、"cancellation interrupts in-flight turn"、"G20: model unavailable → retrieval still works → recover re-executes pending turn"、"cancel fence: late resolve with create_task is blocked"、"recoverUnfinishedTurns — already-committed turn is not redone"；app.test.ts · "HTTP cancel e2e"、"HTTP retry pending turn"；lark-delivery-recovery.test.ts · 5 项投递恢复 | **pass（进程级重启为模拟）** | 模型异常/`ModelUnavailableError` → turn **pending**（`router.markPending`，非 failed）+ 诚实错误、零假 citation，可后续重试；取消经 TurnCancelledError fence + withTimeout（hung model 不挂死）；**持久恢复（生产 call site）**：app.ts 启动时 `await assistant.recoverUnfinishedTurns()`（runtime.ts:347）；`hasCommittedReceipt(turn)` 查真实 `application_receipts` 表（`proposal_id LIKE 'assistant-task:<eventId>:%'`），已 commit 的标 complete 不重做、未 commit 的重新执行；**公开重试入口**：`retryTurn(turnId)` + HTTP `POST /:turnId/retry`（app.ts:583），测试用 fastify inject 不手工改 SQL；投递持久化 enqueue-before-finish/并发幂等/per-turn uuid/重试退避。进程级真实 kill+restart 未测（同 DB 新 runtime 实例模拟）。 |

**统计：20 项 pass，0 项 partial。** G15 为 fake transport 验证（未跑真实飞书网络）；G20 的进程级真实重启为同 DB 新 runtime 实例模拟，非真实 kill+restart。

## 已知限制与环境问题（2026-09-29 复测）

- **osdk 验证**：`osdk deps --frozen` exit 0；`osdk run check` 连续 2 轮 exit 0（typecheck [tsc + vue-tsc] + 全量 vitest **47 文件 / 306 用例** + tsc/vite build，2026-09-29）。本轮首次 check 的 A-R07 timeout 已由 af77ca6 复现根因并回归稳定（详见「当前状态·测试」）。信任门已由 MainAgent 执行 `osdk --yes trust` 解决。
- **ACP 子进程清理已根治**：`agents.ts` 的 `acp()` 在 finally 中 `stop(child)` 后 `await Promise.race([child close, 5s timeout])`，Windows cwd 句柄释放后再返回；测试 cleanup 为单次 `rmSync`，不吞错不重试。连续 3 次 agents(6/6) + role-runtime(8/8) 全过。
- **refresh_dependents 重核验未实现（按设计 blocked）**：`learning/pipeline.ts` 该 job 只调 `recordSourceRefresh` 记录受影响记忆为 `needs_review`，随后**主动抛 `JobExecutionError("NOT_IMPLEMENTED")`** 失败——不谎报已完成重核验。完整 extractor+verifier 重跑 consolidation job 仍待实现。
- **Docker 未安装**：实测 `docker --version` 报「无法识别」，`osdk container doctor --json` 报 docker/containerd 均 `not-installed`。WeKnora/Hindsight 的 Docker 路径本机不可用。
- **无 traecli → 真实 ACP/飞书未端到端**：代码已接 AcpAssistantModel 真实 ACP adapter（含 fixture 解析/超时/取消测试），但本机无 traecli，真实 ACP 主助手对话与真实飞书 WebSocket 收发均未跑 live，仍为注入/fixture adapter 测试。
- **G20 进程级真实重启未测**：pending turn 持久恢复用同 DB 新 runtime 实例模拟（recoverUnfinishedTurns + committed receipt fence），未做真实进程 kill+restart；HTTP cancel e2e 已用 fastify inject 覆盖。
- **repo-review / Code Wiki（隔离纵向切片）**：`osdk run dev:review` 启动隔离 API(5180)+Vite(5181)；上次验证时库为 163 sources / 11940 fragments、代码图投影 190 文件（ts-ast+vue-sfc+regex）、23 条 curated seed → 90 confirmed / 3 candidate / 30 missing 边（实时值以 `GET /api/review/code/current-snapshot` 与 `/api/review/associations` 为准）。**不是完整交付**：跨文件 calls 不解析（单文件名称级 calls 标 candidate）；跨 revision fragment 身份续接未实现；词相似未登记片段不自动 confirmed；检索为关键词召回无 embedding；`refreshDependents` 重核验仍按设计 blocked。dev 生命周期由 `apps/server/tests/review-dev.test.ts` **5 个集成用例**（双端端口占用检测、taskkill /T /F 进程树清理、API 失败透传、Windows 强杀契约、3 轮 boot/kill 稳定性）+ `scripts/code-wiki-viewport.ts` 浏览器验收（5 层 trail / 390 视口 / 焦点归还 / 无裸 id / OmMarkdown XSS 过滤）覆盖。证据分级：curated seed 经 agent 引用审核但**非模型 live**；协议/fixture 测试不等于外部 CLI 可用；真实模型生成与真实 ACP/飞书端到端未测。
- **依赖管理已切换到 pnpm**：历史上为 Batch 2 临时改写的 package-lock npmmirror、`package-lock.json.bak-batch2` 备份、osdk.toml 的 default_agents/npm.auto=true 改动均已随切换清理；根 `package.json` 不再含 npm 风格 `workspaces` 字段，工作区成员由 `pnpm-workspace.yaml`（`apps/*`、`packages/*`）声明，`apps/web` 经 `workspace:*` 链接 `@omem/ui`，锁文件为 `pnpm-lock.yaml`。`osdk deps --frozen` 走 `pnpm install --frozen-lockfile`。

---

## 历史实现记录（Batch 2）

> **以下为历史记录，当前产品行为以本页「当前状态」与 assistant-v3 为准。** Batch 2 是 v3 之前的实现包；其中部分能力已被 v3 重构替代（如 quality dataset 守卫、provenance、检索端口），保留此处仅用于追溯，不作为当前已交付清单。

### Batch 2 进度概览

- **B2-01**：Proposal/ProposalBatch/AssessmentBatch/CorrectionProposal v1 严格合同、capture provenance、任务 CAS、SQLite v1→v2 事务迁移与回滚校验。A-M01～A-M04 用真实 SQLite 验证。
- **B2-02**：schema v3 job attempt/control/input batch；租约/心跳/fencing/有界重试/取消补偿；owner-only hook spool；chat/screen 静默窗与去重。A-J01～07、A-I01～03。
- **B2-03**：extractor/verifier/planner/feedback-curator role bundles、inline/native Skill、ContextManifest、隔离 workspace、结构化输出/修复上限、工具 allowlist、图片能力门。A-R01～08。历史曾用 `OMEM_LIVE_MODEL=gpt-5.4` 跑过一次真实 extractor+verifier smoke。
- **B2-04**：Proposal/assessment 持久化、Unicode quote/图片核验、策略（owner/转发/歧义/冲突/影响）、自动应用、CAS、来源刷新依赖失效。A-K01～10、A-F01～03。历史一次真实 capture→extractor→verifier→policy→应用闭环 smoke。
- **B2-05**：官方 Node SDK `registerApp()`、状态机、二维码/授权 URL、AES-256-GCM secret store、capability probe、pairing、botmux existing-app 复用。A-L01～07。
- **B2-06**：schema v8 飞书 target/lease/event inbox/delivery attempt/card 持久化；WebSocket adapter 单 lease owner；Card 2.0 intent 与 callback 严格校验。A-L08～14、A-N01～05。历史一次真实应用凭据/WebSocket/pairing/通知/callback live。
- **B2-07**：Vue 学习流程 UI（待判断页 diff/证据/三动作、通知详情、飞书绑定页）。A-U01～05 由 Chromium+Fastify+SQLite 浏览器检查覆盖。
- **B2-08**：持久两阶段 worker（extract_claims/verify_proposals 独立 job，lease/fencing，优雅停机重试）；生产 Lark host 装配；A-N04 短窗合并/定时汇总；schema v10 质量数据集/标注卡/冻结 manifest。历史一次真实持久 worker smoke。

### 已实现的基础能力（跨 Batch，仍有效）

- Node/TypeScript + Fastify HTTP API；SQLite + 图片对象目录；Vue 3 阅读台。
- CaptureEnvelope 文本/图片/链接 + 上下文；图片类型/预算校验。
- 文件、固定 Git commit、lark-cli 文档导入；主动 HTTP/CLI；opt-in TraeX hook 转发。
- 版本化材料与不可变片段；引用/反向引用；环跳回；恢复为新版本且拒绝覆盖后续修改。
- 持久变更/通知同事务；待办状态、关联证据、UTC 到期去重。
- 官方 ACP SDK initialize/new/config/prompt/update/cancel/close；动态模型/effort、固定证据、超时、输出预算、进程清理；过滤 thought chunks。
- Codex/TraeX/Claude CLI adapter 与显式 argv（不拼 shell）；CLI 图像不支持时明确报错。

### 明确的实现取舍

- 统一 TypeScript + SQLite 个人单用户实现；**不具备**多租户 ACL、分布式事务、pgvector。team scope 仅保留在架构设想中。
- 所有原件/回答可追溯，不等于每个 Claim 已由证据验证器证实；正式 supported_by 自动评估未实现。
- 跨 revision 语义 Fragment 身份续接、精确选区 selector、原生飞书 block 映射、原文刷新依赖自动重核验暂未实现。
