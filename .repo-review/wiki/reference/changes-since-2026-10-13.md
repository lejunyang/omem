---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-25
---

## 后台运行少发重复通知（2026-11-25）

- `unresolved` 只给规则、关注或情境的运行链，以及助手自己约的复查补提醒。链上已通知本人、留下待答提问、发过消息或卡片、记过事项时间线，或已有有效唤醒和预约复查时不补发。提醒先写问题，再写最后判断和原消息链接。
- 飞书投递后台主动汇报时，从最近四小时的本人发言找共同线索。决策模型确认本人已知结论且无需新行动时只留网页，结果记为 `known`。新场景 `notify-known` 默认门槛 0.8。无共同线索、模型不可用或判断失败时照常投递。紧急、提问和审批、直接要求的结果及显式规则通知继续走原流程。

## 原定范围内的反馈随流程做（2026-11-25）

`note_item_change` 的 `fold` 由跟进角色判断。原范围内的反馈按阶段合批重开，步骤交给阶段，给本人一条带引用的普通通知。扩范围和需要本人拍板的继续用原卡片。另一件未结束事项已经按重叠行并进或问过时，只记处理归属。主助手在「有人找你」查清后可以用 `stage_reopen` 把范围内的反馈交给已关联的流程，两边用同一套原件行匹配和阶段日志避免重复重开。

跟进和已确认关联的会议共用改期更新和通知，时间相同只记账。旧改期卡保留回答入口。测试用合成材料及假客户端覆盖，真实渠道与模型待验。

## 流程对账直接收口，草稿可发，返工不重复问（2026-11-25）

- `submit_flow_reconcile` 带证据停止已达成或取消的流程；可一并完成事项，不开下一轮、不发提问。收口说明放进不急通知，旧关卡和阶段运行一并处理。
- 关联群有机器人时，点卡片就能发草稿，不依赖关注的回复档；自动授权照旧。重开后暂停使用旧结果的下游助手工作，已有批准的返工不算新的自动推进。
- 阶段、对账和接手运行纳入已挂仓库及其业务空间，不扩大成员权限。重开编码阶段后只等新的交办或续轮，旧交办结束不算这一次完成。

## 插件凭据的登录卡片就地收尾（2026-11-25）

`credentials.ts` 的 `startCredentialLogin` 发出的“omem 正在为你登录 …”带 `tone: "warning"`（黄色），记下通知 id；登录结束时 `settleLoginCard` 用 `replaces` 改同一张卡片：完成为绿色“已登录”，过期、失败或取消为“没有登录成功”并写上插件给的原因，链接换成 `loginLink`（打开即重新登录），旧通知的 `link` 清空，网页通知里不再留着失效的官方链接。登录进行中 `reminder` 不另发“过期 / 失败”；`expireCommandCredential` 排在登录后面执行时，若登录在命令报错之后完成（`loggedInAt`）就不再把新登录标成过期。插件登录失败的原因写进日志。插件的 `check` 可返回 `expiresAt: null` 清掉记下的到期时间（自己续签短期令牌的工具用，免得按短期令牌提醒“三天内到期”或判过期）。

## 网页：预查库、先看一眼、情境和新的待处理（2026-11-25）

- 规则页加“预查”页签（`/rules/probes`，`web/src/views/Probes.vue`）：列表、编辑、删除和试跑（没保存的代码也能试）。“交给 Agent”动作和关注、情境共用 `components/FirstLookFields` 设“先快速看一眼”、预查和第一条发到哪；规则可加“预查”动作；情境生成的规则只读并链回情境。
- 情境：工作页右栏列出（`components/SituationList`），新建用 `SituationDialog`，情境页（`views/ListenDetail.vue`）有“各回”（`SituationRounds`：手动开始、结束写小结）和设置。事项页标出属于哪个情境的一回，为此 `GET /api/items/:id` 对本人多返回 `situation`（`src/situations/instances.ts` 的 `instanceOfItem`）。
- 设置 → 代你回复 加“快速通道”卡片：第一条默认发到哪、先看一眼实际用的 AI 及来源、预查库入口。运行页给先看一眼、预查、接手下一步、流程对账、临期预查起中文名，先看一眼的运行列出各层用时和结果；预查运行列出输出和退出码。
- 待处理认得 `item-step`、`flow-reconcile-step`、`item-deadline-check` 和三种情境提问，情境的“改一改”答完直接打开填好的编辑表单。行为改动通知的前后对照分色显示。一次性阶段清单在事项流程上标“一次性清单”。决策页“添加一个”默认选还没用过的提供方。

## 情境开场先看一眼，后续跟进照常

