# 编码交办、评审与 Git（code）

交办编码（`delegate_code`）和评审已有分支（`review_branch`）不对外部客户端（`omem mcp`、没有运行令牌的 `omem tool`）开放，在 omem 的问答里说或用 `omem delegate` / `omem review-branch`。

## 交办

- `delegate_code`：编码交办，评审不通过会自动续轮。可传 `execution`（编码用的 AI）和 `review_execution`（功能评审）、`title`（一句话标题，显示在运行列表和进度卡片上）、`review_tier`（本人点名的评审档位，如“完整”）和 `review_checks`（额外加的评审项档案名），不传按改动和档位设置自动选；编码自动续轮保留这次选择。
- 同一个分支上已有没应用的交办时 `delegate_code` 拒绝（本人明确要另开时传 `parallel: true`），对这个分支的评审按 `fix_review` 修改时续在那次交办上。每轮编码前宿主先拉取目标分支在 origin 上的新提交。
- `continue_code_run`：之后的调整（本人明确继续可到第 4 轮及以后，自动上限仍为 3 轮）。
- 飞书进度缺失时先 `read_run` 看 `codeProgress`，经明确要求后 `retry_code_progress(run_id)` 恢复同一链原卡片，不新开编码任务。

## 进行中调整

- `message_code_run(run_id, text)`：把本人的补充交给正在编码的 Agent（它下一次调用 omem 工具时收到，最晚在这一轮检查前接着同一会话交给它；这一轮已写完代码时随下一轮的任务交付）。
- `set_code_review(run_id, review_tier?, review_checks?, split?)` 改之后的评审：档位可以比之前轻，`review_checks` 只做这些评审项，`split: false` 不再拆需求，`rotate_models` 之后每轮各评审项换用评审设置里轮换列表的下一个模型；还没开始评审的这一轮就生效，之后的轮次沿用。
- `stop_code_run(run_id, reason?)`：停下进行中的编码或评审，不再自动续轮，工作区保留。
- `continue_code_run` 和 `fix_review` 也接受 `review_tier` / `review_checks` / `split` / `rotate_models`，`fix_review` 另可传 `review_execution`；两者的 `apply_first: true` 先把现在的改动应用到目标分支（未提交），下一轮在同一个工作区接着改。
- `resplit_change_points`：重新整理已有评审的需求拆分（网页“变更”里的变更点），不重跑整个评审；没提到的保持，评审没有拆分时就新拆一份。

## 应用与 Git

- `apply_code_run` 把改动应用到交办时指定的目标分支（续轮沿用首轮目标）：复用该分支已有工作区，没有则自动建立接收工作区，不切换仓库主目录。返回实际分支和目录；不要要求本人手动切分支，也不要说已提交或已推送。补丁真正冲突时保留编码成果。
- `clean_code_runs`：本人要清理交办留下的东西时用。先不带 `confirm` 列出清单：没应用的交办（丢弃后工作区删掉，复用工作区和仓库主目录重置）、`receivers: true` 时已应用交办的接收工作区（连同没提交的改动）、没有对应交办的遗留工作区，每项写着改了几个文件。本人同意后带 `confirm: true` 和 `run_ids` 再调，只处理这些。进行中的交办不在清单里。
- `code_git_status(run_id, space)` 查看已应用接收工作区的分支、HEAD、暂存 diff、未暂存文件及操作记录。仅本人可用，限定本次可读空间。远端领先 / 落后数是本地缓存，不自动 fetch。
- `code_git_action(run_id, space, action, expected_state, message?, branch?, force?)`：本人要求后操作；`action` 为 `commit`、`commit_push` 或 `push`。先读状态并检查 diff，`expected_state` 传其 `state`，提交需非空 `message`；只提交暂存区，不自动 add。默认推送到 origin 的原目标分支，`branch` 可推到别的分支；`force` 只在本人明确同意时用（带 lease）。状态过期需重读，返回 `ok: false` 时不能说成功；推送失败保留本地 commit，刷新后仅重试 push。不要让编码 Agent 绕过工具在接收目录提交或推送。

## 工作区与依赖

- 交办默认每次新建 worktree，依赖要重装。`set_code_workspaces(space, pool?, workspaces?, setup_command?, in_place?)` 让它复用：`pool` 是 omem 自建的长期工作区（保留 node_modules 等被忽略的文件），`workspaces` 借本人已有、装好依赖的 worktree（干净时才借），`setup_command` 只在新工作区或锁文件变了时运行，`in_place` 允许直接在仓库主目录里改（主目录干净时优先，在当前分支上改，应用时改动留在原处，丢弃会重置主目录）。`workspaces` 只认 `git worktree add` 出来的目录；本人另一份克隆（remote 相同、自己的 .git）不能借，要在那里编码就用 `connect_repository(那个目录, space, relink: true)` 把空间换过去（本人确认后；有没应用的交办先应用或经本人同意丢弃）。
- 本人给一个本地仓库路径要交办：先 `connect_repository`。同一仓库（remote 相同）已经有空间时不会新建，返回那个空间；要它改用这个目录，本人同意后带 `space` 和 `relink: true`（那个空间还有没应用的交办时不能改）。

## 同步

- `delegate_code` 可传 `sync: {pull?, onto?, mode?: "merge"|"rebase", fetch?}`（编码前先拉取目标分支的远端提交、再合并或变基到 `onto`），`sync_only: true` 只做同步不编码。
- `continue_code_run` 可传 `sync`（这一轮编码前同步，工作区里未提交的改动先收起再放回）或 `onto_latest_target: true`（目标分支有新提交、应用失败时，把改动移到它的最新提交上）。
- 冲突先交给编码 Agent（它可用 `ask_owner` 问业务取舍），解决不了的停下来，给本人一张“已解决，继续 / 放弃这次同步”的卡片。同步产生的提交在应用时快进到目标分支，之后的编码改动照常作为未提交修改应用。

## 评审角色专用

`submit_review`、`submit_change_points`（评审项）和 `rule_review`（评审负责人）只在对应的评审运行里可用。
