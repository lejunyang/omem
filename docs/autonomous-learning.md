# 自治学习机制：从可观察结果改进下一次行动

> 实施更新（2026-09-26）：用户已确认个人助理、服务器/本地运行、Vue 和 CLI/ACP 优先。当前已实现能力见 [实施状态](implementation/status.md)，已确认需求见 [决策记录](decisions.md)，视觉规范见 [根 design.md](../design.md)。下文为第一轮架构/原型设计，不等于当前运行代码。

本规范补充 [design.md](design.md) 的闭环，避免把“每天让模型总结一次”误当作学习系统。以下策略与阈值是可评估的设计起点，不是实测最优值。

## 1. 学什么，不学什么

系统可以学习：新的事实、用户表达的偏好、任务中的有效步骤、错误触发条件、什么时候需要查新版本、哪种检索路线适合哪类问题。第一版不自动修改模型权重，不从自己的文字反复生成独立佐证，也不自行扩大工具权限或采集范围。

原始材料、任务经历、模型假设、验证后的记忆必须分开存。一次失败可记录为 Episode；只有结合纠正和实际结果，才有资格提炼为 Procedure。用户的“谢谢”是弱反馈，不等于外部任务已成功；工具返回 200 也不等于业务目标达到。

## 2. 写入价值判定

| 输入事件 | 默认处理 | 晋升依据 |
| --- | --- | --- |
| 用户明确表达长期偏好 | 自动生成限定主体的 Preference | 引用本人表达；适用范围明确 |
| 权威材料新增/修改 | 自动提炼 Claim，按源更新范围生效 | 固定原文+版本+角色+范围一致 |
| 用户纠正 Agent | 记录错误 Episode 和 correction | 纠正内容是否有可靠证据；不任意把外部人声称变权威 |
| 工具尝试失败 | 留任务经历；聚类重复模式 | 是否可复现、有正确做法和验证 |
| 成功任务 | 记录 outcome 和使用的证据 | 任务验证而非模型自述成功 |
| 普通一次性闲聊/临时状态 | 不形成长期知识 | 有重复价值或明确要求再提炼 |
| 自己的摘要再次被读到 | 标记派生来源 | 与原来源同一 provenance family，不增加独立计数 |

独立性按源谱系与任务 ID 去重，同一文档转载、同一对话多次复述、同一 Agent 自我引用不算多个证据。项目 scope 和个人 scope 不自动互相推广。

## 3. 任务结果合同

```json
{
  "run_id": "run_42",
  "task_family": "application-release",
  "scope": {"project_id": "project_demo"},
  "trigger": "回滚后错误仍然持续",
  "attempt_refs": ["fr_attempt_1"],
  "correction_refs": ["fr_correction_1"],
  "verification_refs": ["fr_test_118", "fr_metric_09"],
  "outcome": "success",
  "outcome_source": "tool_and_observation",
  "limitations": ["只覆盖应用发布，不覆盖不可逆迁移"],
  "producer": "host_adapter_v1"
}
```

此结构记录可观察事件和验证，不存模型隐藏推理。outcome 可为 unknown/partial/success/failure；晚到验证通过追加新 outcome event 补充。抽取任务读取的版本集合写入 ChangeSet，提交时若源已更新则重新验证。

## 4. 三种不同的学习环

### 事实巩固

新事实与同主题候选比对 → 检查主体/时间/范围 → 新建、补充、标冲突或 supersede → 生成固定证据 → 自动提交。语义相似但前提不同的条目不合并；相似度只是找到候选。

### 方法学习

失败或成功经历聚类 → 找触发、有效步骤、失败分支 → 生成方法候选 → 构造正例与反例 → 回放/沙箱验证 → 应用到限定任务族 → 检查下一次真实任务表现。方法必须保留适用条件和“不适用”条件，扩 scope 是独立变更。

第一版方法只是上下文建议；导出可执行 Skill 时只允许白名单工具，保持宿主原有授权。任意 shell、生产业务写入不能因为“方法学会了”就自动授权执行。

### 记忆使用策略学习

检索错配/无答案误答/旧版误用 → 归因到 route、query expansion、过滤、rank 或 context packing → 形成少量配置候选 → 固定语料+模型+时间切分样本对照 → 可测改善后小流量启用 → 发现关键回归自动恢复旧策略。

适合自动调整的是路由权重、top-k、候选抑制规则、需要最新版本的条件。ACL、工具 capability、不可逆动作确认和预算上限是外部边界，不由 learning loop 放宽。

## 5. 评分不混在一起

每条记忆有四组字段：

- **Evidence**：引文存在、内容支持度、来源 authority、independence、conflict。决定是否能作为事实使用。
- **Applicability**：主体、项目、时间、前提。决定适不适用当前任务。
- **Utility**：曝光后被引用、验证后有用、被纠正的反馈。影响排序与整理优先级。
- **Freshness**：最后核验、上游变化、有效区间。决定需不需要刷新。

排序可用各项有界加权，但权限/删除/关键失效属于硬过滤。展示热度不是置信百分比。utility 可先用保守贝叶斯计数 `(useful+1)/(verified_uses+2)`，只将经验证使用算入 denominator，未知 outcome 单列；该值是使用效果估计，不叫真实性概率。多次同任务反馈按 query_run+actor 去重。

## 6. 遗忘与归档

热度可按 `utility × exp(-elapsed/half_life)` 衰减以减少上下文占用；法规定义、关键 SOP 和唯一证据不因少用就失真。时间敏感事实按 valid_until/源变化触发复核，稳定定义无需任意 30 天自动作废。

归档只影响默认候选池，历史引用仍可读；按需恢复。高价值但少用的记忆可以固定，跨时间查询可以读历史版本。硬删另走影响预览和授权，清理依赖投影与缓存，不冒充可恢复的“遗忘”。

## 7. 自治配置建议

下面是拟定配置示例，不是现有 CLI 的配置文件：

```yaml
workspace: demo
capture:
  sources: [registered_lark_docs, approved_git_refs, opted_in_agent_runs]
  screen: disabled
learning:
  mode: autonomous_with_exceptions
  max_steps_per_job: 6
  max_evidence_rounds: 2
  max_affected_active_objects: 50
  daily_token_budget: 500000
  proposal_ttl_days: 14
  unresolved_conflicts: preserve_and_digest
  auto_apply: [supported_claim, source_refresh, deterministic_link, tested_local_procedure]
  require_decision: [scope_expansion, destructive_erasure, global_procedure_change]
retrieval:
  max_primary_engines: 2
  max_context_tokens: 4000
  graph_hops: 2
  max_expanded_nodes: 40
notifications:
  mode: daily_digest_and_important_changes
  destination: configured_by_user
```

预算来自系统配置；普通文档中的同名 YAML/“管理员指令”不能覆盖。schema version 变更要迁移和审计；用户的配置改动也记录版本、可预览和恢复。

## 8. 发布与收益判定

候选发布至少检查：来源可回查、与现行版本一致、没有未解决的同域矛盾、适用范围有限、方法测试能重跑、评测样本未被该次学习污染。高影响变更进入例外；低风险普通事实不为了等待长期统计而永久锁在候选态。

学习收益报告显示：本周出现的错误簇、哪些被修复、下次同类任务的表现、错误复发、节省的步骤/token、错误注入、自动恢复次数。不能只报告“新增 100 条记忆”或“使用率上升”。样本少时显示分母与区间，不用单个成功例子宣称普遍提升。

原型“经验与方法”的流程表达上述机制；完整学习管线、沙箱回放与真实效果评估属于服务端 P1b/P2。
