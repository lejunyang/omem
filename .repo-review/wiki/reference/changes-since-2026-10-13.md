---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-29
---

## 拉取设备快照能断点续传，备份连续失败会提醒并拉长重试间隔（2026-11-29）

**起因**：一台 Windows 电脑每晚经中间设备备份常驻服务器，连续两周没成功，状态里先后是 `Invalid empty pathname`、“aborted due to timeout”、“terminated”。查到的是几件事叠在一起：

- **Windows 上解包失败**：`untar` 调的 `tar` 在服务进程里解析到系统自带的 bsdtar，它把没有 pax 名字的 tar 头按系统代码页读。Linux 上打的包里文件名是 UTF-8：中文名的页面在 GBK 下要么变成别的字，要么字节数凑不成合法字符，报 `Invalid empty pathname`，整次拉取失败。知识库里出现一个三个汉字的目录之后，每次传完都倒在这一步。
- **快照一次传不完就全部作废**：`GET /api/peer/snapshot` 每次请求现做一份、整份流式发出。中间设备转发一次请求总共只给 15 分钟（`/api/peers/:id/*` 的 `AbortSignal.timeout` 连响应体一起算）；常驻那台的主线程被成批的同步 SQL 卡住一两分钟时流就停住；中间设备是台空闲就睡眠的笔记本，睡着后只在收到网络包时醒十秒，中间一睡几分钟，转发的连接就断了。任何一种发生，已收到的几个 GB 全丢。
- **越失败越大**：`pull_since:<设备>` 只在成功后前移，两周的原件和运行事件攒到快照里，数据库部分从几百 MB 涨到 3.3 GB，更传不完。
- **失败后每 20 分钟重试**：每次都让对方重新生成整份快照，对方磁盘和主线程跟着变慢。
- **提醒没人看到**：三天一次的通知只进了备份那台设备自己的站内通知，那台没有推送渠道。

**改法**：

- **解包时告诉 bsdtar 文件名是 UTF-8**（`pull-transfer.ts` 的 `tarReading`）：`tar --version` 认出 bsdtar 就给列目录和解包都加 `--options hdrcharset=UTF-8`；GNU tar 不用。这一条只改拉取方，对方不用更新就生效。
- **对方把快照留在磁盘上**（`src/core/pull-held.ts`）：`POST /api/peer/snapshot` 开始生成并返回 id，`GET /api/peer/snapshot/:id` 看状态和大小，`GET /api/peer/snapshot/:id/data` 按 `Range` 取字节，`DELETE` 用完删除。文件放在数据目录的 `tmp/pull-held/<id>/`，tar 直接写文件，不经过服务进程；半小时没人问就删，最多留两份，服务启动时清掉上一个进程留下的。只有本人令牌能用，四个路由登记在 `settings-sections.ts` 的 `node` 一组。
- **拉取方分块取**（`pull-transfer.ts` 的 `fetchHeldSnapshot`）：每块 32 MB，一块中途断了从已写到的字节接着要，不从头来；等待从 5 秒翻倍到 1 分钟，连续 15 分钟一个字节都没收到才放弃（`FetchOptions.stallMs`）。对方重启丢了快照（404）就重新要一份，最多三次。对方是旧版本（`POST` 返回 404 / 405）时退回原来的整份流式下载。中间设备只转发，不用更新：它本来就透传 `Range` 和 `Content-Range`。
- **附件列表和每批附件**同样按“15 分钟内没成功才放弃”重试（`patiently`），原来是 5 秒、10 秒各试一次。
- **备份的状态多记 `fails`**（`peer-backup.ts`）：连得上但拉取失败的连续次数。满 3 次通知一次（之前只按“3 天没成功”），之后仍是每 3 天一次；失败后的重试间隔按 20 分钟翻倍，最久 6 小时（`backupHoldOff`），手动 `--now` 不受限。只是连不上时照旧每 20 分钟看一眼。备份目录 `.pull-tmp` 里一天以前的 `omem-pull-*`（拉到一半被杀掉的进程留下的半份快照，每份几个 GB）在下一次拉取前删掉。

**没改的**：通知仍只发在备份那台设备上（`notify`）；那台没有机器人或通知出口时还是只在它的站内通知里。跨设备转发提醒会让一台设备能在另一台上给本人发消息，和 `PEER_DENY` 不让别的设备调 `notify` 的约定相冲，留给本人定。跨进程的续传（上一次进程留下的半份文件下次接着用）没做：一次拉取之内能续就够用。

测试：`test/pull-resume.test.ts`（两个节点之间放一个会掐断响应的转发器：每块传 100 KB 就断，下一块从断点开始；15 分钟换成 300 ms 验证放弃；对方丢了快照重新要；旧版本对方走整份下载；`Range` / 416 / 最多两份 / 半小时清理）、`test/pull-untar.test.ts`（手工拼一个只有 UTF-8 文件名的 tar 头，默认的 tar 和 Windows 自带的 tar 都要解出中文名）、`test/peer-backup.test.ts`（连续三次失败通知一次、重试间隔、成功后清零）。

## 沙箱卡片：主目录的层、登记命令，HTTP 规则的来源（2026-11-29）

- `web/src/components/SandboxSettings.vue`：新行“主目录的改动”读 `GET /api/security/sandbox` 的 `overlay` 和 `layers`，每层按人列出大小（`lib/sandbox.ts` 的 `layerRows`、`fmtBytes`，成员名字取 `/api/users`），“清空”确认后调 `DELETE /api/security/sandbox/layers/:identity`；`overlay.ok` 为假时写原因。卡片说明和 `/tmp` 那行改成写时复制、按这件事保留之后的说法。
- 新组件 `ProtectedCommands.vue`（放在同一卡片“你登记的命令”）：读写 `/api/security/protected-commands`，整份保存；表单的格式检查在 `lib/protected-commands.ts`（`parseCommand`：`~/` 去掉、拆词去重、名字和变量名格式、不收 `OMEM_`），服务端的拒绝留在表单下；403（本机直接打开、不是本人登录）只说明，不给重试。
- `OperationRulesSettings.vue`：HTTP 规则多一个“请求来自”（任何来源 / Agent 直接发的 / 执行器里的命令 / 浏览器里的），对应 `match.source`。文档截图 `settings-sandbox` 带上示例的层和登记命令。

