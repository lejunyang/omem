# Wiki（wiki）

- `list_pages(space?, folder?, direct?, limit?, offset?)` / `read_page`：列出、阅读 Wiki 页面。页面按路径分目录（`a/b/c` 是目录 `a/b` 里的页面 `c`）；页面多时 `list_pages` 先给目录概况，再用 `folder` 看某个目录（`direct` 只看直接放在里面的）。页面提示“引用原件已变化”时以较新的原件为准。用旧路径读页面也能读到（它移到了新位置）。
- `write_page`：写 Wiki 页面（`page` 带目录，放进已有的合适目录，不放顶层；顶层只放总览、入门）（Markdown，`[[slug]]` 链接，跨空间 `[[space:slug]]`，`[文字](src:<原件id>#L1-L5)` 引用）。引用放在它支撑的句子末尾。解决过的问题写成案例页：`kind: "case"`，`page: "cases/<主题>"`，写现象、判断方法、原因、解法和适用条件。
- `generate_wiki(space?, focus?, source_spaces?, auto_write?, execution?)`：与网页和命令行共用 Wiki 生成流程，先规划再逐页写作。
  - `focus` 传完整要求、资料优先级和草稿线索，每页都会收到。
  - `source_spaces` 指定额外只读材料空间，默认读取目标的相关空间。写入限于目标空间，须有写权限。
  - `auto_write` 默认 true，只要目录时设 false。
  - 返回规划运行 ID，用 `read_run` 查看写作子运行及状态；已排队不等于已完成。
  - 不要通过 `run_agent` 调内置 Wiki 角色，也不要先写工作文件替代 Wiki。`execution` 给规划和每页写作临时选 AI。
- `move_page(moves: [{from, to}], space?, reason?)`：移动或改名页面；整个目录改名时 `from`、`to` 都以 `/` 结尾（`cases/` → `kb/cases/`）。内容和引用状态不变，旧路径留作别名，其他页面里的 `[[链接]]` 自动改成新路径。目标已有页面、`index`（空间首页）会被拒绝。一次最多 300 页。
- `confirm_page(page, space?, note?)`：核对过一篇引用的原件已变化的页面，说法仍然成立、不用改：清掉“原件已变化”提示，内容不变。改了页面用 `write_page` 就行。
- 原件变了的页面会在原件稳定后自动由 Wiki 检查角色处理，顶层散落或挤在一起的页面由 Wiki 目录整理角色分进目录；不需要你另外安排。
- `submit_plan` 只开放给 Wiki 规划角色。
