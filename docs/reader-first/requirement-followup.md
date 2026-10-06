# 从需求跟进到编码与独立评审

需求跟进把文档、消息、纪要和代码组织成同一份可持续更新的需求页。编码任务从明确需求和登记项目开始，在独立 Git 副本里实现、运行项目检查，再交给全新会话的评审 Agent。原工作区保留，评审通过后由 `apply` 应用补丁；不会自动推送、发布或发群消息。

目标用法是由主助手调用下面的命令或同一组服务，用户用自然语言交办和纠正。用户已确认：**自动跟进指定需求，交办实现后由 AI 自主编码、检查和独立评审。** 内置主助手已接入需求跟进、关注调整、事实纠正、暂停/恢复与后台编码派发。可直接说“跟进这个项目，只关注上线阻塞”，再说“负责人改为小林”或“请开始实现”；助手先查已有对象和项目，操作成功以后返回真实回执。下文保留 CLI 作为配置和排障入口。关注点、人工反馈、多种编码 CLI 和外部能力的改造见[主助手方案](assistant-orchestration.md)。

## 先把需求范围说清楚

用 `import lark/file/git` 保存原件，个人消息订阅持续带回讨论。建立项目并把来源归属进去：

```bash
omem contexts create '工单完成入口' --description '工单分派和完成状态'
omem contexts assign SOURCE_ID CONTEXT_ID
omem requirements track '工单完成入口' \
  --goal '明确验收、当前差距、负责人和实现入口' --context CONTEXT_ID --watch
omem requirements list --json
omem requirements show REQUIREMENT_KEY
omem requirements board REQUIREMENT_KEY
```

`contexts assign` 设置完整归属列表，要保留多个归属就一起传入。也可用 `track --revision ID...` 选择具体来源，后续跟随这些来源的修订。`--context` 还能跟随成员增减。`watch KEY --off` 暂停维护，`refresh KEY` 请求重新调查；排队不等于生成成功。

研究者自主补读原始材料，规划者给出人可读说明及结构化目标、非目标、验收项和行动项，独立复核重新读原件。每项使用稳定 ID，区分代码存在、测试通过和上线；个人提议不直接覆盖会议决定，建议不写成已经存在的等待关系。旧需求页没有结构化状态时先 refresh。

## 让重要行动进入日常待办

```bash
omem requirements follow REQUIREMENT_KEY ACTION_ID
omem tasks list --json
omem requirements unfollow REQUIREMENT_KEY ACTION_ID
```

follow 表示“我要跟进这件事”，将已明确且有原文依据的行动关联到一个个人待办；原材料里的负责人仍是协作对象，不被冒充成当前用户。后续已复核需求更新会修改同一任务，并沿用既有站内通知和已绑定机器人投递。正文缺少日期时不编造提醒时间。

你在待办里修改过状态后，自动同步会停下并保留修改；board 显示原因，重新 follow 可恢复。含糊或仅建议的行动先补充材料，不能变成已承诺任务；新稿遗漏旧行动时也不自动删除。unfollow 保留已创建的待办。任务应用、版本、通知和关联游标同一事务提交，重启不会重复创建。

## 登记目标项目

先准备本机 JSON，明确项目规则和可以运行的命令。下面只是一个使用 Node 内置测试的项目示例，真实项目应填写自己的依赖、测试、构建和浏览器命令：

```json
{
  "name": "我的服务",
  "repository": "/absolute/path/to/repository",
  "instructions": "遵循项目现有接口和兼容约定。",
  "ruleFiles": ["docs/development.md"],
  "commands": [
    {"name": "test", "command": "node", "args": ["--test"], "purpose": "test", "required": true}
  ]
}
```

```bash
omem develop register my-service ./development-project.json
omem develop projects
omem develop start REQUIREMENT_KEY --project my-service
```

登记命令是信任边界：它们以本机用户权限在独立副本中运行，**副本不是操作系统沙箱**。只登记该项目确实需要的依赖准备和检查，不把群消息里的命令直接登记进来。purpose 支持 setup/test/build/browser/design；setup 由 Agent 按需执行，其余 required 命令由宿主在每轮实现后实际执行。缺少必需检查不能进入 ready。

项目开始时原仓库须干净，基于当前提交复制，不复制未提交、被忽略的凭据和依赖目录。需要依赖时登记 setup 命令。编码 Agent 修改每个文件前必须读取适用的根及子目录 AGENTS.md/CLAUDE.md；额外规则由 ruleFiles 指定。仓库内 `.agents/skills`、`.claude/skills`、`.trae/skills` 的技能入口可以发现、按需读取。规则和技能应在仓库已提交版本里。

## 编码、评审、回修如何工作