情境新开的一回可先跑预查、发第一条结论，首轮处理带上这些材料。答完、要本人定或快模型失败都不跳过这一回；后续信号只附预查结果。临期预查点“按这个开始”后，多步工作用一次性阶段清单推进，外部动作仍确认。有人找你的分诊确定要先查后，若既要选处理者又要判断能否自动答复，合成一次决策请求。

集成时把情境时限和对账工具的参数校验与运行逻辑拆开，避免 CLI 入口循环加载。重新测量受这一轮角色改动影响的常驻提示词，保留原来的浮动上限。

## 情境：一类事有共用的说明，每次分开跟

关注新增情境：开始信号由规则识别，每回有事项和独立会话；其他运行能看到这一回，并把发现和相关的本人发言送回来。结束的小结供经验整理；本人一步步带助手做完的事项可提议情境，进入待处理和今天。接口见 `docs/v2/situations.md`；网页见上一节。

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-22](./changes-2026-11-22.md)：任务板跨设备任务的停止与重派、本人沙箱的目录与审批，以及流程阶段的本人链接、插件永久信任、交办复用同意、跨设备飞书读取、成员管理 Agent 档案等当天的其余改动。
- [2026-11-21 下半天](./changes-2026-11-21-second-half.md)（68 节）：编码交办的用量归集、云端工具的令牌和探测、成员权限按区域和对象检查、严格运行的出网代理、插件的通知出口，以及成员的线和“等我的”、变化台账、“今天”并进简报、需求到交付的链路、远程会话交给成员、插件的检索 / 原件格式 / 页面类型、HTTP 规则的判定入口、成员能力和成员沙箱里的编码。
- [2026-11-21 上半天](./changes-2026-11-21-first-half.md)（60 节）：整理第一批（方案、设置页和数据页重做、其余页面整理）、工作线三四期和关注页、指标由本人确认、协同任务板、等本人处理的清单和提问卡的免打扰、按后端能力裁剪常驻说明和云端会话收尾、操作规则和规则包、对象授权、成员在助手里看流程和存规则、插件订阅事项与评审。
- [2026-11-20](./changes-2026-11-20.md)（24 节）：关注（盯群换成关注、从历史学、主动推进）、工作线的事项上下层和现状、演示和 Chrome 扩展的录制、成员用自己的 AI 账号、工作上的指标、每晚复查回复结果、插件设置。
- [2026-11-19](./changes-2026-11-19.md)：编码交办、流程、评审复核、会议、网页、设备和插件回调。
- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 决策模型一次答多题（2026-11-25）

- 宿主可用 `decideMany` 对同一份材料一次问最多 8 题，漏答就换模型重问整批；`decideSceneMany` 对有场景的题各套门槛、各写一条记录。设置试用和 CLI 回放仍逐题。入口：`src/core/decision.ts`、`src/core/decision-log.ts`。

## 流程：对账、解除阻塞与一次性阶段清单（2026-11-25）

巡检给阶段停太久、或事项有新动静的流程排一次对账，六小时内不重排。对账重读挂接对象和群证据，通过原状态机纠正，签字不代点；只读没法解时把最小一步或草稿放进待处理。`flow_start` 可用内联清单开始一次性流程，外部写入要确认，走完可用现有草稿卡存为模板。入口 `src/flows/reconcile.ts`、`inline.ts`，设计见 `docs/v2/flows.md` 文末。

## 行为改动对照、规则安静率与复查收尾（2026-11-25）

- Agent 写入技能（含附件）、规则、关注、档案与角色设置时记录前后差异，按不急的通知汇总，支持本人保留或撤回。入口：`src/agents/behavior-changes.ts`。
- 规则页列近 7 / 30 天触发与安静结束次数，周报列高安静率的规则及理由。`stay_quiet` 增加状态，未恢复又无人跟进时由宿主发一次普通提醒。入口：`src/rules/quiet-stats.ts`、`src/agents/quiet-followup.ts`。

## 有期限的事自己找上门（2026-11-25）

`assigned-sweep` 随库播种，配套规则默认关闭：工作日早上主助手按本人的查询技能清点共享平台上指派给本人的有期事项，按原件键复用事项，新发现且三天内到期的合发一条，其余进“今天”。`src/items/deadline-check.ts` 随巡检挑两天内截止、一天没动且无流程的本人事项，排一轮只读预查；同一截止不重复，结果并入原提醒或独立待处理。本人点“按这个开始”才在事项的私有会话续做。

## 2026-11-25 · 事项下一步可以按技能查和做

- 接手时可用技能里的命令只读核对，命令和操作规则照常。要写但没有可重放工具时，`submit_item_step` 交 `operation_note`，本人看到对象、动作、依据和预期结果后选择执行或不执行。
- 本人同意才在事项会话排普通主助手轮，现有审批不变。结果写回这一步；中断或结果不明确时不自动重做，下次先只读核对。`suggest` 只留建议。见 `src/flows/takeover.ts` 和 `test/item-takeover.test.ts`。

