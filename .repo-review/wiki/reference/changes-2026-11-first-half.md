---
title: 2026-11 上半月的变化（11-03 至 11-15 凌晨）
summary: 11 月上半月加进 omem 的功能和修正；从 changes-since-2026-10-13 里移出来的归档，找旧改动时按关键词搜，不用整份读。
kind: reference
updated: 2026-11-15
---

从 [2026-10-13 之后的变化](./changes-since-2026-10-13.md) 移出来的归档。前一部分按日期排（11-03 到 11-15）；后一部分是当时加在文件最前面的条目（11-05 到 11-15 凌晨，没有按日期排）。条目写的是当时的情况，后来又改过的以新的记录和代码为准。

## 11-03：后端会话清理补漏；豆包会话经 OpenAPI 删除

- **ACP 清理补漏**（`acp.ts`）：`discard` 时原连接已断（进程退出，或后台池里闲置期间连接关闭：常驻服务器上 Codex 10-23 以来 92 次“ACP connection closed”）改用 `deleteAcpSession`：另起一个进程，`initialize` 后只调 `session/delete`。之前进程已退出时直接跳过、不提示。
- **聊天换会话时清理旧的**（`sessions.ts` 的 `retireReplaced`，`dispatch.ts` 的 `retireSession`）：聊天会话因轮数上限、换模型或旧会话恢复不了而换成新会话时，旧会话按后端能力归档（`archiveArgs`）、`session/delete` 或豆包删除；在后台进行，失败只写服务日志。编码、交办、评审链的会话仍保留供续轮。
- **豆包**：`deleteDoubaoSession`（`DELETE /v1/sessions/:id`，无令牌时接口回 99991661，路由存在）。`doubao` 与 `doubao-cli` 的单次运行（不续会话、不保留）结束后删掉这次建的会话，失败的也删；CLI 的对话 id 交给同一个接口（同一豆包账号），这台机器没有授权 OpenAPI 时运行里提示会话留在豆包历史里。只删 omem 从后端拿到的 id。
- **飞书里引用和机器人的私聊**（`citations.ts`）：和机器人的私聊不进 `lark_messages`，补到的位置原来无处可存，`msg:` 引用都只打开这个私聊（读者本来就在这里）。现在位置记在 omem 消息的 `meta.larkPosition`；`deliverToThread` 送出的回复记下 `larkMessageId`；没有位置、又正是发往的会话时，引用改成只读分享；没发到飞书的消息（记录、卡片）直接分享。
- **网页的页面参数**（`web/src/lib/route.ts` 的 `pageParam`）：需求、事项、问答、运行、原件页只认自己路径下的 id，路由已经换到别的页、旧页面还没卸载时不再拿新页的 id 去请求（运行页报“需求点不存在：<运行 id>”）。
- **修改项推进的一轮做完再停**（`code.ts`、`code-overlap.ts` 的 `settleTurn`）：编码 Agent 做完一两项就停下时，同一会话里接着做这一轮没做的项（最多 8 次，没进展就停）。没轮到的项不再算一次尝试（`code-tasks.ts` 的 `notReached`，连续 3 轮没轮到交给助手）。助手用 `continue_code_run` / `message_code_run` 说的“接着推进”作为下一轮的交代（`workNote`、`roundNotes`），`new_item: true` 才记成修改项。问本人的卡片带完成标准、评审问题、每次的情况和编码 Agent 的说明（`ownerQuestionText`）。

## 11-03：豆包会话删除真机验收；兼容 CLI 2.31.2

- 真机确认 CLI 创建的会话可以通过 OpenAPI 删除：先用同一 ID 续聊，再经 `retireSession` 删除；`doubao --list` 不再包含它，OpenAPI 查询返回 HTTP 404 / code 3440008。CLI、OpenAPI 的单次任务结束后也都自动删除，删除接口返回 HTTP 200 / code 0。仅使用本次创建的临时会话。
- `doubao-cli.ts` 启动时忽略 stdin：2.31.2 无法把 Node 子进程默认的 socket 接为标准输入，原来的启动方式报“无法连接标准输入”。`spawn.ts` 增加可选的 stdin 模式，其余调用仍默认管道。CLI 仍按 `doubao` 命令识别，不依赖安装包的名称。
- `doubao.ts` 创建或恢复会话时发出 `session` 事件，修复创建成功但读取回复失败后外层拿不到 ID、未清理的遗漏；假接口覆盖流 HTTP 503、回复失败，以及续聊 / 保留会话不删。
- 全量检查的测试脚本修正：假 osdk 用 shell 参数展开取得自身目录，避免测试收窄 PATH 后找不到外部 `dirname`。

## 11-03：需求页切换空间

- 空间选择先退出旧需求和编码详情，再切换空间，避免页面重建后加载旧需求，把空间切回去；直接打开跨空间需求链接仍切到需求所属空间（`web/src/App.vue`）。
- 需求树和详情忽略过期请求的结果及错误；页面卸载时移除事件订阅并清理定时刷新，旧页面不再改动当前空间（`web/src/views/Requirements.vue`）。

## 11-03：编码交办“等谁”分开，助手马上被叫醒

- 修改项新状态“等助手处理”（`assistant`）：被挡住、缺外部字段、验证 3 次没过、连续 3 轮没轮到、评审负责人没裁决都进这里，不再显示成“等你决定”、不发卡片；“等你决定”只留给带选项的业务取舍（`report_task(owner)`、`settle_code_task(owner)` 没选项会被拒绝）。旧数据的 `owner + blocked` 迁移成新状态（`src/core/db.ts`）。
- 一项变成“等助手处理”时宿主马上叫醒发起交办的助手（`code-chain.ts` 的 `wakeAssistantForTasks`，同一交办同时一轮，可回答 QUIET），不等交办停下；交办停下时叫醒它的消息由宿主写明停下的原因和现在等谁（`stopText`）。
- 宿主限制助手（`code-loop.ts` 的 `settleTask`）：同一项最多 retry 2 次；不能替本人决定；retry 只在自动推进的轮数内开下一轮（`advanceWork`）。
- 运行页轮次多时，较早的轮收进“更早的轮”下拉（`web/src/views/Runs.vue`，和 WorkPane 一样）。
- 角色、工具、唤醒和全部限制的表：docs/v2/coding-loop.md 3.1。

## 11-04：外部 Agent 的工具调用留痕

- 经 `/mcp`、`/api/tools` 进来的每次工具调用，到达和返回时在它的运行上各记一条 `tool-call`（工具名，`omem_call` 写成 `omem_call → 实际工具`；返回时带耗时和是否成功）；超过 60 秒的在服务日志里另记一行。Agent 显示某个调用一直没回时，看有没有“到达”就能分清：没到 omem、卡在 omem 里，还是回去的路上慢（`src/server/http.ts`）。
- 令牌无效的调用在服务日志里记一行：令牌只在内存里，服务重启前开的 Agent 会话还拿着旧令牌。
- 启动时整理修改项：已经不等本人的项关掉旧卡片；等助手处理的项叫醒发起交办的助手，没有助手的交办交给本人（`code-loop.ts` 的 `reconcileWaiting`）。
- 服务重启不再打断交办：停止时正在跑的运行因为会话被关掉而出错的，留在“进行中”，下次启动重新排队（`runs.ts` 的 `stopWorker`）；以前这类运行会记成失败（“ACP connection closed”），交办停住。
- 编码写完后被重启打断的一轮，重新开始时沿用写好的代码，接着验证和阶段评审；以前它被当成“没有要编码的项”的一轮跳过阶段评审，直接判为完成（`code.ts` 的 `ranBefore`）。只有真的做了回退的一轮才不再做阶段评审。
- 运行页修改项面板加“重新评审”（`POST /api/runs/:id/review-again`，`code-loop.ts` 的 `reviewAgain`）：评审被打断、或想再看一遍时，开一轮只做评审，看最后一个检查点之前到现在的改动；发出的“确认并推送”卡片失效。
- 启动时整理修改项也处理已经确认（推送）或丢弃的交办：还挂着的卡片关掉，项记成不做。

## 11-04：检索重排

- `src/search/rerank.ts`：可选的本地重排（默认关），bge-reranker-v2-m3 的 q8 ONNX 经 transformers.js 运行，osdk 别名 `rerank-m3`（`osdk.toml` 锁定版本）。`search()` 融合后把前 `rerank.top` 条（默认 20，读整块片段）重新排序，命中带 `rerank` 分数；调用排队，超过 `timeoutMs` 保持融合顺序；`search(..., { rerank: false })` 跳过。`embeddings.ts` 的 `loadLocalModel` 让本地目录的模型逐个加载（transformers.js 的本地路径是全局设置）。
- 对话前带上记忆（`memory/passive.ts`）：开着重排时余弦 ≥ 0.4 的最近 20 条交给重排，过 `rerank.passiveThreshold`（0.5）才带上，`score` 是重排分数；最多等 3 秒，重排没给结果时退回余弦门槛。
- 设置：`omem setup rerank [--model] [--threads] [--off]`、setup 向导的“重排模型”；网页 设置 → 检索 的“重排”卡片（`GET /api/settings` 多了 `rerank` 状态：加载情况、调用次数、超时次数、上一次耗时），改动不用重启。
- 评测：`eval-retrieval.ts --rerank [模型] --rerank-top --rerank-tokens --model`，`eval-recall-gate.ts --rerank`；T2 子集 nDCG@10 86.61 → 91.58（docs/v2/evaluation.md）。`test/rerank.test.ts`。

## 11-04：卡片点击先回应、会议没开 AI 纪要、豆包

- 飞书卡片的按钮要在约 3 秒内回应：回答要做的事超过 2 秒（确认交办会推送分支），先回“收到，正在处理”，做完卡片再更新（`lark-asks.ts` 的 `ANSWER_WAIT_MS`）。以前推送慢时飞书显示“服务未响应”，其实推送照常完成。
- 机器人入会因会议没开 AI 纪要失败（飞书 10022）时，通知说清楚要主持人打开 AI 纪要；之后半小时内每分钟自动再拉一次，入会后再通知一次（`lark-meetings.ts`）。飞书给 omem 的会议信息里没有“是否开了 AI 纪要”，只能靠入会结果判断。
- 豆包会话清理每次都写一行状态：删了哪个会话、经哪个应用，或者为什么没删；豆包 CLI 的说明里加上“这一轮自己做完，不开子 Agent，原件先 search 再按需读”（CLI 没有关子 Agent 的参数）。
- 会议旁听不再在会上打扰本人：会中各段的运行没有 notify，和本人有关的事写在它的回答里；会后的纪要收齐这些（`heldNotes`），先列和本人有关的、再写结论与待办、最后是处理建议。纪要发到本人和主机器人的私聊（当前的会话），最值得做的 1–3 条用 suggest_next 做成按钮，点了或直接回复就由助手接着处理；找不到私聊时照旧作为通知。智能体运行的输入可以带 `denyTools`（`jobs.ts`）。

## 11-04：飞书文档按块编辑、lark-cli 1.0.98

- `@larksuite/cli` 1.0.97 → 1.0.98、`@larksuiteoapi/node-sdk` 1.74.0 → 1.76.0。
- 新工具 `lark_doc_fetch`（飞书分组）：以本人身份 `docs +fetch --detail with-ids`，可按 outline / section / range / keyword 读一部分，拿 block id；只读，不存原件。外部 Agent（`--peer`）用不了。
- `lark_doc_update` 加 `block_replace`、`block_insert_after`、`block_delete`、`block_move_after`、`block_copy_insert_after`（参数 `block_id`、`start_block_id` / `end_block_id`、`src_block_ids`、`revision_id`），`content` 在这些命令里可省略或默认 DocxXML；返回结果、新 block、飞书的提示。块操作沿用追加 / 局部替换的批准（`commands` 仍记为 append、str_replace），旧批准照样覆盖。以前只有追加、替换一段文字、整篇覆盖，改表格只能整篇覆盖。
- 内置技能 `lark-docs`：读 → 按块改 → 重读核对的做法、表格怎么改、新建文档；`references/` 里的 DocxXML / Markdown 写法由 `scripts/sync-lark-skills.ts` 从 lark-cli 自带的说明（`lark-cli skills read lark-doc/...`）同步。主助手改文档前先读它。lark-cli 的其他技能（lark-im 等）是本人身份的命令行做法，omem 的写入走工具，不内置。

## 11-04：工具按用途分组

- `TOOL_GROUPS` 从 10 个按领域的大组拆成 19 个按用途的小组：`read` / `collect` / `curate`（原 sources）、`track` / `notifications`（原 items）、`delegate` / `skills`（原 agents）、`ask` / `wake`（原 owner，`notify` 移到 ask）、`coding` / `git` / `code-handin`（原 code）、`lark-msg` / `lark-docs` / `lark-capture`（原 lark，`lark_wiki_crawl` 移到 collect）；memory、wiki、learning、plugins 不变。每组带 `doc`，几组共用原来的 reference 页，`omem_help` 填分组 id 或说明页名都行。
- 旧分组名不再兼容（11-04 去掉 `GROUP_ALIASES`：常驻服务器上自定义过的主助手已是新分组名，档案都没用分组）。主助手的 `tools:` 改成新分组。
- `test/tool-help.test.ts`：每组不超过 15 个工具（插件组除外）、每组都在 SKILL.md 分组表里。
- `DIRECT_ALL` 20 → 30：常驻服务器上 ingest（21 个工具）两周调了 750 次 `omem_help`、自定义档案（28 个）343 次、dream 6 次，都是工具数刚过线、非常用工具藏在 `omem_call` 后面造成的。`CORE_TOOLS` 加 `list_sources`、`write_file`、`list_runs`、`read_run`、`wake_later`、`cancel_wake`（主助手和档案运行里最常经 omem_call 调的几个）。
- 按两周的调用统计精简内置角色：triager 去掉 source_outline、list_pages、recall、list_items（2810 次运行里没用过，说明里也没提）；kb-scout 去掉 search；memory-reviewer 去掉 list_items。

## 11-04：以本人身份读写飞书的其他数据

- 新工具 `lark_read` / `lark_write`（分组 `lark-owner`）：以本人身份跑一条 lark-cli 命令，风险等级取 lark-cli 自己在 `--help` 里标的 read / write / high-risk-write（缓存）。read 在数据域里放行（不含 api、auth、config、event、apps），`skills read/list`、`schema` 也能读；write 只放行 sheets、base、slides、markdown、task 和 drive 的评论命令，本人自己的文件直接写（新建到云空间根目录也算），别人的文件和所有任务操作先审批，按文件复用（`docEditDecision` 加了 tool 参数）；命令里必须出现 target 的 token；high-risk-write、`--as`、`--yes` 拒绝；在临时目录里运行，下载的文件运行后删除。外部 Agent（`--peer`）用不了。
- 内置技能 `lark-suite`：按业务列出要读的 lark-cli 官方说明（lark-sheets、lark-base、lark-task、lark-drive、lark-im、lark-mail、lark-meeting、lark-workflow-meeting-summary……）和这里能读 / 能写什么；官方说明不复制进仓库，运行时用 `lark_read(["skills","read",…])` 读，和装的版本一致。lark-shared 的登录、授权、高风险确认由 omem 处理，不需要。
- AGENTS.md 的“以本人身份写飞书只有这几处”补上 `lark_doc_*` 和 `lark_write`；仍不能以本人身份发消息、邮件和日程邀请。
- `lark-cli.ts` 加 `larkCliOutput`（`--help`、`skills read` 这类输出文本的命令）。

## 11-04：额度用完自动换后端

- 问题：常驻服务器上 Codex 额度用完，每个运行都先试 Codex 再失败（“Internal error”），没有换到配好的兜底。codex-acp 2.5.0 把“You've hit your usage limit … try again at 2:36 PM.”作为回答文字发出，再以 JSON-RPC internal error 结束这一轮，`data` 里是 `codexErrorInfo: "usageLimitExceeded"`；原来的重试判断只认限流、排队。
- `acp.ts` 的 `promptError`：把 JSON-RPC 的 `data` 拼进错误信息，额度用完的标成 `quota`（`AgentFailureKind` 新增）；`isRetryableAgentError` 认 `quota` 和 `isQuotaMessage`（usage limit、insufficient_quota、out of credits……）。
- `capacity.ts`：`markOutOfQuota` 按来源记到 kv `agent_quota_exhausted`，恢复时间由 `quotaResetAt` 从消息读（本机时间的“at 2:36 PM”取下一次、带日期的、“in 2 hours”，没有就一小时）；`excluded` 在恢复前为真，所以 `acquire`、`fallbackProfiles` 和对话的兜底链都跳过它；`clearOutOfQuota`、`outOfQuotaList`。
- `runner.ts` 的 `noteQuota`：运行和对话轮次遇到额度用完时记下并发状态“… 的额度用完了，<时间> 前自动改用其他后端”；`sessions.ts` 的对话兜底链跳过额度用完的账号（都不可用时仍试第一个）。
- 网页：设置 → Agent → 并行 显示“额度用完”的账号和恢复时间，`DELETE /api/agents/quota/:source` 提前恢复。
- 剩余额度：codex-acp 只在 `/status` 命令的文字里给出各窗口的剩余百分比，不经 ACP 推送，这里不读它。
- 测试：`test/quota.test.ts`，假 ACP 加 `FAKE_QUOTA=1`。

## 切换、卡片与后台接续修复（2026-11-04）

- 运行详情和评审、Wiki、原件、事项、问答待确认列表、Agent 档案与规则详情丢弃旧请求的迟到结果，旧请求也不能结束新请求的加载状态。
- 飞书确认卡片不等待联系人查询；需执行宿主操作或批准工具时，先保存回答并返回回调，再执行后续操作，避免同步 Git 操作阻塞回调的超时计时器。后续失败写回卡片结果。
- 整群共用会话时，记录最近消息的话题位置；后续回复、通知和确认卡片沿用该位置。本人回到群外层发消息后恢复外层投递。独立话题会话仍分别投递。
- 新编码分支从 origin 声明的默认分支最新提交建立；正常续轮同步工作分支，omem 新建的分支再并入它切出的分支（`cutFrom`），本人选的已有分支（如发布分支）只跟它自己的远端，不并入默认分支；冲突沿用编码 Agent 处理流程。读取或更新远端默认分支失败时停止，不按旧版本继续。没有远端的仓库使用本地默认分支，没有默认分支才使用 HEAD。
- 规则助手自唤醒继承原运行的空间、工具限制、渠道范围和执行配置；唤醒其他档案不继承这些权限。

## 11-04：网页版 VS Code 复用已下载服务端

- `src/server/ide-web.ts`：启动时选最近下载完整的服务端，通过官方 CLI 的 `--commit-id` 指定版本；所有项目共用，不再在打开项目时追踪最新版。中断下载的 `.staging`、缺少 Node、服务端入口或启动脚本的目录不参与选择。
- 首次没有缓存时，准备页改为后台检查并显示等待秒数；准备好才刷新进入工作台。HTTP 错误、连接失败或超过 10 分钟后停止检查，显示原因及“重新检查”；保留 serve-web 在准备响应中设置的 cookie。
- HTTP 集成回归覆盖跨项目、重启复用完整缓存，排除不完整目录，等待响应与 cookie。Playwright 验证等待不导航、成功进入、服务端报错以纯文本显示、超时停止、断网和重试；1440 / 390 宽度无横向溢出。真实官方 CLI 复用缓存，约 1 秒返回工作台。
- 验证：独立临时目录、`LANGUAGE=C LC_ALL=C.UTF-8` 下 `pnpm run check` 通过（134 个测试文件、778 项测试、类型检查与构建）。

## 审查修正：续轮同步、卡片与网页版 VS Code 下载（2026-11-05）

- 编码续轮只把 omem 新建的分支并入它切出的分支（`wt.cutFrom`）；本人选的已有分支（`fromBranches`，如发布分支）只拉自己的远端，不再每轮并入默认分支（`src/agents/code.ts` 的 `syncPhase`，`test/code-sync.test.ts`）。
- 飞书卡片操作：联系人查询在回调里最多等 300 毫秒，超时先用 id；“只有 … 可以处理”恢复显示名字；交给对话的“[卡片操作]”在回调返回后再查名字（最多 5 秒），Agent 看到的是名字（`lark-actions.ts`，`test/lark.test.ts`）。
- 提问卡片关闭时只更新真正发出的那张（有 message_id 的记录，优先未处理的）；卡片回答等待 `ANSWER_WAIT_MS` 改为 800 毫秒，比整个回调的 `CALLBACK_WAIT_MS`（1 秒）短，慢回答也带着更新后的卡片返回。
- 飞书会话的下一步按钮和规则确认卡片在回复送达后展示，另有 60 秒兜底（`LARK_SUGGESTION_FALLBACK_MS`）：回复没发出去时按钮不丢，已展示的不重复（`test/rule-confirmation.test.ts`）。
- 网页版 VS Code：服务端由 omem 自己下载（`src/server/ide-download.ts`）：查更新服务的最新版本，流式下载并显示进度（已下载 / 总大小、速度、剩余时间），按公布的 SHA-256 校验，解压后放进 serve-web 的缓存目录，用 `--commit-id` 运行。已有完整版本时直接进入，serve-web 启动一分钟后（之后每天最多一次）在后台下载新版本，下次启动 serve-web 时使用，旧版本在不再运行后删掉。`ide.web.updateUrl: "off"` 时交回 serve-web 自己下载。Windows 上用系统的 bsdtar 解压 zip（Git 自带的 GNU tar 读不了 zip，也会把 `C:` 当成远程主机）。
- 验证：`test/ide-web.test.ts` 用假更新服务覆盖首次下载的进度、下载中其他请求 503、完成后进入、后台更新不影响正在运行的版本、下次启动换新版本、清理旧版本；本机用官方 1.145.0 Windows 包（211 MB，SHA-256 与公布值一致）经 omem 下载解压后，真实 `code-tunnel serve-web --commit-id` 直接返回工作台，没有再次下载。

## 多人登录（2026-11-05）

- 设计与分期：`docs/v2/multi-user.md`。这是第 1 期：登录与会话。
- `src/auth/`：`providers.ts` 登录方注册表（授权地址、换令牌、`whoami`，身份由服务端拿令牌查，不信浏览器）；`lark.ts` 用机器人应用做飞书 OAuth（`authen/v1/authorize` + PKCE、`authen/v2/oauth/token`、`authen/v1/user_info`），身份是 union_id，本应用的 open_id 记成别名；`login.ts` 登录 / 绑定 / 待批准 / 邀请 / 机器人一次性链接；`sessions.ts` 会话 cookie（`omem_sid`，只存哈希）；`http.ts` 的 `resolveAuth`（令牌 → 会话 → 本机）和相关接口。
- 迁移：`users` 加 `kind`、`status`（pending）、`email`、`avatar`；`identities` 加 `kind`（login / alias）、`tenant`、`app_id`、`display`、`verified_at`，已有的飞书 `ou_` 身份改成 alias；新表 `auth_sessions`、`auth_states`、`invites`、`login_links`（本机的，不参与拉取）。
- `resolveIdentity`、`userForToken`、`accessibleSpaces`、`canWrite` 不认待批准的用户。机器人给用户发私聊改用 `larkOpenIdOf`（只取机器人应用里的 open_id 别名）。
- 配置 `auth`：`enabled`、`providers`、`primary`、`signup`（按登录方：approve / closed / open）、`sessionDays`。打开后 `trustedLocal(..., { refuseProxied })` 把带 `X-Forwarded-For` / `Forwarded` / `X-Real-IP` 的请求排除在本机信任之外（插件流、网页版 VS Code、`omem peer open` 同样）。
- HTTP：`/api/auth/session`、`/api/auth/:provider/start|callback`、`/api/auth/link/:code`、`/api/auth/logout` 不经统一鉴权；`/api/auth/account`、会话和身份的删除给每个人；`/api/users`、`/api/invites`、`/api/auth/providers` 只给本人。待批准和受限会话只能访问 `/api/me` 和 `/api/auth/*`（403 带 `code: pending|restricted`）。成员可以 GET `/api/spaces`（只列能读的）。
- 网页：`/login`（不带外壳）、`/account`、设置 → 成员；401 带 `login: true` 时跳登录页而不是要令牌。命令：`/login`；`omem user approve`、`omem user invite`。

## 交办不在细枝末节里打转（2026-11-05）

- 起因：常驻服务器上一次桌面工具的交办，需求的 6 项第一晚做完，之后两天 43 轮、49 个评审修改项几乎都在磨 MCP stdio 层的请求 ID 复用、取消竞态和输出背压，同一处连着修了十层，源码安装和二维码登录实测一直没做。
- 评审负责人（`TASK_RULING`、`roles/review-lead.md`）先问问题和需求、和代码实际用法的关系；碰不到的 `rule_review` 用 `defer` 记成以后再做（finding `decision = later`，修改项 `wontdo` + `origin.later`）。没改好 / 改出新问题的带 `follows`，`followDepth` 超过 `MAX_FOLLOW_DEPTH`（2）的新项交给助手。评审项的说明也要求先找影响验收和实际用法的问题。
- 可交付点（`WorkState.deliverableAt`）：需求本身的项都完成、检查通过的那次阶段评审；之后的阶段评审还有评审项待做时发一次 `work-deliver` 卡片（先推送验证 / 剩下的以后再做），不暂停。之后 `POLISH_STAGES`（3）次阶段评审仍有新问题就暂停 `polishing`，助手接手。
- 推送不结束交办：`deliverBranchWork` 推工作分支（一轮在编码时推最近一次阶段评审的检查点），`apply_code_run` 的 `keep_going`，记在 `WorkState.delivered`。确认时还在等本人的项记成以后再做。
- 接续：`delegate_code` 在已有分支上、`startFix` 的“接着改”新交办时，`carryTasks` 把之前确认过的交办没做完的项接成待做、以后再做的照样列着，旧项记“接到交办 X 的 Tn”。第一轮全是接续项时编码 Agent 仍先 `plan_tasks` 拆这次的任务。
- 助手：停下的消息带 `goalText`（原任务、需求项与评审项进展、轮数、推送）；两种交给助手的说明改成“你是发起人不是转发人”，按原需求判断、用本人的话、不写 T 编号；`settle_code_task` 加 `later`（评审提的待做项可以直接放下，需求本身的项要本人原话）。
- 运行页和飞书进度卡片显示“以后再做”和新的暂停原因。

## 交办的汇报跟着本人换会话（2026-11-05）

- 现象：话题群里在第一条话题交办，本人之后在第三条话题里接着说（助手 `message_code_run`），每轮结果、“有修改项等你处理”、助手的接手汇报和卡片仍发回第一条话题。原因是这些都用 `chain.conversationId`（发起时的会话），只有交办整体移到工作话题时才换。
- `code-chain.ts` 的 `reportConversation` 导出，顺序是本人最近调整交办的会话（ask 运行的 `output.codeReportTo`）→ 工作话题 → 发起的会话；`followOwner` 在 `message_code_run`、`continue_code_run`、`fix_review`、`settle_code_task`、`apply_code_run` 成功后由 `runTool` 调用（`STEERS_CODE`），从调用它的 ask 运行取会话，只认本人自己的会话；换过去时工具返回里提醒助手说一声进度卡片在原话题。
- 结果记录直接写到汇报会话（`settleCodeChain`），交给助手时按消息实际所在的会话判断要不要搬；卡片（`askDeliver`、`ensureOwnerAsks`、`askPlan`、`askRetry`、`askConfirm`、`escalate`、同步冲突）都改用它。
- 验收 R27k；测试 `test/code-loop.test.ts`“reports to the conversation the owner last steered…”。

## 角色与权限（2026-11-05）

- `src/auth/permissions.ts`：全局权限与空间权限清单、内置角色（`BUILTIN_ROLES`）、自定义角色（新表 `roles`，随拉取同步）、`can` / `spacesWith` / `requirePerm` / `canReadRun` / `runReadableSpaces` / `globalPerms`、改动记录（新表 `audit_events`，本机的）。`accessibleSpaces` = `spacesWith(space.read)`，`canWrite` = `can(memory.write)`；旧的空间 owner 成员迁成 manager。
- `src/auth/routes.ts`：每个 `/api` 路由要什么（public / self / owner / 全局权限 / 某空间的权限 / 能读这条运行），`server/http.ts` 的 `preHandler` 统一检查；`MEMBER_ROUTES` 删掉。`test/permissions.test.ts` 用 `registeredRoutes` 检查全部登记。
- `runs.scope`：`createRun` 记下这条运行最多能读的空间；`listRuns` 的 `visibleTo`。事件流按人过滤（运行、通知、提问、插件会话、空间变化）。`listNotifications` / `markRead` 按人。
- 删除别人的对话、读别人对话里的消息现在返回 404（以前成员能删任何对话）。成员 GET `/api/memories`、`/api/memory-folders`、`/api/memory-tags` 不带空间时只含能读的空间。
- `src/auth/tools.ts`：编码、Git、采集设置、规则、档案和技能保存等工具要对应的全局权限；`runner.ts` 建工具清单时去掉，`callTool` 再查一次。`write_page` / `move_page` / `confirm_page` / `generate_wiki` 和 Wiki 规划运行要 `wiki.write`。
- 新接口：`/api/access/roles`（列出、建、改、删）、`/api/access/audit`、`/api/spaces/:id/members`（空间管理者）、`PATCH /api/users/:id` 的 `role`；邀请可以带全局角色和任意空间角色。成员建空间时成为管理者；关联本机目录要 `code.delegate`。`/api/me` 带 `perms`、`writes`、`wiki`、`manages`。
- 网页：导航按权限显示；设置 → 成员 加全局角色、空间角色、角色编辑和改动记录；账号页“我管理的空间”。

## 评审问题正文里的原件引用也要存在（2026-11-05）

- 现象：一条评审问题正文里的 PRD 链接点开报“原件不存在”。评审项抄原件 id 时中间漏了三个字符；`submit_review` 只核对 `evidence` 和变更点的 `refs`，正文里的链接没有核对。
- `review.ts` 的 `inlineRefs` 取出 Markdown 里的 `src:` / `mem:` 引用；`submit_review`（问题的标题、正文、建议，变更点的需求和实现）、`submit_change_points`、`revise_finding` 都用 `deadRefs` 核对，找不到就拒绝并让它用 `read_source` 核对后重交。
- 另有一种：引用了交办工作区里建了索引的文件，工作区归还后这些原件随之删除，链接也会失效；还没处理。

## 审查修正：交办暂停后的收尾、裁决改口、汇报会话（2026-11-05）

