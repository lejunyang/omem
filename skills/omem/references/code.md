# 编码交办、评审与 Git（code）

交办编码（`delegate_code`）和评审已有分支（`review_branch`）不对外部客户端（`omem mcp`、没有运行令牌的 `omem tool`）开放，在 omem 的问答里说或用 `omem delegate` / `omem review-branch`。例外是另一台设备上的 Agent（`omem tool --peer` / `omem mcp --peer`）：它可以 `review_branch`，评审由它自己做，见下面“设备的外部 Agent 评审分支”；也可以 `delegate_code`，代码由它自己写，见“设备的外部 Agent 编码”。

## 交办

- `delegate_code`：编码交办。新交办按修改项推进（编码 Agent 拆成修改项、逐项提交；评审问题变成修改项自动改，提出它的评审项验证；只有业务和功能上的取舍问本人）。本人给了预算（“最多推进 3 轮”）传 `max_rounds`，没说就不传，由编码 Agent 估。可传 `execution`（编码用的 AI）和 `review_execution`（功能评审）、`title`（一句话标题，显示在运行列表和进度卡片上）、`review_tier`（本人点名的评审档位，如“完整”）和 `review_checks`（额外加的评审项档案名），不传按改动和档位设置自动选；编码自动续轮保留这次选择。
- 编码前检查：新交办的第一轮编码前，`business-analyst` 只读地查改动会碰到什么、这些文件以前出过什么问题、改完要回归什么，结果给编码 Agent 拆修改项、给评审核对，也显示在交办视图“概览”里。改文案、样式这类一眼看得清影响的小改动传 `pre_check: false` 跳过；设置里也能整体关掉（`agents.autoAdvance.preCheck`）。
- `code_history(space, paths)`：一些文件的历史——对上的需求点和状态、改过它们的交办、在上面提过的评审问题、最近的提交（一次最多 20 个文件，业务空间下几个仓库时写 `仓库id/路径`）。改之前看以前出过什么问题，评审时看有没有重犯。
- 同一个分支上已有没应用的交办时 `delegate_code` 拒绝（本人明确要另开时传 `parallel: true`），对这个分支的评审按 `fix_review` 修改时续在那次交办上。新分支从 origin 声明的默认分支最新提交建立；正常续轮前宿主同步目标分支和默认分支，显式 sync 则按指定目标执行。读取或更新默认分支失败时停止，不按旧代码继续。
- `continue_code_run`：之后的调整（本人明确继续可到第 4 轮及以后，自动上限仍为 3 轮）。
- 飞书进度缺失时先 `read_run` 看 `codeProgress`，经明确要求后 `retry_code_progress(run_id)` 恢复同一链原卡片，不新开编码任务。

## 进行中调整

- 按修改项推进的交办里，`message_code_run` 和 `continue_code_run` 默认把话作为交代交给编码 Agent（编码中马上收到，否则随下一轮；`continue_code_run` 有待做的项时马上开下一轮）。只有本人提了一件新的、能单独验证的修改时传 `new_item: true`，记成修改项（`continue_code_run` 另给一份新预算）。“接着推进”“环境好了”“注意某事”不要记成修改项：它没法用一次提交做完，只会一轮轮算作没改好。等本人决定的项用 `settle_code_task` 转达；原需求或此前授权已确定做法的，retry 时附 `existing_authorization` 写明原话或引用及适用依据，后台接续时也能恢复。修改项、等本人决定的问题、回退在运行页处理。
- `message_code_run(run_id, text)`：把本人的补充交给正在编码的 Agent（它下一次调用 omem 工具时收到，最晚在这一轮检查前接着同一会话交给它；这一轮已写完代码时随下一轮的任务交付）。
- `set_code_review(run_id, review_tier?, review_checks?, split?)` 改之后的评审：档位可以比之前轻，`review_checks` 只做这些评审项，`split: false` 不再拆需求，`rotate_models` 之后每轮各评审项换用评审设置里轮换列表的下一个模型；还没开始评审的这一轮就生效，之后的轮次沿用。
- `revise_finding(run_id, finding_id, detail, title?, suggestion?)`：本人看不懂某条评审问题时，读相关代码（迁移也读源实现）后重写它的描述：标题说清什么情况下哪里出了什么错；正文用 Markdown 分“现在的实现 / 源实现 / 触发条件 / 问题”（小节标题单独一行、前面空一行），每点后面直接带 `[说明](路径:起-止)` 或 `[说明](src:<原件id>#L起-L止)`。评审原来的写法保留，严重级别和本人的决定不变。提交评审（`submit_review`）时也按这个写法写 `detail`。
- `stop_code_run(run_id, reason?)`：停下进行中的编码或评审，不再自动续轮，工作区保留。
- `continue_code_run` 和 `fix_review` 也接受 `review_tier` / `review_checks` / `split` / `rotate_models`，`fix_review` 另可传 `review_execution`；两者的 `apply_first: true` 只对以前的交办有用（先应用再接着改）；工作分支上的交办每轮都已经提交在分支上。
- `resplit_change_points`：重新整理已有评审的需求拆分（网页“变更”里的变更点），不重跑整个评审；没提到的保持，评审没有拆分时就新拆一份。

