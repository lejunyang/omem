# 质量数据集与人工标注

日期：2026-09-27。状态：基础设施已实现；dev 标注进行中，holdout 尚未建立。

## 数据隔离

- 原始材料、样本文本、人工标签、预测和逐项失败结果只保存在 `OMEM_DATA_DIR` 对应的 SQLite 与 `.omem/quality/`，均被 Git 忽略。
- 仓库只保存 schema、runner、确定性 fixture 和聚合结果说明。
- 每个 dataset 固定 source URI、source revision、source digest、split 和目标数量；相同输入 digest 不重复入集。
- holdout 只有达到目标数量且全部由人工确认后才能冻结；冻结时保存 manifest digest，评测前重新计算并拒绝篡改。

## 飞书标注流程

标注卡由项目自己的 omem 飞书应用通过正式 outbox 发送到 active owner 私聊，不使用 botmux ask。整个会话只维护一张 Card，点击后返回下一条，避免刷屏。

每次 callback 校验：

- `protocol=omem.quality.v1`
- app、binding owner、chat、message
- session、当前 sample、有效期
- HMAC nonce 与 draft label digest
- event ID 去重

按钮语义：

- `标注正确`：draft label 成为 confirmed label。
- `应不提炼`：人工覆盖为 abstain，`autoApply=false`。
- `需要修改`：进入 needs_edit，不算完成标签。
- `稍后处理`：标为 skipped，不进入冻结集。

needs_edit/skipped 样本可通过 `POST /api/quality/samples/:id/revise` 提交完整修订标签并重新进入 pending；请求必须带上一版 `expectedLabelDigest`，避免覆盖并发修改。

## 当前 dev 集

- 来源：《抖音商家中心业务分享》
- 飞书 revision：3709
- source digest：`63ccbac008ac7b8421572e80eb118c6d54fc60d990e6d3f4db32e78afe82248e`
- 目标：40 条 dev 样本
- 初始草稿：从互不重复的正文块生成 claim 建议；它们只是待确认草稿，不是人工真值
- 当前状态：已生成 40 条改进版 dev 草稿；按 owner 要求停止 live 标注，所有 annotation session 已取消，尚无冻结数据集

项目应用曾通过正式 outbox 向绑定 owner 私聊投递试验卡。首版卡片把整段原文直接重复为 claim，无法形成有意义的判断，已废弃；一次“稍后处理”还暴露了 `skip` 动作与 SQLite `skipped` 状态名不一致的问题。该映射已修复并增加回归测试。随后收到的一次 `abstain` callback 通过了 app/owner/chat/message/nonce/digest 校验，但只保留在未冻结的旧草稿中，不计入质量结果。发送成功或收到点击都不等于数据集通过，只有完整人工确认并冻结后才能运行正式评测。

一篇文档只用于首批 dev 校准，不拆成 120 条来冒充独立 holdout。holdout 还需要更多经明确授权、按项目/时间隔离的材料。

## 运行命令

```bash
OMEM_DATA_DIR=.omem/live-lark \
OMEM_LARK_KEY_FILE=<owner-only-key-file> \
OMEM_LARK_APP_ID=cli_xxx \
OMEM_QUALITY_SOURCE='https://tenant.larkoffice.com/wiki/token' \
osdk run quality-lark-annotate

OMEM_LIVE_MODEL=gpt-5.4 \
OMEM_LIVE_EFFORT=medium \
OMEM_QUALITY_DATASET_ID=your-frozen-dataset-id \
osdk run quality-run

OMEM_QUALITY_DATASET_ID=your-frozen-dataset-id \
OMEM_QUALITY_PREDICTIONS=.omem/quality/predictions.json \
osdk run quality-evaluate
```

`quality-run` 要求 dataset 已冻结，逐样本建立隔离临时库，调用受控 extractor/verifier pipeline，并在每条结束后原子保存 predictions，支持中断后续跑。`quality-evaluate` 再读取冻结标签并输出：

- 自动应用 precision（门槛 ≥95%）
- evidence support precision（门槛 ≥95%）
- 明确样本 coverage（门槛 ≥80%）
- ambiguous/forwarded owner-task false positives（门槛 0）
- missing predictions、失败明细、p50/p95

未完成全部人工标注前，不运行或声称通过最终 holdout 门。

## 固定实现证据

- `quality/repository.ts`: `5b81d5b660183baa8d2ce9cafd3f4c87eb6c933f6c0a5be24a775df86686ebf8`
- `quality/import.ts`: `34e0a7a8eb8cb9238e6f95cec939150e9b8cad738de2a65025b14dad526689dc`
- `quality/evaluator.ts`: `59c8cd3e75cd5639619b05924b088700f751a22f2db101b46adb508334a5f5a5`
- `quality/lark-annotations.ts`: `2a9734873a3933e3fe852c68266cdd5adf717434b0f3c24752e8561d0f4ed7b9`
- `quality-annotation.test.ts`: `6a0872ba47dd911fe3b26a47aa7b6496f97a329a4e67dc3a8950fd88ae55bbe6`
- `quality-evaluation.test.ts`: `693e90f8f7c4bea8495ae2eef45bfcc680186bffbf89757fca782da64c3fbc4c`
