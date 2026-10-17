---
title: omem 源码 Wiki
summary: 面向要读懂并修改 omem v2 的开发者：从一条消息怎么变成回答讲起，再到数据、检索、记忆、Wiki、交办编码、渠道和配置。
kind: index
updated: 2026-10-18
---

omem 是个人记忆与助理系统：文档、代码、聊天、笔记进同一个 SQLite 知识库，按空间隔离；宿主（Node/TypeScript）只管数据、索引、调度和权限，理解与写作交给通过 ACP 或命令行调用的外部 Agent，Agent 经 MCP 工具读写知识库。这套页面按“一件事在系统里怎么发生”组织，每页末尾给出要改这里从哪下手。建议先读概览，再按“核心流程”顺序往下。

## 开始

- [omem 是什么、怎么组成](./overview.md) —— 总架构、核心术语、模块对照和阅读路线
- [跑起来、调试、测试](./howto/run-and-develop.md) —— 启动、数据目录、观察一次运行、假 ACP Agent 测试

## 核心流程

- [一条消息从进来到回复发出](./flows/message-to-reply.md) —— 渠道 → inbox → ask 运行 → 回复，含连发合并和斜杠命令
- [线程与 Agent 会话](./concepts/threads-and-agent-sessions.md) —— 线程如何划分，Agent 进程何时复用、恢复或从摘要重来
- [任务队列、Run 与角色](./concepts/run-queue-and-roles.md) —— lane、并发槽、重启恢复，以及 roles/*.md 如何变成一次运行
- [Agent 运行时与 MCP 工具权限](./concepts/agent-runtime-and-tools.md) —— token、工具白名单、空间范围、ACP 与 CLI 两条路径
- [一份文件导入到能被搜到](./flows/import-to-searchable.md) —— 导入、切分、建索引、符号与调用图
- [Wiki 生成](./flows/wiki-generation.md) —— 规划、逐页写作、引用与过期检查
- [交办编码](./flows/delegated-coding.md) —— worktree、检查、独立评审、确认后应用

## 概念与设计

- [检索：FTS、符号、向量与 RRF 融合](./concepts/retrieval.md) —— search 的排序从哪来，向量怎么开
- [记忆与事项](./concepts/memory-and-items.md) —— supersede 版本链、事项时间线，巡检、做梦、简报，记忆写入检查、复核与按模型比较
- [渠道](./concepts/channels.md) —— 飞书、Telegram、OneBot、个人消息采集（会话类型、免打扰、采集方式）与会话 hook
- [Agent 档案与技能](./concepts/agent-specs-and-skills.md) —— 自定义 Agent、技能的渐进披露、草稿与批准
- [配置、setup 与定时任务](./concepts/config-and-setup.md) —— config.json、角色分配后端、omem setup、cron

## 修改与参考

- [2026-10-13 之后的变化](./reference/changes-since-2026-10-13.md) —— 本 Wiki 生成后加的功能，其他页面未必都已同步
- [修改指南](./howto/modify-omem.md) —— 加工具、角色、渠道、定时任务、Run 类型、检索路时各改哪些文件
- [参考：工具、命令、Run 类型](./reference/tools-commands-runs.md) —— MCP 工具、斜杠命令、CLI 子命令和 Run 类型清单
