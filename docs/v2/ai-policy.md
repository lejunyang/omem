# AI 规则：先定能用哪些，再让模型排先后

四期服务端已接入（2026-11-27）；设置（后端与模型 → 规则）和 Agent 档案的网页编辑入口 2026-11-28 接上。各期进度见 [实现状态](status.md)。和 [ai-models.md](ai-models.md) 的“运行前选 AI”“换后端的顺序”、[agent-accounts.md](agent-accounts.md) 的成员账号一起读。

设置客户端读取 `GET /api/ai/policy` 的 `classes`、`groups`、`policy`、`usage` 和 `backends`（每个后端的程序、key、已知模型和自动命令词，用来把规则写法说成人话、给排除和别名提供候选），按类别显示运行类型、角色、规则来源与近七天各 AI 的次数。类别规则和组分别通过 `PUT /api/ai/policy`（规则对象）和 `PUT /api/ai/groups`（组数组）保存。档案编辑器使用档案的 `class`、`ai.use`、`ai.deny` 和 `ai.strict`，按同一规则提示角色默认值冲突。

一句话提案提交至 `POST /api/ai/policy/propose`，传 `{text}` 后用返回的 `runId` 查看运行；`output.askId` 指向本人确认卡。保存总体偏好仍走 `PUT /api/settings`，响应中的 `guidanceWarning` 可配合提案入口显示。决策报告 `GET /api/ai/decision/report` 的 `routes` 按类别提供模型排序和默认先后的完成数、已知结果数和待定数。

## 1. 现在的问题

现在选 AI 有四处设置：默认后端与按角色的后端 / 模型（`agents.roles`、`roleModels`）、三个档位（`agents.tiers`：强 / 标准 / 省，各一个 AI，只给流程、研究和编码恢复用）、Agent 档案里的一个默认（`agent` / `model` / `effort`）、任务选型（`agents.routing`：一段总体偏好、一组带适用说明的候选，运行前由决策模型挑一个，再按概率排出换后端的顺序）。

在常驻服务器上看了 11-26、11-27 两天的选型记录（运行事件里的 `choice`）：

- **决策模型基本在猜。** 被采用的那一项，概率多在 0.24–0.41；选项有 4–6 个，平均分是 0.17–0.25。没有门槛，概率再低也照用。另有 115 次选型失败：103 次是 11-26 白天一个决策模型的提供方返回 429，其余是超时和连不上。
- **“禁止”只被当成倾向。** 总体偏好里写了“日常频繁的材料整理不要用 gemini”，候选里 gemini 那一项写着“适合文字型工作”。两天里材料整理（`ingest`）有 18 次被放到 gemini、4 次放到 Claude Opus，会话摘要 10 次放到 gemini，巡检 2 次。写 Wiki 放到 gemini 的 12 次才是想要的。
- **它不知道任务是哪一类。** 材料里的“由谁做”是角色 id（`ingest`），任务正文是待整理的材料本身。“这是每来一批材料就跑一次的整理”这件事，决策模型看不到。
- **说明里写的模型选不到。** 候选按后端写，说明里说“要更强选 neon，不选 hydrogen”，可是选项里只有这个后端的默认模型。
- **保留原来的 AI 也不保险。** 选型保留了原来的 AI 时，换后端的顺序里仍排着 gemini 和 Claude（`failoverProfiles` 把全部候选接在后面），一出故障、一排队就换过去。
- **没有“只能用这些”的说法。** 角色、Agent 档案只有一个默认 AI；三个档位不够装下十几个模型；本人想让某件事只用某两个模型，只能靠总体偏好里的一句话。

根子在于：把硬约束、任务分类、偏好、实时状态揉成一段文字，每次运行交给一个 9B–几十 B 的分类模型从头读。分类模型适合回答形状清楚的小问题（这段材料要不要看、两个里选哪个），不适合解读规则。

## 2. 三样东西

### 2.1 任务类别（宿主定，不靠模型猜）

每次运行属于一个类别，由运行类型和角色查表得到（`src/agents/run-classes.ts`，新文件）。Agent 档案可以写 `class:` 声明自己属于哪一类。

| 类别 | 包括（举例） | 特点 |
| --- | --- | --- |
| 日常整理 `routine` | ingest、archive、thread-summary、memory-review、item-settle、item-follow、commit-claim、learn-feed、note-review | 每来一批材料就跑，次数多、量大，要省、要稳 |
| 巡检与分诊 `watch` | heartbeat、triage、mention、first-look、digest、problem-follow | 频繁，要快 |
| 对话 `chat` | ask、lark-command、guest | 本人在等 |
| 写作 `writing` | wiki-plan / write / organize / resolve / lint、brief、dream、work-state | 输出长 |
| 编码 `coding` | code、design、req-split | 现在不进选型，按编码角色的设置 |
| 评审 `review` | review、quality-audit、outcome-review、flow-review、profile-review | 同上，另有换家评审 |
| 调查与交办 `agents` | agent（Agent 档案）、peer-agent | 内容差别大 |
| 流程与研究 `flows` | flow-stage、flow-runner、flow-reconcile、study-trial | 阶段里可写 `ai:` |
| 跟进 `supervise` | 负责跟进的助手（[supervisor.md](supervisor.md)） | 要强、要稳定 |

