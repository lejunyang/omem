# 安装与第一次使用

只要 **5 分钟**，你就可以在本机或常驻服务器上跑起 omem：装好一个 Agent、运行一次交互式向导 `omem setup`、打开网页或连上飞书即可开始。

## 1. 准备环境

你需要两样东西：
1. **Node.js 22.18 以上**（推荐 Node 24）。
2. **至少一个可用的 AI Agent**（或者一个 OpenAI / Anthropic / 火山方舟等兼容的 API Key）。

任何支持 [Agent Client Protocol (ACP)](https://agentclientprotocol.com) 的 Agent 装在 `PATH` 里都会被自动识别：

| Agent | 安装命令 | 配置 ID |
| --- | --- | --- |
| **Codex** | `npm i -g @agentclientprotocol/codex-acp` | `codex` |
| **Claude Code** | `npm i -g @agentclientprotocol/claude-agent-acp` | `claude` |
| **Gemini CLI** | `npm i -g @google/gemini-cli` | `gemini` |
| **Antigravity CLI** | 按[官方说明](https://antigravity.google/docs/getting-started?tab=cli)安装 `agy`，再 `agy acp --login` | `antigravity` |
| **GitHub Copilot CLI** | `npm i -g @github/copilot` | `copilot` |
| **Qwen Code / OpenCode** | `npm i -g @qwen-code/qwen-code` / `npm i -g opencode-ai` | `qwen` / `opencode` |
| **豆包 CLI** | `npm i -g @bytedance/doubao-cli`，再 `doubao login` | `doubao-cli` |
| **其他 20+ 种 Agent** | Cursor、Kimi、goose、Cline、TraeX 等，运行 `omem agents --all` 查看 | 同名 |
| **原生 CLI 兜底** | `claude`、`codex` 或 `traex` 在 PATH 中（无 ACP 时的后备） | `claude-cli` / `codex-cli` / `traex-cli` |

> **登录提示**：每个 Agent 第一次使用前需要登录一次。Codex、Claude Code、TraeX、Copilot、豆包 CLI 和 Antigravity 都支持直接在 omem 网页的 **设置 → 后端与模型** 里点“登录”（通过链接+验证码或粘贴授权码完成，不用登到服务器终端）；也可以直接在 **设置 → 后端与模型 → API key** 里填 API Key 生成按量计费的后端。

## 2. 安装 omem

按你的使用场景选择一种安装方式：

### 方式 A：从 npm 安装发布版（推荐日常使用）

```bash
npm install -g @omem-ai/app
```

### 方式 B：从源码构建运行

```bash
git clone https://github.com/lejunyang/omem.git
cd omem
pnpm install
pnpm run build
npm install -g .          # 可选：把全局 omem 命令链接到当前仓库
```

如果机器上装了 `osdk`，也可以让 `osdk` 统一管理 Node、pnpm 和本地模型：

```bash
osdk install && osdk deps --frozen
osdk run dev              # 开发模式：API :4317 + 网页 :5173，数据在 ./.omem
```

### 方式 C：只连别人的或常驻服务器的 omem（轻量客户端）

如果服务端跑在另一台机器上，本机只需要用命令行或给本机 Claude Code / Codex 接 MCP，装单文件、零依赖的轻量包即可（命令同样是 `omem`）：

```bash
npm install -g @omem-ai/cli
```

## 3. 运行设置向导与启动

第一次使用时运行交互式向导：

```bash
omem setup
```

向导会先检测本机已安装的工具、说明各选项的资源开销，再带你一步步选好：
- **Agent 后端与默认模型**
- **向量检索与重排模型**（可选，经 `osdk` 下载锁定，也可在网页里配云端 API）
- **文档解析**（PDF / DOCX 解析器 Docling）与 **桌面/浏览器控制**（可选，`ai-auto-desktop`）
- **飞书 / Telegram / QQ·微信渠道**（飞书支持扫码一步创建机器人应用并开启个人只读采集）
- **定时任务与后台服务**

设置完成后可以直接在向导末尾启动服务，或随时用命令管理：

```bash
omem serve                # 前台启动，默认打开 http://127.0.0.1:4317
omem service start        # 后台常驻运行（自带独立 PM2，崩溃自动重启）
omem service enable       # 设置开机自启（macOS LaunchAgent / Linux systemd / Windows 启动项，无需管理员权限）
```

## 4. 打开网页后的前五步

浏览器打开 `http://127.0.0.1:4317`：

1. **确认后端可用**：在 **设置 → 后端与模型** 确认至少一个后端显示“已安装”。在 **Agent → 档案** 里可以为不同内置角色（如主助手、编码、评审、把关）选不同的模型与思考强度。
2. **创建空间或接入代码仓库**：在问答里对助手说“创建一个项目空间”或“关联这个本地仓库 / Git 链接”，或在 **设置 → 空间** 新建。输入框会自动识别本地绝对路径和 `HTTP(S) / SSH` Git 地址。
3. **生成第一套 Wiki**：进 **Wiki → 规划并生成 Wiki**，或直接对助手说“结合代码和文档生成 Wiki”。
4. **开始交代工作**：在 **工作 / 问答** 页直接提问或交代事情——“记住：周四下午三点和小王同步项目 A”“不对，预算改成 120 了”“帮我盯着项目 A 群里的需求变化”。
5. **随时检索与保存**：在任何页面按 <kbd>Ctrl K</kbd> 搜索或提问，按 <kbd>Ctrl J</kbd> 保存材料（粘贴文本、网址、飞书文档链接或拖入文件）。

## 补充说明与日常维护

### 数据目录与磁盘空间管理

数据默认存放在 `~/.omem`（可通过 `--home` 或环境变量 `OMEM_HOME` 修改）：

| 路径 | 存放内容 |
| --- | --- |
| `config.json` / `omem.db` | 配置文件 / SQLite 数据库（原件切块、FTS 索引、向量、记忆、事项、运行记录） |
| `library/` | 知识库 Git 仓库（各空间的 Wiki Markdown 页面、自定义 Agent 档案 `_agents/`、技能 `_skills/`） |
| `files/` / `repos/` | 导入与采集的原始附件 / 克隆的 Git 仓库 |
| `runs/` / `workspaces/` | 交办编码的补丁记录 / 复用的 Git worktree 工作区（保留 `node_modules` 免重复装依赖） |
| `secrets/` / `service/` | 仅本人可读（`0600`）的密钥与令牌 / 后台 PM2 进程数据与轮换日志 |

- **查看占用与压缩附件**：在 **设置 → 占用** 点击“开始统计”，可以按模块、表和附件类型查看空间占比。图片和音视频占满磁盘时，可在同一页点“压缩附件”（调用 `ffmpeg` 转为 WebP / AV1 / Opus，有损或无损可选），聊天和文档里的原引用会自动指向压缩后的文件。

### 把 omem 作为 MCP 服务给外部 Agent 用

你可以让你平时在终端或 IDE 里直接使用的 Claude Code、Codex 接入 omem 的知识库：

```bash
omem mcp                  # 作为 stdio MCP 服务启动（只读模式加 --read-only）
```

能跑 Shell 的 Agent 也可以不配 MCP，直接调用命令行：

```bash
omem tool help memory                # 查看某个分组的工具用法说明
omem tool search query="退款 幂等"     # 直接调用工具（传 键=值 或 JSON）
```

omem 共有约 100 个工具；为了不挤占上下文，MCP 默认只直接列出最常用的 20 来个核心工具，其余通过 `omem_help` 和 `omem_call` 按需调用。

### 升级版本

源码安装的用户在仓库目录下运行一条命令即可拉取最新代码、安装依赖、构建并重启服务：

```bash
osdk run upgrade --restart    # 或 node scripts/upgrade.ts --restart
```

### 局域网访问、HTTPS 与通知节奏

- **监听与鉴权**：服务默认监听 `0.0.0.0:4317` 以便其他设备配对。本机浏览器通过 `localhost` / `127.0.0.1` 访问免令牌（校验 `Host` 与 `Origin`，防止其他网页跨站借用）；从其他机器访问必须携带配对码或 `omem link` 生成的令牌。若只允许本机访问，在 `config.json` 中设 `"host": "localhost"`。
- **开启 HTTPS / HTTP/2（可选）**：同时打开很多标签页时，为突破浏览器对单个 HTTP/1.1 地址 6 条并发连接的限制，可在 `config.json` 中配置 `"https": { "port": 4443, "selfSigned": true }`（或指定自有证书 `cert` / `key`），启用 HTTP/2 多路复用。
- **时区、通知汇合与工具审批**：
  - 在 **设置 → 定时任务 → 时区** 设定你的日常时区。
  - 在 **设置 → 通知与打扰 → 通知时间** 可配置“不急的后台进展何时一起发”（默认 `09:30`、`13:30`、`18:30` 合并推送，离开飞书会议时也会立即放出）。
  - 在 **设置 → 安全 → 工具审批** 可为每个工具设定“每次问我 / 做完告诉我 / 不用问”。连续批准满 10 次会询问是否改为“做完告诉我”；对汇报点个负面表情即刻退回“每次问我”。
