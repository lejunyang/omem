# 原件、检索与材料（sources）

## 空间

- `list_spaces`：空间（领域）列表和空间之间的关联。默认空间是当前目录所在的仓库空间（`omem mcp` / `omem tool` 在仓库里启动时），否则是 `personal`。
- 不传 `space` 时 `search`、`scan`、`find_symbol` 会连同默认空间的相关空间一起查，结果里标出命中所在空间；传 `space` 只查那一个，`"*"` 搜全部。
- `relate_spaces`：记下两个空间之间的关联（一个仓库调用另一个的接口、共用 SDK、同一项目），note 写清关系。本人移除过的关联不能再加。读过依据后判断两者无关（做梦里的关联候选），用 `decline: true`，note 写原因：同一类依据以后不再列为候选，出现新的一类才会再列。
- `create_space` / `connect_repository`：建空间、把代码仓库接成空间，只在本人要求时做。同一仓库（git remote 相同）已有空间时 `connect_repository` 返回那个空间而不新建，改关联到新目录要 `relink: true`。仓库属于某个业务时传 `parent`（业务空间 id）：它挂到业务空间下，在业务空间里检索、交办、评审都包括它；已接入的仓库再调一次带 `parent` 就是归过去，`parent: ""` 是移出。`list_spaces` 把仓库缩进列在业务空间下面。

## 检索与阅读

- `search`：检索原件片段、Wiki 页面、记忆。结果是线索，需要细节就用 `read_source`（带行号）或 `read_page`。换几种说法（中英文、同义词、标识符）多查几次。“另有 N 份相同内容”是正文完全相同的其他原件，“同一个聊天或文档另有 N 处”是同一个群或文档在别的空间的副本（别人采集的、镜像来的）；都引用排在前面的那份即可。
- 合并过的重复原件（同一篇飞书文档的 docx / wiki 两份）旧 id 仍然能读，`read_source` 返回留下的那份；引用时用返回的新 id。
- `scan`：汇总类问题（“这个月提到过几次…”）先穷举所有命中行再计数，可按时间段。
- `source_outline` / `find_symbol`：看文档章节或代码符号，找定义与调用方。
- 查代码仓库某个分支上的代码：`search` / `find_symbol` 传 `branch`（`space` 填仓库空间），分支改过、删过的文件按分支上的版本，其余按仓库；`list_branches(space)` 列分支和已建索引的分支。
- 写代码依据（含工作文件和确认表）时，用 `read_source` 返回的 `src:<id>#L起-L止`，先核对分支版本和行号。已有代码原件不换成外部网页；没找到原件先写“仓库 · 路径:行号”，不要从 Git remote 或提交号拼猜 `/blob/` 地址。
- `list_conversations` / `read_conversation`：查以前在某个群、私聊或网页对话里说过什么。飞书聊天原件每行是 `[时间] 发送人: 内容`，回复别人时带 `↩ 回复 X「…」`。
- 聊天消息和记忆不是普通原件：`read_source("msg:<消息id>")` 读消息（记忆来源里的 msg 引用用它，不要因为在原件表查不到就判定来源失效），`read_source("mem:<记忆id>")` 读记忆。
- 其他 omem 服务共享给这台的空间（设置 → 设备里订阅）：`peer_search` 现场检索对方，结果标着来自哪一台；要引用其中的原件，先 `peer_read(peer, source)` 取到本机（放进只读的镜像空间），再用 `read_source` 读、按本机的 `src:<id>` 引用。不要直接写对方的 id。对方不在线时结果里会说明，照实告诉用户。镜像空间只读，不往里写。

## 关注程度与标注

原件有关注程度（重点 / 一般 / 仅检索 / 忽略）和行标注（已过时 / 有误 / 关键）：检索结果和 `read_source` 会带上，过时段落以标注写的为准。`set_source_attention`、`annotate_source` 可以改，本人定的不会被改；`attention_rules` 管理按条件批量定关注程度的规则。

