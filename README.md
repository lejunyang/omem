# omem

个人工作记忆与助理基础系统。Vue 阅读台 + 固定版本的多模态证据 + Agent CLI/ACP 问答 + 需求待办与通知。当前交付包含第一批可运行基础链路，以及 Batch 2 的版本化合同/SQLite 迁移、持久任务和输入缓冲基础；自动知识提炼、屏幕采集器、飞书群机器人和外部通知仍按后续里程碑推进。

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

浏览器打开 `http://127.0.0.1:4317`。默认是空工作区，在“输入材料”开始录入。开发模式 `osdk run dev` 同时启动 API 4317 和 Vue 5173。

工具版本由 [osdk.toml](osdk.toml)、[osdk.lock](osdk.lock) 固定，应用包由 package-lock.json 固定。`osdk deps` 负责调用 npm 安装应用依赖；本项目声明的安装脚本用于 esbuild 等构建依赖。首次构建如遇包安装脚本门禁，请依本机 npm 提示检查并批准对应包，不关闭全局门禁。

## Agent 配置

复制 `config/omem.example.json` 为忽略提交的 `omem.local.json`，按本机命令调整。运行时读取 `OMEM_CONFIG` 指向的文件（默认 omem.local.json，不存在则使用示例）。`profiles` 可配置 transport、command、args、默认 model/effort、instructions、maxContextChars、timeoutMs。文件配置在服务启动时读取，修改后重启；界面中的模型/effort 作用于下一次问题。

- TraeX：`traecli acp serve`，复用宿主登录，动态发现模型/effort，支持图片。
- Codex：`codex exec --json`，默认 read-only，模型/effort 用参数传递。
- Claude Code：`claude --print --output-format stream-json`，禁用工具，模型/effort 用参数传递。
- 其他 ACP agent：配置 `transport=acp` 和进程命令；按其声明的能力使用。

`osdk exec --tool node -- npm run cli -- probe traex` 只握手和创建会话，不执行模型问题。界面“能力与连接”也能探测。默认不硬编码模型名称；更改模型后服务端使用新的 configOptions 再校验 effort。不支持的选项明确报错。

CLI-only 模式暂不支持附图，附图问题需选择支持 image 的 ACP；不会静默丢图。每次问答使用新会话与明确传入的固定证据，尚未做跨轮 ACP session resume。问题、答案保存为材料，引用记录标明“提供给模型的依据”，不冒充已经通过事实支持度验证。

Batch 2 角色运行包位于 `packages/agent-runtime/roles`。extractor、verifier、planner、feedback-curator 都有固定 manifest、prompt、输出 schema 和最小 Skill；当前使用 inline skill 模式，运行时校验全部资产 digest、上下文/输出预算和结构化结果。`osdk run live-role` 会用已登录 TraeX 对虚构小样本执行一次真实提炼和独立复核，并把带模型、effort、bundle/prompt/context/skill hash 的报告写到忽略提交的 `.omem/verification/live-role-smoke.json`。这条命令会真实消耗模型调用。

Agent 进程在 `.omem/agent-workspace` 工作。内置配置采用只读/无工具策略，ACP 权限请求转成通知且拒绝自动执行；这不等于给任意第三方 Agent 提供 OS 安全沙箱。自定义运行器需保留自己的隔离/权限约束。

## 材料与接入

```bash
# 显式本地文件 / 固定 commit 文件 / 飞书文档
osdk exec --tool node -- npm run cli -- file ./notes.txt
osdk exec --tool node -- npm run cli -- git /path/to/repo README.md HEAD
osdk exec --tool node -- npm run cli -- lark 'https://tenant.larkoffice.com/docx/token'
# 主动输入统一 CaptureEnvelope JSON；也可从 stdin 读
osdk exec --tool node -- npm run cli -- capture ./capture.json
```

飞书读取使用 `lark-cli docs +fetch --as user`，需要运行服务所在用户已经授权。仅调用用户提供的文档，不自动全空间抓取。HTTP 的文件/Git 导入受 `captureRoots` 限制；CLI 的显式文件参数由发起 CLI 的本地用户提供，范围限于当前目录（文件）或给定仓库（Git）。

[输入协议与 hooks](docs/implementation/inputs.md) 包含多模态 JSON、屏幕/群聊上下文和 opt-in TraeX hook 模板。当前不会自动安装全局 hook 或启动屏幕监控。选择启用 `hook-forward` 后，事件会先写入 owner-only 本地 spool，服务离线时保留，拿到匹配 capture receipt 后才删除；`OMEM_HOOK_SPOOL` 可覆盖缓冲目录。

## 数据与服务部署

数据位于 `.omem/`，可用 `OMEM_DATA_DIR` 指定。SQLite 保存版本、片段、引用、待办、变更、通知和持久 job；图片为 hash 对象文件。数据库按递增 migration 升级，拒绝写入高于当前程序支持版本的库。相同来源标识+相同内容重试不重复录入；不同内容追加版本，旧引用仍可访问。原始材料与首个提炼 job 同事务提交，job 支持租约、fencing token、分类重试、取消和 attempt 指纹；B2-03 的真实提炼 handler 尚未接入，因此服务当前不会假装处理这些排队任务。恢复会生成新版本；有后续变更时返回 REBASE_REQUIRED。

单用户部署默认仅监听 loopback。公网/局域网监听需设置 `OMEM_HOST` 和强 `OMEM_TOKEN`，所有 `/api/*` 都校验 Bearer；浏览器令牌仅放 sessionStorage。部署到服务器建议用 TLS 反向代理/SSH 隧道。当前不是多租户服务，不把一个 shared token 当团队权限系统。

`GET /api/jobs` 与 `GET /api/jobs/:id` 可查看公开状态和 attempt 指纹；取消、重试分别使用 `POST /api/jobs/:id/cancel|retry`，请求必须带 `expectedGeneration` 和幂等 `requestId`。已成功应用的 job 不能靠取消抹掉效果，只返回需要补偿恢复。角色 job handler 已能持久化验证后的结构化输出和完整公开 trace；B2-04 的提炼/验证/策略编排尚未自动启动这些 handler。

通知默认每次变更即时显示在应用内并写入通知中心；`notifications.mode=digest` 关闭逐条浮动提示，保留所有记录（尚无定时摘要外发）。待办每 30 秒检查到期，重启后补查且去重。服务关闭时不会产生实时提醒；重开后处理逾期事项。飞书消息投递通道还未接入。

详细运行环境、Docker/osdk 实测结果与后续引擎依赖见 [环境说明](docs/implementation/environment.md)。

## 设计与验证

- [design.md](design.md)：Vue 设计系统、token、移动端和无障碍要求。
- [.agents/skills/omem-design/SKILL.md](.agents/skills/omem-design/SKILL.md)：后续界面任务的项目 skill。
- [packages/ui](packages/ui)：8 个可复用 Vue 组件与主题 token。
- [当前实施进度](docs/implementation/status.md)：已实现、已验证及剩余工作。
- [原始系统设计](docs/design.md)：总体架构，已注明本轮调整。

```bash
osdk run check
# 首次没有浏览器时：osdk exec --tool node -- npx playwright install chromium
osdk run browser
# 真实 Agent 测试（会使用已登录账号调用一次大模型）
osdk run live-acp
# 真实 extractor + verifier（会额外使用两次模型调用）
osdk run live-role
```

本仓库不提交真实会话、原件、token、模型权重和运行数据库。`docs/prototype` 保留此前经确认的离线视觉原型，它的演示数据和 React 构建不参与新 Vue 产品运行。