## 已信任的插件也刷新自己播种的技能（2026-11-29）

- `src/plugins/registry.ts` 的 `seedSkills`：原来只有内置插件刷新技能库里自己播种、没被改过的副本（`canUpdateSeededSkill`，按技能库 Git 记录里 `omem: add/update skills of plugin <id>: …` 那次的内容逐文件比），数据目录和链接的插件只补缺，插件里的技能改了也到不了技能库。现在信任状态是 `trusted`（含永久信任、按目录信任的链接插件）的也刷新；`changed` / `required` 和不带代码的场景包仍只补缺（信任的代码指纹覆盖 `skills/`）。
- 技能库里同名、但不是这个插件播种的副本不刷新：要让它跟随插件，整目录移出后重新加载插件补进来。测试 `test/plugin-dev.test.ts`“技能：没信任时只补缺…”。

## 精简每次运行的说明：经验过门槛，技能说明按相关度带（2026-11-29）

起因是常驻服务器上最近 800 次运行的 `prompt` 事件：几乎每个后台角色都固定带 8 条共享经验和约 2,700 字的技能目录（会话摘要的角色说明只有 366 字），主助手的技能目录约 8,800 字，其中每行有 80 多字是技能文件的路径。

- **经验过门槛**：`runner.ts` 的 `taskLessons` 原来按余弦取前 8 条共享偏好与经验、前 12 条自身经验，只要求余弦大于 0，所以总是取满。现在还要过 `memory.lessonFloor`（默认 0.55，比被动召回的 0.60 低一档：按 `docs/v2/evaluation.md` 的校准，0.55 留下约九成相关的）。自身经验 12 条以内仍然全带；没有向量时仍取最新的。
- **经验带编号**：说明里的经验行写成 `- 经验 mem:<id>（主题）：内容`，末尾一句说明用到了照常引用、不对就用编号更正。以前这些行没有编号，召回统计里 `via = lesson` 的“用到”只能是 0。偏好不带编号。运行页“偏好与经验 N 条”改成数行，不再把目录提示算进去。
- **技能行不带路径**：`skillIndex` 每行只有“名字：说明”。技能有附带文件时，`read_skill` 的结果写出它所在的目录。
- **技能说明按相关度带**（`src/agents/skill-suggest.ts`）：每个可用技能的“名字：说明”算一次向量，按文本哈希存在 `<数据目录>/cache/skill-vectors.json`（换向量模型后重算），后台补齐。`skillSuggestReady` 为真（开关开着、有向量模型、每个技能都有向量）时，`prepareRun` 让技能目录只列名字、分组只列“组名「标题」N 个”（主助手改用角色自己挂的技能作为带说明的那几个），并在 `PreparedRun.skillSuggest` 里留下已经带了说明的技能。任务运行（`runRole`）和对话每一轮（`sessions.ts` 的 `skillsForTurn`）用任务或消息的向量取余弦过 `agents.skillSuggest.threshold`（默认 0.55）的前 `limit`（默认 4）个，作为“可能用得上的技能”附在消息后面；对话里给过的记在 `skillSeen`，不重复。复盘的回放轮次不参与。
- **没有条件时的退路**：没有向量模型、向量还没算完、插件向量提供者不能看本人的个人空间、或 `agents.skillSuggest.enabled` 关着时，目录是原来的写法（只是没有路径）。
- 没验的：门槛没在真实的技能说明上校准，没用真实模型看过“只有名字时会不会漏用技能”。上线后先在“看提示词”里对照。

## 运行页能看提示词原文，Agent 页列表分组和搜索（2026-11-29）

- **看提示词**：`sessionPrompt` 发出的 `prompt` 事件带上这一轮的说明和消息原文，`addRunEvent` 落库前把原文交给 `src/agents/prompt-log.ts`：按内容的 sha256 前 32 位存成 `<数据目录>/prompt-log/<前两位>/<哈希>.gz`，事件里只留 `kept: { system, message }` 两个哈希。同一份说明（后台角色几分钟跑一次）只有一个文件，再用到时刷新修改时间；超过 `agents.promptLog.days`（默认 14）没用到的由 `main.ts` 每小时清一次；单条超过 40 万字截断。这些文件只在本机，不进拉取和备份。
- **接口和页面**：`GET /api/runs/:id/prompts/:seq` 返回 `{ via, systemSent, system, message, kept, expired, days }`，只给本人和这次运行为之工作的人（说明里带着那个人的偏好和经验）；`GET /api/runs/:id` 的 `can.prompts` 告诉页面能不能看。运行页和编码交办页“上下文”卡每个角色一行有“看提示词”（`web/src/components/PromptViewer.vue`）：说明和消息按 `#` / `##` 标题分节，列字数和占比，可搜、可看原文。接上原会话的轮次没有再发说明，存的是当时一个新会话会收到的那份，页面写明。
- **Agent 页分组**：内置角色按用途分七组，定义在 `src/core/config.ts` 的 `roleGroups`（新增角色要放进一组，`test/role-groups.test.ts` 检查每个角色恰好在一组），`GET /api/roles` 按组的顺序返回并带 `group`。档案 frontmatter 加 `group`（最多 24 字，本人自己的分组，`save_agent` 也能写），只决定列表怎么排，不进提示词、不影响选型。
- **搜索**：列表顶上的搜索框按名字、用途、分组名筛档案和内置角色，搜索时各组都展开；技能标签下按名字、说明、用途、分组名筛，结果跨分组平铺。折叠状态记在浏览器的 `localStorage`（`omem.agents.groups`）。

