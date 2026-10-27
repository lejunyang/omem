# Wiki（wiki）

- `list_pages` / `read_page`：列出、阅读 Wiki 页面。页面提示“引用原件已变化”时以较新的原件为准。
- `write_page`：写 Wiki 页面（Markdown，`[[slug]]` 链接，跨空间 `[[space:slug]]`，`[文字](src:<原件id>#L1-L5)` 引用）。引用放在它支撑的句子末尾。解决过的问题写成案例页：`kind: "case"`，`page: "cases/<主题>"`，写现象、判断方法、原因、解法和适用条件。
- `generate_wiki(space?, focus?, source_spaces?, auto_write?, execution?)`：与网页和命令行共用 Wiki 生成流程，先规划再逐页写作。
  - `focus` 传完整要求、资料优先级和草稿线索，每页都会收到。
  - `source_spaces` 指定额外只读材料空间，默认读取目标的相关空间。写入限于目标空间，须有写权限。
  - `auto_write` 默认 true，只要目录时设 false。
  - 返回规划运行 ID，用 `read_run` 查看写作子运行及状态；已排队不等于已完成。
  - 不要通过 `run_agent` 调内置 Wiki 角色，也不要先写工作文件替代 Wiki。`execution` 给规划和每页写作临时选 AI。
- `submit_plan` 只开放给 Wiki 规划角色。
