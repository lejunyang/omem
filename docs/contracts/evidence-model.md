# 证据、版本与递归引用契约

本文件为设计合同 v0.1，字段示意用于实现评审，不是已发布 API。前端、检索、导入、记忆引擎必须共享此合同；禁止把外部框架的 chunk ID 当全局证据 ID。

## 1. 对象与身份

| 对象 | 身份与关键字段 | 不变量 |
| --- | --- | --- |
| Source | `tenant_id, source_id, connector_id, external_key, canonical_uri, current_revision_id, acl_policy_id` | URL 可变；ID 不随 URL/标题变化；同 connector/external_key 在 tenant 内唯一 |
| SourceRevision | `revision_id, source_id, upstream_revision, raw_hash, normalized_hash, object_keys, fetched_at, parser_version, normalization_version` | 内容不可变；解析器升级产生新的规范化修订，不冒充上游改稿 |
| Fragment | `fragment_id, source_id, logical_locator` | 跨修订的逻辑身份；由结构锚点匹配，不仅靠正文 hash |
| FragmentRevision | `fragment_revision_id, fragment_id, source_revision_id, ordinal, locator, text_hash, normalized_text, quality` | 一个确切版本的可引用材料；正文不原地编辑 |
| Memory | `memory_id, kind, subject, scope, current_revision_id` | Claim/Procedure/Preference/Episode 的稳定身份 |
| MemoryRevision | `memory_revision_id, memory_id, body_ast, assertions, status, valid_time, created_at, producer, evidence_policy` | 保留历史修订；状态通过事件与当前投影表达 |
| ArticleRevision | `article_revision_id, article_id, body_ast, assertion_bindings` | 面向阅读的文章编排；句子/段落绑定主张和引用 |
| ReferenceEdge | `edge_id, from_node_revision, from_selector, to_node_revision, to_selector, type, provenance, status` | 有方向、有版本、有建立原因；可从两端查 |
| EvidenceAssessment | `assessment_id, claim_revision_id, evidence_refs, verdict, validator_version, reason_code` | LLM 判断与引文存在校验分开；历史结论不覆盖 |

实现用 UUIDv7/UUID 等统一 ID，示例中的 `fr_policy_r7` 仅便于阅读。PK/FK 必须带 tenant，不能仅依赖应用层过滤。统一 `node_revisions` 注册表为 fragment/memory/article 修订提供外键目标，类型扩展表 1:1 关联，避免没有约束的多态字符串引用。

源内容变化后 Fragment 是否延续：优先 upstream block ID/代码 symbol + 文件身份；再结构路径+邻域文本；最后唯一 quote/hash 匹配。存在重复段落或大幅改写时生成新 Fragment 并记录 `possible_successor`，不偷偷选一个。稳定身份解决“追踪同一段”，固定修订解决“打开当时那段”。

时间采用双轴：`valid_from/valid_to` 表示材料声称事实在何时生效，`recorded_from/recorded_to` 表示系统何时获知/修正该说法，区间均为半开。追加修订和事件，派生当前时间视图；未知有效期必须保留 unknown，不能用抓取时间冒充业务生效时间。`as_of_valid` 问“当时什么有效”，`as_of_recorded` 问“我们当时知道什么”，二者可以组合。比如 9 月 26 日补录一份 9 月 20 日生效的规范，不应篡改 9 月 21 日回答曾基于旧材料的历史。

## 2. Locator 与文本选择

共同结构：

```json
{
  "kind": "lark_block",
  "source_revision_id": "sr_release_r7",
  "native": {"document_token": "example", "block_id": "block_rollback"},
  "text": {
    "normalization": "omem-text-v1",
    "offset_unit": "unicode_codepoint",
    "start": 0,
    "end": 20,
    "exact": "发布前必须确认回滚方案和负责人已经到位。",
    "prefix": "",
    "suffix": ""
  }
}
```

上例 exact 共 20 个 Unicode 码点；实际提交时范围应由程序计算，不允许直接信任客户端给的范围。服务端必须验证 `text[start:end] == exact`。生产 JSON 示例/fixture 由 schema builder 生成，避免手算位置。范围采用半开区间 `[start,end)`；浏览器 DOM Range 是 UTF-16，需要转成码点；表情、组合字符、全角字符都有回归样本。`normalization` 对应不可变的规范化结果，不能每次显示时用不同清洗规则重新计算。

