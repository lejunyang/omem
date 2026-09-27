# B2-08 受控学习主链验证

日期：2026-09-27。状态：B2-08 第一阶段完成；本记录不宣称整个 B2-08 或所有发布门已完成。

## 实现范围

- `learning.enabled=true` 时，Fastify 生命周期启动单消费者持久 worker。
- capture 原子创建的 `extract_claims` job 调用版本化 extractor role；结构化 ProposalBatch 与公开 trace 写入 `role_outputs`。
- 有 proposal 时创建持久 `verify_proposals` 子 job；verifier 使用全新 Agent session，并读取相同固定 evidence 与规范化 proposal digest。
- 只有 assessment 覆盖全部 proposal 且 digest 一致，才进入 `MemoryService.evaluate()`；Agent 没有 task/memory/notification 写权限。
- proposal ID 与 origin 由 worker 依据 job、候选序号和内容规范化，重复 verifier 执行由 application receipt 去重。
- stale source 在 Agent 调用前拒绝；优雅停机中断记为 transient retry，不冒充用户取消。
- 修复 ACP readable stream 在 cancel/end 竞态下二次 close 的未处理异常。

## 确定性验证

`apps/server/tests/learning-pipeline.test.ts` 使用 ACP 协议 fixture，但运行真实子进程协议、SQLite、job lease、role runtime、MemoryService 和 Fastify 生命周期：

1. HTTP capture 后自动运行 extractor 与独立 verifier，两条 job 均 succeeded，产生一个 applied proposal、task、application receipt 和通知。
2. extractor 完成后关闭并重开 SQLite，新的 worker 继续 verifier；再次投递同一 extraction output 不重复 task/receipt。
3. source head 更新后旧 job 明确 `STALE_JOB_INPUT`，新 revision 继续完成；运行中 Agent 被服务停机中断后 job 为 `retry_wait/transient`。

这些 fixture 结果证明编排与持久语义，不证明任意外部 Agent 都可用。

固定实现/测试 SHA-256：

- `apps/server/src/learning/pipeline.ts`: `a25a34e9a354a93718129070e92e7f3790aec645d8f6eea02977c132a7bcafc1`
- `apps/server/tests/learning-pipeline.test.ts`: `fc2c352955ba6e579749ffc83a5fd3ada7838ce1ee9a9eff5fe245477b3cfa0d`
- `scripts/live-pipeline-smoke.ts`: `d8e853ada0209867f1c8d411781e86f4a75d731f2ad9d29fa4ee2ed87d99aa4a`

## 真实 ACP 验证

实际命令：

```bash
OMEM_LIVE_MODEL=gpt-5.4 OMEM_LIVE_EFFORT=medium osdk run live-pipeline
```

实际结果：exit 0；请求与生效模型均为 `gpt-5.4`，effort 均为 `medium`；`extract_claims:succeeded`、`verify_proposals:succeeded`、proposal `applied`、task=1、notification=2。报告写入 `.omem/verification/live-pipeline-smoke.json`，权限 `0600`，不提交原文或模型输出。

这次验证显式没有使用 Astra；产品仍从 ACP 实时能力读取模型，不硬编码排除 Astra。

## 回归命令

```bash
osdk lock
osdk deps --frozen
osdk exec --tool node@24.18.1 -- npx vitest run apps/server/tests/learning-pipeline.test.ts apps/server/tests/role-runtime.test.ts apps/server/tests/agents.test.ts
osdk run check
osdk run browser
```

- `osdk run check`: exit 0；14 个测试文件、82 项测试通过，TypeScript/Vue 类型检查与生产构建通过。
- `osdk run browser`: exit 0；12/12 组真实 Chromium + Fastify + SQLite 页面检查通过。

## 剩余 B2-08 范围

- 生产 Lark host 尚未统一装配进 `main.ts`；现有注册、连接、投递和卡片组件仍需显式 host。
- 尚未建立 40 个开发样本与 120 个冻结 holdout，也未达到可声明的质量发布门。
- 短窗通知合并与定时外发摘要未实现，A-N04 仍为 partial。
- 当前是单进程单学习 worker；SQLite lease 支持崩溃恢复，但还没有团队/分布式 worker 部署。
