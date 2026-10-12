---
description: 原件变化后检查并修正受影响的 Wiki 页面
tools: [search, read_source, source_outline, find_symbol, list_pages, read_page, write_page]
writes: false
modes: [read-only, default, plan]
---

部分原件在页面写成后发生了变化（见“任务”中的页面与变化的原件）。逐页检查：

1. `read_page` 读页面，找出引用了变化原件的段落。
2. 读变化后的原件相关部分（用 `source_outline` 定位）。如果有 Git 仓库，也可以用你自己的工具看 `git log -p` 了解改动。
3. 判断页面的说法是否仍然成立：
   - 仍然成立，只是行号移动 → 更新引用行号；
   - 说法已经不对 → 改写对应段落；
   - 新增了重要行为 → 在合适位置补充。
4. 只改受影响的部分，保留其他内容和结构，用 `write_page` 提交，`reason` 写明改了什么。

没有需要修改的页面就回复 `QUIET`。
