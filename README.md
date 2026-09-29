# omem

个人工作记忆与助理基础系统。Vue 阅读台 + 固定版本的多模态证据 + Agent CLI/ACP 问答 + 需求待办与通知。当前交付包含第一批可运行基础链路，以及 Batch 2 的版本化合同/SQLite 迁移、持久任务、输入缓冲、受治理记忆应用、飞书连接/可靠投递核心与 Vue 产品流程；自动 worker 编排和屏幕采集器仍按后续里程碑推进。

## 启动

需要 osdk 和可登录的 Agent CLI；omem 当前运行不需要 Docker、Python、Redis 或本地大语言模型。

```bash
osdk skills sync
osdk trust --yes
osdk install
osdk deps --frozen
osdk run build
osdk run start
```

浏览器打开 `http://127.0.0.1:4317`。默认是空工作区，在“输入材料”开始录入。开发模式 `osdk run dev` 同时启动 API 与 Vue（默认 4317 / 5173）。默认端口被占用时选择空闲端口，并将实际 API 地址传给前端代理；请打开终端打印的 web URL。可用 `OMEM_PORT` / `OMEM_WEB_PORT` 指定端口（显式指定且被占用会报错）。根 `tsconfig.json` 为编辑器提供与服务端检查一致的 Node 类型配置。

## Code Wiki（通用代码知识纵向切片）

Code Wiki **不是独立产品**，也不是第二套知识库。它是同一套 omem 证据模型在代码域上的**确定性 typed projection**：底层仍是 Capture → Source/Revision/Fragment → Relation/Retrieval 链，代码侧的 `CodeSnapshot / CodeFile / CodeSymbol / CodeEdge / CodeUnderstanding` 只是叠加在不可变 fragment 之上、可随时重建的投影视图（代码正文只在快照绑定处留一份不可变 `content_text`，不另存一份真相）。所谓 repo-review 只是这套投影在本机的**隔离 dev 配置与视图**：独立 SQLite、四类材料同步、独立端口、不启动业务 worker。

```bash
osdk run dev:review
```

启动后 API 在 `http://127.0.0.1:5180`，Vue dev web 在 `http://127.0.0.1:5181`（默认端口；已被占用时选择空闲端口，终端打印实际 URL）。`REVIEW_PORT` / `REVIEW_WEB_PORT` 可显式指定端口，此时冲突严格报错。首次启动自动全量同步仓库材料；之后在 web「同步」页点「立即同步」做增量更新（幂等，重复运行不重复入库）。dev 脚本用直接 node 子进程管理 API 与 Vite，退出时 `taskkill /T /F` 清理整棵进程树，API 非 0 退出透传为 dev-review 退出码。实测当前同步库约 160 个 source / 1.2 万个 fragment，代码图投影 190 个文件（`ts-ast@1+vue-sfc@1+regex@1` 解析器）。

**结构图是确定性的，不需要模型**：TypeScript Compiler AST（单文件、不建 Program）+ `@vue/compiler-sfc` 解析 `.vue` + 保守正则补 Fastify 路由与 `it/test` 用例，产出 imports/exports/defines/routes/tests/组件/range 边；零新 pnpm 依赖、离线、可重跑。评审意图边（`implements/requires/decided_by/researched_by/tested_by/candidate_for`）仍只来自手维护的 `docs/repo-review/associations.json`。派生模块说明是 committed 的 curated seed（`.repo-review/knowledge/understandings/*.seed.json`），同步时把 seed 里的 path+qualifiedName 定位到 head 图、盖 digest、过严格 `CodeUnderstanding.v1` 交叉引用校验后投影为 current 行——**没有任何生产模型被调用**，seed 行恒为 `seed=true / verified_by_agent=false`。

**模型是可选、显式 opt-in 的**：review 模式只读一个可选环境变量 `REVIEW_CODE_MODEL_CONFIG`（指向一个 JSON 配置文件），从不读取个人 omem 的 Agent profile、keychain 或宿主配置。变量未设时 `model-status.available=false`，只读图 + curated seed 照常浏览，`POST /api/review/code/understandings/generate` 返回 503 `model_unavailable`，UI 诚实标注「结构边可用、AI 理解暂缺」，绝不生成假摘要。真实模型端到端生成在本机**尚未 live 验证**（见 status.md 的证据分级）。