## 2026-11-25 · 事项变化的下一步有人接

- `note_item_change` 交具体步骤和完成条件。`src/flows/takeover.ts` 同批排一次接手：只读调查安静写回；外部操作先让本人确认原参数，执行仍走现有审批；等别人到点回查一次，等本人进待处理和“今天”。未定的范围不推进。
- 复用事项关注 `assist`，默认 `act`；每天每事项最多六次自动接手。沿用事项范围、消息处理记录和发出前复核。见 `test/item-takeover.test.ts`。

## 快速通道：预查、先看一眼、按需深查（2026-11-25）

设计和接口在 `docs/v2/first-look.md`。

- 预查库 `src/rules/probes.ts`（kv `rule-probe:<名字>`，注意不是后端检测用的 `probe:<档案>`）：只有本人能存、改、删；执行用从 `rules/script.ts` 抽出的 `execScript`（`runScript` 也改用它），每次一个 `probe` 运行；`runProbes` 并行、不抛错。工具 `propose_probe`（卡片用途 `probe-proposal`，“不要”记在 `items/choices.ts` 的种类 `probe`）。HTTP 在 `src/rules/probes-http.ts`。键名和 `probeExists` 单独放在 `probe-key.ts`：`rules/store.ts` 只引它，不经 `probes.ts → script.ts → compile.ts` 引进模型调用（否则 `rule-draft.test.ts` 对 `oneshot.ts` 的 mock 失效）。
- 先看一眼 `src/rules/first-look.ts`：运行种类 `first-look`，角色 `roles/first-look.md`，交结果的 `first_look_outcome`（`ROLE_TOOLS`）；AI 用 `firstLookAI`；决策场景 `firstlook`（`decision-scenes.ts`、`ai.decision.thresholds.firstlook`）；`output.stages` 记每层耗时。去处 `resolveDest` / `deliverFirst`，深查结论 `deliverDeep`（`agents/jobs.ts` 的 `runAgentTask` 在 `input.firstLook` 时调用），按钮 `decideCard`（卡片用途 `first-look`，`lark-actions.ts`）。设置 `firstLook.to`。
- 规则：`types.ts` 的 Agent 动作加 `firstLook` / `probes` / `firstTo`，新动作 `probe`；`actions.ts` 的 `runActions` 带 `outputs` 给后面的动作（延时的 `rule-fire` 也带），`deepAgent` 是先看一眼之后的深查；`store.ts` 保存时检查预查存在。
- 关注：`ListenKnobs` 加同三项，`lark-watch.ts` 的 `routeWatchedMessages` 调 `queueListenLook`；`src/channels/listen-first-look.ts` 负责合并、压住这一批、答完拿走、要查时把结论并进这一批。
- 测试 `test/first-look.test.ts`，假 Agent 的 `FAKE_MODE=first-look`。

## 研究：交给改（2026-11-25）

`src/studies/fix-queue.ts`：`queueFixes` / `unqueueFix` / `tickFixQueue` / `attachFixQueue`（`engine.ts` 的 `attachFlows` 挂上）。表 `study_findings` 加 `fix_queued_at`、`fix_note`，`study_scopes` 加 `fix_ai`；`scope.ts` 的 `fixExecutions` 把它变成交办的 `execution` / `reviewExecution`。同一研究一次一个交办，评审通过（`stage.key = done`）即 `markFixedByChange`；`fixes.ts` 重跑仍失败时清掉。接口 `POST/DELETE /api/items/:id/study/fix-queue`，工具 `queue_study_fixes`（`study` 组）。网页 `ItemStudy.vue`：“交给改…”“挑几条交给改”“不排了”，范围里选改代码和评审的 AI。

## 2026-11-25 · 成员选 AI 与飞书授权

成员可指定自己的会话后端和模型，或在账号页设个人默认与任务偏好。自动选型沿用本人的候选和说明，并参考成员偏好。允许借用且本人额度充足时借本人，紧张时切到成员登录。需要授权时飞书机器人发官方链接或二维码，完成后继续原运行。群话题显示等待提示，授权卡片在同群仅发起成员可见。运行事件记录选择原因和等待状态。入口见 `src/agents/member-run-ai.ts`、`src/channels/lark-ai-login.ts` 和 `test/member-ai.test.ts`。

## 研究：发现的写法、改好与避开做过的方向（2026-11-25）

