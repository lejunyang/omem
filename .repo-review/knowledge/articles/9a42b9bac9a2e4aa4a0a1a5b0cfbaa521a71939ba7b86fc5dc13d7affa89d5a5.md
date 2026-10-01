# ACP 协议测试代理桩

该文件是通过标准输入输出模拟 ACP/JSON-RPC 代理的确定性测试替身，覆盖初始化、动态会话配置、文本与图片提示处理、超时、取消及权限请求取消等交互；它不是真实模型，也不能单独证明服务器测试或外部 Agent CLI 的实际覆盖范围。

来源：gpt-5.6-sol 分析，gpt-5.6-sol 独立复核；模型解释仍可被原始证据纠正。

<a id="purpose-and-state"></a>
## 用途与状态模型

该脚本让服务器无需启动真实模型即可演练协议交互：它逐行读取 JSON，向标准输出写出 JSON-RPC 消息，并明确声明自己是默认不启用的非生产测试替身。进程仅保存模型、推理强度、当前提示 ID 和权限等待标志，因此实现的是单进程全局状态，而非完整的多会话代理。[测试替身声明与进程状态 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L1 "支持该文件属于非生产协议替身，以及其通过少量全局变量维护简化状态的论断。")

配置列表随当前模型变化：初始模型为 `alpha`、强度为 `low`，切换到 `beta` 后才出现 `high`。[动态模型与推理强度选项 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L8 "支持配置选项随模型变化，以及 beta 模型才提供 high 强度的说明。") 配置写入时只单独识别 `model`，其他配置 ID 一律更新 effort，也没有值域校验；这是夹具的简化行为，不能外推为真实 ACP 实现的配置合同。[配置写入与返回逻辑 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L42 "支持仅 model 被单独识别、其他配置 ID 写入 effort 且没有值域校验的行为判断。")

<a id="protocol-flow"></a>
## 核心协议流程

初始化响应声明协议版本、代理身份、图片提示能力和关闭会话能力；新建会话固定返回 `test-session`，配置更新后重新生成选项。[初始化与固定会话响应 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L30 "支持初始化能力、固定会话标识及配置响应的说明。") 收到提示后，夹具拼接其中的文本片段：文本包含 `TIMEOUT` 时故意不响应，包含 `ASK_PERMISSION` 时则发出带 `allow_once` 和 `reject_once` 选项的权限请求，并暂停原提示。[文本拼接、超时与权限请求 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L48 "支持提示文本被拼接用于分支判断、TIMEOUT 无响应及 ASK_PERMISSION 暂停提示的流程。")

普通提示依次发送 `agent_thought_chunk` 和 `agent_message_chunk`，再以 `end_turn` 完成。消息文本在日常消息前缀场景返回固定 JSON，否则返回当前模型、强度及图片片段数量；它没有计算文本片段数量。[提示更新、文本响应与图片计数 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L72 "支持普通提示的事件顺序、固定或参数化文本响应、仅统计图片片段数量以及最终正常结束的准确表述。") `session/cancel` 会用已保存的提示 ID 返回 `cancelled`；权限响应分支也只接受 outcome 为 `cancelled`，随后发送 `Permission declined` 并结束原提示。[提示取消与权限取消结果 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L98 "支持 session/cancel 返回 cancelled，并证明权限响应分支只接受 cancelled、随后发送提示消息并结束原提示。")

<a id="coverage-and-limits"></a>
## 可验证行为与未覆盖边界

该夹具提供确定性的配置选项、文本响应、图片计数、事件顺序、正常结束、无响应超时、提示取消和权限请求取消场景。此前“提供配置、文本与图片计数”的结论已被替代：源码只拼接文本用于分支和响应内容，并仅对图片片段计数，因此准确表述应为“配置、文本响应与图片计数”。[文本拼接、超时与权限请求 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L48 "支持提示文本被拼接用于分支判断、TIMEOUT 无响应及 ASK_PERMISSION 暂停提示的流程。")[提示更新、文本响应与图片计数 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L72 "支持普通提示的事件顺序、固定或参数化文本响应、仅统计图片片段数量以及最终正常结束的准确表述。")

固定会话 ID 和固定文案便于调用方断言，但当前材料没有展示启动夹具的测试文件或断言，无法确认上述分支是否都被实际执行。分派器也未模拟多会话隔离、并发提示、错误 JSON、未知方法错误、权限允许结果或进程恢复；权限选项虽含允许一次和拒绝一次，结果处理却只接受取消。[提示取消与权限取消结果 ↗](../../../apps/server/tests/fixtures/acp-agent.mjs#L98 "支持 session/cancel 返回 cancelled，并证明权限响应分支只接受 cancelled、随后发送提示消息并结束原提示。") 因而本文件只能说明测试替身定义了什么，不能证明真实 ACP CLI 的完整合同或端到端覆盖。
