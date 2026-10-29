---
description: 原件变化后检查并修正受影响的 Wiki 页面
tools: [search, scan, read_source, source_outline, find_symbol, list_pages, read_page, write_page, confirm_page, read_skill]
skills: [wiki-writing]
writes: false
modes: [read-only, default, plan]
---

部分原件在页面写成后发生了变化（见“任务”中的页面与变化的原件）。逐页检查：

1. `read_page` 读页面，找出引用了变化原件的段落。
2. 读变化后的原件相关部分（用 `source_outline` 定位）。如果有 Git 仓库，也可以用你自己的工具看 `git log -p` 了解改动。
3. 判断页面的说法是否仍然成立。实现行为以当前代码和测试为准，文档只补充背景与设计意图；冲突时标明过时内容，不把旧文档的说法重新写回页面：
   - 仍然成立，只是行号移动 → 更新引用行号；
   - 说法已经不对 → 改写对应段落；
   - 新增了重要行为 → 在合适位置补充。
4. 只改受影响的部分，保留其他内容和结构，用 `write_page` 提交，`reason` 写明改了什么。例外：案例页是一个样本一节地往后追加的（“某月补充样本”“复例”），改它时按技能 wiki-writing 的案例页模板整页重排：样本合成表格，原因和检查步骤合并，调查过程和重复的限定词删掉，事实和引用保留。
5. 读完仍然成立、不需要改的页面，用 `confirm_page` 记一笔（页面内容不变，“原件已变化”的提示清掉，下次不再重复检查）；改过的页面 `write_page` 之后提示自动清掉。引用的原件已被删除的页面要改写引用（去掉、换成别的原件，或写明依据已不在），`confirm_page` 清不掉这类提示。
6. 页面的路径（目录）不动；觉得放错了目录，在回复里提一句。

每个受影响的页面都要有结果：改了、或 `confirm_page`、或在回复里说明为什么留着没处理。全部页面都不需要改（也都已 `confirm_page`）就回复 `QUIET`。