- **编码会话**可以搜索/读取真实代码、读取固定原件与图片、查材料历史、读取项目规则、写文件和运行登记命令。写文件检查读取时的内容指纹，防止覆盖后来修改。原生 Traex 保持只读权限，代码修改与命令执行走专门的 MCP 工具。
- **宿主检查**真实运行项目的必需检查并保存退出码、输出和对应代码指纹。检查命令修改源码或产生未忽略文件时，要求整理后重新验证。
- **独立评审**使用新 ACP 会话，只接收原需求、原件、验收项、实际代码/差异和检查结果，不接收开发者自评。可自主补读、复跑登记检查；没有代码写入工具。逐项给出通过/失败/未运行，问题注明位置和修改建议。
- **回修**把评审问题交回编码角色，最多三轮。条件不足或仍有问题时保留副本和问题，不无限重试。ready 需要必需检查成功、评审覆盖全部验收且没有必须修复的问题；不等于人类验收或上线。

```bash
omem develop list
omem develop show RUN_ID
omem develop diff RUN_ID
omem develop resume RUN_ID
omem develop apply RUN_ID
```

start/resume 在前台运行，Ctrl+C 停止；进程中断后显式 resume，继续保留的副本。活动超时沿用 Agent 配置。apply 重新核对已评审代码、原仓库提交和干净状态，重新生成补丁后应用，不自动提交。原仓库已有新改动时拒绝覆盖，保留补丁供手动合并。新任务冻结材料范围、原件摘要和验收定义：单纯补充本次开发进度允许沿用原任务；原始需求、范围、目标或验收描述改变仍需重新规划和评审。旧任务没有这种基线时仍严格核对需求文章版本。

### 准备远端仓库

用户可以直接说“准备这个仓库的 main 分支，项目别名用 billing”；主助手提交 `prepare_repository`，常驻服务后台执行，随后用 `repository_status` 查实际提交、目录或错误。地址须由本人提供，或者来自已经登记的项目；不会从消息材料中自行选一个新远端。重试沿用同一项目，不把登录失败说成项目不存在。准备完成和失败沿用已有通知流程。

### 让助手配置开发与检查方式

已准备的项目不再要求用户先手填检查 JSON。可以直接说“在 billing 实现这个需求，按项目说明准备并检查”；助手先读现有配置、项目规则、README、依赖清单和实际脚本，再把配置与编码交办一起提交。只想准备配置时可以说“先配置 billing 的开发和检查方式，暂不编码”。两种方式都由宿主保存实际配置；保存本身不运行安装或检查。

`project_inspect` 返回根规则、文件入口、当前配置版本及其依据是否变化；`project_files/read/search` 允许继续补读子目录、CI 和 skill。助手选择明确的执行文件、参数、工作目录与 setup/test/build/browser/design 用途，保留已有用户约束，并说明尚缺的服务、权限或验收方式。配置保存已读文件的内容摘要，避免用过时说明覆盖新设置。它们是项目操作依据，不是另一份知识文章或新的授权。

用户交办本地实现包含通常的项目依赖准备和检查；发布、推送、消息写入、全局安装与系统配置不在这个范围。快速模型可建议文件用途、环境前提和可能的外部副作用，不能代替主助手读脚本或授权执行。没有现成测试时应说明检查覆盖，不能用空命令充数；构建成功也不等于界面或业务验收成功。

后台任务在排队时固定配置，后续调整不影响已排队和运行的任务；本地登记仓库仍在任务创建副本时选择实际 HEAD，远端准备目录则已按提交分开。CLI/外部 Agent 可用 `develop inspect ALIAS`、`develop read ALIAS README.md` 和 `develop configure ALIAS configuration.json` 完成同样操作。配置文件包含 inspect 返回的 expectedVersion、完整 instructions/ruleFiles/commands、已读 sources（path/hash）、summary 和 gaps。实际检查仍在独立编码副本运行，日志和退出码随任务保存。

### CLI 与仓库数据

CLI 供 Agent 装配和诊断：

```bash
omem develop prepare billing git@example.company:team/billing.git --ref main --config ./development-project.json
omem develop repository billing --json
omem develop refresh billing
# 明确切换分支；之前的工作区和编码任务保留
omem develop refresh billing --ref release/next
```

本地 Git 仍可 `develop register`。`prepare` 支持 SSH、HTTP(S) 和绝对路径，不依赖 GitHub；`--config` 提供项目名称、规则与检查命令，repository 字段由宿主填写。省略配置时只登记项目，检查列表为空，不能称为已具备项目验收。`refresh --config` 可由装配 Agent 更新配置，未提供则沿用原规则和检查。上述命令运行于服务机器的个人库，不接受 `--url` 去管理另一台服务。

