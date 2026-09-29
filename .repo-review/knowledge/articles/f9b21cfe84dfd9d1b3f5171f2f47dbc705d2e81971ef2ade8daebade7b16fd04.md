# Lark 人工质量标注会话

通过持久化投递意图发送逐条标注卡片，并对回调的会话、操作者、消息、有效期、标签摘要和 nonce 做联合校验后原子推进数据集。

来源：gpt-5.6-sol 分析，gpt-5.6-sol 独立复核；模型解释仍可被原始证据纠正。

<a id="session-delivery"></a>
## 会话启动与卡片投递

服务把质量仓库中的下一条 pending 样本渲染为 Lark 卡片，展示原文、草稿处置、提炼对象和四项人工判断，并提供确认、不提炼、需修改、稍后处理四种动作。按钮携带协议版本、session/sample、nonce、label digest 和过期时间。[质量标注卡片协议 ↗](../../../apps/server/src/quality/lark-annotations.ts#L42 "支持卡片展示内容、四种操作及按钮所携带安全字段的说明。")

启动时若同一数据集已有 active 会话，默认返回重复结果；显式 resend 会轮换 nonce，并新增 change 与 delivery intent。新会话必须找到 personal workspace 中 active 的 owner p2p target，随后在同一事务内创建 session、变更记录、待发送意图及关联表行。[标注会话创建与重发 ↗](../../../apps/server/src/quality/lark-annotations.ts#L180 "说明 active 会话去重、重发行为、owner target 选择和投递意图持久化。") 该模块本身不直接发送网络请求，而是把卡片载荷交给投递意图链路。取消会话时只原子撤销尚未发送或等待重试的意图，已发送及正在发送的历史不会被伪装成已召回。[取消与未发送意图撤销 ↗](../../../apps/server/src/quality/lark-annotations.ts#L151 "解释取消只撤销 pending/retry_wait 投递，保留已发送和在途历史。")

<a id="callback-validation"></a>
## 回调校验与状态推进

回调仅接受 `card.action.trigger`，先通过事件 inbox 持久化和去重。动作必须符合严格 schema，随后联合检查 active session、当前 sample、绑定 owner、chat、message、app、有效期、label digest，以及经 constant-time 比较验证的 nonce hash；任一不符都会把 inbox 标为 failed 并返回无效提示。[Lark 回调联合校验 ↗](../../../apps/server/src/quality/lark-annotations.ts#L355 "支持事件去重以及操作者、消息、有效期、摘要和 nonce 的完整校验链。")

合法动作在事务内调用仓库落标签、写 annotation event、将 inbox 标为 processed、取得下一条 pending 样本，并轮换 nonce、推进 session；无下一项时转为 completed。[标注事务与下一样本推进 ↗](../../../apps/server/src/quality/lark-annotations.ts#L395 "说明落标签、事件审计、inbox 完成和会话状态更新在同一事务中发生。") 边界上，`needs_edit` 只改变状态，卡片没有直接编辑标签的表单；后续修改依赖仓库的 revise 能力或其他界面。材料也未给出 Lark API 投递成功、重复回调窗口及并发点击的测试断言。
