# 原件保存与重新处理

先确认服务地址及个人库，再选择要更新的对象。用 `omem materials list --json` 取得来源 ID，`omem imports list --json` 取得文件导入 ID；文章 key 来自 `knowledge list`，消息 ID 来自 `messages inbox`。这些 ID 不可互换。

机器人事件的 ID 可从 `omem jobs list --json` 找到 `kind` 为 `lark_inbound` 的任务，再用 `omem jobs show JOB_ID --json` 读取 `inputRefs[0].inboxId`，这个值才是 `bot-event` 的 ID。目前没有单独列出机器人事件原件的命令。

## 保存了什么

代码、普通文件和独立文档按同一来源标识只保留最新原件，包括对应正文、结构及资源。更新时旧版本保留身份和摘要，旧引用会说明原件已被替换，不能展示新内容冒充旧版本。已经生成的文章默认仍保留，直到更新或显式删除。

聊天和本人反馈属于事件，保留当时正文与已下载资源。消息中分享的文档响应归属于当时事件，可供离线重新理解；文档自身仍按最新版管理。下载失败的附件只有缺口记录，原件不能凭空恢复。

PDF/DOCX 原字节先保存再解析。解析失败也有导入记录、错误与原件下载入口；服务重启继续未完成任务。同一上传标识更新原件，CLI 的同一路径默认复用来源标识，网页上传默认用文件名，遇到同名不同文档需要改标识。

## 选择处理方式

| 对象                                       | `--action`   | 输入和结果                                             |
| ------------------------------------------ | ------------ | ------------------------------------------------------ |
| `document`                                 | `parse`      | 保存的 PDF/DOCX 原字节，重新提取结构，再按启用设置理解 |
| `source`                                   | `parse`      | 已有 Docling 材料保存的原文件                          |
| `source`、`message`、`bot-event`           | `understand` | 保存的材料，重新整理记忆与事项；须启用学习 Agent       |
| `source`、`document`、`message`            | `describe`   | 保存的正文，重写用途和概念说明；须配置知识 Agent       |
| `source`、`message`、`bot-event`           | `refresh`    | 访问来源读取当前内容；需要有效路径或连接与权限         |
| `article`                                  | `write`      | 保留阅读目标，重新调查、写作并独立补查                 |
| `source`、`document`、`message`、`article` | `delete`     | 删除相关派生成果，保留原件或文章阅读目标               |

`document` 也支持 `understand`，须已有解析正文。`source refresh` 依赖导入时保存的连接信息；旧材料没有该信息时重新导入，不能猜测远端位置。

```bash
omem imports list --json
omem imports show IMPORT_ID --json
omem reprocess run document IMPORT_ID --action parse --replace --wait
omem reprocess run source SOURCE_ID --action understand --replace --wait
omem reprocess run article ARTICLE_KEY --action write --replace --wait
omem reprocess delete article ARTICLE_KEY
omem reprocess list --json
omem reprocess show REQUEST_ID --json
omem reprocess retry REQUEST_ID
```

`--replace` 在生成前删除对应旧成果，旧正文历史也清除。只改材料用途不会删除记忆，只重做理解不会删除用途说明；删除材料成果或更新来源也会清理引用该材料的旧文章。已经人工调整的记忆和待办、外部已执行动作保留，不把重生成当作撤销现实动作。省略 `--replace` 则在处理中保留旧成果。

删除模式失败后会暂时没有新成果，原件仍在，可修复配置后 `retry`。请求记录跟踪后续理解、写作和复核任务，`succeeded` 才表示这次处理完成。`--wait` 失败退出 1，Ctrl+C 退出 130 且只停止等待，后台任务继续；需要停止任务用 `jobs cancel`。

机器人 `understand` 使用保存的原件，可以在连接停用后重放；不再次执行旧委托，也不再次发送当时回复。选择 `refresh` 才访问飞书，资源缺失时不会在离线操作中偷偷补读。个人飞书读取路径仍不能发送、回应或删除消息。

网页在原始材料、知识文章和个人消息旁提供「重新处理」，输入材料页列出文件导入记录，材料处理页汇总实际处理状态。安装的旧技能副本不会自动更新；使用 `omem skills install` 复制到新目录后核对，保留用户定制。
