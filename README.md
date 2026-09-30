# omem

个人工作记忆与助理系统。统一接收文本、图片、链接与上下文，保留不可变证据，通过 Agent CLI/ACP 分析、独立复核和组织知识正文。个人问答、受治理记忆、待办与通知沿用同一证据链；本仓库的 Wiki 是代码材料的一种应用。外部屏幕采集器等接入仍需单独配置。

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

## 知识整理与本仓库 Wiki

知识处理复用 Capture → Source / Revision / Fragment、现有持久 jobs 和 RoleRuntimeGateway。代码、文档、对话、图像使用专门角色；分析后由独立角色复核，再由 AI 组织模块、架构、背景、需求、进展与概览章节。正文引用直接贴近论断，带名称、理由、固定位置，可逐层进入子知识、原文与代码。代码 AST 用于定位和明确的结构关系，语义说明与关系由模型分析和复核。

```bash
# 本仓库阅读视图：恢复已提交知识，不调用模型
osdk run dev:review
# 分析全部仓库材料，独立复核并生成章节；真实消耗模型调用
osdk run review:analyze
# 只处理一个文件或目录
osdk run review:generate -- --target=apps/server/src/retrieval/keyword.ts
# 重试未完成/过期项；正常运行会复用已完成知识与持久结果
osdk run review:analyze -- --retry
# 仅重建索引，不调用模型
osdk run review:build
```

默认 API / web 端口是 5180 / 5181；占用时选择空闲端口，打开终端打印的 web URL。`REVIEW_PORT` / `REVIEW_WEB_PORT` 可显式指定，冲突时会报错。review 是本仓库的隔离运行配置，使用独立 SQLite，不启动个人业务 worker。

实际模型配置是 [`config/review-code-model.json`](config/review-code-model.json)，环境变量 `REVIEW_CODE_MODEL_CONFIG` 可覆盖；修改 example 不影响运行。当前使用本机 ACP 已发现的 `gpt-5.6-sol` / `medium`。实际 review 预算为 192000 输入 / 24000 输出 / 16000 Agent 预留 tokens，角色 manifest 的默认预算为 96000 / 24000。按完整提示词 UTF-8 字节数 ÷ 3 估算，再加 25% 余量，并检查当前模型声明的上下文窗口；这是工程估算，不是实际计费数。`REVIEW_KNOWLEDGE_CONCURRENCY` 可设置 1–6 路并发，默认 3。

直接阅读随 Git 提交的 [Wiki 索引](.repo-review/wiki.md)。目录用途：

- `.repo-review/knowledge/articles/*.json` 与 `.md`：当前流程的知识正文、内联引用、原材料/子知识依赖及真实分析和复核记录。
- `.repo-review/knowledge/coverage.json`：逐文件处理结果与排除理由；失败、过期和待处理不会算作完成。
- `.repo-review/knowledge/user-notes.json`：用户在 review 界面明确保存的补充材料，用于后续核对。
- `.repo-review/knowledge/understandings/` 和 `generated/`：早期切片的人工说明与模型产物，保留溯源；不冒充新流程独立复核结果。
- `.repo-review/runtime/`：可重建数据库、任务、模型工作目录与暂存文件。默认从仓库材料及已提交知识恢复，不读取外层 `data/`。
- `.repo-review/data/` 与旧同步日志：旧修订和旧片段 ID 的历史档案。当前 Wiki 不依赖它；仅 `REVIEW_IMPORT_LEGACY=1` 导入。删除会失去只在其中保存的历史，本轮保留原资产。

个人服务的“知识整理”使用同一流程处理已进入 Capture 的材料。知识正文可引导助手召回，但返回的依据仍是原始 Fragment，继续经过会话可见性过滤。疑问保留为有依据的调查项，用户可以补充背景或加入待办；回答作为原始材料保存并触发重核对。派生解释与已应用事实保持区别，独立模型复核也不等于人工验收。

检索已使用 SQLite FTS5/BM25、中文短词保底以及原文/记忆/知识正文的 RRF 融合，命中派生内容后回查固定原文。跨文件调用的精确类型解析、embedding 检索、周期巡检及跨来源冲突的自动修订尚未完成；不会把这些能力写成已交付。流程、分项提交与验证记录见 [通用知识流程](docs/implementation/knowledge-pipeline.md)，早期问题见 [复审记录](docs/implementation/code-wiki-review-2026-09-29.md)。

工具版本由 [osdk.toml](osdk.toml)、[osdk.lock](osdk.lock) 固定；应用包由 pnpm 工作区管理，锁文件为 [pnpm-lock.yaml](pnpm-lock.yaml)（`pnpm-workspace.yaml` 声明 `apps/*`、`packages/*` 成员）。`osdk deps --frozen` 负责调用 pnpm 以 `--frozen-lockfile` 安装应用依赖；本项目声明的构建脚本（esbuild、protobufjs）由 pnpm 按需从源码构建。首次安装如遇包构建脚本门禁，请依本机提示检查并批准对应包，不关闭全局门禁。

