# 合同样例与校验边界

这些文件是 batch2 待实现合同，均为虚构验收数据；不能直接调用现有 API 或填入当前严格 omem.local.json。

- context.json：可信采集上下文 + 不可信材料。fixture alias 由测试 harness 映射为真实的 SourceRevision/FragmentRevision；身份元信息由认证 receipt 生成，不接受客户端正文自报。
- proposal.json：从该上下文提炼的 task 候选；不是已批准或已生效任务。
- proposal.schema.json：Proposal v1 起稿，task/claim/episode/procedure 的严格 body 与 text/image evidence。runtime 仍必须校验引文、范围、日期、target/read_versions 和资产存在性；JSON Schema 验证不等于支持度验证。ProposalBatch/AssessmentBatch/CorrectionProposal 的完整 schema 由 B2-01/B2-03 按文档实现并评审。
- role-manifest.json：角色包配置起稿；输出 schema 名称、skill digest 和实现路径需由构建器解析。skillBundles 的实际 Skills 由实现 Agent 创建，本轮只交付方法要求与提示词起稿。
- lark-registration.json：registerApp 的可序列化选项；callback/signal 由后端注入，不含任何凭据。最小权限是否生效要平台确认与实际探测。

本例 observation 是 2026-09-22 16:00 Asia/Shanghai（星期二），原文“本周五18:00前”对应 2026-09-25 10:00 UTC。截止时间解析结果必须保留时区/观察时刻和原词。引文30个Unicode码点，selector采用[0,30)。
