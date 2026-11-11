# 方案与变更说明：自己的交办、别人的方案、别人的分支

状态：实现中（2026-11-11 起）。相关：[coding-loop.md](coding-loop.md)（修改项与推进）、[coding-work.md](coding-work.md)（交办视图）、[pre-check.md](pre-check.md)（编码前检查）、[review.md](review.md)、[requirements.md](requirements.md)。

## 1. 要解决的问题

- 交办里 AI 自己推进，容易越写越乱：评审提一条、编码补一层，同一处连着修几层，本人回头看到的是一堆补丁。
- 需求点回答的是“做没做”。本人评审时想知道的是“为什么这么改、有没有更简单的做法、会不会影响别处”，现在只能去 VS Code 里看整份 diff 自己推断。
- 需求点、编码前检查、修改项、变更拆分（change points）各有一套列表，互相对不上。
- 有些需求不是本人实现的：别人写了技术方案，本人想让助手跟进——方案里到底要改什么、有什么问题、哪里可以改进；之后别人的分支出来了，再对照方案做一次综合评审。这和“自己的交办先写方案”是同一件事的两个方向，不应该是两套东西。

## 2. 一个对象：方案（design）

**方案**是一组**决定**，挂在事项（需求）上，也可以单独放在一个空间里。它有三种来历，结构相同：

| 来历（`origin`） | 谁定的做法 | 谁写成方案 | 什么时候 | 之后 |
| --- | --- | --- | --- | --- |
| `own` 自己的方案 | omem 的写方案角色，本人确认 | `designer` | 交办编码之前 | 通过后是这次交办的基线 |
| `external` 别人的方案 | 别人（技术方案文档） | `designer` 读文档和代码，如实提取决定，再逐个评估 | 本人让助手跟进时；文档更新后可重新评估 | 别人的分支出来后，评审对照它 |
| `derived` 事后的变更说明 | 已经写完的代码 | 编码 Agent（小改动不走方案）或评审时的拆分（别人的分支没有方案） | 编码结束 / 评审开始 | 只用来看改动 |

代码这一侧同样统一：一个决定最后落在哪些改动上。

| 代码从哪来 | 改动怎么挂到决定上 |
| --- | --- |
| omem 的交办 | 修改项填它属于哪个决定，宿主按修改项的提交汇总 |
| 别人的分支（`review_branch`） | 评审开始时的拆分把改到的文件归到决定上（原来的“变更拆分”就是这一步，现在归到的是决定） |

所以一条线是：需求点 → 决定 → 改动。

| | 回答什么 | 谁写 |
| --- | --- | --- |
| 需求点 | 要做什么 | 本人 / 助手（需求页） |
| **决定** | 怎么做：这块原来有什么问题、选什么做法、不选什么 | 见上表 |
| 修改项 / 归属的文件 | 一件能单独验证的事 / 落在哪 | 编码 Agent / 评审拆分 |
| 改动 | 提交和文件 | 宿主汇总 |

### 2.1 决定分四种，各写各的内容

一个需求点可以对应几个决定，也可以一个都没有（做法没有可选的余地，直接实现）。决定按它对现有代码做的事分四种，每种要回答的问题不同：

| 种类（`kind`） | 什么时候 | 栏目（`fields` 的键） |
| --- | --- | --- |
| `add` 新增 | 加一项原来没有的能力 | `entry` 入口（用户或调用方从哪里用到它）；`layer` 放在哪一层、为什么；`contract` 对外的约定（类型、接口字段、表结构、配置项——只写签名和字段）；`reuse` 复用哪些已有机制、有意不复用哪些；`behavior` 按情况的行为表；`excludes` 这次不包含什么 |
| `change` 修改 | 改变已有功能的行为 | `behavior` 现在和改后的行为，按情况列成对照表；`where` 改在哪一处（一处，说明为什么不用改别处）；`callers` 受影响的调用方；`migration` 旧数据、旧版本怎么过渡 |
| `remove` 删除 | 去掉一项功能或一段代码 | `removes` 删掉的清单；`users` 谁还在用它和“已经没人用”的依据，或它们迁到哪里；`fallback` 删掉以后原来的入口怎么表现；`cleanup` 要一起清理的数据、配置和文档 |
| `refactor` 重构 | 行为不变，改结构 | `problem` 现在的结构问题（位置）；`structure` 改成什么结构（谁拥有什么）；`invariants` 不变的行为、靠什么证明没变；`removes` 删掉和合并掉的东西 |