界面上“课题”改叫“研究”、“台账”改叫“研究记录”，表和工具名不变。`skills/library/study-summary` 要求发现正文按“条件 / 现象 / 为什么是问题 / 建议”分节，`read_ledger` 给出试验截图的 Markdown（`web/src/lib/markdown.ts` 允许 `/api/artifacts/…` 的图片）。新工具 `revise_study_finding`（`study` 组，主助手加 `group:study` 去掉 `propose_directions` / `trial_report`），`store.ts` 的 `reviseFinding` 首次改写存 `revised`；`setFindingState` 多 `fixed`（`fixed_at` / `fixed_note`），`fixes.ts` 重跑全过时 `markFixedByChange`。`materials.ts`：覆盖按 `study_trials.features` 统计（旧试验按反引号命令认），`planningMaterials` 加“以前的方向”；`service.ts` 校验 features。`engine.ts` 的 `startRound` 带 `note`，记成 `round-note` 事件供 `ownerWords` 读。网页 `ItemStudy.vue`：“就这条问”“看不懂，重写”“已改好…”、收起已改好的；`ItemFlow.vue` 研究再来一轮先问看什么。见 `docs/v2/studies.md` 最后一节。
## 凭据按子命令分流（2026-11-25）

插件登记的命令可带 `subcommand` 前缀（`packages/plugin-sdk/credential.ts`、`credential-registry.ts`）：`credential-outcome.ts` 的 `credentialCommand(name, args)` 在同名的登记里取参数能匹配上的最长前缀，没前缀的接其余调用；命令垫片、成员身份执行和结果回报都按它选凭据。每条命令的 `readOnly` 上限从 64 提到 256。`test/credential-subcommand.test.ts`。

## 规则的飞书工具跟随成员身份（2026-11-25）

`src/agents/tools.ts` 按工具声明分发飞书身份。个人读写使用当前成员的连接，`lark_chat_history`、显式选机器人的文档工具和机器人消息保留各自的机器人凭据。邀请、回溯和本人的采集设置要求先换回本人。写入审批按飞书调用者查文件归属和历史批准，批准卡只发给当前成员，延迟执行绑定原申请身份并重查同意。实际写入留下 `lark.run-as.write` 审计和运行事件。知识库爬取持久化读取者，附件下载也使用成员连接。用 `test/rule-run-as-lark.test.ts` 覆盖分发、审批、撤回、缺登录和后台续跑。

## 规则以成员的身份运行（2026-11-25）

Agent 动作新增 `runAs`（`src/rules/types.ts`，只有本人能加人，`store.ts` 校验）。`src/rules/run-as.ts`：表 `rule_run_as`，保存后 `syncRunAs` 逐人检查（账号、`ask.send`、飞书关联）并用 `asks`（handler `rule-run-as`，只能本人答）发卡片，结果会话是飞书群时发在群里；`decideRunAs` 给账号页同意 / 撤回；`switchIdentity` / `actingAs` 记一次运行当前的身份。工具 `act_as`（`wake` 组，规则运行带 `runAs` 时加上）；命令垫片请求到 `/api/command-gate` 时，换了身份的运行由 `memberExecution` 用成员的持有在他的账号沙箱里跑，`credentialOutcome` 多了 `onBehalf`，登录失效时替他发起登录并等。`lark_read` 在换了身份时包进 `asLarkUser`。接口 `GET /api/rules/:id/run-as`、`POST /api/rules/:id/run-as/:userId/ask`、`GET /api/rule-run-as-candidates`、`GET/POST /api/me/run-as`；网页规则页选人和状态，账号页 `RunAsConsents.vue`。

## 成员自己的远程浏览器与本机地址守卫（2026-11-25）

`src/remote/browser-guard.ts`：不是本人的浏览器由 `aad mcp` 带守卫环境启动（去掉桌面代理来源，`*_proxy` 指向守卫，`no_proxy=<-loopback>`），守卫复用 `egress-proxy.ts`（新增 TCP 监听、`limits`、`unref`，`Destination` 带 `local` 和 `ip`），拒绝本机和链路本地地址。`sessions.ts` 的 `guarded`、`mayBrowse`；只有守卫下的浏览器能交给成员操作（`grants.ts`），普通会话的操作授权按只看处理。新能力 `remote.browser`；桌面、屏幕、复制本机登录、显示窗口只给本人（`remote/http.ts`）。成员运行带 `OMEM_BROWSER_PROXY`，`browser.mjs` 用它启动，`agent-browser.ts` 核对启动参数。自定义角色可带细分能力（`permissions.ts` 的 `validPermissions`、`capabilities.ts` 的 `presetGrants`），网页分组抽到 `web/src/lib/capability-areas.ts`。

## 文档采集的范围（2026-11-24）