**数据目录布局**：
- **运行库 `.repo-review/runtime/`（gitignored，唯一写入处）**：含 `omem.sqlite` WAL、`last-sync.*`、`migrated-v2.flag`、`assets/`。首启若 runtime 库不存在，用 readOnly 连接对 tracked 种子做一次一致 SQLite 备份（含 WAL）投影到 runtime，之后只写 runtime。
- **冻结种子 `.repo-review/data/omem.sqlite*` + 根级 `last-sync.*` / `browser.*.log` / `migrated-v2.flag`（tracked）**：历史快照，首启后运行服务不再写这里；不要 restore/reset/delete。
- **curated 知识 `.repo-review/knowledge/**`（tracked）**：6 个模块 seed + manifest + 一份 agent 引用核验记录（只核对 locator/原文引用，不是模型运行、不是产品验收）。
- 仅扫描本仓库文本文件（源码、docs、AGENTS.md），不读 `omem.local.json`、`.env*`、node_modules、dist、二进制；不启动 Lark WebSocket、业务 worker、外部通知，不访问网络。

**当前边界（不是完整交付）**：
- **跨文件 calls 未解析**：calls 边是单文件 AST 内、名称级匹配，标 `candidate`；跨文件调用边不产生，跨文件类型感知（SCIP/tree-sitter）按设计后续 PoC。
- **跨 revision 符号/fragment 身份续接未实现**：关系锚在 head snapshot 的 fragment 上；代码改动产生新 snapshot 后，旧关系仍指向旧 fragment id（标「历史版本」），需重新 `POST /api/review/code/sync` 让 symbol/anchor 在新 head 上重新定位。
- 词相似但未在 `associations.json` 登记的片段**永远不会**自动变成 confirmed；未解析锚点记 `missing` 并可见，不静默丢弃。
- 检索是 SQLite 关键词召回（CJK 2-gram），无 embedding/语义检索；`refreshDependents` 下游重核验按设计 blocked。
- Web 下钻交互与个人助理 EvidenceReader 共用同一套帧栈合同（`packages/ui` 的 trail/OmDialog 系组件），人读 label，内部 id 不渲染；键盘 Esc 退层、关闭归还焦点、390px 无横向溢出、Markdown 经 DOMPurify 过滤（脚本验收见 status.md）。

工具版本由 [osdk.toml](osdk.toml)、[osdk.lock](osdk.lock) 固定；应用包由 pnpm 工作区管理，锁文件为 [pnpm-lock.yaml](pnpm-lock.yaml)（`pnpm-workspace.yaml` 声明 `apps/*`、`packages/*` 成员）。`osdk deps --frozen` 负责调用 pnpm 以 `--frozen-lockfile` 安装应用依赖；本项目声明的构建脚本（esbuild、protobufjs）由 pnpm 按需从源码构建。首次安装如遇包构建脚本门禁，请依本机提示检查并批准对应包，不关闭全局门禁。

## Agent 配置

复制 `config/omem.example.json` 为忽略提交的 `omem.local.json`，按本机命令调整。运行时读取 `OMEM_CONFIG` 指向的文件（默认 omem.local.json，不存在则使用示例）。`profiles` 可配置 transport、command、args、默认 model/effort、instructions、maxContextChars、timeoutMs。文件配置在服务启动时读取，修改后重启；界面中的模型/effort 作用于下一次问题。

- TraeX：`traecli acp serve`，复用宿主登录，动态发现模型/effort，支持图片。
- Codex：`codex exec --json`，默认 read-only，模型/effort 用参数传递。
- Claude Code：`claude --print --output-format stream-json`，禁用工具，模型/effort 用参数传递。
- 其他 ACP agent：配置 `transport=acp` 和进程命令；按其声明的能力使用。

