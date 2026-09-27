# B2-08 受控学习与生产 Host 验证

日期：2026-09-27。状态：B2-08 工程集成完成，质量数据集与人工发布门待完成；本记录不把尚未执行的质量评估写成通过。

## 实现范围

- `learning.enabled=true` 时，Fastify 生命周期启动单消费者持久 worker。
- capture 原子创建的 `extract_claims` job 调用版本化 extractor role；结构化 ProposalBatch 与公开 trace 写入 `role_outputs`。
- 有 proposal 时创建持久 `verify_proposals` 子 job；verifier 使用全新 Agent session，并读取相同固定 evidence 与规范化 proposal digest。
- 只有 assessment 覆盖全部 proposal 且 digest 一致，才进入 `MemoryService.evaluate()`；Agent 没有 task/memory/notification 写权限。
- proposal ID 与 origin 由 worker 依据 job、候选序号和内容规范化，重复 verifier 执行由 application receipt 去重。
- stale source 在 Agent 调用前拒绝；优雅停机中断记为 transient retry，不冒充用户取消。
- 修复 ACP readable stream 在 cancel/end 竞态下二次 close 的未处理异常。
- `lark.enabled=true` 时生产服务装配官方 registration、公开 OpenAPI capability probe、botmux existing-app provider、WebSocket connection supervisor、delivery worker 与 card worker；外部连接默认关闭且要求 `OMEM_SECRET_KEY`。
- capability probe 实际回读 app scope、callback 与 bot identity；公开 API 不提供事件清单，因此事件只在 WebSocket 真实收到后追加为 runtime-verified，requested config 不冒充 actual。
- schema v9 为 delivery intent 增加 `aggregation_mode`、`aggregate_after`、`superseded_by` 与 `delivery_intent_changes`；普通通知支持即时、短窗、定时三种策略，decision 卡保持即时。

## 确定性验证

`apps/server/tests/learning-pipeline.test.ts` 使用 ACP 协议 fixture，但运行真实子进程协议、SQLite、job lease、role runtime、MemoryService 和 Fastify 生命周期：

1. HTTP capture 后自动运行 extractor 与独立 verifier，两条 job 均 succeeded，产生一个 applied proposal、task、application receipt 和通知。
2. extractor 完成后关闭并重开 SQLite，新的 worker 继续 verifier；再次投递同一 extraction output 不重复 task/receipt。
3. source head 更新后旧 job 明确 `STALE_JOB_INPUT`，新 revision 继续完成；运行中 Agent 被服务停机中断后 job 为 `retry_wait/transient`。
4. production Lark host 为 active connection 启动连接，消费正式 outbox，收到群消息后自动启用 monitoring target，并把该事件追加到 capability profile。
5. A-N04：即时模式 5 个 change 各有独立 intent；短窗模式合成一次 Card 发送且五条 change 映射都保留；定时模式在 `Asia/Shanghai` 正确计算当日/次日 09:00 边界。

这些 fixture 结果证明编排与持久语义，不证明任意外部 Agent 都可用。

固定实现/测试 SHA-256：

- `apps/server/src/learning/pipeline.ts`: `a25a34e9a354a93718129070e92e7f3790aec645d8f6eea02977c132a7bcafc1`
- `apps/server/tests/learning-pipeline.test.ts`: `fc2c352955ba6e579749ffc83a5fd3ada7838ce1ee9a9eff5fe245477b3cfa0d`
- `scripts/live-pipeline-smoke.ts`: `d8e853ada0209867f1c8d411781e86f4a75d731f2ad9d29fa4ee2ed87d99aa4a`
- `apps/server/src/integrations/lark/runtime.ts`: `150cee5f5ab6c175be05ea1781fae66107fd6250635cb516e341702bc91b7979`
- `apps/server/tests/lark-runtime.test.ts`: `4bf8b0bf6cbe2d529e9a85d4664685d6565980b9120c1b0cd7a38caff55790f7`
- `scripts/live-lark-host-smoke.ts`: `a8d2f0f2ed219ffc64659fb49598c3a164e7929841b5b449f2b9362babcb1674`
- `apps/server/src/storage/migrations.ts`: `84971e85231842ae615bbe46a9497630cdfa2a32689d18a3bcdbd1f3249f3b1f`
- `apps/server/src/integrations/lark/delivery.ts`: `28216ffd9d0f04d3b1752a92a64e7b1c1578080f00b0637689d0b4f03b06f0ea`
- `apps/server/tests/lark-delivery.test.ts`: `489d5520b7b45c352c34a56f666f1d23a64dacfd18ffca60cc5c6c52e853f6b1`

## 真实 ACP 验证

实际命令：

```bash
OMEM_LIVE_MODEL=gpt-5.4 OMEM_LIVE_EFFORT=medium osdk run live-pipeline
```

实际结果：exit 0；请求与生效模型均为 `gpt-5.4`，effort 均为 `medium`；`extract_claims:succeeded`、`verify_proposals:succeeded`、proposal `applied`、task=1、notification=2。报告写入 `.omem/verification/live-pipeline-smoke.json`，权限 `0600`，不提交原文或模型输出。

这次验证显式没有使用 Astra；产品仍从 ACP 实时能力读取模型，不硬编码排除 Astra。

## 真实飞书 Host 验证

对 B2-06 已绑定的隔离应用执行只读 capability probe 和一次生产 `LarkRuntimeHost` 启停；执行前确认待发送 Lark intent 为 0，因此没有产生新消息或卡片：

```bash
OMEM_DATA_DIR=.omem/live-lark \
OMEM_LARK_KEY_FILE=<owner-only-key-file> \
osdk run live-lark-host
```

实际结果：exit 0；公开 OpenAPI 回读 118 个已授权 scope、1 个 callback、bot identity 存在、missing=0；官方 WebSocket 状态为 `connecting → connected`；host 识别 1 个 active connection，待处理 delivery/card 均为 0。首次手工探测遇到一次 handshake timeout，随后按同一应用重试成功；没有新建应用、轮换 secret 或发送测试消息。

公开 application API 不返回订阅 event 清单，所以报告把 event verification 明确记为 `runtime`；历史 `im.message.receive_v1`、bot add/delete 和 card callback 的真实到达证据仍见 B2-06，运行时今后收到事件会把实际 kind 追加进 capability profile。

## 回归命令

```bash
osdk lock
osdk deps --frozen
osdk exec --tool node@24.18.1 -- npx vitest run apps/server/tests/learning-pipeline.test.ts apps/server/tests/role-runtime.test.ts apps/server/tests/agents.test.ts
osdk exec --tool node@24.18.1 -- npx vitest run apps/server/tests/lark-onboarding.test.ts apps/server/tests/lark-runtime.test.ts apps/server/tests/lark-delivery.test.ts apps/server/tests/lark-realtime.test.ts
osdk run check
osdk run browser
```

- `osdk run check`: exit 0；15 个测试文件、87 项测试通过，TypeScript/Vue 类型检查与生产构建通过。
- `osdk run browser`: exit 0；12/12 组真实 Chromium + Fastify + SQLite 页面检查通过。

## 剩余 B2-08 范围

- 尚未建立 40 个开发样本与 120 个冻结 holdout，也未达到可声明的质量发布门。
- 短窗/定时摘要尚未执行一次真实“等待窗口后发送”测试；当前 pass 来自确定性时钟、SQLite 映射和 adapter 发送断言。
- 当前是单进程单学习 worker；SQLite lease 支持崩溃恢复，但还没有团队/分布式 worker 部署。