## 豆包 CLI 跟随角色的“完全访问”（2026-11-29）

本人自己的运行里，Agent 页给角色开了“完全访问”时，豆包 CLI 也用 `--permission-mode always_allow`。以前只有会写的角色和本人沙箱里的 `sandboxed` 轮次才这样，巡检这类不写文件的后台角色即使开了完全访问仍是 `ask_risky`，遇到风险操作会在本人的豆包客户端里弹确认。访客的轮次照旧用 `ask_risky`。`src/agents/own-sandbox.ts` 的 `runAccess`，测试 `test/full-access.test.ts`。

## 版本号读自 package.json（2026-11-28）

`omem --version`、ACP 和 MCP 的 `clientInfo` / 服务名里的版本原来写死成 `0.0.1`，发 0.0.2 后仍报 0.0.1。现在统一由 `src/core/version.ts` 的 `packageVersion()` 读包的 `package.json`（源码和 `dist/` 两种位置都认）。

## 重启不打断正在跑的一轮（2026-11-28）

- 运行里经 `runRole` 跑的 ACP 一轮（交办编码、评审检查、跟进、课题试验、流程阶段等）的 Agent 放在 Agent 宿主下（`src/agents/agent-host.ts`）：omem 起一个启动器，启动器以独立会话起宿主后退出，宿主不在 omem 的进程树里，PM2 重启 omem 时停不到它。omem 经数据目录 `agent-hosts/` 下的套接字（Windows 是命名管道）说 ACP（`src/agents/hosted.ts` 的 `HostedChild`，帧格式在 `host-frames.ts`）。设置 `agents.restartHold`（默认开，留 5 分钟）。
- `omem serve` 退出前先把宿主交出去（`detachHostsForShutdown`），再给正在回答的工具调用最多 5 秒（`src/server/http.ts` 的 `drainToolCalls`）。宿主在 omem 不在时让 Agent 照常跑：记下这一轮的 `session/update`，压着 Agent 问的权限，它对 omem 的调用在宿主的本机代理里等（MCP 地址和 `OMEM_URL` 都改成代理）；到时没人回来就取消这一轮、停掉 Agent。
- 重启后运行的处理函数照常重跑，`openAcpOnce` 先按运行、角色或检查（`AgentRequest.hostSlot`，runner 填）、AI 和目录找留着的宿主（`claimHost`）：接回后重放输出（重启前已上报的只拼回复），发 `_omem/await_turn` 等原来那个 `session/prompt` 的结果，不重发提示。Agent 的旧工具令牌核对哈希后代表新的一轮（`tools.ts` 的 `aliasToolToken`），沙箱的 `/tmp` 沿用启动时那个。对不上的宿主停掉。
- 表 `agent_hosts`（本机，不同步）。宿主持有的后端会话在清理账上记成宿主的 pid，活着时不会被清理；启动时和每分钟清一遍（`sweepAgentHosts`），只经套接字让宿主停，不按 pid 杀。
- 不走宿主：API key 中转的后端、出网隔离的运行、云端 HTTP 工具的一轮、对话和后台复用的会话、探测，以及用了 HOME 写时复制层或数据只读视图的本人沙箱运行（层和视图随 omem 进程结束，`src/agents/spawn.ts`）。
- Agent 在 omem 第一次连上宿主之前就退出时（沙箱挂载失败、命令没登录），宿主留着它的 stderr（最多 64 KiB）和退出码，等 stderr 读完、omem 连上后按顺序交出（`src/agents/agent-host.ts`）。以前宿主只转发给已连上的 omem，启动失败的原因丢掉，运行只报“Agent 进程退出（1）”或 10 秒没有活动。
- 测试：`test/agent-host.test.ts`，`test/fake-acp-agent.ts` 加 `FAKE_MODE=gap`；`OMEM_TEST_HOSTED=1` 让任何测试经宿主跑（`test/helpers.ts` 默认关）。设计在 `docs/v2/restart-hold.md`。

## 沙箱可读取已有本地仓库的远端副本（2026-11-28）

跨设备拉取后，本机记录每份仓库副本所属的空间。即使本地工作区有未提交的修改，本人和获准成员也能在沙箱中读取副本里的远端版本。重复拉取同一版本沿用原登记。实现见 `src/core/pull-repos.ts`，联合验收见 `test/pull-complete.test.ts`。

## 本机沙箱按身份保存 HOME 并提供只读资料（2026-11-28）

普通 HOME 修改和缓存保存在身份层，每个进程独立写入。状态接口给出大小和回退原因。代码、原件和产物经只读视图访问，成员按空间、原件和运行权限筛选。宿主预览仍从本人的交办页面启动。见 `docs/v2/sandbox-everyday.md`。

## 插件工具能改自己的设置（2026-11-28）

- 插件工具的 `ctx.saveSettings(patch)` 保存这次调用的人的几项插件设置，校验和 设置 → 插件 相同（`null` 恢复默认），返回保存后的值；在 omem 里运行和隔离运行的插件都能用。以前要改自己的名单只能引用宿主内部模块。实现在 `src/plugins/blocks.ts`（`pluginContext`）、`src/plugins/sandbox.ts`（`settings.save`），测试在 `test/plugins.test.ts`、`test/plugin-sandbox.test.ts`。
- 凭据插件一份声明里的命令从最多 32 条放宽到 128 条（`src/agents/credential-registry.ts`）：内网命令行多的插件已经用满 32 条，再加一条整个插件会加载失败。

## 从录制里挑一个需要批准的网页请求（2026-11-28）

