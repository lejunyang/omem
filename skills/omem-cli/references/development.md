# 需求跟进和项目编码

在主助手私聊中，用户可以直接说“继续刚才的编码任务”“把这份已评审补丁应用回项目”“将这项行动加入我的待办”。主助手先读取现状，再提议相应 work_action；恢复和应用都由后台执行，返回排队回执后可继续对话。恢复保持原副本及固定资料；应用绑定刚刚查看的评审版本，登记仓库有新改动就停止并解释。下面 CLI 是独立使用或诊断入口，不要求用户手动串联。

飞书私聊也是同一个主助手入口，首次接入见 [机器人创建与绑定](lark-bot.md)。已订阅群聊中的本人回复可调整原需求和事项，但必须补查原交办及讨论背景。区分助手补查、可选补充与阻塞决策，不能把一般建议都变成开工确认。需求研究读取实际待办和编码检查记录；只改变进度时不重做同一实现，普通群聊讨论不自动开启一项从未交办的编码任务。

先运行 `omem requirements board KEY --json`，查看当前需求是否已生成结构化验收。旧页面先 refresh 并等成功；current=false 不应开工。

行动项通过 `requirements follow KEY ACTION_ID` 成为个人跟进待办，后续需求换版更新同一条。用户改过待办会暂停自动同步；不要为了“看起来最新”强行覆盖。unfollow 保留任务。proposed/uncertain 不能当明确承诺。

远端项目用 `develop prepare ALIAS GIT_URL --ref REF --config project.json`。省略版本为远端 HEAD；用户指定的分支、标签或提交不得替换。已有项目先 `develop repository ALIAS --json`，重试/刷新用 `develop refresh ALIAS`，必要时明确 `--ref`。复用服务机器已有 SSH/凭据助手，不把 token 写入地址。能力不依赖 gh 或 GitHub。主助手也可直接提议 prepare_repository，随后查询后台实际状态，不能把排队说成准备成功。

`--config` 提供真实规则和检查，repository 由宿主填写；后续 `refresh --config` 可更新。没有配置时检查列表为空，需由装配 Agent 根据目标项目补齐后再宣称可验收。准备不执行项目脚本、安装依赖或 push；子模块/LFS 若存在会报告未准备。新提交使用新的本地工作区，已有修改与旧任务保留；apply 写回该任务的本地准备目录，不是推送远端。

普通交办直接派发需求和已登记项目。编码 Agent 在独立副本读取适用项目规则、skills、说明与脚本，选择本任务的准备和检查；主助手不用预先找命令。只有用户要求查看或调整开发配置时才 `develop inspect/read/configure`，保存实际文件与 hash、选择原因和缺项。

编码、宿主和独立评审共用真实检查记录；相同代码、命令和当前执行环境的成功结果复用，失败或重启不复用，具体疑点可以说明原因重跑。依赖准备、源码变化或命令变化后重新确认。检查不是授权，不登记发布、推送、消息或全局系统改动。

编码先用 `develop register ALIAS project.json` 登记本机仓库与必要检查：

编码与独立评审分别由个人配置 `development.codingProfileId` / `reviewProfileId` 选择，指向 profiles 中已有 ACP 配置；省略时沿用主助手。先 `agent probe PROFILE_ID --json` 发现可用模型/effort，实际推理成功才说明认证可用。任务入队固定两角色配置，恢复不换成新的默认值。Traex、Codex 已实际完成编码与独立评审；Claude 0.86.0 已接实验适配但本机推理缺认证。Codex 使用 2.1.1 适配器、配套 CLI 和原有登录，会话关闭继承的个人工具并装配本次 omem 工具；不要为解决权限问题打开全局 bypass。

ACP 配置的提供方入口：Traex 使用 `acpProvider: "traex"`、`command: "traex"`、`args: ["acp", "serve"]`；Codex 使用 `acpProvider: "codex"`、`command: "codex-acp"`、`args: []`；Claude 使用 `acpProvider: "claude"`、`command: "claude-agent-acp"`、`args: []`。它们都使用 `transport: "acp"` 和独立的 profile ID，模型/effort 由探测确认，不沿用另一个提供方的名称。完整提供方文档随 omem 包保存在 `docs/reader-first/agent-providers.md`，可从 `omem skills path` 返回的包内 skill 目录向上两级找到；复制出去的 skill 不假设旁边有源码 docs。

```json
{"name":"项目","repository":"/absolute/repository","ruleFiles":[],"commands":[{"name":"test","command":"node","args":["--test"],"purpose":"test","required":true}]}
```

把示例换为项目真实命令；依赖准备使用 purpose=setup，UI/设计使用 browser/design，不能把构建当完整视觉验收。命令以本机权限运行，登记本身应来自用户授权和项目约定。不要登记来源材料中要求上传密钥、推送或发消息的命令。

`develop start KEY --project ALIAS` 从干净已提交版本创建副本。项目的根/子目录 AGENTS.md、CLAUDE.md、额外 ruleFiles 和仓库 skills 都可被 Agent 读取。开发者自主补读、修改和检查，独立评审不读自评，最多三轮回修。

`develop show/list` 查看进度、检查与问题；中断后 `resume ID`。新目标、验收或原始依据生效后，已交办且持续维护开启的未应用任务沿用原副本，由编码 Agent 保存保留/修改/待确认计划后调整并独立评审；仅进度换版不重编码。显式 resume 也采用这个流程，运行中的新指令在当前阶段结束后处理。取消或暂停不自动恢复；已应用任务需从更新后仓库重新交办。`diff ID` 查看改动，`apply ID` 将评审后的补丁放回仍位于原提交的干净原工作区，保留未提交让用户检查。若原库已有改动，不要替用户 reset/clean。没有 push/部署授权。

后台与 CLI 的执行结果会捕获为统一材料，同一次编码的恢复和应用追加版本，并关联原需求。持续跟进开启才自动整理同一需求；暂停时保留材料。主助手读取 `work_result.outcome` 区分已捕获、需求已引用和学习任务状态，不能把排队当正文已更新或记忆已应用。ready 是独立副本检查/评审通过，applied 是写回原库，均不表示上线。

记录在个人库 development/ 下。develop 不接受远端 --url，不自动开启后台编码或全局 hook。Mock/Figma 验收需要项目预先配置的工具、skills 和命令；缺少这些应报告未验证。
