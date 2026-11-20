# 事项与通知（items）

## 事项

- `list_items` / `read_item` / `upsert_item`：待办、等待回复、提醒、关注、待决定、工作线（`kind: "line"`）。时间用带时区的 ISO 格式。
- 工作线是本人这几周在推进的一件事（“示例商城 · 退款改造”）。需求、缺陷、评审挂在它下面，缺陷也可以挂在它的需求下面，最多三层：`upsert_item` 传 `parent`（上层事项的 id，`null` 移出），只能挂到本人自己的事项下，不能成环。工作线只由本人建（本人这一轮亲口要的，或在每晚提议的卡片上点了“建”）；后台运行传 `kind: "line"` 会被拒绝。
- `list_items` 每件写出“上层”和“下面几件在办”，`parent` 只列挂在某件下面的；`read_item` 带 `parent`、`children`，工作线另有 `now`（“截至今天”一句、人和角色、最近几周）和还没定的下一步 `next`。挂在线下的事项不单独建关注：它的群收进线的关注，问这件事的进展看线的关注。
- 两个只给特定运行交结果的工具（不随分组授出）：`submit_line_state` 给每天看一条线的运行，交一句“截至今天……”（120 字内）、人和角色（`people`，最多 8 个，不写本人）、最近几周各一句（`weeks`：本周·至今N天 / 上周 / 2周前 / 3周前）、最多三条下一步（`next`：`text`、`why`、`refs`、`kind` 为 read / test / code / ask / data），宿主存到线上，下一步放进本人每天一张的下一步卡片，交完不用再通知本人。可选的 `phase` 说这条线到了哪一段：`state` 为 active / watching（做完了、上线后还要看一阵，可带 `days`）/ done / cancelled，`reason` 一句依据，`refs`，`confidence` 0 到 1；宿主只在把握够时动（观察 0.6，结束 0.8 且有依据、线下没有没结的事），拿不准的问本人一次，没把握就不填。观察中的线下一步只写上线后的事。线结束后宿主排一轮收尾，那一轮交 `summary`（做成了什么、关键决定、上线后数字怎么样、还剩什么），`next` 不填；`propose_lines` 给每晚的近况整理（work-state），交这几周在推进的线（名字、目标、事项、群、文档），对得上已有线的宿主直接补，新的由宿主发卡片问本人。
- `list_items(space: "*")` 在本次可发现空间内查已有事项，查询在分页前限定空间；`read_item(item_id)` 返回一件事的全貌：完整事项、时间线、材料、工作文件、`places`（它在哪些会话和群里进行，每处最近的一句话或摘要）和 `runs`（碰过它、或在它的会话里正在进行的运行）。
- 一个需求这类要反复回来看的事，用 `upsert_item` 的 `materials_add`（`kind`：source 原件 / conversation 会话 / repo 仓库加 `branch` / space 空间 / run 运行 / req 需求点，可写 `note`）把文档、群聊、分支、要对照的仓库和这次要做的需求点挂上，`materials_remove` 移除；只改材料不会动事项本身。
- 会话和群聊材料就是“这件事在哪里进行”：运行用 `upsert_item` 写了事项，宿主自动把它关联到这次运行所在的会话或群（结果里会说关联到了哪里）；同一件事在别的会话里也在谈，用 `materials_add`（`conversation` 或群聊原件 `source`）关联过去，不是同一件事用 `materials_remove` 取消。任务后面的“可能是同一件事的在办事项”是宿主按引用、链接或单号、人和共同的词猜的，读过确认再关联。
- 事项会自己收尾：一段时间没有新进展会变成 `expired`（`list_items` 的 active 不含它）。工作线和显示成线的顶层事项不过期：它们先进入观察，观察期满没有新问题由宿主结束（`read_item` 里 `item.phase`、`item.watchUntil`；结束后的收尾小结在 `item.now.summary`）。新材料和一件已过期的事项有关时用 `list_items(status: "expired")` 找到它再 `upsert_item` 记进展，它会重新打开，不要另建；不用为了“一直没动静”去关事项。
- 后台 ingest 的事项发现可覆盖本人可访问空间，普通原件检索与写权限仍保持原范围。

### 不是本人这一轮要的新事项：`why` 和候选

- 整理、巡检、简报、有人找你、规则、唤醒后的轮次这类运行新建事项时，`upsert_item` 必须带 `why`：一句话说本人为什么会要它——本人自己说过要做、要跟、要等的话（带 `src:…#L…` 或 `msg:…`，引用照 `source_refs` 校验），或它属于本人的哪个「关注」（写关注的名字），或它服务本人近况（`state/work`）里的哪条线。没写就被退回；“可能有用”“留意一下”不算理由，说不出来就不建。本人自己这一轮要的、本人批准过的调用、本人自己的工具不用写。
- 宿主再过一次决策模型（设置 → AI → 决策 的“自动建事项”，把握不到门槛就保守处理）；没有决策模型时只有引用了本人原话或点名关注的直接建。没过的建成 `candidate`（候选）：不提醒、不进 `list_items` 的 active、巡检和简报的材料，也不会过期；结果里会写明是候选，给本人的话里不要说“已建事项、到时提醒”。
- 候选由本人在 9:30 的事项清点卡或事项页上点“留下”（变成打开，提醒时间照旧）或“不要”（取消），三天没答自动放下。`list_items(status: "candidate")` 能看到；同名的候选不会再建一件，本人两周内不要过的同名事项也不会再建；后台运行可以给候选记进展，不能改它的状态。
- 本人对自动建的事项的每次取舍（候选留下 / 不要 / 没答、忽略或取消、标完成、一直没动而过期）都记下来，建事项的后台运行在任务里会读到“本人最近对你自动建的事项的取舍”：照着判断，同类被本人不要过的不再建。

