---
title: 2026-10-13 之后的变化
summary: 本 Wiki 生成之后加进 omem 的功能和修正，这里只留最近的；更早的按时间段放在同目录的归档文件里。读其他页面时遇到对不上的地方，先看这里。
kind: reference
updated: 2026-11-24
---

这套 Wiki 主体生成于 2026-10-13。之后的提交按模块整理如下，每条给出改了什么和从哪个文件读起。[记忆与事项](../concepts/memory-and-items.md)、[渠道](../concepts/channels.md) 和 [参考](./tools-commands-runs.md) 已按 2026-10-18 的代码补过，其他页面可能还停在旧实现。以代码为准。


**这个文件只留最近的改动**，新的加在最前面。更早的移到了同目录的归档里，找旧改动时按关键词在这几个文件里搜，不用整份读：

- [2026-11-22](./changes-2026-11-22.md)：任务板跨设备任务的停止与重派、本人沙箱的目录与审批。
- [2026-11-21 下半天](./changes-2026-11-21-second-half.md)（68 节）：编码交办的用量归集、云端工具的令牌和探测、成员权限按区域和对象检查、严格运行的出网代理、插件的通知出口，以及成员的线和“等我的”、变化台账、“今天”并进简报、需求到交付的链路、远程会话交给成员、插件的检索 / 原件格式 / 页面类型、HTTP 规则的判定入口、成员能力和成员沙箱里的编码。
- [2026-11-21 上半天](./changes-2026-11-21-first-half.md)（60 节）：整理第一批（方案、设置页和数据页重做、其余页面整理）、工作线三四期和关注页、指标由本人确认、协同任务板、等本人处理的清单和提问卡的免打扰、按后端能力裁剪常驻说明和云端会话收尾、操作规则和规则包、对象授权、成员在助手里看流程和存规则、插件订阅事项与评审。
- [2026-11-20](./changes-2026-11-20.md)（24 节）：关注（盯群换成关注、从历史学、主动推进）、工作线的事项上下层和现状、演示和 Chrome 扩展的录制、成员用自己的 AI 账号、工作上的指标、每晚复查回复结果、插件设置。
- [2026-11-19](./changes-2026-11-19.md)：编码交办、流程、评审复核、会议、网页、设备和插件回调。
- [2026-11-18](./changes-2026-11-18.md)（25 节）：要本人回答的内容分段写、图片和文件并进 @ 机器人的一轮、事项的流程页、技能分组整理、浏览器长期资料、重启后接着做、ACP 适配器升级、会议里叫机器人和回答提问、知识库爬取暂停、订阅会话并进飞书会话、设置 → AI 按后端整理，以及流程和插件对象的设计稿（11-15）。
- [2026-11-15 至 11-17](./changes-2026-11-15-to-17.md)（45 节）：流程第二至四期（上下文跟进、Git 信号、补录与签字、看板、提交认领）、课题第一至三期、插件的对象与信号和界面插槽、数据页与图表、回复发出后有没有用、时区、AI 后端的网络条件与 DNS 诊断、机器人改文档和 lark-cli 重新授权等渠道修正。
- [2026-11 上半月](./changes-2026-11-first-half.md)（11-03 至 11-15 凌晨，166 节）：多人登录与权限、连接器与插件、界面块与交互页、远程使用、方案与变更说明、有人找你、会话感知、工作近况、代码索引、材料归位、组网、Wiki 写后核对，以及调研建议的头两轮（召回、巡检预筛、抽检、评审、通知、场景包、技能试用）。
- [2026-10](./changes-2026-10.md)（10-13 至 10-31，128 节）：规则页与规则引擎、多 Agent 协作、访客与私聊指令、分档评审、多个飞书机器人、会议规则、插件、设备的外部 Agent、夜间复盘、原件治理、需求树。

这个文件超过四百行左右时，把最早的一批整节移到归档里（没有合适的就新建一个按时间段命名的文件，并在上面加一行）。

## 对话切换 AI 后接手轮收到切换结果（2026-11-24）

接手的 Agent 以前只看到原始请求，把其中的切换要求重新执行，每轮又开一颗飞书思考气泡。现在 `switch_run_ai` 按会话实际使用的默认值比较后端、模型和强度，等价配置直接返回已设置。旧运行只记录一个接手运行。接手轮的提示带上设置结果和实际使用的 AI，继续回答或处理原消息里的任务。回归测试覆盖省略和显式传入默认值、并发调用、实际更换强度。入口在 `src/agents/tools.ts` 和 `sessions.ts`。

## 成员读飞书文档缺权时预勾「文档与知识库」（2026-11-24）

`lark_doc_fetch` 遇到 CLI 报缺新版只读权限或旧版的创建及编辑权限时，成员收到的链接带 `features=docs`。同一会话拿到 `docx:document:readonly` 就能续跑，六小时内留下的旧版读取等待也认这个权限。测试覆盖新链接、旧等待和仅有编辑权限时继续等待。入口是 `src/channels/lark-auth.ts` 和 `src/auth/connect-wait.ts`。

登录或连接时勾选「文档与知识库」，同时申请 `search:docs:read`（列出最近打开的文档）、知识库细分查询、云空间目录及元数据、文档素材和画板读取。旧版文档权限加搜索已足够继续采集，缺搜索的连接在账号页可补授权。权限清单见 `docs/v2/multi-user.md`，登录授权参数由 `test/connections.test.ts` 核对。

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

## 流程阶段交给本人看的链接（2026-11-22）

阶段卡住等本人确认一份表格时，卡片和事项页上只列依据的标题，表格地址藏在依据原件里，本人找不到要看的东西。`stage_report` 加 `links: [{label, url}]`（http(s)，最多 10 个），存进阶段的 `control.links`：再交一次不带 `links` 的结果保留上次的，传空数组清掉。事项页这一段多一行“交给你看”（`ItemFlow.vue`、`ItemFlowPage.vue`），进度视图里链接排在依据前面（`outputs` 的 `kind: "link"`，新标签页打开），做完或卡住时给本人的进度卡末尾带“交给你看：[名称](地址)”（`src/flows/store.ts`）。`roles/_common.md` 的“流程里的一个阶段”要求等本人确认某份东西而卡住时必须带上链接。读起：`src/flows/engine.ts` 的 `reportStage`、`src/agents/progress.ts` 的 `flowView`；测试 `test/flows.test.ts`“卡住等本人确认一份表格时带上链接”。

