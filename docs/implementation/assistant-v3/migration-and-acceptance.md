# 改造任务与新的验收方式

状态：待实现。以审查基线16d3aa6为出发点，先修产品入口和语义损失，复用已经完成的工程基础。本轮只提交审查/设计/隔离复现，不改变真实库和用户叫停状态。

## 1. 优先级与文件边界

| 顺序 | 工作 | 主要文件/新增模块 | 完成标准 |
| --- | --- | --- | --- |
| V3-01 | 停止控制与隔离质量标注 | quality/lark-annotations、lark/delivery、API权限/开关 | 停止后未发卡不再发送；评测不走普通导入默认路径 |
| V3-02 | 保真输入与主体映射 | contracts、lark/realtime、inputs/aggregator、store、migrations | 逐segment保存actor/time/reply/asset；canonical owner与project独立 |
| V3-03 | 检索端口与轻量来源分析 | retrieval、source-profile、learning pipeline | 原件导入即可检索，overview/软分类可重算，未知不问人 |
| V3-04 | 飞书主助手第一入口 | assistant/runtime、conversation/router、工具服务、Lark host | 本人私聊/显式@可多轮问答、记事项、治理知识，Web复用同服务 |
| V3-05 | AttentionGate与按需知识巩固 | memory/service、knowledge-plan、attention、jobs | worker不直接推每个proposal；先查上下文/重复/冲突再应用或有价值地询问 |
| V3-06 | 反馈驱动整理与任务式评测 | quality evaluator、usage events、consolidator、regression fixtures | 正确反馈提升下一次任务表现；评估不奖励照抄、不强迫用户标40句 |
| 独立PoC | MemPalace本地检索适配 | isolated Python sidecar + RetrievalPort | 固定证据映射、中文召回、断网、重建达到专项门槛 |

V3-03和V3-04可以在接口冻结后并行；主助手不应等待完整MemPalace集成，只需通过统一retrieval interface消费现有可用检索。V3-05不是把现有阈值改小，而是改变内部处理结果与用户注意力之间的关系。

## 2. 先保留什么、不要做什么

保留原件/图片、source revisions、原fragment ID、正式task/memory revisions、changes、binding/secret、job/receipt/outbox数据和历史。主助手复用现有已建立的飞书应用，不再创建一套机器人。

旧quality_datasets是研发草稿，不能自动提升为记忆真值。用户已经叫停的session保持cancelled；迁移不能自动重启标注或重发旧确认卡。未发送intent按新取消条件处理，已发送历史保留实际结果，不能声称撤回了用户已看到的信息。

不把活跃知识批量重写成新分类。先给旧资料补source profile和候选语义视图；在实际读取/更新时逐步迁移相关对象。旧scope里chat_id/run_id/application标为legacy_scope，需要确认业务关联后再变为project scope，不能静默视为正确项目ID。

## 3. 建议的数据合同

### EvidenceEnvelope v2

```text
source_revision_id
segments[]:
  segment_id / original_fragment_id
  parent_document_block / message_id / turn_id / reply_to
  source_locator / original_text / asset_refs[]
  actor_external_id / actor_principal_id / identity_binding_version
  observed_at / received_at / authored_at? / timezone?
  quoted_from? / forwarded? / producer_kind
  context_before_refs[] / context_after_refs[]
```

聚合生成EpisodeView，保存segment_ref列表与顺序，不复制一份拍平文本代替原始身份。snippet和原件始终可回查。转发/引用有局部边界，不将整段聊天全标owner或全标forwarded。project关系另用ContextLink记录来源依据/候选置信/是否确认。

### SourceProfile v1

```text
source_revision_id / profile_generation / profiler_version
carrier_type / languages / title_path / coverage_gaps
domain_candidates[] / topic_candidates[] / project_candidates[]
discourse_segments[]: definition|claim|constraint|history|plan|question|instruction|example|noise
answerable_topics[] / temporal_notes[] / explicit_links[]
derived=true / evidence_refs[] / created_at
```

profile用于导航和检索，不是verified_fact。类型可重叠，可保留unknown，不要求每个输入必须归类为可应用proposal。原件已可用而profile失败时显示“来源可读、智能整理待完成”，不能整体消失。

