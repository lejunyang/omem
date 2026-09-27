# 下一批实施交接包

日期：2026-09-26；实施状态更新至 2026-09-27。原始基线提交：`d627af2`。下列任务最初由本交接包定义，不应仅凭方案文字判断已实现；当前实际能力以根 [README](../../../README.md)、[状态页](../status.md) 和各任务验证记录为准。B2-01～B2-06 已有实现提交，B2-06 的确定性结果与 live 缺口见 [验证记录](b2-06-verification.md)。

目标：让新材料在后台形成有证据的事实/经历/事项；高置信小范围变化自动应用并通知；歧义、背景不足、范围大和危险操作进入具体决策；人的纠正能影响后续处理。

## 阅读顺序

1. 根 [AGENTS.md](../../../AGENTS.md)、[实际状态](../status.md)、[已确认需求](../../decisions.md)。不要把第一轮蓝图当已经实现的接口。
2. [核心实施方案](plan.md)：数据库迁移、任务租约、提案、策略、原子应用、反馈与 API。
3. [Agent 运行包](agent-runtime.md)：ACP/CLI、角色提示词、Skills、MCP 与上下文隔离。
4. [飞书接入](lark.md)：官方扫码创建机器人、绑定、自有凭据、通知和交互回调。
5. [验收](acceptance.md)：编号用例、门槛、运行证据、交付要求。
6. [MemPalace 调研与接入决策](../../research/mempalace/README.md)：源码边界、结果复算、PoC。

提示词起稿在 [prompts](prompts)，机器可读样例在 [examples](examples)；**样例是 batch2 新合同（各自 schema_version=1），不能直接写入当前 omem.local.json**。所有版本/来源见 [research-sources.json](research-sources.json)。

## 可交给实现 Agent 的任务单

| 任务 | 修改责任范围（建议） | 前置 | 独立验收 |
| --- | --- | --- | --- |
| B2-01 合同与迁移 | packages/contracts；server migrations/repository；迁移测试 | 无 | A-M01～04，schema/旧库兼容 |
| B2-02 持久任务与输入缓冲 | jobs/worker、capture hook/spool；只调用 B2-01 repo 接口 | 01 | A-J01～07，A-I01～03 |
| B2-03 推理与角色包 | agent gateway、role assets、prompt renderer、ACP/CLI tests | 01；可先 mock job | A-R01～08 |
| B2-04 提炼/验证/策略/应用 | extraction、proposal、evidence validation、policy、feedback | 01–03 | A-K01～10，A-F01～03 |
| B2-05 飞书创建与绑定 | lark registration、binding repo、secure secret store、SDK tests | 01 | A-L01～07 |
| B2-06 外部投递与决策回调 | outbox worker、send adapter、event inbox、card actions | 04、05 | A-L08～14，A-N01～05 |
| B2-07 Vue 产品流程 | 捕获状态、学习流、待判断、机器人设置、变更/通知详情 | 合同冻结；可用测试 API | A-U01～05 |
| B2-08 集成与回归 | 端到端 fixtures、故障注入、文档和发布说明 | 01–07 | 全部门槛 |
| R-MP 独立研究 PoC | MemPalace adapter spikes、隔离环境与质量报告 | 无；不得改权威模型 | 调研第 7 节硬门 |

工作可以按责任范围并行，但共享 contracts/migrations 由单一负责人合并。B2-03/B2-05 在合同冻结后可并行。每个任务提交一个可运行闭环和相关测试；不能只提交 stub、schema 或未接线页面后声称完成。

## 建议的交接提示

> 在 omem 基线 d627af2 上实现 B2-XX。先读 AGENTS.md 和 docs/implementation/batch2 的对应方案、验收编号；使用 osdk 管理依赖，Vue 复用 packages/ui。只修改分配范围，协调共享合同，不回退其他 Agent 的改动。实现真实错误/重试路径，运行指定测试并记录证据。不要将 mock 或 fixture 结果写成真实第三方集成成功；新建飞书应用需通过用户扫码/平台授权流程，禁止打印 secret。完成后提供 commit、执行命令、通过与未通过编号及明确限制。

## 交付标准

- 沿用 Node/SQLite 的个人模式；不引入必需 Docker、本地生成式 LLM 或完整组织平台。
- 主线必须能从 capture 一路走到通知和反馈，不把所有候选锁在人工队列。
- 模型只产生结构化建议，领域服务负责权限、并发、证据/版本校验和事实提交。
- 每次普通自动应用都有完整变更与通知记录；需要人的决定必须绑定到具体 diff/版本。
- 飞书官方注册能力优先；botmux 是可选渠道适配器，不复制其会话管理/CLI 调度平台。
- 先通过 fixture/故障测试，再跑真实 CLI/ACP 和独立测试机器人验证；两类结果分别列明。