新增 `src/channels/lark-doc-filter.ts`：各人的 `settings.larkDocs`（跳过个人文档库、按链接排除文档 / 知识库页面及子页面 / 整个知识库 / 云空间文件夹）和成员的 `larkCapture.docs` 开关。`captureRecentDocs` 和本人聊天里的文档链接先过 `docSkipper`，`importLarkDocument` 的 `skip` 让跟随的链接和子页面也跳过。接口 `GET/PUT /api/lark/doc-capture`（各人自己的）。登录与连接的 `capture` 参数存在 `kv` 的 `auth_capture:<state>`，回调时写进 `larkCapture`。界面：`LarkDocExclusions.vue` 用在账号页和 设置 → 采集 → 飞书文档 的“你最近打开的文档”（本人）；登录页勾消息或文档时出现“存进 omem”的选择；“以你的身份写文档”只给本人。

## 凭据失效后发起登录、授权后接着做（2026-11-24）

插件凭据加了可选的 `ownerLogin`：本人那份也能在 omem 里走工具自己的官方登录（`startCredentialLogin` 对本人调它，失败不改本人的持有状态）。对话里的命令报没登录或过期时，`credential-outcome.ts` 记下这段对话（`credential-wait.ts`）并当场发起登录，卡片链接直接是官方页，命令垫片的 `[omem]` 行让助手别自己登录或轮询；登录完成或检查看到换了新登录（`checkCredential`）时 `credentialReady` 给对话发 `[授权]` 消息。提醒在能发起登录时链接到 `#/account?login=<种类>`，账号页打开就开始登录。命令报过的过期（`COMMAND_EXPIRED`）不会被只读本机文件的检查改回有效，过期时账号页不再显示续签期限。运行的常驻说明对本人也写明命令登录由 omem 发起（`commandLoginNote`）。

## 运行页的每一步带参数（2026-11-24）

运行页“过程”里每一步可以展开看参数和输出。开始和完成两条事件按调用 id 合并时保留开始时的参数，`omem_call` 那一步按它实际调用的工具显示，参数取那个工具自己的。`read_run` 给下一轮的步骤摘要也写成 `omem_call → 工具名`（`tools.ts` 的 `calledThrough`）。见 `web/src/components/RunActivity.vue`、`src/agents/tools.ts`。

另：`test/credential-execution.test.ts` 的两条兜底用例在能开账号沙箱的机器上会因为假登录立刻成功而走成员自己的登录，改成发出链接后等着；`test/auth.test.ts` 的成员可读设置加上 `credentials.ownerFallback`。

## 成员飞书文档的失败通知与重试隔离（2026-11-24）

成员的飞书文档采集遇到读不到的链接时，保留飞书链接并按读取人排队，本人只收到自己读取失败的汇总。重试使用原读取人的连接，连接停用、缺少文档授权或空间不可访问时跳过。文档更新检查、飞书事件刷新和手动重新读取也沿用原件记录的读取身份。

本人收到的失败卡片直接打开父文档的飞书原文，各失败条目链接到对应文档。正文保留重试信息，移除终端命令。

启动时把旧的共享队列迁到各读取人的队列。父原件记录不足或互相冲突时，仅保留记录，不发起读取。实现和回归测试见 `src/channels/lark-docs.ts`、`src/channels/lark-doc-events.ts`、`test/lark-docs.test.ts`。

## 从空目录构建保留 CLI 执行位（2026-11-24）

`pnpm run build` 在编译后为 `dist/src/cli.js` 设置执行位。npm 或工具链从该文件生成 `omem` 命令时，构建产物可直接执行。

## 对话切换 AI 后接手轮收到切换结果（2026-11-24）

接手的 Agent 以前只看到原始请求，把其中的切换要求重新执行，每轮又开一颗飞书思考气泡。现在 `switch_run_ai` 按会话实际使用的默认值比较后端、模型和强度，等价配置直接返回已设置。旧运行只记录一个接手运行。接手轮的提示带上设置结果和实际使用的 AI，继续回答或处理原消息里的任务。回归测试覆盖省略和显式传入默认值、并发调用、实际更换强度。入口在 `src/agents/tools.ts` 和 `sessions.ts`。

## 成员读飞书文档缺权时预勾「文档与知识库」（2026-11-24）

`lark_doc_fetch` 遇到 CLI 报缺新版只读权限或旧版的创建及编辑权限时，成员收到的链接带 `features=docs`。同一会话拿到 `docx:document:readonly` 就能续跑，六小时内留下的旧版读取等待也认这个权限。测试覆盖新链接、旧等待和仅有编辑权限时继续等待。入口是 `src/channels/lark-auth.ts` 和 `src/auth/connect-wait.ts`。

登录或连接时勾选「文档与知识库」，同时申请 `search:docs:read`（列出最近打开的文档）、知识库细分查询、云空间目录及元数据、文档素材和画板读取。旧版文档权限加搜索已足够继续采集，缺搜索的连接在账号页可补授权。权限清单见 `docs/v2/multi-user.md`，登录授权参数由 `test/connections.test.ts` 核对。