## 工作分支、确认与 Git

- 交办每个仓库一条工作分支：`delegate_code` 不传分支时从仓库目录当前的提交切出临时分支，编码 Agent 按功能改名；`from_branch` 接着已有分支提交；`branch` 指定新分支名（本人说了才传）。编码 Agent 按功能提交，一轮剩下没提交的由宿主提交；不要让它 push。同一个分支一次只有一个没确认的交办，新交办默认各开一条分支，可以并行。
- `code_branch(run_id, action, …)`：本人要求时用，进行中的交办等这一轮结束。`status` 看每个仓库的分支、切出点、提交、推送状态和检出位置；`rename(name)` 改名；`checkout_main` 把仓库目录切到这条分支（目录要干净），之后每轮的提交自动快进到那里，本人可以直接在仓库目录运行验证；`squash(message)` 压缩成一个提交；`sync(onto, mode)` 排一轮把另一个分支合并（或变基）进来，冲突交给编码 Agent。
- `apply_code_run(run_id, squash_message?, force?, keep_going?)`：本人明确说确认 / 推送 / 合入时用。本人要先推上去验证、之后还要接着改时传 `keep_going`：只把工作分支推到 origin（有一轮在编码时推最近一次阶段评审看过的检查点），交办和工作区留着，之后的提交接着在同一分支，试过以后的问题用 `continue_code_run`；不能和 `squash_message` 一起用。交办已经确认、又要接着改时，`delegate_code` 传同一条 `from_branch`：之前交办没做完的项接成待做，记成以后再做的照样列着（返回里会说接上了哪些），任务里只写这次要做的。工作分支上的交办：可先压缩，推到 origin 的同名分支并设为上游，归还工作区，分支保留；远端有本地没有的提交时报错，本人同意覆盖才传 `force`（带 lease）。没有 origin 时只在本地确认。返回推送了哪些分支，失败就照实说。
- 以前的交办（工作区里是未提交的改动）：`apply_code_run` 把改动应用到目标分支的工作区（未提交），之后 `code_git_status(run_id, space)` 看接收工作区的状态和暂存 diff，`code_git_action(run_id, space, action, expected_state, …)` 提交或推送（`expected_state` 传刚读到的 `state`；只提交暂存区；`force` 只在本人同意时用）。
- `clean_code_runs`：本人要清理交办留下的东西时用。先不带 `confirm` 列出清单：没确认的交办（丢弃后工作区归还，这次新建、没推送、没在别处检出的分支一起删）、`receivers: true` 时以前交办的接收工作区、没有对应交办的遗留工作区，每项写着改了几个文件。本人同意后带 `confirm: true` 和 `run_ids` 再调，只处理这些。进行中的交办不在清单里。

## 工作区与依赖