## 插件永久信任、预检带账号名和邮箱、新成员用邮箱前缀做 ID（2026-11-22）

- 永久信任：`src/plugins/trust.ts` 的信任记录带 `permanent`，`trustState` 对它直接算“已信任”（链接的插件仍要目录不变），`acceptCredentialDeclarations` 接受新声明；`setTrust` 在再次信任时保留这个选择。`registry.ts` 的 `trustPlugin` 收 `permanent` 参数（只改开关时不重新加载，写 `audit_events`），`describePlugin` 带 `permanentTrust`；网页在插件卡片上加开关。
- 预检：`src/agents/credentials.ts` 的 `precheckCredential` 给插件的 `req` 加上 `account`（这个人这份持有的账号名）和 `email`（omem 里他的邮箱），SDK 类型同步。插件据此找到资源服务要查的人，不用本人手填对照表。
- 新成员 ID：`src/core/users.ts` 的 `createUser` 有邮箱时用邮箱前缀（原来中文名会退回 `u` 加时间戳的随机串）。已有成员不改名。
- `test/users.test.ts` 里“成员读设置被拒”改成成员只读到出借相关的两项（凭据第二期起就是这样）。

## 聊天交办的后台任务复用持有人的同意（2026-11-22）

从 `src/core/db.ts` 的 `credential_task_runs` 读起。发起聊天结束后，后台交办仍可保存和复用任务同意。同一聊天另开的任务要单独询问。任务链最后一个运行结束时清除授权。

## 只读命令借用凭据时向持有人确认（2026-11-22）

从 `src/agents/credential-execution.ts` 的实时预检读起。`credential-confirm.ts` 建立持有人提问，等待十分钟，并把任务内的同意限定到根运行、双方、凭据和资源。机器人私聊和“等我的”共用提问；飞书来源群的独享提醒、机器人邀请和本人身份退路见 `src/channels/lark-credential-confirm.ts`。

## 保存向量设置时的重建确认与跨关注消息的来源（2026-11-22）

网页保存检索设置时，宿主先合并磁盘上的修改，再核对权限和向量目标。预览后地址、模型或维度又变了，接口会返回新目标的预览和令牌。确认并写盘成功后才替换索引，写盘失败时可继续用原向量检索。从 `src/server/http.ts` 的 `PUT /api/settings` 和 `src/core/config.ts` 读起。

个人关注通过 `read_source` 或 `read_conversation` 读取另一关注的消息时，宿主把实际返回的消息来源记到当前轮。用项目群原话搜索或定时回查时，个人空间的向量插件不会收到查询，全文和符号仍可命中。从 `src/agents/tools.ts` 的两个读取入口和 `src/core/message-origins.ts` 读起。

## 账号页和成员总览区分本机登录的未知与停借（2026-11-22）

从 `src/agents/credentials.ts` 的 `viewOf` 读起。两个页面共用 `web/src/lib/credentials.ts` 的状态标签。本机登录还没有检查结论时显示「状态未知」，沿用出借设置。检查确认缺失后显示「没登录（已停止出借）」。

## 本机登录检查失败时的凭据出借（2026-11-22）

登记凭据种类时就建立本人的持有。AI 后端和命令行都能按出借设置选到尚未检查或检查无结果的本机登录。检查明确报缺失或过期后停止出借，后续检查异常仍保留上次结论。只读命令须由资源服务实时核实发起人的读取权。持有选择从 `src/agents/credentials.ts` 读起，命令选人和执行分别见 `credential-access.ts` 和 `credential-execution.ts`。

## 设置 → 空间改成紧凑的树；运行页按后端或模型筛选；确认交办只推一部分仓库（2026-11-22）

- `web/src/views/settings/Spaces.vue`：左边每个空间一行（名字 + 仓库数），业务空间下的仓库可以折叠（展开状态存在浏览器里，筛选时全展开，筛选也匹配仓库名和目录），说明和目录放进悬停提示；不属于任何业务的仓库在“独立仓库”小标题下。右边不再空着：打开时依次选地址里的 `?space=`、上次在这页打开的、当前空间、列表第一个；空间的说明、原件 / 页 / 仓库数（仓库是所属业务和目录名）移到右边的标题下。底部“关闭”换成“还原”（丢掉没保存的修改）；新建表单取消后回到原来的空间。右边的仓库清单每个两行（名字和索引状态一行、目录一行）。
- 确认交办可以只推一部分仓库：`confirmBranchRun` / `applyCodeRun` 加 `spaces`（`POST /api/runs/:id/apply` 和工具 `apply_code_run` 同名参数），没选的仓库不压缩、不推送、分支原样，工作区照样归还，结果的 notes 写“没动”；分支面板（`CodeBranchPanel.vue`）在有几个仓库时列出勾选框。测试 `test/code-confirm-some.test.ts`。
- 运行页：全部运行 → 筛选 多了“后端或模型”下拉（和“全部类型”同一行，下面是触发人、触发方式，两列对齐），列出近 30 天用过的后端（AI 档案）和它们用过的模型（只有一个模型的后端不再分列）。接口 `GET /api/runs/ais`（只统计这个人能看的运行），`GET /api/runs` 加 `ai`、`model` 参数；后端按运行记下的 `ai.profile`，没有时用排队时的 `profile_id`（`src/agents/runs.ts` 的 `runAis`）。测试 `test/run-ai-filter.test.ts`。

## 观察者读取个人凭据清单时隐藏出借方式和成员名单（2026-11-22）

从 `src/agents/credentials.ts` 的 `myCredentials` 读起。凭据清单和设置接口复用 `src/auth/capabilities.ts` 的成员身份判断。观察者仍能读取自己的凭据清单，响应省略全局出借方式，候选成员为空。两处接口的对照用例在 `test/credentials.test.ts`。

## 云端后端可以用内网地址回调，课题的阶段能交给云端跑（2026-11-22）