- 暂停后没有可做的：`advanceWork` 原来先看 `paused` 和轮数，助手把“只剩打磨”或轮数用完时剩下的评审项都 `later` 后交办一直停着，不出确认卡片（只有本人的操作会经 `renewBudget` 清掉暂停）。现在只在还有可做的项时才被暂停和轮数挡住；没有可做、也没有等谁的项时清掉暂停，照常 `completed`。
- `work-deliver` 卡片（需求做完了）在 `completed`、`confirmBranchRun`、`discardCodeRun` 时关掉，不再一直挂着、点了报错。
- 可交付点：`deliverableStage`（`code-tasks.ts`）在需求本身的项又有没做完的（本人加了一项）时作废，做完再重新记；打磨的次数从可交付点和上次打磨暂停里较晚的那个数起。原来可交付点只记一次，本人加的需求一做完，第一次阶段评审就会因打磨暂停。
- `applyRulings`：评审负责人在同一轮里对同一条问题先 `defer` 再改成别的裁决，`decision = later` 不再留着（原来会让接受的问题变成以后再做，连带丢掉给本人的问题）。
- `followFrom`：只有本人在这一轮说了话（`ownerAskedThisTurn`）才改汇报的会话。原来交给助手的一轮、唤醒、规则触发的运行调用 `settle_code_task` 等也会改，还排在第一条话题里的交接会把汇报拉回去。
- 验收 R27l；测试 `test/code-loop.test.ts` 新增四个用例，“reports to the conversation…”补了交接一轮的情况。

## 连接器与飞书多用户（2026-11-05）

- `src/auth/vault.ts`：连接（每人每个提供方一条）与令牌，存 `secrets/vault.db`，令牌 AES-256-GCM（`secrets/vault.key`）。`connections.ts`：`saveConnection`、`accessToken`（到期前 10 分钟刷新，同一连接串行）、`renewConnections`（刷新令牌两天内到期的续一次，接在 lark-poll 定时任务后面）、刷新失败标 `expired` 并通知一次。`features.ts`：飞书功能与 scope。`LoginProvider.refresh`（飞书 `authen/v2/oauth/token` 的 refresh_token）。
- 登录流程加 `purpose=connect`（要 `connector.use`；`features` 或 `scopes` 决定要哪些 scope）；登录或绑定时令牌带 scope、带刷新令牌或已经有连接，就存下来。接口：`GET /api/auth/connections`、`DELETE /api/auth/connections/:provider`。
- `lark-cli.ts`：`larkActor`（AsyncLocalStorage）与 `setLarkCredentials`；在某人的上下文里 `larkCli` 用 `LARKSUITE_CLI_APP_ID` / `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_BRAND` 跑。`lark-user.ts` 的 `asLarkUser`；`tools.ts` 的 `runTool` 把每次工具调用包进去，`ownerOnly` 改为“本人，或有 `connector.use` 且连接可用的人”。`asOwner` 在成员上下文里给成员发账号页授权链接；`personalLibrary` 按人缓存；`lark_write` 判断“是不是自己的文件”用这个人在机器人应用里的 open_id。
- 去重：迁移给 `sources` 加 `origin_key`（`upsertSource` 用 `originKeyOf` 填，旧数据按 URI 和 `documentId` 回填）、新表 `source_viewers`、`lark_message_lines`（按原件记消息的行，从 `lark_messages.source_id/line` 回填；拉取不带，回落到旧列）。`persistChatMessages` 加 `userId`：本人照旧写进聊天已有的副本，别人只写自己空间里的副本。`captureSpace(app, chatId, userId)`：绑定和已有副本只在采集者有 `capture.route` 的空间才用，否则进他的个人空间。成员导入一篇已在他能读的共享空间里的飞书文档时只记 `source_viewers`。
- `src/channels/lark-member-capture.ts`：开了“我的消息”的成员，每次 lark-poll 后以他的身份读最近活跃的 30 个会话（游标在 kv `lark_member_cursor:<用户>:<会话>`），已有可读共享副本的只记 `source_viewers`。开了日程、妙记、文档的，接着跑 `lark-personal.ts` 的 `captureCalendar` / `captureMinutes` / `captureRecentDocs`（带 `who`：写进他的个人空间，kv 状态键加 `:<用户>`，不占本人的每小时检查）；`capture-space.ts` 的 `sharedCopyFor` 找他能读的共享副本并记下（聊天也改用它）。
- 按读者分开：`lark-docs.ts` 数正文里嵌进来的表格和同步块，有的话 meta 记 `perReader` 和 `capturedBy`，`originKeyOf` 给 `lark:doc:<id>#<用户>`，不会被当作共享副本给别人用。多维表格只存链接，没有要分开的。
- 检索：`search.ts` 按 origin_key（去掉 `#` 以后）合并，留排名最高的一份，`Hit.elsewhere` 列出其余；`SearchOptions.visible`（`visibility.ts` 的 `hitFilter`）让读者看不到的副本在合并前去掉。`search` 工具输出“同一个聊天或文档另有 N 处”，命令面板显示其余几处的空间名。
- 对着真实飞书接口用假令牌核对过返回（2026-11-05）：令牌接口失败是 `{ error: "invalid_grant", error_description, code }`（授权码 20003、刷新令牌 20026），`user_info` 的坏令牌是 HTTP 200 加 `code: 20005`，文档权限接口路径存在（坏令牌 99991668）。据此改了两处：刷新只在 `invalid_grant`（`providers.ts` 的 `GrantRejected` / `grantRejected`，插件的 `refresh` 也这样表示）时标为需要重新授权，网络或飞书出错返回 503、连接不动，下次再刷；文档阅读权限只记飞书真正给出的答案，调用失败（连接过期、缺权限、网络）不记成“不能看”，十分钟内不重复问。lark-cli 1.0.98 以成员身份调用（`LARKSUITE_CLI_USER_ACCESS_TOKEN`）时确实把这个令牌发给飞书、不用本机登录，`auth` 命令在这种方式下不可用；令牌被拒时退出码 3、stderr 里是 `authentication` / `token_invalid`（99991668）。以前这类错误可能被说成“请执行 lark-cli auth login”；现在在成员的调用里改说他的授权不被接受，并把令牌标为过期（`staleToken`），下一次先刷新。用假凭据从 `asLarkUser` 一路走到真实飞书核对过：被拒 → 标为过期 → 刷新被拒（20026）→ 连接变成需要重新授权。
- 机器人检查（`lark-bot-check.ts`）：`checkLarkApp` 带回应用已有的全部 scope（`grantedScopes`），主应用的结果多一项 `members`：连接功能（`features.ts`）要用、应用还没有的用户身份 scope，涉及哪些功能，`token_type=user` 的申请链接；设置页“机器人权限与事件检查”和远程命令 `lark-bot-permissions` 都带上。成员打开这些功能时就不会撞上 20027。
- 授权页地址里 scope 之间用 `%20`（飞书文档的写法；`URLSearchParams` 会写成 `+`）。用真实应用打开授权页（不登录）：回调地址没加进“重定向 URL”时飞书先报 20029，scope 的检查在这之后，要加上回调地址才看得到。
- 向量：`embedPending` 先找正文和标题都相同、已有向量的切块，复制过来；同一批里相同的输入只算一次。迁移加部分索引 `chunks_text_head`（长度 + 开头 80 字，只含有向量的切块）。
- 网页：账号页“已连接的应用”（按功能打开、重新授权、断开、缺权限的授权提示）；本人那里只说明用 lark-cli 登录。

## 插件连接器（2026-11-05）

- `src/plugins/types.ts`：`PluginApi.connector(def)`（`LoginProvider` 加 `features`）、`PluginContext.connection(provider)` 返回 `{ account, scopes, fetch }`。清单加 `connectors: [{ provider, features }]`，`describePlugin` 带出来。
- `registry.ts`：`api.connector` 检查 id 前缀、注册 `registerLoginProvider` 和 `registerFeatures`，`unloadCode` 时撤销。`LoginProvider.apiBase`；`connections.ts` 的 `pluginConnection` 只往 `apiBase` 下发请求（不跟随重定向）。
- 账号页列出所有有功能的提供方（不只是登录方）；插件页在清单要的连接缺失时显示提示条。

## 多服务连接（2026-11-05）

- `src/core/federation.ts`：服务账号（`serviceAccount`，`users.kind = service`，角色 viewer，没有个人空间）、`peer_shares`、`shareInvite`（`peers.ts` 的 `invite` 可以给服务账号发令牌，标签 `fed:<名字>`）、`sharesFor`（本人的设备看到全部）、`fedSearch` / `fedSource` / `fedChanges`；订阅方 `subscribe`（建或认领只读镜像空间，`settings.mirror`）、`peerSearch`、`peerRead`、`syncSubscription` / `syncAll`、`peer_aliases` 换引用。镜像原件 URI 为 `peer:<设备>:<对方 id>`，带 origin_key。
- 迁移：`peer_shares`、`change_log`（原件、页面、记忆的触发器）、`peer_subscriptions`、`peer_aliases`（都是本机的，不参与拉取）。
- `permissions.ts`：镜像空间里谁都没有 `source.write` / `memory.write` / `wiki.write` / `capture.route`（本人也没有）。
- 接口：`/api/fed/*`（服务账号，按授权）、`/api/peer/shares`、`/api/peer/subscriptions`、`/api/peer/offers/:peer`（`peers.manage`）。`addPeer` 探测地址改用 `/api/me`（服务账号读不了诊断）。定时任务 `peer-sync`（第一次关注同步空间时建，每半小时）。
- 工具：`peer_search`、`peer_read`（分组 read，说明在 `skills/omem/references/sources.md`）。命令：`omem peer share/subscribe/subscriptions/sync`。网页：设置 → 设备 → 和别人的 omem 共享。

## 只对部分人开放的原件（2026-11-05）

- 迁移：`sources.visibility`（space / restricted）、`source_access`（每人对每篇飞书文档的阅读权限，记一天）。
- `src/auth/visibility.ts`：`setVisibility`、`sourceVisible`（同步判断，飞书文档未知时为 check）、`sourceReadable`（用读者的连接调云文档的权限判断接口）、`requireReadable`、`visibleHits`、`keptHere`、`isRestricted`。
- 接入：`checkRoute` 改为异步，`src:` 定位的路由再查一次能否读；`/api/search`、原件列表、工具的 `search`（`viewSearch`）和 `read_source` 过滤；`shares.ts` 不复制、`federation.ts` 不检索不发送不同步这两类；`write_page` 在非个人空间拒绝引用受限原件。新接口 `PUT /api/sources/:id/visibility`（`space.manage`）。`PATCH /api/spaces/:id`：非本人只能改 `larkAccess`，带 `mirror` 一律拒绝（设置页保存时去掉它）。

## 飞书卡片排版、@ 处理人与气泡跟随话题（2026-11-06）

- `lark-send.ts`：`cardText`（卡片 Markdown 的原样文字按 HTML 实体转义，取代反斜杠）、`textWidth`、`buttonRows`（按手机宽度 40 单位分行、各行个数尽量平均，太宽的按钮独占一行 `width: fill`）、`cardMentions` / `mentionInCard`、`larkPrivateChat`（`lark_owner_chat*` 或会话 `settings.group = false`）。`buildCard` 的按钮块走 `buttonRows`；表单由 `formFields` 生成：每个字段上方一行粗体 Markdown 问题（多题自动编号、必填红星），字段 `width: fill`，不再用 input 自带的 label。
- `lark-asks.ts`：选项要么全是按钮（`buttonRows`），要么全是编号行（文字 + “选择”，`vertical_align: center`），不再长短混排；问题有两条以上编号要点时输入框为 `multiline_text`；`askCard(app, ask, { mention })` 在群里开头 @ 回答人（`show` 用已算好的处理人 id，私聊不传）。
- `ThreadSettings.group`：`receive` 在渠道给了 `isGroup` 时记下。
- `tools.ts` 的 `larkPost`：交互卡片带 `allowed`、没给 `mentions`、发往群时 @ 其中本人和 `lark_people` 认识的 id。
- `lark-bot.ts`：`toAsker` 给群里的回答（助理回答、访客回答和拒绝）开头加 `<at id=提问人>`，私聊和机器人发来的不加。
- `lark-cot.ts`：`startCot` 的 `locate`；建气泡前 `GET /im/v1/messages/:id` 看锚点有没有 `thread_id`，有就 `reply_in_thread = true`（普通回复会被飞书放进话题，气泡接口不会）。`lark-agent-cot.ts` 在会话没有话题时传 `locate`。`rules/actions.ts` 记 `lastMessageId` 时一起记 `lastTopicId`。
- 验收见 acceptance.md 同名一节；测试 `test/lark-cards.test.ts`、`test/lark-answers.test.ts`，`test/asks.test.ts` 的排版用例改写。

## 豆包临时会话在重启后继续清理（2026-11-05）

- 修复运行中重启造成的遗漏：旧豆包 CLI 任务仍在云端执行，但 omem 的 `finally` 已丢失；重跑只删除新会话，旧会话留在历史里。
- `dispatch.ts` 拿到临时会话 ID 时即登记 `doubao_session_cleanup`，保存创建时选用的应用、所属运行和 omem 进程 ID；正常清理成功后撤掉记录。聊天、明确保留和续轮不登记，显式退役的旧聊天会话也经同一清理路径处理。
- `doubao-cleanup.ts` 启动时及每分钟恢复：原进程仍活着的临时运行让开，原进程已退出时先查云端状态，等到 idle 再删。删除失败保留记录重试，应用变更后仍用原应用；接口返回资源不存在视为完成。不扫描或批量处理既有账号历史。
- 回归用单独的 Node 子进程拿到 ID 后立即退出，确认清理登记先于退出落盘，再用新的 App 恢复；覆盖云端仍在执行、正常完成、接口失败重试、应用变更、404 和权限查询失败。既有 CLI 临时文件测试改用独立临时目录，避免与常驻服务正在使用的文件冲突。
- 真机：CLI 已创建会话、OpenAPI 返回 in_progress 时退出所属 omem 测试进程，用隔离数据库中的清理记录恢复，等待空闲后删除；最终 OpenAPI 返回 HTTP 404 / code 3440008，CLI 列表不再包含这次会话。该清理表是设备本地的进程状态，快照不携带，覆盖拉取保留本机的记录。

## ACP 与豆包共用会话清理，退役被替换的编码与评审会话（2026-11-05）

- `session-cleanup.ts` 统一登记、释放、重启恢复和失败重试。`session_cleanup` 从前一版豆包清理表迁移，后端与会话 ID 共同定位；凭据从当前配置读取，仅保存原配置指纹，命令或身份配置改变时不改用另一身份清理。该表只在本机保留，不随设备快照同步。
- ACP 单次运行和后台池都在拿到会话 ID 时登记；池内复用和仍需续聊的会话不会被恢复清理。ACP 删除是可选能力：正常释放优先原连接的 `session/delete`，连接已断或重启后重新握手；未声明删除时再走配置的 `archiveArgs`，不按 Agent 名分支，不把协议失败当成不支持而换归档。
- 复看评审会话超过上限后，旧实现会保存新 ID 并遗失旧 ID；`keepSession` 现在将被替换的旧会话交给同一清理流程。编码换后端、上下文超限或恢复失败后成功建立新会话，同样退役登记过的旧会话。仍在使用的会话保持续聊能力；没有可核对后端身份的既有历史不批量推断处理。
- 回归覆盖 ACP 子进程退出后的协议删除与归档回退、协议优先、失败后重试、原配置校验、保留会话不自动清理、评审轮换，以及前版豆包清理记录的迁移；真实 Codex / TraeX：临时任务回答 2 后归档成功；另一轮在模型已经产生回复、会话持久化（archived=0）时退出宿主，恢复清理后均为 archived=1，登记表清空。
- 协议归档被拒绝时保留后端错误的 `data`（例如仍被其他客户端占用），不只写 Internal error，也不绕过协议改用归档命令；记录继续等待重试。模型检测和聊天连接也接入统一登记，聊天仍标为保留。

## 慢检索的索引、空缓存与进程隔离（2026-11-05）

- 根因：全范围检索逐空间加载向量，空间计数缺少匹配索引，空空间每轮重新扫描；空结果不经过分页让出的路径，多个同步查询连续占住主线程。修复不依赖材料类别、项目或具体查询词。
- 迁移加 `chunks_vector_space(space_id,id) where embedding is not null`；`vectors.ts` 缓存空结果，新增向量能直接补入，加载前及空间之间让出事件循环，失效的加载提前结束。
- `read-process.ts` / `read-worker.ts` 以只读 SQLite 连接执行检索。SQL、向量、重排分别复用子进程，排队计入时限，执行超时杀掉进程；不同通道互不占住，超时保留其余通道结果。向量新增只同步同一数据目录的进程，删除、空间迁移与模型变更保持失效；服务 / 数据库关闭和父进程退出时回收，空闲五分钟自行退出。
- `trace.ts` 记录查询摘要与分段耗时；`http.ts` 将检索关联到调用工具的运行。日志与诊断不包含查询原文；`toolLatency` 纳入 `tool-call`，与同一运行的 Agent 展示事件按工具名去重，保留原生文件与命令工具。
- 回归覆盖空空间首个向量、查询计划、重复加载、事件循环、硬超时、排队取消、HTTP 响应、只读拒写、后续重建、空间过滤与向量通道回退。规模和公开数据对照见 `docs/v2/evaluation.md`。

- 本机复查发现后台本地向量编码的 ONNX 推理也会占住主线程，补为独立编码进程；批量编码最多 120 秒，问题编码与检索共用交互通道、最多 30 秒。先在进程里确认模型可加载，再允许宿主切换模型并清空旧向量；数据库写入仍由宿主完成。加载期间新增向量按当时的游标决定是留待追加还是由后续分页读取，避免重复入缓存。
- 启动时的向量预加载同样转到检索进程，宿主不再保留一份重复矩阵。

## 2026-11-05：飞书完整复制与节点授权

- 新增 `lark_doc_copy`，专用入口调用官方 `wiki +node-copy`，共享目标可审批后执行，不再因通用读写工具的风险分类直接拒绝；原文档保持不变，返回副本节点供核对。
- 新增 `lark_doc_authorize`：本人指定知识库节点和 create / copy / edit / move，批准覆盖节点及所有后代（含未来页面），供后续会话和定时规则复用。执行按实时祖先链核对，移动两端须在范围内，整篇覆盖另批；用户、操作隔离及最新拒绝继续生效。
- 文档写入审批卡私发本人，回答仍归原任务；外部 Agent 禁用新增入口。工具分组、主助手和内置文档技能已同步。
- 假飞书回归覆盖复制审批、节点授权复用、移出范围、同名与跨知识库节点、循环与快捷方式、操作隔离、拒绝及私聊投递。
- 真实 Codex（gpt-6.1-sol / low）在隔离库验证先授权后复制、下一次复用授权，两次复制仅一张审批卡，均回读核对；飞书调用为假客户端。
- `LANGUAGE=C pnpm run check` 通过：862 项测试、类型检查及构建；固定语言用于避开本机 Git 中文诊断对既有推送测试的影响。

## 2026-11-05：规则气泡与失败投递

- Agent 动作新增 hideThinking 和 failureTo（本人 / 群聊），成功回复方式独立；规则 Agent 与后端异常通过 report_rule_failure 按原规则报告，最终回答不重复发回群里，并发只报告一次。群投递失败时通知本人；启动前失败同样通知，真实任务队列回归覆盖。外部调用不能使用该入口。
- 完整复制修正为目标父节点与目标知识库二选一，兼容 CLI 的互斥校验；回归核对两种目标参数。
- 全量检查通过（872 项测试）；真实 Codex 在隔离库确认模拟复制失败只通过 report_rule_failure 通知本人一次，不向群发消息。

## 2026-11-05：旧交办同步与应用

- 旧交办“移到目标分支最新提交”默认 merge，网页和工具支持显式 rebase；目标已包含时直接跳过，保留工作区全部改动。显式 rebase 使用实际共同祖先，避免从过时切出点重放已有历史。入口：code-sync.ts、code.ts、server/http.ts、tools.ts、Runs.vue、WorkPane.vue。
- 应用时按祖先关系接受已同步历史中的目标位置及后续提交，继续检查补丁；多仓库预检失败回滚到接收区实际原 HEAD。真实 Git 回归覆盖默认合并、变基边界、无操作和未提交改动保留。
- 全量检查通过（872 项测试）；1440 / 390 浏览器验证独立规则设置及同步方式切换，无横向溢出，使用虚构数据重新生成全部文档截图。

## 2026-11-06：规则处理中再次触发并入同一会话

- 起因：报警群短时间大量报警，每条触发一个 Agent 运行，耗资源、排查不及时，结论彼此孤立。
- `src/rules/actions.ts`：Agent 动作（含静默排查的首次触发）的运行放进 `lane = rule:<规则>:<群>`；`joinLane` 发现这条队列里有等着的同规则运行就把触发并进它的 `input.triggers`（最多 60 条，其余记 `moreTriggers`），只有正在跑的就新建一个排在后面、带 `resumeFromRun` 的运行。`merge: false`（规则页取消勾选）时不进队列，和以前一样各自并行。静默排查的话题跟进仍用原来的话题队列。
- `src/agents/steer.ts`：`takeSteering` 对规则队列里正在跑的 agent 运行，在它下一次调用工具后拿走等着的运行的触发（取消那个运行，记 `steeredInto`、`joinedTriggers`），用 `triggerNote` 列出摘要和消息 id、说明怎么一起下结论或分别回复。
- `src/agents/jobs.ts`：等着的运行自己开始时把 `triggers` 里第一条以后的列进任务，按 `resumeFromRun` 续上前一个运行的会话（同档案、同 AI、同范围、前一个已完成）；规则队列里的运行保留会话（`persistSession`）。
- 规则页 Agent 动作加“处理中再次触发时并入同一会话”（默认勾上）；`compile.ts` 的草稿说明加 `merge`。
- 测试：`test/rule-merge.test.ts`（并入等着的运行、换群另开、正在跑的一轮拿走触发、之后再触发另排；结束后等着的运行续上会话且任务里有全部触发，用假 ACP Agent；关掉合并时各自并行）。

## 静默改成工具 stay_quiet（2026-11-06）

- 新工具 `stay_quiet(reason)`（`tools.ts`，分组 ask；不在 CORE_TOOLS，多数会话经 `omem_call` 调）：记到运行输出 `stayQuiet`，并加一条状态事件。`src/agents/quiet.ts`：`mayStayQuiet(app, run)` 决定这一轮能不能用（工具里检查），`quietReason(app, runId)` 给宿主读。
- 去掉 `jobs.ts` 的 `isQuiet` 和 digest.ts、profile-jobs.ts、lark-meetings.ts（`heldNotes` 改为排除 `stayQuiet` 的窗口）里按文字认 QUIET 的地方；后台角色用 `quietOf(ctx, text)`。
- 授予：`threadTurn` 的三处 `prepareRun` 都 `addTools: ["stay_quiet"]`（一个 Agent 会话服务各种轮次）；`runAgentTask` 在 rule / silent / meeting / wake 时加；十个后台角色的 `tools:` 写上它。规则运行静默且这次没有 `lark_sent` 记录时返回 `quiet: true`（气泡撤回）。
- 测试替身：`test/fake-acp-agent.ts` 的 `FAKE_QUIET` 让固定回答前先调 `stay_quiet`（直接或经 `omem_call`），被拒时把拒绝说出来。
- 验收见 acceptance.md 同名一节。

## 运行页“编码”与统一的交办视图（2026-11-06）

- 起因：编码记录要去运行列表里一轮一轮翻；需求页和运行页的编码详情是两套，编码中看不到概览这些标签；看不出分支从哪切出、确认后推到哪（方案 docs/v2/coding-work.md，本人选定放在运行页、仓库做成业务空间的下级空间）。
- `src/agents/code-works.ts`：一次交办或分支评审一项，按投影列算阶段、等谁（owner / active / assistant / idle / ended，两天没动算 idle）、现在、下一步和可做的动作、修改项进度、事项与需求、各仓库分支；`GET /api/code-works`、`GET /api/code-works/:id`；需求详情接口多返回 `works`，需求树的“等你 N”按同一套算。
- 网页：运行页顶部“编码 / 全部运行”；`CodeWork.vue` 取代运行页里的编码详情和 `WorkPane.vue`（提问、修改点、讲解一起搬过来），需求页用同一个组件；`CodeWorkRow.vue` 两处共用。“全部运行”带 `exclude=code,review`，类型筛选去掉这两项；按 id 精确搜仍能找到。
- 测试：`test/code-works.test.ts`。

## 仓库挂在业务空间下（2026-11-06）

- 起因：每个代码仓库都要单独建空间、再和业务空间关联，空间越来越多；同一个需求的交办有的记在业务空间、有的记在仓库空间（方案 docs/v2/coding-work.md 第 4 节，本人选定“下级空间”）。
- `spaces.parent_id`（迁移）；`src/core/spaces.ts`：`childSpaces`、`spaceFamily`、`businessOf`、`setSpaceParent`，`relatedSpaces` 把上下级排在前面（`via: parent | child`）；`src/core/space-repos.ts` 的 `repoSuggestions`。
- 用到的地方：`permissions.ts`（成员跟着业务空间）、`code.ts`（`homeSpace`、`codeRepos` 用业务空间代替唯一的仓库）、`tools.ts`（`search` 写业务空间时带上仓库、`connect_repository` 的 `parent`、`list_spaces` 缩进）、`http.ts`（建空间带 `parent`、`/parent`、`/repo-suggestions`、网页交办记账、检索 / 运行 / 编码列表按业务空间）、CLI `omem space parent`、`--parent`。
- 网页：`lib/spaces.ts`（排序与选择器选项，`UiSelect` 加 `indent`）、设置页的“仓库”一栏和“所属业务空间”、原件页的仓库入口。
- 测试：`test/space-repos.test.ts`。

## 2026-11-06：助手读消息附件

- 起因：别的机器人在群里发了 CSV，助手用 `lark_read` 跑 `im +messages-resources-download`，lark-cli 把它标为写操作（它写本地文件），被拒；其实采集时已经把这个 CSV 存成了原件，只是助手用原始的 `lark_read` 读话题，看不到原件链接。
- 新文件 `src/channels/lark-message-files.ts`：`messageFile` 按 `lark_messages.resources` 找已有原件；没有就用 `messageResourceFile`（本人 lark-cli 的 `+messages-mget --download-resources`，退回机器人）下载，按真名导入群所在的空间（uri `lark:<群>/<消息>/<key>/<名字>`），记回 `sourceId` 和 `parse.status = done`；没采集过的消息先用 `+messages-mget` 读出所在的群。范围：群所在的空间在运行的读取范围里，或群是这次运行自己的群。视频和音频只给文件；解析不了的格式给文件路径和原因。`resourceDownload` 认 `lark_read` 的下载命令。
- 工具 `lark_message_file`（分组 lark-msg，说明在 `skills/omem/references/lark.md` 的“附件”）；`lark_read` 遇到下载命令改走它。

## 2026-11-06：没登录时首页不进登录页

- 现象：常驻服务器打开多人登录后，没登录直接打开 `#/` 停在“无法连接 omem 服务：请先登录”。原因：页面的第一个请求（`/api/me`）返回 401 时 `toLogin` 改了地址，但路由的第一次导航还没完成，完成时把地址写回 `#/`。
- `web/src/api.ts`：`toLogin` 经路由跳转（`setNavigation`，`main.ts` 在 `router.isReady()` 之后 `router.replace`），路由起来之前仍改地址；去登录页抛出的错误带 `login`，`App.vue` 不把它当成加载失败。

## 2026-11-06：登录时选功能，账号页关掉功能

- 起因：本人在真实租户上登录时，飞书授权页列出了以前给这个应用授过的全部权限（只要身份的登录，令牌里也带着 183 项）；新用户想在登录前就选好给什么。
- 登录页：`/api/auth/session` 的登录方式带上可勾的功能（不含后台访问）；勾了的作为 `features` 传给 `/api/auth/:provider/start`，`purpose=login` 时按 `scopesFor` 要这些 scope（自动加 `offline_access`）。不勾就和以前一样只要身份。
- 关掉的功能：`UserSettings.featuresOff`（按提供方）；`connections.ts` 的 `featuresOff` / `usableFeatures` / `setFeatureOff`，`PUT /api/auth/connections/:provider/features/:feature`（本人自己，不能关后台访问）。连接视图每项带 `paused`。
- 用到的地方：`lark-member-capture.ts` 只采集可用的功能（聊天、日程、妙记、最近文档各自判断；以前只有“我的消息”打开时才会采日程等），等批准的账号不采集；`tools.ts` 的 `ownerOnly(ctx, feature)` 和 `featureGate`：文档读取对应“文档与知识库”，写文档、复制、授权对应“让助手写文档”，`lark_read` / `lark_write` 按命令的域（im、docs/wiki/drive、sheets/base、calendar、minutes/vc），`lark_message_file` 对应“我的消息”。本人不受影响。
- 测试：`test/connections.test.ts`（登录页勾的功能才要 scope；关掉后不采集、工具拒绝，再打开恢复；等批准的账号不采集；后台访问不能关）。

## 2026-11-06：后端没开始工作就失败时也换后端

- 起因：常驻服务器夜里的巡检在豆包 CLI 上连续失败（“Local execution environment preparation failed: ENVIRONMENT_ERROR”，几秒内退出），配了 codex、traex 作后备却没有换：以前只有排队、限流、额度、容量这类错误才换。
- `runner.ts` 的 `runRole`：每次尝试记下有没有工具调用（后端自己的 `tool` 事件）和宿主记下的写入（`tool-write`）；都没有就算没开始工作，任何错误都换到链上的下一个后端，状态写“上一个后端没有开始工作就失败了（原因）”。已经开始工作的、取消的、点名了档案或指定了 AI 的运行照旧不换。
- 测试：`test/backend-fallback.test.ts`（第一个后端启动就退出，改用后备；没有后备时报错）。

## 2026-11-06：远程命令 connections

- 起因：常驻服务器上本人的飞书连接只给登录和成员功能用，本人自己读飞书仍走 lark-cli 的登录，所以没有什么会去刷新它的令牌；刷新令牌快过期（两天内）才由后台续期。要在真实租户上看一次刷新，得有个地方取令牌。
- `src/core/peer-exec.ts` 的 `connections`：不带参数时列出每个连接（用户、账号名、状态、权限数、授到的 / 关掉的 / 能用的功能、有没有刷新令牌、到期时间、最近的错误），不带令牌。`check: <用户 id>` 时按成员用到时一样取令牌（`accessToken`，快到期就刷新），再用平台的 `whoami` 确认令牌属于这个账号，返回刷新前后的到期时间。
- 测试：`test/connections.test.ts`（列表里没有令牌；快到期时刷新一次、确认是同一个账号；再查不刷新；没有连接的用户和不合法的 id 被拒）。

## 2026-11-06：远程操作与录制技能