## Agent 配置

复制 `config/omem.example.json` 为忽略提交的 `omem.local.json`，按本机命令调整。运行时读取 `OMEM_CONFIG` 指向的文件（默认 omem.local.json，不存在则使用示例）。`profiles` 可配置 transport、command、args、默认 model/effort、instructions、maxContextChars、timeoutMs。文件配置在服务启动时读取，修改后重启；界面中的模型/effort 作用于下一次问题。

- TraeX：`traex acp serve`，复用宿主登录，动态发现模型/effort，支持图片。
- Codex：`codex exec --json`，默认 read-only，模型/effort 用参数传递。
- Claude Code：`claude --print --output-format stream-json`，禁用工具，模型/effort 用参数传递。
- 其他 ACP agent：配置 `transport=acp` 和进程命令；按其声明的能力使用。

`osdk exec --tool node --tool pnpm -- pnpm run cli -- probe traex` 只握手和创建会话，不执行模型问题。界面“能力与连接”也能探测。默认不硬编码模型名称；更改模型后服务端使用新的 configOptions 再校验 effort。不支持的选项明确报错。

CLI-only 模式暂不支持附图，附图问题需选择支持 image 的 ACP；不会静默丢图。每次问答使用新会话与明确传入的固定证据，尚未做跨轮 ACP session resume。问题、答案保存为材料，引用记录标明“提供给模型的依据”，不冒充已经通过事实支持度验证。

Batch 2 角色运行包位于 `packages/agent-runtime/roles`。extractor、verifier、planner、feedback-curator 都有固定 manifest、prompt、输出 schema 和最小 Skill；当前使用 inline skill 模式，运行时校验全部资产 digest、上下文/输出预算和结构化结果。`osdk run live-role` 会用已登录 TraeX 对虚构小样本执行一次真实提炼和独立复核，可用 `OMEM_LIVE_MODEL` 显式选择本次验证模型；产品和脚本不禁用 Astra。报告写到忽略提交的 `.omem/verification/live-role-smoke.json`。这条命令会真实消耗模型调用。

Agent 进程在 `.omem/agent-workspace` 工作。内置配置采用只读/无工具策略，ACP 权限请求转成通知且拒绝自动执行；这不等于给任意第三方 Agent 提供 OS 安全沙箱。自定义运行器需保留自己的隔离/权限约束。

## 材料变更后的记忆更新

已知来源出现新版本时，旧记忆先停止作为有效依据，再复用现有提炼任务和独立复核任务。仍受新原文支持的结论更新同一个记忆 ID，旧原文和旧记忆版本继续保留；无法支持的保留 `needs_review`。`GET /api/memory-refreshes` 可查看影响范围、核验任务和真实应用结果。调度任务成功只表示已排队，只有实际修复所有受影响记忆后才记为 `applied`。

学习 worker 仍由 `learning.enabled` 控制。模型不可用或复核失败不会恢复旧事实。本轮没有新增全库定时巡检，也没有自动生成英语卡片。角色给模型的 JSON Schema 现在由宿主 Zod 合同生成；修改合同后运行 `osdk exec --tool node --tool pnpm -- pnpm exec tsx scripts/sync-role-schemas.ts` 同步。

## 日常使用

主助手现在可以先查询已有事项，再根据明确指令创建带时间的任务、改期、完成或重新打开。时间按用户配置的时区解析，保存原始时间表达；操作回复来自真实数据库回执。未明确时间时会询问，未成功写入不会显示“已安排”。目前提醒使用任务时间并在应用内触发；独立 reminder、重复安排、取消状态与外部到期投递尚未接通。

检索不足时，助手可提出最多三个同义词/跨语言查询，由宿主补搜一次，再根据原片段回答。补搜不增加模型写权限，也不把搜索词当事实。可用合成材料验证整条真实 ACP 流程：

```bash
OMEM_LIVE_MODEL=gpt-5.6-sol OMEM_LIVE_EFFORT=medium osdk exec --tool node --tool pnpm -- pnpm exec tsx scripts/live-assistant-smoke.ts
```

该脚本使用隔离临时数据库，验证中文问英文材料、创建带时间事项、改期、完成；报告在 `.omem/verification/live-assistant.json`，不发送外部消息。

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

数据位于 `.omem/`，可用 `OMEM_DATA_DIR` 指定。SQLite 保存版本、片段、引用、待办、变更、通知和持久 job；图片为 hash 对象文件。数据库按递增 migration 升级，拒绝写入高于当前程序支持版本的库。相同来源标识+相同内容重试不重复录入；不同内容追加版本，旧引用仍可访问。原始材料与首个提炼 job 同事务提交，job 支持租约、fencing token、分类重试、取消和 attempt 指纹；配置 `learning.enabled=true` 并提供可用 Agent 后会执行提炼与独立复核；关闭时任务保持排队，不冒充处理完成。恢复会生成新版本；有后续变更时返回 REBASE_REQUIRED。

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