| 类型 | native locator | 展示/降级 |
| --- | --- | --- |
| 飞书/HTML/Markdown | block ID / AST node path / heading path + ordinal | 显示原文块并高亮，缺块用固定快照 |
| PDF/图片 | page + bbox + OCR text range + coordinate system | 原页裁片/高亮；OCR 不确定显示质量提示 |
| Git | repo ID + commit SHA + path + blob hash + line range + symbol | 固定 commit 代码；行号不是跨版本身份 |
| 聊天/轨迹 | conversation ID + message/tool span ID + sequence | 发生时间、参与者、可展开前后上下文 |
| 音视频 | asset revision + start_ms/end_ms + transcript span | 播放到时间段；ASR 文字和原音轨分别保留 |

人工摘录/圈选也生成 selector，保留上下文 prefix/suffix。自动匹配失败状态为 `anchor_unresolved`，提供打开完整材料，不以最相似段落冒充原文。

## 3. 关系语义

| type | 方向 A→B 的含义 | 可否当事实支持 |
| --- | --- | --- |
| contains | A 包含 B | 否，结构关系 |
| references | A 明确提到了/链接到了 B | 否，仅证明引用存在 |
| derived_from | A 的内容由 B 提炼/生成 | 否，生成来源不等于结论正确 |
| supported_by | A 的原子主张受到 B 支持 | 是，但需有效的 EvidenceAssessment |
| contradicted_by | B 与 A 的主张相冲突 | 作为冲突提示 |
| supersedes | A 在确定范围/时间取代 B | 不自动跨范围取代 |
| related_to | A 和 B 语义相关 | 否，仅用于导航/候选召回 |
| depends_on | A 的有效性/执行依赖 B | 用于变更影响分析 |

边至少记录：`method=parser|user|model`、`producer_version`、`origin_event_id`、可解释引文或结构事实、校验状态。LLM 自动发现的候选显式引用，只有在 A 正文存在引用标记/可定位语义表达时才能确认为 references；其他保持 related_to。支持链不能靠“引用的引用”自动传递：A 引 B、B 引 C，不等于 C 支持 A 的全部结论。

多来源支持使用 EvidenceSet/Group：某个主张可能要求 `all_of`（联合证据）或 `any_of`（独立支持）。不能因剩余一个来源可读就暴露依赖另一个私有来源的摘要。

## 4. 精确引用协议

```json
{
  "citation_id": "cit_answer_42_1",
  "from": {"node_revision_id": "ar_answer_42", "block_id": "answer_p2"},
  "to": {"node_revision_id": "fr_policy_r7", "selector_id": "sel_release_gate"},
  "edge_type": "supported_by",
  "assessment_id": "ea_318",
  "display": {"label": "发布规范 §3.2", "ordinal": 1},
  "resolver_url": "/v1/evidence/fr_policy_r7?selector=sel_release_gate"
}
```

Citation 本身不带访问令牌，读取时重新鉴权。URI/哈希不作为授权凭据。网页内部引用用普通可聚焦链接/按钮承载，fallback href 指向固定版本的阅读页。复制链接只复制定位信息，接收方仍需权限。

`GET /v1/evidence/{node_revision_id}` 返回原文/渲染结构、selector 高亮、当前与最新版本指针、outgoing/backlinks 页游标、状态和验证摘要。首次只返回一跳、默认每页 20 条。边端点不能直接返回目标无权访问的标题/摘要/计数；如连对象存在性也不可公开，合并返回 `not_available`。

状态枚举与 UI：

- `available`：显示固定原文、版本和引用。
- `superseded`：保留历史原文，上方可查看新版本/差异；不是自动重定向。
- `restricted`：仅在对象存在性可披露时显示“需要访问权限”；否则 `not_available`。
- `deleted`：对象已被删除且允许披露删除事实，显示 tombstone；不能用缓存绕过。
- `temporarily_unavailable`：上游离线，有权读取的快照可显示其同步时间。
- `anchor_unresolved`：能显示整份材料，但不伪造精确高亮。
- `low_quality`：OCR/ASR 等质量不足，提示对照原件。

## 5. Trace Session：无限层级的 UI 状态

```ts
type TraceFrame = {
  nodeRevisionId: string;
  incomingEdgeId?: string;
  selectorId?: string;
  scrollTop: number;
  localQuestionDraft: string;
  activeTab: 'excerpt' | 'context' | 'backlinks' | 'versions';
};
type TraceSession = {
  traceId: string;
  rootArticleRevisionId: string;
  frames: TraceFrame[];
  cursor: number;
  returnFocusKey: string;
};
```