- 本人说某一步的接口要审批，助手从远程或扩展录制中挑一个请求。`propose_operation_rule` 把数字、UUID 和哈希路径段换成通配，并按请求体条件核对目标、读请求和噪声。
- 本人点“启用”后，规则才排进现有操作规则，aad 随即能查到对应的主机和方法。卡片和规则保留录制来源。实现见 `src/remote/operation-rule.ts`，验收见 `test/recording-rule.test.ts`。
- 旧放行规则限定正文字段时，取消审批草稿可以不限正文，也可以限定另一个字段。录制中的取消请求同时满足两条规则时，启用后优先审批。

## 本人登记受保护命令（2026-11-28）

本人通过 `/api/security/protected-commands` 管理没有凭据插件的工具。Linux 沙箱按当前身份隐藏登记的登录目录和变量，获准的调用走同身份执行器。声明格式与例子见 `docs/v2/command-gate.md`。

## 沙箱通过执行器使用桌面（2026-11-28）

每个获准运行有独立的 aad 网络与后台进程。网页远程查看沿用原来的访问授权，只连接本轮的托管浏览器。

## 出网规则可以限定来源（2026-11-28）

HTTP 匹配可限定 Agent、执行器或浏览器。本人 Git 执行器中的 OpenSSH 经授权的 CONNECT 隧道到远端。

## 卡片预览画出 Markdown 表格；沙箱设置页跟上执行器（2026-11-28）

- `scripts/card-preview.ts` 画之前把 Markdown 元素里的管道表格换成表格组件（每列 125px、每页 5 行），手机宽度下和客户端一样要横着滑；以前画成原样的竖线文字。在卡片搭建工具的手机视图里核对过客户端：JSON 2.0 的 Markdown 表格每页 5 行带翻页，每列约 125px，四列在手机上只露出前两列多一点。`skills/omem/references/owner.md` 的 `fold` 写明 fold 里的明细一项一行或只留两三列，列多的放成 fold 外的 `table`；`docs/v2/lark-cards.md` 同步。
- 设置 → 安全 → 运行的沙箱（`web/src/components/SandboxSettings.vue`、`web/src/lib/sandbox.ts`）：加“只让这些运行进”“这些不进”两个多选（`agents.ownSandbox.includeKinds` / `excludeKinds`，选项是运行类型的中文名）；“默认藏起来”分清 omem 的数据目录和插件命令的登录（以前每一项都写成数据目录），能展开看常用登录文件和浏览器资料的清单（`defaults.loginPaths`，配置了 `loginPaths` 时用配置的）；帮助文字改成执行器之后的说法，“你加的可写目录”不再让人把登录目录加进来。操作规则卡的说明写明进了沙箱的运行里绝对路径和改过的 PATH 也落到垫片上，没进沙箱时才拦不住。截图 `settings-sandbox` 重拍。
- `src/agents/own-sandbox.ts` 的 `canonical` 在 Windows 上按盘符路径的规则拆不存在的路径：以前把它当 POSIX 路径拆，成员账号下还没建的状态目录被判成“越界或含符号链接”，`scripts/doc-screens.ts` 在 Windows 上给演示成员登录时就退出。Linux 上不变。

## 跟进对修改项答 later / skip 是放下或不做（2026-11-28）

- 跟进在报告的 `answers` 里回答修改项问题（`task:…`）时，宿主一律当作“重做，做法是这段回答”。跟进写 `later` 想放到以后，结果修改项变成待做、指示是“later”，交办续轮时编码会照着这个空话去改（11-28 osdk 研究的 5 项和一轮 PATH 修复）。现在 `answerWorkerQuestion` 认 later / 以后再做 → 放到以后，skip / 不做 → 不做，理由取这条回答的 `basis`；同样的回答再交一次不报错。报告 schema 的 `answers` 说明里写了这个用法。`test/supervisor-code.test.ts`。

## 跟进等模型空位不再往话题里发（2026-11-28）

- 跟进的一轮等模型空位（`hasRoom`）、后端刚出故障被排后（`downReason`）、服务商排队或限流（`isRetryableAgentError`）时，原来等满 `queueTimeoutMinutes` 就停止本轮，往话题里发“等待超过 10 分钟，本轮停止”，这一轮的事件也随之丢了。现在这类等待留在队列里每分钟再看一次，不限时长、不发话题（`supervisor.ts` 的 `waitForAi` 分 slot / retry / owner）；中途断了的轮次悄悄重试三次（`output.silentRetries`）后才在话题里说；设置、登录、额度用完照旧。每次尝试各等自己的 `queueUntil`。`test/supervisor.test.ts`。

## 最高思考强度多给空闲时间（2026-11-28）

- 后端的空闲看门狗原来一律按 Agent 档案的 `idleTimeoutMs`（默认 10 分钟）。Codex 在 xhigh / max 时会十几分钟不出声地思考，11-26 到 11-28 有六次运行在工具返回后被判“超过 600 秒没有任何活动”停掉，一次停在它刚要回答的时候，其中两次是长任务跟进。现在 xhigh 乘 2、max 乘 3（`src/agents/spawn.ts` 的 `idleTimeoutFor`），`openAcp`、命令行后端和豆包 CLI 都按它算。代价是真卡住的运行要多等一会儿才停。`test/stall.test.ts`。

## 研究可以重新交给跟进（2026-11-28）

