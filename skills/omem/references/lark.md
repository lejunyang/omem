# 飞书（lark）

发飞书消息的 `lark_*` 工具和以本人身份写飞书文档的 `lark_doc_*` 只在 omem 自己的运行里可用（外部调用会被拒绝），能发的会话由本次运行限定；草稿模式下回复先变成给本人的确认卡片。

## 消息与卡片

- `lark_send` / `lark_card` / `lark_update_card` / `lark_react` / `lark_send_file`：发消息、卡片、更新卡片、表情回应、发文件。自己生成的文件（表格、压缩包、图片）用 `lark_send_file` 作为附件发出。
- `lark_card` 带按钮或表单、又用 `allowed` 限定了处理人时，发在群里会在卡片开头 @ 这些人（只 @ 机器人认识的 id；给了 `mentions` 就只按 `mentions`），不用自己再拼 @。表单每个字段的 `label` 写成要问的话：显示成字段上方的一行粗体，几个问题时自动编号。
- `mentions` 可填姓名、邮箱、已核实的机器人应用侧 open_id/user_id 或 all。普通姓名按授权目标群的完整成员列表核对，群内重名拒绝；确认不在群内的普通 mentions 自动跳过，正文和其他人的提醒继续发送，回执说明跳过对象，不需重发或在群内解释。权限或分页错误不算缺席，urgent / only_to 不静默降级；邮箱查不到时，可改用明确的群成员姓名，不把邮箱记录按姓名强行合并。@ 机器人需用本应用已收到的 @ 中的身份，不能用 app_id 或采集应用的 open_id。
- 发送前会转换 Markdown 里的引用：文档链到原文，飞书聊天行和来自飞书的消息链到飞书里那条消息；代码、工作文件、记忆、Wiki 在配置了网页地址时变成只读分享链接，否则省略。属于句子的引用保留文字，句末的变成 ①② 链接。沿用 omem 引用格式即可，不用自行拼跳转地址或分享链接。
- `meeting_send`：旁听会议的运行里，以机器人身份往会中聊天发一句话（所有参会人可见）。只在规则允许“回答会中提问”、有人点名问机器人时可用；其余时候需要本人注意的事用 `notify` 告诉本人，不在会里说。
- `set_chat_watch`：盯一个飞书群，之后群里的消息按批交给主助手或更合适的档案。本人说“帮我盯一下这个群”时用；长期分工（报警群交给告警档案）也用它。

## 飞书文档

- `lark_doc_create` / `lark_doc_update` / `lark_doc_move` / `lark_doc_copy`：以本人身份写飞书文档，只在本人要求时用。完整复制知识库文档用 `lark_doc_copy(doc, target, summary, title?)`，调用官方节点复制，保留表格、图片和排版，不把正文重建成新文档，也不递归复制子页面；成功后回读返回的新节点核对，状态不明先查远端。做法和 DocxXML / Markdown 写法在内置技能 `lark-docs`。
- 本人希望某个目录一次审批时，`lark_doc_authorize(under, operations, summary)`：`under` 填本人指定的知识库节点链接，`operations` 从 `create`（新建）、`copy`（复制到范围内）、`edit`（局部编辑）、`move`（范围内移动）中选。卡片说明节点、操作和用途，发到本人机器人私聊；批准后包含节点自身、全部后代和以后新建的子页面，跨会话、定时规则和失败重试复用。执行时按飞书当前层级核对，不按标题或本地旧目录推断；移动须来源和目标都在范围内。整篇覆盖、范围外写入另行批准；最近的拒绝阻止沿用旧授权。申请不执行文档写入，批准后照常调用具体工具。
- 改已有文档：先 `lark_doc_fetch` 读要改的部分（`scope=outline` 看目录、`section` 读一节、`keyword` 按关键词、`range` 读整张表），拿到 block id；再用 `lark_doc_update` 的 `str_replace`（行内文字）、`block_replace`（一块或同层连续几块，含整张表格）、`block_insert_after`、`block_delete`、`block_move_after`、`block_copy_insert_after` 局部改。`block_*` 的内容默认 DocxXML，其余默认 Markdown；每次写入后旧 block id 可能失效，再改前重读。`overwrite` 会丢掉图片、评论等，只在本人要整篇重写时用。块操作和追加、局部替换同属“局部编辑”，沿用同一份批准。
- 共享文档的编辑也可按文档复用批准：首次 `lark_doc_update` 用 `approval_docs` 列出本次全部待编辑文档，`summary` 写一两句整体改动（不贴正文或 HTML/XML）。一次批准后，这些文档在后续任务和对话中的追加、局部替换和失败重试不重复问，兼容旧版已批准的编辑记录；单篇可不填 `approval_docs`。不在节点授权内的其他文档、新建、复制和移动，以及整篇覆盖要重新批准；实际写入仍须本人发起。文档写入的批准卡统一发到本人机器人私聊，回答和执行结果仍回到原任务。卡片列出文档和摘要，旧调用没有摘要时使用去标签的正文预览；`lark_doc_create` 也支持 `summary`。等审批时用 `wait_answer`，同一待批范围不会再发卡片；提示“当前这处编辑尚未执行”时，批准后再调用那处编辑。
- 其他飞书数据：`lark_read(command)` 以本人身份跑 lark-cli 标为 read 的命令（表格、多维表格、幻灯片、云空间和评论、Markdown 文件、知识库、任务、日历、邮件、聊天记录、会议与妙记、通讯录、OKR、审批），`["skills","read","lark-sheets"]`、`["schema", …]`、`["<域>","--help"]` 读官方说明。`lark_write(command, target, summary)` 只放行 sheets、base、slides、markdown、task 的 write 命令和 drive 的评论命令：本人自己的文件直接写，别人的文件和任务先请本人批准（按文件复用，首次可用 `approval_targets` 列全），命令里改的必须是 `target`；high-risk-write、`--as`、`--yes`、`api` 都不放行。做法在内置技能 `lark-suite`。
- 替成员（不是本人）用这些工具时：他在 omem 账号页关掉的功能，对应的调用会被拒绝并说明（例如关了「我的消息」就读不了聊天）。照实告诉他，让他在账号页打开，不要换别的办法绕过。
- 读文档用 `import_url`（可给 `depth`）；整个知识库用 `lark_wiki_crawl`（start / continue / stop / status，可分批）。

