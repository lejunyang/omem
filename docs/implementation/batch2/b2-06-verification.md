# B2-06 验证记录

日期：2026-09-27。实现提交：本文件所在的 B2-06 提交。

## 范围与证据等级

本轮实现飞书 WebSocket 连接租约与 event inbox、owner notification outbox、Card 2.0 决策 callback。测试使用官方 Node SDK adapter 边界、真实 SQLite 文件/重启和注入 transport；没有创建、授权或连接真实飞书测试应用。因此下表的“通过”仅指确定性实现验收，所有平台 live 项继续为 `skipped`，不能据此声称真实飞书集成成功。

固定测试源文件 SHA-256：

- `lark-delivery.test.ts`: `957b4a8068b0ce22750bf38a356f53ed6bf271f9971d2400ffad6ec25de92d10`
- `lark-realtime.test.ts`: `bb2719abbe80c09c22f7706a9684bbdd03fcbb4c0f9bb940be145ada4a8623d3`

测试动态生成 app/chat/message/event ID、加密 key、nonce 和临时 SQLite，不把任何真实凭据或消息写入仓库。

## 编号结果

| ID | 确定性结果 | 观察值 | Live |
| --- | --- | --- | --- |
| A-L08 | pass | 两 worker 只有一个取得 connection lease；连接/reconnecting/connected 事件入库；SDK callback context 归一化；pairing 消息路由 | skipped：无真实 WS/断网恢复 |
| A-L09 | pass | bot-added 后监控 target 立即 active；复用应用已有群由首条消息补建 active target；event_id 去重、同 ID 冲突拒绝；自消息忽略；其他 bot 身份、事件时间和乱序更新保留 | skipped：无真实群消息 |
| A-L10 | pass | 同 callback 重放复用一条 command；不同按钮竞态被拒；与 Web 决策竞态只有一个业务结果，卡片按实际状态更新 | skipped：无真实卡片点击 |
| A-L11 | pass | 错 operator/chat/message/nonce/proposal digest/expiry/expected-version digest 全部拒绝，零 command/业务效果 | skipped |
| A-L12 | pass | callback 先写 event inbox + command 再返回 ACK；注入 DB INSERT 失败时不返回成功，原事件可重投 | skipped：未测平台 3 秒时限 |
| A-L13 | pass | source head 改变后 queued approval 变 stale，零 task 副作用，结果卡显示需重新查看 | skipped |
| A-L14 | pass | 移群事件停用该群全部 target/capture；认证失败停用 connection；旧 binding intent 不转发 | skipped：无真实移群/secret 轮换 |
| A-N01 | pass | application 与 intent 已提交后重开 SQLite，sender 继续发送且 task 不重复 | skipped：发送 adapter 为注入 transport |
| A-N02 | pass | 响应丢失在一小时内沿用同 provider UUID；超窗不再发送并记 `unknown` | skipped：未验证平台去重窗口 |
| A-N03 | pass | 429 使用 Retry-After、有界 attempt；401/auth 停用 connection/targets；落库错误脱敏 | skipped |
| A-N04 | partial | 当前支持的即时模式下 5 个 change 各有独立 intent/digest/UUID 映射 | 未通过：短窗合并与定时外发摘要未实现 |
| A-N05 | pass | superseded binding 的 pending intent 全部取消；恢复变更只投新 target；卡片不生成 localhost URL | skipped：无真实目标切换 |

## 实际命令

```bash
osdk deps --frozen
osdk exec --tool node -- npx vitest run apps/server/tests/lark-delivery.test.ts apps/server/tests/lark-realtime.test.ts
osdk exec --tool node -- npx vitest run apps/server/tests/lark-delivery.test.ts apps/server/tests/lark-realtime.test.ts apps/server/tests/migrations.test.ts
osdk run typecheck
osdk run check
osdk run browser
```

最终结果：`osdk deps --frozen` exit 0（npm up to date）；`osdk run check` exit 0（13 个测试文件、78 项测试通过，TypeScript/Vue 类型检查和生产构建通过）；`osdk run browser` exit 0（7/7 组浏览器检查通过）。本任务没有调用 ACP，也没有使用或排除任何产品模型；此前用户要求的“验证时不用 Astra”不需要通过写死模型限制来实现。

## 剩余限制

- 必须由用户进入显式创建/复用应用流程，完成扫码、权限发布、同应用 pairing，并把机器人加入测试群后，才能执行 live 验收；入群后不再增加第二次监控批准。
- `LarkConnectionManager`、delivery worker 和 card worker 是显式装配组件；默认 `main.ts` 在缺少 master key、真实 capability probe 与 host 配置时不启动外部连接。
- 当前没有 B2-07 的连接设置、群监控状态、投递状态和 decision UI，也没有 `POST .../test` / disconnect API。
- 当前只实现逐条即时外发；短窗合并与定时外发摘要不计为通过。