- 起因：本人想在网页上远程打开 omem 那台机器的浏览器或桌面、用键鼠操作，并把做一遍的过程录下来，和助手对话整理成技能；看、操作、录制、回放都交给 ai-auto-desktop（aad），缺的能力在 aad 那边补（ai-auto-desktop#12：查看页按自己的地址连 WebSocket、`aad record --until-stdin-closes`、录制和查找共用命名规则、`aad browser-record steps` 转成可回放步骤、iframe 与页面同前缀时选地址一致的、`run_workflow` 正确报告控制步骤）。
- `src/remote/`：`aad.ts`（一次性命令、长驻进程、`aad mcp` 的 JSON-RPC 客户端）、`sessions.ts`（浏览器会话用 `browser_open` 起无窗口浏览器再接 `aad assist --browser-port`，桌面会话 `aad assist --desktop`；地址栏、录制、回放；30 分钟没人看结束）、`recordings.ts`（表 `remote_recordings`、摘要、`read_recording` 的四部分、技能附带的文件；启动时把还在录的标成中断）、`http.ts`（`/api/remote/*`，`/remote/<会话>/` 的 HTTP 与 WebSocket 转发，查看用的会话 cookie 加 Origin 检查）。
- 网页：`views/Remote.vue`（导航“远程”只在装了 aad 时加上，`desktop.control`）、`components/RemoteChat.vue`（页面旁的对话，和问答同一条线程）；Vite 开发代理加 `/remote`。
- Agent：工具分组 `remote`（`list_recordings`、`read_recording`），主助手 `group:remote`；`save_skill` 加 `from_recording`；内置技能 `skill-from-recording`；说明页 `skills/omem/references/remote.md`。
- 其他：`/remote` 进 `peer-tunnel` 的 `tunneled`、中间设备转发 `/api/peers/:id/remote/*`；`OMEM_TOOL_<名>` 指定某个工具的程序（`core/tools.ts`，也放进 Agent 的 PATH）。
- 测试：`test/remote.test.ts` + `test/fake-aad.ts`；本机真实 aad 与 Codex 跑通一次浏览器录制 → 技能 → 回放（acceptance 有记录）。
- 画面设置（同日）：`src/remote/settings.ts`，每人一份存 kv `remote_settings:<用户>`，换成 `aad assist` 的格式、画质、帧率、最大宽度、鼠标指针、剪贴板参数，新开浏览器用哪个；`aad assist --probe-video` 的结果存 kv `remote_video_probe`（按 aad 版本），开会话时带 `--encoder`，`--codecs auto` 不再每次启动都把所有编码器试一遍；`POST /api/remote/sessions/:id/viewer` 给开着的会话换查看进程（会话、浏览器、录制不动，旧进程退出不结束会话）。网页“画面设置”面板；“新会话”标签在没有打开的会话时是 ghost + primary，文字和背景同色看不见，改成二选一。
- 页面整理（同日）：会话改成浏览器式标签（× 和中键关闭，去掉右下角“关闭会话”），地址栏、画面、录制区放在标签下的一个框里，卡片加内边距、字段名用 `<span>`；浏览器资料可以复制本机 Chrome / Edge / Brave 的资料（`GET /api/remote/browser-profiles` → `browser_profiles`；`browser_open` 的 `copy_profile`、`close_running`，`aad mcp --allow-profile-copy`）；共享一个窗口时录制自动用这个窗口（按窗口句柄或进程加标题在 `aad apps` 里找），共享整个屏幕时才选录哪个程序；`aad apps` 的结果在 `apps` 字段（之前读 `resources`，可录列表一直是空的）；查看页地址带 `lang=zh`。查看页本身的修复在 aad（ai-auto-desktop `fix/viewer-input`）：每个键鼠事件带上按住的修饰键、服务端补按或松开（组合键在修饰键自己的按下没送到时也成立），Mac 上 ⌘ 当 Ctrl、Ctrl+V 粘贴本机剪贴板、浏览器页面的选中文字带回、右键不弹本机菜单、提示文字中文、浏览器页面按查看页大小排版。

## 2026-11-06：文档变化规则、延时 / 模型判断 / 脚本动作，会议邀请修正

- 文档变化：`src/channels/lark-doc-events.ts`。主机器人订阅文档（`POST /open-apis/drive/v1/files/:token/subscribe`，知识库页面经 `wiki_nodes` 或读节点换成文档），结果存 `lark_doc_subscriptions`（含只被规则盯着的文档的 `snapshot`）。`lark-bot.ts` 注册 `drive.file.edit_v1`、`drive.file.bitable_record_changed_v1`、`drive.file.bitable_field_changed_v1`、`drive.notice.comment_add_v1`；编辑按文档合并（静 90 秒、最多 10 分钟），采集过的重新导入并逐行比较，交给 `doc` 触发的规则（`RuleEvent.doc` / `change`，字段 `doc.*`、`change.*`）。每天的文档检查前先替 50 篇已采集文档订阅；订阅成功且最近一个月收到过文档事件时，`checkLarkDocs` 不再检查它们。机器人检查多一行 `docs`（`DOC_SCOPES`），扫码更新应用一并申请这些权限和事件。
- 规则：`trigger.event = "doc"`、`trigger.docs`；`checkDocRule`（只用文档字段、没有群的动作、不能等待）；权限检查订阅列出的文档并列出被拒的原因（1069603：机器人不是管理者）。动作 `delay`（`runActions` 把后面的动作和事件放进带 `not_before` 的 `rule-fire` 运行，`fireAfterWait` 接着做）、`check`（一次模型调用回答是否，否就停）、`script`（`src/rules/script.ts`：`rule-script` 运行，事件经 `OMEM_EVENT` 和标准输入，最小环境，审批卡片 `card_interactions.purpose = rule-script`，运行开始前再核对批准；只有本人经网页或接口保存，`saveRule` 多了 `actor`）。`sendLark` 的 `userIdType` 让卡片能按 user_id 发给邮箱查到的人。
- 会议：`botInvitedToMeeting` 的 `inviter.id` 是对象（真实事件），以前当字符串比较，本人邀请永远走“先问”并停掉 AI 纪要的自动重试；改为取 `open_id`。机器人收到但不处理的事件注册空处理，SDK 不再逐条警告；会议事件监听同样原因的退出只记一次日志。
- 其他修正：运行页首次加载不再在骨架屏下面多一个“搜索中…”；列表底部的转圈和文字居中对齐。左下角账号图标按其他图标的高度重画。成员页同一个飞书账号的登录 id 和机器人里的 id 合成一个标签（悬停看两个 id），× 解绑整个账号（以前只解一个，下次登录会自己补回）；空间和角色改成胶囊样式，角色是行内下拉（`UiSelect` 的 `variant="inline"`）。远程页右上角的版本和“画面设置”按标签高度居中，“打开远程画面”卡片在剩余空间里居中。编码评审里，之前轮次“暂不改”的问题改成“改”后不再从最新一轮消失：还没有交给修改的（`fixed_by` 为空）照样列出，VS Code 插件同理。
- 远程页审查：长期浏览器资料每人一份（本人的位置不变，别人的在 `remote/profiles/@<用户>/`），列表只列自己的；列出和复制本机浏览器的资料（`/api/remote/browser-profiles`、`copyFrom`）只有本人能用。以前给了自定义角色“操作桌面”的人能打开别人的长期资料、复制本人浏览器的登录。

## 2026-11-06：连续触发可分别回复

- 规则 Agent 动作在 `merge` 开启时新增 `mergeReply`：`combined`（默认，合并回复）和 `separate`（每次触发分别回复）。分别回复时同规则同群仍串行并复用 Agent 会话，每个触发各排一轮，保留完整事件、任务和回复位置；当前轮不拿走、取消后续触发。
- `rules/actions.ts` 按最后一个排队或运行中的前驱衔接会话；`agents/steer.ts` 不吸收分别回复的轮次。`jobs.ts` 按当前消息投递，已有话题或未选择开话题的消息也保持自己的锚点；思考气泡遵循同一投递位置。
- 提示 Agent 复用调查时仍逐条完成任务中的操作、核对本条状态和答复，不能用首条处理或汇总结论代替其他触发。平台专属的接手与确认流程仍放在本人的数据目录技能中，不进入宿主。
- 规则页、自然语言草稿、工具说明、README 和文档站同步。专项回归覆盖默认合并、独立并行、三次连续触发串行续会话、各自回复、完整长事件、已有话题及从旧模式切换。
- 验证：`LANGUAGE=C pnpm run check` 通过，917 项测试；真实 Codex gpt-6.1-sol low 验证两种规则草稿；演示页验证选项保存、刷新和关闭时隐藏，1440 / 390 无横向溢出，仅刷新 `rules.png`。附件降级回归显式关闭解析器，不再依赖机器上是否已安装转换器。

## 2026-11-06：远程浏览器关闭与窗口说明

- 显示窗口选项明确指运行 omem 的电脑桌面；补充说明默认仍能在当前远程画面里看和操作。
- `AadMcp.close()` 先调用并等待 `browser_close`，再结束标准输入并等待进程退出；`closeSession` 与打开失败的清理等待它完成，防止旧的 3 秒强制结束打断浏览器和资料释放。
- 回归：假 aad 的资料锁直到 3.2 秒关闭完成才释放，关闭接口返回后同一资料立即重开成功。aad 的崩溃残留锁恢复由 aad 自身处理，omem 不删除外部资料目录里的锁。

## 2026-11-06：从群历史核实其他机器人的提及身份

- `lark-people.ts` 的 `resolveMention`：普通成员列表没有命中且没有明确的普通联系人身份时，再用发送应用读目标群最近 200 条消息的 mentions，拒绝混用个人采集应用的 open_id；按机器人和群缓存 10 分钟。
- 更新发消息技能与工具说明：优先传机器人名字，只有当前应用的历史也没有可核实的提及才需要本人补一次 @，不要求与助理在同一条消息里。
- 专项回归与真实 Codex gpt-6.1-sol low（假飞书接口）通过；完整类型、920 项测试与构建通过。

## 2026-11-06：目录导入不再占住 Web 主进程

- 起因：检索已在只读子进程，但仓库接入的 `syncDirectorySpace` 仍在主进程整批同步遍历、解析、写索引和解析引用，大仓库接入会使网页与其他请求等待。
- `sources/import-process.ts` / `import-worker.ts`：目录同步与普通目录导入走独立进程，同一应用串行；每批进度先暂停工作进程，让主进程记录进度、转发原件变化并失效向量缓存。超时或关闭服务时停止工作进程，保留已提交文件。权限仍由调用工具核对，工作进程不提供独立接口。
- HTTP 响应、增删、取消、原有仓库与调用图专项回归通过。1200 文件规模对照：总耗时 7217.1 → 7489.3 ms，主进程最长停顿 7219.4 → 12.4 ms，导入数量一致。

- 完整检查：159 个测试文件、922 项测试、类型与构建通过。

## 2026-11-06：机器人检查只留扫码更新，订阅可立即重试

- `lark-setup.ts` 的 `LARK_BOT_ADDONS.scopes.user` 加上 `FEATURES.lark` 里各功能的权限（去重），扫码更新一并申请成员连接飞书要的用户身份权限；以前只有个人采集那一套，扫完成员那一行还缺三项。
- `summarizeCheck`：应用信息没给事件订阅时用线上版本的事件；“未发布”只在两边都有时比较。设置页去掉权限的“一键申请”（多项逗号分隔在飞书权限页搜不出来）和“去事件订阅页面”，说明改成扫码更新后发布新版本；扫码链接只在浏览器拦下新页面时显示。
- 远程命令 `lark-bot-permissions` 加 `raw`（`rawAppInfo`：应用信息和线上版本的权限、事件原样）；新的 `lark-doc-subscribe`（`link` 订阅一篇，`retryFailed` 重试被拒的，`retryFailedSubscriptions`）。每天的批量订阅里没试过的优先，被拒的三天后再试（以前一周）。
- 真实应用的线上版本里 `events` 是显示名（“文件编辑”“接收消息”），事件键在 `event_infos`：`eventKeys` 从里面取出 `xx.yy_v1` 形式的键当作已订阅的事件；`raw` 也带上 `event_infos`。
- `lark-bot.ts` 给 SDK 的客户端一个只写一行的 logger：失败的接口调用不再把整个请求和响应打进服务日志（订阅被拒的那批每篇几十行），只留方法、路径、状态和飞书的错误码。
- 成员连接飞书的“表格与多维表格”“让助手写文档”改用飞书现在的细分权限（`sheets:spreadsheet:read`、`base:*:read`、`docx:document:write_only`），旧的 `sheets:spreadsheet:readonly`、`bitable:app:readonly`、`docx:document` 新应用申请不到，机器人检查一直显示缺这三项、扫码也补不上。

## 2026-11-07：文档变化规则订阅不了时定时查

- `lark-doc-events.ts` 的 `pollRuleDocs`（main.ts 每分钟调一次）：启用的文档变化规则列出的文档里，订阅被拒的（或一个月里没收到过文档事件时的全部）按 `trigger.pollMinutes`（默认 30）用本人 lark-cli 只读查最后修改时间（`lark-docs.ts` 的 `docMetas`，原来的 `lastEdits` 改由它实现，带修改人），第一次只记下；改过就走和事件一样的 `flush`（重新读、逐行比较、交给规则），变化内容注明定时检查发现。`lark_doc_subscriptions` 加 `polled_at`、`modified_ms`。规则保存后的检查不管订阅成没成都给只被规则盯着的文档存 `snapshot`。规则页加“机器人订阅不了的，每 N 分钟用我的登录查一次更新”。

## 2026-11-07：设备拉取可选内容和目标目录，附件只传缺的

- `omem peer pull`：数据库总会拉；知识库、附件、代码仓库、编码工作区可选（`--only`，在终端里用勾选列表逐项问，列出对方存储页扫到的大致大小）；`--to <目录>` 合并进另一个数据目录（不存在就新建，设备配对仍读当前目录）；`-y` 不询问。`--overwrite` 总是完整拉取，不能和 `--only` 一起用。
- 传输：`GET /api/peer/snapshot` 认 `parts`、`strip`、`files=separate`；SSH 快照程序收同样的选择作第三个参数。没选的仓库和工作区不打包；合并时不传 `chunks`、`chunks_fts`、`symbols`、`code_refs`（合并会重建；常驻服务器 8.7 GB 的库里约 6.7 GB 是这些）。附件先列名字（`GET /api/peer/files`），只请求本机没有的，每批 500 个（`POST /api/peer/files`）；覆盖时跳过的附件从备份复制回来。
- 兼容：旧设备忽略参数、发来全部内容，`mergeLibrary` 先删掉没选的部分再合并。快照里既没有知识库也没有附件时 tar 不再因为结尾的空 `-C` 失败。
- 回归：`test/peers.test.ts`（经中间节点只拉附件：只传缺的一个、快照无索引、合并后重建）、`test/pull.test.ts`（旧设备全量快照按选择合并）；本机起一台临时 omem 用 CLI `--only files --to <新目录> -y` 实测。

## 2026-11-07：连接其他平台（身份与能力两类连接器）

- 内置插件 `plugins/connect`：运行时读 npm 包 `@nangohq/providers`（Nango 的平台目录，ELv2，不复制进仓库），把全部 OAuth 2 平台和可采集分组（文档、聊天、邮件日程、会议、代码、工单）里用 API Key / 账号密码连接的平台注册成连接器；`china.ts` 补微信扫码登录、QQ 互联、微博、钉钉、抖音、Gitee、百度网盘、阿里云盘、语雀。通用引擎 `engine.ts` 处理授权参数、Basic / JSON / GET 换令牌、参数改名、响应路径、令牌放请求头或 query。
- 两类：`identities.ts` / `china.ts` 里有“我是谁”的是身份（可登录、绑定，按平台永久 id 记 identities），其余 `identity: false` 是能力：登录流程只接受 connect，回调只存令牌。
- 宿主：`LoginProvider` 加 `identity`、`credentials`、`appFields`、`sign`、`group`、`docs`，`apiBase` 可以是函数，授权三函数可选；`src/auth/apps.ts` 存主人填的应用配置（`secrets/connector-apps.json`）；`auth.connectors` 是开放给成员的平台；`POST /api/auth/connections/:provider/credentials`、`PUT /api/auth/providers/:id/app`；插件 `api.appConfig`、`api.fetch`、功能可为函数、`ctx.saveSource`（`saveSourceFor`，按调用者可写的空间，uri 作 origin_key）。
- 工具 `connect_list`、`connect_request`（只读：GET；POST 只放行搜索、查询、GraphQL query 和少数已知只读接口）、`connect_save`；档案 `connect-collector`、技能 `platform-capture`。
- 网页：设置 → 成员 → 平台应用（`ProviderApps.vue`：搜索、用途与范围筛选、填配置、复制回调、开放）；登录方式只列能登录且已设置的；账号页可搜索、用 key 连接。
- `test/connect-plugin.test.ts`；没有用真实平台应用走过授权。

## 2026-11-07：平台包（读取器与定时同步）

- `src/plugins/platforms.ts`：`api.platform` 注册平台包：功能（替换连接器原来的，`overrideFeatures`）、读取器（`read` 读一项成 Markdown，`changes` 列出容器里某位置之后改过的）、同步间隔。`platform_watches` 存盯着的内容；定时任务 `platform-sync`（每 20 分钟）按盯的人的连接同步，只写能写的空间，一轮 50 项，失败时位置不前进。原件 uri `<平台>:<类型>/<id>` 兼作 origin_key。
- 内置平台包：figma、notion、github、google（云盘、Gmail、日历）、slack、atlassian（Jira、Confluence）、linear。`src/sources/html.ts` 的 HTML 转 Markdown 经 `api.text.html` 给插件用。
- 连接插件加 `connect_read`、`connect_watch`，`connect_list` 列出能读的类型和盯着的内容；账号页列出盯着的内容（立即同步、不再同步）。登录流程记下申请的 scope，平台没回报时按申请的记。
- `test/platform-packs.test.ts`。

## 2026-11-07：插件启用开关、第三方插件安装、权限声明

- `plugins.disabled`：停用的插件不加载代码、档案、页面和侧栏入口；设置页切换立即生效（`setPluginEnabled`），`omem plugin enable|disable` 改配置、重启生效。
- `src/plugins/install.ts`：`npm:包@版本` 或 `github:owner/repo#tag`（必须 tag 或提交）装进数据目录，不跑安装脚本、依赖 `--ignore-scripts`，来源记在 `.omem-install.json`；拒绝和内置或本人手放的插件重名。接口 `POST /api/plugins/install`、`/:id/update`、`DELETE /api/plugins/:id`、`PUT /:id/enabled`；命令 `omem plugin list|install|remove|enable|disable`。
- 清单 `permissions`（`write`、`connectors`、`platforms`）：数据目录插件的代码注册超出声明的会被拒；`describePlugin` 带 `permissions`（信任前取声明，运行后取实际），设置页和信任确认里列出。
- `test/plugin-install.test.ts`。

## 2026-11-07：插件隔离运行

- `src/plugins/sandbox.ts` / `sandbox-runner.ts`：数据目录插件信任时默认隔离运行。fork 一个带 `--permission` 的 Node 进程（读插件目录和 omem 包，写 `plugin-data/<id>`，不能起子进程），环境变量不带 omem 的；工具（宿主用插件给的 JSON Schema 列出，`Tool.jsonSchema`）和平台包读取器注册为代理。进程的请求（fetch 经连接、`store`、`saveSource`、`watches`、`service.ensure`）按正在进行的调用的 ToolContext 回答，令牌不出 omem。内容块、新连接器要选在 omem 里运行。
- `trust.ts` 记 `mode`（isolated / inprocess；以前的记录算 inprocess），`POST /api/plugins/:id/trust` 带 `mode`；加载失败或超出声明时撤回信任。设置页显示运行方式，“在 omem 里运行…”单独确认。
- `test/plugin-sandbox.test.ts`。

## 2026-11-08：设置页分组；平台工具只给连了平台的人

- 设置拆出“连接”（`tab=connect`）：本人的飞书文档与个人消息采集（从“渠道”移来）和其他平台（`ProviderApps.vue` 自己加载、虚拟滚动、每行有说明：授权页连接要建应用，填 key 连接的由成员各自填 key，开放后才出现在账号页）。“渠道”只留机器人与聊天渠道（OneBot 卡片改名“QQ / 微信 机器人”）；“成员”去掉平台应用，登录方式链接到连接页；网页地址移到“设备”。设置页跟随 `?tab=` 变化切换标签。国内平台的用途分组改成社交媒体、聊天与通讯。
- 内置角色的技能和工具改成叠加设置：`updateRoleMeta`（挂技能、批准的增减工具建议）只写 `_roles/<名>.overlay.yaml`，`loadRole` 叠在源码或自定义副本上，源码更新不用合并；改说明正文或其他字段才复制。启动时 `simplifyRoleCopies` 把“和它所基于的版本只差技能 / 工具”的旧副本转成叠加设置并删掉副本。`RoleState.overlay`。
- 工具 `available`（`dropUnavailable` 在 runner 里按这次运行的人去掉）；插件工具 `whenConnected`（含隔离运行的插件）：连了本插件某个连接器才给。`TOOL_GROUPS` 加 `connect`（由同名插件填充，说明 `skills/omem/references/connect.md`），主助手带 `group:connect`；连接插件去掉侧栏页，`connect-collector` 留作档案。

## 2026-11-07：网页版 VS Code 打开交办工作区不再问信任

VS Code 的信任记录存在浏览器里、按路径算，交办每次换工作区就要再点一次信任。`proxyIde` 在返回工作台页面时，若 `folder` 是编码交办自己的目录（`codeRunsAt`），把页面配置的 `enableWorkspaceTrust` 改成 `false`（`trustWorkbench`）；其他文件夹不变。配置 `ide.web.trustCodeFolders`（默认开）。实现：`src/server/ide-web.ts`；回归：`test/ide-setup.test.ts`；本地开发实例用真实 serve-web 对照过（交办工作区无受限模式，无关目录有）。

## 2026-11-07：检查结果交给评审，评审不再重跑测试

- 宿主的检查记下跑在哪个提交、改动起点和用时，命令带 `OMEM_BASE`（`src/agents/code.ts`）；评审材料的“检查结果”写明这些和编码工作区位置，没设检查命令时写明没有复核（`review-chain.ts`）；逐项验证也带“检查结果”（`code-overlap.ts` 的 `verifyChecks`）。
- `roles/_common.md` 新增“评审时的测试和检查结果”（只给评审）：核对结果是否完整有效，不重跑整套测试，只为具体问题跑最小范围；`roles/coder.md` 要求写原样的验证命令和结果。
- 运行页检查一节显示提交和用时，没设检查命令时提示；设置 → 空间 的检查命令说明 `OMEM_BASE`。
- `test/code-checks.test.ts`；设计在 docs/v2/review.md §4.5。

## 2026-11-07：交办工作区的预览

- 仓库空间设置加“预览命令”（`previewCommands`，一行一个“名字: 命令”）。交办视图“预览”（`web/src/components/WorkPreview.vue`）在这次交办的工作区里运行它，列出它和子进程监听的端口；`src/agents/previews.ts` 管起停、同一仓库一个、没有连接超过 `preview.idleMinutes` 分钟或工作区收回时停、重启后停掉遗留进程；`src/core/listening.ts` 查进程树监听的端口与连接数（Linux `/proc`、macOS `lsof`、Windows `netstat`）。
- 按原端口号看：`omem peer open` 的本机进程处理 `/api/local/forwards`，在同样的端口号上监听，每个连接经 `tunnelConnect`（`Upgrade: omem-tcp`，`/api/previews/:id/tcp`，加进 `tunneled`）原样接到那台机器的端口，所以把 localhost 端口写死在开发配置里的多应用项目不用另配；接口与隧道在 `src/server/preview-http.ts`，只对本人。
- 设置页 `?tab=spaces&space=<id>` 直接打开那个空间的设置。
- `test/preview.test.ts`；设计在 docs/v2/preview.md。
- 预览启动前，工作区没准备过依赖（比如交办应用后单独建的目录）或锁文件变了时，先跑仓库的准备命令（`setupCommandFor` / `setupKey` / `setupDone`，和编码前同一规则），状态“准备依赖”；命令在开出端口前结束时，原因写明“没有开出端口（看输出）”。在常驻服务器上第一次试时，应用后的目录里没有依赖，两个 dev 都起不来，才补上这一步。
- 修复：预览命令在 `spawn` 时就被拒（命令里有空字符）时，记录留着进程号 -1、状态停在“启动中”，下一次启动按“同一仓库一个”去停它，`killPid(-1)` 退到 `process.kill(-1)`，给这个用户的所有进程发了 SIGTERM（在常驻服务器上实际发生过一次）。`killPid` 现在拒绝 ≤1 和自身的 pid；`spawn` 失败时预览直接以“命令没能运行”结束，不留占位 pid。`test/preview.test.ts` 覆盖。

## 2026-11-07：升级用 osdk 安装依赖，npm 源由 osdk.toml 指定

- 常驻服务器的 `.npmrc` 指向公司镜像，镜像里没有 `@nangohq/providers@0.72.2`，pnpm 11 的发布时间检查（minimumReleaseAge）因此拒绝安装，远程更新停在“安装依赖”。
- `osdk.toml`：`[settings.precedence] npm = "osdk"` 和 `[registries.npm] default`（公开源）；osdk 给 pnpm 注入 `npm_config_registry` / `pnpm_config_registry`，覆盖 `.npmrc` 和 `pnpm-workspace.yaml` 的源，scope 和认证仍按原生配置。osdk 对写了自定义 `run` 的依赖不选源（`deps_cmd.rs` 只在 `run` 为空时注入），所以 `[deps.pnpm]` 另用 `env` 带上同样的两个变量，指向同一个源。`[deps.pnpm]` 的命令加 `--config.confirmModulesPurge=false`（没有终端时 pnpm 不会停下来问）。
- `scripts/upgrade.ts`：有 osdk 时 `osdk trust osdk.toml` → `osdk install --no-deps`（工具；常驻服务器上全局 `omem` 同时挂在 node 和 npm 的前缀里，osdk 生成 shim 时报冲突，所以只提示不中断）→ `osdk deps` → `osdk run build`，之后还原本机改写的 `osdk.lock`（部署用的检出保持干净，下次 `git pull --ff-only` 不被挡）；没有 osdk 时照旧直接用 pnpm。

## 2026-11-07：中间设备转发任何升级请求；预览说明文件监听上限

- 经 `--via` 中转时，中间设备以前只转发 `tunneled` 列出的升级路径，预览的隧道（`/api/previews/:id/tcp`）在旧版中间设备上被回 404。现在中间设备对本人令牌的升级请求不看路径原样转发，由最后那台设备鉴权和判断路径（`src/server/http.ts`）；以后加新的隧道，中间设备不用跟着更新。
- 预览输出里出现 `EMFILE … watch`（inotify 实例数）或 `ENOSPC`（监听数）时，`previewHint` 给出原因，交办视图的预览面板显示在状态下面。常驻服务器上主应用崩过一次就是这个：同一用户 128 个 inotify 实例被别的程序占满，两个开发服务器各只占 1 个。
- `test/preview.test.ts`：经一个不认识预览的中间设备打开预览端口；按真实报错格式测提示。
- 预览命令不再继承 omem 后台服务的 `NODE_ENV=production`（`previewEnv`）：常驻服务器上 `rsbuild dev` 因此按生产模式构建，页面引用 `//undefined/undefined/static/js/…`，白屏。端口刚开时 `/` 可能还是 404，启动后 3 分钟内判定为“不是网页”的端口会再探测。
- 修复：经设备隧道转发的连接，一端结束时会立刻销毁另一端，慢链路上排队待写的数据被丢掉。常驻服务器上主应用的代理（`Connection: close`）转来的子应用脚本因此被截断（`ERR_INCOMPLETE_CHUNKED_ENCODING`，curl 报 “transfer closed with outstanding read data remaining”），Garfish 加载子应用失败。三段转发（本机、中间设备、目标设备）改用 `splice`：结束时先写完再关，出错才同时断开。

## 2026-11-07：运行产物；编码前检查

- 运行产物（`src/agents/artifacts.ts`、表 `run_artifacts`）：编码 Agent、编码助手、宿主的检查命令、外部 Agent 的 `code_workspace` 命令带 `OMEM_ARTIFACTS`，宿主在 `finish_task`、一轮结束、命令跑完时收走，`T<编号>/` 归到那一项；`attach_artifact` 和 `code_workspace` 的 `attach` 按路径交；文件按路径里的密钥给出（`/api/artifacts/<id>.<key>/…`，`src/server/artifact-http.ts`），网页和报告带 CSP sandbox；中间设备转发时带上 Range 和这些响应头；交办视图“产物”标签（`RunArtifacts.vue`）和修改项上的数量；评审材料和逐项验证列出文件路径。设计在 docs/v2/artifacts.md。
- 编码前检查（`src/agents/pre-check.ts`、`roles/business-analyst.md`）：新交办第一轮编码前查影响面、以前的问题、回归清单，`submit_brief` 交结果，编码 Agent 的任务和阶段评审的材料里多一节；`code_history`（`src/agents/code-history.ts`）按文件列需求点、交办、评审问题和提交，历史评审也用；`agents.autoAdvance.preCheck`、`delegate_code` 的 `pre_check`；“概览”里的卡片（`PreCheckCard.vue`）。设计在 docs/v2/pre-check.md，review.md 5.2 的业务简报以它落地。
- `test/artifacts.test.ts`；测试里默认关掉编码前检查（`test/helpers.ts`），这个文件里打开。

## 2026-11-08：同步暂存只认本工作区的

- Git 的 stash 是整个仓库共用的：以前任何一个工作区留下“同步前未提交的改动”，别的工作区都被当成同步没做完，新交办就不把复用的工作区切到分支最新提交，接着把远端合进上次留下的旧提交。现在 `src/agents/code-sync.ts` 暂存时把这条 stash 的提交记在本工作区自己的 Git 目录（`git rev-parse --git-path omem-sync-stash`），`hasSyncStash`、放回、放弃同步都只认这一条。`test/code-sync.test.ts` 加了两个工作区的用例。

## 2026-11-08：界面块第一阶段（表单提问与展示块）