不进类别、不经规则的只有内部运行：探测（probe）、复盘的对比臂（replay、replay-arm：它们本来就是在比模型）。

设置页每个类别一行，点开看包括哪些运行类型和角色，以及近 7 天各用了哪些 AI、几次。

### 2.2 AI 组（取代三个档位）

一组 AI，有先后，本人起名字。每一项是 后端 · 模型 · 强度，可带时段和一句说明：

```yaml
groups:
  - id: cheap          # 内置三个：strong / standard / cheap，页面上叫 强 / 标准 / 省
    name: 省
    items:
      - { ai: traex · deepseek-v4.1-flash · medium, hours: "20:00-09:00", note: 晚上不排队 }
      - { ai: codex · gpt-6.2-sol · low }
  - id: writing
    name: 写作
    items:
      - { ai: antigravity · gemini-4-neon · high }
      - { ai: claude · claude-opus-5-5 · high }
  - id: supervise
    name: 长任务候选
    items:
      - { ai: codex · gpt-6.2-astra · xhigh }
      - { ai: claude · claude-opus-5-5 · high }
```

- 组内的先后由本人定；宿主按先后取第一个现在能用的（不在时段内、满了、额度快用完、刚出故障的往后放，现有的 `acquire` / `quotaAvoid` / `downReason` 不变）。
- 旧的三个档位迁成只有一项的 `strong` / `standard` / `cheap` 组。流程里的 `ai: strong`、研究环境的 `ai:` 照旧能用。
- 组名在所有能写 AI 的地方都能用：流程阶段的 `ai:`、Agent 档案、规则的“交给 Agent”、助手交办时的 `execution`、命令（第 5 节）、对话里说“用写作组”。
- 现在的“任务选型候选”迁成一个名叫 `candidates`（候选）的组，适用说明留在每一项的 `note` 里。尚未设类别规则时，旧流程档位只供原调用方使用；旧候选组与角色默认 AI 一起参与选型，拿不准时仍以角色默认 AI 起步。

### 2.3 规则

每个类别一条，Agent 档案可以有自己的一条：

```yaml
policy:
  deny: [model:grok]                    # 所有类别都不用
  classes:
    routine:
      use: [cheap, standard]            # 只在这些组里选；不写 = 不限
      deny: [model:gemini, backend:claude]
      order: fixed                      # fixed：按 use 的先后；choose：让决策模型在 use 的组之间挑
      strict: true                      # 用不了时只在 use 里换，都不行就排队等，不换到别处
      said:                             # 这条规则从哪句话来（第 3 节），只用于显示
        - { text: "日常整理别用 gemini 和 Claude Code", at: 2026-11-27T21:00+08:00 }
    writing:
      use: [writing, standard]
      order: fixed
```

`deny` 的写法：

| 写法 | 排除什么 |
| --- | --- |
| `backend:claude` | 这个 Agent 程序的所有形态：ACP 版、命令行后备（claude-cli）、API key 生成的（claude@编号）、别的设备上的（peer 的 agent 是 claude）及自定义编号。依次按 peer 的 agent、程序来源、状态目录类型、目录里的启动命令、后端编号识别程序 |
| `model:gemini` | 这一家的模型，在哪个后端上跑都算（按 `families.ts` 认：gemini / claude / gpt / deepseek / doubao / qwen……） |
| `ai:traex · deepseek-v4.1-flash` | 某个后端上的某个模型（强度不写就是全部） |
| `key:<编号>` | 某个 API key 生成的全部后端 |

规则怎么生效：

1. **范围**：一次运行能用的 AI = （Agent 档案的 `use`，没写就用类别的 `use`，都没写就是全部）减去 档案、类别、全局三层 `deny` 的并集。
2. **谁点名都要过范围**：助手交办时给的 `execution`、流程阶段的 `ai:`、规则里写的 AI、成员的个人默认，不在范围里的，工具直接拒绝并写明是哪条规则（`validateExecution`）；流程和规则在保存时就校验。
3. **本人当场点名例外**：本人用命令或在这一轮里说“用 X”，照本人的来，运行记录写一行“本人点名，越过了『日常整理不用 gemini』”。本人存成默认（`save`）的仍要过范围，保存时提示冲突。
4. **起步**：`order: fixed` 时取 `use` 里第一个组的第一个能用的；`choose` 时才问决策模型（第 4 节）。
5. **换后端**（故障、额度、排队、上游出错）：只在范围里按先后换。`strict: true` 时只在 `use` 的组里换；都用不了就排队等，等太久（`queueTimeoutMinutes`）就失败并通知本人，不换到范围外。现在 `failoverProfiles` 把全部候选接在后面的做法改成先过范围。
6. **角色的旧设置**：`agents.roles` / `roleModels` 继续当“这个角色在组内的首选”。角色默认用了被禁的 AI 时，设置页把那一行标红；运行时跳过它，记录写明原因。

