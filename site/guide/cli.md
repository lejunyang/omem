# 命令行

网页和飞书里能做的大多数操作，在终端里都有对应的 `omem` 命令。运行 `omem --help` 可随时查看完整列表。

> **两个安装包的区别**：
> - `@omem-ai/app`：完整版（含服务端、数据库、网页与全部 CLI 命令）。
> - `@omem-ai/cli`：单文件零依赖的轻量客户端，只含连接远程 omem 的 5 个命令（`login`、`tool`、`mcp`、`open`、`remote`），适合装在不跑服务端的个人笔记本上。

## 最常用的核心命令

### 1. 服务管理与初始化

```bash
omem setup                                  # 交互式设置向导（后端、模型、解析器、渠道、定时任务）
omem serve                                  # 前台启动服务（默认 http://127.0.0.1:4317）
omem service start|stop|restart|status|logs # 后台常驻服务管理（独立 PM2，崩溃自动重启）
omem service enable|disable                 # 设置或取消开机自启
omem db                                     # 查看数据库大小、空闲页与向量 int8 紧凑化进度（omem db vacuum 回收磁盘）
```

### 2. 空间、材料与问答

```bash
# 空间管理
omem space add shop --path ~/code/shop                  # 把本地代码仓库加为空间
omem space add 商城前端 --path ~/code/shop-web --parent shop  # 挂到业务空间 shop 下
omem space add demo --init                              # 新建空 Git 仓库并建空间
omem space parent shop-api shop                         # 把已有仓库归到业务空间下
omem space relate shop-web shop-api -n "调用订单接口"     # 关联两个相关空间（--remove 取消）
omem space sync shop --exclude docs/archive             # 同步仓库文件并排除指定路径

# 保存材料、检索与提问
omem add notes.md -s personal                           # 保存文件、目录、网址或飞书文档（- 读标准输入）
omem search "预算 约定"                                  # 检索原件、Wiki 页面与记忆
omem search --space shop-api --branch feature/refund "退款金额"  # 按指定分支检索代码
omem ask "项目 A 的预算之前是多少，现在是多少？"            # 让主助手调查并带依据回答
```

### 3. Wiki、记忆与事项

```bash
# Wiki 生成与维护
omem wiki plan shop -f "读者是新加入的后端开发"            # 先规划目录、再逐页生成 Wiki
omem wiki lint shop                                     # 原件变化后检查并修正受影响的页面
omem wiki organize shop                                 # 把顶层散落或过满目录里的页面整理进子目录
omem wiki move shop cases/ kb/cases/                    # 移动页面或目录（旧路径自动保留为别名）
omem wiki export shop .repo-review/wiki                 # 导出为仓库内可直接阅读的 Markdown

# 事项与记忆
omem items                                              # 列出当前事项
omem todo "交报销单" --remind 2026-10-19T09:00+08:00     # 新建带提醒的待办事项
omem memories stats|check|prune|rejections              # 按模型统计记忆质量、检查旧记忆、清理或查看被拒写入
omem digest proj --mode triage --goal "…"               # 批量整理存量材料（triage 分级 / digest 精读）
```

### 4. 编码交办与分支评审

```bash
omem delegate shop "订单页显示退款状态" --check "pnpm test"                 # 交办单仓库编码
omem delegate shop "订单页显示退款状态" --repos shop-web,shop-api           # 一次交办跨多个仓库一起改
omem review-branch shop-api feature/refund --task "只退未发货的行"           # 独立评审已有分支（只出意见不改代码）
omem branches shop-api [--fetch] [--index <分支>] [--drop <分支>]           # 查看分支列表与管理分支叠加索引
```

### 5. Agent、技能与外部 MCP 接入

```bash
# Agent 与角色管理
omem agents [--all]                                     # 查看已识别的 Agent（--all 含安装方法）
omem agents registry                                    # 浏览官方 ACP 注册表中的全部 Agent
omem agents add gemini --via npx                        # 一键添加 Agent（npx / uvx / binary）
omem roles [list|customize|reset|merge] <角色名>         # 自定义内置角色说明、恢复源码版或三方合并更新
omem skills [take-over [--dry-run] [--on]|restore|group <技能> <分组>] # 接管并按分组整理 Agent 自带技能目录

# 作为 MCP 或工具给外部 Agent 调用
omem mcp [--read-only] [--space <id>]                   # 启动 stdio MCP 服务供 Claude Code / Codex 接入
omem tool [工具名] [JSON | 键=值 … | -f 文件]             # 在终端直接调用 omem 工具
omem tool help [工具名|分组]                             # 查看工具分组说明
omem hook claude|codex                                  # 在 Claude Code / Codex 钩子中记录会话到知识库
```

## 渠道、插件与高级运维命令

### 飞书采集与知识库命令

```bash
omem lark backfill [--name 报警 | --kind group | --all] [--days 0] # 回溯历史聊天消息
omem lark fill-files [--name … | --all]                 # 补拉已保存消息中缺失的图片与附件
omem lark wiki-crawl <知识库页面链接> --depth 3 --max 500 --batch 100 # 按目录树分批爬取飞书知识库
omem lark kb list | discover | read [--limit 30]        # 查看飞书知识库列表、触发 kb-scout 发现建议、立即读一批
omem lark kb map <id> accept|map|create|ignore|pause …  # 处理某个飞书知识库的空间归属建议
omem lark docs-refresh | docs-dedupe [--apply] | docs-missing | docs-check # 刷新文档素材、合并重复原件、重试缺失、检查更新
omem lark user-permissions [--grant] | bot-permissions [--scan] # 检查并补齐个人 lark-cli 或机器人的飞书权限
omem doubao status | login [--app <appId>] | send-test  # 查看豆包权限、设备码授权、给自己试发一条私聊并核对
```