`osdk exec --tool node --tool pnpm -- pnpm run cli -- probe traex` 只握手和创建会话，不执行模型问题。界面“能力与连接”也能探测。默认不硬编码模型名称；更改模型后服务端使用新的 configOptions 再校验 effort。不支持的选项明确报错。

CLI-only 模式暂不支持附图，附图问题需选择支持 image 的 ACP；不会静默丢图。每次问答使用新会话与明确传入的固定证据，尚未做跨轮 ACP session resume。问题、答案保存为材料，引用记录标明“提供给模型的依据”，不冒充已经通过事实支持度验证。

Batch 2 角色运行包位于 `packages/agent-runtime/roles`。extractor、verifier、planner、feedback-curator 都有固定 manifest、prompt、输出 schema 和最小 Skill；当前使用 inline skill 模式，运行时校验全部资产 digest、上下文/输出预算和结构化结果。`osdk run live-role` 会用已登录 TraeX 对虚构小样本执行一次真实提炼和独立复核，可用 `OMEM_LIVE_MODEL` 显式选择本次验证模型；产品和脚本不禁用 Astra。报告写到忽略提交的 `.omem/verification/live-role-smoke.json`。这条命令会真实消耗模型调用。

Agent 进程在 `.omem/agent-workspace` 工作。内置配置采用只读/无工具策略，ACP 权限请求转成通知且拒绝自动执行；这不等于给任意第三方 Agent 提供 OS 安全沙箱。自定义运行器需保留自己的隔离/权限约束。

## 材料与接入

```bash
# 显式本地文件 / 固定 commit 文件 / 飞书文档
osdk exec --tool node --tool pnpm -- pnpm run cli -- file ./notes.txt
osdk exec --tool node --tool pnpm -- pnpm run cli -- git /path/to/repo README.md HEAD
osdk exec --tool node --tool pnpm -- pnpm run cli -- lark 'https://tenant.larkoffice.com/docx/token'
# 主动输入统一 CaptureEnvelope JSON；也可从 stdin 读
osdk exec --tool node --tool pnpm -- pnpm run cli -- capture ./capture.json
```

飞书读取使用 `lark-cli docs +fetch --as user`，需要运行服务所在用户已经授权。仅调用用户提供的文档，不自动全空间抓取。HTTP 的文件/Git 导入受 `captureRoots` 限制；CLI 的显式文件参数由发起 CLI 的本地用户提供，范围限于当前目录（文件）或给定仓库（Git）。

[输入协议与 hooks](docs/implementation/inputs.md) 包含多模态 JSON、屏幕/群聊上下文和 opt-in TraeX hook 模板。当前不会自动安装全局 hook 或启动屏幕监控。选择启用 `hook-forward` 后，事件会先写入 owner-only 本地 spool，服务离线时保留，拿到匹配 capture receipt 后才删除；`OMEM_HOOK_SPOOL` 可覆盖缓冲目录。

## 数据与服务部署

数据位于 `.omem/`，可用 `OMEM_DATA_DIR` 指定。SQLite 保存版本、片段、引用、待办、变更、通知和持久 job；图片为 hash 对象文件。数据库按递增 migration 升级，拒绝写入高于当前程序支持版本的库。相同来源标识+相同内容重试不重复录入；不同内容追加版本，旧引用仍可访问。原始材料与首个提炼 job 同事务提交，job 支持租约、fencing token、分类重试、取消和 attempt 指纹；B2-03 的真实提炼 handler 尚未接入，因此服务当前不会假装处理这些排队任务。恢复会生成新版本；有后续变更时返回 REBASE_REQUIRED。

单用户部署默认仅监听 loopback。公网/局域网监听需设置 `OMEM_HOST` 和强 `OMEM_TOKEN`，所有 `/api/*` 都校验 Bearer；浏览器令牌仅放 sessionStorage。部署到服务器建议用 TLS 反向代理/SSH 隧道。当前不是多租户服务，不把一个 shared token 当团队权限系统。

