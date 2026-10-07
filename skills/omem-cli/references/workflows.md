# 命令与工作流

## 首次安装

需要 Node.js 24+。发布包安装后：

```bash
omem init
omem service start
omem status --json
omem agent probe --json
```

init 保留已有配置。基础导入、全文搜索和网页不要求模型；AI 使用已登录的 Traex ACP，配置中默认 gpt-5.6-sol。服务默认为 127.0.0.1:4317，数据 ~/.omem。`omem config path` 获取实际位置。PM2 后台不等于开机自启动，也不能阻止电脑休眠。

`omem skills path/show` 查看当前安装包的技能，`omem skills install /absolute/agent-skills` 复制完整 omem-cli 目录和 references。升级包不会同步此前复制出去的副本，已有目标会拒绝覆盖；先比较用户定制，再安装到新目录或合并更新。不要自动覆盖用户的其他技能或安装全局 hooks。

## 记录、找回、追问

```bash
omem import file ./notes.md --json
omem import git ./repo src/main.ts --ref HEAD --json
omem import text '下周三交付设计稿' --title '项目约定' --source-id design-plan --json
omem search '交付时间' --json
omem ask '设计稿什么时候交付，背景是什么？' --research --json
omem ask '后来是否改期？' --conversation CONVERSATION_ID --research --json
omem sources history SOURCE_ID --json
omem sources revision REVISION_ID --json
```

不要对返回 ID 硬编码。搜索目的选项 balanced / concept / implementation / background / follow-up。`ask` 的 turn.inputMessageRefs.status 必须为 done 才能把它称为完成；degraded 和引用的缺口照实说明。旧原文和当前知识状态应区分。

## 写知识文章

一批材料需要目录和多篇文章时，先用 `omem knowledge outline`，完整的选材、草案 JSON、编辑确认与失败处理见[知识目录草案](knowledge-outlines.md)。它先保存阅读路线，用户确认后才开始正文写作；单篇明确目标仍可用下面的 write。

先 `omem knowledge list --json`，从 materials 选择 revisionId，建立 JSON：

```json
{
  "brief": {
    "key": "guide:first-release", "title": "完成第一次发布", "order": 0,
    "kind": "tutorial", "reader": "新同事", "goal": "能够独立完成一次发布",
    "scenario": "把一个小改动发布到生产", "questions": ["需要哪些前提？", "如何验证和回滚？"],
    "entryPaths": [], "topicPath": ["项目入门"]
  },
  "revisionIds": ["实际选中的当前版本"]
}
```

`omem knowledge write plan.json --json` 提交，`knowledge list` 查看该页面维护状态，`knowledge show KEY` 阅读正文。材料、章节和文章不是同一层；别按每个代码文件创建一篇读者文章。返回 queued 只代表排队，不代表模型复核或用户验收通过。

## 消息与通知

在服务机器运行 `omem lark login`，再 `omem messages discover --json`；`messages chats '名称' --json` 查询缓存候选。同名会话先辨明实际对象。本人可以直接要求主助手订阅或自动关注，无需逐个填 ID；主助手查询对象与设置，再通过 work_action 应用本人交办。手动 watch 选择会话，enable 开启采集。configure 接受 `{enabled,intervalMinutes,historyHours,mentionExceptions,resources,autoWatch}`，保留未修改字段；intervalMinutes 为 1–1440，historyHours 为 1–168。

inbox 返回消息、资源与处理状态；资源缺失时先补读或说明未理解。unwatch 停止普通消息订阅，提及例外仍按原设置处理；exclude 明确排除会话（包括提及例外），pause 暂停全部个人消息采集与自动发现。读取不会修改飞书已读状态。

`messages auto-watch status/configure/run` 管理自动关注政策；自动发现需同时开启采集，先过滤人工选择与免打扰，再按少量抽样和已有关注背景判断。快速决策不可用时保留待判断，不自动订阅全部群。focus/ignore 文本变更先暂停旧自动群、取消旧同步，再按新政策重评；人工设置优先。`schedules list/show/add/configure/pause/resume/run/delete` 管理唯一自动发现任务及简报，两个默认模板首次暂停。先查询已有任务，修改同一任务并提供实际 version，避免重复通知。完整 JSON、自然语言操作与失败处理见 [会话关注与定时简报](schedules.md)。

创建或绑定机器人先读 [飞书机器人](lark-bot.md)，按准备服务、选择应用、核验、本人配对、检查状态完成。`omem bot setup --start` 准备本机配置和密钥并启动服务；CLI 与网页可继续同一次接入。`bot connect` 导入已有应用后仍需本人配对。只有明确要求接入时才创建或更改应用。个人采集不等于机器人自动进入全部群聊。

本人日常私聊由主助手调用工具，不要求用户执行上述命令。待决定问题可直接在飞书回答；已采集群聊中的本人确认先补读会话，沿用现有事项身份。需求调查缺背景时先自行补查，只有阻塞且需本人选择的问题通知本人；原有检查、提醒和执行结果需读回实际记录，不能再次制造同一个问题。

## 故障与可选能力

需求：`contexts list/create/assign` 管理材料范围；`requirements track '名称' --goal '验收目标' --context ID --watch` 开始持续调查。`requirements list` 的 maintenance 状态为 published 后用 show 阅读。新材料只有归属该范围后才进入调查，别把未归属、待判断的消息算作已调查。`requirements handoff KEY --to NEW_DIRECTORY` 导出 TASK.md 和固定文本；编码前另行检查目标仓库当前版本和用户授权。不能把提议当决定或代码存在当上线。

数据：`data info` 显示热/冷占用；停止对应服务及前台进程后 `data backup NEW_DIRECTORY`。`data restore BACKUP --to NEW_DIRECTORY` 先校验，不覆盖。`data migrate --to NEW_DIRECTORY` 保留原库。`data archive --before YYYY-MM-DD --to COLD_DIRECTORY` 默认预览；范围符合请求再加 --apply，可加 --compact 回收 SQLite 空页。`data prune --before DATE` 仅预览已完成的临时 Agent 目录，--apply 才删除。环境变量密钥、第三方登录与可重装模型不在数据备份里。

个人消息按持久游标增量拉取和摘要去重；status 的 last_batch 可查看最近窗口和复用数。文档链接十分钟缓存，附件字节三十天缓存；显式消息重试绕过缓存。缓存过期不删除已捕获原件。

- 无法连接：检查 --url、端口和 `service status`，区分目标 API 和本机 PM2。
- Agent 不可用：`agent probe` 读取真实可用模型/思考强度；不要猜参数。检查配置文件后 `config validate`。
- Sol 超时：idleTimeoutMs 为连续无活动时限，默认 Sol 480000 ms；旧 timeoutMs 兼容同义，maxDurationMs 才是可选总时限。stderr 日志不算模型活动。
- PDF/DOCX：`omem setup documents` 安装 Docling；`setup document-models` 显式下载 PDF 模型，需 osdk。
- 中文向量：`setup embedding` 后启用 retrieval.enabled。
- 本地决策：Apple Silicon Mac 上 `setup decisions` 后设置 decisions.mode 为 auto，2B/4B 随负载选择。缺少本地模型时不伪造判断结果。

退出码 0/1/2/130 分别是成功、执行失败、参数错误、用户中断。`serve`、`setup`、`lark login/status` 使用工具自身输出，不把它们当统一 JSON 接口。
