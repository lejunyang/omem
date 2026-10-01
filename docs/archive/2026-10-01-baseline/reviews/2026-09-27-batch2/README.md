# Batch 2 实现审查与产品偏差

审查日期：2026-09-27；基线：`16d3aa6`。审查重点是提炼质量、确认打扰、输入语义和飞书主入口，不是完整安全/性能审计。本轮不恢复被用户叫停的飞书标注、不重启业务 worker、不发送测试卡片、不修改运行库。

**结论：工程底座有真实实现，但目前不能作为“个人超级助理”验收。** 迁移、租约、幂等、角色包、事件收发和回调有测试支撑；价值判断、上下文保真、知识召回和主 Agent 入口仍有明显缺口。原来的产品方案也把“尽早提炼成 claim，再让用户判断”放得过重，需要调整，不能只更换模型或继续优化卡片文案。

新的目标设计见 [assistant-v3](../../implementation/assistant-v3/README.md)。

## 1. 实际检查与证据

- `osdk run typecheck` 通过。
- `osdk run test`：17 个测试文件、**90 项测试通过**；都是已有测试，不是本轮新增效果指标。
- 使用 Python SQLite `mode=ro`、`PRAGMA query_only=ON` 检查实际标注库。观察到3个同一材料的dev数据集，共120条草稿；1条confirmed、119条pending（confirmed是评测标签状态，不表示业务知识被批准）；3个annotation session均cancelled；与取消session关联的4条历史投递已delivered，没有发现这些session仍有pending标注投递。没有修改或导出业务原文/凭据。
- 抽查6个现有样本，均为 `statement == evidenceQuote == input.text`、`autoApply=true`。有的句子混合当前状态与未来可能性，有的依赖“上述”等前文。
- 新增 [隔离复现脚本](reproduce.ts) 与 [复现结果](reproduction-results.json)。使用临时 SQLite、合成材料、注入的语义verdict和假消息adapter；**没有调用模型或真实飞书接口**。它验证基线缺陷，修复后应把对应场景转成断言正确行为的生产回归测试。

## 2. 用户收到的内容为什么低价值

### F1 · P1：确认卡来自规则切句标注器，不是 AI worker 的有效提炼

位置：[quality/import.ts](../../../apps/server/src/quality/import.ts) 第49–108行；[quality/lark-annotations.ts](../../../apps/server/src/quality/lark-annotations.ts) 第94–97行。复现 R1。

导入器跳过表格/白板/图片块，按换行和标点切文本，再用“必须/只能/不支持/数字”等关键词打分选40条。所有候选被固定标为 `category=explicit`、`kind=claim`、`autoApply=true`，statement和evidenceQuote直接等于原句。没有做场景辨识、任务价值判断、上下文补齐或真实AI提炼。

标注卡再让用户同时判断“是否值得记、是否准确、是否原子、范围是否完整、是否可自动沉淀”。这把材料理解与系统设计工作转嫁给用户，确认项也没有一个实际业务问题。后来的规则缩句改善了长度，没有解决目的缺失。

**修复方向**：停止把普通导入变成人工标注任务。该功能仅保留在显式开启的研发评测模式。真实材料先变成可检索的来源和上下文，不能为了凑40条把句子变成事实。评测围绕用户问题/任务建立预期，而非逐句问“这条值得记吗”。

### F2 · P1：正式策略把“不确定”几乎统一转为“问用户”

位置：[memory/service.ts](../../../apps/server/src/memory/service.ts) 第291–334行、第395行起。复现 R4。

除了 invalid/contradicted 外，semantic insufficient、scope未知、非本人、图片推断、普通procedure等都会进入 awaiting_decision；随后直接创建决策卡。没有 defer、background_research、retain_as_source、ignore_noise，也没有当前任务相关性和打扰价值判断。

缺背景不一定能由用户补齐，且多数知识导入没有迫在眉睫的选择。当前逻辑会把“我读不懂/没证据/不知道属于哪个项目”都升级成你的待办。

**修复方向**：治理结果与通知决策分离。worker只能写候选和状态，主助手判断是否与当前任务有关、是否真需要你的选择。低价值不确定内容留在来源层，检索或使用时再澄清。

## 3. 实现正确性与主要遗漏

### F3 · P1：飞书没有可对话的主助手路径