- 研究退出跟进后，或 `longTasks.auto.studies` 关着时，本人可以在事项页的流程块点“交给跟进”（`POST /api/items/:id/flow/follow`，权限 `flows.operate`），用设置里的跟进 AI 新开一份跟进（`source_generation` 加一）。`ensureAutoFollow` 多了 `explicit`：本人要求的不看自动开关，也不受之前退出的限制，设置不对时直接报错。
- 研究的补挂和重新交给跟进共用 `adoptStudy`（`src/studies/auto-follow.ts`）：等着的选方向、验收结果改问跟进；退出后已经发给本人的“下一轮”卡先撤回，再问跟进，不会有两张。
- 研究里改缺陷的交办（没有 `codeChain`，不向哪个助手汇报）没有跟进时，修改项改不好就直接问本人。交给跟进时，`handOwnerTasksToFollow`（`src/agents/code-tasks.ts`）把这些还没答的改成等跟进，关掉本人的卡；自动接管编码交办（`followCodePlan`）也调它。
- 跟进交报告时，`askOwner` 里带 `task:` 编号的问题，修改项必须还在等跟进（`submitSupervisorReport` 校验）。同一轮里已经重做或放下的那项再问本人，本人答了也落不到任何地方。卡片发出后修改项才变的，本人的选择照样记成补充并叫醒跟进，不再整张卡报 409、丢掉选择。
- 流程视图多了 `supervisor`（`{id,status,ai}`），流程块显示由谁跟进，旁边是“不用跟进”或“交给跟进”（`web/src/components/ItemFlow.vue`）。

## API key 的每分钟限额和英语课程的网页（2026-11-28）

- 设置 → 后端与模型 → API key 每一行多了“每分钟限额”：`web/src/components/AiKeyLimits.vue`，整体和按模型的 RPM / TPM、最近一小时排队、各模型这一分钟的用量；保存走 `ai.providers[].limits`，清空传 `null`（`AiModels.vue` 的 `plain` 现在带上 `limits`）。
- 插件设置的 `source-spaces` 字段在 `PluginSettings.vue` 里是多选。英语练习页：`plugins/english/web/LessonCard.vue`（课程卡，`?lesson=<日期>` 打开）、`MaterialLink.vue`（“出自”，经外壳打开 `#/sources/<id>?from=&to=`）；页面工具 `english_lesson_get` 读某天的课程，不带答案。文档截图 `english-lesson`。

## 英语陪练的默认读范围和跨设备出处（2026-11-28）

- 材料空间留空时沿用档案读范围，选定后可读所选空间及插件自己的空间。读范围从 `src/plugins/blocks.ts` 的 `materialSpaceScope` 看起。
- 设备拉取重排聊天行号后，开题时按本地行号核对单行出处，题目和画像都保存完整行号区间。见 `plugins/english/materials.ts`。

## 英语陪练用材料出题与今日学习（2026-11-28）

- 从 `plugins/english/server.ts` 看题目、口语简报、评价及每日课程，从 `materials.ts` 看引用核对与去重。表达跟着画像里的知识点复习，语音模型收到匿名简述。
- `src/plugins/settings.ts` 和 `src/agents/runner.ts` 限定材料读取范围。规则 `plugins/english/rules/daily-lesson.yaml` 初次导入停用；启用后每天准备课程并用宿主通知发链接。页面数据约定在 `docs/v2/plugins.md` 的“材料出处和今日学习”。

## 研究里改缺陷的交办归研究自己的跟进（2026-11-28）

`longTaskForRun`（`src/agents/supervisor-code.ts`）认交办的事项上开着的研究跟进；`followCodePlan` 不再因为“来自流程”给研究的每个修复交办各起一件跟进（事项有研究方向即算研究）。常驻服务器上线自动跟进时，服务启动补挂给两个研究的 11 个修复交办各起了一件跟进，同时排了十几轮强模型，已改回。

## 交回的报告只存报告本身，网页上折叠（2026-11-28）

`run_agent` 的报告交回会话时（`src/agents/wakes.ts` 的 `returnChildReport`），会话里那条消息的正文只有报告；“按报告给本会话写回复……stay_quiet”这段说明放在 `meta.wake.note`，`meta.wake.report` 记下是哪个 Agent、哪次运行。助手那一轮看到的内容没变：`renderMessages` 把说明拼回报告前面，署名“<Agent> 交回的报告（宿主转交，不是本人说的）”；摘要和 `read_conversation` 也按这个署名，不再记成“助理”。问答页把交回的报告、多 Agent 工作里各轮的报告和定时唤醒都收成一行，点开看正文；旧数据里正文带着说明的，展示时去掉说明只留报告。这类消息本来就不发到飞书。

## “用一句话改”的规则卡：倾向不写成规则，提醒被挡住的指定 AI（2026-11-28）

起草角色 `ai-policy-writer` 只把“禁止 / 别用 / 只用 / 必须用”这类话写成 `use` / `deny`；“优先 / 尽量 / 可考虑”放进草稿新加的 `prefer`，卡片上单列，不改范围。预览（`src/agents/ai-policy-proposal.ts`）在长任务跟进用的 AI 或角色默认 AI 会被新规则挡住时加一段提醒，起草时也把这些指定告诉起草角色。卡片上的具体 AI 写成“Codex · gpt-6.2-astra · xhigh”（原来是 `ai:codex · · high`），后端去掉“(ACP)”，每个类别的范围、顺序、兜底写在类别的框里，不再用飞书上画成半宽、值另起一行的字段块。

## 回扫：分几次做完的事，中间的进展算接着往下（2026-11-28）

`roles/outcome-reviewer.md`：盯发布、等部署、交办的一轮这类如实报告做到哪一步、之后助手自己接着做的回答标 `next`，不再标 `supplement`；`supplement` 只留给漏了原话要的、说做完其实没做完、运行没出结果的。

## 回补时回扫一段接一段（2026-11-28）

`src/agents/outcome-review.ts` 的运行交完一段、回补还没完时立刻排下一段，不再等巡检的下一个节拍（原来一刻钟只跑一段，每段三四分钟）。这一段一次回答都没交时不接着排，留给巡检。

## 研究正常完成后再来一轮（2026-11-28）

从 `src/agents/auto-follow.ts` 读起。正常完成后再开研究，新一轮有自己的任务书和预算，上一轮的报告和进度保留在原话题。已选择“不用跟进”的研究继续由本人确认方向。