- 实测：豆包 OpenAPI 的云端沙箱能用 curl 访问公司内网 IP 上的 omem（带回了只有本机会返回的响应），能执行 shell，也能访问 GitHub。
- `agents.cloudTools.privateAddress`（默认关，本人在 设置 → 安全 →“云端后端调工具”里打开，先确认一次）：`cloud-probe.ts` 的 `cloudAddress` 接受内网的 http(s) `webUrl`，`checkCloudAddress(app, url)` 只要求能解析；探测和确认照旧。
- `cloudToolNames` 加课题交结果的 `read_ledger`、`propose_directions`、`trial_report`、`record_finding`、`close_direction`。签发凭据时与运行自己的工具取交集（`cloud-tools.ts` 原逻辑），所以只在课题的阶段可用。`runner.ts` 的云端小节改名“## 云端工具”，有交结果工具时提示必须用工具交回。
- 测试：`test/cloud-probe.test.ts`（内网地址只在开关打开时接受、凭据和查询串仍拒绝、课题工具可选）。
- 在 ljy1 上第一次让课题的“定方向”在豆包 OpenAPI 上跑时，选后端把它跳过了：判断能否交结果只认 MCP 和命令桥，而且“必须的工具”算进了阶段顺带的 `attach_artifact` 等。改成：流程阶段只把交结果的那一个工具当必须（定方向 `propose_directions`、试验 `trial_report`、其余 `stage_report`，`flows/engine.ts`），云端后端探测已确认、必须的工具都在云端名单里时算能交结果（`runner.ts` 的 `overHttp`）；`stage_report` 也加进可选的云端工具。

## Copilot 的设备码登录、Gemini 的 API key（2026-11-22）

- 在本机装了 Gemini CLI 0.70、Copilot CLI 1.0.114、Qwen Code 0.28.3 实测：Copilot 的 `login --device-code` 打印 GitHub 的设备页和验证码，和 Codex 同一种，加进目录（`account.login`，`COPILOT_HOME` 放进账号目录，也可粘贴 `COPILOT_GITHUB_TOKEN`）；它没有查状态的命令，登录命令以 0 退出就算登录（成员的 `accounts.ts` 和本机的 `machine-login.ts` 都这样认）。Gemini 自己的登录只在真终端里问授权码（管道上直接拒绝，`-i` 也不行），浏览器方式回调本机回环端口，所以只给成员加了粘贴 `GEMINI_API_KEY`，本机的登录仍要在终端里做。Qwen 已经去掉 `qwen auth`，只能在交互界面里 `/auth` 或用环境变量给 key，没有加。
- osdk 在 Windows 上把命令入口都做成同一个程序的硬链接，有任何一个入口在运行（比如开着的 `omem peer open`）时装新包会在“syncing shim”报文件被占用；安装任务遇到这个错误时说明原因（`adapter.ts` 的 `settle`）。

## 在网页上登录这台机器的后端，Claude Code 能贴授权码登录（2026-11-22）

- 以前这台机器本身（服务在用、成员借用的那份）的登录要到机器上跑 CLI。`src/agents/machine-login.ts` 用目录里已有的账号声明（`account.login` / `status` / `cli`），以服务自己的环境和 HOME 跑登录命令，不进成员沙箱：链接、验证码给页面，状态命令退出码 0 算登录。接口 `GET|POST|DELETE /api/agents/:id/machine-login`（`?check=1` 现查一次）、`POST …/machine-login/input`，都只给本人（`routes.ts`）。网页：设置 → 后端与模型 展开后端，最上面“这台机器的登录”（`web/src/components/MachineLogin.vue`），目录没声明登录方式的后端不显示。
- 登录声明加 `input`（`catalog.ts` 的 `AccountSpec.login`、配置里 `account` 的校验）：登录命令打印链接后等人把授权页给的码贴回去。Claude Code 用 `claude auth login`（在管道上也读这一行），所以成员在 账号 → 我的 AI 账号 也能直接登录 Claude Code，不必在自己电脑上 `claude setup-token` 再粘贴令牌（令牌仍可用）。成员这边 `accounts.ts` 的 `sendLoginInput`、`POST /api/me/agent-accounts/:backend/login/input`，页面上多一个授权码输入框。
- 现在声明了无界面登录的：Codex（设备码）、TraeX（设备码）、Claude Code（贴授权码）、豆包命令行（二维码链接）。Gemini、Copilot、Qwen 等其他后端没有声明，页面上不出现登录，仍要在机器上登录。
- 测试：`test/machine-login.test.ts`（假 CLI 打印链接、等授权码、状态命令）。

## 从 ACP 注册表添加的后端也能升级（2026-11-22）

- 从注册表“下载”的程序装在 `<数据目录>/agents/<id>/<版本>/`，npx / uvx 添加的在参数里写死了 `<包>@<版本>` / `<包>==<版本>`，以前没有任何地方会把它们升上去。`src/agents/registry-update.ts` 从配置认出这三种来源和版本（`registrySource`），和注册表（缓存十分钟，“检查更新”时重新读）比较。
- 设置 → 后端与模型 展开这类后端，适配器那一行显示版本和“有新版 x”，升级走同一个后台任务（`adapter.ts` 拆出的 `startTask`）：下载的程序按注册表的 sha256 校验后解压到新版本目录，配置改指过去，留上一版、删更早的，再检测一次模型；npx / uvx 只改参数里的版本，下次启动时取（不在任务里检测，免得在任务里下载）。`POST /api/agents/:id/adapter/upgrade` 和远程命令 `agent-upgrade` 经 `upgradeBackend` 分到 npm 适配器或注册表；注册表后端不能指定 version。
- 测试：`test/adapter-jobs.test.ts`（来源识别、版本比较、npx 后端升级改参数）。

## 后端的 npm 包在网页上安装和升级，改成后台任务；ACP 目录对照注册表刷新（2026-11-22）