- 设计在 `docs/v2/interactive-ui.md`。`src/agents/ui-blocks.ts`：展示组件（markdown、heading、table、chart 含 pie、metric、compare、timeline）和输入字段（text、textarea、number、choice、multi、scale、date、datetime、toggle、pick、checklist，`required`、`show_if`）的 zod schema，`normalizeAnswers` 检查回答，`summarizeAnswers` / `viewText` / `fieldsText` 给 Agent 和文字渠道读。
- `ask_owner` 改名 `ask_user`（不保留旧名），加 `fields`、`view`、`submit_label`；`asks` 加 `ui`、`value` 两列，`answerAsk` 收 `value`，`describeAnswer` 给逐行摘要和 JSON。新工具 `show` 写 `ui_views`（同步表，`delivered_at` 本机），网页和插件页画在回复下面；飞书等渠道在 `showSuggestions`（回复发出后）收到文字版和 `#/ui/<id>` 链接。接口 `GET /api/ui/views?conversation=`、`GET /api/ui/:id`，`POST /api/asks/:id/answer` 收 `value`。
- 飞书提问卡片（`lark-asks.ts`）：带表单的提问列出字段和“打开填写”按钮，不在卡片里填。
- 插件：删 `src/plugins/generic.ts`（`plugin_form` / `plugin_chart`）；`PLUGIN_TOOLS` 改成 `plugin_query`、`plugin_put`、`ask_user`、`wait_answer`、`show`；`sessionView` 把会话的提问和展示列成 `ask` / `view` 块，`submitBlock` 对提问转给 `answerAsk`；提问和展示变化时发 `plugin` 事件（`nudgePlugin`）。渲染器 `packages/plugin-sdk/blocks.ts` 重写：`renderView`、`renderBlock`（`ask` / `view`）、`fieldVisible`、`initialValues`。
- 网页：`UiView.vue`（SDK 渲染器 + Markdown 组件）、`UiFields.vue`（omem 控件的表单）、`AskCard` 带表单、问答页的表单跟在回复下面、`views/UiItem.vue`（`#/ui/:id`）。
- 角色：`_common.md`“问本人、给本人选项”讲什么时候用表单、`pick`、`checklist` 和 `show`；`coder.md`、英语陪练改用新工具。`skills/omem/references/owner.md` 同步。
- 同一次运行里再交一张表单（重答的一轮、改过的表单）会取消还没填的旧表单，避免会话里挂两张。真实 Agent（codex-cli）试过：团建这类要问好几项的问题，一张表问完（日期 `date`、人数和预算 `number`、方案 `pick` 带要点和代价），提交后下一轮照着值排了日程和预算。

## 2026-11-08：界面块第二阶段（飞书卡片里直接填表、卡片里的表格和图表）

- `lark-asks.ts`：`cardFields` 把提问的字段映射成卡片表单（输入、下拉、多选下拉、日期、日期时间、勾选；`pick` 下拉，`checklist` 每条下拉加备注框，超过 12 条或卡片超过约 24 KB 退回网页链接），`valueFromCard` 把表单值转回字段值（日期 “2026-11-15 +0800” → `2026-11-15`），`handleAskAction` 先用 `normalizeAnswers` 检查，错了只弹提示。
- `lark-ui.ts`：`viewCardBlocks` 把表格、图表画成卡片的 `table`、`chart`（VChart）元素，其余转文字；`viewTarget` 找会话所在的群或话题。`asks.ts` 加 `addViewSink`，飞书注册后 `show` 的内容在回复后发成一张卡片（`viewCard`），失败退回文字。`lark-send.ts` 的 `CardBlock` 加 `element`（宿主自己拼的元素）。

## 2026-11-08：界面块第三阶段（交互页）

- `src/agents/ui-pages.ts`：`savePage` / `getPage`（表 `ui_pages`，每版一行，同步表），`pageDocument` 在页面最前面放 `<meta>` 安全策略（`PAGE_CSP`：`default-src 'none'`，只许内联脚本样式和 data: 图）、基础样式和桥（`window.omem`：`submit`、`draft`、`onInit`、`onTheme`、`open`，高度自动上报）。`asks` 加 `draft` 列，`saveDraft` / `draftOf`。
- 工具 `ui_page`（`ask` 分组，`coder` 也有）：`html` 或工作区里的 `.html` 文件（同 `attach_artifact` 的目录范围），`page_id` 出新版。`page` 组件放进 `show` / `ask_user` 的 `view`（宿主补标题；和 `fields` 不能同在一个提问）；`answerAsk` 收页面交回的值（最多 20000 字符）。接口 `GET /api/ui/pages/:id?version=`、`POST /api/asks/:id/draft`。
- 网页 `UiPage.vue`：`srcdoc` + `sandbox="allow-scripts"`，只认这个 iframe 发来的消息，发主题 token（浅色深色切换时更新）、存草稿、提交回答、只放行 `#/` 链接，全屏和版本切换；问答页里带交互页的提问跟在回复下面。飞书卡片里是一行说明加“打开交互页”。
- 外部 Agent 编码（`code_workspace`）在游离 HEAD 上的提交要等它 `finish` 排的那一轮结束才放回分支；以前那一轮开头的 `placeOnBranch` 把工作区切回分支最新提交（分支在别处检出时），提交就留在了外面，检查和评审跑的是没有改动的代码。现在本次交办自己的工作区里在分支之上还没放回的提交会保留（分支没在别处检出时直接快进分支），刚借来的工作区仍从分支最新提交开始（`src/agents/code-branch.ts`，`test/code-sync.test.ts`）。

## 2026-11-08：界面块第四阶段（飞书网页应用入口）

- `web/lark/index.html` + `web/src/lark/`（`main.ts`、`LarkApp.vue`、`LarkHome.vue`）：Vite 第二个入口（`web/vite.config.ts` 的 `rollupOptions.input`），只有它加载飞书 JSSDK；登录：`tt.requestAccess`（103 退回 `requestAuthCode`）→ `POST /api/auth/lark/app`（`AUTH_PUBLIC` 放行）→ `login.ts` 的 `larkAppLogin`（`lark.ts` 的 `exchange` 在没有 `redirectUri` / `verifier` 时不带这两个参数）；不在飞书里跳回主站。
- 配置 `lark.webApp`，`/api/auth/session` 返回 `larkApp`；`asks.ts` 的 `larkAppLink`，`uiLink` 在打开后给 `applink.feishu.cn/client/web_app/open?…&mode=sidebar&lk_target_url=…`。设置 → 渠道的开关写明开发者后台要填的主页和可信域名。测试 `test/lark-webapp.test.ts`。

## 2026-11-08：界面块第五阶段（排序、可编辑表格、问别人、页面截图）

- `ui-blocks.ts`：字段 `rank`、`table`（`normalizeAnswers`、摘要、文字版）；`lark-asks.ts` 的 `cardFields` 遇到它们返回 null（退回网页）。网页 `UiFields.vue` 用上移 / 下移和带 `UiSelect` 的表格；SDK 渲染器同样支持。
- `ask_user` 的 `to`（`tools.ts`）：本人自己会话里 `kind = ask` 的一轮、对方能读空间才行；提问 `context` 记 `askedBy` / `toName`（`Ask` 上的同名字段），`asks.ts` 的 `show` 只通知对方和发对方的飞书私聊（`lark-asks.ts` 的 `targetFor`），`describeAnswer` 用对方的名字，`deliverAnswer` 以提问人的身份回到原会话；`/api/asks` 和 `/api/ui/:id` 带 `askedByName`，`AskCard` 显示是谁的助手在问。
- `lark-ui.ts` 的 `preparePageShots`：有 Playwright 时发卡片前给交互页截图并上传，`kv` 的 `ui_page_shot:<页>:<版>:<机器人>` 记图片 key，`viewCardBlocks` 放截图。测试 `test/ui-ask-others.test.ts`。

## 2026-11-08：评审卡片改用组件块

- `review-chain.ts`：`askPlan` 的 `ui.view` 是指标（评审档、最多轮数、评审项数）+ 表格（评审项、阻塞级别）+ 编码说明和理由；`askDone` 的“默认要改的问题”是表格（最多 50 行），正文去掉编号列表。处理逻辑（`review-plan` / `review-done`）不变。

## 2026-11-08：卡片画不了的只给链接

- 去掉交互页截图（`lark-ui.ts` 的 `preparePageShots`、`kv` 的 `ui_page_shot:*`）：要服务器装浏览器，流程也绕。`viewCardBlocks(app, view, { linked })`：有链接时交互页不进卡片，由调用方放“打开交互页”按钮；没链接时写一行说明。
- `lark-asks.ts`：卡片放不下的表单只放“打开填写”按钮，不再把字段列成文字；只有没设网页地址时才列字段让人回复文字。`show` 的卡片里有交互页时按钮是“打开交互页”。链接仍由 `uiLink` 决定：开了 `lark.webApp` 给 AppLink，否则是普通网页链接。

## 2026-11-08：测试结果挂到需求点，技能挂到空间

- `src/items/req-tests.ts`：表 `req_tests`（运行、交办、轮次、提交、用例名、文件、状态、方式、说明、产物 id）；`recordTests` 后 `pruneTest` 让同一个测试（点、文件、用例名）只有最近 3 次结果留着产物；`testState`、`testsText`（阶段评审材料的“测试结果”一节）。
- 工具 `report_tests`（新分组 `code-results`，`attach_artifact` 从 `code-handin` 移过来；`ROLE_TOOLS`、`PEER_REVIEW_TOOLS`）：校验需求点 id 和空间，产物按 `attachPath` 收（`req` 指向那个点），不填 `commit` 时取唯一仓库工作区的 HEAD。外部 Agent 带 `run_id`（`peerHandIn`）。`roles/coder.md` 加“测试结果”。
- 空间设置 `skills`（`specs.ts` 的 `spaceSkillNames` / `spaceSkillsText`）：`runner.ts` 按 `workRepos`（交办的 `repos` 或工作区，沿 `codeRunId` / `helperOf` / `continueFrom` 找）把本空间、所属业务、改到的仓库挂的技能单独列一节，`skillIndex` 不再列挂在别的空间上的技能；改到的仓库的 SPACE.md 也进说明；`code_workspace` brief 同样。
- 产物（`artifacts.ts` 的 `take`）：记内容哈希 `run_artifacts.sha`，同样内容再交时硬链接到已存的文件；没有扩展名的文件按开头字节认出 png / jpg / gif / webp / webm / mp4 / mov / pdf 并补扩展名。
- 网页：需求树标“测试通过 / 失败 N”，节点详情“测试结果”（`RunArtifacts` 支持直接给 `items`）；设置 → 空间“这个空间的技能”。接口 `GET /api/requirements` 带 `testState`，`GET /api/requirements/:id` 带 `testState`、`testResults`。

## 2026-11-08：在交办之外做完的编码自动收尾

- `code-branch.ts` 的 `settleCodeWorks`（每小时随 `item-sweep` 跑，`POST /api/items-expiry/sweep` 也会跑）：没在编码、评审和 Git 同步、一小时没动的交办，每个有提交的工作分支都已在 origin 上（`fetchBranch` 后本地分支是 `origin/<分支>` 的祖先，且不是 omem 自己推过的那个提交：`output.pushed`、`work.delivered`）时记成已确认（`appliedAt`、`settled: "pushed-outside"`，`pushed` 带 `outside: true`），留下的项照常由同一分支的下一次交办接上；否则同一分支上有在它最后一次动静之后开的交办时记 `supersededBy`，没做完的项标 `wontdo` 并写明去处。两种都取消这几轮的宿主卡片、归还工作区。
- `code-works.ts`：`supersededBy` 显示“由新交办接着做”；本人停下的交办先于“等你决定”显示为“你停下的”。
- 检查命令和外部 Agent 命令的输出在宿主收的时候去掉终端颜色代码（`util.ts` 的 `stripAnsi`，预览日志共用）；交办视图显示旧记录时也去掉。

## 2026-11-09：规则里的主助手可以把触发交给别的 Agent

- `runner.ts`：环境里的“已有的 Agent 档案”按这次运行实际有的工具写用途：有 `run_agent` 写可交办，只有 `ask_agent`（规则运行的主助手，`rules/actions.ts` 的 `assistantScope` 去掉了交办工具）写“不能交办，用 ask_agent 请教”，都没有就不列。之前规则运行的主助手看到“可用 run_agent 交给它们”去找交办入口，找不到就调 `report_rule_failure`，规则显示为失败。
- `tools.ts` 的 `ruleHandoff`：规则运行里调 `run_agent` 时，新运行沿用父运行的 `rule`、`lark`、`threadId`、`replyAt`、`silent`、`hideThinking`、`conversationId`，`denyTools` 去掉交办与请教，任务里附上父运行的原始任务；`rules/actions.ts` 的 `assistantScope` 不再拒绝 `run_agent`。静默排查时被交办的 Agent 在话题里发言，跟进记录记在交办它的运行上（`handoff`），话题里的回复回到主助手。回归：`test/rule-handoff.test.ts`。

## 2026-11-09：Codex 不再为每次 omem 工具调用请求审批

- 起因：常驻服务器上 codex-acp 2.5.0 的每次 omem 调用都先发一次“MCP tool call approval”，11-07 起平均每次 30～40 秒，有的一直没有发出（规则运行因此报失败）。omem 的工具不带 MCP 注解，Codex 把它们当作有破坏性、会访问外部，只要不是“完全访问”模式就每次都问；`acp.ts` 每次选“允许一次”。
- `mcp-server.ts`：列工具时都加 `destructiveHint: false`、`openWorldHint: false`（权限仍由 omem 每次调用时检查）。`acp.ts`：MCP 工具审批有“本会话允许”时选它。回归：`test/rule-handoff.test.ts` 的 MCP 注解一项；真实 codex-acp 下是否不再询问，部署后看运行事件里还有没有这类审批。

## 2026-11-09：做梦轮查存量、关联候选记住判断无关的、错过的定时任务补跑

- 起因：常驻服务器上 10-30～11-08 应跑 10 晚，2 晚计时器没触发（`last_run_at`、`dream_at` 都没动，日志无报错，同一秒的 heartbeat 照常），1 晚 Agent 启动即 EPIPE；跑完的 6 晚每晚只改 1～4 处：任务只给当天变化（每天新记忆个位数），digest 经验按“同一原件”分组几乎凑不出组（364 条里只有一个原件有 2 条），关联候选把 `view` 当依赖（`includes` 子串匹配，命中 preview）且没有否决记录，4 晚重复核对同一对。croner 10 在假时钟里 30 天每天都触发，没找到漏跑的根因。
- `scheduler.ts`：触发包进 `fire`（更新 `last_run_at` 也在 try 里）；`catchUpSchedules` 每分钟一次（`restartScheduler` 里的 unref 定时器），上一个时间点过去 90 秒～6 小时、`last_run_at` 早于它的补跑并写日志；一小时内会再跑的和从没跑过的不补。
- `jobs.ts` 的 `agent()`：EPIPE / ECONNRESET / connection closed，两分钟内且还没有工具事件时重试一次（运行里记一条状态）。做梦报告用 `replyOf`（最后一条消息）。
- `dreamStockBatch`：每晚取 80 条上次做梦前就有的有效记忆（按 created_at、id，kv `dream_stock_cursor`，到头从头再来），`sameTopicPairs` 找相近的对，单独一节列给 dreamer（去掉和当天那节重复的对）；只有存量对时也会跑。
- `digest-merge.ts`：按同空间、同档案的向量分组（以种子为中心，成员都和种子相近），组可以跨原件；没有向量时按同一原件。`DigestGroup` 改为 `memories[].sourceId` + `sources[]`。
- `space-candidates.ts`：`dependsOn` 按清单类型整词匹配依赖名；多个空间发布同名包的不算；表 `space_relation_declines`、`declineRelation`，候选去掉被判断无关、且没有新一类依据（数字归一）的对。工具 `relate_spaces` 加 `decline`（note 写原因）。`roles/dreamer.md` 第 00、1、7 条跟着改。

## 2026-11-09：规则运行设了唤醒时保留它的后端会话

- 起因：常驻服务器上一次报警规则运行设了 5 分钟后的 wake_later 接着查，运行结束 45 秒后它的会话就被清理，唤醒时恢复失败（Internal error），新会话拿不到上一轮的执行结果，只记了一笔就结束。`releaseRuleSessions` 只看排队中的 `resumeSessionId` / `resumeFromRun`、同一 lane 和跟进中的话题，没看排队中的唤醒（`kind='wake'`，原运行在 `target.resumeRunId`）。
- `session-cleanup.ts`：排队中的唤醒和待触发的消息唤醒（临时规则的 wake 动作）指向的运行，会话保留到唤醒结束。回归：`test/session-cleanup.test.ts` 的唤醒一项。

## 2026-11-09：规则和档案的“完全访问”

- 起因：报警规则用的内部命令行工具在 Codex 只读沙箱里起不来（读网卡 EPERM、不能联网），每条命令都要走沙箱外执行的审批，一轮二三十次；codex-acp 2.5.0 偶尔把审批请求压几分钟才发出（这次 4 分钟，Agent 先报了失败，命令在它结束后才跑）。omem 本来就批准所有非编辑类命令，沙箱对这类运行只多了等待。
- 规则的 agent 动作和 Agent 档案加 `fullAccess`（规则页、Agent 页的开关，默认关）。`runRole` 只在规则运行、档案打开时生效，评审检查、复盘、对比运行、访客不用；`acp.ts` 选 `full-access` 模式（`agent-full-access`、`bypassPermissions`、`danger-full-access`、`yolo`），没有时记一条状态照旧运行，此时审批也放行编辑；`cli.ts` 的 codex 用 `--dangerously-bypass-approvals-and-sandbox`，claude 用 `--permission-mode bypassPermissions`。后台会话池的键带上它。规则交给别的档案（`RULE_DELIVERY`）、唤醒续轮（`wakes.ts`）沿用。
- 只有本人能打开：`saveRule` 非本人保存时新开的 `fullAccess` 返回 403，漏写的保留原值；`saveAgentSpec` 非 user 保存保留原值，`PUT /api/agents/:name` 只认本人的。检测结果记下后端的模式（`ProbeInfo.modes`），网页 `fullAccessHint` 按它说明当前后端支不支持。回归：`test/full-access.test.ts`、`test/rule-handoff.test.ts`。

## 2026-11-09：内置角色和访客的完全访问

- 起因：网页对话里的主助手跑要联网的命令时同样一条条等审批（常驻服务器上一次数据对账 13 轮，几乎每次唤醒都是“先 functions.wait 某个 cell”），规则和档案的开关管不到它。
- 判断集中到 `prepareRun`（`PreparedRun.fullAccess`）：运行自己的值（规则的开关、回答访客那一轮的访客开关）优先；否则本人的运行用档案或内置角色叠加设置（`_roles/<名>.overlay.yaml` 的 `fullAccess`）的值；别的用户的运行、评审检查、复盘、对比运行不开。规则运行在 `jobs.ts` 里总是给明确的值，不跟角色或档案走。
- 内置角色：`setRoleFullAccess`、`PUT /api/roles/:name/full-access`（只认本人），改技能和工具时保留；`guest`、`gatekeeper` 不设，改在 `lark.guests.fullAccess`（设置 → 渠道 → 访客提问，默认关），`lark-guest.ts` 的回答访客运行和 `threadTurn` 里含访客消息（`meta.asker`）的那一轮用它。会话复用键带上它，访客一轮和本人一轮不会共用同一个完全访问的进程。
- 访客提问的“也回答私聊”从勾选框改为开关，和上面的开关一致。回归：`test/full-access.test.ts`。

## 2026-11-09：规则动作“转发到”

- 本人要把通知机器人私聊自己的消息转到别的群，目标是人时建群转发。规则原来只能在触发的会话里发言、只能把机器人拉进触发的群。
- `rules/forward.ts`：`forward` 动作（`to: { chatId, name, kind: group | p2p }`、`note`），机器人发出，uuid 由规则、消息、目标算出去重。群：`chatBots` 里没有 omem 的机器人就 `inviteOwnBot`。私聊：对方取采集到的最近一条 `sender_kind='user'` 的发送人，以本人身份 `im +chat-create --as user --users <对方> --bots <app_id>`，群 id 存 kv `rule_forward_group:<私聊 id>` 复用。只用于“新消息”触发；非本人保存时新加或改动目标返回 403。AGENTS.md 的本人身份写操作清单加上这两处。
- 规则页“转发到”从采集过的会话里选目标（`rule-options` 的 chats 带 `chat_mode`）。回归：`test/rule-forward.test.ts`。

## 2026-11-09：对话里指定转发目标；补充消息直接交给进行中的一轮

- 转发目标：`save_rule` 在回答本人自己消息的那一轮（`ownerAskedThisTurn`）可以新加或改动 `forward` 的目标，`chatId: "current"` 换成本会话的飞书群，名字和类型从 `lark_cursors` 补；`saveRule` 的 `opts.ownerAsked`。规则草稿（`compile.ts`）认识 forward。
- 中途接收：常驻服务器上一轮在跑命令行时，本人的补充消息要等它下一次调用 omem 工具才能交进去，看上去像在排队。codex-acp 2.5.0 有扩展方法 `_session/steering`（`idleBehavior: "promptRequired"` 时没有进行中的一轮返回 `promptRequired`），本机实测 `injected` 且这一轮的回复包含补充内容；直接再发 `session/prompt` 只会排成下一轮。`AcpHandle.steer`；`steer.ts` 拆成 `claimSteering`（先看）+ `commit`（交出后再移走）；`inbox.ts` 收到消息后 `steerLiveTurn`，交不进去（后端不支持、这一轮已结束、发送人不同）就照旧等工具调用。回归：`test/steer-live.test.ts`（假 Agent 的 `FAKE_STEER`）、`test/rule-forward.test.ts`。

## 2026-11-09：会议结论发在私聊里而不是上次的话题；下一步卡片可以直接写

- 会议结束后的结论投递到本人和机器人的私聊会话（`ownerChatThread`），飞书发送跟着会话的 `lastTopicId` 回复，本人上一条消息在私聊的某个话题里时结论就进了那个话题。会后那一轮的输入带 `topLevel`，`jobs.ts` 投递时带上（会后那一轮也带着拉机器人入会的规则，走的是规则那条投递分支，两条分支都要带；第一次只改了一条，部署后又进了话题），`lark-bot.ts` 的发送直接发到私聊本身，并把会话的 `lastTopicId` 清掉、`lastMessageId` 换成这条（下一步卡片跟着它）。回归：`test/lark-answers.test.ts`（两项：发送本身，和带规则的会后运行走一遍真实投递）。
- 下一步（suggestion）卡片在飞书上一律带输入框和“按我写的做”：选一项时写的话接在那项后面一起说，不选只写也行（`answerAsk` 合并 `option.message` 和文字）。回归：`test/asks.test.ts`。

## 2026-11-09：规则的快速检查、“等某个会话的新消息”、转发回触发的会话

- 本人要的场景：有人在群里 @ 或私聊要验证码，5 分钟内验证码机器人发来新码就自动发给他。原来私聊和没有机器人的群只靠采集（常驻服务器上每 10 分钟），赶不上；规则也不能等另一个会话的消息。
- `rules/fast.ts`：`pollFastRules`（`main.ts` 每分钟；只在有勾了 `trigger.fast` 的启用规则时搜，`+messages-search` 群里 @ 本人 + 私聊，`--query` 取条件里 `message.text contains` 的词，kv `rule_fast_since_ms`，往前多看 2 分钟，`dispatchRuleEvent` 加 `only` 只交给这些规则）；`waitThenAct`（`wait-message` 动作排 `rule-fire` 运行，每 10 秒 `+chat-messages-list` 读目标会话，触发之后第一条符合的作为 `RuleEvent.awaited`，`fireAfterWait` 接着做后面的动作；超时按 `onTimeout`）。
- `forward`：`awaited` 时转发等到的那条；`to.kind=origin` 回到触发的会话（群：机器人回复在触发消息下，必要时以本人身份拉机器人；私聊：对触发消息的发送人以本人身份建群并记住）。保存检查：`checkWaitRule`、`origin` 也算转发目标（非本人要求的一轮不能新加）。规则页：快速检查勾选、“等某个会话的新消息”编辑、“回到触发的会话”。AGENTS.md 的本人身份写操作清单跟着改。回归：`test/rule-fast.test.ts`。

## 2026-11-09：主聊天里的消息变成话题根后，后续消息不再跟进那个话题

- 起因：常驻服务器上本人和机器人私聊的主会话 `lastMessageId` 指着一条已经用 /topic 拆成独立话题的消息。往主会话投递（唤醒、交办结果、会议结论）时 `lark-bot.ts` 的发送在主聊天里“回复”这条消息，飞书把对话题根的回复放进那个话题，于是发到了为别的任务开的话题里。多 Agent 工作话题、规则在消息下开话题同样会让主聊天的消息变成话题根。
- `lark-send.ts`：回复带 `reply_in_thread` 且飞书返回 `thread_id` 时，发送记录带 `topicRoot`；`lark-bot.ts` 的 `releaseTopicRoot` 把同一个聊天主会话里还指着这条根消息的 `lastMessageId` 去掉（之后发到聊天本身），开话题的那个会话（或运行所属的会话）保留——编码进度卡片在请求下开的话题，结果本来就该回到那里。回归：`test/topic-root.test.ts`。已经指着话题根的旧会话不迁移：本人在主聊天里再发一条消息就换掉了。

## 2026-11-09：套餐额度纳入自动选择

- 原来只有额度用完（报错）后才避开那个账号。现在读本机登录账号的剩余额度：Codex 起 `codex app-server` 调 `account/rateLimits/read`（Pro 套餐只有周窗口，没有 5 小时窗口，窗口按长度认），Claude 在 claude-agent-acp 的会话里发本地命令 `/usage`；都不耗额度。对话和运行里 Claude 报的限额事件随时更新。存在 kv `agent_quota`（`src/agents/quota.ts`）。
- 快用完的账号（`agents.capacity.quotaAvoidAbove` 默认 90%，`quotaPerDayBelow` 每天剩余百分比默认不看）在角色运行的候选里排到最后；`list_ai_backends` 带 `quota`；设置 → AI → 并行 显示额度、阈值和“现在读取”；`peer call <设备> agents` 带 `quota`。回归：`test/quota-limits.test.ts`。

## 2026-11-09～10：决策模型支持 Cloudflare Clef；检测账号里的模型

- 提供方新增 `cloudflare`（`config.ai.providers[].accountId` 填账号 ID），决策走 Workers AI 的 `…/accounts/<账号>/ai/run/@cf/cloudflare/<模型>`，格式同 Jev 的 System One，默认 `clef-flash`；返回包在 `{result}` 里也认（`src/core/decision.ts`）。
- `decide` 可带 `media`（图片、音频、视频的 data URL）；`decisionMedia`（`src/core/ai-keys.ts`）给出模型能读的媒体：`clef-flash` / `clef` 读图片，`clef-omni` 还读音频和视频，其他模型只读文字，带了读不了的媒体直接报错。设置页决策的状态行写明能读什么。
- 读提供方的模型列表（`refreshModels`，`cache/ai-models.json`，添加 key、检查通过或过一天时刷新）：设置页的图片、语音、转写、委托、决策模型改成下拉选，可手填；留空用列表里版本号最大的模型（`newestOf`，列表为空时用内置默认）。图片的内置默认改为 `gpt-image-2.6-flare`。

## 2026-11-10：运行前自动选 AI；后端出故障时换后端

- 选 AI 收成一处（`src/agents/choose-ai.ts` 的 `chooseAI`）：没指定 AI 的运行开始前，从“按原来的设置”和任务选型的候选里挑一个，材料是任务、谁来做、现在时间、总体偏好，每个选项带适用说明、占用、账号额度和最近的故障。有决策模型时用它（`decide` 的 choice），`always` 档在没有决策模型或它出错时问通用模型（`askModel`）。按运行类型设置：`agents.routing.choose` 的 `conversation`（新开 Agent 会话时选，记在 `threads.settings.auto`）、`rules`（规则交给的 Agent）、`tasks`（交办和后台任务，编码、评审除外）。
- 原来 Agent 档案的运行（规则交给的、交办出去的）只用档案的后端，不换；现在没指定 AI 时和角色运行一样按 `failoverProfiles`（选中的、原来的、角色在其他后端的模型、兜底、任务选型的候选）换。
- 原来只有排队、限流、额度用完和“还没开始就失败”才换后端。现在后端本身出故障（`isBackendDown`：进程退出、连接断开、看门狗判定没有活动）也换，已经做了一半也换：接手的后端在任务前面看到上一个已做的写入（`retry.ts` 的 `partialAttemptNote`），出故障的后端 15 分钟内排到最后（`capacity.ts` 的 `markDown`）。对话也一样：看门狗超时不再在同一个后端重开会话，接手的后端拿到会话背景（原来只拿到新消息），下一轮留在它上面。

## 2026-11-10：远程使用 CLI 与 MCP；鉴权插件；按邮箱预建账号

- 设计与实现：docs/v2/remote-clients.md。`omem tool` / `omem mcp` 加 `--url`、`--remote`（`OMEM_URL` 同样），不用配对就以自己的身份连远程 omem；凭据取记下的远程地址（`~/.omem/client.json`，`omem remote add|list|default|rm`）、`OMEM_TOKEN`、`OMEM_AUTH_CMD`（`src/remote-client.ts`）。只有 `OMEM_TOKEN` 没有地址时仍连本机服务，omem 运行里的 Agent 行为不变。
- `omem login <地址>`：确认码 + 浏览器确认（`#/cli-login`）换一个标签 `cli:<主机名>` 的 API 令牌（`src/auth/cli-login.ts`，表 `cli_logins`，`api_tokens.client`）；账号页“命令行与 MCP”列出和撤销。`omem open [页面]`：用命令行的凭据换一次性登录链接，登录后回到那一页。
- `/api/tools`、`/mcp` 除了运行令牌也认用户凭据（`src/auth/external-tools.ts`）：工具是设备外部 Agent 那套（`peer-agent.ts` 从只给本人改成按用户：空间 `accessibleSpaces`、工具按全局权限裁剪，不能交办编码的去掉评审交付工具），会话信息在 `x-omem-*` 请求头（URI 编码），运行带 `user_id` 和 `via`。新全局权限 `tools.external`，内置管理员、成员、访客都有。设备交办（`run_agent` / `ask_agent`）排出的运行记在调用的人名下。
- 鉴权插件 `api.authenticator`（`src/auth/authenticators.ts`）：只在 omem 进程里运行、要在清单 `permissions.authenticators` 声明；请求先经 `checkBearer` 验证，结果按凭据哈希缓存到过期（最多 10 分钟），`resolveAuth` 读缓存。认出的身份经 `bearerLogin` 找账号或认领预建账号，都没有时按 `auth.signup` 建等待批准的账号并通知一次。
- 按邮箱预建账号：`POST /api/users`、成员页“按邮箱添加成员”、`omem user add --email [--login-any]`，`PATCH /api/users/:id` 可改邮箱；邮箱一律存小写（迁移时转换），建账号和改邮箱时查重。`claimByEmail`：飞书登录（`verifiedEmails`：企业邮箱优先，再是邮箱）和鉴权插件（`emailVerified`）按邮箱认领唯一的预建账号，多个时不认领并通知。飞书登录和绑定都申请 `contact:user.email:readonly`、`contact:user.employee:readonly`（`identityScopes`），只为这两项拿到的令牌不当作连接保存；机器人检查列出缺的这两项。
- 修复：名字以非拉丁字符开头又带字母数字时（“用户 u200”）生成的用户 id 带前导连字符，个人空间对不上而建账号失败。

## 2026-11-10：复用已有分支的交办只比较自己的改动