每个栏目有两层：`brief`（一句话，卡片收起时显示）和展开后的内容（`text` Markdown、`code` 约定片段、`table` 行为表，按需要给）。

共有的：`title`（一句话，写做法不写任务）、`reqs`（对应的需求点；没有需求页时写任务原话里的哪一句）、`rejected`（考虑过但不选的做法，各一句理由）、`question`（要本人定的，带选项和建议）。

各来历要求不同：

- `own`：该种类的栏目都要有 `brief`；`contract`、`behavior` 这类要给展开内容。
- `external`：如实提取，文档没写的栏目留空——“这一栏方案没写”本身显示出来，是要问作者的地方。`stated: false` 表示这个决定文档里没有、但实现时必须定（由读代码推断出来的）。
- `derived`：只要 `title`、种类和行为上的变化（`behavior` 的 `brief`），其余可缺。

### 2.2 写到多细：到“约定”为止，不到“实现”

**方案写边界上的东西，不写边界里面的东西。**

写：跨模块、跨进程、跨版本的约定（类型定义、接口的参数和返回字段、表和列、配置项，只有签名和字段，一个决定里不超过 30 行）；行为表（行是情况，列是预期结果）；归属（这段逻辑、这份数据归谁管）；删掉什么。

不写：函数体、控制流、变量名、怎么拆文件、测试代码。

整份方案在决定之前有三段，都很短：

- `facts` **影响方案的事实**：调查中发现的、会改变做法的事实，每条带依据。事实错了后面都不用看。
- `matrix` **整体的行为表**：跨几个决定的情况（发布顺序、版本组合）。
- `gaps` **和要求不一致的地方**：做不到或建议换做法的，直接说。

### 2.3 评估：对别人的方案（也用于评审自己的）

决定和整份方案上都可以挂**意见**（`concerns`）：

| `level` | 含义 |
| --- | --- |
| `problem` | 照这样做会出错：和现有代码的事实冲突、漏了一种情况、数据会坏 |
| `risk` | 可能出问题，要验证或要有回退：发布顺序、兼容、性能、依赖别的团队 |
| `improve` | 有更简单或更统一的做法，说清是什么、省了什么 |
| `question` | 文档没写清、要问作者的 |

每条带位置（文件:行、文档里的哪一节）和依据（`src:`、`mem:`、提交）。意见有状态 `open` / `resolved` / `dropped`：文档更新后重新评估时，上一版的每条意见要给出现在的状态；本人也可以在页面上标掉。

评估别人的方案时 `designer` 要做的是：先不带评价地提取“作者决定了什么”，再回到代码核对每个决定依赖的事实，最后才写意见；整份方案漏掉的部分（没有说旧数据怎么办、没有说回滚）写在整体意见里。不替作者改方案。

### 2.4 编码后

决定上多出三项：

- `changes`：落在哪些修改项、哪些提交、哪些文件（宿主汇总，不靠模型写）；别人的分支是拆分归属的文件。
- `after.deviation`：实际做法和方案不一样的地方和原因。没有偏差就是空。别人的分支由评审负责人对照方案写。
- `after.simpler`：做完以后看，有没有更简单或可以统一的做法没做；没有就写为什么没有。

小改动不走方案这一步，但编码结束时同样交一份 `derived` 的方案，通常只有一两个决定。所以“变更说明”对所有交办都有，“方案先行”只对值得的交办有。

没挂到任何决定上的改动单独列为“方案之外的改动”，这一组不为空本身就是要看的信号。

## 3. 自己的交办：什么时候先写方案

编码前检查（`business-analyst`）在简报里多答一项 `design: { needed, why }`。满足任一条就要：

- 要改现有的分工或接口（不只是在现有位置加逻辑）；
- 有两种以上说得通的做法，选哪种会影响别的模块；
- 任务原话里要求重构、收敛、统一。

另外：`delegate_code` 的 `design`（`auto` 默认 / `always` / `never`）；设置 `agents.design.mode`（同样三档，默认 `auto`）；仓库空间设置里可以设“总是先写方案”。本人说“不用方案，直接改”时助手传 `never`。交办时传 `design_id` 则直接以那份已有的方案为基线（比如先评估过别人的方案、现在由 omem 来实现）。

流程：