## 3. 本人的话怎么变成规则

两处入口：

- 设置 → 后端与模型 → 规则：每个类别一行，点选组和要排除的后端、模型族。
- 用一句话：设置页的“用一句话改”，或在对话里对助手说（“日常整理别用 gemini 和 Claude Code”“写文档优先 gemini 的 neon”）。

一句话的处理：

1. 交给通用模型（`strong` 组，不是决策模型）：附上全部类别（含说明和包括的运行类型）、全部组、现在能用的后端和模型、现有规则，让它输出对规则的改动（新工具 `propose_ai_policy` 的结构化参数：改哪个类别、加减哪些 `use` / `deny`、`order`、`strict`）。
2. 宿主校验：类别、组、后端、模型族都存在；把每条 `deny` 展开成它实际排除的 AI（`model:claude` 也会排除别的后端上的 claude 模型，这时要列出来）；按近 7 天的运行算出影响。
3. 发一张卡给本人：

   > 日常整理：不再用 gemini（antigravity · gemini-4-hydrogen、gemini-4-neon）和 Claude Code（claude · 全部模型）。近 7 天有 26 次会换到别的 AI。
   > [确认] [改一下] [不改]

4. 确认后才写进设置，原话进这条规则的 `said`。看不懂、对不上的部分，卡片上写“这半句没有对应的设置：……”，不硬猜。

总体偏好那段自由文字保留，只在范围内排先后时用。保存时发现里面有“禁止 / 不要用 / 别用 / 只用 / 必须用”这类词，提示“写在这里只当倾向，要一定做到请转成规则”，按钮把这段话交给第 1 步。

为什么这样做：理解一句话、对上现有的后端和模型，交给强模型做一次、本人确认一次；之后每次运行按确定的规则过滤，记录里能看到哪条规则排除了谁。决策模型不再承担“读懂规则”的事。

## 4. 决策模型还做什么，怎么更可信

只在 `order: choose` 的类别、范围里还有两个以上的组时才问。默认除编码、评审外都是 `choose`（大部分任务照旧自动选）；本人给高频的简单任务（日常整理、巡检）限定组并设 `fixed` / `strict`，给要指导或写作的类别指定强的组，这些由本人按第 3 节设。

问题换成它答得好的形状：

- 选项是**组**（2–3 个，例如“标准”“强”），每个组带本人写的一句用途；组内用哪一个由宿主按先后和占用定。不再让它在 6 个后端里挑。
- 材料里写类别名和说明（“对话：本人在等回答”），任务正文截到开头 1500 字；不再给角色 id。
- 时段、额度、排队这些宿主已经知道的，由组的 `hours` 和现有的额度规则处理，不写进选项让模型对照。

门槛和记录：

- `route` 加进 `DECISION_SCENES`：最高概率低于门槛（默认 0.55）、或和第二名差不到 0.15 时不采用，按 `use` 的先后；记录写“决策模型拿不准（标准 0.41 / 强 0.36），按默认先后”。门槛在 设置 → 决策 改，和别的场景一样。
- 每次判断写 `decisions`；结果标注用运行的结局：正常完成、失败、被换掉、本人改了 AI 重跑、本人对回复回了负面表情。决策页的报告按类别列“采用模型的选择”和“按默认先后”两边的完成率，样本够了再定这个类别要不要继续让模型挑。
- 调用超时：对话 8 秒，后台 20 秒；超时、限流、出错都按默认先后，不再等通用模型（现在决策模型出错时这一类运行直接不选，`always` 的才改问通用模型；规则生效后“不选”也不会出范围）。

## 5. 命令：`/<后端> [模型] [强度]`

后端名直接当命令，参数写得随意也认：

```
/codex astra xhigh            本会话改用 codex · gpt-6.2-astra · xhigh
/claude opus5.5 high          claude · claude-opus-5-5 · high
/claudeopus5.5high            同上（不加空格也行）
/traex deepseek               traex · deepseek-v4.1-flash，强度不变
/gemini neon                  gemini 是 antigravity 的别名
/codex 方舟 seed high          用 API key「方舟」生成的 codex@<编号>，模型在这个 key 的模型里找
/强                            用“强”组的第一个能用的，例如 /写作 选择写作组
/codex astra xhigh 帮我查一下…   只这一件事用它，不改会话
/ai off                       恢复默认（/model off 照旧）
```

