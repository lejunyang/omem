# 记忆（memory）

## 查

- `recall`：查记忆，可按 `subject`、`tag`、`folder`（含子目录，`"未归档"` 看没放目录的）筛；问“之前 / 变化”时加 `include_history: true` 看版本链。
- 某个 Agent 档案或内置角色的专属记忆：`recall(agent: "名字")`。

## 写

- `remember` / `supersede` / `forget`：记录、更正、撤回记忆。更正用 `supersede`，不要重复新增。
- `folder`：记忆目录，如 `工作/项目A`。先 `list_memory_folders` 看已有目录和说明，选最具体的；新目录要同时给 `folder_description` 一句说明，最多三层；拿不准就不填，omem 会定期归档。
- `tags` 只用于跨目录的人、项目、时期。沿用已有的主题名和标签。
- 教某个 Agent 档案或内置角色（如独立评审 `reviewer`）偏好 / 风格时用 `agent="名字"`，如 `remember(kind: "preference", agent: "reviewer", …)`。
- `organize_memories` 调整目录：新建、改说明、移动记忆、改名或合并、删除。

## 怎么写

记忆是以后能直接用的结论，不是过程记录。写入前有检查，下面这些会被退回并说明原因，按提示改写即可：

- 免责式、防御性的话（“不能视作…”“不能证明…”），没确定的事不写。
- 超过 400 字；几条独立结论分开写。
- 原文复述、“某天某人说了某事”的事件流水、“我已完成…”的汇报、运行过程。
- 和已有记忆重复（应当 `supersede` 那条）。

同一空间里有相近的记忆（同一主题、向量相近）时，`remember` 先不写，列出它们：同一件事有变化就 `supersede` 那条；已经说清楚了就不写；确实是另一件事，再调用一次并把列出的 id 都填进 `distinct_from`。

后台整理类角色（ingest、dreamer 等）写的记忆必须带 `source_refs` 说明来源。