- 起因：在一台慢的镜像上同时点了 codex 和 claude 两个适配器的“升级”，带原生程序的包下了十几分钟；请求一直挂着，页面停在“升级中”，刷新后能再点一次；600 秒的超时只让请求返回，npm 进程还活着，正在升级的标记却清掉了；装到一半时旧版已经挪走、命令链接还没建，claude 的命令找不到了，后端掉进“未安装”。
- `src/agents/adapter.ts`：安装和升级都是服务端的后台任务（`AdapterJob`），一次只跑一个（同一个全局前缀），进程真正退出才算结束，45 分钟还没装完就停掉整个进程组。`GET /api/agents/:id/adapter` 带上任务（`?quick=1` 只要任务，不问 npm 最新版），`POST …/adapter/upgrade` 和新的 `POST /api/agents/:id/install` 立即返回任务。装完核对命令还在不在：装到一半命令没了，提示到“其他支持的 Agent”里重装；PATH 里找不到时说要把 bin 目录加进服务的 PATH。装完清掉 `availability.ts` 里缓存的“命令在不在”（以前缓存到重启）。
- 有 osdk 和 Node 时新装走 `osdk --yes use -g npm:<包>@latest`；升级时 `osdk where -g` 认得正在用的那一份才走 osdk，否则仍用 npm 装进命令所在的前缀。
- 网页：`AiBackend.vue` 跟着任务轮询，刷新后还能看到“在后台升级，已 N 分”和最后一行输出，失败时留一行原因；设置 → 后端与模型 → 其他支持的 Agent 里目录带 npm 包的多了“安装”按钮（`installable`，只给本人）。跟任务的轮询在 `web/src/lib/adapter-job.ts`。远程命令 `agent-upgrade` 用同一个任务，等装完才返回。
- ACP 目录（`src/agents/catalog.ts`）按官方注册表 11-22 的版本刷新：Qwen 加 `--experimental-skills`（旧参数自动换）；Kimi 换成 npm 包 `@moonshot-ai/kimi-code`；MiniMax 换成 `@minimax-ai/code-acp`（命令 `code-acp acp`）；OpenCode 的 npm 包停在 1.x，改成安装说明；新增 Kiro CLI、IBM Bob、GLM。注册表列表里 `claude-acp` 这类和内置 id 不同的条目按别名算“已可用”（`setup.ts` 的 `registryAlias`）。
- 测试：`test/adapter-jobs.test.ts`（假 npm 走一遍后台安装，POSIX 上跑）。

## 2026-11-22　缺少登录时按发起人的实时读取权借用命令登录

从 `src/agents/credential-execution.ts` 读起。命令垫片在本地执行前询问宿主。插件按完整参数核实发起人可读具体资源后，宿主可在自动出借人的环境执行只读调用，并把两路输出交回。发起人收到拒绝时保留原结果和申请链接。插件回执契约见 `packages/plugin-sdk/credential.ts`。

## 2026-11-22　凭据命令结果与资源权限查询

从 `src/agents/credential-access.ts` 读起。`who_can` 返回指定资源最近三十天的权限记录和申请链接。没有可见记录时，宿主按查询者的出借范围使用插件预检。权限记录留在本机。命令执行从 `src/agents/command-gate.ts` 和 `credential-outcome.ts` 读起。命令的 stdout、stderr 实时送回，宿主把资源读取和拒绝写进记录，登录失效时提醒持有人。

## 凭据第四期：账号页的清单、出借设置和成员页的总览（2026-11-22）

- 账号页在“我的 AI 账号”上面多了“凭据”（`web/src/components/CredentialList.vue`，由 `AgentAccounts.vue` 放进来）：每种一行，必做、状态、到期，供给的后端和命令点开看；登录 / 重新授权打开授权页、显示验证码并轮询到状态变化；退出前说清会一起退出哪些；“谁能借”选只给自己 / 指定成员 / 所有成员，指定成员选了人才保存。本人的凭据只有“谁能借”。
- “我的 AI 账号”里由凭据供给的后端标“由 × 供给”，退出换成跳到凭据那一行；还是收到 409 时把说明渲染在那一行下面。
- 设置 → 安全 → 凭据的出借（`CredentialLending.vue`）管 `credentials.lending`、`credentials.confirm.inviteAsOwner`、`agents.accountsDefault`；设置 → 成员 → 成员的凭据（`CredentialHolds.vue`）读 `GET /api/credentials/all`，可以替成员退出。卡片链接 `?card=credentials`、`?card=credential-holds`。
- 纯函数和测试：`web/src/lib/credentials.ts`、`test/web-credentials.test.ts`。演示数据（`scripts/doc-screens.ts`）装上 `examples/plugins/acmeauth`，另登记一个演示的代码托管凭据，三个成员各有有效 / 快到期 / 没登录的持有；演示里把成员账号沙箱当作可用。新截图 `account-credentials`。

## 成员能用内置插件带来的工具（2026-11-22）

从 `src/auth/tools.ts` 的 `setPluginToolCapabilities` 读起。11-21 工具改成按成员能力判定以后，内置插件的工具（connect 的 `connect_read`、`connect_watch`，各平台包）落在“仅限本人”的分组里，成员用自己的连接读平台也被拒。现在内置插件加载时按每个工具的 `write` 登记能力：只读的要 `ask.send`，会写入的要 `sources.edit`（只在调用者能改原件的空间里）。数据目录里装的插件的工具、平台对象的动作仍只给本人（`plugin-connectors` 的测试改成以本人验证连接器，并验证成员在入口被拒）。回归在 `test/plugin-tool-capability.test.ts`，原来失败的 `connect-plugin`、`platform-packs` 8 条恢复通过。

## 本人那份凭据检查出错时照旧出借本机登录（2026-11-22）

从 `src/agents/credentials.ts` 的 `backendUsable`、`selectCredential` 读起。原来本人的持有只有检查成功才算可借，插件的检查一出错（或插件没有 `check`），成员就借不到本人的本机登录了，比没有凭据时更严；检查失败还要等第二天才重查。现在只有检查明确说没登录或过期才不借；`credential-registry.ts` 在插件重新登记凭据时让本人那份下一分钟重查。回归在 `test/credentials.test.ts` 最后一条。

## 在 omem 里运行的插件重新加载时，引用的文件一起换新（2026-11-22）

从 `src/plugins/fresh-import.ts` 读起。原来重新加载插件只给入口文件加版本号，入口从插件目录里引用的文件仍是服务启动时缓存的那份：改了 `src/` 下的文件再重新信任，入口找不到新的导出就报错。现在头一次导入插件时注册 Node 的同线程解析钩子（`module.registerHooks`，每次导入几乎没有额外开销），把入口的版本号带给它从插件目录里引用的文件（`node_modules/` 除外）。插件页把“给成员登记凭据”列进权限，声明了凭据的链接插件改了代码标“代码改过，需要重新确认”。验证在 `test/plugin-fresh-import.test.ts`（起一个 Node 子进程，vitest 自己的模块加载不经过这个钩子）。

## 凭据第一期：插件登记、按人持有、供给和出借（2026-11-22）

