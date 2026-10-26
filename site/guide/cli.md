# 命令行

网页能做的大多数事也有命令；`omem --help` 列出全部。

## 服务

```bash
omem serve                          # 前台启动
omem service start|stop|restart|status|logs
omem service enable|disable         # 开机自启（macOS LaunchAgent、Linux systemd 用户服务、Windows 启动文件夹）
omem setup                          # 设置向导
omem setup embeddings --model bge-small-zh   # 只开启向量检索
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
omem mcp [--read-only] [--space <id>]           # 作为 MCP 服务给其他 Agent 用
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
omem pull <同伴>
omem peer open <同伴>
omem link
```
