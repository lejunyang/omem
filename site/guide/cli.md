# 命令行

网页能做的大多数事也有命令；`omem --help` 列出全部。

## 服务

```bash
omem serve                          # 前台启动
omem service start|stop|restart|status|logs
omem service enable|disable         # 开机自启（macOS LaunchAgent、Linux systemd 用户服务、Windows 启动文件夹）
omem setup                          # 设置向导
omem setup embeddings --model bge-small-zh   # 只开启向量检索
omem setup desktop                  # 安装或更新桌面与浏览器控制（aad），并做环境检查
```

## 材料与检索

```bash
omem space add shop --path ~/code/shop          # 代码仓库空间
omem space relate shop-web shop-api -n "调用订单接口"
omem space sync shop --exclude docs/archive
omem add notes.md -s personal                   # 保存文件、目录、网址、飞书文档（- 读标准输入）
omem search "预算 约定"                          # 检索原件、页面、记忆
omem search --space shop-api --branch feature/refund "退款金额"
omem ask "项目 A 的预算之前是多少，现在是多少？"
omem digest proj --mode triage --goal "…"       # 整理一大批存量材料：分级 / 精读
```

## Wiki、记忆、事项

```bash
omem wiki plan shop -f "读者是新加入的后端开发"   # 规划并逐页生成
omem wiki lint shop                              # 原件变了之后修正受影响的页面
omem wiki export shop .repo-review/wiki          # 导出成仓库里可读的 Markdown
omem items
omem todo "交报销单" --remind 2026-10-19T09:00+08:00
omem memories stats|check|prune|rejections       # 记忆质量
```

## 编码与评审

```bash
omem delegate shop "订单页显示退款状态" --check "pnpm test"
omem delegate shop "订单页显示退款状态" --repos shop-web,shop-api   # 几个仓库一起改
omem review-branch shop-api feature/refund --task "只退未发货的行"   # 评审已有分支
omem branches shop-api [--fetch] [--index <分支>]
```

## Agent 与角色

```bash
omem agents [--all]                 # 已识别的 Agent（--all 含未安装的和安装方式）
omem agents registry                # 官方 ACP 注册表
omem agents add gemini --via npx
omem roles [list|customize|reset|merge] <名>   # 内置角色：自定义、恢复、合并源码更新
omem replay [list]                              # 夜间复盘：状态和最近的结论
omem replay run [--run <运行id>] [--axis M1]    # 立即复盘（先给 replay-judge 选模型）
omem mcp [--read-only] [--space <id>]           # 作为 MCP 服务给其他 Agent 用
omem tool [工具名] [JSON | 键=值 … | -f 文件]     # 在终端里调用 omem 工具；omem tool help [工具名|分组] 看说明
omem tool --peer <同伴> [工具名] [参数…]         # 在同伴上调用（用本机的模型整理它的库），mcp 也有 --peer
omem hook claude|codex                          # 把编码 Agent 的会话记进知识库
```

## 飞书

```bash
omem lark backfill --name 报警 --days 0         # 回溯会话历史
omem lark fill-files --all                      # 补拉缺的图片和附件
omem lark wiki-crawl <知识库页面链接> --depth 3   # 按目录树读飞书知识库
omem lark docs-refresh | docs-missing | docs-check
omem lark user-permissions [--grant] | bot-permissions [--scan]
```

## 多人与多台设备

```bash
omem user add 小王 --id wang --lark ou_xxx --space team
omem user token wang
omem space share project-a wang [--edit]
omem peer invite --label laptop     # 打印配对码
omem peer add <配对码> [--via <中间那台>]
omem diag <同伴>
omem peer call <同伴> update
omem peer pull <同伴>
omem peer pull <同伴> --dry-run
omem peer pull <同伴> --overwrite  # 先停本机服务；旧数据留备份
omem peer open <同伴>
omem link
```

`pull` 是手动单向合并：原件、记忆、事项和提醒时间、运行与评审问题、原件标注和归档、规则与学习记录都会拉取；Wiki、档案和技能随知识库合并，附件传整个文件目录。SSH 主机和已配对同伴使用相同快照。两端升级后还能传仓库的 Git 历史、分支、暂存与未暂存改动、非忽略的未跟踪文件、已检出子模块，以及编码 worktree 和补丁。

两边各自新增的记录保留；同一记录按更新时间处理。聊天追加远端缺少的行，保留本机行号并换算远端引用。知识库文件冲突留本地，远端另存 `.remote.md`；物理删除不传播。新仓库保存到数据目录并关联空间；已有仓库只在干净、同分支且可快进时更新，本机改动和分叉保留，远端分支与工作区另存。

配置、密钥、令牌、采集游标、模型和服务日志留在本机。新导入的任务规则和定时任务先停用，存量整理任务暂停，远端排队或运行中的任务取消，不恢复另一台的 Agent 进程。覆盖前停掉本机服务；旧数据库、附件、知识库、运行和托管仓库会备份，恢复失败时回滚。覆盖后同样需要按需启用任务。