位置：[realtime.ts](../../../apps/server/src/integrations/lark/realtime.ts) 第419–493行；[runtime.ts](../../../apps/server/src/integrations/lark/runtime.ts) 的连接/卡片/投递循环。复现 R8。

绑定以外的普通私聊在 `event.chatType !== 'group'` 分支返回 `ignored_not_allowed`。群消息进入捕获器；没有调用会话路由、Runs/主角色、检索工具或生成回复。planner role文件存在不代表它接入了机器人。当前机器人支持创建绑定、通知、采集和卡片按钮，但不能充当用户要求的主助手。

**修复方向**：建立独立 `AssistantRuntime + ConversationRouter`，已绑定owner私聊和显式@进入它；Web对话复用同一入口，管理页仍可独立操作。群内背景材料只入库，不一律回复。

### F4 · P1：输入进模型前丢失了关键语义，不能只靠 prompt 修复

位置：[inputs/aggregator.ts](../../../apps/server/src/inputs/aggregator.ts) 第178–268行；[learning/pipeline.ts](../../../apps/server/src/learning/pipeline.ts) 第173–234行；[realtime.ts](../../../apps/server/src/integrations/lark/realtime.ts) 第67–76、第471–489行。复现 R7/R8，另有静态检查。

- 聚合多个说话人的文本后，顶层actor置null，片段没有保留actor/message/time映射。原始input_events还在，但当前ContextManifest并不读取它们。两个人分别说“我负责开发”“我只负责评审”，模型看不到每句话属于谁。
- project_id直接取conversationId/runId/application，且当成trusted scope。一个群可有多个项目，多个群也可讨论同一项目，“Browser”更不等于项目。
- 飞书图片/富文本没有转换成统一多模态parts：图片消息JSON目前作为文本入库；“支持图片输入”的API测试不能证明飞书图片链路已接通。
- 飞书事件把quoted/forwarded固定false，context缺少足够的引述关系；应用事件时间与具体消息原始时间也需区分。

**修复方向**：先做EvidenceEnvelope v2，保留逐消息/逐片段的provenance。来源载体、话语类型、项目/主题候选与用户意图分开；unknown不能被伪装成trusted project。图片先解析key、经权限下载为asset，再送模型；失败显示资源缺失。

### F5 · P1：复核不看已有知识，新建路径没有语义冲突/重复检查

位置：[learning/pipeline.ts](../../../apps/server/src/learning/pipeline.ts) 第234行 `related_memories: []`；[memory/service.ts](../../../apps/server/src/memory/service.ts) 第263–288行；proposal digest包含每次生成的ID/origin。复现 R3。

在合成测试里，两个相反的、各自有原文支持的create提案都auto_apply；同一事实换proposal ID后再次create，也会新增active memory。这里使用注入supported verdict，证明领域层没有查重/关联现行知识，不证明真实模型必然会犯同样错误。

不同来源的矛盾可以作为“来源声称”并存，问题在于现在没有标示分歧、支持集合和已知等价关系，verifier也没有相关上下文。不能将“发生在不同source的update需确认”当作完整冲突检测。

**修复方向**：先召回同实体/主题/时间的原件与知识，再决定新建、关联、补证、保留分歧或替代；source_attributed、verified_fact、accepted_decision分开。相同文本不同来源不合并原件，等价结论可以共享概念并保留多份证据。

### F6 · P1：质量指标会把不支持的结论算作证据支持

位置：[quality/evaluator.ts](../../../apps/server/src/quality/evaluator.ts) 第64–73、第121–125行；[quality-evaluation.test.ts](../../../apps/server/tests/quality-evaluation.test.ts)。复现 R2。

`evidenceSupport`只检查引文是否为输入子串。即使statement与引文矛盾，指标仍为1；objects为空时`every()`也为true。其他exact/autoApply指标可能同时失败，因此不能说“整个发布门可任意绕过”，但95%支持度这一独立指标没有表达它宣称的含义。

同时exact match逐字比较statement/evidenceQuote，会惩罚正确改写而奖励照抄；现有评估测试直接把confirmedLabel拷成prediction，只验证管道与计数，不能检验语义区分。quality-run把观察时间改成运行时“现在”、source改manual，也无法稳定检验历史日期/来源类型。

**修复方向**：分别测引用定位、语义支持、核心事实槽位、必要证据覆盖、用户任务完成和不必要打扰。增加反向陈述、缺条件、空答案、同义改写、转述和旧时间反例；没有eligible分母时输出null。评测label保持独立，用户反馈不变成照抄目标。