- 修复：在已有分支上交办（`fromBranches`）时，比较起点是选分支时本地的旧提交；首轮同步把 origin 的新提交拉进来后，运行详情、diff 统计、评审输入、检查点 0（“全部改动”）、检查命令的 `OMEM_BASE`、临时索引都把这些公共提交算成交办的改动。
- `WorktreeRef.diffBase`（`code-branch.ts`）：规划时先 fetch，取本地分支和 origin 的共同祖先；拉取 origin 时（`code-sync.ts` 的 `nextDiffBase` / `settleDiffBase`），只要 origin 没有这次交办的提交，就推进到拉进来的 origin 提交（冲突停下的同步处理完才生效）；origin 已经有交办的提交（推送过）时不动。`changeBase` 对较早的检查点取 `merge-base(diffBase, 终点)`。合并别的分支（`onto`）不改变比较起点。
- 旧交办（没有 `diffBase`）读取时按“本地分支与 origin 的共同祖先”补上（`withDiffBase`，不写库，下一轮随工作区保存）；origin 已含它某一轮编码检查点的提交时保留原起点。保存的补丁、统计在能确定该轮终点（检查的提交或该轮检查点）时按新起点重算（`codeDiffView`，运行详情和评审共用）。首轮单项误记进修改项的公共提交在读取时排除（`ownCommits`）；首轮的提交归属从同步后（`syncHead`）算起。
- 整段压缩、回到检查点：范围里有交办开始前分支上已有的提交（本人未推送的）或 origin 上已有的提交时拒绝，提示按修改项回退（`assertOwnRange`）；多仓库压缩在任何写入前先检查全部仓库。

## 2026-11-11：网页版 VS Code 认本人的登录；实时连接按需建立；可选 HTTPS（HTTP/2）

- **网页版 VS Code 在网页地址上打开**：`ideAllowed` 认本人的登录会话（`omem_sid`，本人、非受限、同源），omem 重启或直接打开 `/ide` 后不再 401；转发给 serve-web 时去掉登录 cookie；未登录打开 `/ide` 页面时给出登录入口。
- 分享页“一直在加载”是浏览器在 http 下每个地址 6 条连接被各标签页的实时连接占满。实时连接改为按需建立（`web/src/lib/live.ts`：分享页、登录页不建）、后台 45 秒断开、冻结或进入往返缓存时立即断开、回前台重连并通知页面刷新（`onServerResync`）。
- 新增可选 `https` 配置（`src/server/secure.ts`：`port`、`cert` / `key` 或 `selfSigned`、`hosts`），在原 http 端口之外再开一个 HTTPS 端口，浏览器在上面走 HTTP/2；`http2Compat` 补 Host、移走伪首部、去掉 HTTP/2 禁止的连接级首部。

## 2026-11-11：飞书消息的加粗与引用编号；需决定的卡片统一收尾

- 飞书发送统一经 `src/channels/lark-markdown.ts` 规范加粗：中文标点紧邻 `**` 时按 CommonMark 的规则不成立（`**建议：**先…`），发出前把句读移到加粗外、括号引号外侧补空格、去掉标记内侧空格；代码不动。
- 句末引用编号改为 `(n)`（`citations.ts` 的 `citationMark`）：⑪ 以后的带圈数字在常用中文字体里缺字形，回退到别的字体后大小不一。
- 需决定的卡片（提问、批准、草稿确认、规则脚本审批、访客审批、入会确认）收尾统一为 `decidedBlocks`：谁、何时、决定，一句结果，工具的原始输出放进折叠的“完整输出”。

## 2026-11-11：“有人找你”和渠道分开；规则先于它

- 流程搬到 `src/mentions/`（`mentions.ts` 预筛、等待、每日上限、处理与兜底、`reply_to_asker` 的检查；`triage.ts` 分诊；`channel.ts` 渠道接口 `MentionChannel`）。飞书实现接口：`src/channels/lark-mentions.ts`（挑出找本人的消息、读消息和引用、已读、前后聊天、发送人、盯群和机器人直接回答、规则键 `lark:<id>`），`mention-reply.ts`（在飞书上回复和草稿卡片）。`src/channels/mention-triage.ts` 移到 `src/mentions/triage.ts`，前后聊天和发送人改由渠道提供。运行类型、`input.mention`、`handled_messages` 的 `lark-mention` 不变；`input.mention` 多了 `channel`（没有的按飞书）。
- 设置从 `lark.mentions` 移到顶层 `mentions`，回复方式按渠道放在 `mentions.reply.lark`（`group` / `p2p` / `p2pVia`）。读取配置时把旧位置迁过去（`config.ts moveOldSettings`，保存时对文件里的旧位置同样处理），之后可删。设置页文案不再只说飞书。
- 和规则的先后：规则在这条消息上触发过（不论动作类型，跳过也算），或认领后正在等（`rule-fire` 运行排着或在跑），“有人找你”让开；规则还在判断（`dispatchRuleEvent` 进行中，`rules/store.ts rulesJudging`）时等一分钟，和等 ingest 合计最多 8 次。判断在 `rules/store.ts ruleClaim`。原来只在规则带“交给 Agent”动作时让开，只通知、只转发的规则会和这里各提醒一次；带等待的规则等待比 `delayMinutes` 长时两边都处理。
- 规则页列表最后一条“没有规则处理的、找你的消息 → 有人找你”（不能删除，显示开关和今天的次数，点进去到 设置 → 渠道）；新接口 `GET /api/mentions`。docs/v2/mentions.md 加“消息先经过谁”“渠道”，“和规则的关系”重写；docs/v2/rules.md 加“和‘有人找你’的先后”。

## 2026-11-11：有人找本人时先分诊再处理

- “预筛 → 决策模型分诊（`roles/mention-triage.md`）→ 按需交给主助手或档案 → 可选回复对方”（现在在 `src/mentions/`，见上一节；设计 docs/v2/mentions.md）。新运行类型 `mention`；处理是带 `input.mention` 的 `agent` 运行，最后的回答作为提醒，卡片关联运行以便接着聊。
- 新工具 `reply_to_asker`（只给这类运行，目标固定，按 `mentions.reply.lark` 变草稿卡片或直接发，写 `audit_events`）；AGENTS.md “渠道”新增这一处以本人身份写。
- `notify()` 对 6 小时内已提醒过的同一批聊天消息返回 409，要求用 `replaces`（原因：实时采集和轮询各排一个 `ingest`，读同一批行各提醒一次）。新设置 `mentions`（原为 `lark.mentions`；`guidance`、`noDecision`、`perDay`、`reply`）。

## 2026-11-11：编码交办里要本人定的问题先交给助手；精简评审

- 编码 Agent 的 `report_task`(owner)、评审负责人的 `rule_review` / `rule_dispute` owner 和方案分歧都先进“等助手处理”（`code-tasks.ts` 的 `toDecide`）；助手可以 skip 驳回或 later 放下还没做的评审项，用 `settle_code_task` 的 `add` 新增需求漏掉的项（不经本人每次交办最多 5 项），定不了才 owner 发卡片。去掉 `existing_authorization`，卡片发出后只等本人；同一处助手放下两次后评审再提直接问本人；卡片因助手转达关闭时注明。起因：编码 Agent 的问题直接发给本人，同时被叫醒的助手又在后台把它处理掉，卡片只显示“已失效”。
- 精简评审在补丁堆起来的地方自动加上（`code-loop.ts` 的 `simplifyDue`）：改动到 200 行代码而它还没看过，或它看过之后又出现“修过的地方又修”。`coder`、`reviewer`、`review-arch`、`review-simplify` 的说明加了不写防御性补丁、判断在边界上处理一次的要求。
- 设计稿 docs/v2/coding-plan.md（方案与变更说明，未实现）。

## 2026-11-11：一件事的后续消息跟着它最近在哪里聊

- `src/agents/home.ts`：一件事是按 `parent_id` 连起来的一串运行，归属位置记在最上面那个运行的 `output.home`。唤醒、协调回复、编码汇报按它投递；本人在别处回复这件事的消息，或在别处用写工具操作它的运行，归属就迁到那里。
- 飞书会话本身只引用这件事自己的上一条消息，没有就不引用；唤醒那一轮开的工作话题挂在这件事自己的消息下。原话题发不进去时退回本人私聊，并写明是哪件事的后续。

## 2026-11-11：后端出错、换后端的顺序与选型记录

- 上游流中断（stream disconnected、empty stream、RST_STREAM、502 / 503 / 504）算后端故障并按模型冷却；`stay_quiet` 之后后端对空的最终回复报错按完成处理（`runner.ts` 的 `quietAfterAll`）。
- 点名的 AI 不可用时按 `agents.routing.pinnedFallback`（默认 unavailable）换并写明。所有换后端的地方都按选型说明排的顺序：运行前选型时决策模型给出整个排序，没经过选型的运行第一次要换时问一次（`fallbackOrder`，缓存 10 分钟），没有决策模型才用静态兜底顺序；记录里写明顺序来源。
- 每次运行记一条带 `choice` 的状态事件（选了谁、理由，或为什么没选），换后端带 `failover`。
- 按模型的每日额度：“今日额度用完”类错误只把那个模型排除到次日零点；设置 → AI → 并行 的单独上限加“每天最多”；ACP 探测保存每个模型的说明（`modelNotes`）。按修改项推进的交办续轮时保留新指定的 AI。

## 2026-11-11：规则——电子表格按行比对、发到群、“这个群”、所属空间

- 文档变化规则可指定“发到”会话（auto / draft），Agent 在那个群里回复指定消息或话题并 @ 修改人。
- 电子表格存快照、逐行比对，每个新增或改动的行一个事件（`change.sheet` / `change.row` / `change.action`）；多维表格按记录分发（`change.recordId` / `change.tableId` / `change.action`）。新增条件字段 `change.byOwner`、`change.editorId`。规则运行用 `lark_write` 回写后 5 分钟内，只由本人造成的变化不再触发同一条规则（`src/rules/own-writes.ts`）。
- `save_rule` 的条件 `chat.id` 和“发到”支持 `current`。规则页列表显示所属空间或“全局”，所有类型的规则都能改所属空间；规则换空间时挂在它上面的工作文件一起移过去，共享的工作文件可在原件页换空间（`moveWorkFile`）。

## 2026-11-11：命令规则

- 命令规则（docs/v2/command-gate.md）：配置 `security.commandRules`（仅本人经 `GET/PUT /api/security/command-rules` 修改）。`command-gate.ts` 在 `<home>/bin/guarded` 生成同名包装，放在 Agent 进程 PATH 最前；`POST /api/command-gate`（本机连接 + 运行令牌）按规则放行、拒绝或建审批（`asks`，`context.handler="command-gate"`），长轮询等 `waitSeconds`，之后才有结果的用 `fireWake` 唤醒。审计 `command.allow|ask|approve|reject|deny|pending|expire`。防误操作，拦不住绝对路径调用。

## 2026-11-11：主线程卡顿监测；向量快照

- 主线程卡顿监测（`src/core/loop-monitor.ts`，`diag` 的 `eventLoop`）：延迟超过 500 ms 记日志，带当时的 SQL / git 同步步骤。
- 向量变更记录 `vector_log`（触发器）加量化快照（`cache/vectors`）：检索进程重启后读快照再重放记录，不再每次整份重读；向量通道空闲 30 分钟才退出，载入不会因超时被杀。
- `page_cites` / `symbols` 加索引（`list_pages`、`find_symbol`）；网络 git（fetch / ls-remote）改为异步。

## 2026-11-11：Wiki 规划接受目录说明页、案例页和空计划

- `submit_plan` 的页面类型原来只有 guide / concept / howto / reference / topic，而规划角色被要求给新目录计划 `<目录>/index`（kind=index），已有空间里又多是案例页（case）：带这两类的计划被参数校验拒绝，运行以“规划没有提交页面计划”失败。现在类型和 `write_page` 一致；现有页面够用、这次只移动页面时可以提交空计划，运行按完成结束。
- 常驻服务器上实际失败的那几次是另一种情况：助手用 `generate_wiki` 让规划去改一页已有页面，规划自己用 `write_page` 改完了、没有可计划的页面，运行却按“没有提交计划”记为失败。现在规划没交计划但自己写过或移动过页面时按完成结束；`generate_wiki` 新增 `pages`：只改已有的几页时不规划，每页直接交给写作（`src/wiki/generate.ts`）。

## 2026-11-11：交办结束后清理它留着的后端会话

- 评审项在按修改项推进的交办里各留一个会话（`persistSession`），编码 Agent 也留一个；交办确认或丢弃后没有任何地方释放它们，豆包这类把会话记在账号历史里的后端会一直留着。现在每分钟的清理（`session-cleanup.ts` 的 `releaseRuleSessions`）把已确认或已丢弃的交办留下的会话标为可清理；交给 Agent 的工作（`agentWorkId`）里两天没有新运行的会话同样释放。

## 2026-11-11：同一批聊天消息只整理一次

- 机器人实时收到和本人身份轮询各自为同一个会话排整理（ingest），说明文字不同所以不合并，而且都从同一行读起：同一批消息被读两遍。现在已经在排队的运行里有这个原件时，不看说明直接并进去；整理运行开始读时记下读到第几行（kv `ingest_to:<原件>`），之后再为同样的行排队就跳过，新的运行从上次读完的下一行开始（不再从“最后一次追加的位置”开始，中间追加的行不会漏）。

## 2026-11-11：拉人进群

- 新工具 `lark_invite`（分组 `lark-owner`，`src/channels/lark-invite.ts`）：以本人身份把人或机器人拉进本人的群，一批群一次调用。`resolveInvites` 一次列出全部问题：群读名字、拒绝单聊；人按 `lark_people` 的 `cli_open_id`、`contact +search-user` 完全匹配，重名列候选，`ou_` 取不到名字的拒绝，查到的 `rememberPerson`；机器人按 `self`、`lark.bots`、kv `lark_known_bots`（`chatBots` 读到时写入）、`bots_seen_in`。
- 有人时整次 `held` 审批，参数存成只含 id 的规范形式，相同参数在等批准时不再发卡，卡片固定发到本人私聊、全文不截断（超 20 KB 要求分次）；只拉认得出的机器人默认直接执行，新配置 `lark.invite.botApproval`（设置 → 渠道 → 拉人进群）打开后机器人也审批，只拉 `self` 且 `ownerAskedThisTurn` 的那一轮除外。
- `runInvites` 人 50、机器人 5 一批 `chat.members create --succeed-type 1`，逐群写结果和 `audit_events`（`lark.invite`）。`inviteOwnBot` 移到这里共用 `addChatMembers`；`set_chat_watch` 去掉 `invite_bot`；lark-cli 用户 scope 补 `im:chat.members:write_only`；经 `--peer` 的外部 Agent 和“有人找你”的处理不给这个工具。

## 2026-11-11：方案与变更说明（docs/v2/coding-plan.md）

- 新对象“方案”（`designs`、`design_revisions`，`src/designs/`）：一组决定（`add` / `change` / `remove` / `refactor`，各有栏目，每栏 `brief` 加展开的 `text` / `code` / `table`），加事实、整体行为表、不一致和意见（`problem` / `risk` / `improve` / `question`，状态 open / resolved / dropped）。来历 `own`（交办前写，本人确认）、`external`（别人的技术方案，提取加评估）、`derived`（编码 Agent 事后交的变更说明）；按来历校验，id（`D<n>`、`C<n>`）各版本稳定，重新评估必须交代上一版每条意见。
- 工具：`submit_design`（`code-handin`，只有 `designer` 能写 own / external）、新分组 `design`（`read_design`、`assess_design`、`settle_design`）；角色 `designer`；运行类型 `design`（评估别人的方案，结果回到发起的对话，网页发起的发通知）；设置 `agents.design.mode` / `confirm`。
- 交办：`submit_brief` 多 `design: { needed, why }`；`delegate_code` 多 `design`（auto / always / never）和 `design_id`；方案阶段在编码前检查之后（`src/designs/work.ts` 的 `designStage`），等确认时这一轮以 `awaiting-design` 结束（交办阶段 `design`），确认走 `decideDesign`（卡片 handler `design-confirm`、`POST /api/designs/:id/decide`、`settle_design`），通过后同一轮重新排队；`continue_code_run` 表示不等方案直接编码。`plan_tasks` 每项可带 `decision`，`finish_task` 可带 `deviation`、`simpler`；`submit_review` 的问题可带 `decision`（新列 `review_findings.design_decision`）。
- 分支评审：`review_branch` 多 `design_id`（不传取事项上最新的 own / external 方案）；有方案时拆分用 `submit_change_points` 的 `decisions: [{ decision, files }]` 只写归属（`attributeFiles`，其余进 `outside`），`rule_review` 多 `decisions`（`done`、`deviation`、意见状态）；没有方案的照旧。
- 接口与网页：`/api/designs`（列表、详情含 `changes` / `outside` / `runId`、发起或重新评估、`decide`、`concerns/:cid`、`diff?decision=`，补丁结构同 `task-diff`）；`/api/code-works/:id` 多 `design`（没交的变更说明不算）；方案变化发 `changed` 事件（entity `design`）。网页 `DesignView`、`#/design/:id`、`#/designs`、交办视图“方案”标签、事项页“方案”一栏、设置 → AI → 方案先行、仓库空间“总是先写方案”。

## 2026-11-11：没交结果的交办也能看改动；VS Code 插件按决定看改动

起因：外部设备的 Agent 编码（`code_workspace`）在 `finish` 之前不保存补丁，网页“变更”只读保存的补丁，所以一直显示“这一轮没有改动”；插件的看改动接口只认按修改项推进的交办，这类交办连“和分支比较”都用不了。

- `workPatches` 多一种取法 `work`（`GET /api/runs/:id/task-diff?work=1`）：每个仓库从 `changeBase` 到工作区现在的样子。工作区有没提交的改动时，用索引的一份副本（`GIT_INDEX_FILE`）`add -A` 后 `diff --cached`，新文件也在，工作区自己的索引不动；`to` 是 `worktree`。都提交了就是两个提交之间的差异。分支评审是 `base` 到 `tip`。`core/git.ts` 的 `git()` 多一个可选的环境变量参数。
- `task-diff`：不按修改项推进的交办不带参数就是 `work`，`base=` 同样可用；只有 `tasks` / `from` / `to` / `since` 还要求按修改项推进。`file-at` 的 `rev=worktree` 读工作区里现在的文件（路径不出工作区、不进 `.git`、不跟出去的链接）。
- 网页 `CodeWork` 的“变更”：最新一轮没有保存的补丁、交办没结束时，打开标签读一次 `work=1`，带“刷新”。
- 方案：`designDiff` 在分支评审时给补丁带上 `from` / `to`；交办没有修改项时（外部 Agent 编码的、只有变更说明的），决定的补丁是它列的文件在全部改动里的那几段。
- 插件：`tasks.ts` 的 `showPatches`（原 `showChanges` 拆出来，任何来源的补丁都能打开）；`design.ts` 的“方案”视图（`omem.hasDesign`）；命令 `omem.work.changes`、`omem.design.diff`、`omem.design.openWeb`；`omem.work.compareBase` 不再限于按修改项推进的交办。测试数据加了一份方案和一次没交结果的外部编码。

## 2026-11-11：盯群和 @ 不再各答一遍、回答里的 @、会后说明、巡检知道本人在哪

常驻服务器上一天里看到的几件事，原因和改法：

- 盯着的群里有人 @ 机器人，同一条消息起了两个运行：盯群的那一路（`lark-watch` 会话）和当场回答的那一路（群或话题的会话），各回一遍，还各开话题。现在 @ 机器人、会被当场回答的消息不再交给盯群（`lark-watch.ts` 的 `answeredDirectly`，在 `handled_messages` 记 `direct`，本人身份的采集晚些看到也不再送）；当场回答的那一轮在上下文里带上本人盯这个群要什么（`watchPurpose`）。盯群的说明加了两句：同一件事的后续回在原话题里，@ 机器人的消息不会送到这里。
- 一条回复里 @ 同一个人两次：群里的回答由宿主在开头 @ 提问的人，模型又在正文开头写了 `@名字`。现在正文里的 `@名字` 换成真正的 @（提问的人、消息里 @ 到的人、被引用消息的发送人），每人一次，开头不再重复加（`lark-bot.ts` 的 `toAsker`）。助手的角色说明加了一条：结论是给谁的就 @ 谁（本人让帮某人看、本人回复了某人的消息时也 @ 那个人），同一件事不再用 `lark_send` 往同一个群发一遍。
- 机器人没能入会的会议也收到“没有记录”的纪要和建议：`meetingEnded` 在没有任何转写和会中聊天时不写原件、不起会后运行。会后运行的说明重写：本人自己在会上，不复述、不罗列别人的待办；落到本人头上的事逐件推进，主要是听的会只写要点，临时沟通只写结论，没有要说的用 `stay_quiet`。旁听窗口只记事实，不写建议。
- 巡检在本人开会时发了会上正在讲的内容，还夹带了早就发生的安排：巡检的任务和“有人找你”的分诊材料里多了“本人此刻”（`src/agents/owner-now.ts`：正在开的会、今天开过的会、最近一小时说过话的会话），`roles/heartbeat.md` 加了“本人在场的不用提醒”“只说新的、只说这件事”。
- “有人找你”的处理只给一句建议回复：处理说明改成先把事情往前推（要过后做的事写进事项并把提醒定在该动手的时候），提醒里写做了什么、还差本人哪一步；“收到，会处理”这类话不写。分诊材料多了“本人在这个会话里”（近 14 天发言数、这里 @ 助手问过什么）。
- 运行页“所在会话与关联”把结果只是发到那个会话的运行（有人找你的处理、会后说明）也当成会话里的一轮，列出了整个主会话的几十轮对话：现在只有本身是对话轮次的运行才列，长会话只列前后 9 轮；别的运行那一行写“结果发到”。
- 本人在话题里说“换另一个 AI 再试”，助手对自己这一轮调用 `switch_run_ai`：这一轮被停下重排，但对话轮次按会话的后端运行，不认运行上的选择，重排后还在原来的后端上，续接的旧会话里工具令牌也已失效。现在目标是对话轮次时改的是会话的后端、模型和强度并放掉旧会话，重排的这一轮和之后的轮次都在新的 AI 上（`tools.ts` 的 `switch_run_ai`）；角色说明写明这种要求不另外交给别的 Agent。
- 系统自动发的通知卡片被整理成待办并定时提醒，本人直接忽略：`roles/ingest.md` 写明这类卡片默认不建事项、不设提醒。

## 2026-11-11：内置角色合并不再因为 tools 那一行冲突；正文可以重新跟随源码

起因：一个只挂了技能的内置角色，每次源码更新都要手动合并，还总有冲突。合并后的基线是会前移的（干净合并和模型解决冲突后都把基线设成新源码）；反复冲突的原因有两个：frontmatter 的 `tools` 是一整行，副本里这一行和基线不同（早期合并把分组里已有的工具名也摊开写了，还多一行 `skills`），源码一动这一行就必然冲突；模型解决冲突时倾向把两边都留下，源码已经删改的旧段落留在副本里，正文越走越远，所以“只多挂了技能”的副本也没法自动变回叠加设置。

- `mergeRole`：frontmatter 按字段合并，`tools` 和 `skills` 按集合（源码现在有的，加上本人加的，去掉本人去掉的；分组已经带上的工具名不再单独列），只有正文按文本三方合并。合并或模型解决冲突之后，副本如果只剩技能和工具的差别，自动变回叠加设置。
- `followRoleSource`（`POST /api/roles/:name/follow-source`，Agent 页“正文跟随源码”）：放弃副本的正文，保留副本比源码多的技能和工具（源码特意排除的工具不带回来），之后源码更新直接生效。
- 模型解决冲突的说明：源码删掉或改写、本人没改过的段落按源码，不把旧写法和新写法并排留着；frontmatter 已合并好，不改。

## 2026-11-11：工作近况与人物卡（docs/v2/work-state.md）

- 新内置角色 `work-state` 和定时任务 `work-state`（默认每晚 02:50，打开）：宿主把最近 `workState.days`（默认 21）天的事实写进任务（本人发言多的会话、打开过或发过链接的文档、编码交办、打开的事项、会议、本人找助手做的事），角色在 personal 空间改 `state/work`（摘要 / 在推进的事 / 最近活跃 / 要追踪的对象 / 本人补充），再给有新消息的常打交道的人写人物卡 `people/<名字>`（每晚最多 `workState.people`，默认 8）。没有新材料时不调用模型。
- 页面里 `## 本人补充` 一节归本人：`write_page` 由 Agent 写入时恢复成原文（`keepOwnerSection`）。要追踪的内部对象的查法写成数据目录的技能。
- “最近打开的文档”：`captureRecentDocs` 记下新进入最近打开第一页的文档（kv `lark_doc_opened:<url>`）。
- 注入集中在 `owner-now.ts` 的 `ownerContextParts`：主助手本人的对话轮次（新会话背景；近况页改过后的第一轮再带一次；群里带有人物卡的人）、巡检、有人找你的分诊材料（“发送人”带人物卡那句话）和处理任务、会后说明。设置 `workState.inject` 关掉。
- 角色说明：`_common.md` 新增“本人近况与人物卡”（只给有 `recall` 的运行，访客没有），`assistant.md` 写清处理不了的事查人物卡、向本人提出拉谁进来（照旧经 `lark_invite` 和本人批准）。
- 设置 → 定时任务 里这一项下可改天数、每晚人物卡上限和是否注入。

## 2026-11-11：多 Agent 工作的过程消息收敛、思考气泡三档、交办时借工具

起因：在飞书话题里交给另一个档案做的一件事走了 5 轮，每轮有协调回复、唤醒轮和几个思考气泡，话题里十几条中间消息本人并不需要；那个档案没有读写表格的工具，每轮都回头找主助手代做。

- 新设置 `agents.progress`（设置 → AI → 过程消息）。`messages`：`milestones`（默认）/ `all`。`thinking`：`all` / `own`（默认）/ `off`。
- “只是接着推进”的判定（`agent-work.ts` 的 `onlyMovedOn`）：这一轮排出了下一轮（`queueAgentRound` 记 `queuedBy`，`run_agent` / `continue_agent_work` 都带）、这一轮没有 `asks`（提问或审批）、回答的消息里没有本人自己的话、工作不在等本人。满足时 `deliverCoordination` 只把回复存进工作会话（`meta.progressOnly`），不发；工作会话里的唤醒回合同样处理（`jobs.ts`）。协调出错、到自动推进上限、没再交办（做完）都照常发。
- 进度卡：`src/channels/lark-work-progress.ts`（`watchWorkProgress` 由主机器人注册），按运行状态变化 0.5 秒、步骤 8 秒合并更新；卡片写第几轮、谁在做什么、最近一个工具或状态、运行记录链接，消息 id 和内容指纹存在发起 ask 运行的 `output.workProgress`，内容不变不更新；话题开出来之前不发；`all` 模式不发。
- 思考气泡：`lark-agent-cot.ts` 的 `showThinking` 统一判断，两处起气泡的地方都问它：`lark-bot.ts` 回答消息时（本人自己发的、不是访客或机器人的消息才算 `own`），`startReplyProgress` 多 `bubble` 参数，关掉时只加“处理中”表情，不起气泡、不发兜底卡片；后台运行（交办的轮次、请教、协调、编码交办结果、规则）只有回答本人自己消息的 ask 轮在 `own` 下显示。
- 借工具：`run_agent` / `continue_agent_work` 多 `extra_tools`（最多 12 件）。`tools.ts` 的 `lendTools`：必须是发起这次交办的运行令牌里有的工具（被禁用的、本人没权限的本来就不在里面）；`LEND_DENIED` 不借以本人身份写飞书（`lark_write`、`lark_invite`、`lark_doc_create/update/move/copy/authorize`）、发消息（`lark_send` 等 lark-msg 里发送的）、再交办（`run_agent`、`continue_agent_work`、`ask_agent`、`delegate_code`、`review_branch`、`continue_code_run`）、`stay_quiet`、`report_rule_failure` 和 `ROLE_TOOLS`；从别的设备或规则运行里交办不能借。借出的记在这一轮的 `input.extraTools`，`runAgentTask` 去掉这次运行被禁用的再交给 `addTools`，任务末尾写明借到了什么；`prepareRun` 照常按本人权限裁剪，空间范围不变。
- `roles/assistant.md`、协调说明（`sessions.ts` 的 `coordinationNote`）：交办前看对方档案的工具，缺的自己做或借；只是接着交办的那一轮回复写一两句记录。设置页加“过程消息”一节（两个 `UiSegmented`）。
- 测试：`test/agent-work-progress.test.ts`、`test/agent-work-lend.test.ts`，`test/agent-work.test.ts` 多一条默认设置下的循环。验收 17a–17d。

## 2026-11-11：会话与运行互相知道（docs/v2/awareness.md）

起因：同一个群里两路同时处理同一件事各回一遍；后台在查的事本人中途插手了，后台照发过时的结论；一件事在几个会话里进行，各会话只看眼前。改法：

- 运行的范围键：表 `run_scope`（迁移），`src/agents/run-scope.ts` 的 `recordRunStart` 在 `runs.ts` 认领运行后从输入得出（会话、飞书群和话题、触发消息、事项），事项工具（`read_item`、`upsert_item`、`settle_items`、`propose_item_update`、带 `entity_id` 的 `notify`）运行中补上。`relatedNote` 生成“同时在办的相关工作”（进行中或 30 分钟内结束，最多 6 条），`runner.ts` 的 `runRole` 和 `sessions.ts` 的 `threadTurn` 接在任务后面（`awareness.ts` 的 `awarenessNote`）。
- 发出前复核：`awareness.ts` 的 `preSendCheck`（`tools.ts` 的 `runTool` 里，`notify`、`lark_send`、`lark_card`、`lark_send_file`、`reply_to_asker`）和 `recheckAnswer`（`jobs.ts` 的 `ask` 处理和 `runAgentTask`，最终回答）；只对 `mayStayQuiet` 的后台运行，每次运行一次（`output.awareness.recheckedAt`）。`ownerMoves` 收集运行排队后本人在范围里说的话。通知闸门的已读、表情、之后回复并进同一个检查；`lark-bot.ts` 推送时对复核过的运行不再拦（`checkedBeforeSend`），夜间攒下的照旧检查。
- 运行中送达：`ownerNews` 接在 `tools.ts` 的 `steering` 后面，后台运行下一次工具调用的结果末尾附“本人刚说了”，每条一次。
- 一件事跨会话：`src/items/places.ts`。会话和群聊是事项材料；`upsert_item` 写事项时自动关联运行所在的会话或群（`linkRunPlaces`）；“这件事还在这些会话里进行”（`itemPlacesNote`）；候选事项（`placeCandidates`，引用、链接或单号、人、共同的词、时间）；`read_item` 多返回 `places`、`runs`；`GET /api/items/:id` 多返回 `places`、`runs`（只给事项的主人）；事项页“在这些会话里进行”（`ItemPlaces.vue`）。
- 接手：新工具 `take_over_run`（分组 `delegate`），停下同一个人的后台运行并返回它最后的文字、工作文件、碰过的事项和已发出的消息。
- `roles/_common.md` 新增“同时在办的工作”；`skills/omem/references/items.md`、`agents.md` 同步；测试 `test/awareness.test.ts`（假 Agent 新增 `FAKE_MODE=aware`）。

