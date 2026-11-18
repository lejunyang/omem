# 接管 Agent 自带的技能

## 要解决的问题

不少命令行工具安装时会把自己的技能平铺进各家 Agent 的技能目录：`~/.claude/skills`、`~/.agents/skills`（Codex 和 TraeX 都读）、`~/.trae/skills`……一个内部平台的命令行就可能装进两三百个。每个 Agent 启动时都会带上全部技能的说明，命令行会截断，或者提示“技能说明被缩短”，模型看不清每个技能是做什么的，也就不知道该读哪一个。

omem 自己的运行原来也只列 `library/_skills` 里的技能，不管这些目录。

## 做法

打开接管（`agentSkills.takeOver`，默认关）后：

1. **收走**：omem 扫描已知 Agent 的技能目录（`src/agents/catalog.ts` 里各条目的 `skills.read`，加上设置里的 `agentSkills.extraDirs`），把里面的技能复制进 `library/_skills/<名>/`。原件移进 `<数据目录>/agent-skills/backup/<时间>/`，同时写一份 `manifest.json`（只保留最近 5 份）。链接直接删掉，不动它指向的目录。同名技能出现在几个目录里时，取 SKILL.md 最新的那份。以 `.` 开头的目录（Agent 自己的内置技能，如 Codex 的 `.system`）不动；名字不是小写字母、数字和连字符的跳过并报告。
2. **归组**：新收进来的技能先看同一名称前缀的技能已经在哪个组，在哪个组就放进哪个组；没有的话，前缀至少有三个技能共用时，用这个前缀作组名；都不满足就放进 `other`。分组、组内用途和启用状态记在 `library/skill-groups.json`（进 Git），不写进 SKILL.md，所以上游的新版本可以直接替换库里的副本。
3. **写回入口**：每个 Agent 只往一个目录写（`skills.write`：Codex 和 TraeX 写 `~/.agents/skills`，Claude Code 写 `~/.claude/skills`），读两个目录的 Agent 不会看到两份。写进去的有两样：一是 omem 的使用说明（仓库里的 `skills/omem`），二是每个启用的分组一个总入口。总入口的 `description` 说明做哪类事时该读这一组；正文按用途分节列出技能，并给出全文路径（`library/_skills/<名>/SKILL.md`，也可以用 `omem tool read_skill`）。组里技能超过 40 个且分了用途时，正文只列名字，各用途的说明放在 `purposes/NN.md`，这样总入口本身保持短小。omem 写的目录都带 `.omem-managed` 标记，扫描时跳过；分组停用或删除后，对应的总入口会被删掉。
4. **定时再收**：工具升级时往往会把技能装回去。接管打开期间，每 `agentSkills.everyMinutes`（默认 10）分钟扫一次。同名技能有新版时，替换库里的副本，分组、用途和开关保持不变；有新技能进来时发一条稍后合并的通知。库里本来就有的同名技能（不是接管来的）保留库里的版本，记为冲突。接管来的技能被删掉后，会留下一条停用记录，以后再被装回来时仍是停用状态。
5. **撤销**：`omem skills restore` 或网页上的“撤销最近一次”会把原件和链接放回原处（原处已经有东西的不动），删掉 omem 写进去的入口，并关闭接管。技能仍然留在库里。

## omem 自己的运行

- 技能目录（`specs.ts` 的 `skillIndex`）：分组里的技能不逐个列出，每组只有一行：组名、标题、启用数量，再加组的说明（没有说明时列几个技能名），并提示用 `read_skill name=<组名>` 按用途查找。档案或角色明确挂上的技能仍然单独列出、带说明。停用的技能（包括整组停用）不出现在任何地方，空间挂载的技能也一样。
- `read_skill` 的 name 没有对应技能、但有同名分组时，返回这一组的总入口；`file` 可以读 `purposes/NN.md`。
- `list_skills`：分组里的技能只列分组；`group=<组名>` 列出这一组的全部技能、用途和启用状态。
- `organize_skills`（分组 `skills`，写工具）：一次可以改多个技能的分组、用途和启用状态，也可以改组的标题、说明和整组启用。主助手按分组授权，所以直接能用。设备上的外部 Agent 和影子运行不能用。

## 界面与命令

- Agent 页 → 技能：列表里只有未分组的技能，下面是“技能分组”。打开一个分组可以写标题和说明、整组启用或停用、按名称筛选，以及给每个技能填用途、开关。没选中任何技能时，右侧是“Agent 自带的技能”面板：接管开关、各目录的状态（属于哪个 Agent、是否写入总入口、还有几个没接管）、上次收取的结果，以及“看看会收哪些”（不动文件）、“现在收一次”、“撤销最近一次”三个按钮。
- 接口：`GET /api/skill-groups`（分组和接管状态）、`GET/PUT /api/skill-groups/:id`、`PUT /api/skill-groups`（批量改技能）、`PUT /api/agent-skills/settings`、`POST /api/agent-skills/sweep`（`dryRun`）、`POST /api/agent-skills/restore`。写操作只有本人能做。`GET /api/skills` 不再返回正文和文件列表，改为带上 `group` 和 `enabled`。
- 命令行：`omem skills`（状态和分组）、`omem skills take-over [--dry-run] [--on]`、`omem skills restore [备份]`、`omem skills group <技能> <分组|-> [--purpose 用途]`。

## 边界

- Claude Code 插件（marketplace）带来的技能、仓库里的项目级技能（`<repo>/.claude/skills` 等）不在接管范围内。
- 接管之后，不经 omem、直接打开 Claude Code 或 Codex 时，也只能看到 omem 说明和各组的总入口。读具体技能的全文时要读数据目录下的文件，Claude Code 可能会为此询问一次读取权限。
- 总入口的分流质量取决于组的说明和用途。自动说明只列出技能名，可以让助手“把某组按用途整理并写好说明”（`organize_skills`）。