复用 Git 的 [fetch](https://git-scm.com/docs/git-fetch)、[worktree](https://git-scm.com/docs/git-worktree) 和[凭据助手](https://git-scm.com/docs/gitcredentials)。认证留在已有 SSH / Git 配置，地址不能携带密码或 token；不会自动登录。准备过程不执行依赖安装、项目脚本、push 或递归子模块读取。LFS 和子模块尚未自动补齐，发现声明时显示缺口。拉取持续有输出就续期，两分钟没有输出才报无活动；进程中断后可重试，缓存对象保留。

数据在 `development/repositories/ALIAS/`：一个 Git 对象缓存、当前准备状态和按提交保存的工作区。刷新获取新提交后登记新的本地路径，旧工作区及未提交修改保留。编码任务仍按创建时的项目路径和提交建立自己的独立副本；旧任务不会因远端刷新悄悄换基线。对远端项目 apply 只写入该任务对应的本地准备目录，并不推送到远端。工作区/缓存当前没有自动回收策略，不能直接删除仍被任务引用的版本。

快速模型可对失败记录给凭据、网络、版本、本地环境或不确定等原因和排查方向建议；不会因此扩大读取范围、改分支或执行修复。真实 SSH、公司 SSO、子模块/LFS 与大型业务仓库还需要各自验收。

本地路径在 `DATA_DIR/development/projects` 与 `development/runs/RUN_ID`。运行记录包含固定需求、项目配置、代码副本、检查日志、各轮角色结果及最终补丁，不应进入 Git。develop 是本地命令，不使用远端 `--url`。由主助手派发的编码任务保存在同一个个人库中，随常驻服务执行；进程重启会续跑同一任务和副本。前台 CLI start/resume 仍是显式执行。通过聊天询问进度，可读到当前阶段、实际检查和独立评审；完成/失败复用已有通知与机器人绑定。

## 执行结果如何回到需求和记忆

每次后台任务结束，宿主把工作阶段、固定需求、实际检查及退出码、独立评审意见和补丁摘要捕获为原始材料，明确记录“副本完成”或“已应用”。同一编码任务使用同一 Source，恢复和应用产生新 Revision；旧版引用保留，重复处理同一完成事件不会再生成一份。最近 20 次检查各保留最多 3,500 字节日志末尾，补丁保留开头 70,000 字节，截断会注明完整私人文件位置；完整内容仍可经开发结果工具和任务目录读取。

材料直接关联原需求页和已有项目归属，不靠标题相似度猜测。开启持续跟进的需求进入原有合并队列，由研究者补读、规划者更新、独立会话复核后发布到同一页。暂停跟进只保存结果，不擅自恢复写作。`work_result` 返回捕获版本、当前需求是否引用它，以及学习任务状态；“已保存”“已排队”和“正文已更新”分别呈现。

材料也进入既有 `extract_claims` 学习队列，再由记忆调查与 MemoryService 决定是否更新记忆。学习未开启时留在队列，不代表已有记忆写入。评审意见是模型判断，真实检查也只能支持它覆盖的行为；两者都不证明已发布，不会由捕获代码直接把所有待办标为完成。需求发布后只同步已关联的明确行动，保留人工改过的待办。

快速模型复用新增/换版材料的相关性、变化类型、背景是否足够等建议，帮助研究者先读进展或阻塞；不会直接判定完成或过滤掉低分原件。本轮是否准确、是否提速仍需另测。当前回流覆盖主助手后台和前台 CLI；外部工具回执全文自动进入统一材料库、需求变更后的自主重新规划尚未完成。

## 借鉴 dev-flow 的哪些能力

已阅读本机 dev-flow 的 README、需求进展约定和独立验证 skill，采用以下设计原则，不把整个测试平台搬入个人库：

| dev-flow 的做法 | 在 omem 中如何使用 |
| --- | --- |
| 功能点和验收是权威输入，进度引用同一条目 | 需求文章保存稳定 criteria/actions；编码与评审覆盖相同 ID |
| 保存代码影响、卡点与每轮问题 | 独立副本、每轮完整差异/检查、评审 findings 和阻塞状态 |
| 验收不读开发自评 | code-reviewer 全新会话从原需求、代码和运行结果重新判断 |
| 旧证据不能证明新源码 | 检查绑定指纹，评审后或应用前源码变化会使结果失效 |
| Mock、Figma 按真实需求使用 | 作为项目 browser/design 命令和 skills 接入，不给无 UI 需求强塞视觉流程 |

现阶段可以登记调用已安装 dev-flow 的项目命令、提交项目相应配置与 skills。尚未内嵌它的 Figma 下载缓存、静态 Mock runtime、测试包和 Studio；也不声称当前 Agent 已能自动完成任意 Figma 验收。下一步有真实界面需求时，应复用其可搬运验收包和独立 verdict，而不是再造一套字段测试和图片评分器。

## 当前边界与验收

消息自动归属依赖 learning.enabled 和有效 Agent；watch 只跟随已归属材料，不猜群名，也不自动同步所有远端文档或仓库。代码检查成功不会把需求页自动改成“上线”；需要把真实检查/代码材料捕获后重新调查。实施已验证 Traex、Codex ACP；Claude 实验适配完成但实际推理缺认证。两角色独立配置、固定与支持状态见 [Agent 提供方](agent-providers.md)。

`osdk run development:verify` 用临时合成项目覆盖跨来源需求、关联待办、真实 Sol 编码、子目录规则、独立评审和应用前原工作区保护。具体本轮结果与失败见 [progress.md](progress.md)。固定输出覆盖 `.repo-review/runtime/research/development.json`，不追加重复正文。