1. 编码前检查之后、编码之前，`designer` 在工作区里只读地调查，交 `submit_design`（状态 `review`）。
2. 发给本人确认：通过、对某个决定提意见（回到同一个会话改一版，版本号加一）、或“换个思路”（重写）。`agents.design.confirm` 为 `assistant` 时，没有待本人定的问题的方案由发起交办的助手确认（默认 `owner`）。等确认期间这一轮结束，不占并发槽。
3. 通过后（`approved`）是这次交办的基线：
   - 编码 Agent 的任务里带上方案；`plan_tasks` 每项填 `decision`；做不下去要换做法时用 `report_task` 说明，方案改一版，不能悄悄偏离；`finish_task` 可填 `deviation`、`simpler`。
   - 评审负责人和各评审项的材料里有决定列表。评审问题带 `decision`（对不上任何决定和需求点的归为“方案之外”，默认记成以后再做，由助手决定要不要管）。
   - 精简评审对照 `removes` 检查说要删的是不是真删了。
4. 没走方案的交办：编码 Agent 结束前交一份 `derived` 的方案（`submit_design`），没交不算失败，页面上显示“没有变更说明”。

## 4. 别人的方案和别人的分支

### 4.1 跟进别人的技术方案

本人把技术方案文档（飞书文档链接、已有的原件）交给助手，说“跟进一下这个方案”：

1. 助手确保文档已是原件（没有就 `import_url`），有事项就挂到事项上，然后 `assess_design`：`sources`（文档）、`repo_spaces`（方案要改的仓库，用来核对事实）、`author`、`note`（本人关心的点）、`item_id`。
2. `designer` 读文档和代码，交 `external` 的方案：提取的决定、每个决定的意见、整体意见（状态 `assessed`，不需要本人“通过”——那是别人的方案）。
3. 本人收到一条通知（几个决定、几条问题 / 风险 / 改进 / 要问作者的，链接到方案页）。助手可以把“要问作者的”和问题整理成一段话给本人；发给作者由本人决定（发消息、写文档评论仍走现有的草稿和批准，不新增以本人身份写的路径）。
4. 文档更新后：对同一份方案再 `assess_design`（传 `design_id`），版本号加一，上一版每条意见给出现在的状态。要自动的话用现有的文档变更规则触发助手，不另做一条流程。

### 4.2 综合评审别人的分支

`review_branch` 多一个 `design_id`（不传时取事项上最新的方案）：

- 有方案：评审开始时的拆分把分支改到的文件归到各个决定上（归不上的进“方案之外的改动”）；评审负责人和各评审项拿到决定和当时的意见。评审问题带 `decision`。负责人汇总时逐个决定写：做了没有、和方案的偏差（`after.deviation`）、方案评估时的每条意见现在是否还成立（更新意见状态）。
- 没有方案：拆分直接产出一份 `derived` 的方案（就是原来的变更拆分，多了种类和行为变化），之后一样按决定看。

结果在同一个方案页上：每个决定下面是方案怎么写的、代码怎么做的、偏差、意见和评审问题。这就是“综合”：方案评估和代码评审对着同一组决定。

## 5. 在哪里看

- **方案页**（`#/design/<id>`，组件 `DesignView`）：顶部是事实、整体行为表、不一致的地方和整体意见；下面左边需求点、右边决定卡片。卡片收起时每栏一句话，点开才显示约定片段和行为表；有意见的卡片标出各级数量；编码后多出改动、偏差、更简单的做法，“看 diff”只看这个决定的改动。版本可切换。
- **交办视图**（`CodeWork`）：标签改为 `[概览] [方案] [评审] [活动] [分支]`，“方案”就是这次交办或这次分支评审对应的方案页内容（取代“需求点”“变更”两个标签；没有方案的旧交办照旧显示）。
- **事项 / 需求页**：事项下列出它的方案（自己的、别人的）和状态，“跟进一份技术方案”从这里发起。
- **方案列表**（`#/designs`）：全部方案按更新时间排，可按来历和空间筛选；入口在运行页“编码”列表底部和命令面板，不进主菜单。
- **飞书**：自己的方案写好时发确认卡片（几个决定、要本人定的问题直接在卡片上选，链接到方案页）；别人的方案评估完发一条通知。交办结束的汇总按决定列。

卡片示意（自己的方案，等确认）：