`GET /api/jobs` 与 `GET /api/jobs/:id` 可查看公开状态和 attempt 指纹；取消、重试分别使用 `POST /api/jobs/:id/cancel|retry`，请求必须带 `expectedGeneration` 和幂等 `requestId`。已成功应用的 job 不能靠取消抹掉效果，只返回需要补偿恢复。配置 `learning.enabled=true` 后，服务启动一个受 lease/fencing 保护的单消费者：`extract_claims` 使用 extractor Agent，随后持久化 `verify_proposals` 子任务并用全新 verifier 会话复核，最终由确定性策略决定应用、待判断或拒绝。Agent 没有领域写权限；只有 MemoryService 能提交事实、receipt、change、notification 和 outbox。优雅停机会把被中断 attempt 留为可重试，而不是误记为用户取消。

`POST /api/proposals/evaluate` 接受严格 Proposal 与可信 verifier assessment，服务端再执行固定引文/图片、source head/epoch、owner/转发、冲突、影响范围和 CAS 门；安全的小范围 task/claim/episode 可原子写入 change、通知、delivery intent 和 receipt，其余进入可审计 decision 或拒绝。`POST /api/decisions/:id` 会在批准时重新检查来源版本。反馈通过 `POST /api/feedback` 去重，只有已验证、原始、同 scope 且有现存证据的纠正进入后续召回；ACL/预算/自动审批建议只记 shadow。自动 worker 和 HTTP evaluate 最终都进入同一个 MemoryService 边界，不存在模型直接写库的旁路。

通知默认每次变更即时显示在应用内并写入通知中心；`notifications.mode=digest` 只关闭逐条浮动提示，仍保留所有记录。外部飞书通知由 `notifications.external.mode` 独立选择 `instant`、`window` 或 `scheduled`：短窗与定时模式会在发送前合并同一 binding/target 的普通变更，并通过 `delivery_intent_changes` 保留每条 change 映射；交互 decision 卡始终即时发送。`windowMs` 控制短窗，`scheduleLocalTime` 与 IANA `timezone` 控制定时摘要。待办每 30 秒检查到期，重启后补查且去重。sender 使用官方 SDK、同 UUID 有界重试和 `unknown` 状态。

Vue 新增“学习流程”“待判断”“通知详情”和“飞书机器人”：任务状态、attempt、提案策略、具体 diff、判断 receipt、应用 receipt、证据和投递错误都来自持久 API；服务/模型/通知失败时继续显示已保存原件与已生效事实，不把排队或失败显示成成功。飞书设置支持创建新应用、为指定 App ID 打开增量授权、从 botmux 或手工凭据导入；授权页同时给出本地生成的二维码与可直接打开的完整链接，后续严格经过 checking 和同应用 owner pairing。App Secret 只进入后端 secret store，不返回页面。

飞书接入已有基于官方 `@larksuiteoapi/node-sdk@1.74.0` 的 `registerApp()` adapter、扫码状态机、AES-256-GCM secret store、公开 OpenAPI capability probe、一次性 pairing/binding、官方 WebSocket adapter、单消费者 lease、事件 inbox、入群自动监控/移群停用、通知 sender 和耐竞态的 Card 2.0 决策队列。可手工导入现有应用，也可从本机 botmux 配置按 app_id 选择后加密转存，不修改 botmux 配置。默认注册 profile 还参考 botmux 权限清单为未来文档/云盘/知识库、表格/幻灯片、日历、任务、会议和 CardKit 能力预留 app/user scopes，但明确排除批量/系统消息、群成员与群主操作、文档权限转移和日历 ACL 管理。`lark.enabled=true` 且提供 `OMEM_SECRET_KEY` 后，主服务会装配 onboarding、WebSocket connection supervisor、delivery worker 和 card worker；默认仍关闭，避免无意连接外部系统。scope 与 callback 由公开 OpenAPI 回读，事件订阅由实际 WebSocket 事件到达后写入 capability profile。用户授权的 live 结果见 Batch 2 验证记录。

