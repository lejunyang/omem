# 运行环境与 osdk 实测

2026-09-26。本轮首批基础系统直接使用 Node 24.18.1（含 SQLite）、Vue、Fastify、官方 ACP TypeScript SDK。Node 通过 osdk 安装；所有 npm 包由 `osdk deps` 管理并生成 lockfile。

## 是否需要 Docker

| 部分 | 当前需求 | Docker 是否必需 |
| --- | --- | --- |
| omem Vue/API/SQLite/CLI 接入 | Node、持久目录、浏览器 | 不需要 |
| TraeX/Codex/Claude Code | 本机可运行的命令与账号登录；模型由宿主访问 | 不需要，不下载本地 LLM |
| 飞书材料 | lark-cli 与用户授权 | 不需要 |
| Git/文本 | Git 与可读目录 | 不需要 |
| Embedding/reranker | 之后可用本地小模型，由 osdk 下载固定快照 | 尚未引入；可 CPU 起步，需按具体模型测 |
| WeKnora 全套引擎 | Go 主服务、Python docreader、DB/队列/模型 endpoint 等，按锁定版本配置 | Compose 是较方便的部署方式；源码方式也可运行 |
| Hindsight | 服务、数据库/扩展、模型与 embedding/rerank 配置，按锁定版本配置 | 有 Docker 路径，也有 Python 部署路径 |

上一轮建议的 WeKnora/Hindsight 各自会在内部调用大模型，不能简单把 `command=traecli` 填入 OpenAI endpoint。当大模型必须先通过 CLI/ACP 接入时，先实现统一推理 gateway；后续给引擎写经过验证的 provider adapter，或者等待 API provider 接入。当前代码没有伪造一个“兼容所有模型 API”的 CLI 代理，也未部署两套引擎。

首版轻量数据用 SQLite 是个人模式的明确实现选择；PostgreSQL/多用户 ACL、混合索引是后续阶段，不假定仅替换连接字符串即可升级。

## osdk 检查结果

- 版本：osdk 0.0.3。
- `osdk skills add lejunyang/osdk`：镜像和 GitHub 直连都返回 404。本机 one-sdk 的 remote 为 `git@github.com:lejunyang/one-sdk.git`，改用 `osdk skills add lejunyang/one-sdk --skill osdk-guide --agent universal --agent claude-code --copy --yes` 后成功。
- 固定 skill commit：`02a2f2b3142ded7d73554aaee629a24966a62313`，已写 osdk.lock。TraeX 可读取项目 `.agents/skills`；osdk 的 agent ID 表当前没有 `trae`，使用 universal。
- `osdk install node@24.18.1` 成功；TUNA 单源 404 后自动切换其他源成功，验证了回退路径。
- `osdk deps` 成功安装项目闭包；日志显示 `npm.cmd install`，Linux 实际执行成功。尚不足以认定运行错误。
- `osdk container doctor --json` 成功给出 schema_version 2 的诊断；Docker 为 permission-denied，containerd 为 client-only，pull unavailable，Buildx inspection permission-denied。
- 以上说明当前宿主没有可供本用户使用的容器运行环境；尚未执行真实 pull/build，因此不能宣称 container 功能端到端已通过，也没有足够依据报成 osdk bug。

**能力边界**：当前 container 子命令覆盖 doctor/pull/cache/prune/mirror；没有 compose up/down 服务编排。后续即便使用 osdk 管理镜像/诊断，仍需原生 Docker Compose 启动服务。这是现有命令面的边界，不自行修改 osdk 或冒称支持。

## 长期运行

开发 `osdk run dev`；生产先 `osdk run build` 再 `osdk run start`，服务在前台运行，便于现有 supervisor/systemd 管理。环境变量：OMEM_CONFIG、OMEM_DATA_DIR、OMEM_HOST、OMEM_PORT、OMEM_TOKEN。数据目录应持久化且仅服务账户可读。

没有在本轮安装系统服务或变更 Docker 用户组。备份 SQLite 时使用在线 backup API/停止服务后的完整复制，包含 WAL 状态；图片 assets 必须一起备份。当前恢复以文件级备份为主，不承诺 PostgreSQL PITR。

已提供 deploy/omem.service.example 和 deploy/omem.env.example，供现有 systemd user supervisor 使用；路径为明确占位，部署时替换并保护环境文件（0600）。模板没有在本轮安装。当前启动进程在 127.0.0.1:4317，尚未设置开机自启；远程浏览可经 SSH 隧道映射该端口。
