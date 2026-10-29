# 安装与第一次使用

## 准备

- Node.js 22.18 以上（推荐 24）；
- 至少一个已登录的 Agent。支持 [Agent Client Protocol](https://agentclientprotocol.com) 的 Agent 装在 PATH 里就会被识别：

| Agent | 安装 | 配置 id |
| --- | --- | --- |
| Codex | `npm i -g @agentclientprotocol/codex-acp` | `codex` |
| Claude Code | `npm i -g @agentclientprotocol/claude-agent-acp` | `claude` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini` |
| GitHub Copilot CLI | `npm i -g @github/copilot` | `copilot` |
| Qwen Code | `npm i -g @qwen-code/qwen-code` | `qwen` |
| OpenCode | `npm i -g opencode-ai` | `opencode` |
| 其他（Cursor、Kimi、goose、Cline……） | 见 `omem agents --all` | 同名 |
| Claude / Codex 命令行（没有 ACP 时的后备） | `claude` 或 `codex` 在 PATH 中 | `claude-cli` / `codex-cli` |

每个 Agent 第一次用之前，在终端里直接运行一次完成登录。

## 安装

```bash
git clone https://github.com/lejunyang/omem.git
cd omem
pnpm install
pnpm run build
npm install -g .          # 把 omem 命令链接到这个仓库（可选）
```

用 osdk 管理 Node、pnpm 和可选的本地模型时：

```bash
osdk install && osdk deps --frozen
osdk run dev              # API :4317 + 网页 :5173，数据在 ./.omem
```

## 设置向导

```bash
omem setup
```

交互式选择：Agent 后端与模型、向量检索模型（可选）、PDF / DOCX 解析、桌面与浏览器控制（可选，让 Agent 操作电脑上的程序和网页）、飞书 / Telegram / QQ·微信渠道、会话与并发、定时任务。每一项先显示本机装了什么、各选项的代价，缺的经 osdk 装好。最后可以直接启动后台服务。

## 启动

```bash
omem serve                # 前台运行，http://127.0.0.1:4317
omem service start        # 后台常驻（崩溃自动重启）；stop / restart / status / logs
omem service enable       # 开机自启
```

数据目录默认 `~/.omem`（`--home` 或 `OMEM_HOME` 可改）：`config.json` 是配置，`omem.db` 是索引与记录，`library/` 是 Wiki 的 Git 仓库，`files/` 存原始文件，`runs/` 存交办编码的工作区和补丁。各部分占了多少（附件按图片、视频等类型和来源分开，数据库按模块和表分开）在 **设置 → 占用** 里统计。

默认监听所有网卡，方便其他设备配对；本机请求不需要令牌，其他机器必须带令牌。只想本机访问，在配置里写 `"host": "localhost"`。

## 打开网页之后

1. **设置 → Agent**：确认至少一个后端显示“已安装”。在 **Agent → 档案** 里给内置角色选默认后端、模型和思考强度。
2. 在问答里说“创建一个项目空间”或“关联这个本地仓库”，也可以在 **设置 → 空间** 新建。Git 链接会克隆到数据目录的 `repos/`。
3. **Wiki → 规划并生成 Wiki**，或直接对助理说“生成 Wiki”。
4. **今日 / 问答**：直接提问或交代事情，比如“记住：周四下午三点和小王同步项目 A”“不对，预算改成 120 了”“下周一提醒我交报销单”。
5. <kbd>Ctrl K</kbd> 搜索或提问，<kbd>Ctrl J</kbd> 保存材料（文本、网址、飞书文档、拖入文件）。

## 更新

```bash
osdk run upgrade --restart    # 或 node scripts/upgrade.ts --restart
```

拉最新代码、装依赖、构建、链接全局命令，并重启后台服务。

## 给其他 Agent 用

在 Claude Code、Codex 里把 omem 配成 MCP 服务：

```bash
omem mcp                  # 只读用 --read-only
```

它们就能检索你的知识库、读原文、记记忆和事项。仓库里的 `skills/omem/` 是给这些 Agent 的使用说明（`SKILL.md` 概览，`references/` 按分组），可以整个放进它们的技能目录。能跑 shell 的 Agent 也可以直接用命令行：

```bash
omem tool help memory                      # 记忆类工具的做法
omem tool search query="退款 幂等"           # 调用一个工具，键=值 或一个 JSON 对象
```

常用的工具直接列出，其余的经 `omem_help`（看说明）和 `omem_call`（调用）使用，不会一次把一百个工具的说明塞进 Agent 的上下文。