- 工作区由 omem 自动管：按需建（每个仓库最多 4 个），闲着的收回给新交办，保留 node_modules 等被忽略的文件；事项结束时它的交办占着的工作区自动归还。`set_code_workspaces(space, setup_command?)` 只设准备命令（不设时按锁文件自动选 pnpm / yarn / npm / bun，`none` 不准备），并列出各工作区的状态。
- 本人给一个本地仓库路径要交办：先 `connect_repository`。同一仓库（remote 相同）已经有空间时不会新建，返回那个空间；要它改用这个目录，本人同意后带 `space` 和 `relink: true`（那个空间还有没确认的交办时不能改）。业务空间下只有一个仓库时，`repo_spaces` 写业务空间就是它；有几个时写仓库的 id。交办记在仓库所属的业务空间。

## 同步

- `delegate_code` 可传 `sync: {pull?, onto?, mode?: "merge"|"rebase", fetch?}`（编码前先拉取目标分支的远端提交、再合并或变基到 `onto`），`sync_only: true` 只做同步不编码。
- `continue_code_run` 可传 `sync`（这一轮编码前同步，工作区里未提交的改动先收起再放回）或 `onto_latest_target: true`（目标分支有新提交、应用失败时，把改动移到它的最新提交上）；默认合并，也可传 `onto_latest_target_mode: "rebase"` 逐个重放提交。目标已包含在工作区时直接跳过，保留暂存、未暂存和未跟踪文件。
- 冲突先交给编码 Agent（它可用 `ask_user` 问业务取舍），解决不了的停下来，给本人一张“已解决，继续 / 放弃这次同步”的卡片。同步产生的提交在应用时快进到目标分支，之后的编码改动照常作为未提交修改应用。

## 评审角色专用

`submit_review`、`submit_change_points`（评审项）和 `rule_review`（评审负责人）只在对应的评审运行里可用。按修改项推进的交办里还有：编码 Agent 的 `plan_tasks`（拆分、估轮数）、`finish_task`（说明一项做完了；没提交的改动由宿主作为这一项提交）、`report_task`（owner 交给本人，必须带 question 和两三个 options；disputed 有异议；blocked 被挡住或缺外部字段，交给发起交办的助手）、`ask_reviewer`（问提出这一项的评审项，它在自己这次交办的会话里回答）、`dispatch_tasks`（编码负责人把几组互不相干的项分给编码助手，同时做，这一轮结束时合并）；评审项的 `verify_tasks`（逐项验证）；评审负责人的 `plan_review`（这次评审谁看、看什么，`second_look` 请另一个模型复看）、`rule_dispute`（评审项坚持、编码 Agent 仍有异议时裁决），`rule_review` 的裁决可带 `owner`（交给本人决定的问题和选项），和已有修改项重复的用 `merge` + `task`（如 T5）合到那一项；问题成立但现在的用法碰不到（假想的并发、协议被乱用、极少见的时序、需求没要求的加固）用 `defer` 记成以后再做（要写 note），不挡交付；已完成的项没改好或改出新问题时 accept / defer 带 `follows`（如 T5），同一处修到第三层以后宿主交给助手判断。

修改项停下时只等一方：「等助手处理」（编码被挡住、缺外部字段、验证 3 次没过、连续 3 轮没轮到、评审负责人没裁决）不发卡片，宿主马上在交办汇报的会话里叫醒发起交办的助手，别的项照常推进；「等你决定」才发卡片给本人。助手用 `settle_code_task` 处理：retry 写清这次怎么做（同一项最多 2 次，在自动推进的轮数内才开下一轮），skip 写在等什么，later 记成以后再做（问题成立但和这次要的关系不大；评审提的待做项也可以直接 later，需求本身的项只有本人能放下），owner 必须带 `question` 和两三个 `options`；没什么要告诉本人的就调用 `stay_quiet`。等本人决定的项，当前轮转达本人的答案，或在 retry 时附 `existing_authorization` 写明原需求或已有授权及其适用依据（不能作新的业务决定，不能用它 skip）。已经发给本人的卡片随之关闭，不用再让本人点。

## 截图、录屏和报告（运行产物）