成员完整复制知识库文档前一次检查读节点、读知识库和复制权限。「让助手写文档」补入 `wiki:node:copy`，飞书错误里的旧 `wiki:wiki` 不再带进复制授权链接，旧等待也认细分权限。一个会话同时保留一张授权卡，同一轮多次缺权合并，新增要求更新原卡。测试见 `test/connections.test.ts`、`test/notification-card.test.ts`。

「让助手写文档」单独勾选也会带上读取目标正文、定位知识库与云盘、新建、编辑、复制、跨位置移动和上传文档素材的权限。最近文档搜索和采集仍由「文档与知识库」授权。OAuth 权限清单按 `test/connections.test.ts` 核对。

## 在别的仓库改的交办不再挂到事项的需求点和流程上（2026-11-24）

联调一件需求时查出联调工具的缺陷，助手交办修工具时带上了那件事的 `item_id`。结果交办页顶上显示那件事流程里等本人的段（埋点、验收），评审的需求拆分拿到那件事的几十个需求点，照“上轮状态”给每个点交了已实现 / 部分实现，宿主记成了这次交办的结果，需求点的“最近一次评审”被一次没改业务代码的交办覆盖。现在交办（`delegate_code`、`review_branch`、网页的交办）带了事项而改的仓库不在这件事以前的交办和仓库材料里时，宿主存成 `contextItemId`（`src/items/materials.ts` 的 `workItem`；事项还没有任何仓库记录时照旧算这件事的）：编码和评审的任务里是“背景：事项「…」”，有说明和材料、没有需求点；交办不挂到事项上，评审不按需求点拆分、不写 `req_status`，不跟流程；`GET /api/code-works` 多一个 `background`，交办页写“为事项：…”，没有流程的等待。续轮和按评审修改沿用它。`item_id` 的工具说明和 `skills/omem/references/code.md` 改成只在做这件事要的改动时传。测试 `test/req-work.test.ts`。

## 编码：交办、方案、需求合成左侧一项（2026-11-24）

本人说方案页藏在运行页“编码”列表底部找不到，需求页单独一项又别扭，要合成一个入口。左侧菜单的“需求”换成“编码”（`#/code`），列表列顶上三个标签（`web/src/components/CodeTabs.vue`，按 `code.work.view` / `designs.view` / `requirements.view` 各自显示）：“交办”（`web/src/views/Code.vue`）是原来运行页的“编码”列表和交办对话框（拆成 `components/DelegateDialog.vue`，加了 Esc 关闭和焦点归还）；“方案”（`views/Designs.vue`）改成左边列表、右边方案，`views/Design.vue` 删掉；“需求”（`views/Requirements.vue`）去掉了在树里打开交办的那一套（`?work=`、树上的变更状态、需求外一行），需求点下的编码点开转到“交办”。按需求点看代码挪进交办自己的“需求点”标签：`CodeWork` 去掉 `focus` / `from` / `points`，点一个功能点只看它的变更点和代码；新增 `loaded`、`missing` 两个事件，页面据此在同一交办的各轮之间保留视图、把不是编码的运行转回运行页。运行页去掉“编码 / 全部运行”切换和“交办”按钮，打开编码运行时转到 `#/code/<id>`；`main.ts` 里 `#/reqs/…`（带 `work` 的转到那次交办）、`#/designs`、`#/design/<id>` 都转到新位置，服务端通知、飞书卡片里的链接不用改。`lib/route.ts` 的 `pageParam` 可以传路由模式（`/code/reqs/:id?`），给同在 `/code` 下的几个页面用。验证：网页类型检查、11 个相关测试文件、截图脚本的虚构数据上 1440 / 390 走查；重拍了交办、方案、需求相关的截图。

## 需求页：测试点的行不再撑高，测试结果不再超出卡片（2026-11-24）

需求页详情里测试结果的条目用的类名 `.test` 也命中了树上测试点的行（`node test`），那些行变成上下排列的网格，比别的行高出好几倍；改名为 `.test-result`。详情的各块（`.block`）是单列网格却没限定列宽，测试的文件路径很长时把整列撑宽、超出卡片右边，现在列宽是 `minmax(0, 1fr)`，路径按省略号截断。另外产物里没有预览的文件（日志、文本、报告）在 `RunArtifacts` 里不再占一块 16:10 的空白框，改成一条带类型的窄条。验证：本地预览在 1440 / 390 宽度下测试点的行高与其他行相同（33px），卡片内没有元素超出右边，页面没有横向溢出。`web/src/views/Requirements.vue`、`web/src/components/RunArtifacts.vue`。

