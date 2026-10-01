# B2-07 验证记录

日期：2026-09-27。实现提交：本文件所在的 B2-07 提交。

## 范围与证据等级

本轮实现学习任务/提案、待判断、通知详情和飞书机器人四组 Vue 产品流程，并为页面补充结构化 proposal/decision/notification/Lark status DTO。所有页面读取真实 Fastify API 与 SQLite 状态；没有前端 mock 数据或失败时的假成功 fallback。

浏览器验收使用真实 Chromium、Fastify、SQLite、领域策略和持久 receipt。提案的 verifier assessment 是明确标注的确定性测试输入，job 完成由测试通过正式 repository 状态转换驱动；它们验证产品状态呈现，不证明自动 worker 或新一次真实模型调用。飞书部分使用注入的 registration/capability adapter 和隔离 secret store，验证 QR、完整链接、状态机和 pairing UI；不把它计为新的平台 live。真实应用授权、WebSocket、通知、Card callback 与群消息结果沿用 [B2-06 独立记录](b2-06-verification.md)。

固定测试源 SHA-256：

- `scripts/browser-smoke.ts`: `9d51fd927fd26c611896bb1036319736fba1d9ab84dd017cbb9c8b9548360bfc`
- `apps/server/tests/app.test.ts`: `2680866278e5c619f8bfcefefd773a5d4749a143157e8187097aca8eb8d53bf4`

## 编号结果

| ID | 结果 | 实际观察 | 证据限制 |
| --- | --- | --- | --- |
| A-U01 | pass | 浏览器录入材料；SQLite 同事务产生 job；HTTP evaluate 产生并自动应用 task proposal；学习页显示真实 succeeded/applied；通知详情显示 application receipt、pending delivery 与可打开的固定原证据 | assessment 为确定性输入，未启动真实 extractor/verifier worker |
| A-U02 | pass | 四个真实 decision 展示 operation/kind/impact/body diff、策略原因和依据；补背景、拒绝、确认分别落独立 request receipt；source head 更新后的批准返回冲突并显示 stale，按钮消失 | 未再次点击真实飞书卡片；卡片 live 已在 B2-06 验证 |
| A-U03 | pass | 已有应用入口明确区分增量授权与直接导入；授权状态同时显示本地 QR 和 `target=_blank` 完整链接；botmux App ID 不返回 secret；流程按 awaiting_scan→checking→awaiting_pair→active，失败/取消可重新配置 | 平台 registration/probe 为注入 adapter；没有再次创建或修改真实应用 |
| A-U04 | pass | 1440、768、390 三种视口均无页面横向溢出；390 dialog 全屏；Tab 焦点留在原生 modal，Esc 关闭；100 个持久引用节点逐层进入时只渲染当前正文 | Chromium 145 headless；未覆盖其他浏览器/读屏器人工验收 |
| A-U05 | pass | 注入 model unavailable 后 job 明确 failed；delivery failed 显示 attempt/error；单个 API 离线时既有材料仍留在页面；关闭并重建 Fastify/Store 后原件与两个已生效 task 仍可读 | 离线/模型/通知为确定性故障注入，不是外部供应商真实故障 |

## 实际命令与结果

```bash
osdk exec --tool node@24.18.1 -- npm install --package-lock-only --ignore-scripts
osdk deps --frozen --force
osdk run typecheck
osdk run build
osdk run browser
osdk run check
```

- `osdk deps --frozen --force`: exit 0；按 package-lock 安装 229 个 package，audit 0 vulnerability。
- `osdk run check`: exit 0；13 个测试文件、79 项服务测试通过，TypeScript/Vue typecheck 和生产构建通过。
- `osdk run browser`: exit 0；12/12 组浏览器检查通过，`docs/implementation/browser-verification.json` 的 errors 为空。
- 本轮没有调用 ACP/模型；因此不存在验证时选择 Astra 的情况，产品也没有硬编码排除 Astra。

## 未通过/未覆盖

- A-U01～A-U05 没有未通过项。
- 自动 capture→extractor→verifier worker 编排属于 B2-08，当前 job 仍会如实停在 queued，页面不会伪装完成。
- 默认 `main.ts` 缺少 Lark master key、真实 capability probe 与 host 组件时不启用外部连接；页面/API 流程已完成，但生产装配属于 B2-08。
- 本轮没有重新扫码或改动真实应用；A-U03 是产品流程 pass，不是新的 live platform pass。