- **目录**：`list_sources()` 列出空间的顶层目录（知识库 `wiki:<id>`、云文档 `lark-drive`、聊天 `chat:group` / `chat:p2p`…、网站 `site:<域名>`、会议 `kind:meeting`），`list_sources(under=<节点 key>, depth)` 往下看，每行带节点 key、份数和各档数量；知识库节点是 `wn:<token>`，一个会话是 `chat:<会话id>`。`search(under=…)` 只在这个目录里查。
- **标注**：`annotate_source(source, kind, quote | from/to, note, ref)`，kind 多一个 `exclude`（不检索：测试数据、粘贴的日志、无关段落）。位置优先给 `quote`（照抄段落开头），文档改版后能找回；过时和有误的 `ref` 写到行，检索命中时会附上那几行。你写的标注先按一半强度影响排序，本人确认后才完全生效；本人否定过的同一条不能再加。读到“原文已改动”的标注，位置可能不对，按原文判断。
- **先按目录定，再挑例外**：整个知识库、目录或群是同一档时 `set_source_attention(under=<节点 key>, space, level, reason)`，子树连同以后进来的都按这一档；单份自己定过的档不受目录影响（本人的目录档会压过 Agent 给单份定的档）。和目录不同的几份再用 `ids` 单独设。本人定过或否定过的目录档改不了。

## 保存与整理材料

- `import_url`：保存网页或飞书文档；读飞书文档时可给 `depth`（链接和知识库子页面往下几层），整个知识库用 `lark_wiki_crawl`（见 lark 分组）。
- `save_note`：把本人明确要求保存的内容存为笔记原件，之后可检索和引用。
- `write_file(path, content, mode?, expires?, item?, rule?)`：写工作文件（原件 `work/<path>`）——长任务的当前成果、定时任务逐天累积的周报素材。`mode: "append"` 追加；`expires` 设过期（`30d`、日期，`never` 永久）；`item` / `rule` 挂到事项或规则上。放在哪个空间：给了 `space` 放那里；挂事项时放事项所在空间；在本人个人空间里为某个业务空间的事项、会话、绑定的群或规则工作时，自动放进那个业务空间（结果里会说明）；要留在个人空间就明确写 `space`。解决过的问题写成案例页：`write_page(kind: "case", page: "cases/<主题>")`。
- `digest_sources` 整理存量材料：`parallel`（同时几批）、`batch`（每批几份）、`chars`（精读每批附多少字正文）；`after`（等另一个整理任务做完再开始，如先分级再精读）；`action: "pace"` 调整已有任务。

## 原件归档

- 原件归档优先用设置与规则，不确定的仍留在个人空间；不创建“待归档”空间。规则与历史预览在网页 `#/rules/archive` 管理，归属修正在原件详情。迁移保留 ID 和引用，目标重复时拒绝覆盖。
- `classify_source(source_id, hash, space, reason)` 只开放给内置 `archivist` 运行，只处理本次清单内、仍待判断且版本一致的原件，同时校验源和目标空间权限，不能覆盖手动指定或当前规则。
- `classify_source` 的 `verdict`：`business`（归到业务空间）、`personal`（确实个人，留下）、`unsure`（判断不了，留下，`candidates` 写可能的空间，本人在网页“从个人空间归位”里定）。任务里每份原件的 `evidence` 是宿主查到的旁证（知识库位置与归入的空间、同目录文档去向、引用它的其他空间、贴过它的群、关注程度、工作文件的事项），`again` 是重新判断的原因。自动移动关闭（`archive.autoMove`）时归到业务空间的判断只记成建议。
- 留在个人空间的原件出现新旁证（被业务页面 / 事项 / 记忆引用、同目录文档已归档、知识库归入空间）或空间、归档规则有变化时，每晚检查会再交给 archivist；本人移回或指定过的不再自动移动。业务页面引用的原件读者能不能打开，用 `GET /api/spaces/<空间>/citation-reach` 查。
- `propose_archive_rule(name, description, target, enabled, conditions)` 只开放给 `archive-rule-writer`，结果为本次运行中的草稿，不保存或启用。外部客户端和主助手不能冒充内部角色调用。条件组合用 all / any / not，不执行模型生成的程序。
- 归档条件的 kind 使用 doc（文档）、chat、note、web、image、event、meeting；equals / in 不接受未知类型，文档不能写成 document。
- 归档条件使用类型、标题、正文、网址 / 路径、采集渠道及中文知识库 / 目录名称。`meta.wikiSpaceName` 是知识库名，`meta.wikiParentTitle` 是直接父目录名，`meta.wikiPath` 是不含当前文档标题的祖先目录路径。目录下任意层级用路径包含目录名；不支持会话 ID、知识库 ID、节点 token、作者或父页面地址。缺失字段的排除条件也不会命中。