- 从 `src/agents/credentials.ts` 和 `credential-registry.ts` 读起，设计和接口在 `docs/v2/credentials.md`。`api.credential` 声明一次授权覆盖的后端、命令行、安装和状态目录；只有声明 `permissions.credential` 且被信任为进程内运行的插件能登记，隔离模式下说明原因。声明进信任指纹，链接开发目录的插件按代码指纹重新确认。
- 三张本机表 `credential_kinds`、`credential_holds`、`credential_onboarding` 由一条迁移建成，不随快照同步；秘密走密钥库。登录和续签先供给、持有再生效；同一份持有的回调串行、超时取消；每日检查和续签按索引取，每批最多 32 份，过期和三天内到期按人通知。本人的持有只做只读检查，不调登录、续签、供给、退出。
- 持有记下历次供给的后端、命令和路径：由凭据供给的后端不能单独退出（成员和本人代办都返回 409，提示退出整份凭据）；整份退出删掉这份持有独占的文件，别的登录共用的目录保留；插件停用或撤销信任后照样能清理本地状态，不调插件的 `logout`；插件改了供给范围，原后端的文件仍受保护，新后端成功供给后才能用和出借。
- AI 后端用谁的登录：`agents.accountsDefault`（默认 `owner`，即原来的行为）可被 `agents.accounts[后端]` 逐个覆盖。允许借时先用自己的，再借本人开放的，其余按最近一次成功使用；借成员的登录在他的账号沙箱里起整轮，持有人的临时文件和套接字对借用者不可见；`credentials.lending` 不是 `auto` 时不借。借用写运行事件和 `audit_events`，会话重建换了凭据时重新校验出借权限。`accounts.ts` 预建声明的状态目录、只读挂上安装目录，`own-run.ts` 把声明的状态目录列进本人沙箱的默认可写清单。
- 接口：成员 `/api/credentials`（清单、登录、出借范围、退出），本人 `GET /api/credentials/all`、`DELETE /api/credentials/:user/:kind`；成员第一次进网页或 @ 机器人时发一次接入清单。示例插件 `examples/plugins/acmeauth`，测试 `test/credentials.test.ts`、`test/acmeauth.test.ts`。

## 2026-11-22：豆包 CLI 用空普通文件连接标准输入

- 从 `src/agents/doubao-cli.ts` 的 `emptyStdin` 读起。CLI 即使给了 `-p` 也会读非终端 stdin；`ignore` 对应的 `/dev/null` 在原生输入桥中可报“无法以 UTF-8 格式读取标准输入”，Node 创建的管道又是 socket。普通运行、帮助和模型探测统一传入可读的空普通文件，不依赖版本号；短提示和长提示的传递方式沿用原实现。
- 父进程在启动后关闭自己的文件描述符，输入文件留到子进程关闭后删除，启动抛错也清理。`src/agents/spawn.ts` 只扩展 `stdin` 参数类型以接受已有文件描述符，其他后端的默认值和启动方式保持原样。会话删除仍走 `src/agents/doubao.ts` 的 OpenAPI，没有删除会话的 CLI 启动点。
- `test/fake-doubao-cli.ts` 模拟字符设备读取失败、socket 拒绝和 stdin 内容追加。`test/doubao-cli.test.ts` 覆盖内联与长提示、模型探测和临时文件回收；换回旧的 `ignore` 启动后，两条新增用例都复现退出码 2。CLI 2.37.1 真机用 `GPT 6.1 Sol / high / ask_risky` 调修复后的长提示分支，收到“收到”，会话清理查询为不存在。验收和实现状态见 `docs/v2/acceptance.md`、`status.md`。

## 2026-11-22：网页用上第二轮补齐的服务端字段

- 流程定义页（`web/src/views/Flows.vue`、`lib/flow-hooks.ts`）：去掉校验失败时自己解析 YAML 列阶段的兜底，停用标记只看校验的 `unavailableReferences` 和列表的 `unavailableChecks`（`FlowStageHooks.vue`、`FlowChecks.vue` 收 `unavailable`），插件信号名取列表的 `stageSummaries`；停用插件后改阶段名照常保存。“新用到的能力没有插件提供”的提示改成只对新增或改参的引用说。
- 事项的流程（`FlowStagePlugin.vue`）：运行器用 `carrier.runner`，删掉从 `carrier.label` 解析的 `runnerOf`；信号名用 `waitingSignal.name`；被拦下的卡片状态用 `gateReview.ask`，删掉点按钮前读 `GET /api/asks/:id`。还在等时 `stageActions` 只给“重开”，选了等处理以后写“你选了等处理（时间）”并给“处理好了，重新检查”；别人看时写负责人的名字（`ItemFlow` / `ItemFlowPage` 传 `who`）。`GET /api/flows` 只在阶段有运行器或检查时才读（取运行器用途和检查名）。`WorkStageTrack.vue` 拿到的精简阶段没有 `gateReview`，没改。
- 设置 → 安全（`SandboxSettings.vue`、`lib/sandbox.ts`）：主目录用接口的 `home`，删掉 `homeOf`；“按角色”下面按 `fullAccessGrants` 列出单独开着完全访问的内置角色、档案、规则（`grantLinks`），各链到 Agent 页或规则页。
- 后端：`AiDefaults.vue` 删掉按 `<插件>:<id>` 猜停用的分支，只认 `unavailableBackends`（设置 → AI 的档位也传了，`settings/ctx.ts` 存它）；`canProbe: false` 的后端用列表带的缓存、不发探测、不显示“重新检测”（`ctx.ts` 的 `loadProbes`、`AiBackend.vue`）。
- Agent 页按档案和技能的 `canEdit` / `canDelete` 显示保存、启用、停用、移动、文件和删除按钮；插件带来的档案不再出删除按钮。
- 向量状态行加“已有 N 个向量”，悬停看原件分块和记忆各多少（`embeddingStatusLine`）。重排“试一下”在改用环境变量时发出的草稿不带 `keyRef`，补了测试。进度视图的“只读 / 可写”此前已按 `access` 写好，服务端现在给了值。
- 文档截图：`settings-search-providers` 里示例云的地址显示成固定的 `https://api.example.com/v1`（`scripts/doc-screens.ts` 改写设置响应），重拍了它和 `work-progress`。

## 2026-11-22：试验和修改阶段的执行者摘要