点击正文引用建立 frame；点击弹窗内引用 push；返回 pop/cursor 回退；面包屑跳至任意已访问位置。分支从当前 cursor 截断前进历史，但旧分支可在最近记录找到。深链 URL 保存 trace ID，服务端按用户会话保存路径；不把整条可无限增长的路径放 querystring。

循环检测依据 `(node_revision_id, selector_id)`；遇环提示回到之前 frame。body 虚拟化，只保留当前正文、邻近摘要与 path；前端缓存 LRU 默认 30 个节点，路径条目不随正文缓存淘汰。每次网络请求有条数/大小/超时上限，不对用户逐步深入次数设产品硬上限。默认最多预取一跳、10 个目标，禁止无界抓整张图。

键盘：Tab 留在当前 dialog；Esc 返回一层，根层 Esc 关闭；“关闭全部”显式关闭；返回恢复滚动/焦点；读屏播报当前层数。桌面 dialog 内可展开当前片段问答，底层文章和全局问答保持状态。移动端全屏层级页，保留同样返回语义。

## 6. 原位追问与答案固化

`POST /v1/answers` 提交 `question, thread_id, focus_ref, selection_ref, scope, as_of, max_context_tokens`。`focus_ref` 固定当前 frame；scope 只能取本段、当前材料、当前引用路径、授权知识库之一，默认本段+必要的直接证据。扩大范围必须在界面明确展示。

服务端重新读取当前身份能访问的片段，不信任客户端附带全文/ACL。路径只是用户意图，不强制把所有 ancestor 全塞给模型。context builder 优先选中片段、直接支持、冲突、必要定义，长链需压缩时保留原始 reference IDs。

流式输出事件：`answer.started → answer.delta* → citation.proposed* → citation.verified* → answer.completed`。生成中的引用标记为“核对中”；完成后每条至少通过目标可访问、selector 存在、版本一致校验，支持度另记 assessment。无法核对的陈述显示证据不足或删去，不能以伪编号补齐。

回答成为 AnswerRevision；用户选择“沉淀为知识”或自治价值判定通过后，作为 derived_from 回答的候选，同时挂回原始证据。回答→回答的自循环不增加独立证据计数。原位新回答中的引用可继续打开 frame；回答属于创建它的焦点，切换 frame 不混用会话上下文。

## 7. 更新、撤权和删除

更新：旧 snapshot 不改；建立新 SourceRevision，完成片段匹配和依赖影响标记后推进 current pointer。引用旧版本永远打开旧版本，并提示最新版本。

撤权：更新 acl epoch；缓存键至少含 tenant/principal/acl epoch，所有返回/生成前重新检查；正在流式回答发现权限失效即停止受影响后续内容并标记失效。已经发送到外部渠道的内容不能技术上自动撤回，产品不能承诺历史泄露可由回滚抹去。

删除：soft archive 与 physical erasure 分开。被引用对象的硬删需列出依赖、保留允许的 tombstone/无正文审计。敏感原件删除后清理向量、框架副本、缓存和导出副本的可管理范围；备份有保留期与加密密钥销毁策略。不可变审计不保存必须擦除的敏感正文，只保留对象 ID/摘要 hash/动作事实。已物理擦除的原件不提供“恢复”按钮。

## 8. ChangeSet 与恢复

ChangeSet 包含 `id, actor, trigger, policy_version, read_versions, operations, evidence_refs, risk, expected_heads, before_refs, after_refs, idempotency_key, status`。`proposed` 不等于 `applied`；待判断不写事实变更事件。

提交事务：校验主体与策略 → 锁目标/检查 expected_heads → 写新修订 → 更新 heads/边 → 追加不可变 AppliedEvent → 写 outbox → 提交。事件与当前状态同 PG 事务，避免“日志显示成功但事实没改”。大批变更按可独立子集分组并展示部分完成，不能伪装全局原子。

恢复生成新 ChangeSet，引用 `compensates_change_set_id`。若目标 head 仍是该变更产生的 head，可直接恢复之前的内容为新修订；若已有后续修改，返回 `409 REBASE_REQUIRED`，展示差异并按字段/依赖重算；不能强制把整个对象倒回旧快照。恢复后重新投影、失效受影响的摘要/方法，不重放历史外发消息或外部业务操作。