## 2026-11-11：经豆包以本人身份发私聊

起因：有的企业禁用了 lark-cli 以本人身份发私聊消息的权限，“有人找你”的私聊回复（`p2pVia = signed`）和 `/ai` 都发不出去；豆包 OpenAPI 的云端会话以本人身份运行，能发飞书私聊。

- 设置：`mentions.reply.lark.signedVia` 和 `lark.commands.signedVia`，`lark-cli`（默认）或 `doubao`。设置 → 渠道 → 有人找你（私聊“以你的身份回”下面）和 私聊指令 各有一个选项；选了豆包时显示能不能用（`GET /api/lark/doubao-send`，没授权、缺权限、授权过期写原因）和“给自己发一条测试私聊”（`POST /api/lark/doubao-send/test`，只有本人）。命令行 `omem doubao send-test`。
- 发送：`src/channels/doubao-send.ts` 的 `sendViaDoubao`。每条消息建一个新豆包会话（`runBackend` 的豆包后端，临时档案 `doubao-send` 只带 `DOUBAO_APP_ID`），提示里只有定稿全文（含署名）和收件人（`recipientOf`：`lark_people` 里的姓名、邮箱、user_id，私聊 chat_id，lark-cli 下的 open_id），要求原样发、只回一行 `OMEM_SEND_RESULT: OK` 或 `FAILED <原因>`（`parseDoubaoReport`，同时有 OK 和 FAILED 算失败）。会话用完删，删不掉进 `session_cleanup` 重试。
- 核对：lark-cli 只读那个私聊（不知道 chat_id 时读本人这段时间发出的单聊消息），去掉空白和 Markdown 标记后比对。结果 `verified` / `unverified`（豆包说发了、私聊读不了）/ `mismatch` / `failed`；后两种不算成功，单独通知本人（原因加全文）。会话建起来以后这次处理就记为已回复，不再发第二次。
- 草稿点发送后卡片立刻变成“正在经豆包发送”（卡片回调等不了几十秒），结果另发提醒；自动档核对上时写在处理运行的提醒里。`Replied` 多可选的 `ok`、`problem`，处理运行的提醒在 `ok === false` 时写“回复对方没有成功”。审计 `lark.mention-reply` / `lark.command-reply`（新）/ `lark.doubao-send.test`（新），带结果、豆包的回报（截断）、会话 id 和应用。
- AGENTS.md 渠道一节写进了这条以本人身份写飞书的路径。提示原文和真机待验的点在 docs/v2/mentions.md “经豆包发送”。验收 19a–19e（文末一节）。

## 2026-11-11：首页“等你回答”不再撑出栏；过期的提问自己失效；网页通知以飞书为准

起因：首页左栏的待回答卡片里有很长的链接、宽表格和不换行的代码块时，卡片撑出左栏、盖住右边的“后台运行”“最近保存”；“需要你回答”越积越多，其中不少本人已经在飞书上接着说了别的，或者那件事已经结束；通知都推到飞书了，网页上的未读数仍然越积越多。

- 首页样式：`Home.vue` 的两栏（`.col`、`.block .stack`）用 `minmax(0, 1fr)` 和 `min-width: 0`，内容再宽也不撑开栏；`AskCard` 本身限宽 `min(760px, 100%)`、长文字换行，表格和代码块在卡片里横向滚动，表格单元格不再一字一行地断数字。同一个组件也用在问答页、`#/ui/:id` 和插件会话里，一起修好。1440 和 390 宽度都没有横向溢出。
- 提问失效（`src/agents/ask-expiry.ts`）：
  - 本人在同一个会话里接着说话（`answerFromMessage` 之后）：那里更早的、提问那一轮已经结束、也没有 `wait_answer` 在等的问题失效；还在等的由那一轮的 Agent 自己决定，新工具 `withdraw_ask` 撤回自己的问题（`roles/_common.md` 加了一句：本人改了主意或给了别的指示，先撤回还开着的问题）。
  - 交办确认（不是部分应用）或丢弃时（`applyCodeRun`、`discardCodeRun`），它各轮和各轮评审还开着的提问失效；事项关闭时（`upsertItem` 变成 done / cancelled / expired），为它做的运行还开着的提问失效（还有别的未关闭事项要它的除外），这个事项的通知记为已读。
  - 放了 `asks.staleDays` 天（默认 7，0 表示不限）没人回答的失效。宿主自己的决定卡片（评审计划、规则启用等）在它的工作还在进行时不按天数失效（取消了也会再问一次），只跟着工作结束；命令审批和交办修改项的卡片各有自己的收尾（`command-gate.ts`、`code-loop.ts` 的 `reconcileWaiting`），这里不动。
  - `sweepStaleAsks` 把上面这些规则用在库里已有的数据上：每次启动（升级后第一次启动就清掉积下的）和每次巡检各跑一次。
  - 失效的提问记下原因（`context.lapsed`），飞书卡片更新成“需要你回答 · 已失效”和原因，没有按钮，交互记录关闭，再点提示已经处理过；`wait_answer` 返回“已失效：原因”。飞书卡片上点“拒绝”或选项本来就是回答，网页同步不再列出，没有改。
- 网页通知（`core/notify.ts`、`channels/notify-read.ts`）：
  - 推送记在通知上（`pushed`：渠道、时间、飞书消息 id）：通知卡片、事项卡片、每日汇总、夜里攒下的一次补发都记；按免提醒规则或本人已经处理而没有推的记 `quiet`（后一种同时记为已读）。
  - 网页的未读数和小红点只算没推到任何渠道的（`countsAsUnread`：没读、没推、没被有意不推、不是只在应用内的 `silent`）；通知页仍列全部，推过的标“已发到飞书”，没推的标“没有推送”。网页收到新通知后过几秒再取未读数，不再直接加一。
  - 变成已读：本人引用回复了通知卡片（`inbox.ts`）、点了通知卡片上的按钮（`lark-actions.ts`）、事项关闭；巡检时 `syncNotificationReads` 查最近 7 天推过还没读的：卡片上有本人的表情、有引用它的回复，或 lark-cli 的已读状态（一次最多 50 条，一批一次调用）说读过。
  - 升级后第一次启动 `backfillPushed` 把以前推过的（记过卡片 id 的、有事项或汇总卡片交互记录的）补记为已推送，只跑一次（`kv.notify_pushed_backfill`）。
- 没有在真机上验证：lark-cli 的 `+messages-read-status` 能否读到机器人发给本人的卡片的已读状态（读不到时不改，靠表情、回复和事项关闭）。

## 2026-11-11：口语练习并入英语练习；`omem peer open` 下插件页面加载失败

起因：设置 → AI → 语音加进来时，网页多了一个单独的“口语”页（`Speaking.vue`、导航项、`/speaking`），评价由宿主的 `speaking-coach` 角色写，按钮是浏览器原生样式，和英语练习是两套东西。另外在一台电脑上 `omem peer open` 打开经中间设备转发的设备网页时，英语练习页控制台报 `blocked by CORS policy`，页面空白。

- 宿主给插件页面的语音会话：清单 `voice: true`；`GET /api/plugins/:id/voice`、`POST …/voice/realtime/secret`、`POST …/voice/live/sdp` 带插件的 `instructions`（最多 6000 字），不带 omem 工具，也不进 `voice_sessions`（`core/voice.ts` 的 `VoiceSpec`）。外壳 `Plugin.vue` 收到页面的 `voice-start` 后用 `lib/voice.ts` 拿麦克风、建 WebRTC，只把转写和结束时的记录转给页面；要求页面里刚有点击（`navigator.userActivation`），进行中顶上显示“正在使用麦克风”和“结束”，不替页面转发 `voice/…`（临时凭证不进沙箱）。SDK 加 `omem.voice()` / `voiceStatus()`。
- 英语插件：内容块 `speaking`（场景、想练的说法），页面工具 `english_speaking_start`、`english_speaking_brief`（按口语等级、薄弱短语、口音写给语音模型的说明），提交时存 `speaking` 记录并把对话记录交给陪练；陪练按插件技能 `english-speaking`（由原 `speaking-assessment` 改写）用 `english_speaking_grade` 交等级、四项分、评价和知识点，进同一份画像（`PROFILE_SKILLS` 多了 speaking，`snapshot.speaking`）。页面“新练习”里“做题 / 口语对话”并列，口语卡片 `SpeakingCard.vue` 用 omem 的样式；没配语音模型时说明去哪里配。
- 删掉：`web/src/views/Speaking.vue`、导航项和 `/speaking` 路由、`roles/speaking-coach.md`（`roleNames` 同步）、`speaking-review` 的评价逻辑（旧的排队运行直接结束）、`voice_sessions` 的练习写入（表保留，旧的 `practice` 行不再列出）。已经播种到数据目录的 `speaking-assessment` 技能不会被删，不再有角色用它。
- CORS：问题在第一跳，`omem peer open` 的本机代理。沙箱 iframe 以 `Origin: null` 按 CORS 方式取 module script 和样式表，本机代理的本机信任检查（`trustedLocal` → `sameOrigin`，10-30 起）把 `Origin: null` 当作别的网站，直接回 403，没有跨域头，浏览器就报 CORS。直接访问目标设备时不经过这层所以正常。现在本机代理对 `Origin: null` 只放行插件页面的文件（`pluginPageFile`：`/plugins/<id>/…`、`/plugins/_sdk/…`，只允许普通路径字符、不含点段和 `%`，免得 `..` 在转发时被解析成别的路径），并在响应上自己补 `access-control-allow-origin: *`，所以中间设备是 11-07（d25fbf62）之前的版本、转发时丢掉这个头也没关系；只需要更新运行 `omem peer open` 的那台电脑。插件页面的流（`/api/plugins/<id>/streams/…`）加进本机代理的原始隧道（`PLUGIN_STREAM`），中间设备 11-07（6050f807）起原样转发本人的升级请求。`test/peer-plugin-page.test.ts`：三台 omem 两级转发，以及一个丢掉跨域头的旧中间设备。

## 2026-11-12：原件页的仓库目录、筛选和滚动加载

起因：业务空间挂了十几个仓库、一万多份原件时，原件页顶部一排仓库按钮换了七八行，关注程度和类型两排一样的按钮挨在一起，筛选区占了半屏；目录树滚到底会闪、反复加载。

- 滚到底反复加载：目录树（非仓库空间）和仓库路径树自己取数据，但列表栏的滚动监听仍按平铺列表的分页判断：平铺列表是空的，总数却是目录树报上来的整个空间的份数，于是每次接近底部都去取 `/api/sources` 的下一页（这一页根本不显示），底部的“加载中…”一出一没又改变了高度和滚动位置，接着再触发。现在只有平铺列表（没选空间）分页，判断抽成 `web/src/lib/sources.ts` 的 `shouldLoadMore`（某页返回空就停，即使总数说还有）；底部那一行在还有下一页时一直占位，只换文字。
- 仓库进目录树（`SourceTree.vue`）：业务空间名下的仓库作为顶层目录，展开是从仓库空间加载的路径树（节点 key 加 `@<仓库>@` 前缀，设关注程度时按仓库空间写）；6 个以上收进一个“仓库”目录。份数并进标题旁的总数。仓库行的菜单显示本地路径和“单独打开”。顶部的仓库按钮去掉，仓库空间里留“属于 业务空间”的返回链接。
- 筛选：关键词 + 类型下拉一行，关注程度下拉（选项带份数）+“待复核”一行；“待复核”打开后变成“回到目录”。标题行的整理、知识库在列表栏里是图标按钮，手机上显示文字；手机上没选原件时列表占满屏。
- 验证：`test/sources-web.test.ts`；本地演示数据（5000 份、15 个仓库）在 1440 / 1060 / 390 宽度截图，没有横向溢出。验收 25a–25g。

## 2026-11-12：代码索引有了基线，分支和交办的索引按需用、自动过期

起因：本人问代码问题，助手拿之前某次交办分支上的代码回答。两条路都会这样：仓库的索引就是 `rootPath` 目录检出的样子（目录停在功能分支或交办检出的分支上时，那就是“仓库的代码”）；`space: "*"` 或不限空间的检索把所有交办工作区（`wt-…`）和分支索引（`br-…`）都带上，而且这时分支版本不替代仓库同名文件，各个版本并排出现。另外 `repo-sync` 默认关、从没跑过；交办续轮的 `wt-<轮>-<仓库>` 只删了第一轮或被应用那一轮的；按提交 sha 建的分支索引永远解析得到、永远不删。

- 基线（`src/sources/code-baseline.ts`）：仓库空间的 `settings.codeIndex`（`mode` baseline / directory、`ref`、`branches`）。按基线时用 `git ls-tree` + `cat-file --batch` 从提交里读，按 blob id（`meta.blob`）只重读变了的文件，基线提交没变就什么都不读；子目录空间路径相对子目录，已检出的子模块按记录的提交读。状态写 `settings.codeIndexState`（ref、提交、提交时间、索引时间、拉取时间、错误、跟的分支的错误），网页保存空间设置时不覆盖它。原件仍按“空间 + 路径”定 id，切换和更新后 `src:` 不变。已有空间不自动切换（按目录，也记下当时检出的分支和有没有未提交改动），新接入、有 origin 的仓库第一次同步就按基线。
- 定期更新（`src/sources/code-index.ts`）：`repo-sync` 改成 `repoSyncTick`，默认开，从没运行过的库启动时打开一次（kv `repo_sync_default_on`）。按 Git 仓库（common dir）分组，每组一次 fetch（只拉基线和跟的分支），按目录的空间看 `HEAD` + `git status` 指纹，变了才排 `sync` 运行；然后刷新跟的分支和最近用过的分支索引、清理过期索引。
- 叠加索引：`search.ts` 的 `withOverlays` / `overlays` 选项，不列空间的检索排除所有叠加索引（全文、符号、向量），列了空间时只加允许的；`tools.ts` 的 `search`、`find_symbol`、`scan` 跟着改，运行属于某次交办或分支评审时自动带上那次的工作区索引（`worktree-index.ts` 的 `runOverlaySpaces`）。`worktreeSpacesOf` 按整次交办找所有轮次。`indexBranch` 记 `usedAt`、`committedAt`，相对仓库的基线比较，子目录仓库用 `--relative`。
- 过期（`expireOverlays`）：交办应用、确认、丢弃、被接替时删每一轮的工作区索引，14 天没动静也删；sha 分支索引 3 天、没登记跟的分支索引 14 天没用就删；`repo-sync` 每小时和启动时清理。
- 版本说明：`search` 头部、`find_symbol` 末尾、`read_source` 头部写“代码来自”（`codeVersion`）；`roles/_common.md` 加一条：回答代码问题说明依据的分支，问分支或交办的事带 `branch`。
- 接口（`src/sources/code-index-http.ts`）：`GET/PUT /api/spaces/:id/code-index`、`POST /api/spaces/:id/code-index/refresh`、`GET/POST/DELETE /api/code-index/hook`（变更通知令牌，存 kv `code_hook_token` 的哈希）、`POST /api/code-index/notify`（独立令牌或本人凭据；按 git remote 或空间匹配，后台拉取刷新）。网页仓库设置的“代码索引”（`web/src/components/CodeIndexPanel.vue`），业务空间的仓库列表显示索引到哪个提交。设计 `docs/v2/code-index.md`。

## 2026-11-12：材料从个人空间归位

起因：个人空间堆了大量业务文档和工作记录（一台实际使用的机器上三千多份文档、一百多份工作文件，业务页面引用个人空间原件七十多处）。archivist 只看正文、一判定终身、“不确定就留个人”；主助手在个人空间里为业务事项写的工作文件留在个人空间；协作者打不开业务页面引用的个人空间原件。设计在 docs/v2/archive-routing.md。

- 旁证（`src/sources/homing.ts` 的 `archiveEvidence`）：知识库位置和本人归入的空间、同目录文档的去向、引用它的其他空间的页面 / 事项 / 记忆（含合并前旧 id）、贴过它的群和群的空间、手动定的关注程度、工作文件的事项或规则。`archive` 运行把它和重判原因（`again`）一起交给 archivist。`roles/archivist.md` 改为：旁证指向同一业务空间就归过去，矛盾或只有弱旁证时留下记“判断不了”，日常个人内容记“确实个人”。
- `classify_source` 加 `verdict`、`candidates`；`source_routes.verdict` / `suggested`，`source_moves.mode` / `detail`（迁移）。`archive.autoMove`（默认开）关掉时 AI 的判断只记成建议。
- 重判：`archive_evidence` 记判断时的旁证指纹，`archive_recheck` 是队列；`collectRecheck` 找新旁证、空间或归档规则变化（第一次只记状态）；每晚 `archive-sweep`（01:40，`archive.nightly` 默认 60）按优先级交出，规则能定的直接移，没有待判的不跑。理由“有新旁证，重新判断”的原件不跟随同一会话的旧判断（`archive.ts` 的 `REJUDGE`）。
- 工作文件：`write_file` 在本人个人空间里、运行范围只指向一个业务空间时写到那里（`matterSpace`，同路径旧版本一起移），挂在业务事项或规则上的旧工作文件每晚跟过去（`followWorkFiles`）。
- 网页：归档规则页左侧“从个人空间归位”（`ArchiveHoming.vue`）：自动移走的及依据、移回并记住、等你定的批量指定、读者打不开的引用、两个设置。接口 `GET /api/archive/homing`、`POST /api/archive/homing/{return,assign,sweep}`、`GET /api/spaces/:id/citation-reach`、`POST /api/spaces/:id/citation-reach/recheck`。
- 引用可达性（`src/sources/reach.ts`）：按空间读者和 `sourceVisible` 判断，不写死个人空间；只有本人能读的空间不报。
- 群里再贴一次已移走文档的链接时，一天内读过的不再重读（`importLinkedDocs` 认 `source_locations`）。
- 测试：`test/homing.test.ts`、`test/homing-agent.test.ts`（`FAKE_MODE=archive`）。验收 26a–26l。

## Wiki 生成时的检查与核对（2026-11-11）

起因：一次对夜间自动生成页面的审核，发现首页丢了目录入口、同一主题在几个相关空间各写一遍且不一致、流程步骤和代码不符、规划了的页面没写也没提示、“未取得”其实原件里有、业务页引用个人空间和临时分支的原件、代码空间索引过期只能写纯文本、页面过长和过程性语言。本人没时间逐页核对。设计在 docs/v2/wiki-verify.md。

- 宿主检查（`src/wiki/checks.ts`，`write_page` 调用）：首页和目录页改写丢了仍然存在的页面入口时退回，同一运行再缺补在页尾；引用不存在、已删除、行号超出退回；共享空间页面引用个人空间、交办分支索引、部分读者无权限空间的原件退回，并给出本空间或相关业务空间里的同一份；能唯一对上索引的 `路径:行号` 和 `` `符号` `` 写成纯文本时退回并给出 `src:` 写法；超过 12000 字退回。新页面和相关空间页面标题相近时提示链接。
- 代码索引：规划和每页写作前，相关代码空间的索引落后于仓库 HEAD 就先同步（`refreshCodeIndexes`）。
- 规划：任务里列出相关空间已有的页面；`submit_plan` 新增 `overlap`（本空间另写的理由）和 `reuse`（链接过去的主题），同名主题两样都没有时退回。
- 核对（`src/wiki/verify.ts`、新角色 `wiki-checker`、工具 `submit_page_check`）：写作运行里计划的那一页先存草稿（`read_page` 读到草稿），核对角色用自己的 AI（`runRole` 的 `ownAI`）逐条核对并交结构化结论，写作者改或反驳，最多 3 轮后发布；核对记录存 kv，`GET /api/wiki/:space/page/*` 的 `checks`，网页右栏“核对”（`WikiChecks.vue`）。空间设置 `wikiVerify: false` 关闭。
- 生成对账：规划的各页和 `generate_wiki` 的 `pages` 记成一次生成（kv `wiki-gen:<id>`），每个写作运行结束时 `settleWikiRun` 判断；没写成的重试一次，都结束后发一条通知（有未解决时普通通知，否则 silent），规划运行的输出带 `report`。
- 角色说明与技能：`wiki-planner`（相关空间同主题、保留首页入口、调查入口写到代码）、`wiki-writer`（按代码数步骤、写“没有”前先找、引用只用业务空间、代码写成引用、6000 字以上拆、核对意见怎么处理）、`wiki-linter`（同样的写入规则）、技能 `wiki-writing`（事实上最常出错的几处、自查项）。
- 测试：`test/wiki-checks.test.ts`、`test/wiki-verify.test.ts`；假 Agent 的 wiki 模式加了核对角色（`FAKE_WIKI_CHECK_FILE`：pass / once / always）和按核对改写。

## Wiki 写法：过程性与防御性语言、拿不准的问本人、只放知识、图表（2026-11-12）

本人看了一批自动生成的页面后提的四件事，设计补在 docs/v2/wiki-verify.md 的第 9–12 类。

- 过程性和防御性语言：核对角色新增 `wording` / `hedge` 两类，逐句给出改后的句子；技能 wiki-writing 加了“整理过程、防御性的话：改写对照”表和自查项，要点取自开发用的表达检查技能里对知识页面适用的几条（整理过程、写给审稿人的话、退路、先立误解再推翻、冒号前的提示语、起手式），不改小标题编号、“这意味着”、句子长短。宿主不堆正则。
- 拿不准的不写进页面：`write_page` 加 `questions`（写作运行的草稿上，跨版本保留），核对角色的 `unsure` 带 `question`；页面里不留“待确认/还没查清”小节（技能、写作、distiller、`_common.md` 的案例页结构同步去掉）。一次生成结束把问题合成一张表单（`handler: wiki-questions`，不单独通知，链接在那条通知里），本人填了的按页面排一次 `generate_wiki` 的 `pages` 补进去。
- Wiki 只放知识：规划、写作、技能写清知识和流水记录的区别，核对角色新增 `log`；超过 6000 字的页面每轮由宿主自己记一条 length，发布前一定退回去拆。
- 图表：`write_page` 用 mermaid 自己的解析器在 Node 里检查语法（DOMPurify 补上不做事的方法），语法错的拒写并给出行号。网页上带箭头的流程图之前一张都没渲染：DOMPurify 删掉了值里含 `-->` 的 `data-mermaid` 属性，现在属性里放编码后的源码；`import("mermaid")` 失败不再缓存；画不出来的图显示原因、靠左的源码和“重试”；切页面时动态分块取不到（服务更新后）自动刷新一次，页面内后加载的部分取不到时提示刷新。
- 目标空间里同一地址的原件已经删除（只剩墓碑）时，移动仍被“已有同地址原件”拒绝：`moveSource` 和 `moveWorkFile` 现在让墓碑让位（清掉墓碑再移入），没删除的仍然拒绝。

## Wiki 未决问题：拿不准的点存在页面之外，先由 Agent 查，少量问本人（2026-11-12）

起因：真实使用的库上 784 页里 711 页带“还没查清”一类的小节或过程性、防御性语言，大多是旧模板要求的页尾一节。设计在 docs/v2/wiki-verify.md 第 5、6 节。

- 新表 `wiki_questions`（迁移加表，登记进 `pull-data.ts`）：按空间和页面存问题、为什么拿不准、引用、来源、状态、重要度、回答。`src/wiki/questions.ts`。页面移动时跟着走。
- `write_page` 的 `questions` 可以带 why 和 refs，不论是否在写作运行里都记进表；核对的 unsure 也进表。新工具 `settle_wiki_question`（wiki 分组，写作角色）。
- 处理顺序：写作运行先查这页挂着的问题；一次生成结束先排一次 `wiki-resolve`（最多 20 个）让 Agent 查，查不清的才问本人，一次最多 5 个（一张表单，其余留在清单）；回答后按页面写回，发布时关掉问题。
- 网页：页面右栏“未决问题”、目录上方入口和按页面分组的清单（回答、不用管、让助手先查、重新核对已有页面），只对有写 Wiki 权限的人显示；对应接口都要 `wiki.write`。
- 存量迁移 `src/wiki/migrate.ts`：升级后启动时排一次，按标题识别“还没查清”等一节，逐条拆成问题（保留引用），只删这一节、保留其余引用状态、Git 留历史；每批 200 页，可重入，进度记在 kv。正文中间的过程性语言不动，留给重新核对（`recheckPages`，一次 10 页、最多 50 页）。
- 约定和模板：wiki-writer、distiller、wiki-linter、`_common.md`、技能 wiki-writing 的“还没查清”都改成交 `questions`。
- 测试：`test/wiki-questions.test.ts`、`test/wiki-verify.test.ts`（假 Agent 的调查运行）。

## 2026-11-12：从个人空间归位不再占住服务

第一版的“现在检查”在一个真实大小的库上把服务卡死：`collectRecheck` 对几千个候选逐个算指纹，每个都对事项、记忆的 `source_refs` 做 `json_each` 全表展开、按 `json_extract(meta)` 扫整张 `sources`，全部在主线程同步执行；判断时每份原件还对 `lark_messages.content` 做 `like '%token%'`。

- 指纹按集合算：几条（分页）查询建出“原件 → 引用它的空间”“目录 → 已在的业务空间”“知识库 → 目标空间”，在内存里比对；一批原件的旁证一次算（`archiveEvidenceFor`）。
- 检查在后台跑，每 30 毫秒让出事件循环，同一时间一个，总时长上限 5 分钟，到了停下次接着；`POST /api/archive/homing/sweep` 立即返回，进度在 `kv.archive_sweep_progress`，网页显示进度和上次用时。
- 新表 `lark_doc_links`：采集消息时写入，已有消息由检查分批补（游标 `kv.lark_doc_links_backfill`）；“贴过它的群”只查这张表。
- 可达性检查按“读者 × 空间”算一次，分批让出；批量指定空间逐份让出。
- 迁移：表达式索引 `sources_wiki_parent`、`source_moves_source`、`source_routes_verdict`，表 `lark_doc_links`。
- 规模测试 `test/homing-scale.test.ts`（3000 份个人空间原件、12000 份其他、引用 20000、消息 60000）：一次检查从约 28 秒同步变成约 1 秒、主线程最长约 0.1 秒；一批 40 份的旁证从约 2 秒到约 0.06 秒。验收 26m–26o。
- 一对一私聊不再参与自动归位：真实使用里，放宽后的归属判断把十几个和同事、和机器人的私聊判成业务材料移进了业务空间，那个空间的成员就能读到。现在由宿主确定性地挡住（`archive.ts` 的 `isPrivateChat`：采集时不交给归属判断、不跟随同会话的旧判断，重判队列不收，`classify_source` 拒绝把它移到别的空间），只有本人手动、会话绑定或归档规则能移；`roles/archivist.md` 写明原因。

## 时间按本人时区显示（2026-11-12）

- 运行页“排队中：定时，… 开始”、唤醒列表、盯群到期、事项过期候选、编码交办里本人补充的时间等原来直接截 UTC 的 ISO 串，服务器在 UTC 时区时就显示成 UTC。现在统一用 `core/util.ts` 的 `localStamp(时间, config.timezone)`；交给模型转述的材料（会话列表、事项时间线、需求版本、复盘上下文、规则的讨论记录）也一样，规则讨论记录原来写死 +8，改为按配置时区。命令行输出按本机时区。
- 不变的：存进原件的聊天行时间（飞书、onebot 采集、会话日志）仍按 UTC 写，`notify-gate` 按 UTC 解析它们。
- 网页：原件归位“上次检查”、插件默认页的会话时间、运行页分支日期改用 `fmtTime`（浏览器时区）。
- Wiki 目录栏：空间名较长时顶部一行（名字 + 四个按钮）把目录栏撑宽、出现横向滚动条；现在名字缩成省略号，目录栏不横向滚动，右侧给滚动条留出位置；页面标题里很长的英文词会折行。

## 换 AI 后接着回、验证码等待、规则卡片、授权卡片、有人找你的条件（2026-11-12 晚）

- `switch_run_ai` 停下进行中的一轮另排新运行时，旧运行的 output 记 `replacedBy`；聊天渠道等这一轮回答的地方（`channels/common.ts`）跟到新运行，飞书收起旧气泡、给新运行开气泡。原来新运行做完没人发，飞书只看到“已终止”。
- 规则的“等某个会话的新消息”：飞书消息时间只到分钟，原来从触发的毫秒时刻起算，同一分钟里先到的验证码被滤掉。现在从触发那一分钟的开头再往前 1 分钟（`WAIT_LOOKBACK_MS`）起算，取符合条件的最新一条；等待时长仍从触发时刻算。
- 卡片点击：卡片没绑会话、但记着发它的 Agent 运行（规则的 Agent 在触发消息话题里发的卡片）时，同一个 Agent 带着原任务接着它的会话处理这次选择（`resumeAgentFromCard`），不再提示“找不到对应的会话”。
- 通知加 `tone`：`warning`（要本人去做的事，橙色）、`done`（办好了，绿色）；`notify` 工具可传，更新一张 warning 卡片时不传也按 done；宿主自己的飞书授权提醒用它，完成后改原卡片。
- 有人找你：`mentions.skipWhen.{read,reacted,replied}` 分别决定已读、回表情、回复算不算本人已处理（默认都算）。
- 问答页底部“等你回答”区的卡片不再被压缩（内容原来会溢出卡片框）。
- 豆包 CLI 只在整轮结束后输出回复，没有过程事件：运行期间宿主把它经 `omem tool` 调的每个 omem 工具同时记成过程步骤（`tool` 事件，`shellToolRuns`），思考气泡和运行页能看到它在调什么、成没成功；它自己的思考和本机 shell 命令仍看不到。给它的工具说明加了一句：说“没有工具”之前先 `omem tool help` 查（一次真实运行里它没调任何 omem 工具就说改规则的工具没开放）。
- 命令行后备的过程：`codex exec --json` 的思考摘要（reasoning）记成思考，命令、MCP 工具、改文件的结束状态（成功 / 失败）也记下；`claude -p` 的 `tool_result` 把对应工具标为完成或失败。原来两者都只有“开始”，工具一直显示进行中。
- 规则“分别回复”模式下的一波触发：已有同一规则的运行在排队时，新触发并进这个排队的运行（不并进正在跑的），它开始时一起处理，每条仍独立做完、分别回复，先处理最紧急的（`triggerNote` 的 separate 写法）。原来一条一个运行，报警连发时后面的要等前面的全部做完。
- 编码交办接上同一分支之前交办留下的修改项时，原来“在等本人”的那项由助手发起时先交给助手（`carryTasks` 的 `viaAssistant`），旧交办上那张卡片标为失效；拆修改项和交办任务的说明写明：挂回事项、写工作文件这类事归助手，不写成编码 Agent 的完成标准。
- 规则的“完全访问”不勾时跟随那个 Agent 自己的设置（原来不勾就一定在沙箱里，助手开了完全访问也不算）。
- `read_run` 加“过程”：每个工具步骤的结果、命令输出末尾（ACP `tool_call_update` 结束时留最后 3000 字）、omem 对权限请求的回答、运行结束时还没跑完的步骤。`_common.md` 写明权限请求由 omem 当场回答、没有要等的审批，醒来先看 `read_run` 的过程。
- 盯群预筛：配了决策模型时，盯群的每批消息先由它按盯群的目的（note）和群里的场景判断有没有助手能有效介入的事（不限于找本人的：替别人解答、查东西也算），不用看的不起完整运行，会话里留一条“预筛跳过”（`prefilterBatch`）；@ 本人或机器人的消息不筛，模型出错照常交给处理者。总开关 `lark.watchPrefilter`（默认开，设置 → 渠道 → 盯群），单个群用 `set_chat_watch` 的 `prefilter` 显式开关。
- 决策模型的材料：盯群预筛加上本人在这个盯群会话里说过的话、条件里点名这个群的规则（`rulesNaming`）、相关的记忆（含偏好和经验）、这一批之前的群聊和本人在这个群的习惯；“有人找你”的分诊加上点名这个会话的规则和 7 天内在这个会话里的处理结论。
- 访客提问的空间：开放给访客的业务空间（和群所在的业务空间）连同它下面的仓库一起可读，和成员权限一致；原来要把仓库单独加进去。
- 有人找你在群里回复对方时，正文里每个“@名字”都去群里核对成员，认得出的都换成真正的 @（原来只处理被回复的那个人，@ 第二个人时那个是纯文字）；对方本人只 @ 一次。