## 能看到的知识库（kb-scout）

omem 每周列出本人能看到的全部飞书知识库，交给 kb-scout 角色提归属建议；只有它能用 `propose_knowledge_mapping`，kb 填任务里列出的 id：

- `map` + `space`：归入已有空间（不能是代码仓库空间）。
- `create` + `new_space`（id 用小写字母、数字和连字符，name，kind 为 project / topic / learning，description 一句话）：新建空间。同一领域的几个知识库用同一个新空间（同 id、同名称）；id 被别的空间占了会被拒绝。
- `ignore` 不读；`later` 先放着，方向变了以后再问。
- `priority`（high / normal / low）决定每晚读的份额（3:2:1），`level`（focus / normal / reference）写在目标空间的知识库目录上，读进来的页面都按这一档，reference 的只检索、不整理。
- `reason` 写依据：方向里的哪一点、目录里的哪些标题。

本人开了“建议直接生效”时调用即生效（新建空间、开始每晚读取），否则等本人在原件 → 知识库确认。本人已经定过的知识库不能再提。只看名称、简介和目录标题判断，不读文档内容。

## 采集设置

`list_lark_chats` 列出会话；`set_lark_subscription`、`set_lark_capture_policy`、`set_lark_backfill` 会改本人的飞书采集设置，只在本人明确要求时用。

## 历史回溯

- 飞书历史回溯按固定窗口和远端页令牌续读，整页消息 ID 已知不代表完成。用 `set_lark_backfill` 只重排本人授权的具体群和天数。
- 回溯在独立后台循环里按 `pages_per_minute`（所有会话合计，默认 20）和 `concurrency`（默认 2）推进，被限流自动退避；出错的会话按 30 秒翻倍（最长 1 小时）再试，本人不在群里或没有权限的会话不再重试并在进度里列出，本人要求时重新回溯即可。
- 本人嫌慢时调这两个值（只调速度可不传 `chat_ids`），不要自己写脚本调 lark-cli 抓历史；不清除其他队列、不直接写库修复游标；旧队列会按原目标重新核验。状态 `pending=false` 以主列表及话题耗尽证据为准，实际最早消息时间不是完整覆盖证明。

## 附件

- 消息里的附件（别人发来的 CSV、表格、图片）用 `lark_message_file(message_id, file_key?)`：采集时已经存成原件的直接给原件 id，没下载过的先下载并存进这个群的空间，再用 `read_source` 读。不要用 `lark_read` 跑 `im +messages-resources-download`（它写本地文件，被当作写入；`lark_read` 遇到它也会改走这里）。视频和音频只保存文件，omem 不转写、不抽帧，读不到内容。

- 附件保存与解析分别验收：`set_lark_backfill` 的 `ingest=true` 会把已保存的文档附件交给独立 `lark-resource-parse` 运行，解析失败不阻塞消息翻页；通过 `list_runs` / `read_run` 核对解析状态，原文件已保存不能说成下载失败。重试解析使用原文件，不重置消息回溯。
- 视频本体是必需资源，封面可选；正文中的外链图片副本不计入原群附件缺失。
- 消息覆盖、原文件保存、解析和知识整理分别报告；已经提交的批次由后台继续，不为等待分页反复交办。
