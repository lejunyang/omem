# 查看运行日志

先运行 `omem service status --json`，确认当前服务、实际日志等级与轮换状态。`omem service logs` 读取本机最近的结构化记录，不启动服务，也不调用模型；查询远程服务请用 `omem status`，不要给日志命令加 `--url` 或设置 `OMEM_URL`。

```bash
omem service logs --lines 100
omem service logs --level warn --json
omem service logs --job 任务标识 --lines 200 --json
omem service logs --source 来源标识 --json
omem service logs --message 消息标识 --json
```

`--level warn` 只筛选已有记录，显示 warn 及更严重的日志。`--lines` 接受 1–1000；多个标识条件同时使用时，必须全部匹配。默认最多返回最近 100 条。当前命令读取两个现行日志文件的末尾，每个文件最多扫描 1000 行或 1 MiB，不连续追踪，也不展开压缩归档。较早的匹配项可能不在这个窗口内。

## 设置详细程度

```bash
omem config logging debug
omem service restart
omem service status --json
```

配置命令保存个人配置中的 `logging.level`，重启后生效。默认 info，允许 trace、debug、info、warn、error、fatal 和 silent。debug 增加任务开始、决策耗时及每条检索材料的保留或过滤原因；trace 当前没有额外的专用事件。warn 可用于只看失败或降级，silent 关闭统一运行日志，任务结果仍保存到数据库。

`OMEM_LOG_LEVEL` 优先于文件配置。例如临时以 debug 启动后台服务：

```bash
OMEM_LOG_LEVEL=debug omem service restart
```

检查 `service status` 返回的 `logLevel`，确认实际进程使用的等级。日志查询返回的 `settings` 是本次命令读取的配置和环境；服务尚未重启时，它可能与进程的等级不同。非法等级会报错，不会静默使用 info。

`--data-dir` / `OMEM_DATA_DIR` 选择本机数据目录；`--config` / `OMEM_CONFIG` 选择配置文件。对多个个人库操作时，每次使用相同的目录与配置参数。日志等级调整与服务启停都不会改变消息采集范围。

## 能查到什么

| 记录                                                          | 帮助判断                                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `job.started`、`job.completed`、`job.failed`                  | 哪个任务运行了多久，进入成功、重试或失败状态；开始记录在 debug                     |
| `acp.started`、`acp.completed`、`acp.failed`、`acp.cancelled` | Agent profile 和调用阶段，超时或退出情况；用 acpCallId 串联同一次调用              |
| `http.request_failed` 及 HTTP 流/序列化失败                   | API 异常的路由模板、状态码与错误类别，不包含请求参数                               |
| `decision.completed`、`decision.unavailable`                  | 使用的模型、耗时与不可用原因，正常决策详情在 debug                                 |
| `retrieval.passage_decision`                                  | 材料是否保留、各分类的概率与理由；在 debug，可通过 hitId/sourceId 回到库中检查材料 |
| `retrieval.selection`、`retrieval.decision_skipped`           | 本次筛选数量，或模型未就绪、耗时限制等跳过原因                                     |

记录会按实际上下文带上 jobId、sourceId、messageId，也可能包含 revisionId、turnId、runId。没有这些上下文的事件不会制造关联 ID。一次搜索用 queryDigest 关联，不保存用户问题。决策弃权会写出 `all_omitted_abstention`；这表示保留原候选供后续调查，不能解释为材料已经通过复核。

运行日志只包含诊断元数据。原文与模型提示词被排除，工具参数和输出也不会写入；异常仅保留错误类别与代码位置，ACP stderr 只记录长度、摘要和认证提示，不复制原文。密钥字段和常见凭据格式统一脱敏。旧版本留下的普通文本不会被日志命令导出，`legacyLines` 表示此次扫描跳过了多少行。需要看任务完整结果时使用 `omem jobs show <id>`；调查产物仍受个人目录访问权限和数据清理规则管理。

## 位置与保留

安装版默认目录为 `~/.omem/service/pm2/logs/`，`service status` 给出实际位置与文件名。主日志固定为 `omem-out.log` 与 `omem-error.log`；前台运行写入终端 stderr，不会另建一套文件。

服务启动或重启会在该个人目录的隔离 PM2 中加载安装包自带的 [pm2-logrotate](https://github.com/keymetrics/pm2-logrotate)，不要求全局安装，也不在启动时去 npm 下载。默认每个文件达到 10 MiB 后轮换，保留 7 份压缩归档，另有当前文件；每 10 秒检查一次，并在本机每天零点轮换。PM2 自身日志也参与轮换。大小是检查阈值，快速写入期间可能超过阈值，不能当作严格的磁盘配额。

需要改变保留策略时，在个人配置加入或修改该段，再重启：

```json
{
  "logging": { "level": "info", "maxSizeMB": 10, "retain": 7 }
}
```

这段应合并到已有配置，保留 profiles 等原字段。maxSizeMB 接受 1–1000，retain 接受 1–100。轮换模块无法加载时，启动命令会失败，不能宣称日志已有限保留。`service status` 的 `logRotation.active` 表示模块当前在线；停止服务也停止该目录的轮换模块。升级前的日志文件可留在磁盘上，重启后新日志使用固定文件名。

日志文件仍需私密保管；轮换仅限制运行日志的份数，不删除原材料版本、数据库事实或仍被引用的历史。