## 2026-11-13：远程浏览器占用与后台显示环境

- 长期资料也可勾选关闭占用它的浏览器；先结束同一人的旧远程会话，再把 `close_running` 交给 aad。浏览器启动失败时保留最初错误，只对没有安装的浏览器继续尝试。
- aad 配套修复：核对锁的主机、PID 和进程归属，关闭验证过的占用浏览器、清理确认已退出的本机进程锁；错误指出仍在运行但不匹配的 PID。本次浏览器启动失败和正常关闭也释放本次 PID 的残留锁。提前退出报告 stderr；Linux 窗口模式没有 DISPLAY 时在操作资料和关闭旧浏览器前拒绝。
- 后台服务显式保留启动终端的桌面环境与 `OMEM_TOOL_*` 程序；远程页提示无桌面环境并禁用显示窗口，无窗口浏览器仍可用。
- 验证：`LANGUAGE=C pnpm run check` 通过（230 个文件、1359 项测试）；最后的 PID 展示和服务环境改动另跑对应专项、类型检查与构建。真实 Edge 占用独立资料时核对旧 PID 退出，新浏览器可打开；同一资料关闭后立即重开、已退出 PID 的锁恢复、无 DISPLAY 时保留原占用浏览器均通过。网页在 1440 / 390 宽度可勾选关闭，无桌面时窗口模式禁用，无横向溢出。aad 的 CDP / CLI 测试与 Clippy 通过；MCP 原有的 `an_agent_can_keep_what_it_worked_out` 因 `secret_input must be savable` 失败，其他 MCP 回归通过。

- 机器人发到会话里的 Markdown 统一在 `sendLark` 里把“@名字”换成真 @（`setMentionResolver` → `lark-people.ts` 的 `realMentions`：先认这次对话里已知的人，再核对群成员；名字后面紧跟着字时按前缀核对；代码和邮箱里的 @ 不动；同一个人只 @ 一次）。原来机器人回答、话题后续、规则 Agent 回答、有人找你的回复各自处理，覆盖的人不同，常留下纯文字 @。
- 卡片也一样：新发的卡片和更新卡片（进度卡片收尾时写进回答）里每段 Markdown 的“@名字”都换成真 @；同一会话里核对过的名字缓存 10 分钟。

## 2026-11-13：一件事一条消息

- 有人找你的“草稿”档：`reply_to_asker` 只把草稿记在运行上（`mentionReply.pending`），处理结束时随提醒一起发（`notify` 的 `replyDraft`，飞书在同一张卡片里放提醒和可编辑的回复，`draftMentionReply` 带 `head`，点了之后提醒正文保留）；处理 `stay_quiet` 时草稿作废（`mentionReply.dropped`）；处理自己 `notify` 过时草稿单独一张卡片。原来草稿卡片一拟好就发，之后再来一条提醒，处理决定不提醒时草稿卡片也已经发出去了。夜里攒下的通知超过 3 条合成一张列表时，带草稿的仍单独发。
- `ask_user` 之后的回答：飞书上这一轮的回答紧跟在它自己还没回答的提问卡片后面、在同一个群，回答只是指向卡片（30 字以内）或四字片段有四成以上在问题里出现时，不另发，并进卡片里折起来的“这一轮的说明”（`foldIntoAsk`，卡片按钮仍绑在原来的交互上）。`ask_user` 的工具结果和 `_common.md` 也写明问完不要再写一遍。
- 编码交办停下后交给助手的那一轮：宿主已经发给本人的卡片和通知（`hostToldOwner`：这一轮的宿主提问、交办的通知）列进任务，汇报只写卡片上没有的，有这些卡片时可以 `stay_quiet`；同一会话里一个提到这一轮或这次交办运行 id 的唤醒在这一轮结束后汇报过，就不再起交给助手的那一轮（`reportedSince`）。
- 唤醒说明（`WAKE_NOTE`）：只有要本人做或决定的事、或者事情有了结果才写给本人，别人还在跟、排了下次复查这类进展记进事项后安静结束。

## 2026-11-14：远程页

- 去掉录制卡片上的“回放”和 `POST /api/remote/recordings/:id/replay`（本人不用）；录制转出的 `workflow.yaml` 仍随技能保存。
- 地址栏换页：aad 只对完整的页面快照放行输入，omem 只取 20 个节点，真实页面都被截断，`control_act navigate` 报 “truncated observation cannot authorize input”（回放先回起始页也卡在这里）。快照被截断时改用浏览器调试端口的 `Page.navigate`，等 `Page.loadEventFired`（`devtoolsNavigate`）。
- aad 的查看页连接断开后只显示“已断开”，不重连：远程页（同源）盯查看页的状态行，断开时按 1、2、4…秒（最长 30 秒，最多 8 次）重新 `view` 并重新加载查看页，会话已结束就去掉标签；地址栏旁（桌面会话在画面上方）加“刷新画面”。
- 过程气泡（`RunActivity`）：命令很长时“进行中 · N 步”和转圈被挤成一字一行；标签不换行、不收缩，只让命令那段截断。
- 录制整理成技能：请求按形态分出噪音（`src/remote/requests.ts`：资源类型、事件批次请求体、监控样子的路径和主机、不变的反复 GET），剩下的按“方法 + 主机 + 路径”合并、写操作在前；`read_recording` 概要列“调用的接口”，`part=requests` 默认不列噪音（`noise=true` 全列），steps 里也不列噪音请求。技能只带 `recording/requests.md`（`save_skill` 的 `recording_requests` 挑接口，不填时是去噪后的全部），不再带 `workflow.yaml` 和 aad 的完整操作说明。原来 `requests.md` 是录制的前 100 个原始请求：常驻服务器上一次 1152 个请求的录制，前 100 个里 63 个埋点、14 个扫码轮询、4 个预检，真正配置接口的请求一个都没进去。`skill-from-recording` 写明录制不是剧本，先从试错里找出真正完成这件事的步骤和接口。
- Windows 上找 aad：PATH 上只有 osdk 的 `aad.cmd` 垫片时，原来照样返回 `aad`，不经 shell 起进程报 ENOENT，而且这个错误没人接，整个 omem 退出。现在 Windows 上先找 PATH 上的 `aad.exe`，没有就用 osdk 安装目录里的（`exeOnPath`）；aad 起不来时请求返回“aad 没能启动”，`aad mcp` 已退出时后续请求立刻失败，不再等 30 秒超时。

## 2026-11-14：展示组件的版式、引用原件的排版

- 展示组件（`src/agents/ui-blocks.ts`）：新 `callout`（tone、title、text）；`metric` 加分组 `title` / `note`，每项加 `trend`、`good`、`note`、`spark`（`metricTrend` / `metricTone` 按 change 开头的符号判断方向、按 good 定好坏）；`chart` 加 `area`、`hbar`、`stack`、`goal`，饼图最多 8 块、不能有负数。
- 飞书卡片（`src/channels/lark-ui.ts`）：指标画成等宽分栏里的灰底块，结论是浅灰底的 `interactive_container`，只有图标库图标按语气着色，方案对比是并排的列；表格有表头样式、数字格式、宽表冻结首列；图表显式写 8 个系列色、细柱圆角、平滑折线、`markLine` 目标线，饼图把占比写进名字；卡片头只有结论是需要关注或故障时才是橙、红色，`config.summary` 写标题加结论（`buildCard` 的 `summary`）。
- 网页（`packages/plugin-sdk/blocks.ts`）：图表重画——整数刻度、一个轴一种写法、平滑折线和淡色面积、柱状整格高亮、横向条形、圆环饼图带合计、目标线、悬停提示列出所有系列、方向键逐个看；指标卡按个数排成整齐的几行，变化只给文字着色，带走势小折线；结论块是浅灰底、只有图标着色。系列色换成一套 8 个颜色（靛蓝、青、珊瑚红、琥珀……，从六套候选里选定），浅色、深色各一套、色相一致，按 omem 的面板做过色觉区分和对比度校验。`UiView.vue` 把组件里的 Markdown 交给 omem 自己的 Markdown 组件画。
- Agent 说明：`roles/_common.md` 和 `skills/omem/references/owner.md` 写了报告的顺序（先结论、再指标、再图表和明细）和图表类型怎么选；`show` 工具的说明同步。
- 原件页：带引用行号打开的文档（飞书文档、Markdown）不再退回原文行号，按排版显示并把引用的段落标出来、滚到中间；引用落在飞书的提示块或分栏里时整块标出，两边不留半个容器（`web/src/lib/cited-document.ts`，引用抽屉同样受益）。

## 2026-11-14：学本人怎么回、知识库的文档归位、表格与提示块、触发人、设置页

- 有人找你（`src/mentions/reply-learn.ts`，表 `reply_samples`）：每条进到这个流程的消息记一个样本——对方问了什么、助手拟了什么、本人怎么处置（照发 / 改后发 / 没发和原因）、本人之后自己在那个会话里回了什么或没回（`MentionChannel.ownerSaid`，飞书按 `lark_messages` 里本人的消息，24 小时内，带 `/ai` 署名的不算）。分诊材料多一行“本人以往回不回”（`habitLine`），处理运行的任务多一节“本人以往怎么回”（`replyHabits`：同一个人、同一个会话的例子在前）。草稿卡片的“不发”换成带原因的四个按钮（`DROP_REASONS`）；`reply_to_asker` 对远长于本人平时的回复拒一次（`typicalReplyLength`）。草稿档的说明改成“有能直接给对方的结论才拟，一两句”。设计见 docs/v2/mentions.md“学本人怎么回”。
- 知识库的文档归位（`src/sources/kb-home.ts`，表 `wiki_node_homes`，索引 `sources_wiki_space`）：知识库归入业务空间后，它的文档不管从哪个入口进来都落在那个空间——`prepareArchive` 对自动采集按它归属，`importLarkDocument` 对跟着链接读进来的文档按它落位（已有的未固定副本移过去）；本人手动移动过的不动（`pinned`）。目录可以单独归到别的空间（`setDirHome`，原件目录树的行菜单）。存量：`kbStrays` / `rehomeKb`（移动，目标已有同一篇就并成一份，`duplicates.ts mergeSources`），入口是知识库页的“收回”、`/api/lark/kb-home`、远程命令 `lark-kb-home`，每晚的归位巡检也先做这一步（`archive.autoMove` 开着且待归位的不超过 50 份时；更多的等本人点“收回”）。归入个人空间的知识库不适用。
- 文档排版（`web/src/lib/doc-layout.ts`）：`sizeTables` 给每张表按内容算列宽（文档带宽度时用文档的），比正文宽的在 `.table-wrap` 里横向滚动；`layoutCallouts` 把飞书高亮块排成图标在左、文字在右；`docBlocks` 把另一种导出格式（`<lark-table column-widths>`、`<quote-container>`、`<callout emoji>`）转成普通 HTML。`styles.css` 补了 `.doc-callout`、`.doc-grid`、`.doc-col` 的样式（之前没有）；采集时带上高亮块的颜色（`lark-docs.ts calloutColor`）。
- 虚拟列表（`web/src/components/VirtualList.vue`）：每次更新重新找滚动容器，滚动事件在 window 上捕获。之前只在挂载时找一次：面板当时还没溢出就认了窗口，之后在面板里滚动不再补行，下面留一大段空白。
- 运行的触发方式和触发人（`src/core/run-trigger.ts`，列 `runs.trigger` / `trigger_by`）：对话、访客提问、有人找你、规则、定时、同伴设备、成员操作；人是 omem 用户（`user:<id>`）、飞书上的人（`lark:<open_id>`）或别的机器人；创建运行时给出，或从输入读出，或沿用上一级运行的；定时任务的执行器里建的运行带上是哪个定时（`withTrigger`）。`GET /api/runs?by=` 按人筛选，`GET /api/runs/triggerers` 列近 30 天的人。运行页列表显示触发人，头部多“触发人”下拉。迁移回填了访客、有人找你和对话三类旧运行。
- 设置页（`web/src/views/Settings.vue`、`components/HelpText.vue`）：分类移到左边分组显示，右边是当前分类的卡片目录；长说明用 `HelpText` 收成一行，全文在 ⓘ 的悬浮层里。约定写进 `.agents/skills/omem-design`。
- 组网的名片与请教（`src/core/mesh.ts`，表 `peer_grants`）：`nodeCard` 按调用方给出这台有什么（本人设备全部，服务账号只有授权的），`refreshCards` / `startMesh` 每十分钟取配对节点的名片，`meshNote` 写进本人助手的常驻说明；`fedAsk` / `fedAnswer`（`/api/fed/ask`）让别的节点请教这台的 Agent（别人的服务问主助手时走访客角色，只读、限共享的空间、有每天次数），`askPeerAgent` 是 `ask_agent` 的 `<档案>@<节点>`，回答里的引用经 `peerRead` 落到本机；`consultAgent` 多了 `input` / `trigger` / `onStart`。设置 → 设备 显示名片、按对象开放 Agent。
- 借出 AI（`src/core/mesh.ts` 的 `lendAllowed` / `lentToday`，`src/server/http.ts` 的 `/api/peer/acp` 升级鉴权）：服务账号有 `ai:<后端>` 授权时可以打开这台的 ACP 后端，按连接计每天次数；名片的 `ai` 带剩余次数和 `as`（这台怎么看对方）。`/api/peers/:id/status` 读不到对方设置时用名片上的 `ai`。空间设置 `local`（仅本机）：`setShares` 拒绝，`runner.ts` 换后端顺序里跳过 `lentByOthers` 的后端。
- 镜像上的写入转给主（`src/core/mesh-write.ts`，表 `fed_outbox`）：`callTool` 在执行 `remember` / `supersede` / `forget` / `save_note` / `write_page` 前看目标空间是不是镜像（`forwardToHome`），是就把参数里的本机 id 换成主的 id、调主的 `/api/peer/tool`，再同步这个订阅；主连不上时进发件箱，`syncAll` 先 `flushOutbox`。`placementOf` 给出空间是主、仅本机还是镜像。
- 自动备份（`src/core/peer-backup.ts`，设置项 `backups`，定时任务 `peer-backup` 每 20 分钟）：到期的备份先问对方在不在（`/api/diag`），在就在子进程里跑 `omem peer pull <设备> --to <目录> --only … -y`，状态记在 `kv` 的 `peer_backup:<设备>`；`omem peer backup`、`/api/peer/backups`、设置 → 设备 的“自动备份”。`omem serve --no-background` 不启动定时任务、渠道和采集。
- 拉取的快照（`src/core/pull-snapshot.ts`）：`strip` 模式改成在一次读事务里按表拷进新库（`chunks` / `symbols` / `code_refs`、设备表、全文索引表只建空的），不再 `vacuum into` 整库；`since`（`PullSelection.since`、`/api/peer/snapshot?since=`）时 `sources` 和 `run_events` 只带那之后变过的，没带的原件写进 `pull_source_keys`，`prepareData` 用它补 id 映射。清单 `pull-manifest.json` 多 `takenAt` / `since`；`omem peer pull` 成功后把 `takenAt` 记在目标库 `kv` 的 `pull_since:<机器>`，下次减一小时作为 `since`，`--full` 不用。
- 拉取时原件跟着对方换空间（`pull-data.ts` 的 `prepareData`、`pull.ts` 的 `mergeLibrary`）：移动原件不改它的正文和时间，增量快照不带它、合并也认不出来。现在对方那个位置在本机找不到时，按它离开过的位置（`source_locations`，那里对方没有别的原件时）或同一个 id 找到本机的那份，记进 `prepared.moves`；合并时对方的最后一次移动不早于本机的就改本机的 `space_id` 和分块、符号的空间，本机之后自己移过的保持不动，目标位置已有别的原件时不动。只改拉取方，对方不用更新。找本机那份时同一个 id 优先，旧位置上已删除的原件不算。对方把一份副本合并进另一份（`source_aliases` 里本机还没有的）时，合并前先对本机的行做同样的改挂（`refTables`、`item_materials`，删掉副本的 `source_routes`）；另外带 `sync_key` 的表插入时跳过本机已有同一个 `sync_key` 的行。之前对方合并过重复原件后，拉取方会在 `digest_done.sync_key` 上撞唯一约束，整次合并回滚。
- 拉取的知识库不再凭空分叉：`rewriteRefs` 在原件 id 不用换、也没有行号换算时原样返回（以前会把 `#L8-L8` 写成 `#L8`，每次拉取都在对方的历史上多出一个改了几百个页面的提交，对方再改到相邻的行就冲突，而冲突保留的是本机的旧版）。`mergeLibrary` 加 `preferRemote`（命令行 `omem peer pull --prefer-remote`，自动备份的拉取带上它）：页面两边都改过时用对方的版本，本机的存为同名 `.local.md`。
- 向量紧凑存储（`src/search/vector-codec.ts`）：`pack` / `unpackInto` / `toFloats` / `isPacked`；`embedPending` 写入 `pack(v)`，`vectors.ts` 的 `push` 和 `sampleMatches` 两种格式都读（`quantize` 挪到 codec）；`packStoredVectors` 按分块 id 顺序每批 500 行改存（游标 `kv.vector_pack_cursor`，做完 `vector_packed = 1`），`main.ts` 启动 20 秒后每秒一批；迁移重建 `vector_log_update` 触发器，同一向量从 float32 改成紧凑格式不记变更。`omem db [status|vacuum]`。记忆的向量（`memories.embedding`）仍是 float32，条数少。找还没算向量的分块（`embedPending`，每半分钟一次）走部分索引 `chunks_unembedded`：原来是读整张表，紧凑格式的向量存在表自己的页里，扫描跳不过去。
- docs/v2/mesh.md：组网运行（名片、问对方的 Agent、借 AI、按空间定主从与发件箱、租约）和助手的设计，各节写了实现到哪。
- 助手（`src/agents/assistants.ts`）：`lark.bots` 的机器人加 `userId`（谁的助手）、`name`、`description`、`dailyRuns`；`botSender` 把建机器人的人认成它的主人（成员），`botRoster` 写明是谁的助手；`overDailyLimit` 在 `inbox.receive` 里拦超过每天次数的轮次；`/api/assistants`；`AssistantsSettings.vue` 用在账号页（我的助手）和 设置 → 渠道（全部助手，替换原来的“其他机器人”列表），可以“用飞书创建机器人”（`scanNewAssistant`，`registerLarkBot` 的确认链接）或填已有应用。

## 2026-11-14：多个决策模型

设置 → AI → 决策 可配置多个模型（最多 9 个），用上移、下移调整顺序。第一个存为 `ai.decision.provider` / `model`，其余存为 `others`；`pick` 为 `fixed`（默认，按顺序先问第一个可用的）或 `random`（每次随机选一个可用的先问）。不可用的跳过，拒答或调用出错时自动问下一个；刚调用出错的模型在 5 分钟内排在其他模型之后。判断记录写明实际回答的提供方和模型，换过时另写“没答上，换了一个”。每行分别显示可用状态和缺少的配置。

设置接口返回 `decisionModels`；试用接口可指定提供方和模型，以配置副本测试，不改保存的设置。

## 2026-11-14：Agent 页 MCP 服务

Agent 页新增“MCP 服务”：按名称配置命令和参数或网址，环境变量 / 请求头的值存密钥，保存后只返回名称与是否已设置。可以检测连接并列工具（20 秒超时，回收子进程，响应脱敏），编辑、删除时看哪些档案和角色还在用。

档案表单用 `mcpServers` 选择服务，内置角色用 overlay `mcp`，访客角色不可挂载；旧内联 `mcp` 保留并显示“写在档案文件里”。仅本人运行带这些服务，其他成员、访客和评审不带，夜间复盘只带标只读的。HTTP 路由本人专用，档案保存拒绝未知名称；保存系统设置保留 MCP 的密钥。

实现与专项回归：`src/agents/mcp-test.ts`、`web/src/components/McpServices.vue`、`test/mcp-servers.test.ts`、`test/fixture-mcp-server.ts`。

## 11-14：候选技能交给夜间复盘试用，补充调研与逐轮改进技能说明

- K1 从库中 draft 技能和 pending 技能提案挑候选，按名字、说明匹配问题（向量余弦 ≥0.5，无向量双字相似度 ≥0.2），遵守档案 / 角色归属；同一题同一候选不重试。变体只追加最多 6000 字符，不增加工具。
- 默认计划在负面和纠正的 M1 后、正常和慢的首位加入 K1；已有计划不迁移。夜间没有 K1 时，为未试候选找近期最匹配的问题，最多换掉一个最弱信号选题，保留负面和纠正。
- `replay_effects` 记候选 helped / hurt；默认两胜且胜多于负后启用草稿或采纳提案，记复盘归因，发一次 later 通知。`replay.skills.adoptAfter=0` 只试用。两负无胜拒绝提案、草稿仍保留；有胜未达门槛的提案不按年龄过期。Agent 页显示胜负与“复盘后自动启用”，复盘结果带技能名；CLI 与设备命令含 K1。
- README 与文档站说明内置 `research`（库先查、外部 MCP、多来源核对、开头给结论）、`improve-loop`（先定度量与完成条件，每轮一改，无效回退，两轮换方向、四轮交回）；内部检索或另一模型云端调研的接法只写数据目录技能，内部名字和代码不进入外部查询。技能正文保持不变。
- 回归限于 `test/replay.test.ts`、`test/desktop-control.test.ts` 与前后端类型检查，未跑全量检查；细项见 `docs/v2/acceptance.md` 的 RP-K1-01 至 RP-K1-07。

## 11-15：改进循环由宿主度量、回退和停止

- 新增 `improve_goals` / `improve_rounds`（设备本地），工具组 `improve`：`improve_start` 固定度量和预算、量基线；`improve_round` 检查保护路径、跑委托检查、按相对增益留下或新增 revert 提交；`improve_status` 读状态与历史。达标、预算、四轮无效或时限停止，由宿主发 later 报告，两轮无效返回换方向提示。
- 检查和度量共用 `repositoryCommand`，继承宿主 shell、环境、工作区与超时；原有宿主检查同时接入命令规则 PATH 垫片。改进轮检查追加到运行的 `improveChecks`，不覆盖原 Check；`latestCheck` 和交办“活动”可见。交办概览新增“改进目标”，新 API `GET /api/code/:id/improve` 按运行读取权限。
- 无推送、合并或应用。分支在别处检出时，回退提交保留在委托 worktree 的 `pending`，下一次正常结算再处理，不更新别处文件。
- 专项验证及已知限制见 `docs/v2/coding-loop.md` 与验收 IMP-01 至 IMP-06。
- `roles/assistant.md` 的工具加 `group:improve`；内置技能 `skills/library/improve-loop` 改成按这三个工具走（第 0 轮先把度量命令跑通，再 `improve_start`；每轮编码后 `improve_round`）。内置技能只补缺：已有数据目录里的旧版 `improve-loop` 不会被覆盖，要在技能页换成仓库版。


<!-- 以下条目当时加在文件最前面，日期在 11-05 到 11-15 凌晨之间 -->

## 回复对方的档位升降；不急通知的清单只列 12 条（11-15）

- `src/mentions/reply-ladder.ts`：回复找本人的人和工具审批一样分档升降。`draftStreak` 按 `reply_samples` 数某一类会话（群 / 私聊）最近连续照发的草稿；到 `mentions.reply.promoteAfter`（默认 10，0 不问）时 `suggestReplyPromotion` 问本人一次，回答由 `reply-promote` 处理：只有本人自己选“直接发”才经 `MentionChannel.reply.setMode` 改成 auto。`demoteReplyFor`：自动回复的提醒被本人回负面表情，这一类退回 draft 并重数。入口在 `src/channels/mention-reply.ts decideMentionReply`（照发之后）和 `src/core/notify-reactions.ts applyNegative`（先于学忽略规则）。
- `src/core/notify.ts releaseLater`：三条以上合成的清单只列最新的 12 条，更早的只报条数；全部仍随清单算已送达。
- 测试 `test/reply-ladder.test.ts`、`test/notify-later.test.ts`；验收 43d1–43d3。

## 2026-11-15：决策按场景设门槛、记结果与离线比较

- 巡检、盯群、有人找你、直接答复分别记录模型、问题、截短材料和概率，低把握的跳过 / 忽略 / 直接答复改为谨慎选项；分诊选处理者和其他调用不变。
- 巡检按当前运行或来源的补看运行标注；分诊按 mention / handleRun 的通知结果，忽略则按原消息后一天内本人是否回复。通知按运行索引查询，事项事件新增可选运行 ID，标注每轮最多 200 条；超过 90 天分批删除。decisions / decision_sweeps 按 quality_audits 的方式列为设备本地数据，不拉取合并。
- 设置 → AI → 决策有四项门槛、30 天报告与只读建议；本人接口 `/api/ai/decision/report`、设备命令 `decisions`，以及 `omem decision report` / `omem decision replay`。回放指定单个模型，当前门槛下比较相同成功样本，不写库，连续三次失败停止。盯群和直接答复本次不标注。
- 详见 `docs/v2/ai-models.md` 的“按场景记录、门槛与回放”和验收 DEC1–DEC6；真实模型效果仍需本人用自己的记录校准。

## 仓库从评审里学到的约定（11-15）

仓库空间新增“学到的约定”：Agent 对照近 90 天其他交办采纳过的相近问题，通过 `propose_repo_lesson` 提炼；文本或模式相同的合并证据，两个根交办默认启用并只通知一次，本人关闭的不自动打开。启用的模式约定只查每轮新增行，命中复用仓库检查失败结果；其他约定也交给编码和各类评审，问题可引用 `lesson:<id>`。空间设置支持维护条目、打开来源交办；约定随设备拉取携带。代码在 `src/agents/code-lessons.ts`、`code.ts`、`review-chain.ts`、`code-overlap.ts`、`review.ts`、`tools.ts`，网页在 `web/src/components/RepoLessons.vue`。范围与上限见 `docs/v2/review.md`“学到的约定”。角色：`roles/review-lead.md` 多一条“同一类问题第二次出现，写成这个仓库的约定”，`roles/coach.md` 复盘编码类档案时也可以提，两者的工具加 `propose_repo_lesson`；`roles/_common.md` 新增一节“这个仓库学到的约定”，编码和各评审项的运行都带上。找以往采纳过的问题直接从评审记录读，没有另建表。

## 通知负反馈改变下次行为；会议结束释放通知（11-15）

- `src/core/notify-reactions.ts`、`src/channels/lark-feedback.ts`：本人对工具完成汇报回负面表情，按通知 `reportTool` 立即用 `setRung` 改回 ask，重算批准连续次数，later 告知一次；普通通知复用“忽略”按钮的模型路径，通知保存生成的规则，一次性事件不告知。紧急提醒与工具汇报不学忽略规则，`notify.learnFromReactions` 默认开，可在渠道设置关闭。通知页展示、删除忽略规则，并显示通知学出的规则。
- `src/core/notify-outcome.ts`：标为 negative 时补做同一处理，覆盖服务停机期间已存到 `feedback` 的反应；重复事件与重复标注不重复执行。`src/channels/lark-actions.ts` 的本人“忽略”也共用通知上的处理记录。
- `src/channels/lark-meetings.ts`：会议结束或本人离会调用 `releaseLater(app, new Date(), { now: true })`，立即放出攒着的通知，不占下个固定时点。本次不增加会中扣留逻辑。测试见 `notify-reactions`、`notify-outcome`、`approval-ladder`、`meeting-rules`、`notification-settings`。

## 场景包带空间结构（11-15）

- `src/plugins/registry.ts`、`spaces.ts`：清单增加 `spaces`，与旧 `space` 合并；挂载技能须由本包声明，拒绝重复 id、无效 id，忽略未声明字段。启用时按清单顺序创建空间，已有同 id 空间完整保留；详情记录“已创建”或“已有同名空间，没有改动”，停用和卸载不删空间。空间表无插件来源字段，未新增列；创建记录使用插件的保留安装状态。
- `src/plugins/pack.ts`、`cli-main.ts`、`web/src/components/PluginPack.vue`、`PluginsSettings.vue`：API 的 `spaces`、可重复的 `--space <id>` 和同一打包表单选择空间，只带名称、类型、说明和技能挂载，不读取或复制空间内容，不带成员、仓库路径、会话或其他设置。个人和代码仓库空间拒绝打包；遗漏空间或挂载技能按名称提醒。规则复用 `portableRule`，保留包内空间，安装先建空间再导入停用规则；接收方已有空间的行为保持不变。
- 测试 `test/plugin-pack.test.ts`、`test/permissions.test.ts`；验收 PL7–PL9。

## 夜间抽检 Agent 的原件与目录定级（11-15）