- 流程列表的 trials、fixes 阶段保留 object 类型，在 `carrier.run` 返回执行类型、档案 id/name 和技能，最终缺省档案为 assistant。fixes 自身配置优先，未指定的字段分别继承首个 trials 阶段，与执行端共用同一规则。从 `src/flows/definitions.ts` 的 `studyStageCarrier`、`summarizeStage` 和 `src/studies/fixes.ts` 的 `fixModelStage` 读起。
- HTTP 列表用例覆盖两个对象阶段的指定档案、默认助手、显式助手和各字段继承、覆盖；改后重跑用例核对排队运行收到的档案与技能。字段文档在 `docs/v2/flows.md` 的“流程定义的结构化摘要”，用例在 `test/flows-http.test.ts`、`test/study-fix.test.ts`。

## 2026-11-22：停用运行器后的流程草稿保留

- 草稿列表按结构解析，不因信号或运行器停用而丢弃待启用定义，继续按流程查看空间裁剪。保存和确认卡启用仍校验新增、改参引用。从 `src/flows/http.ts` 的草稿读取、`src/flows/definitions.ts` 的保存边界读起。
- 假插件 HTTP 回归覆盖初次启用、停用后 PUT 改名、GET 草稿、本人回答及重读新定义；也核对改参仍被拒绝。用例在 `test/flow-plugin.test.ts`。

## 2026-11-22：第二轮网页对接的服务端字段

- 知识查看者得到只读后端摘要；普通探测读缓存，缺缓存返回空列表，刷新仅本人。缓存批量按主键读取。从 `src/server/http.ts`、`src/agents/probe.ts`、`src/auth/routes.ts` 读起。

- 进度投影 attempts 带 read/write 访问档位。从 `src/agents/progress.ts`、`progress-runs.ts` 读起。

- 重排检测按请求 api 整份替换，null 清字段，支持试用环境变量密钥。从 `src/server/http.ts` 的 rerank/test 读起。

- embeddings.embedded 提供分块、有效记忆已有数量及合计，复用部分索引。从 `src/search/embedding-index.ts`、`embeddings.ts` 读起。

- 豆包 CLI 从帮助探测目录参数，放到业务参数之前，无支持时用进程 cwd。从 `src/agents/doubao-cli.ts` 读起。

- 档案技能列表带当前人的 canEdit/canDelete，无管理能力的删除仍拒绝。从 `src/server/http.ts`、`src/auth/routes.ts` 读起。

- 本人沙箱状态增加 home 和各处完全访问授权清单，规则使用部分索引。从 `src/agents/own-run.ts`、`src/core/db.ts` 的末尾迁移读起。

- 设置列出所有配置引用的停用插件后端及原因。从 `src/core/config.ts` 的 allProfiles 和 `src/server/http.ts` 读起。

- gateReview.ask 显示处理状态和答复时间，查看者可读、本人答复，越过后保留、重开清除。从 `src/flows/engine.ts`、`plugin-gates.ts` 读起。

- 事项阶段直接带 carrier.runner、waitingSignal.id/name。从 `src/flows/engine.ts`、`signals.ts` 读起。

- 流程列表新增 stageSummaries，含承担者、完成信号与参数、时限。从 `src/flows/definitions.ts` 的 summarizeStage 读起。

- 流程保存保留同阶段未变的停用引用；校验和列表单独提示不可执行能力，校验结果也带停用检查 unavailableChecks。从 `src/flows/definitions.ts`、`http.ts`、`plugin-gates.ts` 读起。

## 网页接上向量和重排的来源、设备的接活开关和进度里的设备（2026-11-22）

设置 → 检索与记忆：“向量检索”卡（`web/src/components/EmbeddingSettings.vue`）选来源（不用 / 本机模型 / 云端接口 / 插件的向量提供者，按插件分组），云端填地址、模型名、密钥（设置 → AI 的服务商或环境变量名）、维度、每批条数和超时；来源和参数是一份草稿，“试一下”调 `POST /api/search/embeddings/test`，“保存”遇到 409 `confirmation: "embedding-model"` 时用 `confirmDialog` 写出清掉和重算的条数，确认后带 `?confirmEmbedding=<token>` 再存，取消就恢复。为此 `web/src/api.ts` 的 `ApiError` 多了 `data`（响应体）。“重排”卡（`RerankSettings.vue`）同样选本机 / 云端 / 插件，`rerank.api` 整份替换，“试一下”调 `POST /api/search/rerank/test`；本机模型的条数、长度和线程照旧即改即存。原来“插件参与检索”卡里选重排和插件门槛的两行挪走：选重排在“重排”卡，非本机重排的门槛在“对话前带上相关记忆”卡；那张卡改名“插件参与召回”，只管召回。草稿和形状的纯函数在 `web/src/lib/search-settings.ts`。

设置 → 设备：新卡“接别的设备派来的活”（`AcceptWorkSettings.vue`，`lib/accept-work.ts`），三档 `node.acceptWork` 只提交 `{node:{acceptWork}}`；按 `GET /api/peers` 的 paired[] 一行一台单独设，提交完整的 `acceptWorkFrom`。进度视图和任务板按尝试的 `mode` 写“借 ×× 的后端 / 在 ×× 跑”，历次尝试写期限、迟到标记和对方运行页链接（`lib/progress.ts` 的 `placeLabel`、`lateText`、`remoteHref`）；运行页的 `peer-work` 种类写“别的设备派来的任务”。演示数据（`scripts/doc-screens.ts`）加了一个本地假的 `/embeddings`、`/rerank` 接口和指向它的“示例云”服务商、一个插件向量提供者、配对设备 lab-mac，任务板的两块改成借它的后端和在它上面跑（其中一次迟到）。截图 `settings-search-providers`、`settings-devices-work`，重拍了 `search-providers`、`run-board`、`progress-board`。

云端向量和重排的接口地址（`embeddings.url`、`rerank.api.url`）接受任何 `http` / `https` 地址，本机和内网的模型服务可以直接填（合并前只接受域名）；`src/core/config.ts` 的 `searchApiFields`。被检查拦下的阶段卡第一句不再重复标题（`web/src/lib/flow.ts` 的 `nextWords`）。

## 关注回查沿用问题材料的来源（2026-11-22）

从 `src/channels/listen-problems.ts` 的 `trackProblem` 和 `problemsDue` 读起。问题记录保存会话材料的来源，后续更新合并已有来源。定时回查和当前处理带入问题正文时，都沿用这份记录。个人关注全程只用个人材料时，回查轮和下一轮都可使用个人向量插件。网页中本人的文字按会话空间登记。会议操作备注只在显式读取时计入材料，来源不明的会议纪要仍走全文和符号检索。

## 个人关注的摘要带有助手回复时可用向量检索（2026-11-22）

