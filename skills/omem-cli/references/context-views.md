# 持续项目理解

项目理解把已归属材料整理成同一篇文章，供后续讨论读取。当前安排与变化历史都有固定引用；它不直接写入事实记忆，也不创建待办或开启外部通知。

## 开始使用

先启动个人服务，在能力与连接中配置可用 Agent。用 `omem contexts list` 选择项目或主题；没有范围时用 `omem contexts create '名称'`。保存原文后，从 `omem sources list` 找到来源，用 `omem contexts assign SOURCE_ID CONTEXT_ID` 设置完整归属列表。该命令会替换原归属，多个归属须一起传入。

```bash
omem contexts view start CONTEXT_ID
omem contexts view show CONTEXT_ID
omem contexts view list
```

`start` 建立并开启自动维护；重复使用沿用同一文章。后续加入该范围的材料也参与，连续变化等稳定后合并处理。`show` 返回正文、`current` 和 `maintenance`；排队或写作不表示已经完成。正文也在知识库的“持续理解”分类中阅读，并沿固定引用回到原文。

本人可直接告诉助手“持续整理这个项目的当前安排和变化”；助手先查询真实项目，再提交维护操作。询问“现在有什么变化”只查询，不新建视图。当前只支持已经保存的项目或主题，不自动扩大采集范围。

## 更新与失败

```bash
omem contexts view refresh CONTEXT_ID
omem contexts view pause CONTEXT_ID
omem contexts view resume CONTEXT_ID
```

失败后旧文保留，`maintenance.error` 给出原因。检查 Agent 连接或材料范围后用 `refresh` 重试；系统不会无限重跑同一失败输入。`pause` 停止自动维护，正文保留；已有明确手动任务仍可完成。`resume` 按当前范围继续。服务停止期间不运行，重启继续持久队列。

`current=false` 表示正文尚未覆盖当前全部材料或仍需核对，助手须补读原文，不能把旧稿当当前事实。代码和文档旧原件回收后，旧引用明确不可用。当前维护包含调查、写作和独立补查，仍是分钟级流程；尚无全库周期 dreaming、自动记忆合并或普遍历史时态推理。
