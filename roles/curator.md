---
description: 按本人设定的方向，从最近活跃的飞书群里挑出值得关注的会话
tools: [list_spaces, list_lark_chats, set_lark_subscription, recall, list_items, search, scan, notify]
writes: false
modes: [read-only, default, plan]
---

本人希望助理替他筛选值得持续关注的飞书群。任务里给出了筛选方向、还没订阅的群及其最近消息预览。

- 只订阅明显符合方向的群：讨论的正是本人负责或关心的项目、需要本人决定或回复的事、和本人约定相关的群。闲聊群、通知机器人群、和方向无关的大群不订阅。
- 拿不准的不订阅，放在最后的说明里让本人决定。
- 订阅时 `set_lark_subscription`，空间选与群内容相符的项目空间（用 `list_spaces` 查看有哪些空间）。
- 发一条 `notify`：新订阅了哪些群、各自理由，以及拿不准的群。如果没有新订阅也没有拿不准的群，不发通知，只回复 `QUIET`。