`OMEM_SECRET_KEY` 不是飞书 App Secret，而是 omem 用来加密飞书 App Secret 的本地主密钥。它必须是独立保存的 32 字节 hex/base64 值，不能写入 `omem.local.json` 或 Git。可用 `openssl rand -base64 32` 生成一次，再放入密码管理器或部署平台 secret；服务重启必须继续使用同一个值。丢失或轮换后，已有 `.omem/secrets/*.json` 将无法解密，需要重新授权或导入对应应用。[`.env.example`](.env.example) 只保留空变量和说明，不包含真实 key。

`lark.botmuxConfig` 可选；未配置时只读 `~/.botmux/bots.json` 来列出可复用 App。启用后仍需在“飞书机器人”页选择/授权应用并完成同应用私聊 pairing，不会因为配置开关而自动读取任意群。App ID + 链接授权可以让官方流程把 App Secret 返回给后端，但 App ID 本身不能用于换取 tenant token 或建立 WebSocket；收到的 App Secret 仍需由 `OMEM_SECRET_KEY` 加密落盘。

详细运行环境、Docker/osdk 实测结果与后续引擎依赖见 [环境说明](docs/implementation/environment.md)。

## 设计与验证

- [design.md](design.md)：Vue 设计系统、token、移动端和无障碍要求。
- [.agents/skills/omem-design/SKILL.md](.agents/skills/omem-design/SKILL.md)：后续界面任务的项目 skill。
- [packages/ui](packages/ui)：8 个可复用 Vue 组件与主题 token。
- [当前实施进度](docs/implementation/status.md)：已实现、已验证及剩余工作。
- [原始系统设计](docs/design.md)：总体架构，已注明本轮调整。

```bash
osdk run check
# 首次没有浏览器时：osdk exec --tool node --tool pnpm -- pnpm exec playwright install chromium
osdk run browser
# 真实 Agent 测试（会使用已登录账号调用一次大模型）
osdk run live-acp
# 真实 extractor + verifier（会额外使用两次模型调用）
osdk run live-role
# 真实 extractor → verifier → 本地策略/原子应用（隔离临时库）
osdk run live-learning
# 真实持久 worker：extractor → 独立 verifier → policy/apply
# 必须显式选本次验证模型；示例不改变产品支持范围
OMEM_LIVE_MODEL=gpt-5.4 OMEM_LIVE_EFFORT=medium osdk run live-pipeline
# 从授权文档建立本地 dev 集，并通过已绑定的 omem 应用逐条确认
OMEM_DATA_DIR=.omem/live-lark \
OMEM_LARK_KEY_FILE=/path/to/owner-only-key \
OMEM_LARK_APP_ID=cli_xxx \
OMEM_QUALITY_SOURCE='https://tenant.larkoffice.com/wiki/token' \
osdk run quality-lark-annotate
# 冻结数据集后运行模型预测与离线指标计算
OMEM_QUALITY_DATASET_ID=your-dataset-id \
OMEM_LIVE_MODEL=gpt-5.4 osdk run quality-run
OMEM_QUALITY_DATASET_ID=your-dataset-id \
OMEM_QUALITY_PREDICTIONS=.omem/quality/predictions.json osdk run quality-evaluate
```

质量数据集、原文、人工标签、预测和逐项失败明细只保存在 `OMEM_DATA_DIR` 对应的 SQLite 与 `.omem/quality/`，不提交 Git。飞书标注由项目自己的应用发送一张可持续更新的 Card：owner 每次点击“标注正确 / 应不提炼 / 需要修改 / 稍后处理”后，服务校验 app、owner、chat、message、nonce、label digest 与有效期，再原子记录结果并在同一张卡展示下一条。只有全部人工确认后才能冻结；runner 在冻结 manifest 上计算自动应用精度、证据支持精度、明确样本覆盖率、歧义/转述误建数和 p50/p95。

本仓库不提交真实会话、原件、token、模型权重和运行数据库。`docs/prototype` 保留此前经确认的离线视觉原型，它的演示数据和 React 构建不参与新 Vue 产品运行。