- `src/quality/levels.ts`：同一次夜间审计除页面外还抽最多 6 条 Agent 定级（`quality.audit.levels`，0 关闭）。目录先于单篇、忽略和仅检索先于其他，大目录先查，再按定级时间。少量目录候选按空间共用现有内存目录，取路径和原件数；单篇通过部分索引做 SQL 限额查询，只取剩余额度。选中后才取正文前 4000 字；目录从原件 ID 列表等距选最多 15 个 ID，一次只读这些标题。目录不落库，采集时不维护审计专用的目录关系。`wiki-checker` 的工具列表和说明包含 `submit_level_check`，工具只在定级核对步骤接受结论。
- `src/sources/attention.ts`、`SourceReview.vue`：不对的决策带建议级别和理由进入原件 → 待复核；本人采纳或保持，审计不自行修改。建议绑定当时的决策；更新定级后旧建议失效。单篇定级新增时间、理由和运行，老决策可抽一次。
- `src/quality/audit.ts`、`Quality.vue`：定级沿用 `quality_audits`，记录来源运行类型；报告增定级行，相同窗口单列准确率，不触发自动加严。测试在 `test/quality-audit*.test.ts`。

## 简报先替本人备好；会后放出攒着的通知（11-15）

- `roles/brief.md`：写简报之前，先按任务里的“本人近况”（`work-state.ts` 的摘要）逐条线看有没有现在就能做完、又不需要本人拍板的准备（查出会上要用的数字、理好要回的消息的背景、先读要评审的文档），每条线最多一件、一共不超过三件，只读、只写工作文件和事项时间线；简报里单列“已备好”。角色多了 `write_file`、`read_item`、`list_pages`、`source_outline`。`jobs.ts` 的简报任务带上近况。
- `core/notify.ts`：`releaseLater(app, at, { now: true })` 不等固定时点，立即放出攒着的不急通知，也不占用下一个时点。

## 回复发出前拦下空话（11-15）

- `src/agents/reply-quality.ts`：确定性地认出四种明显不是回答的回复——只有一个表示不说话的内部标记、只说接下来要做什么、只应一声、只有退路没有结论和依据。规则在真实回复上校准过：拦下的不到百分之一，普通的短回答（问候、做完后的确认、先说事实再说下一步）都放行；这一轮已经安排了之后回来（唤醒、交办、提问）或做过写入时，“我去看看”“好的”不算。
- `src/agents/reply-check.ts` 的 `reviseHollow`：对话轮次（`ask`）和规则、被 @ 等交给 Agent 的运行（`agent`）在回答发出前过一遍，命中就在同一个会话里退回重写一次，告诉它哪里不行、该怎么写；重写后的内容照发。内部标记永远不发：没人在等的那一轮按不说话处理，有人在等就回一句“这一轮没有给出回答”。结果记在运行的 `output.replyCheck`。
- 配置 `replies.check`（默认开），设置 → AI →“回复发出前的检查”。测试 `test/reply-quality.test.ts`。

## 本地模型优先经 osdk 下载（11-15）

- `src/search/local-models.ts`：向量模型和重排模型在配置里写的是 Hugging Face 的 id 时，机器上有 osdk 就先用 osdk 下载并锁定版本（清单 `OSDK_MODELS`，和 `osdk.toml`、`omem setup` 里的别名、来源、文件一致），加载时从 osdk 的目录离线读；没有 osdk、清单里没有这个模型、或 osdk 下载失败（十分钟后再试）时，才由 transformers.js 自己下载到依赖目录的缓存里。配置里的模型名不改：向量模型的名字就是它的身份，改了会清空向量。
- 以前自己下载过的那份还在缓存里时，osdk 下载期间先用它，功能不断；什么都没有时，osdk 下完之前重排不生效、向量不生成，不会两边同时下载。
- `loadLocalModel`（`embeddings.ts`）在每个进程里都先查 osdk 的目录；主进程的 `getEmbedder` 和 `rerankScores` 负责发起下载（`prepareLocalModel`）。
- 设置 → 检索：向量和重排各有一行写明模型从哪里来（本地目录 / osdk 锁定的目录 / 自己下载的缓存 / osdk 正在下载 / osdk 失败的原因）。重排的状态不再把“模型在读进程里加载失败”显示成“还没用过”：读进程把失败原因抛回来（`read-worker.ts`），首次下载期间的超时显示成“正在下载或加载”。
- 测试 `test/local-models.test.ts`（osdk 用替身，测试进程里不碰真的 osdk）。

## 经验目录过大时，做梦提炼技能草稿（11-15）

- `src/agents/dream-consolidate.ts`：统计档案和内置角色名下有效的专属经验，按目录条数排序，附最多 12 个标题（回答时召回次数优先，其次新写的）。`dream.consolidate.min` 默认 30，`perNight` 默认 2、0 关闭；同一时区日期内手动再跑也计入额度。共享记忆不计数，空间范围按运行和用户权限限定。
- `jobs.ts` 的 dream 任务加“经验太多的目录”，无其他变化也可启动；成功后才写 `kv` 的 `dream_consolidated:<档案>:<目录>`（条数、日期、技能名）。通过草稿正文的 `mem:` 出处对应原目录，增长至少 30% 或对应技能删除后才重交；已被复盘启用的技能不算删除。运行摘要列出提炼的技能草稿和归属。
- `tools.ts` 的 `recall` 原已允许指定别的档案读取，现在补 `limit` / `offset`，可翻完超过 200 条的目录；`save_skill(agent, draft=true)` 沿用原有挂载路径，记录做梦保存的草稿，由既有夜间复盘 K1 试用后启用；原经验不删改。`peer call … config` 自动包含新设置。`test/dream-consolidate.test.ts` 覆盖筛选、去重交接、失败和 ACP + MCP 保存与挂载。
- `docs/v2/review.md` 同步 `_common.md` 的运行行为证据约定：实际运行附命令和关键输出，只读代码推断要明说未运行并给行号。

## 重点文档每晚补写进 Wiki（11-15）

- `wiki/coverage.ts`：有效级别为 focus 的文档统计覆盖率；尚无页面引用的按贴链接次数、发帖人数、引用、事项、本人定级和近期修改排序，不读取候选正文。`wiki_coverage_tries` 记录生成尝试并同步，30 天内不重复选。
- `wiki/generate.ts` 新增 `sourceIds`，只规划指定文档涉及的内容，优先补已有页面，沿用现有写作与核对。默认 `wiki-coverage` 每天 04:10 全局最多 3 份，每空间最多 2 份，跳过关闭自动整理和代码空间。
- 空间 Wiki 顶部的覆盖数字可展开前 20 份候选和具体信号，写权限用户可点“现在写这几份”；两个 coverage HTTP 路由均需 wiki.write；只读 peer 命令 `wiki-coverage` 返回各空间数字。设置 → 定时任务可调整额度或关闭。回归在 `test/wiki-coverage.test.ts`、`test/permissions.test.ts`。

## Wiki 指正：改这一页、排查同类、后续核对记住（11-15）

- `src/wiki/corrections.ts`：`page_corrections` 保存本人原话、正确说法和最后写入的运行类型，支持设备拉取合并；网页与 `correct_page` 共用写权限和空间范围检查。原页直接进现有写作核对，再由 `wiki-sweep` 选同空间同类运行近 90 天写的页与搜索命中，同目录优先、默认最多 15 页（0 关闭）。
- `verify.ts` 每轮草稿核对和 `checkPublished` 都带本空间最近 20 条指正；排查只找同类问题，通过 `generate.ts` 的 `sendPagesBack` 与夜间抽检共用退回路径。等写作与核对完成再计已改，只有一条 later 汇总，0 页不通知。网页页面操作“这页有错”用双字段弹窗，未决问题清单列指正和进度。
- 验证：`test/wiki-corrections.test.ts` 走 ACP + MCP 假 Agent；权限、工具分组与夜间抽检定向回归。真实模型同类问题判断待验。

## Agent 页按分组选工具；技能可以停用（11-14）

- `web/src/components/ToolPicker.vue`：档案和内置角色的 omem 工具不再是一个长下拉。已选的显示成标签（整组一个标签，带“排除 N 个”），“按分组选择”展开面板：勾分组名写成 `group:<id>`，整组里取消一个写成 `-<工具>`，展开后逐个勾写成工具名；可搜索；底下按档案文件的写法显示结果。`GET /api/profile-options` 多了 `toolGroups` 和每个工具的 `roleOnly`（内置角色交结果用的，不随整组）。
- 内置角色：`builtin-roles.ts` 的 `roleTools` / `setRoleTools`，`PUT /api/roles/:name/tools`（只给本人）。加减存进叠加（`updateRoleMeta` 的那条路径），角色不变成自定义副本；角色自己列出的交结果工具不能去掉；guest、gatekeeper 拒绝。`GET /api/roles/:name` 返回 `toolSet`（按写法的清单、版本自带的清单、交结果的工具、是否改过）。
- 档案：`saveAgentSpec` 拒绝不存在的 `group:`（以前不报错，运行时什么都不给）；`save_agent` 的参数说明写了分组和排除的写法。
- `proposals.ts`：改进建议去掉的工具如果是整组带来的，写成排除；加回时去掉排除；没列工具的档案从默认只读工具起算（以前加一个工具会让它只剩这一个）。
- 技能停用：`specs.ts` 的 `setSkillStatus` 保留其余 frontmatter，本人停用时记 `tryout: false`（`skillHeld`）；`PUT /api/skills/:name/status`；技能页多了“停用”。`replay-skills.ts` 的候选不含本人停用的草稿和复盘启用过的草稿；候选的向量每晚只算一次；启用失败只记日志。
- `sources/attention.ts`：关掉标注的独立复核（`notes.review.enabled = false`）时，Agent 的标注直接进本人的待确认队列（开着时仍是复核拿不准的才进）。`config.ts` 里 `notes`、`wiki` 的默认值改成每次加载各自一份。
- 测试 `test/role-tools.test.ts`。

## 编码评审：换别家模型、提前精简、第三次修补与复用（11-14）

- `review-chain.ts` / `review.ts` / `families.ts`：默认 prefer 在评审项与编码同家时，从评审换模型列表和任务选型候选顺序找可用别家；保留本人、轮换与复看选择。记录实际独立性，same 在网页有徽标，require 在摘要与裁决材料说明不算独立评审，不拦运行。
- `code-tasks.ts` / `code-loop.ts` / `code-overlap.ts`：40 行源代码即要求精简；新库标准档功能、精简、业务，完整档再加架构、历史、规范（已有档位不迁移）。阶段计划加同仓库近 30 天采纳 / 驳回史，裁决（含复看）列深度至少 3 的修补链。`pre-check.ts` 的 reuse 清单给编码、方案与评审，概览卡片可展开。细节见 `docs/v2/review.md` 末节。

## 不急的进展汇总与提醒效果（11-14）

- `src/agents/jobs.ts` 把 `releaseLater` 与 `labelOutcomes` 接入巡检杂务，无新材料也执行。通知工具接受 later；网页区分等待 / 已并入汇总，汇总标题各自可打开；设置 → 渠道编辑时间和查看近 30 天效果。
- `src/core/notify-outcome.ts` 在超过 48 小时后每轮最多标注 300 条，按负面、处理、先已知道、只读、未读区分，并入汇总单记 bundled。统计按运行类型与聊天原件回给巡检、整理与找人分诊；至少 8 条且从未处理的会话可确认后设免提醒，保留点名、限时例外。忽略规则没记录来源 ID，未拿它判 negative。
- `web/src/components/ApprovalSettings.vue`：工具审批可选每次问 / 做完告诉 / 不用问，显示连续批准次数、可调提议门槛；report 用 later 告知。核心在 `src/agents/approval-ladder.ts`，强制审批插件不升档。行为回归见 `test/asks.test.ts`；统计、接口、巡检分别见 `notify-outcome`、`notification-settings`、`heartbeat-handler` 测试。

## 原件标注复核与知识库建议分档（11-14）

- `sources/attention.ts`、`agents/jobs.ts`、`roles/note-reviewer.md`：每小时独立复核 Agent 标注，保留按八成、撤回归零，拿不准才进本人清单；本人可恢复近 14 天撤回的标注，只有本人确认的有误、不检索才移出检索结果。`review_notes` 只给复核角色，记录模型、时间和依据；候选按排名影响、搜索命中和时间排序。
- `channels/lark-knowledge.ts`：autoApply 改 off/safe/all，旧布尔兼容，新配置默认 safe；归入已有空间和忽略直接应用，新建仍等确认，通知分列处理与等待，原有 reset 可撤销。
- `wiki/questions.ts`：新增阅读次数、夜间候选排序与预算、旧问题过期函数；网页能筛选过期并重开。定时任务 `wiki-resolve`（每天 05:40，`wiki/verify.ts` 的 `resolveNightly`）先过期、再把当晚选出的问题按空间各排一次调查；`queueResolve` 可以接指定的问题 id 和当晚的日期。

## 场景包与插件聊天渠道（11-14）

- 插件可带规则与 MCP：规则首次导入停用并记来源，删后不重建；MCP 只留密钥名，命令先经插件信任，同名不覆盖，卸载后保留。`src/plugins/contributions.ts`、`registry.ts`，规则的 `origin` 在 `src/rules/store.ts`。
- `omem plugin pack`、本人专用 `POST /api/plugins/pack` 和 设置 → 插件 的“打成场景包”导出已有配置，技能含全部资源；文本含已存密钥或用户目录绝对路径时拒绝写包，用户目录路径可按文件放行、已存密钥不能；带脚本或转发的规则不随包走，完全访问、会话、指定的 AI、接收方没有的空间去掉（`contributions.ts` 的 `portableRule`，导入时同样处理，不创建的规则在插件详情里写原因）；插件档案只能用包自带的 MCP 服务，技能目录里的符号链接不复制；安装支持本地目录，复制而非链接。入口 `src/plugins/pack.ts`、`install.ts`、`http.ts`、`web/src/components/PluginPack.vue`。
- `api.channel` 接聊天平台，在 omem 进程里运行。宿主负责身份、会话、回复、通知分段、发送错误与注销，停用或撤销信任立即断开投递入口；设置 → 渠道 显示状态。入口 `src/plugins/channels.ts`、`types.ts`、`web/src/components/PluginChannels.vue`。

## 每晚抽检（11-14）

- `src/quality/audit.ts`：05:10 抽检 Agent 自主写入的页面，核对事实与写法；问题交回正常写作，按运行类型统计并在低于门槛时加严。`#/quality` 展示统计、原因、问题与修改运行，Wiki 侧栏展示最近结论，设置 → AI 可调开关、额度、门槛和交回方式；HTTP 只给本人，peer 命令 `quality` 只读最近 20 条摘要。设计与限制见 `docs/v2/quality.md`。

## 巡检预筛与定期补看（11-14）

- `src/agents/heartbeat-gate.ts`、`jobs.ts`：巡检前由决策模型看关注、等待事项、新材料标题与片段、事项来源、已发通知和本人状态；判断无关则安静结束，输出 `gated: true` 和预筛摘要。未配模型、调用失败或新材料超过 30 份时直接交给助手，到期提醒不受预筛影响。
- `heartbeat_skipped` 保存跳过的材料；默认每 12 小时由助手补看，补看不问决策模型，完成后清空。设置 → 定时任务 → 巡检预筛可关闭，并将 `heartbeat.sweepHours` 设为 1–72 小时；决策模型在 AI → 决策 配置。
- `test/heartbeat-gate.test.ts` 覆盖门函数；`test/heartbeat-handler.test.ts` 走真实 handler 与 fake ACP，覆盖跳过、启动、13 小时后无新材料的补看、关闭预筛。
- 一次巡检最多交给助手 60 份材料：补看清单里放不下的留在记录里，下一次巡检接着看，全部看完才重新计时（`test/heartbeat-handler.test.ts` 的容量用例）。

## 记忆按对话与任务供给，召回区分回答与整理（11-14）

- `src/agents/runner.ts`：对话常驻偏好和自身经验，小量经验全带、超量带最新 6 条；任务按相关性挑最多 12 条自身经验与 8 条共享偏好、经验，无向量时取最新。主助手的自身记忆归属为 `assistant`。`src/memory/folders.ts` 的 `ownFolderNote` 提供目录、说明和条数。
- `src/memory/passive.ts`、`sessions.ts`、`replay.ts`：所有类型参与自动召回，排除说明已带上的记忆；复核开启时偏好、经验只用本人写入或已保留的；回答和办事任务也带上相关记忆，整理角色不带。
- `src/memory/recall-stats.ts` 与“记忆 → 召回”：`purpose` 分回答、办事与整理，`via` 分主动查、自动带上、任务挑选；整理次数单列，偏好不计从未召回。`recall` 的目录等筛选配合 query 时先扩大候选再筛，最多返回 20 条。回归：`test/memory-recall-scope.test.ts`。

## 轻量命令行 @omem-ai/cli（11-13）

- 新包 `packages/cli`（npm `@omem-ai/cli`，命令也是 `omem`）：只有连远程 omem 的 `login`、`open`、`remote` 和远程的 `tool` / `mcp`，Vite 打成一个无依赖的文件，给只用别人 omem 的人装，不带服务端的依赖。
- npm 包统一放到 `@omem-ai` 下（11-13）：应用 `omem-assistant` → `@omem-ai/app`，SDK `omem-plugin-sdk` → `@omem-ai/plugin-sdk`（`web/vite-plugin-pages.ts` 的别名、`web/tsconfig.json` 的 paths 一起改），三个包都从 0.0.1 起；`omem-cli` 因和别的包名太像发不出去，用 `@omem-ai/cli`。`scripts/upgrade.ts` 会先卸掉旧名字 `omem-assistant` 的全局链接。
- `remote`、`login`、`open` 三组命令和 `clientInfo` 从 `cli-main.ts` 移到 `src/remote-commands.ts`，两个命令行共用；`omemHome()` 移到 `src/core/home.ts`（`config.ts` 照旧导出）。`scripts/publish-npm.ts` 和 `publish.yml` 多发这个包。回归：`test/omem-cli.test.ts`。

## Chrome 扩展连接 omem：多连接与把拾取发给 omem（11-10）

- 扩展存多条连接（本机、远程地址、经已登录连接转发的配对设备，`chrome/src/shared/connections.ts`），用 `omem login` 同一套确认页换 `om_` 令牌；浏览器 cookie 只用来提示「已登录为 X」，写请求不靠它（omem 对带 cookie 的写请求要求同源）。
- 新接口 `POST /api/clips`（`src/sources/clips.ts`，路由权限是目标空间的 `source.write`）：截图校验后存成图片原件，正文里的 `{{image:key}}` 换成 `omem-file:` 和 `src:`；`mode: ask` 走问答入口，`mode: source` 存成笔记并排进整理。确认页 `CliLogin.vue` 的文案不再只说命令行。
- 拾取时多记元素上下文（`chrome/src/shared/element-context.ts`：CSS 路径、属性、文字、精简 HTML、子元素概况、所在标题，各项有上限）和页面上下文。回归：`test/clips.test.ts`、`chrome/src/shared/omem-send.test.ts`，e2e `chrome/e2e/omem-send.e2e.test.ts`（起真实 omem）。

## Chrome 扩展并入仓库：默认不连 CDP 与拾取（11-10）

- 原来独立的 DevTools 扩展并入 workspace（`chrome/`，包 `omem-chrome`），界面换成 omem 的配色。约定在 `chrome/AGENTS.md`，设计在 `chrome/docs/changes/no-cdp-and-pick/design.md`。
- 默认不连 `chrome.debugger`：面板一打开就连、且只在标签页关闭时才断，是 Chrome 顶部一直显示调试提示条的原因。现在 `attachDebugger` 只在「CDP 增强」开启时放行；不开时 Mock 和调用栈由页面钩子（`src/inject/page-hook.ts`）改写 fetch / XHR，资源搜索由面板读 `inspectedWindow.getResources()` 送给后台，模拟器用 DNR 会话规则，禁用缓存、限速、原页面模拟置灰。
- 「拾取」：`src/inject/pick-overlay.ts` 在页面上选元素、量间距、框区域、整页逐屏拼接，`src/background/pick-service.ts` 截图裁剪后存 IndexedDB；侧栏 `src/sidepanel/` 是拾取篮（引用记录、导出 Markdown）。回归：`chrome/src/shared/pick.test.ts`、`no-cdp.test.ts`，e2e `chrome/e2e/pick-and-hook.e2e.test.ts`。

## 规则批次与 Codex 审批子会话清理（11-08）

- 规则 Agent 的会话原来一律保留，批次结束和重启后换会话都可能积压。`session-cleanup.ts` 按排队续轮与有效的话题跟进判断是否还需要，完成、失败、取消且不再被引用的归档；`jobs.ts` 在换成新会话后退役旧的。会议、多 Agent 工作、聊天及编码续轮保持保留。
- Codex 的 guardian 自动审批会话没有经 ACP 报出 ID，归档父会话也不会连带归档它。`catalog.ts` 为后端声明 `sessionHistory` 格式和目录；`session-children.ts` 只读 rollout 首条元数据，按 omem 来源、guardian 类型和已登记父会话精确识别，再通过 ACP 归档。普通工作子 Agent 和其他聊天不纳入，`CODEX_HOME` 覆盖默认目录。
- 每轮结束处理子会话，失败单独持久登记；定时清理也检查已结束的保留会话，补宿主中断的遗漏。活跃的在线会话和其他存活进程拥有的会话不被后台检查打断。回归：`test/session-children.test.ts`、`test/session-cleanup.test.ts`、`test/rule-merge.test.ts`。

## 设置 → AI 与 API key（11-07）

- 设置页的“Agent”改名“AI”，分通用 / 语音 / 决策 / 图片生成 / API key 五个子页（`?tab=agents&section=keys` 可直达）。通用就是原来的内容。
- `config.ai.providers` 登记 API key 的提供方（openai、anthropic、typesafe、openrouter、openai-compatible），key 在 `secrets/ai-keys.json`（`src/core/ai-keys.ts`）。OpenAI / Anthropic 的提供方可生成 `codex@<编号>` 等后端（`config.ts` 的 `keyedProfiles`），启动时由 `keyEnv` 注入 key，额度单独计。
- 语音、决策、图片三类模型的设置与可用状态（`categoryStatus`），功能本身分阶段做，设计在 docs/v2/ai-models.md。
- 图片生成（`src/core/images.ts`）：工具 `generate_image`（新分组 `media`，只在图片模型可用时给出），图片存进 `files/`；技能 frontmatter 加 `requires`（`skillUsable`），内置技能 `image-generation`。
- 语音（`src/core/voice.ts`、`web/src/lib/voice.ts`）：Realtime 发临时凭证、GPT-Live 由 omem 代开会话，工具经 `/api/voice/tool` 只读执行；问答页麦克风与语音对话；口语练习页 `/speaking`，`speaking-review` 运行由新角色 `speaking-coach` 按技能 `speaking-assessment` 评价；迁移加 `voice_sessions`。
- 决策模型接入（`src/core/decision.ts`）：OpenAI Decisions 与 System One（Jev、本机 StartLux）两种格式；规则加 `judgeWith`（迁移加 `rules.judge_with`），模型判断和 `check` 动作默认决策模型优先；访客把关先问决策模型（`lark-guest.ts` 的 `decisionGate`）；设置页“试一下”（`POST /api/ai/decision/test`）。

## 访客开放空间按名称多选（11-06）

- 设置 → 渠道 → 访客提问的空间 ID 输入框改成 `UiSelect` 多选，显示空间名称和 ID，保存仍用 `lark.guests.spaces`。旧的失效 ID 保留为可取消的选项，不因修改范围丢失；私聊说明直接指向“开放给访客的空间”，明确未选择时没有知识库资料可查。保存期间选项暂停操作，防止连续请求丢失选择。入口：`web/src/views/Settings.vue`、`web/src/components/UiSelect.vue`；验证：`pnpm run check`（英文 Git、屏蔽本机可选文档解析器，915 项测试）、1440 / 390 浏览器交互与输入法回归。

## 交办轮次查询走索引（11-05）

- 编码循环找交办各轮的查询（`id = ? or json_extract(input, '$.continueFrom') = ?`，`lastRound`、`advanceWork`、`rounds`、`workRoundIds`、`reconcileWaiting` 等约 26 处）和按 `parent_id` 找链下运行原来都是全表扫描，常驻服务器上每次 6–14 ms，一步要查十几次。迁移加 `runs_continue_from`（表达式索引）和 `runs_parent`，查询写法不用改。合成库 1.1 万条运行：`lastRound` 34.5 → 0.048 ms，`codeChainRounds` 165.7 → 0.187 ms。入口：`src/core/db.ts`；验证：`test/runs-index.test.ts`、`scripts/bench-scale.ts --code-rounds`。

## 启动清理临时索引（11-05）

- 失效工作区逐份清理临时原件时，符号删除和采集位置的级联删除缺索引，积压较多时启动迟迟不能监听。数据库迁移补齐 `symbols(source_id)` 与 `source_locations(source_id)`；旧库迁移、查询计划和其他原件保留有回归。合成库 2 万原件、10 万符号清理 300 份：9044.1 → 372.9 ms。入口：`src/core/db.ts`；验证：`test/source-purge-index.test.ts`、`scripts/bench-scale.ts --source-purge`。

## 网页接入 Git 仓库（11-05）

- 设置 → 空间新建“代码仓库”时，同一输入框自动识别本地目录与 HTTP(S)/SSH Git 地址。`POST /api/spaces` 复用 `cloneRepository`，成功后建空间并排同步；权限检查在联网前执行，非法协议与含凭据链接拒绝，克隆失败不创建空间。网页等待期间防止重复提交，失败保留表单。入口：`src/server/http.ts`、`web/src/views/Settings.vue`；回归：`test/http-space-repository.test.ts`。

## 规则启用确认与飞书回调登记（11-04）

- `save_rule` 为会话中的停用规则准备宿主确认卡片，回答送达后再展示；点击先校验规则快照、本人身份和空间，再在事务中启用规则并保存回答，不排 AI 续轮。修改后旧卡片失效，不另生成普通的建议按钮。`confirmation.ts`、`agents/asks.ts`。
- 飞书卡片发送前保存交互记录，按钮携带交互标识；发送接口尚未返回时的点击也能在校验机器人、会话和操作者后绑定消息。建议卡片等待回答投递，不再依赖四秒定时器抢发。`lark-asks.ts`、`lark-actions.ts`、`lark-bot.ts`、`lark-send.ts`。
- 规则变更发出实时事件，网页更新列表和未编辑的详情，不覆盖正在修改的表单。`rules/store.ts`、`Rules.vue`。回归：`test/rule-confirmation.test.ts`，真实 Codex 在隔离库验证保存与启用。

## 飞书选项卡片布局（11-04）

- `src/channels/lark-asks.ts` 按选项文字长度排版：两个短选项保持并排，更多短选项每行最多两个，长选项独立成行，用可换行的文字展示完整内容，旁边保留简短的“选择”（下一步建议为“继续”）按钮。“用文字回答”放在输入框后，不挤入选项行。选项编号、表单附言和回调动作保持对应；`test/asks.test.ts` 覆盖长短混排、六个长选项、文字回答和批准/拒绝。

## ID 优先搜索（11-04）

- 全局搜索和运行页直接识别裸 id，先按索引查精确命中并显示，加载状态持续到其余文本或向量搜索结束；运行页沿用筛选，追加时去重，分页偏移按文本结果计算。新查询立即使旧响应失效。入口：`src/core/id-query.ts`、`src/agents/runs.ts`、`src/server/http.ts`、`CommandPalette.vue`、`Runs.vue`；浏览器回归：`scripts/check-id-search.ts`，规模对比：`scripts/bench-scale.ts --runs`。

## 飞书回答尾注（11-04）

- 回答底部的“运行”改成 `id`，后面直接列出本次运行记录中的后端、模型、思考强度（如 `id r… · codex · gpt-6.1-sol · low`）；兜底后读取更新的 AI，未指定模型或强度标“默认模型”或“默认强度”，无 AI 记录只显示 id。普通回答、进度卡片、访客和后续投递共用，整行粘到 `Ctrl K` 仍能打开运行。入口：`src/channels/lark-bot.ts`、`lark-progress.ts`、`src/core/lookup.ts`。

## 网页组合输入保护（11-04）

- `web/src/lib/composition.ts` 统一隔离输入法组合期间的键盘事件，并取消确认回车引起的隐式表单提交；主站和英语插件的 Vue 入口共用。原生 input / textarea、父级键盘处理、Teleport 弹窗与下拉筛选、全局快捷键都受保护，保留输入法选词的默认行为。`scripts/check-composition.ts` 用真实 Vue 控件和浏览器回归，操作系统输入法另需手动验收。

## 中断的 Git 操作续轮（11-03）

- `code-sync.ts` 在 merge / rebase 之外识别 cherry-pick / revert 及其 sequencer；`placeOnBranch` 保留现场，`syncWorktree` 先解决并继续未完成的操作再暂存与同步，`code.ts` 让失败重试和无需拉取的续轮也进入恢复。多提交序列和空提交不再卡住，冲突仍未解决时保留现场。`test/code-sync.test.ts` 覆盖工作区入口、后续提交、空提交、revert 和 ACP 端到端恢复。

## 飞书文档编辑审批（11-03）

- `lark_doc_update` 首次用 `approval_docs` 列出本次所有待改文档、`summary` 说明整体改动；宿主核对文档实际对象后记在审批上下文，按本人和文档实际对象复用追加、局部替换和失败重试的批准，跨轮次、会话及旧版批准记录均兼容；最近的拒绝仍拦截；新文档、整篇覆盖、移动和新建不借用局部编辑授权。`lark-doc-approval.ts` 管范围匹配和去标签预览，`test/lark-wiki.test.ts` 覆盖拒绝、重复待批、失败重试与续轮边界。卡片不再直接显示 XML 标签；新建文档也可传摘要。

## 需求切换性能（11-03）

- `src/items/work.ts` 批量读取交办轮次和评审状态，只取列表摘要，避免逐轮解析完整补丁和检查输出。`Requirements.vue` 在普通需求切换时立即显示新标题和加载骨架；同一编码内切换需求点保留面板。`test/req-work-summary.test.ts` 覆盖大结果、查询数量、旧工作区字段和跨轮应用状态；`scripts/bench-scale.ts --requirements` 提供可复现的规模基准。

## 对话投递、引用与编码接续（11-03）

- `roles/_common.md` 与原件工具说明明确：工作文件、确认表内的代码锚点优先引用库内原件并核对版本、行号；不能从 Git remote、提交号或其他平台的路径规则猜造代码网页地址。

- 确认卡片和建议触发的后续回答回到原渠道；卡片回答与普通消息合并时只投递一次（`agents/inbox.ts`、`jobs.ts`、`channels/common.ts`）。
- 文档引用按完整 Markdown 块高亮，表格、列表与代码块不会从引用行被切断（`web/src/lib/cited-document.ts`、`CitationDrawer.vue`）。
- 连续三次验证失败、裁决未交付先交给发起助手；`settle_code_task` 的 retry 可附 `existing_authorization` 说明原需求或已有授权，后台接续也能恢复，新的业务决定仍问本人。编码确认卡片先显示问题和按钮，完整技术记录默认折叠（`code-tasks.ts`、`code-loop.ts`、`tools.ts`、`channels/lark-asks.ts`）。
