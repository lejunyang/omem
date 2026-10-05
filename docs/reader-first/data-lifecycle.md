# 个人库、缓存与冷存储

安装版默认 `~/.omem`，可用 `--data-dir` 或 `OMEM_DATA_DIR` 指定。源码开发默认仓库 `.omem`。CLI 和 Web 连接同一服务；`data` 子命令直接管理本机目录，不通过 HTTP，不能使用 `--url` 操作远程库。

## 实际存了什么

| 数据 | 热存储 | 本轮冷存储与保留策略 |
| --- | --- | --- |
| 来源、修订、原文段落、文章、记忆、事项、项目归属 | `omem.sqlite` | 保留，仍支撑固定引用和事务应用 |
| 消息同步游标、分页位置、消息 ID、去重摘要、处理状态 | 同一 SQLite | 始终保留，归档不导致重新全量拉取 |
| 消息原始 JSON、决策详情、资源清单 | SQLite | 可按更新时间归档为校验过的 gzip 文件；最近 200 条、失败和未完成消息保留热载荷 |
| 图片、附件和下载原件 | `assets/<sha256>` | 可按文件时间迁到另一目录/磁盘；ID 不变，读取自动回到冷存储 |
| 全文与向量检索数据 | SQLite | 目前仍在主库，不宣称完成索引分库 |
| 模型运行输出和任务审计 | SQLite；另有 Agent 工作目录 | 正式输出保留；完成且已释放原件快照的临时目录可预览后清理 |
| PM2、配置、加密凭据、模型环境 | 独立文件目录 | 不混入知识；备份含配置和 `secrets`，排除可重装模型、PM2 状态与临时工作区 |

因此，目前大多数结构化状态仍在一个 SQLite 中，**这一轮不是把所有历史分库**。先迁出大附件和重复消息载荷，保证旧引用可读。原文修订与 Agent 正式输出仍会增长，不能把首次冷归档当作已解决长期容量问题。下一阶段应按实际占用，把可重建索引和运行审计分离，再设计原文历史的分段存储；不要按日常/代码等产品类别复制一套事实库。

## 命令与恢复

```bash
omem data info
omem service stop
omem data backup /Volumes/Backup/omem-2026-10-06
omem data restore /Volumes/Backup/omem-2026-10-06 --to /Volumes/Data/omem-restored
omem --data-dir /Volumes/Data/omem-restored service start

# 迁移保留原目录；确认新库正常后再自行处置旧库
omem data migrate --to /Volumes/Data/omem

# 默认只列出候选；--apply 才迁出，--compact 再收缩主库文件
omem data archive --before 2026-09-01 --to /Volumes/Archive/omem
omem data archive --before 2026-09-01 --to /Volumes/Archive/omem --apply --compact
omem data prune --before 2026-09-01
```

数据维护要求停止这个个人库的后台服务及所有前台开发进程。新版 Store 持有进程租约，维护命令检测到活跃实例会拒绝执行；升级前已运行的旧服务没有这个租约，也必须先停止。日期是候选条件，不自动判定知识失效，也不自动删除固定版本。归档目录写入 `cold-store.json`；当前只支持一个文件系统冷存储根，不直接支持 S3。目录不可用时不能完整读取旧资源，应挂载磁盘，不重新下载冒充旧版本。

备份使用 SQLite 的 [`VACUUM INTO`](https://sqlite.org/backup.html)，再复制附件、冷存储、配置和加密凭据，记录各文件 SHA-256。恢复先校验，目标必须为新目录。含冷存储的备份可独立恢复，不依赖原挂载路径。环境变量密钥、第三方 CLI 登录不在备份中；机器人解密密钥应另行保管，备份本身包含个人材料。跨机器恢复后要检查配置内模型路径、捕获目录和第三方登录。

## 消息缓存不是只缓存最后一页

每个订阅独立保存 watermark、固定查询窗口和 page_token；分页未完只继续该窗口，完成后保留一分钟重叠，补捉窗口交界。消息按 ID 与摘要去重，同一消息不重复产生模型任务。冷归档保留 ID、摘要和处理状态。

群内文档链接成功读取后，十分钟内复用固定修订；同一图片/附件按账号、资源类型和 key 复用已保存字节，缓存有效期 30 天，过期只是重新读取许可，不删除已引用原件。失败不缓存为成功，显式重试绕过缓存。十分钟缓存意味着可变文档可能短暂不是最新内容；消息正文没变时不会为了链接轮询远端文档，独立文档持续同步尚需后续接入。

`messages status --json` 显示每条流最近一页的时间窗口、拉取数、复用数、处理数及后续分页。这里的 fetched 是顶层消息数，cached/processed 还包括返回的线程回复；并非模型准确率或完成事项数。所有读取继续保留用户未读状态。

实现入口：`storage/library.ts` 管维护，`storage/cold.ts` 管固定 ID 读取，`storage/library-lock.ts` 管维护互斥；个人消息 `service.ts` 管游标/去重，`materials.ts` 与 `cache.ts` 管资源缓存。不引入另一套消息数据库或文件名驱动的业务分类。