```
┌ 需求点 ─────────────┐┌ 方案 · 等你确认 · 3 个决定，1 个要你定 ──────────────┐
│ ▸ 退款只算已发货行 ●││ D1 [修改] 退款金额在订单行上算，页面不再自己合计   │
│ ▸ 部分发货可退运费 ●││    行为  三个页面各算一遍 → 都调 computeRefund      │
│ ▸ 导出与页面一致   ●││    改在  order/refund.ts 一处                       │
│                     ││    影响  导出任务、对账报表                          │
│                     ││ D2 [新增] 运费按已发货行的金额比例退   ⚠ 要你定     │
│                     ││    ○ 按金额比例（建议） ○ 按件数比例                 │
│                     ││ D3 [删除] 页面里的两份合计（约 80 行）               │
│                     ││                       [通过] [提意见] [换个思路]     │
└─────────────────────┘└──────────────────────────────────────────────────────┘
```

别人的方案（评估后）和分支评审后：

```
│ 方案 · 小王《退款改造技术方案》· 第 2 版 · 4 个决定 · 问题 1 风险 2 改进 1 要问 3 │
│ D1 [修改] 退款金额改由订单服务计算                      ● 问题 1 · 要问 1    │
│    行为  （方案没写部分发货的情况）                                          │
│    问题  对账报表读的是落库前的金额，方案没有改它 (report/daily.ts:88)       │
│    要问  旧订单的退款记录要不要回填                                          │
│    ── 分支 feature/refund ──                                                 │
│    改动  6 个文件 +120 −40                                  [看 diff]        │
│    偏差  方案说在订单服务算，实际在网关里又算了一遍                          │
│    评审  2 个问题                                                            │
│ 方案之外的改动  3 个文件                                                     │
```

## 6. 数据与接口（实现的约定）

### 6.1 表

```sql
create table designs (
  id text primary key,                 -- dsg…
  space_id text not null,
  item_id text,
  title text not null,
  origin text not null,                -- own | external | derived
  author text,                         -- external：方案作者（显示名）
  sources text not null default '[]',  -- 方案或需求文档：src:<原件 id> 或链接
  repos text not null default '[]',    -- 仓库空间 id
  status text not null,                -- drafting | review | approved | assessed | recorded
  revision integer not null default 0, -- 0：还没交过
  body text not null default '{}',     -- 当前版本的 DesignBody
  feedback text not null default '[]', -- 本人对当前版本说的（提意见、换思路），重写的运行读它
  work_id text,                        -- 以它为基线的交办或分支评审的首个运行
  run_id text,                         -- 写出当前版本的运行
  user_id text,
  created_at text not null,
  updated_at text not null
);
create table design_revisions (
  design_id text not null, revision integer not null, body text not null,
  run_id text, note text not null default '', at text not null,
  primary key (design_id, revision)
);
```

状态：`drafting`（在写）→ `own`：`review`（等确认）→ `approved`；`external`：`assessed`；`derived`：`recorded`。

### 6.2 类型（`src/designs/types.ts`）

```ts
type DecisionKind = "add" | "change" | "remove" | "refactor";
type Table = { head: string[]; rows: string[][] };
type Field = { brief: string; text?: string; code?: string; lang?: string; table?: Table };
type ConcernLevel = "problem" | "risk" | "improve" | "question";
type Concern = { id: string; level: ConcernLevel; text: string; where?: string[]; refs?: string[];
                 state: "open" | "resolved" | "dropped"; note?: string; by?: string };
type Decision = {
  id: string;                       // D1、D2…，一份方案里各版本保持不变
  kind: DecisionKind;
  title: string;
  reqs: string[];
  fields: Record<string, Field>;    // 键见 2.1
  rejected?: { text: string; why: string }[];
  question?: { text: string; options: string[]; recommended?: number; answer?: string };
  stated?: boolean;                 // external：false = 文档没写、推断出来的
  concerns?: Concern[];
  files?: string[];                 // 归到这个决定的文件（分支评审的拆分、derived），仓库id/路径
  tasks?: number[];                 // derived：编码 Agent 填的修改项序号
  after?: { deviation?: string; simpler?: string; done?: "yes" | "partly" | "no"; by?: string; at?: string };
};
type DesignBody = {
  facts: { text: string; refs?: string[] }[];
  matrix?: Table & { title?: string };
  gaps?: string[];
  decisions: Decision[];
  concerns?: Concern[];             // 整份方案的意见
  outside?: string[];               // 方案之外的改动（文件）
};
```