- 交办的编码 Agent、编码助手、宿主跑的检查命令、外部 Agent 用 `code_workspace` 运行的命令，环境变量 `OMEM_ARTIFACTS` 指向这次运行的收件目录。放进去的文件在 `finish_task`（归到正在做的那一项）、这一轮结束、命令跑完时被收走：顶层 `T<编号>/` 子目录归到那一项，其他子目录是分组（`改前/`、`改后/`），带 `index.html` 的目录作为一份报告整个收；隐藏文件和符号链接不收。
- `attach_artifact(path, caption?, task?, req?, name?)`：按路径交工作区里的文件或目录（只能是这次交办的工作区和自己的收件目录），`caption` 写哪个页面、什么状态、改前改后，`req` 是需求点或测试点 id。编码 Agent、编码助手和评审项可用（评审项没有收件目录，只能按路径交）。
- 单个文件最多 200 MB，一个交办合计 4 GB。本人在交办视图“产物”里看；阶段评审和逐项验证的材料列出这些文件在这台机器上的路径，能读图片的可以直接打开。

## 设备的外部 Agent 评审分支

经 `--peer` 调用时，`review_branch` 的评审项交给调用方自己（用调用方的模型），那台机器不问任何模型：

1. `review_branch`（不能带 `review_execution`）：那台机器检出分支、取改动、建索引、定评审计划（不做预判和负责人汇总，不等本人确认计划），返回运行 id。
2. `review_task(run_id)`：取需求、检查结果、改动统计、各评审项的角色说明和要求；还在准备时会说明，过一会再取。完整 diff 用 `part=diff`，按返回的 `offset` 分页。工作区不在调用方机器上：改过的文件用 `read_source` / `search` / `find_symbol` 读，space 填说明里列的索引空间。
3. `submit_change_points(run_id, …)`：需求拆分（可选，网页“变更”视图用它）。要交就在最后一个评审项之前交。
4. 每个评审项 `submit_review(run_id, check, …)`。最后一项交上去后，那台机器按各项的阻断级别汇总结论、通知本人；之后不再接收提交。只有发起评审的那台设备能取材料和提交。

## 设备的外部 Agent 编码

经 `--peer` 调用时，`delegate_code` 的编码交给调用方自己，那台机器只建工作分支和工作区、装依赖，不问任何模型写代码：

1. `delegate_code`（不能带 `execution`、`sync`；可带 `branch`、`from_branch`、`item_id`）：返回运行 id，第一轮准备好后以 `awaiting-peer-code` 结束。
2. `code_workspace(run_id, action=brief)`：任务、事项材料（含需求点）、工作分支、能运行的命令、各轮状态；还在准备时会说明。
3. 看和改：`list`、`read`（`from` 分页，每页 400 行）、`grep`（正则，`path` 限定目录）、`write`（整个文件）、`edit`（`old` 要唯一，或 `replace_all`）、`delete`。路径是仓库里的相对路径，几个仓库时写成 `仓库空间id/路径`；`.git` 和工作区外不能动。
4. 运行：`run` 只能运行本人给仓库设的命令（仓库设置里的检查命令 `check`、准备命令 `setup`、“设备的外部 Agent 可以运行的命令”里的 `名字: 命令`），`args` 追加不带空格和 shell 符号的参数（测试文件、选项）。最多等 `wait` 秒（≤100），没跑完用 `output` 取；同一时间只跑一条。
5. `git`：`status`、`diff`、`log`、`commit`（`message`，按功能分几次提交，不 push）；`merge`（`ref`，先 fetch，要求工作区干净）把另一条分支合并进来，冲突标记留在文件里，改好后 `commit` 完成合并，`merge-abort` 放弃。`import`（`from_run`）把另一次没应用的交办保存的改动导入工作区（先 `merge` 它基于的提交），核对后 `commit`；用于接手旧交办的工作。
6. 截图和报告：`run` 的命令写到 `$OMEM_ARTIFACTS` 的文件跑完就收下（输出里会说）；工作区里已有的文件用 `attach`（`path` + `caption`）交。本人在交办视图“产物”里看。
7. `finish(summary, review)`：排下一轮，提交剩下的改动、运行检查命令、取 diff，再交给评审：`review=peer`（默认）按“设备的外部 Agent 评审分支”的 2–4 步自己评审（`run_id` 用 finish 返回的那一轮），`here` 交给那台机器的评审 Agent。评审要求修改就在同一个工作区接着改，再 `finish`。轮次排队或进行时不能改文件。应用（推送）由本人在网页上确认。
