# 需求跟进与实现交接

此前已有通用调查、记忆/事项和文章维护，但没有专门的需求工作流。现在增加 `requirements` CLI，用需求目标驱动 `requirement-tracker → implementation-planner → knowledge-verifier`，共享现有材料快照、搜索、代码导航、原生读取工具、持久队列和知识阅读页。

这条流程生成并维护一份需求页，回答：为谁解决什么问题、哪些约定已确认、验收条件是什么、代码到哪里、谁在等谁、下一步改哪里。它目前提供**需求综合跟进和实现建议/交接**，不是收到群消息就自动修改代码的执行器，也没有替代现有 MemoryService 写事项状态。

## 一条可用流程

1. 用 `omem import lark/file/git` 导入需求、纪要和代码；用个人消息订阅持续拉讨论。材料统一成为 Source/Revision。
2. `omem contexts create '需求名称' --description '目标和范围'` 建立项目范围；`contexts assign SOURCE_ID CONTEXT_ID` 指定来源归属。该命令设置完整归属列表，要保留其他归属就一起传入。已有自动归属可补充后来加入的材料；含糊时待判断，不凭相似词把别的需求纳入。
3. 建立需求页，明确目标和持续选材范围：

```bash
omem requirements track '工单自动分派' \
  --goal '明确验收口径、当前差距和下一步实现' \
  --context PROJECT_ID --watch
omem requirements list --json
omem requirements show REQUIREMENT_KEY
omem requirements handoff REQUIREMENT_KEY --to ./implementation-handoff
```

也可用 `--revision ID...` 选择材料：后续跟随这些来源的修订，不会因此自动把其他来源加入。`--context` 可跟随项目成员增减。`watch KEY --off` 暂停，`refresh KEY` 手动重新调查。排队、生成、复核和发布是不同状态；失败保留旧文和错误，不能显示为已完成。

## Agent 如何综合判断

- 跟进研究者先读正式需求和最新决定，再补会议/讨论与实际入口代码。不能把较晚的个人提议当成覆盖正式决定的授权。
- 实现规划者按用户场景、验收表、关键变化、实现入口、阻塞与下一步组织正文。未知负责人、期限和上线状态明确未知；“有代码”“测试通过”“已经上线”分别有各自依据。
- 独立复核会话重新读原件，检查关键结论和引用。它仍可能漏掉业务背景，模型通过不等于需求负责人验收。
- 已开启的维护沿用同一需求页及固定历史，项目里新归属材料或旧来源换版触发已有维护队列。个人群聊只是一个来源，正式飞书文档和代码仍需导入或上游更新；目前不是自动拉取所有关联仓库和文档。

`handoff` 导出 TASK.md、references.json 和被该页依赖的固定文本原件。它不是 Git 工作区，也不含所有二进制附件；图片继续通过个人库查看。开工前编码 Agent 应比较实际仓库、分支、未提交修改与快照，再按用户授权实施。若引用旧版或需求页待更新，交接保留状态，不静默替换为最新原件。

## 还缺什么

目前没有自动完成实现、跑项目检查、提 PR、部署的需求执行 Agent；本轮也没有把所有跟进页条目自动转成可编辑的结构化需求状态。下一步应把需求页的阻塞和“等谁回复”接到已有事项处理，再增加用户主动发起的仓库实现任务；沿用现有通知投递，不另建消息发送通道。

代码改造入口：`knowledge/requirements.ts` 提供目的模板和固定交接，`WikiPageBrief.workflow` 持久标识工作流，`KnowledgePipeline` 选择专门角色，`KnowledgePageWorker` 负责持续更新。它们没有按 omem 目录、固定题目或仓库名决定结果。

## 本轮实际验证

`osdk run requirements:verify` 使用真实 Traex ACP / gpt-5.6-sol，输入合成需求、群聊、会议纪要、代码，以及未归属的干扰文档。2026-10-06 用时 471.8 秒：正确保留 general 兜底、完成入口尚未实现、内部演示不等于上线，固定依赖包含四类材料而排除干扰。独立复核发现并修订了“建议先确认接口”被写成“小周正在等待”的问题，也纠正了无依据的操作人判断。

最终页面能给出验收表与实现建议，但同一状态在摘要、验收表和进度表间仍重复，未知项的解释偏长。它验证了跨来源调查与修订流程，不证明真实大群的自动需求识别准确率。该样例没有另跑第二轮变更生成；自动持续更新沿用已有队列与重启检查。专项完整输出覆盖写入 `.repo-review/runtime/research/requirement-followup.json`，不逐轮新增整套知识产物。

## 新消息怎样自动进入项目

`requirements track --watch` 跟随正式项目归属，不猜群名。新消息的自动归属依赖已有学习流程：在个人配置启用 `learning.enabled`，设置有效 `learning.profileId` 后重启服务；`omem status --json` 的 `processingEnabled` 与 `learning.running` 可检查是否消费作业。未启用时仍可显式导入并设置归属、主动生成需求页，但不能把采集入队当作已经自动理解项目。