关注摘要保留用户消息和助手回复。计算摘要来源时，合并前次摘要的来源和本次用户消息的来源。个人空间的消息即使已有助手回复，冷启动搜索也能调用个人空间插件；摘要含项目消息或来源不明时，仍可用全文和符号搜索。从 `src/agents/jobs.ts` 的 `thread-summary` 和 `test/plugin-embeddings.test.ts` 的冷启动用例读起。

## 关注助手按实际收到的摘要、补充和群历史校验向量权限（2026-11-22）

关注会话生成摘要时保存原摘要与新材料的来源。冷启动按实际带入的摘要登记来源；旧摘要来源不明时仍可用全文和符号搜索。实时补充在正文交给助手前登记，即使等待批次被取消，已交付的内容也受保护。新建关注合成群历史时保留归档消息 ID 和空间，仅含个人空间材料时可正常调用个人向量插件。从 `src/core/message-origins.ts`、`src/agents/sessions.ts` 和 `src/channels/lark-watch.ts` 读起。

## 关注助手主动搜索时核对查询材料的来源（2026-11-22）

从 `src/core/message-origins.ts` 的 `watchSearchSourceSpaces` 读起。助手用群里的原话调用 `search` 时，宿主核对会话历史、本轮消息和中途补入的消息。历史消息的来源按批在检索子进程中读取。项目群消息只交给已获项目空间授权的向量插件。来源不明时跳过受限向量插件，仍返回目标空间的全文和符号命中。

## 快速检查在每页飞书消息到达时记录来源（2026-11-22）

从 `src/rules/fast.ts` 的 `pollFastRules` 读起。分页期间群改绑时，已读到的消息沿用首次记录的来源空间。后续页重复返回同一消息，也只按原有顺序转交一次。

## 规则等待期间保留飞书消息来源（2026-11-22）

规则收到飞书消息时记录已归档的原件空间，尚未归档就记当时的采集空间。触发等待、动作延时和恢复执行都沿用事件里的来源。交给关注时再合并后来归档的空间和已有关注消息的来源。旧事件缺少来源且找不到原件时，受限向量插件收不到正文。入口见 `src/rules/engine.ts`、`src/rules/fast.ts`，转交见 `src/rules/actions.ts`。

## 云端向量按已收到的 HTTP 状态决定重试（2026-11-22）

云端接口返回错误响应头后，即使读取正文提前超时，最近错误仍显示 HTTP 状态码。向量请求遇到普通 4xx 只发一次，429 和 5xx 继续在剩余时限内退避重试。实现从 `src/search/api.ts` 读起。

## 飞书关注按消息来源校验向量插件权限（2026-11-22）

普通关注和规则转入都会记录正文入队时的来源空间。已有归档的消息取原件空间，未归档的消息取当时的采集空间。跟进时一并检查后来归档的原件。群改绑后，个人空间插件仍收不到已入队的项目正文。实现从 `src/core/capture-space.ts` 和 `src/channels/lark-watch.ts` 读起。

## 向量设置可切回默认值（2026-11-22）

保存和检测向量设置时，`keyRef`、`url` 和 `dimensions` 可以传 `null` 清除。两处共用 `src/auth/settings-sections.ts` 的字段合并，保存时会预览实际模型或地址变化影响的索引。

## 网页接上流程里的插件和插件后端的来源（2026-11-22）

流程定义页每一段多了“改谁来做、怎么算完”（`web/src/components/FlowStageHooks.vue`）：内置和插件的信号按来源分组，“谁来做”里有插件执行；选中后写回 YAML（`web/src/lib/flow-hooks.ts` 的 `writeCarrier` / `writeDone`，用 `yaml` 的文档接口保留注释），参数的 JSON Schema 扁平时画成表单，否则是 JSON 框。`PUT /api/flows/:id` 返回 `askId` 时页面写“已提交，等你启用才生效”，就地启用。插件停用后 `/api/flows/validate` 读不了这份定义，页面按 YAML 自己列出各段并标停用。同页“完成前的检查”是 `FlowChecks.vue`，整表 `PUT /api/flows/:id/checks`。

事项的流程里插件的部分集中在 `FlowStagePlugin.vue`（用在 `FlowWaiting`、`ItemFlowPage`、`ItemFlow`）：插件信号的在等 / 问不到 / 没人能判断（给手动完成），运行器的执行者和运行链接，`pluginEvidence` 按 `src:` / `#/` / http(s) 打开，`gateReview` 的原因和“仍然通过 / 等处理”（回答 `askId` 那张卡，先读 `GET /api/asks/:id` 看还在不在等）。`lib/flow.ts` 的 `stageActions` 对被检查拦下的阶段给“处理好了，重新检查”和“重开”。

`AiDefaults.vue` 的后端下拉标“来自插件 ××”，已选而不可用的仍是选中项，写原因并链到插件页；只有保存的 `<插件>:<id>` 没出现在任何列表里时也这样显示。设置 → 后端与模型的后端行（`AiBackend.vue`）和未安装列表标来源；插件页在信任确认和卡片上列出后端和启动命令。进度视图的落点：`CodeTasks.vue` 读 `?task=T<n>`，`ItemFlowPage.vue` 读 `?stage=`，`ItemStudy.vue` 读 `?direction=` / `?trial=`，都用 `web/src/lib/landing.ts` 滚到并标出；`/items/:id/flow` 改道时保留查询参数（`web/src/main.ts`）。测试 `test/web-flow-hooks.test.ts`；演示数据装了 `examples/plugins/stagekit`，截图 `flow-plugin-checks`、`flow-stage-blocked`。

## 网页接上本人沙箱和补齐的接口字段（2026-11-22）

设置 → 安全 多了“运行的沙箱”和“完全访问”两张卡，从 `web/src/components/SandboxSettings.vue` 读起（纯函数在 `web/src/lib/sandbox.ts`，目录清单是 `SandboxPaths.vue`）。卡片读写 `GET` / `PUT /api/security/sandbox`，每次改动整份保存，“全部开”先确认并带 `confirmAll`；目录被拒时服务端的原因写在那一行下面。主目录从返回的路径里推出来（接口不给），用来把路径写成 `~/…`。