### 6.3 工具

| 工具 | 给谁 | 作用 |
| --- | --- | --- |
| `submit_design` | `designer`、编码 Agent（`derived`）、评审拆分（分支评审），放 `ROLE_TOOLS` | 交一版方案：写进本次运行绑定的方案（`input.designId`），版本号加一；按来历校验栏目 |
| `read_design` | 助手、编码、评审（`coding` 组） | 读方案的 Markdown（`design_id`，或 `run_id` / `item_id` 取对应的）；`revision` 可选 |
| `assess_design` | 助手（`coding` 组） | 跟进别人的技术方案（4.1），返回运行 id |
| `settle_design` | 助手（`coding` 组） | 转达本人对自己方案的确认 / 意见 / 换思路，或回答某个决定的问题；`agents.design.confirm=assistant` 时助手自己确认；也用来标意见的状态 |
| `delegate_code` | | 多 `design`、`design_id` |
| `review_branch` | | 多 `design_id` |
| `plan_tasks` / `finish_task` | 编码 Agent | 每项多 `decision`；多 `deviation`、`simpler` |
| `submit_review` | 评审 | 问题多 `decision` |
| `submit_brief` | `business-analyst` | 多 `design: { needed, why }` |

原来的 `submit_change_points` 由 `submit_design` 取代（旧运行的变更拆分照原样显示）。

### 6.4 HTTP

| 接口 | 说明 |
| --- | --- |
| `GET /api/designs?item=&space=&work=` | 列表：`id, title, origin, status, revision, author, itemId, workId, spaceId, updatedAt, counts: { decisions, questions, concerns: { problem, risk, improve, question } }`（只数 `open` 的意见） |
| `GET /api/designs/:id?revision=` | 详情：上面的字段 + `sources, repos, body, revisions: [{ revision, at, note, runId }], item: { id, title } \| null, reqs: [{ id, title, kind }], work: { rootId, title, branchReview } \| null, changes: [{ decision, tasks: [{ seq, title, state }], commits, files: [{ space, path, add, del }], findings: { open, total } }], outside: [{ space, path, add, del }]` |
| `POST /api/designs` | 从网页发起评估别人的方案：`{ title, sources, repos, itemId?, space?, author?, note? }` → `{ id, runId }` |
| `POST /api/designs/:id/decide` | 本人对自己的方案：`{ action: "approve" \| "comment" \| "rethink", text?, answers?: { [decisionId]: string } }` |
| `POST /api/designs/:id/concerns/:cid` | `{ state, note? }` |
| `GET /api/designs/:id/diff?decision=D1` | 这个决定的补丁（交办按修改项取，分支按归属的文件取）；`decision=outside` 取方案之外的 |
| `GET /api/code-works/:id`（已有） | 多 `design: { id, origin, status, revision, counts } \| null` |

都按空间限定可见范围（`scopeFor` / `accessibleSpaces`）。

### 6.5 角色与设置

- 新角色 `designer`（`roles/designer.md`，`roleNames` 同步）：只读工具 + `submit_design`。两段说明：自己写方案、评估别人的方案。它用哪个模型在 Agent 页给这个角色选，建议最强的；照方案实现的编码 Agent 可以用便宜的。
- `roles/coder.md`、`review-lead.md`、`reviewer.md`、`review-simplify.md`、`business-analyst.md`、`assistant.md` 各加几句。
- 设置 `agents.design`：`mode`（`auto` / `always` / `never`）、`confirm`（`owner` / `assistant`）。

## 7. 不做的

- 不让宿主判断“这算不算偏离方案”：偏差由编码 Agent 自己报，评审负责人核对。
- 不强制每个交办都写方案；不把方案做成长文档，一个决定超过一屏说明拆得不对。
- 不替别人改方案，也不自动把意见发给作者。
- VS Code 插件的“决定 → 文件”树这一期不做。
- 按新增行的“禁止的写法”检查不在这里：仓库空间设置里一组正则，宿主只对这一轮新增的行匹配，命中算检查没过，另做。

## 8. 本人定的

2026-11-11：开始实现；要通用到别人的方案和别人的分支。设计稿里留的四个问题按建议取默认：要“决定”这一层；方案默认本人确认（可设为没有待定问题时由助手确认）；小改动的变更说明只在交办视图和结束汇总里，不单独发卡片；编码前后两部分一起做。
