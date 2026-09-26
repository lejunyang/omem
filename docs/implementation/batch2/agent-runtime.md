# ACP/CLI 运行包：提示词、Skills 与工具必须配套

状态：待实现。**ACP 是传输与会话协议，不会自动赋予 Agent 正确的记忆治理方法。** 每个认知任务需要版本化角色提示词、合适的 Skills、明确工具范围、输入背景和严格输出合同；这些与模型/effort 是不同维度。

## 1. 当前基础和需修改的入口

基线 `agents.ts` 能 initialize/new/set_config_option/prompt/cancel/close，且 `_meta.trae.options.skills` 取 profile.skills，`mcpServers` 清空。它只选择已发现的 canonical skill 名称，**不会安装该技能**。`config/omem.example.json` 的 skills 默认为空，`Runs.start()` 也只是把 instructions 拼进普通 prompt，尚无角色/skill 版本管理。

当前 `agentCwd` 是数据目录下的 agent-workspace；项目开发用的 `omem-design/osdk-guide` 不应该被自动作为后台提炼技能注入。需要新增 runtime bundle 管理器，而不是给 profile 填几个不存在的 skill 名称。

## 2. 角色划分

这些是逻辑角色，可复用同一 CLI/模型进程，不要求同时启动多个自主 Agent。

| role | 工作 | 输入 | 输出 | 工具 |
| --- | --- | --- | --- | --- |
| extractor | 提炼事实、经历、事项线索 | 固定材料+已验证 provenance+相关现行记忆 | ProposalBatch | 默认无工具 |
| verifier | 判断引文支持、条件/否定/冲突/意图 | 候选+原文+冲突集合 | AssessmentBatch | 默认无工具；需要时受限 evidence_read |
| planner | 补背景、拆下一步、提醒建议 | 已生效事项+依赖+明确目标 | PlanProposal | 不执行对外动作 |
| feedback-curator | 将纠正归入同 scope 的后续约束 | 反馈+原提案+结果 | CorrectionProposal | 默认无工具 |
| answerer | 按证据回答并标引用 | 用户问题+允许的 Context Packet | answer + citation refs | 只读检索/原文，按需 |

角色提示词起稿分别在 [common](prompts/common.md)、[extractor](prompts/extractor.md)、[verifier](prompts/verifier.md)、[planner](prompts/planner.md)、[feedback](prompts/feedback.md)。它们是实现起点，必须由 schema/评测约束验证，不能仅凭提示词承诺行为可靠。

## 3. RoleManifest v1（新合同）

示意 [examples/role-manifest.json](examples/role-manifest.json) 包含 role ID/version、profile_ref、prompt_templates、skill_bundles、output_schema、tool_policy、session_policy、budget。使用 role_id 调度任务，由服务端解析成最终模型请求。不要把 role 对象直接塞进现有严格 `AgentProfile`。样例中 RESOLVE_FROM_BUILT_BUNDLE 是构建占位，bundle 校验器在运行前必须将其替换为实际 digest，未替换则拒绝启动。

每次 attempt 记录：bundle hash、prompt hash、输入原件 hash/版本、effective model/effort、实际加载 Skills、tool allowlist、output schema version、session ID、usage/错误。使用记录的 model/effort，不用 UI 期望值冒充实际生效值。记录公开判断理由，不存隐藏 chain-of-thought。

profile 仍管理 command/args/transport/model/effort/timeout；role 管“做什么、按什么方法”；工具策略管理“能做什么”。选择模型之后再读取新的 configOptions 校验 effort；同一字符串 high 在不同模型上不是同一预算。一个会话同时最多一个 prompt。

## 4. Skills 包如何落地

建议实现资产布局（本轮不安装）：

```text
packages/agent-runtime/roles/<role>/<version>/
  manifest.json
  prompt.md
  output.schema.json
  skills/omem-extract/SKILL.md
  skills/omem-evidence-review/SKILL.md
  skills/omem-task-planning/SKILL.md
  skills/omem-feedback-curation/SKILL.md
```

一个 role 只带所需技能。技能内容包含领域判定步骤、反例、失败/拒答规则和工具合同，避免把整个源资料塞进技能；资料走本次输入。

| 技能 | 必须写进技能的方法 | 不能拥有的权限 |
| --- | --- | --- |
| omem-extract | 区分事实/计划/假设/转述，明确本人指派，来源时间，不推测缺字段 | 直接写 DB、自动发消息、把分数当审批 |
| omem-evidence-review | exact quote、条件/否定、跨来源冲突、图片推断、日期/负责人歧义 | 自己批准自己的提案、改 policy |
| omem-task-planning | 目标/前提/依赖/下一步、补证优先级、可停止条件 | 任意 shell/外部业务写 |
| omem-feedback-curation | 区分强纠正/弱反馈、同 scope、独立证据、负例测试 | 全局改写行为或扩大采集范围 |

提供两种可检验的加载方式：