## 成员查不到时用本人的登录兜底，问答页不再重复显示后补的回复（2026-11-24）

新设置 `credentials.ownerFallback`（设置 → 安全 → 凭据的出借，默认关，只在出借方式 `auto` 时生效）：成员的只读命令先用他自己的登录；没有，或跑出没登录 / 过期 / 没权限，就提醒他授权（`inviteCredential`：替他发起登录并把链接发给他，没权限时发申请链接，同种凭据每天一次），同时用开放给他的本人登录跑完这条命令，不做发起人权限预检。成员运行借用本人 HOME 时命令照常在本人环境里跑，只多一行 `[omem]` 说明，结果不记到成员名下（`report: false`）。只读声明的子命令匹配跳过前面的全局选项和值（`--site cn log …`）。成员运行的常驻说明加了一行：这些命令用谁的登录由 omem 决定，不要自己换 profile 或发起登录（`commandLoginNote`）。另外，授权完成后接着做的那一轮回复只在 `meta.runId` 里记着运行，问答页和远程会话把它当成没回答，又把运行输出显示了一遍：网页现在也认 `meta.runId`。入口：`src/agents/credential-execution.ts`、`credentials.ts`、`credential-outcome.ts`、`web/src/views/Ask.vue`、`web/src/components/RemoteChat.vue`、`CredentialLending.vue`；回归：`test/credential-execution.test.ts`。

## 云端后端用了之前运行留下的凭据时说清楚（2026-11-24）

豆包 OpenAPI 的云端沙箱在会话之间保留文件，后一次运行会翻到前一次留下的脚本，用里面已作废的凭据调工具，只得到“凭据无效”就停了（课题小结因此没交回结果）。现在已结束运行的凭据被用到时，回复说明这是之前一次运行的、只用本轮给的连接信息；凭据打到别的接口时，403 写明能用的两个接口和请求头；云端工具说明里加了不要沿用沙箱里旧脚本的地址和凭据（`src/agents/cloud-tools.ts`、`src/server/http.ts`、`src/agents/runner.ts`，测试 `test/cloud-http.test.ts`）。

## 豆包命令行长时间编译测试时不再被当成没有反应（2026-11-24）

豆包命令行用 `-p` 跑时整轮结束才输出，编码交办里一次 Rust 编译加测试超过空闲上限（30 分钟）就被停掉，报“豆包 CLI 长时间没有结果”。现在 Linux 上每分钟看一次它的进程树（含已结束的子进程）用掉的 CPU 时间，还在涨就算有动静（`src/agents/spawn.ts` 的 `treeCpuTicks` / `touchWhileBusy`，`src/agents/doubao-cli.ts`，测试 `test/tree-cpu.test.ts`）；别的系统仍只按输出算。

## 数据目录在链接路径下时课题试验能拿到工作区（2026-11-24）

数据目录所在的上级目录是链接（比如 `/home` 指向另一块盘）时，课题的每个试验都被判成“工作区槽位不能指向其他目录”而 blocked。现在只拦槽位本身是链接的情况，链接和槽位按解析后的真实路径比较（`src/studies/workspace.ts` 的 `owned`，测试 `test/study-workspace.test.ts`）。

## 本人的多个账号、Antigravity CLI 按人登录（2026-11-24）

后端卡片“这台机器的登录”下可以“再加一个账号”：生成后端 `<后端>-<n>`，source 为 `<后端>#<n>`，`env` 把目录 `account.env` 的变量指向 `<数据目录>/logins/<id>`，HOME 不变；登录、检查走同一套机器登录，命令带它自己的变量；额度按 source 分开，`catalogEntry` 认 `#` 前的部分。删除时去掉后端、角色 / 档位 / 兜底 / 候选里的引用和目录。Antigravity CLI 加了 `account`：私有的 `XDG_CONFIG_HOME`、`XDG_RUNTIME_DIR`、空的 `DBUS_SESSION_BUS_ADDRESS`（没有总线时 agy 把登录存到 `$XDG_CONFIG_HOME/antigravity`），`acp --login` 贴回授权码，`-p /usage` 作状态检查；新的 `account.cliEnv` 只给登录、检查、退出命令。入口：`src/agents/login-slots.ts`、`machine-login.ts`、`catalog.ts`、`web/src/components/MachineLogin.vue`；回归：`test/login-slots.test.ts`。

## 命令垫片的循环兜底、同一程序的后端合并、不支持清理的会话不再重试（2026-11-24）