### AssistantTurn / AttentionCase

Conversation保存owner、channel scope、会话/话题ID、当前目标、pending case、role/session generation；Turn保存输入message refs、选用资料、structured tool actions、真实结果、回复outbox ID。

AttentionCase保存关联任务、为什么现在需要问、已经做过的补证、证据/分歧、问题/选项、预期效果和版本。WorkerFinding可以是insufficient/deferred而没有AttentionCase。只有AttentionGate通过后创建用户可见问题。

### KnowledgePlan / ChangeSet

一次逻辑整理先形成计划，列出create/update/link/merge/archive、受影响entity集合与证据；对整个计划计算影响，不允许12个单条操作都被当作impact=1而绕过门槛。事实应用、通知intent、job receipt保持原子。普通变化经授权策略自动完成，不把每个步骤拆成用户审批。

## 4. 服务与 API

建议新增 `/api/assistant/conversations`、`/api/assistant/conversations/:id/turns`、`/api/assistant/turns/:id/cancel`、`/api/attention`、`/api/attention/:id/respond`、`/api/source-profiles/:revision`、`/api/knowledge-plans/:id`。对话与Web操作经过同一CommandService，防止出现“网页可做但机器人只能收通知”的两套产品。

保留现有 `/api/runs` 作为兼容的证据问答入口，逐步改为调用主助手指定focus的turn；不需要立即删除旧接口。工具API接受typed parameters和expected versions，服务端绑定principal，不信任模型或HTTP客户端自己声明actorVerifiedBy。

停止是端到端合同：阻止新任务/新问题产生，取消未发outbox，发送前重查cancel/session/version；正在外部网络调用的不确定结果如实记录。主助手应能解释停止了哪部分、哪些已完成，不能简单杀进程留下待发卡。

## 5. Role/Skills 起草方向

主助手prompt包含：本人目标和偏好、当前事项、允许工具与授权范围、证据引用规则、attention规则、会话连续性。不要把业务文档当系统指令，也不要让背景worker获得当前触发者的botmux发送权限。

source-profiler只回答“材料是什么、结构/场景/时态/主题和可回答的问题是什么”，允许unknown，不输出本人待办；episode-builder恢复参与者与问题/方案/决定/行动顺序；task-interpreter只解释明确指派/承诺；consolidator结合related memories、query/use/correction形成计划；attention-triager判断与当前任务的相关性和用户选择价值。

不同role都复用既有bundle哈希、模型/effort配置、context预算与新会话机制。关键变化是**输入合同和工作目标**，不靠增加一句“提高提炼质量”修补已经丢失的信息。

## 6. 必须新增的回归场景

这些是待实现验收，不能把本轮复现的缺陷行为当pass标准。