## 需求树

业务空间里“系统应该做什么”的长期记录（docs/v2/requirements.md）：系统 → 模块 → 页面 → 功能（需求点），功能下挂测试点。交办和评审按事项挂的需求点开发、核对。

- `req_tree(space, under?, tests?)` 看树，每个节点有固定 id；`req_read(id)` 看需求、验收、测试点、关联、时间线和最近一次评审的状态。`search(scope: "requirements")` 只查需求点。
- `save_requirements(ops)`：一批操作原子执行。`add` 用 `key` 起名，同批后面用 `$key` 当 parent；`edit` / `delete` 必须选 `change`：`correct`（写错了，没有业务含义）或 `change`（业务规则变了，写 `reason`，带 `source_refs`）。不要为了改规则删掉重建：用 edit + change，历史才连得上。
- 跨业务的需求用 `link`（另一个空间的需求点 id，`note` 写关系），不要复制一份。
- Agent 写的节点待本人确认；本人说“确认”时让本人在需求页点，或本人在网页上改。
- `split_requirements(item_id, note?)`：让拆需求的角色（`req-splitter`，本人可在 Agent 页改说明、模型和挂的技能）读事项的材料拆进树里，后台运行；拆完它改动的最上层节点自动挂到事项上。先用 `upsert_item` 把需求文档、讨论挂好。

## 来源

- `upsert_item.source_refs` 默认增量合并。纠正用 `source_refs_mode: "replace" | "remove"`，必须指定 `id`、`note`、非空 `source_refs` 和重读得到的完整 `expected_source_refs`。`[]` 不清空；清空必须逐条 remove。
- replace 校验来源存在、行号与可读空间，remove 只撤回该事项原有来源，允许撤回已删除的来源。所有写入还检查用户身份和空间写权限；纠正前后都保留在事件中。

## 跨空间的进展

- `propose_item_update(item_id, note, source_refs)`：只读发现另一个空间已有同一具体事项时路由进展，目标事项保持不变；相同未决提案复用。不能因为只读就挂到另一个宽泛旧事项。
- 主助手 `list_item_proposals` 查看、阅读两边材料，再 `resolve_item_proposal(proposal_id, action: "apply" | "reject", reason)`，需要来源空间和目标空间写权限。

## 通知

- `notify(title, body, entity: "item", entity_id, source_refs?, event_id?)`：本次变化的来源快照，事件必须属于指定事项；省略来源时用最近事件，绝不取全部历史引用。来源校验权限，通知接收者是本次用户。
- 同一批聊天消息（`source_refs` 指向的那几行）6 小时内已经提醒过本人时，`notify` 拒绝（409）并给出那条通知的 id：不要换个说法再发；查到了新东西就用 `replaces` 更新那一条。定时提醒（事项的 remind_at）不受这条限制。
- `notify(…, replaces)`：同一件事有了新状态（授权完成、等待结束），传之前那条通知的 id（发通知时返回），飞书里改原卡片而不是再发一条；原通知标为已读。之前那条没发到飞书（夜间暂缓）时照常发新卡片。
- `notify(…, tone)`：要本人去做的事（授权、登录、审批）传 `tone: "warning"`，飞书卡片是橙色；办好后用 `replaces` 更新那条并传 `tone: "done"`，卡片变绿色。普通通知不传。
- 定时提醒取设定提醒时仍有效可读的来源，失效引用只留历史，不阻断其他提醒。飞书原文在整张卡片（正文与来源区）内按最终 URL 去重，不按条数截断。
- 后台运行（唤醒、盯群、规则、有人找你、巡检）调用 `notify`、`lark_send`、`lark_card`、`reply_to_asker` 或交出最终回答之前，本人在它的范围里说过话（同一个群或话题、回复了触发它的消息、在别的会话里谈了它碰过的事项），或引用的消息本人已经看过，这次不发出，宿主把本人的话交回：还要说就改写后再发，本人已经处理了就 `stay_quiet`。每次运行只拦一次。运行中本人说的话也会附在下一次工具结果后面（“本人刚说了”）。
- `ignore_notification_rule`：本人引用或回复某条通知说“这类不用提醒我”时记一条免提醒规则；只静默飞书推送，应用内通知仍保留。不要拿一次性事件当通用规则。

## 修复（仅本人主助手）

- `repair_item_association` 默认预览，参数为 `from_item_id`、`to_item_id`、`event_ids`、`source_refs`、`expected_source_refs`、`run_id`、`reason`，可带 `notification_id` / `interaction_id`，多条通知 / 卡片用 `notification_ids` / `interaction_ids` 一起修复（带通知时必须给修正后的 `title/body`），核对后传 `apply: true`。
- 它精确移动事件、保留未迁移事件共用的来源（预览 / 审计列出 retainedSourceRefs 与 removedSourceRefs）、撤回其余错误引用、修正通知和交互 payload、给原运行加纠正标注；保留审计快照，原卡片停用，不发消息。
- `inspect_item_notification(notification_id)` 在修复前读取通知及全部交互记录，`read_item_repair(repair_id)` 查看审计。
- 本人要求修复原飞书卡片时 `refresh_item_notification(interaction_id, reason)` 更新原消息；卡片与 payload 使用同一事项，失败保持失效可重试，需要本次飞书会话权限。

- `notify(urgency="later")`：不需要本人现在做什么的进展或结果（后台的事做完了、你替他查清的结论、一条供了解的变化），不单独推送，和别的攒到固定时点一起发；要本人处理、决定、回复的不用 later。默认 09:30、13:30、18:30（本人设置的时区），超过两条合成清单；本人在设置 → 渠道可调整，清空后新通知立即发。通知先出现在网页；不要为同一结果再发一条 normal。