常驻服务器上一次运行里，垫片经符号链接别名找到自己，同一条命令两分钟内套了一千八百多层，每层一个进程。除 11-23 按真实路径排除外，再加三道：垫片跳过任何内容是 omem 垫片的文件（另一个数据目录的垫片在 PATH 上时不会互相启动）；经垫片启动的子进程带嵌套层数，被垫片直接再启动或超过 8 层就拒绝，不再请求服务；服务端同一运行、同一命令和参数一分钟内超过 60 次就拒绝并在运行里记一条。凭据代跑的 PATH 按真实路径去掉垫片目录。

设置里保存的后端运行的是内置条目的同一个程序（同名命令或指向它的路径、同样的参数、没有自己的环境变量）时，它顶替内置条目，并以内置条目为来源共用额度、登录和账号目录；内置条目的 id 仍被引用、或程序是从 ACP 注册表下载到数据目录的，两条都保留。后端没有声明 session/delete 也没有归档命令时，会话清理第一次失败就标为失败，不再按间隔重试（可手动重试）。“在做的”任务行没有产出时，状态也落在最后一列。

入口：`src/agents/command-gate.ts`、`credential-execution.ts`、`src/server/http.ts`、`src/core/config.ts`（`allProfiles`）、`src/agents/session-cleanup.ts`、`web/src/styles.css`（`.pg-res`）；回归：`test/command-gate.test.ts`、`test/catalog.test.ts`、`test/acp-cleanup.test.ts`。

## Antigravity 官方 CLI 内置后端（2026-11-23）

内置目录新增 `antigravity`，按 PATH 中的 `agy` 识别，以 `agy acp` 启动，复用在终端通过 `agy acp --login` 完成的 CLI 登录。Web、`omem agents` 和 `omem setup` 共用目录，不再需要手写启动配置。注册表的 `antigravity-acp` 仍是独立运行包，认证与 CLI 分开，已有配置保留。额度用 CLI 本地处理的 `agy -p /usage --output-format json` 读取，把剩余比例换算为已用比例，保留分组和重置时间，接入现有缓存、展示和调度避让；模型范围从 CLI 的分组说明读取，不明范围只展示。真实 CLI 1.5.15 已读到 9 个模型，额度命令没有模型回合和 token 消耗。入口：`src/agents/catalog.ts`、`antigravity-quota.ts`、`quota.ts`；回归：`test/catalog.test.ts`、`test/antigravity-quota.test.ts`。使用说明在 README 和文档站的 Agent 页。

## 机器人文档调用与豆包每轮工具的凭据（2026-11-23）

机器人文档调用此前只把 App ID 与 App Secret 交给 lark-cli，环境变量凭据通道不会换取租户令牌。现由 SDK 缓存、刷新机器人的租户令牌，再显式传给 CLI；不继承用户令牌与认证代理。豆包 CLI 共享后台可能沿用前轮的环境，每轮改用私有临时命令绑定自己的工具地址、令牌和环境，通过本轮提示给出；并发运行互不覆盖，结束及启动失败后回收。入口：`src/channels/lark-cli.ts`、`src/agents/doubao-cli.ts`、`tool-cli.ts`；回归：`test/lark-cli-auth.test.ts`、`test/doubao-cli.test.ts`。

## 命令垫片不再通过路径别名递归启动（2026-11-23）

数据目录可以有符号链接别名。生成的命令垫片此前只按路径字符串排除 guarded 目录，Node 解析后的脚本目录与 PATH 使用不同别名时，会再次找到自身。现按真实路径核对目录与候选文件，跳过垫片别名，原权限判断不变。入口：`src/agents/command-gate.ts`；回归：`test/command-gate.test.ts`（目录别名、文件别名）。类型检查、构建和 7 个关联测试文件共 44 项通过。

## 远程浏览器按资料目录识别占用（2026-11-23）

Web 远程的“先关闭”仍由 `src/remote/sessions.ts` 传给 aad。含修复的 aad 会检查 Chrome、Edge 和 Brave 的进程属于哪份资料，识别 Linux 上升级后仍在运行的旧浏览器。浏览器进程的默认目录读不到时，核对本机锁里的 PID 是否持有对应的监听套接字。只有核对了进程和资料目录才关闭。Linux 上勾选“先关闭”时也可清理本机已退出进程留下、无活动套接字的锁。验收见 [远程浏览器的占用与显示环境](../../../docs/v2/acceptance.md#远程浏览器的占用与显示环境2026-11-13)。

## 成员飞书工具的身份与权限（2026-11-23）

从 `src/agents/tool-help.ts` 的飞书分组和 `src/auth/tools.ts` 的单工具权限读起。成员有连接权限时可以用自己的飞书读数据、读写文档，缺授权时回到原会话续办。通用写入、拉人进群和目录长期授权只给本人。云空间文档的归属按本次连接的 open_id 核对，编辑共享文档由发起成员批准。成员工具身份和日程、妙记采集的验收在 `test/connections.test.ts`。