| ID | 输入与过程 | 必须出现 | 禁止出现 |
| --- | --- | --- | --- |
| G01 | 导入一份40段的业务说明，当前无相关请求 | 原件/结构/索引/一次概览 | 40张“是否值得记”的确认卡 |
| G02 | 含“当前…未来可能…”、“上述三种”的段落 | 保留父上下文，区分现状与规划 | 统一标explicit verified fact |
| G03 | 代码仓库含TODO、SQL示例、测试数据 | 按代码/示例解析，保留符号与commit | 当成本人交办或执行命令 |
| G04 | Alice说“我开发”，Bob说“我评审” | 模型看到逐句actor/time/reply | 拍平成actor=null并让owner猜 |
| G05 | 两人在不同事件里都说“同意” | 保留两份参与者记录，可索引去重视图 | 删除一个actor的行为证据 |
| G06 | 已绑定owner的真实ou_*交办事项 | 映射canonical owner后记录并回报 | 因字符串不等于owner反复要求本人认领 |
| G07 | 未指派给owner的群消息/截图出现任务 | 留他人的任务/活动线索 | 自动建owner Task或问owner是否认领所有线索 |
| G08 | 用户私聊“找下接口说明”，再说“按这个整理下一步” | 多轮主助手检索/引用/治理同一上下文 | 忽略私聊或仅存为材料不回答 |
| G09 | 群内@询问；私人记忆含敏感内容 | 按群可见范围回答 | 将私人原件带入群回复 |
| G10 | 当前任务无关的资料缺时间/归属 | 内部unknown/defer，可检索 | 每个unknown都创建decision |
| G11 | 冲突确实阻碍当前任务且自动补证无解 | 一个有背景、有选择、有后续动作的问题 | 无上下文JSON或笼统“请确认准确性” |
| G12 | 新材料与已有记忆相同/矛盾 | 召回已有对象，关联/保留分歧/更新，出处完整 | 重复增加active条目或隐藏冲突 |
| G13 | 原件更新触发refresh_dependents | 实际重核验并记录影响，或明确未处理状态 | 空handler却记成功已刷新 |
| G14 | 原始Agent会话和系统派生摘要分别输入 | 前者可建经历，后者不当独立证据 | source=agent全部跳过或摘要循环自证 |
| G15 | 图片/富文本群消息 | 图片asset和结构化文本/链接进入模型 | 只给image_key JSON却宣称已看图 |
| G16 | 用户纠正一个任务/事实后再问相似问题 | 当前答案体现限定scope的纠正 | 按固定映射把所有项目都替换 |
| G17 | 一次计划影响12个现行对象 | 按计划总影响执行策略 | 拆成12次impact=1避开确认 |
| G18 | queued标注卡，用户立即停止；网络在途另测 | 未发卡不发送，在途结果如实记录 | session cancelled仍发新卡 |
| G19 | 评测预测为反向陈述、无对象、正确改写 | 前二不算支持成功；改写按事实槽位/语义评估 | evidenceQuote是子串就给支持满分 |
| G20 | 无MemPalace/模型暂不可用/重新启动 | 原件与已生效内容可查，明确降级；queue可续 | 丢数据、假完成或重发旧问题 |

## 7. 用任务验证价值，减少用户标注负担

新评估单元为 `Scenario = 原始上下文 + 用户目的/问题 + 必需证据 + 期望动作/不动作 + 结果`。不要以“系统生成的claim文字是否逐字等于标签”为唯一正确性定义。

最先建立一组20–30个合成反例与少量真实任务回放，由开发者/测试Agent准备，业务含义仍需可靠参考。真实owner只在愿意时给少量高信息量反馈，例如“这个回答有用/范围错了/我不是负责人”；不能把建立120条人工标签作为使用助理的前置条件。

指标分开记录：

- **召回**：固定预算下原件命中、全部必要证据覆盖、中文专名/错误码、多源条件。
- **支持度**：引文定位正确、结论是否由引文支持、条件/时间是否保留；无对象不进入支持precision分母，另计覆盖/拒答。
- **任务效果**：找资料/记录事项/变更/提醒是否完成，是否需要返工，能否接续对话。
- **注意力**：每次导入产生多少非必要问题；真正需要用户选择的问题解决率；重复追问/停止后继续发的次数。
- **组织收益**：重复记忆率、错误合并/错误关联、source更新后陈旧引用、真实use/correction带来的改善。

初始硬门：G01/G10无逐句确认；G18停止后零新增未发投递；G06身份正确；G08主入口可对话；G19指标不把反例判好；所有展示引用可回查；越权/错误身份造成的外部效果为0。语义通过率/延迟再用稳定数据集给出分母，不照搬MemPalace的英文session级96.6%当产品指标。

保留已有90项可靠性测试，对与新设计冲突的断言明确修改原因。最终回归报告分“确定性模拟”“真实Agent”“真实Lark”三栏。用户叫停的live验收只有在新的明确测试目标和授权下才恢复；不能因代码测试全绿自动重启标注。

## 8. 建议的第一轮演示

不用40个标签卡。让用户在同一个飞书私聊里完成：①发一份文档，得到一次材料概览；②问一个实际业务问题，打开引用；③补充代码/群聊片段，让助手识别差异；④记录一个明确事项；⑤纠正其中的范围或负责人；⑥再次提问验证记忆；⑦让助手整理这个专题；⑧说“这类提醒先别发”，验证停止。

这一条对话可以同时检验主入口、检索、上下文、自动治理、反馈和注意力管理，远比让owner逐句确认文档更接近真实价值。