### F7 · P2：真实飞书身份与canonical owner未统一

位置：[realtime.ts](../../../apps/server/src/integrations/lark/realtime.ts) 第480行；[memory/service.ts](../../../apps/server/src/memory/service.ts) 第249–260行。复现 R5。

飞书捕获存ou_*，任务自动应用却要求actorId和body.owner_id均等于默认字面量owner。真实绑定用户的明确承诺也可能被降为owner_not_verified，从而反复问本人。现有正例用actorId='owner'，没有覆盖真实映射。

**修复方向**：用已绑定app/tenant/open_id解析canonical principal，保存两种ID和binding版本；不得把其他群成员也归为owner。

### F8 · P2：原始Agent会话被统一跳过，刷新任务空执行却成功

位置：[store.ts](../../../apps/server/src/store.ts) 第337–357行；[learning/pipeline.ts](../../../apps/server/src/learning/pipeline.ts) 第102–110行。复现 R6/R9。

source='agent'时即使producerKind='original'也不入处理队列，阻止了从主动导入的原始Agent会话中学习；应该按原始/派生产物区分，不能只按载体区分。refresh_dependents仅返回revision ID，任务标succeeded，旧memory仍invalidated；失效保护是好的，但不能当作已经完成重核验。暂不支持应有明确blocked/not_implemented状态。

### F9 · P1：取消标注session没有撤销尚未发出的卡片

位置：[quality/lark-annotations.ts](../../../apps/server/src/quality/lark-annotations.ts) 第151–160行；[delivery.ts](../../../apps/server/src/integrations/lark/delivery.ts) 第190行起。复现 R10。

在临时库先排队标注卡、立即cancel session，再运行假sender，仍调用send一次。cancel仅更新session，delivery认领/发送没有检查annotation session状态。本轮真实库只发现已投递历史卡，没有发现取消session待发的卡，因此不声称用户停止后已经实际收到新增卡。

**修复方向**：cancel事务同时取消未发送intent，sender发送前检查session/version和撤销标志；正在网络调用的请求明确无法保证撤回，记录可能已送达。此项应在任何重新开启标注前修复。

## 4. 次级静态问题和验证边界

- `verify()`逐条调用MemoryService.evaluate且不传impactCount，后者默认1；批次大范围门槛只在测试显式传impactCount时覆盖。后续以ChangeSet计算受影响实体总数，不能只相信调用方填的数字。
- Context预算以字符数/4估算，混合中文、代码和多模态需更保守预算；没有结构分包时整份长文失败不应转而要求用户逐句审阅。
- docs/status中顶部“尚未实现”和末尾“已实现”相互混杂，尤其支持度/源失效/飞书装配，接手者应以代码和逐项报告为准。后续拆能力矩阵，避免只追加日志。
- 本轮未复测真实飞书平台注册、网络断线、secret轮换或模型效果；没有改变群监控范围。另一Agent若已获得用户对“入群即监控”等授权，不能仅凭旧文档把该行为定为越权。

## 5. 可以保留的工作

保留现有SQLite迁移、固定原件/片段、job lease/fencing、事务application receipt/outbox、role bundle校验、Lark secret/binding/事件/投递基础设施、Vue证据阅读组件。这些不是废代码。

重做的是**入口与策略层**：主助手先理解用户目的；worker先保证材料可用和上下文保真；深度知识整理由使用/任务/变更触发；只有与真实选择有关的问题才由主助手提出。不要为了让旧的90个测试继续绿而保留“任何不确定就问人”的错误预期，应修改这些预期并增加本报告反例。

## 6. 复查方式

```bash
osdk run typecheck
osdk run test
osdk exec --tool node -- npx tsx docs/reviews/2026-09-27-batch2/reproduce.ts
```

最后一条只创建临时库和假发送器，使用合成输入，退出清理临时目录。它断言16d3aa6的已知缺口，**不能并入常规CI来要求这些缺口继续存在**；修复时将案例改写为v3中G01～G20的预期行为。修复后的复现脚本断言失败可能说明缺陷已消除，需要按实际输出判定。

本轮文档检查：128个局部文件链接均存在，20个v3场景编号连续唯一，复现结果含10个唯一案例。只提交docs；没有运行新的真实Agent/飞书验收、没有安装MemPalace或改动应用配置。