## 研究、编码交办与多 Agent 工作自动跟进（2026-11-28）

从 `src/agents/auto-follow.ts` 读起。自动跟进记录工作来源，首版任务书随报告生效。原会话可退出，之后仍能查到已作出的决定。三类工作各有独立开关，编码交办另按拆分和轮数判断。进度卡、可编辑的必问清单和每轮报告在 `src/agents/supervisor-report.ts`。

服务启动时同时补挂研究和编码。编码交办即使没有活跃运行，只要当前轮还在等确认或等修改项答复，重启时也会按原门槛补挂一次。等待中的研究关卡随退出操作交回本人。研究流程的运行阶段可在 `done: confirm` 旁写 `confirm: supervisor`，详见 `src/flows/engine.ts`。

## 沙箱在启动前报告后端与命令的登录目录冲突（2026-11-28）

从 `src/agents/credential-registry.ts` 的 `checkBackendCommandState` 读起。本人、成员及借用账号启动 Linux 沙箱时检查两个路径是否相同或互相包含。冲突时提示分开供给独立凭据或改用其他后端。

## 登录目录重合的凭据插件可注册（2026-11-28）

从 `src/agents/credential-registry.ts` 读起。注册接受后端与命令的状态目录相同或互为父子。本人关闭沙箱时可照常使用这类登录。

## 按运行类型分批启用沙箱，分开后端与命令登录（2026-11-28）

从 `src/agents/own-run.ts` 读起。非空的 `includeKinds` 只隔离列出的本人运行，`excludeKinds` 优先。飞书 CLI 在执行器里使用本账号的登录，常见浏览器资料加入默认隐藏清单。凭据插件分别供给后端与命令状态的例子见 `examples/plugins/acmeauth`。

## Git 远端与子模块更新使用本身份的登录（2026-11-28）

`src/agents/git-command.ts` 供垫片和执行器共同识别 `git remote update` 与 `git submodule update --remote`。这两类更新与 fetch 共用执行许可和命令审计。查看、添加或删除 remote 仍按本地操作处理。

## 执行器恢复命令登录变量（2026-11-28）

`src/agents/command-executor.ts` 为 gh、npm 等命令恢复各自的登录环境，受信任的凭据插件可按子命令声明 `loginEnv`。本人使用后端档案或宿主环境中的值，成员只使用本账号的值。

## 沙箱命令使用本人授权的额外目录（2026-11-28）

从 `src/agents/own-sandbox.ts` 的挂载计划读起。执行器沿用启动时确定的工作区权限，额外仓库可通过 cwd 或 Git 的 `-C` 使用。后端状态、隐藏路径和各命令自己的登录仍分别隔离。

## 沙箱保留 npm 的源设置（2026-11-28）

从 `src/agents/sandbox-npmrc.ts` 读起。Linux 本人和成员沙箱把用户 npm 配置作为只读快照挂回原位，保留源、作用域、代理及 CA 设置，去掉登录字段。私有源需要认证时由明确授权的执行器处理，或由本人安装。

## 本人沙箱的登录路径与运行类型（2026-11-28）

从 `src/agents/own-run.ts` 读起。挂载工作区后再遮住登录文件、SSH agent 套接字和插件状态，设置可替换内置路径或排除指定类型的本人运行。`src/agents/egress-run.ts` 将本人沙箱接入已有的 all-sandboxed 出网模式。命令启动从 `src/agents/command-executor.ts` 读起，同身份的命令使用独立沙箱和流式管道，原有借用流程保留。

## API key 检查等待分钟额度（2026-11-28）

- 从 `src/core/ai-keys.ts` 读起。对同一个接入点试调用 OpenAI 和 Anthropic 两种格式时，共用分钟额度。轮到请求发往上游时才开始计 30 秒超时，`rpm: 1` 时第二种格式可以等到窗口释放后完成检查。

## 决策等不到 API key 分钟额度时的处理（2026-11-28）

- 从 `src/core/decision.ts` 读起。所有决策模型都来不及等额度时，按决策失败处理。配置 `fallback: general` 时改问通用模型，配置 `fallback: none` 时按否处理。等待超时仍不计入提供方故障，设置页试用会显示等待超过时限。

## API key 的分钟限额（2026-11-28）

- 在 `ai.providers[].limits` 设置 RPM / TPM，可按模型名或接入点 ID 覆盖。同一 key 和请求模型共用滚动 60 秒窗口，按到达顺序排队，收到用量后修正预占。实现从 `src/core/ai-rate-limit.ts`、`ai-request.ts` 读起。
- 中转收到明确的分钟限额时保留连接，按原 key 和模型最多等三轮。决策时限不够就跳过。运行记等待秒数，设置接口给出最近一小时的等待和各模型窗口用量。入口见 `src/core/ai-relay.ts`、`decision.ts` 和 `src/server/http.ts`。

## 用 /跟进 开启和管理长任务（2026-11-28）

从 `src/agents/supervisor-command.ts` 读起。在工作话题发 `/跟进` 看进展，进度卡显示由哪个 AI 跟进。跟进消息沿用主助手署名，设置项名为“长任务跟进用的 AI”。

## 群工作话题接收斜杠开头的补充（2026-11-28）

从 `src/channels/lark-bot.ts` 的群话题入口读起。发起人在工作话题直接发接口路径或目录名，会按原文追加到任务书并立即唤醒。路径的首段即使是后端名（如 `/claude/settings.json`），群入口与会话收件也都按补充处理。其他已注册命令和选择 AI 的命令仍按群消息原有的 @ 规则处理。

## Codex 启动流量（2026-11-28）

- omem 启动的 Codex 关闭 `plugin_discovery_prefetch`。ACP 用 `CODEX_PATH` 给原本选中的 Codex 传启动参数，CLI 后备和额度查询直接传同一开关。仍可按需浏览和使用插件。

