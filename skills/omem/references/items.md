# 事项与通知（items）

## 事项

- `list_items` / `read_item` / `upsert_item`：待办、等待回复、提醒、关注、待决定。时间用带时区的 ISO 格式。
- `list_items(space: "*")` 在本次可发现空间内查已有事项，查询在分页前限定空间；`read_item(item_id)` 返回完整事项、时间线和材料。
- 一个需求这类要反复回来看的事，用 `upsert_item` 的 `materials_add`（`kind`：source 原件 / conversation 会话 / repo 仓库加 `branch` / space 空间 / run 运行，可写 `note`）把文档、群聊、分支和要对照的仓库挂上，`materials_remove` 移除；只改材料不会动事项本身。
- 事项会自己收尾：一段时间没有新进展会变成 `expired`（`list_items` 的 active 不含它）。新材料和一件已过期的事项有关时用 `list_items(status: "expired")` 找到它再 `upsert_item` 记进展，它会重新打开，不要另建；不用为了“一直没动静”去关事项。
- 后台 ingest 的事项发现可覆盖本人可访问空间，普通原件检索与写权限仍保持原范围。

## 来源

- `upsert_item.source_refs` 默认增量合并。纠正用 `source_refs_mode: "replace" | "remove"`，必须指定 `id`、`note`、非空 `source_refs` 和重读得到的完整 `expected_source_refs`。`[]` 不清空；清空必须逐条 remove。
- replace 校验来源存在、行号与可读空间，remove 只撤回该事项原有来源，允许撤回已删除的来源。所有写入还检查用户身份和空间写权限；纠正前后都保留在事件中。

## 跨空间的进展

- `propose_item_update(item_id, note, source_refs)`：只读发现另一个空间已有同一具体事项时路由进展，目标事项保持不变；相同未决提案复用。不能因为只读就挂到另一个宽泛旧事项。
- 主助手 `list_item_proposals` 查看、阅读两边材料，再 `resolve_item_proposal(proposal_id, action: "apply" | "reject", reason)`，需要来源空间和目标空间写权限。

## 通知

- `notify(title, body, entity: "item", entity_id, source_refs?, event_id?)`：本次变化的来源快照，事件必须属于指定事项；省略来源时用最近事件，绝不取全部历史引用。来源校验权限，通知接收者是本次用户。
- 定时提醒取设定提醒时仍有效可读的来源，失效引用只留历史，不阻断其他提醒。飞书原文在整张卡片（正文与来源区）内按最终 URL 去重，不按条数截断。
- `ignore_notification_rule`：本人引用或回复某条通知说“这类不用提醒我”时记一条免提醒规则；只静默飞书推送，应用内通知仍保留。不要拿一次性事件当通用规则。

## 修复（仅本人主助手）

- `repair_item_association` 默认预览，参数为 `from_item_id`、`to_item_id`、`event_ids`、`source_refs`、`expected_source_refs`、`run_id`、`reason`，可带 `notification_id` / `interaction_id`，多条通知 / 卡片用 `notification_ids` / `interaction_ids` 一起修复（带通知时必须给修正后的 `title/body`），核对后传 `apply: true`。
- 它精确移动事件、保留未迁移事件共用的来源（预览 / 审计列出 retainedSourceRefs 与 removedSourceRefs）、撤回其余错误引用、修正通知和交互 payload、给原运行加纠正标注；保留审计快照，原卡片停用，不发消息。
- `inspect_item_notification(notification_id)` 在修复前读取通知及全部交互记录，`read_item_repair(repair_id)` 查看审计。
- 本人要求修复原飞书卡片时 `refresh_item_notification(interaction_id, reason)` 更新原消息；卡片与 payload 使用同一事项，失败保持失效可重试，需要本次飞书会话权限。