解析规则：

1. **后端**：命令词按后端的 id 和别名找（不分大小写；`cc` / `claude` → claude，`gemini` / `agy` / `antigravity` → antigravity），取最长的前缀，余下的当参数（所以 `/claudeopus5.5high` 能拆开）。拼错一个字母、名字至少 5 个字母、只像一个后端时也认，回复里写“按 /claude 理解”。不像任何后端的照旧当普通文字交给助手。组名（中文或 id）也能当命令词。

   后端的编号、显示名、目录条目编号、启动命令的文件名（去路径和扩展名）、`source`、`peer.agent` 都会成为命令词。常用别名按实际程序匹配，自定义编号的 Antigravity 也可用 `/agy`、`/antigravity` 和 `/gemini`。在 `agents.profiles[].aliases` 可给后端增加名字，例如 `["谷歌"]`。通过 `PUT /api/settings` 保存；自定义别名和组编号、组名均不得占用已有命令或其他后端的自动名、自定义名。保存失败时返回冲突对象。

   同一程序有多份时优先本机登录，并提示其他可用入口。可以用 `/codex@ark` 指定 key，或在后端后写设备编号或设备名。命中了已知后端而它们均不可用时，命令直接回复原因和目录中已有的安装提示。需要用一个词指定后端、模型和强度时，创建只含这一项的 AI 组。

2. **强度**：参数末尾的 `minimal / low / medium / high / xhigh / max`（也认 低 / 中 / 高 / 极高 / 最高），先比长的（`xhigh` 不会被读成 `high`）。
3. **API key**：参数里有词对上某个 key 的编号或名字时，换成这个 key 生成的那个后端（`codex@<编号>`）；也可以直接写 `/codex@ark`。同一后端只有一个 key 时不用写。模型按 key 的模型显示名找，接入点 ID 不用记。
4. **模型**：余下的在这个后端（这份登录或这个 key）检测到的模型里找。两边都去掉符号、转小写后：是子串的最优先；没写版本号而有几个版本（`astra` 对上 gpt-6.2-astra 和 gpt-6-astra），取版本号最大的，回复里写“astra → gpt-6.2-astra（最新的）”；名字不同的几个都像（`seed` 对上三个 Doubao-Seed），回一张卡让本人点；一个都对不上，列出可选的。
5. **任务**：AI 那几个词之后，从第一个中文字或换行起是任务，只这一件事用这个 AI。
6. **范围**：本人点名的照用（第 2 节第 3 条）；成员只能点自己能用的后端和账号（现有 `memberAccountPlan`）。`/codex save astra xhigh` 存为默认，语义同现在的 `/model save`。

`/topic` 也认 AI：`/topic codex astra xhigh 任务…` 开话题，并把这个话题定在这个 AI 上。

`/help` 只列五个常用的（`/topic`、`/<后端> 模型 强度`、`/跟进`、`/stop`、`/new`），其他在 `/help all`。

## 6. Agent 档案

```yaml
---
name: 发布检查
class: agents
ai:
  use: [standard, ai:claude · claude-opus-5-5 · high]   # 组名或具体的 AI
  deny: [model:deepseek]
  strict: true
---
```

旧写法 `agent` / `model` / `effort` 照旧，等于 `use` 只有这一项、`strict: false`。Agent 页的“默认 AI”换成“能用的 AI”：选组或具体 AI、可排除、勾“只用这些”。

## 7. 运行记录

选 AI 的那条 `status` 事件改成说清三件事：

```
日常整理 · 范围：省、标准（不用 gemini、Claude Code，11-27 你说的）
按先后用 traex · deepseek-v4.1-flash · medium；用不了依次换 codex · gpt-6.2-sol · low、codex · gpt-6.2-sol · high
没进范围的：antigravity（规则）、claude（规则）、traex · gpt-6.1-sol（额度快用完）
```

`ChoiceRecord` 加 `class`、`scope`（范围内的组和 AI）、`excluded`（被哪条规则排除）；换后端的 `failover` 事件加 `inScope`。

## 8. 分期

1. **规则**：类别表、组（含旧档位和候选的迁移）、`use` / `deny` / `order` / `strict` 接进运行前选型、换后端、`validateExecution`、流程和规则的保存校验；设置页的规则和组；运行记录。
2. **命令**：`/<后端>`、组名命令、宽松解析、`/topic` 带 AI、精简 `/help`。
3. **一句话改规则**：`propose_ai_policy`、确认卡、总体偏好里的硬约束提示。
4. **决策模型**：选项改成组、`route` 场景的门槛和记录、超时。

第 1、2 期做完就能解决“日常整理被放到 gemini / Claude”和“记不住怎么换模型”。
