# 编码交办、评审与 Git（code）

交办编码（`delegate_code`）和评审已有分支（`review_branch`）不对外部客户端（`omem mcp`、没有运行令牌的 `omem tool`）开放，在 omem 的问答里说或用 `omem delegate` / `omem review-branch`。例外是另一台设备上的 Agent（`omem tool --peer` / `omem mcp --peer`）：它可以 `review_branch`，评审由它自己做，见下面“设备的外部 Agent 评审分支”；也可以 `delegate_code`，代码由它自己写，见“设备的外部 Agent 编码”。

## 交办

- `delegate_code`：编码交办，评审不通过会自动续轮。可传 `execution`（编码用的 AI）和 `review_execution`（功能评审）、`title`（一句话标题，显示在运行列表和进度卡片上）、`review_tier`（本人点名的评审档位，如“完整”）和 `review_checks`（额外加的评审项档案名），不传按改动和档位设置自动选；编码自动续轮保留这次选择。
- 同一个分支上已有没应用的交办时 `delegate_code` 拒绝（本人明确要另开时传 `parallel: true`），对这个分支的评审按 `fix_review` 修改时续在那次交办上。每轮编码前宿主先拉取目标分支在 origin 上的新提交。
- `continue_code_run`：之后的调整（本人明确继续可到第 4 轮及以后，自动上限仍为 3 轮）。
- 飞书进度缺失时先 `read_run` 看 `codeProgress`，经明确要求后 `retry_code_progress(run_id)` 恢复同一链原卡片，不新开编码任务。

## 进行中调整

- `message_code_run(run_id, text)`：把本人的补充交给正在编码的 Agent（它下一次调用 omem 工具时收到，最晚在这一轮检查前接着同一会话交给它；这一轮已写完代码时随下一轮的任务交付）。
- `set_code_review(run_id, review_tier?, review_checks?, split?)` 改之后的评审：档位可以比之前轻，`review_checks` 只做这些评审项，`split: false` 不再拆需求，`rotate_models` 之后每轮各评审项换用评审设置里轮换列表的下一个模型；还没开始评审的这一轮就生效，之后的轮次沿用。
- `revise_finding(run_id, finding_id, detail, title?, suggestion?)`：本人看不懂某条评审问题时，读相关代码（迁移也读源实现）后重写它的描述：标题说清什么情况下哪里出了什么错；正文用 Markdown 分“现在的实现 / 源实现 / 触发条件 / 问题”（小节标题单独一行、前面空一行），每点后面直接带 `[说明](路径:起-止)` 或 `[说明](src:<原件id>#L起-L止)`。评审原来的写法保留，严重级别和本人的决定不变。提交评审（`submit_review`）时也按这个写法写 `detail`。
- `stop_code_run(run_id, reason?)`：停下进行中的编码或评审，不再自动续轮，工作区保留。
- `continue_code_run` 和 `fix_review` 也接受 `review_tier` / `review_checks` / `split` / `rotate_models`，`fix_review` 另可传 `review_execution`；两者的 `apply_first: true` 只对以前的交办有用（先应用再接着改）；工作分支上的交办每轮都已经提交在分支上。
- `resplit_change_points`：重新整理已有评审的需求拆分（网页“变更”里的变更点），不重跑整个评审；没提到的保持，评审没有拆分时就新拆一份。

## 工作分支、确认与 Git

- 交办每个仓库一条工作分支：`delegate_code` 不传分支时从仓库目录当前的提交切出临时分支，编码 Agent 按功能改名；`from_branch` 接着已有分支提交；`branch` 指定新分支名（本人说了才传）。编码 Agent 按功能提交，一轮剩下没提交的由宿主提交；不要让它 push。同一个分支一次只有一个没确认的交办，新交办默认各开一条分支，可以并行。
- `code_branch(run_id, action, …)`：本人要求时用，进行中的交办等这一轮结束。`status` 看每个仓库的分支、切出点、提交、推送状态和检出位置；`rename(name)` 改名；`checkout_main` 把仓库目录切到这条分支（目录要干净），之后每轮的提交自动快进到那里，本人可以直接在仓库目录运行验证；`squash(message)` 压缩成一个提交；`sync(onto, mode)` 排一轮把另一个分支合并（或变基）进来，冲突交给编码 Agent。
- `apply_code_run(run_id, squash_message?, force?)`：本人明确说确认 / 推送 / 合入时用。工作分支上的交办：可先压缩，推到 origin 的同名分支并设为上游，归还工作区，分支保留；远端有本地没有的提交时报错，本人同意覆盖才传 `force`（带 lease）。没有 origin 时只在本地确认。返回推送了哪些分支，失败就照实说。
- 以前的交办（工作区里是未提交的改动）：`apply_code_run` 把改动应用到目标分支的工作区（未提交），之后 `code_git_status(run_id, space)` 看接收工作区的状态和暂存 diff，`code_git_action(run_id, space, action, expected_state, …)` 提交或推送（`expected_state` 传刚读到的 `state`；只提交暂存区；`force` 只在本人同意时用）。
- `clean_code_runs`：本人要清理交办留下的东西时用。先不带 `confirm` 列出清单：没确认的交办（丢弃后工作区归还，这次新建、没推送、没在别处检出的分支一起删）、`receivers: true` 时以前交办的接收工作区、没有对应交办的遗留工作区，每项写着改了几个文件。本人同意后带 `confirm: true` 和 `run_ids` 再调，只处理这些。进行中的交办不在清单里。

## 工作区与依赖

- 工作区由 omem 自动管：按需建（每个仓库最多 4 个），闲着的收回给新交办，保留 node_modules 等被忽略的文件；事项结束时它的交办占着的工作区自动归还。`set_code_workspaces(space, setup_command?)` 只设准备命令（不设时按锁文件自动选 pnpm / yarn / npm / bun，`none` 不准备），并列出各工作区的状态。
- 本人给一个本地仓库路径要交办：先 `connect_repository`。同一仓库（remote 相同）已经有空间时不会新建，返回那个空间；要它改用这个目录，本人同意后带 `space` 和 `relink: true`（那个空间还有没确认的交办时不能改）。

## 同步

- `delegate_code` 可传 `sync: {pull?, onto?, mode?: "merge"|"rebase", fetch?}`（编码前先拉取目标分支的远端提交、再合并或变基到 `onto`），`sync_only: true` 只做同步不编码。
- `continue_code_run` 可传 `sync`（这一轮编码前同步，工作区里未提交的改动先收起再放回）或 `onto_latest_target: true`（目标分支有新提交、应用失败时，把改动移到它的最新提交上）。
- 冲突先交给编码 Agent（它可用 `ask_owner` 问业务取舍），解决不了的停下来，给本人一张“已解决，继续 / 放弃这次同步”的卡片。同步产生的提交在应用时快进到目标分支，之后的编码改动照常作为未提交修改应用。

## 评审角色专用

`submit_review`、`submit_change_points`（评审项）和 `rule_review`（评审负责人）只在对应的评审运行里可用。

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
6. `finish(summary, review)`：排下一轮，提交剩下的改动、运行检查命令、取 diff，再交给评审：`review=peer`（默认）按“设备的外部 Agent 评审分支”的 2–4 步自己评审（`run_id` 用 finish 返回的那一轮），`here` 交给那台机器的评审 Agent。评审要求修改就在同一个工作区接着改，再 `finish`。轮次排队或进行时不能改文件。应用（推送）由本人在网页上确认。
