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

start/resume 在前台运行，Ctrl+C 停止；进程中断后显式 resume，继续保留的副本。活动超时沿用 Agent 配置。apply 重新核对已评审代码、原仓库提交和干净状态，重新生成补丁后应用，不自动提交。原仓库已有新改动时拒绝覆盖，保留补丁供手动合并。需求在开始/恢复前换版时要求按新需求创建任务；不会悄悄采用旧验收标准。

本地路径在 `DATA_DIR/development/projects` 与 `development/runs/RUN_ID`。运行记录包含固定需求、项目配置、代码副本、检查日志、各轮角色结果及最终补丁，不应进入 Git。develop 是本地命令，不使用远端 `--url`。由主助手派发的编码任务保存在同一个个人库中，随常驻服务执行；进程重启会续跑同一任务和副本。前台 CLI start/resume 仍是显式执行。通过聊天询问进度，可读到当前阶段、实际检查和独立评审；完成/失败复用已有通知与机器人绑定。

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

消息自动归属依赖 learning.enabled 和有效 Agent；watch 只跟随已归属材料，不猜群名，也不自动同步所有远端文档或仓库。代码检查成功不会把需求页自动改成“上线”；需要把真实检查/代码材料捕获后重新调查。实施只验证 Traex ACP；其他 CLI 编码权限适配尚未接通。

`osdk run development:verify` 用临时合成项目覆盖跨来源需求、关联待办、真实 Sol 编码、子目录规则、独立评审和应用前原工作区保护。具体本轮结果与失败见 [progress.md](progress.md)。固定输出覆盖 `.repo-review/runtime/research/development.json`，不追加重复正文。