1. **Native skill mode**：构建专用 role workspace；TraeX 放在其确认支持的 `.trae/skills` 等路径，Codex 使用 `.agents/skills`，Claude 使用 `.claude/skills`；加入相应宿主入口说明。TraeX session/new 的 `_meta.trae.options.skills=[canonical_names]` 是选择器；通过 `available_commands_update` 等 discovery 核验名称已加载。技能被禁用、重名、版本不符必须停止该 role，不静默继承全部用户技能。
2. **Inline skill mode**：无文件工具或宿主不支持原生 Skills 时，把已审核技能正文按预算拼入 role context，并明确记为 `inlined`。这能让 no-tools 提炼器实际得到方法，不声称加载了宿主 native skill。避免当前 Claude `--tools ''` 下只登记文件却无法阅读的情况。

bundle 在构建时校验 frontmatter/canonical name/引用文件/允许路径/hash，禁止 symlink 逃出 bundle；模板内容只能来自安装的可信包，不从检索资料自动生成后马上作为执行技能加载。设计 skill-creator 工作流用于实现这些 Skill 的创建/验证，不能用“SKILL.md 文件存在”代替实际加载验收。

## 5. Prompt 层级与跨宿主差异

标准 ACP `session/prompt` 没有可假定的通用 system-prompt 字段。不要发一个杜撰的 `systemPrompt` 参数。稳定 role 规则通过宿主支持的角色/项目入口或经过核实的配置传入，动态证据用 text/resource/image content blocks。TraeX/Codex 可使用受管理 workspace 的 AGENTS.md；Claude 使用其已支持的 system-prompt/CLAUDE.md 方式。具体 argv 以安装版本 help/契约测试为准。

对于只有普通 prompt 的适配器，应如实记录“role instructions included as prompt”，后端确定性校验与工具限制才是授权边界。模型不遵循提示词时，不能导致写库或调用外部系统。

Prompt 构建顺序：可信 role 规则→可信 skill 方法→任务和输出 schema→已确认用户纠正/适用范围→带来源标签的原文/图片→当前问题。来源里的 XML/Markdown 标记要作为数据转义/结构化封装，不能利用 `</materials>` 等提前结束包裹并注入新角色。

## 6. 上下文与会话复用

- 使用 ContextManifest 记录 actor/time/source、source revision、片段/图像 refs、related memories、confirmed corrections、预算和截断。现有 context metadata 不能在入口保存了却没传给提炼器。
- `maxContextChars` 保留兼容；新增模型 tokenizer 或保守 token 估计的硬限额。不能截断掉否定条件、时间限定和必要支持片段。超过预算先按文档/episode 分包，汇总时仍引用原片段，不拿中间摘要自证。
- extractor/verifier 默认 fresh session，防止上一任务的猜测渗入另一项目。verifier 不接提炼器自由形式推理，只接候选和可核验资料。
- answerer/planner 可复用同 owner/workspace/topic/role-version 的会话；持久 session ID、last_turn、context generation，支持 resume；模型/role/skill/权限配置变更时新建或显式 fork。不能把用户A/项目A的历史带到B。
- source/permission epoch 变化时清理或更换会话上下文；不能以“对话里已经出现过”绕过最新可见性。
- tool stdout、Agent 输出与进度事件有字节和时间预算；不完整 JSON、模型中断、非 end_turn 不进入 applied。

## 7. 工具与人的问题

extraction/verifier 优先无工具，通过服务端一次提供必要原文。需要补采时输出 `missing_context`，由确定性的 job 创建 scoped fetch，再把结果作为新一轮输入；不把浏览器、shell、飞书发送工具直接交给 extractor。

回答可使用由 omem 提供的只读 MCP：`memory_search`、`evidence_read`、`task_read`，凭据限该 job/workspace，工具返回固定证据。当前实现把 MCP 全清空；本批需新增受管理 allowlist，而不是继承用户全局 MCP。MCP 只读不意味材料可信，内容仍是不可信数据。

权限请求/elicitation：映射为短期 runtime decision，与长期知识 Proposal decision 分开；持久 request ID、session/turn、允许的 options、expiry。后台 worker 不无限占租约等人。进程已终止或 request 失效时旧按钮返回 stale，不试图恢复一次已经不存在的 pending call。初期可统一拒绝工具权限并生成补证任务，只有有真实需求时再实现恢复型权限代理。

## 8. 验收重点

详见 A-R01～08：不仅验证握手，还要证明指定 role/prompt/skill 实际到达模型、模型切换后 effort 重新协商、身份/版本上下文齐全、技能无法加载会报错、无工具模式可提炼、隔离会话不串味、异常输出不应用、人的过期决策不执行。

真实测试使用无敏感的小材料；将模型选择、role hash、skill manifest 与最终 JSON 保存成可审查工件。完成时将本页的“建议布局”改写为实际路径，保留未实现项，不能把起稿当已部署配置。