## 云端后端调工具（2026-11-28）

- 试验、编码和评审、带工作区或要求运行本机命令的阶段只走本机后端。流程用 `by.run.local: true` 声明；入口见 `src/flows/engine.ts` 和 `src/agents/runner.ts`。
- 云端工具凭据按活动运行续期。名单外的调用返回本轮工具及用途，无头 GET 可用 next 继续。工具失败事件写截断脱敏的原因。角色说明按 HTTP 名单裁剪。见 `src/agents/cloud-tools.ts` 和 `instruction-sections.ts`。
- 试验、阶段和研究发现可随结果交 `evidence_text`，宿主保存为文本产物并引用。飞书 `msg:om_…` 能定位到可读聊天原件的一行；误用事项参数、试验编号或飞书 token 时提示正确工具。见 `src/agents/tools.ts`、`artifacts.ts`。

## 进度块的任务行对齐（2026-11-28）

- 运行页“分头在做的”、事项和工作页“在做的”（`ProgressBoard`）：同一块里的任务行共用列宽（`.pg-tasks` 定列，各行 `subgrid`），结果列至少 6em，产出列不再随“已接受”“29 条取舍”“阻塞”的宽度左右错开；圆点对齐标题第一行，不再在产出占两三行时掉到中间。研究的试验行在列里缩进（圆点平移、标题加内边距），不加宽圆点那一列。演示数据上 1440 和 390 宽度核对过，没有溢出。

## 回扫回答代替每晚复查：按件判、两种新标注、任务类型、查数记录；工作文件可以改路径（2026-11-28）

- 设计在 docs/v2/reply-sweep.md。发出满一天的回答按会话分段（一个会话当天的回答，最多 15 次一段，几个短会话可以一起，一次一个运行，同一会话按时间先后），`outcome-reviewer` 读整段对话交 `review_reply_outcomes(tasks)`：分件（能接上之前的件）、每次回答的标注和缺的是什么、件的结论、类型、主题、查数记录。原来按信号挑三十条复查的逻辑去掉了（`reviewCandidates`、`pickForReview`、随机抽查），`replies.outcome.review` 去掉 `sample`，`max` 改成每天最多回扫几次回答（默认 200），`batch` 默认 15。
- 标注：“被追问”拆成“接着往下”（`next`，算有用）和“要补充”（`supplement`）；第一遍小模型也用新的六种，旧的 `followup` 照原样留着、数据页单列。回扫同意记 `checked_pick = 'sweep'`，不同就改判（`revised_by` 是“回扫（模型）”），会盖过此前模型的改判，不碰本人的和表情的。
- 新表 `reply_tasks`、`task_types`、`data_queries`，`reply_outcomes` 加 `task_id`、`missing`、`swept_at`、`sweep_tries`，都随拉取同步。类型两级，起始为空，回扫自动建（一段最多三个，本人删掉过的不再建），本人可改名、挪层级、合并（件跟过去）、删除（`/api/task-types`）。
- 回补：`POST /api/replies/sweep {since, until?, limit?, perDay?, reset?}` 先补登记更早的回答（标“没判”），从最早的开始扫，到条数上限或扫完就停；`reset` 清掉那一段回扫的结论、件和查数记录。`GET /api/replies/sweep`、`/api/reply-tasks`、`/api/data-queries` 看进度和结果。两回都没交结论的回答按第一遍留着。
- 数据页：“谁触发的”显示飞书姓名（`askerOf`：成员按邮箱认成成员），模型名归一（`modelKey`），“回扫过的”“回扫同意第一遍的占比”“还没回扫的”。
- `move_file`（“收进材料”组）和 `POST /api/sources/:id/move` 的 `path`：工作文件改路径或空间，id 不变，移动记录写着从哪条路径到哪条。数据相关的放法（`数据/数据源目录.md`、`数据/观测计划/`、`数据/采集/`、`数据/查数/`、`数据/报表/`）写进 `roles/_common.md` 和技能 data-sources、observation-plan。

## 跟进命令沿用话题的 AI 写法（2026-11-28）

从 `src/agents/supervisor-command.ts` 读起。创建任务和更换跟进的 AI 都用 `parseAiSpec` 按发起人解析后端、别名、组、设备或密钥。任务保存选中的具体 AI。指定后端时，英文目标另起一行。模型简称有多个候选时，回复会列出完整型号。

## 飞书工作话题的暂停和结束命令刷新原卡（2026-11-28）

从 `src/channels/lark-bot.ts` 的群消息入口看起。发起人可以在工作话题直接发送 `/跟进 暂停` 或 `/跟进 结束`。接收机器人按群和话题定位任务，命令沿用空间写权限校验。只有在该话题向机器人提问或接着发附件，才会延长两分钟的附件跟随时间。

命令、HTTP 和卡片按钮在 `src/agents/long-tasks.ts` 保存变更后共用一次刷新。原卡在暂停后显示“继续”，结束后收起全部操作按钮。

## 跟进汇总卡上的修改项决定（2026-11-28）

从 `src/agents/supervisor-report.ts` 的汇总卡回调看起。本人选择的做法记入修改项和长任务补充。助手已经让同一项重做两次时，本人仍可决定继续，下一轮沿用长任务剩余预算。

## AI 规则和组有了网页（2026-11-28）