网页改用服务端补齐的字段，去掉自己拼的逻辑：本人的称呼读 `/api/me` 的 `ownerName`（`web/src/lib/owner-name.ts`）；成员页每人的“通知出口”复用 `NotifyOutlets.vue`（`user` 属性，`?user=` / `userId`），成员能不能勾审批看 `grantedAskKinds`；进度视图取 `?summary=true` 的合计、`local`、`href` 和证据的 `target`（`web/src/lib/progress.ts`）；出网和云端工具用接口给的运行标题和 `availableTools`（`web/src/lib/run-titles.ts` 只剩 `runName`）；HTTP 规则“在哪里生效”读顶层 `enforcedBy`（`web/src/lib/rule-places.ts`）。

`web/src/styles.css` 进度视图的窄屏 `@media` 少一个右括号，后面的“settings 2”一段原来只在窄屏生效，已补上。

沙箱的路径规则按 POSIX 写。Windows 上原来读、存这张卡都报错：现在 `sandboxStatus`（`src/agents/own-run.ts`）在路径不是 POSIX 的机器上不算示例运行的可写清单（返回空），模式和完全访问照常保存，带目录的保存返回 400 并说明这台配不了目录。不可用的原因改成“沙箱只支持 Linux”（原来写的是“多账号”）。

## 带运行器的流程由本人提交和确认（2026-11-22）

从 `docs/v2/plugins.md` 的「插件承担一个阶段」读提交和启用方式。本人通过流程保存接口或自己的助手提交新版本，确认卡列出阶段、插件和用途。两个入口的成员权限及本人确认前后的状态由 `test/flow-plugin.test.ts` 覆盖。

## 完成检查按合并后的原件和 URI 定位结果核对权限（2026-11-22）

从 `src/flows/plugin-gates.ts` 读检查收到的证据。合并旧链接按保留件的空间和读取权限过滤；URI 链接与原件读取接口共用 `src/sources/store.ts` 的解析。检查收到的可读链接保留原样，事项上的证据完整保留。

## 插件完成检查的原件读取链接（2026-11-22）

从 `src/flows/plugin-gates.ts` 读检查回调的证据裁剪。同一原件的 `src:`、网页链接和 HTTP 原件读取链接均按事项空间和原件读取权限过滤。提交者留下的原始证据在事项上保留。回归见 `test/flow-plugin.test.ts`。

## 角色和档案表单中的已停用后端（2026-11-22）

从 `web/src/components/AiDefaults.vue` 读保存值的显示。角色和档案表单都从 `/api/profile-options` 读取已停用后端的来源与原因，候选列表只列可用条目。冷启动回归见 `test/web-review-entry.test.ts`。

## 插件完成信号的批次时限（2026-11-22）

从 `src/flows/plugin-signals.ts` 读巡检的并发数、每次检查的时限和批次游标。余下时间不足一次完整检查时，游标留给下批，阶段不会因为排在批末而增加失败次数。双模式回归见 `test/flow-plugin.test.ts`。

## 主助手代答与复盘显示豆包实际审批档位（2026-11-22）

从 `src/agents/doubao-cli.ts` 的启动入口读起。「使用 AI」按启动参数记录风险审批或完全访问。会话回退到豆包，以及复盘的两次评判，都在各自运行记录里看到实际档位。

## 沙箱设置校验后端状态路径类型（2026-11-22）

从 `src/agents/own-run.ts` 的挂载计划读起。后端所需目录已被普通文件占用时，保存设置和准备运行都会指出路径。首次启动仍会创建缺失目录。

## 交办发起人的评审档位判断（2026-11-22）

从 `src/agents/code.ts` 的 `runCodeTask` 读起。编码前预估档位和首轮检查后细化计划时，短问答都以发起人身份选择账号与审批模式。

## 成员多仓评审的工作树权限（2026-11-22）

从 `src/agents/review-chain.ts` 的评审入口读起。评审按交办分配的仓库只读挂载，覆盖工作区池和直接检出两种方式。与编码同时进行的验证在自己的快照写测试产物。

## 接活设备读取飞书群历史长页（2026-11-22）

从 `src/channels/lark-cli-tools.ts` 读起。飞书返回的消息超过 60,000 字符时，分页信息单独放在截断正文前，助手可以取出令牌继续同群同查询。

## 跨设备飞书读取保留文档选区、群分页和消息副本（2026-11-22）

从 `src/agents/board-lark-read.ts` 读起。接活设备按文档 ID 核对按读者保存的 wiki 原件，读取时保留选区。群历史的续页令牌绑定本次运行和原查询，续页时重新核验群归属。消息按各份原件的当前空间核验，其他空间补采同一条消息后，任务仍可读取本空间已有的消息和附件。

## 接活设备按任务空间核验飞书读取（2026-11-22）

远端任务读取飞书现文前，先在接活设备核对文档或群消息原件的当前空间。按 ID 批量取消息时逐条核验，读取整群时也检查分月归档。未归档的目标、账号范围搜索和无法限定目标的参数均在调用飞书前拒绝。从 `src/agents/board-lark-read.ts` 读起，两档接活的用例在 `test/work-board-peer.test.ts`。

## 成员查看内置角色（2026-11-22）

从 `src/server/http.ts` 的角色接口读起。有档案管理权限的成员可看内置角色的名称、用途和默认 AI。在 Agent 页打开角色进入只读摘要；只有本人的详情包含正文、专属记忆和复盘建议。自定义操作仅向本人回传原文。

## 跨设备任务按当前空间读取附件和技能（2026-11-22）

飞书消息留在任务空间时，单独归档的附件按原件当前空间核对，见 `src/agents/tools.ts` 的 `messageFileText`。技能目录、分组用途页、正文和附带文件共用 `src/agents/specs.ts` 的可见范围：执行档案指定的技能、可读空间挂载的技能和公共技能。

## 跨设备任务只读取已入库的飞书消息附件（2026-11-22）

从 `src/agents/tools.ts` 的 `messageFileText` 读起。任务板借后端和在对端运行时，读取已有附件原件沿用原件访问权限。附件尚未入库时，工具在下载或导入前返回原因，消息的附件记录保持原样。

## 成员管理 Agent 档案（2026-11-22）

从 `src/server/http.ts` 的档案接口读起。成员查看档案详情或保存说明、状态时取得与列表一致的摘要。档案原文的读写权限在 `src/auth/settings-sections.ts` 中与 MCP 配置一起限定给本人，技能原文沿用原权限。

`web/src/views/Agents.vue` 用摘要填写用途和状态，保存后重新读取档案。只有完整详情才加载原文和专属学习记录。