### 插件、复盘与可选组件安装

```bash
# 可选模型与组件安装（经 osdk）
omem setup embeddings --model bge-small-zh              # 开启本地向量检索（可选 bge-base-zh / bge-m3）
omem setup rerank [--threads 16]                        # 开启本地重排模型 bge-reranker-v2-m3（--off 关闭）
omem setup desktop                                      # 安装或更新桌面与浏览器控制组件（aad）
omem setup ffmpeg [--concurrency 4 --auto lossy]        # 安装 ffmpeg 并配置附件自动压缩

# 插件与场景包
omem plugin list|install|remove|enable|disable          # 管理插件（支持本地目录、npm:包@版本、github:owner/repo#tag）
omem plugin link <目录> / unlink <id>                    # 开发插件：直接链接本地目录并热重载
omem plugin pack --id projecta --name "项目 A" --agents helper --skills project-guide # 导出场景包
omem plugin failed-events | replay                      # 查看或重放失败的插件事件订阅

# 夜间复盘、决策评测与云端只读探测
omem replay [list] | omem replay run [--run <id>] [--axis K1] # 查看夜间复盘结论或立即对某题回放盲评
omem decision report [--days N]                         # 查看各决策场景的门槛表现与 AI 组选型完成率
omem decision replay --scene <scene> --model <提供方>:<模型> # 用其他模型离线回放对比决策记录
omem cloud-tools probe <后端档案>                        # 探测云端后端通过 HTTPS 调用本机只读工具的连通性
```

### 多人协作与多设备同步（Peer / Remote）

```bash
# 多用户管理
omem user add 小王 --id wang --lark ou_xxx --space team  # 登记同事账号并绑定飞书身份与空间
omem user add 小周 --email zhou@example.com --space team # 按邮箱预建账号（首次登录或找机器人时自动对应）
omem user approve <id> | omem user token <id>           # 批准待审账号 / 签发 API 令牌
omem user invite --space team [--edit project-a]        # 生成一次性邀请链接
omem space share project-a wang [--edit]                # 向成员开放空间读取或编辑权限

# 远程客户端登录（不配对，适合团队成员连常驻服务器）
omem login https://omem.example.com                     # 在浏览器确认登录，获取个人专属令牌
omem remote add|list|default|rm                         # 管理已保存的远程服务地址
omem open [页面]                                         # 用命令行身份直接在浏览器打开远程 omem
omem mcp --remote <名字> / --url <地址>                   # 以个人身份把远程 omem 作为本机 MCP 服务（tool 同理）

# 本人多台设备配对与互操作
omem peer invite --label laptop                         # 在常驻机器打印配对码（含所有网卡地址与令牌）
omem peer add <配对码> [--via <中间设备>]                 # 在另一台机器添加配对设备（支持经中间节点转发）
omem peer back <设备> on|off                             # 开启反向连接：让连不到本机的常驻服务器也能反过来调用本机
omem peer open <设备>                                    # 在本机浏览器免令牌打开对方网页（并按原端口号转发交办预览）
omem link                                               # 打印带令牌的局域网访问链接
omem diag [<设备>]                                       # 查看本机或配对设备的健康诊断、耗时与事件循环卡顿
omem peer call <设备> <命令> ['{"参数":…}']               # 在配对设备上执行白名单远程命令（如 update、logs、sql 等）
omem tool --peer <设备> <工具名> [参数…]                  # 用本机的 Agent 模型读写和整理配对设备上的知识库（mcp 同样支持 --peer）

# 跨服务空间共享与单向数据拉取
omem peer share <名字> --space 空间:query|sync[:内容]     # 向别人的 omem 服务开放指定空间（只检索或可同步）
omem peer subscribe <设备> <空间> [--sync]               # 订阅别人共享的空间（--sync 每半小时同步到本机只读镜像）
omem peer backup <设备> --to <目录> [--at 00:00]         # 后台定时把常驻设备的完整数据备份到本机指定目录
omem peer pull <设备> [--only library,files] [--to <目录>] [--dry-run] [--prefer-remote] [--overwrite]
```

### 补充：`omem peer pull` 的合并规则

`omem peer pull` 用于把常驻设备（或 SSH 主机）上的数据单向拉取合并到本机：
- **合并范围**：数据库（原件、记忆、事项、会话、运行、评审、规则等）必拉；知识库（`library/`）、原始附件（`files/`）、Git 代码仓库与交办工作区可按需勾选。
- **增量与冲突处理**：双方各自新增的记录都会保留，同一记录按更新时间取较新版；聊天原件追加缺失行并自动换算引用行号；Wiki 与技能走 Git 合并，冲突时保留本机版本并将远端另存为 `.remote.md`；物理删除不跨机传播。
- **安全隔离**：本机配置、密钥、API 令牌、采集游标和本地模型不会被打乱；检索索引与向量在本机按原件重新构建。新拉过来的定时任务和任务规则默认停用，避免两台机器重复执行或重复发消息。