- 设置 → 后端与模型 多一个子页“规则”（`web/src/components/AiRules.vue`）：顶上“用一句话改”（`AiPolicyPropose.vue`，起草运行好了在原处出确认卡，运行 id 存在标签页里，回来接着跟）；“任务类别”（`AiClassRules.vue`）一类一行，点开改能用的组或 AI、排除、先后、只用这些，看规则来源、近 7 天用量和被排除的角色默认 AI，整份 `PUT /api/ai/policy`；“AI 组”（`AiGroups.vue`）整份 `PUT /api/ai/groups`。
- 规则里的写法（`backend:` / `model:` / `ai:` / `key:`）在页面上一律换成人话、用下拉选（`web/src/lib/ai-policy.ts` 的 `selectorText`、`AiDenyPicker.vue`）；冲突标记按服务端 `policyReason` 的读法在前端算一遍（`scopeReason`）。
- 原来“默认 AI 与档位”的三档编辑和后端里的“适合做什么”（任务选型候选）去掉，改由 AI 组编辑：第一次保存前编辑器从旧档位和候选预填（`effectiveGroups`），保存后服务端清掉旧的两处。通用页只列各组并链过去；旧链接 `?card=tiers` 落到 AI 组。
- 后端点开后多了“命令别名”（自动命令词灰色只读，自定义的存在 ACP 那份配置的 `aliases`）和“在哪些 AI 组里”。保存任务选型后有 `guidanceWarning` 时提示并可“转成规则”。
- Agent 页：档案的“默认 AI”换成“能用的 AI”（`AgentAiScope.vue`：`class`、先用的 AI、`ai.use` / `deny` / `strict`）；内置角色的默认 AI 下写它那一类的范围和冲突。决策页加“按类别选 AI 的结果”（报告的 `routes`）。
- 服务端只加了一处：`GET /api/ai/policy` 带 `backends`（每个后端的程序、key、不用问后端就知道的模型、自动命令词，`policyBackends`）。

## 回复结果把成员说的话记在他名下；取不到的指标不再每个节拍都重取（2026-11-28）

- 成员和机器人的会话里，他的话只带 `userId`、不带 `speaker`，判断回复结果时被当成“本人”说的；飞书里那份同样的话前面带着机器人的 @，去重认不出来，每句话出现两遍。决策模型看到的是“本人又问了一遍”，夜里复查也会误报“本人之后在那里自己答了”。现在第一遍（`followUps`）和复查的材料（`readAfter`）都按 `turnSpeaker` 认人（`speaker` → 成员名 → 本人），去重的键去掉 @ 提及（`messageKey`）。已经标过的旧记录不重判。
- Agent 取的指标没记下值时，宿主不记“试过了”（`lastAttemptAt` 只有插件取数会写），每个巡检节拍都当它到期。在常驻服务器上，七个缺读权限或口径的指标让“取指标”运行一天跑 34–48 次、合计三个半到五小时，直到每天 40 次的上限。现在排上一轮就给这批指标记一次尝试，下一轮等满一个周期，和插件取数一样；没取到的原因照旧写在那一轮的记录里。

## “先看一眼”改名“帮你回复”；关注里触发得更多；有人找你也能先帮你回复（2026-11-28）

- 快速通道的第二层改名“帮你回复”（卡片标题、运行标题、角色名、设置页、文档）；运行种类 `first-look`、角色 `first-look`、设置键 `firstLook` 不变。
- 关注的每天次数（`perDay`）原来把开始时就让开的帮你回复也算进去（这一批已在处理、群里已有回复、预筛认为不用看）。在常驻服务器的一个关注上，三天 72 次里 44 次是这种，一天能用掉三十几次，之后连 @ 本人的消息也没有帮你回复。现在只算真正看了的，@ 本人或机器人的不受上限（和这一批一样）。
- 连发时只有第一条轮得到：帮你回复答完后放开这一批，这一批马上带着看的时候新来的消息跑掉，排着的下一次帮你回复开始时发现它们已被处理，只能让开。现在放开时若有排着的帮你回复看这一批的消息，这一批等它先开始（多等 15 秒，`LOOK_LEAD_MS`），由它再压住这一批。
- 有人找你新增“先帮你回复”（`mentions.firstLook`，默认关，设置 → 代你回复 → 有人找你）。分诊说要查时先排一次帮你回复（`src/mentions/first-look.ts`），快模型读分诊整理的材料和本人所有空间：答得了就发有人找你的提醒，回复作为草稿附在同一张卡片下（“自动”档也只拟草稿）；要本人定的提醒本人；不用回的不提醒；答不了交给分诊选的处理者，任务里多一节“帮你回复已经看过的”。占一次 `perDay.handle`。
- `FirstLookInput` 加 `source: "mention"`、`mention`（和处理者一样的 `MentionInfo`，草稿卡片、发送、回复样本照用）、`mentionLook`、`spaces`；`startHandling` 多一个参数带上帮你回复的结论。

## 飞书卡片不用登录也能预览；文档站加了卡片截图（2026-11-28）

- `node scripts/card-preview.ts`：用真实的卡片代码（`askCard`、`viewCard`、阶段卡和方案确认的排版）在临时数据目录里生成样例，用开发依赖 open-feishu-card 按电脑和手机宽度画出来截图；`--json` 画任意卡片，`--site` 重画文档站的 `lark-card-stage` / `lark-card-design` / `lark-card-view`（机器人与卡片页）。和客户端的差别写在脚本开头和 docs/v2/lark-cards.md 第 5 节。
- 方案确认的排版提成纯函数 `designConfirmation`（`src/designs/work.ts`），脚本和交办共用。
- 预览里看出来的：回答后的宿主卡片原来还是灰色卡片头，灰色的“已回答”标签几乎看不见；现在宿主卡片回答后也是不着色的卡片头，颜色只在标签上。展示块的卡片（`show`）第一个结论不是需要关注或故障时，卡片头从灰色改成不着色：飞书规范里灰色表示失效，真实 Agent 的一张运行盘点卡看起来像过期了。
- 常驻实例上用真实 Agent（codex gpt-6.2-sol）问了一次“过去 24 小时的运行情况”：它用了 `callout`、`metric` 和四个 `fold`（明细收在折叠里），没用 `list`。
