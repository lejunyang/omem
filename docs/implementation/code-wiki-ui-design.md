# Code Wiki 通用纵向切片 — Vue 3 交互与组件规格

状态：设计稿 v1，2026-09-28。本文件**只定义界面与组件合同**，不改生产代码。后端 API 与 SQLite schema 缺口在对应章节标注，不在本次切片内实现。

标记约定：

- **[当前]** = 仓库 HEAD（`46d808a`）已经存在的行为，引用 `apps/web/src/ReviewApp.vue` / `packages/ui` / `apps/server/src/review/*` 实际代码。
- **[拟实现]** = 本切片要落地的交互/组件；标注需要的后端或依赖缺口。
- **[后续]** = 不在本切片，记录方向。

视觉 token、三栏骨架、黑白灰证据阅读风格以根 `design.md` 与 `packages/ui/src/tokens.css` 为准；本文不重复 token 值，只在需要新增时显式说明。

---

## 1. 现状信息架构与组件缺口

### 1.1 [当前] ReviewApp 实际信息架构

`ReviewApp.vue` 是一个 730 行单文件，内部 `view: "browse" | "read" | "search" | "trace" | "sync"` 五态，全部用 `ref` 串起来，没有路由、没有 URL 深链：

| 视图 | 入口 | 数据 | 交互 |
| --- | --- | --- | --- |
| browse | 侧栏分类按钮 | `GET /sources?category=` | 点击 OmPanel → `openRevision` |
| read | browse 行 / 搜索结果 / trace 行 | `GET /revisions/:id` + `GET /sources/:id/versions` + `GET /fragments/:id/relations` + 关键词 search | 点击「片段详情与追溯」在页面底部内联展开一个 OmPanel；切历史版本 `<select>` |
| search | 顶栏输入回车 | `GET /search?q=` | 结果行点击 → 反查 fragment → openRevision |
| trace | 侧栏「代码追溯」+ 路径输入框 | `GET /code?path=` + `GET /code-relations?path=` + 两次关键词 search | 四格 OmPanel 竖排：代码 / 登记链路 / 决策候选 / 调研候选 |
| sync | 侧栏「同步状态」 | `GET /sync/status` + `POST /sync` | 立即同步按钮 |

关系数据形状（`review-api.ts` `ReviewRelation`）：

- `relationType` 已在服务端反演（`implements` → `implemented_by`）。
- `relationStatus` 是**有效状态**（服务端已把「对方非 head / 已删除」压成 `stale`），UI 不二次判断。
- `other` 为 `null` 表示未解析（missing seed）。

### 1.2 [当前] 已复用的 `@omem/ui` 组件

`packages/ui/src` 实际导出 8 个组件：`OmButton / OmIcon / OmBadge / OmPanel / OmEmpty / OmDialog / OmCitation / OmShell`。ReviewApp 只用了前 6 个；`OmDialog` 和 `OmCitation` 在 review 模式下**未被使用**。

- `OmDialog` 已经是原生 `<dialog>` + `showModal()` + 焦点陷阱 + `Esc` emit `back` + 关闭恢复触发焦点，宽度 `min(960px, 100vw-64px)`，≤700px 全屏。**这是受控 trail 浮层的现成基座**。
- `EvidenceReader.vue`（个人助理模式）已经实现了一个**帧栈**：`frames: {e, tab, ask, scroll}[]`，push/pop、面包屑、环检测（`findIndex` → `loop` 跳回）、每层滚动位置记忆。这是 trail 交互的参考实现，但它在 apps/web 业务侧，没下沉到 packages/ui。

### 1.3 缺口清单（本切片要补的）

| # | 缺口 | 现状 | 影响 |
| --- | --- | --- | --- |
| G1 | 无仓库/快照总览首页 | browse 直接进分类列表，没有「这个仓库现在是什么状态」的入口 | 用户不知道同步到哪个 commit、多少 confirmed 边 |
| G2 | 无模块/架构图 | trace 页是 4 个竖排 OmPanel，没有代码→意图→决策→测试的图形 | 跨文件关系只能靠逐个点 |
| G3 | 无源码查看器 | 代码 fragment 直接 `<pre class="frag-text">` 纯文本，无行号、无高亮、无 range anchor | 无法跳到具体函数行 |
| G4 | 受控 trail 未用 | ReviewApp 的「下探」是**替换主视图**（`view.value = "read"`），不是浮层栈；没有返回上一层、没有面包屑、环检测只在 EvidenceReader 里 | 用户从决策点回代码后，背景材料丢失，浏览器后退键无效 |
| G5 | 无 URL 深链 | view/selectedRevisionId/selectedFragmentId 全是内存 ref，刷新丢 | 无法把「这个类→那个决策」粘给同事/书签 |
| G6 | Markdown 裸渲染 | decisions/research 文档的 fragment 直接 `<pre>`，没走 Markdown | 文档里的列表/链接/代码块不可读 |
| G7 | 无安全代码高亮 | 同 G3 | TS/Vue 语法不可读 |
| G8 | raw/derived/candidate/stale/error 视觉不统一 | statusTone 只覆盖 confirmed/candidate/missing/stale；raw（原始采集）vs derived（派生解释）没有视觉区分；error 只有顶部红色 banner | 用户分不清「这是原文」「这是模型/规则派生」「这是猜测」 |
| G9 | 空模型降级没在 review 模式体现 | 当前顶栏 badge 写死「本地只读浏览 · 无模型依赖」，但没有「将来接模型时哪些区域会消失/降级」的占位 | 后续接模型会改布局 |
| G10 | packages/ui 缺 trail 栈、源码查看器、Markdown 渲染器、状态徽章族 | 业务组件散在 apps/web | 第二处用到同样交互时会重写 |
| G11 | 无响应式/移动端验收脚本 | OmShell 有 1100/700 断点，但 ReviewApp 自己的 `.sync-grid` 是 5 列定宽，移动端会溢出 | 390px 下未验证 |
| G12 | 反向从规则/决策到源码的路径没显式化 | relations API 支持 `implemented_by` 反查，UI 只是平铺在「实现意图与关联」里，没有「这条决策影响哪些代码文件」的视图 | 从决策读代码要靠关键词 search 猜 |

---

## 2. 仓库 / 快照总览（新首页）

**[拟实现]** 在导航里加一项「仓库总览」（`view === "overview"`），作为启动落地页（替代当前直接 loadSources）。

### 2.1 内容

复用 `GET /api/review/health` + `GET /categories` + `GET /associations`（已存在，前端目前没调）。

| 区块 | 数据 | 组件 |
| --- | --- | --- |
| 快照行 | `health.lastSyncCommit`（短 hash）、`health.sourceCount / fragmentCount`、`associations.seedCount`、`associations.{confirmed,candidate,missing}` | 一行 OmBadge 组：`commit a1b2c3d` · `127 源 / 4053 片段` · `77 confirmed / 3 candidate / 2 missing` |
| 分类矩阵 | `GET /categories` 4 行（architecture/progress/decisions/research） | OmPanel 卡片，每张显示 `name`、`sourceCount`、`fragmentCount`，点击进 browse |
| 关系健康 | `associations.byType`（implements/requires/decided_by/researched_by/tested_by 各多少条） | 一个横向条带，每类型一段色条（中性灰，不用品牌色），数字标在段内 |
| 同步按钮 | `POST /sync` | 复用现有 sync 面板的「立即同步」按钮，busy 态用 `OmButton :loading` |

### 2.2 空态

- 从未同步过：`health.lastSyncCommit == null` → `OmEmpty` 标题「还没有任何材料快照」，描述「先执行一次同步，扫描本仓库源码与 docs」，主按钮「立即同步」。**不**用演示数据填充。
- 同步过但 `confirmed=0`：OmEmpty「已同步但还没有登记关系」，描述指向 `docs/repo-review/associations.json`。

---

## 3. 确定性模块架构图

### 3.1 技术选型：手写 SVG，不用 Mermaid / ECharts force / Canvas

**[拟实现]** 选 SVG（DOM 节点，手写分层布局）。理由：

1. **确定性**。Mermaid 与 ECharts `graph` 的 force layout 每次渲染位置都漂，刷新后节点跑到别处，违反 design.md「初始静态可读、不依赖 hover」。本切片的关系图是**有方向的分类层**（代码 → 意图 → 决策/调研/测试），不是自由拓扑，不需要力导。
2. **数据规模小**。当前 23 seeds → 77 confirmed 边，未来 200 节点以内手排完全够；真到 1k 节点再考虑 DAG 布局库。
3. **可访问性**。SVG 节点是 DOM，能 `tabindex=0`、能 `aria-label`、能键盘 Enter 下探；Canvas 做不到。
4. **与 tokens.css 一致**。描边/填充直接用 `--om-line / --om-ink / --om-soft`，不引入第二套配色。
5. **非 Mermaid**：Mermaid 在浏览器端运行时把 markdown 编译成 SVG，包体积大、样式不可控、主题无法对齐黑白灰；且本切片数据来自 API 而非手写 markdown。

**[后续]** 若节点数 > 300 或需要子图折叠，再评估 `d3-dag`（ layered 布局、确定性）或 ECharts `graph` 的 `layout: 'none'` + 外部算坐标——**保留 force 为禁用项**。

### 3.2 布局合同

固定四列泳道，从左到右：

```
┌──────────────┐  ┌──────────────┐  ┌─────────────────────────┐  ┌──────────────┐
│  代码文件     │→│  意图片段    │→│  决策 / 调研 / 测试      │  │  (反向回链)  │
│  (architecture)│ │  (implements)│ │  (decided_by/researched_│  │ implemented_ │
│              │  │              │  │   by/tested_by)         │  │ by 虚线回指  │
└──────────────┘  └──────────────┘  └─────────────────────────┘  └──────────────┘
```

- 节点 = fragment（code fragment 或 doc fragment），节点文本 = `other.title` 或 symbol 名。
- 边 = `ReviewRelation`：实线 = `confirmed`，虚线 = `candidate`，灰+斜纹 = `stale`，缺失（`other==null`）画成断头线 + 「缺失」标签。
- 节点按 relationStatus 填色：confirmed `--om-panel` + 1px ink 边；candidate `#f6f2e8` + warning 边；missing `--om-soft` + muted 边；stale 加 `opacity:.5`。
- 点击节点 → 触发 trail push（见 §6）。
- 点击边 → 在右侧 detail 抽屉显示该 edge 的 `evidence` 字段（手维护 seed 的说明文字）。
- **降级**：SVG 渲染失败或 `relations` 为空 → 直接渲染分组列表（当前 trace 页的 4 格 OmPanel 竖排），不白屏。

### 3.3 交互

- 初始视图：**当前选中文件**（从 trace 或源码查看器进入时，以该文件为根）的两跳邻域（code → intent → docs）。
- 双击空白或「展开全部」才显示整个仓库图；默认不一次性画 77 条边。
- 缩放：用 CSS `transform: scale()` + 滚轮监听，不用第三方 pan/zoom 库；移动端捏合手势禁用，改用「当前节点的邻域」列表。
- 键盘：Tab 在节点间移动，Enter push trail，Esc pop。

---

## 4. 模块 / 功能详情（derived 解释 + 状态 + 证据）

**[拟实现]** 把当前 read 视图里底部那个「片段详情」OmPanel 拆成一个独立详情区，三类信息分层展示：

### 4.1 三层内容，视觉上必须能区分

| 层 | 来源 | 视觉 |
| --- | --- | --- |
| **raw（原始证据）** | `fragment.text` 原文，不可变 | 现有 `<pre class="frag-text">`，等宽字体、`--om-paper` 底、1px line 边。前缀一行小标签 `原始片段 · 不可变`。 |
| **derived（派生解释）** | 本切片里**只有**两种派生：(a) 服务端从 seed 带出来的 `intent` 一句话；(b) 未来模型摘要。本切片**不接模型**，所以 derived 只展示 seed 里的 `intent` 字段。 | 衬线字体 `--om-serif`、左 3px `--om-ink` 竖线、灰底 `--om-soft`。前缀标签 `派生说明 · 来自 associations.json`。**明确标注不是原文**。 |
| **candidate（候选/猜测）** | 关键词 search 捞到的 decisions/research（当前 trace 页的 ③④ 格） | OmBadge `tone="warning"`「候选」+ 斜体；点击才加载 snippet，默认折叠。 |

### 4.2 状态徽章（统一复用 OmBadge tone）

把 ReviewApp 里散落的 `statusTone / statusLabel` 保留，但补全到 5 态：

| relationStatus | tone | 文案 |
| --- | --- | --- |
| confirmed | success | 已关联 |
| candidate | warning | 候选 |
| missing | neutral | 缺失 |
| stale | neutral + 删除线 | 已过期 |
| error（加载失败） | danger | 加载失败 |

**新增**：raw vs derived vs candidate 不是 relationStatus，是**内容层**，用前缀标签而不是 badge，避免和边状态混淆。

### 4.3 证据行

每条边下面显示 `relation.evidence`（seed 里的那句人写说明），样式 `small.om-muted`，换行块。`other == null` 时显示「缺失：{evidence}」，不要假装跳到一个不存在的东西。

---

## 5. 源码查看器

### 5.1 [当前] 现状

代码 fragment 就是 `revision.fragments[].text` 数组，按段落切，**没有行号、没有 range、没有 symbol 锚点**。当前 read 视图用 `<pre class="frag-text">{{ f.text }}</pre>` 平铺。

### 5.2 [拟实现] 组件合同 `OmCodeViewer`（新通用组件，下沉 packages/ui）

Props：

```ts
{
  code: string;                 // 整个文件原文（或 fragment 文本）
  language?: string;             // 'ts' | 'vue' | 'md' | 'json' | 'bash' | ...
  highlightLines?: number[];    // 要高亮的行号
  anchorLine?: number;          // 初始滚动到这一行
  ranges?: { start: number; end: number; fragmentId: string }[]; // fragment → 行映射
  onNavigate?: (target: { filePath: string; symbol?: string; line?: number }) => void;
}
```

Slots：`#line-gutter-extra`（在行号槽右边注入跳转按钮）。

#### 5.2.1 行号与 range anchor

- 左侧固定宽度 gutter（`ch` 单位，最多 6 位行号），每行一个 `<span class="ln" data-line="N">`。
- `anchorLine` → mounted 后 `scrollIntoView({block:'center'})`，该行加背景 `--om-soft` 持续 3 秒后淡出（尊重 `prefers-reduced-motion`）。
- **[后端缺口]** fragment 当前不带 `startLine/endLine`。本切片的过渡方案：客户端按 `\n` split 全文累计行号，与 `fragment.ordinal` 对齐（sync 当前按段落切，ordinal 顺序即文件顺序），在 range 标签上小字标「行号为按段落顺序推算」。**[后续]** sync 阶段真正记录行范围，去掉这个标注。

#### 5.2.2 安全代码高亮

- **库候选**（按需 `import()`，不打进首屏 bundle）：
  1. **highlight.js**（首选）：`import('highlight.js/lib/core')` 后按 language 动态 `registerLanguage`。体积可控（core ~40KB，单语言 ~2-10KB），浏览器端成熟，CSP 友好。
  2. shiki（备选）：语法更准但默认打包整个 TextMate 主题很重，需要 `createHighlighter` + 显式 langs，首屏代价大。
- **禁用**：`<pre v-html="highlighted">` 直出。改为：highlight.js 返回 HTML 字符串后，**过一遍 DOMPurify**（见 §8），白名单只允许 `<span class="hljs-*">` 和空白文本节点；不允许任何属性除 `class`。
- 主题：不自带 hljs 主题，自己写 ~30 行 CSS，把 `hljs-keyword/string/comment/function/number` 映射到 tokens.css 的灰度阶（不引入彩色）：keyword `--om-ink` 粗体、string `--om-secondary`、comment `--om-muted`、function 下划线、number 同 secondary。**保持黑白灰**。
- 语言检测：从 `context.filePath` 后缀推（`.ts/.vue/.md/.json/.sh`），不靠 hljs auto-detect（auto-detect 在大文件上慢且误判）。

#### 5.2.3 边导航（symbol / import / call / test / route / component）

**[当前]** API 只有 fragment 级关系，没有 symbol 级边。

**[拟实现] 本切片能做的（纯前端、不依赖后端新边）**：

- 把当前文件里的标识符做成**可点击词**：鼠标 hover 一个 `<span class="sym">foo</span>` 时，用 `foo` 去当前文件已加载的 `relations` 列表里查 `other.title` / `other.filePath` 是否命中（包括 path basename）。命中 → 点击触发 `onNavigate({filePath: other.filePath, symbol: foo})`，push trail。
- import 语句（`import ... from "..."`）用正则抽出路径字符串，点击直接 `GET /code?path=<resolved>`；解析失败（包名）→ OmEmpty 提示「外部包不在本仓库快照内」。
- 测试边：`testRefs` 在 associations.json 里是 `path::test-name` 字符串，sync 后会变成 `tested_by` 边；在源码查看器里，函数名旁的 gutter 图标（小 `check`）= 该函数有 confirmed tested_by 边；点击跳测试 fragment。

**[后续]** 真正的 symbol 级边（精确到 `AssistantRuntime.turn` 的调用点）需要 sync 阶段做 TS 解析器（ts-morph），本切片不做。本切片的「符号点击」是**关键词兜底**，必须在 UI 上标「按名称匹配，非精确调用点」。

---

## 6. 受控 trail：单浮层无限下探

这是本切片的核心交互。目标：从任意节点（源码行 / 决策段落 / 测试用例 / 需求 ID）点进去，能一路下探 5+ 层，能逐级返回，能刷新恢复，能环检测，焦点不丢。

### 6.1 [当前] 做法与问题

- 当前 ReviewApp：点 relation → `openRevision(other.revisionId, other.fragmentId)` 直接**替换主视图**，原页面状态丢；浏览器后退键不改 view；刷新后回到 browse。
- EvidenceReader 已经做对了一半：frames 栈、环检测、面包屑、滚动恢复，但它是 `<dialog>`，**不能在 trail 里同时看到背景代码**（dialog backdrop 挡住了）。

### 6.2 [拟实现] 单浮层 trail（drawer，不是 dialog）

**为什么 drawer 而不是复用 OmDialog**：OmDialog 是 `showModal()`，带 backdrop 遮罩 + 焦点陷阱，背景内容完全不可见。代码 Wiki 的下探需要**背景源码保持可见**（用户在看 `runtime.ts` 里 `governCreateTask`，点「G08 任务治理」下探，应该还能看到背景代码在等他回来）。所以本切片用**右侧 drawer**，不是 modal。

**[新增通用组件] `OmTrailDrawer`（packages/ui）**：

- 一个右侧固定宽抽屉（≤1100px 时宽 `min(560px, 100vw)`，≥1100px 时 `560px`），从右滑入，不锁背景滚动（背景可滚动但点击穿透被阻止）。
- 内部维护 `frames: TrailFrame[]`。
- 每个 `TrailFrame = { kind: 'fragment'|'code'|'decision'|'test'|'search', id, title, scroll, tab? }`。
- **单浮层**：无论下探多少层，DOM 里只有一个 drawer；当前帧用 `v-if="i===current"` 渲染，prev/next 帧销毁（保留 `scroll` 数字在 frame 对象上）。
- **返回**：
  - 抽屉顶部「← 返回」按钮（OmIcon `back`）→ `pop()`。
  - Esc 键 → `pop()`；pop 到空 → 关闭 drawer。
  - 面包屑：顶部一行 `1 / 2 / 3 / 4 / 5` 按钮，点第 i 个 = `frames = frames.slice(0, i+1)`。
- **环检测**：push 前 `findIndex(f => f.id === newId)`；命中 → 不 push，在抽屉顶部显示一条 warning notice：「你已经在第 N 层看过这条材料，跳回该层 / 继续留在当前层」两个按钮（直接抄 EvidenceReader.vue:87-94 的逻辑）。
- **焦点恢复**：打开 drawer 时记录 `document.activeElement`；关闭时 `previous.focus()`（抄 OmDialog.vue:14-27）。每层切换时焦点落在抽屉内标题上。
- **滚动恢复**：push 前把当前 `.om-trail-scroll` 的 `scrollTop` 写进 `frames[depth-1].scroll`；pop 后 nextTick 恢复。

### 6.3 URL 深链与刷新恢复

**[拟实现]** 不引入 vue-router（当前 apps/web 没装路由），用 `location.hash`：

```
#/overview
#/browse/<category>
#/read/<revisionId>?frag=<fragmentId>
#/code/<filePath>?line=<n>
#/trail/<frameKind>/<frameId>/<frameKind>/<frameId>/...
```

- trail 路径 = URL hash 末尾的斜杠段数组；boot 时解析 hash → 重建 frames → 顺序 await 拉数据。
- 最多保留 8 段（再深就 pushState 截断根段），防止 URL 过长。
- 刷新：boot 先 fetch `/api/review/health` 确认 review mode，再读 hash 恢复；hash 损坏/数据 404 → 降级到 overview，不白屏。
- 浏览器后退：`popstate` 事件 → 同步 frames.pop()。
- **本切片不做**：把 hash 同步到服务端、跨设备深链（单用户本地工具，无此需求）。

### 6.4 与 OmDialog 的边界

- 「就这段追问」「添加新关系」这类需要模态焦点的动作**仍然用 OmDialog**（模态），不塞进 trail。
- trail 是导航/阅读栈；dialog 是临时任务。两者不嵌套（trail 里弹 dialog 时，dialog backdrop 罩在 drawer 上，符合 `<dialog>` 原生层叠）。

---

## 7. 从规则 / 决策反向到源码

### 7.1 [当前]

- relations API 已经反演：从 decision fragment 查 relations，看到的 `relationType` 是 `implemented_by` / `tested_for` / `required_by`。
- 当前 UI 在 fragment 详情里只是平铺分组，没有专门的「这条决策影响哪些代码」视图。

### 7.2 [拟实现]

在详情面板加一个 tab「反向到代码」（与当前的「正向关联」并列）：

- 只列出 `relationType` 属于 `implemented_by / required_by / tested_for` 的边。
- 每行直接显示 `other.filePath`（等宽字体）+ `other.title` + status badge。
- 点击 → trail push 到那个 code fragment，并且**自动定位到该 fragment 的行范围**（§5.2.1）。
- 空态：OmEmpty「这条决策还没有登记到任何代码实现——可在 associations.json 补充」。

这样 §3 的架构图从右往左（虚线回指）和这条 tab 是同一份数据，两个入口。

---

## 8. Markdown 与代码高亮的安全配置

### 8.1 Markdown 渲染（决策/调研文档用）

**[拟实现]** 新通用组件 `OmMarkdown`（packages/ui）。

- **库候选**：
  1. **marked**（首选）：同步 lexer/parser，体积小（~30KB），插件生态稳。
  2. markdown-it（备选）：可配置性更强但 API 更重。
- **安全配置（强制）**：
  - marked 输出 HTML 后**必须**过 DOMPurify：`DOMPurify.sanitize(html, { ALLOWED_TAGS: ['p','ul','ol','li','h1'..'h6','code','pre','a','strong','em','blockquote','table','thead','tbody','tr','th','td','hr','br'], ALLOWED_ATTR: ['href'] })`。
  - **禁用**：`ALLOWED_TAGS` 不含 `script/iframe/img/form/input/svg/style`；`ALLOWED_URI_REGEXP` 只允许 `https?:` 和相对路径，`javascript:` 一律剥掉。
  - `target="_blank" rel="noopener noreferrer"` 由 DOMPurify `ADD_ATTR: ['target','rel']` 之后手动补，或在 renderer 里对 `a` 加。
  - **不**用 `v-html` 直绑模型/采集回包。associations.json 里的 decisionRefs 指向的是仓库内 docs，渲染前仍过 DOMPurify（纵深防御，不假设内部 markdown 一定干净）。
- **代码块**：``` 围栏 → 抽出 language + code string → 交给 OmCodeViewer（§5）渲染，**不**交给 DOMPurify 的 HTML 通道。
- **路由**：md 里的相对路径链接（`./foo.md`）拦截为 SPA 内部导航（push hash），不跳 `<a href>` 原生行为。

### 8.2 按需加载

- `marked` 和 `dompurify` 都 `const md = await import('marked')` 动态导入，只在第一次打开 decision/research fragment 时加载。
- highlight.js 语言包同理：进 `.ts` 文件才 `import('highlight.js/lib/languages/typescript')`。
- 首屏（overview / browse）不加载任何 markdown/highlight 代码。

---

## 9. raw / derived / candidate / stale / error 视觉规范

| 状态 | 视觉 | 文案 |
| --- | --- | --- |
| **raw**（原文片段） | `<pre>` 等宽、`--om-paper` 底、`--om-line` 边；前缀小标签「原始证据」 | 不可变，版本号固定 |
| **derived**（seed intent 一句 / 未来模型摘要） | `--om-serif` 衬线、`--om-soft` 底、左 3px ink 竖条；前缀小标签「派生说明」 | 必须写出来源（`associations.json` / 模型名+时间） |
| **candidate**（关键词搜出、未登记） | OmBadge warning「候选」+ 斜体，默认折叠成一行 snippet，点开才展开 | 顶部一行小字「按名称匹配，未人工登记」 |
| **stale**（对方非 head / 源已删） | opacity 0.5 + 删除线标题 + OmBadge neutral「已过期」 | 「这条关联指向历史版本/已删除文件」 |
| **error**（fetch 失败 / 404） | 红色 banner `role="alert"`，文案含具体错误（网络/404/500），不写「出错了」 | 提供「重试」按钮，不空等 |

**禁止**：用纯颜色区分状态（色盲）；把 candidate 渲染得和 confirmed 一样绿；错误用 toast 一闪而过不留痕。

---

## 10. 空模型降级

**[当前]** review 模式顶栏 badge 写死「本地只读浏览 · 无模型依赖」，不调任何 ACP。

**[拟实现]** 把这个 badge 升级成诚实的状态行：

- 无模型时：badge 文字「只读浏览 · 未配置模型」，derived 区只显示 seed 里的人写 intent，**不**显示「AI 摘要」占位。
- 将来接模型（后续切片）：derived 区出现两段——「人工登记意图」（始终在）+「模型摘要（可重算）」；模型不可用时，第二段换成 OmEmpty「模型未连接，未生成摘要」，**不**用假摘要填充。
- 本切片不写任何模型调用代码。布局预留好 `.derived-model` 插槽即可。

---

## 11. packages/ui 复用 / 新增清单

### 11.1 直接复用（不改）

| 组件 | 用途 |
| --- | --- |
| `OmShell` | 三栏骨架，断点已带 |
| `OmButton` / `OmIcon` | 所有按钮、图标（back/close/menu/link/check/clock 都已在 paths 里） |
| `OmBadge` | 状态徽章族（tone 已够，不用新增 tone） |
| `OmPanel` | 概览卡片、关系分组卡 |
| `OmEmpty` | 所有空态 |
| `OmDialog` | 临时任务（添加关系/追问），不用于 trail |
| `OmCitation` | 内联引用 chip（从正文下探） |

### 11.2 需要新增的通用组件（下沉 packages/ui，不在 apps/web 业务侧堆）

| 组件 | 职责 | 关键 props/slots/emits |
| --- | --- | --- |
| `OmTrailDrawer.vue` | §6 受控 trail 栈 | props: `frames: TrailFrame[]`, `open: boolean`; emits: `close`, `pop`, `jump(i)`; slot default = 当前帧内容 |
| `OmCodeViewer.vue` | §5 源码查看器 | props: `code, language, anchorLine, highlightLines, ranges`; emits: `navigate({filePath, symbol, line})` |
| `OmMarkdown.vue` | §8 安全 Markdown | props: `source: string`; emits: `navigate-internal(path)`; 内部动态 import marked + dompurify |
| `OmStatusLine.vue` | §9 raw/derived/candidate 前缀标签 | props: `kind: 'raw'|'derived'|'candidate'|'stale'|'error'`, `sourceNote?: string` |
| `OmRelationGraph.vue` | §3 分层 SVG 图 | props: `nodes, edges, rootId`; emits: `selectNode(nodeId)`, `selectEdge(edgeId)` |
| `OmHashRoute.ts` | §6.3 hash 路由薄封装 | `parseHash() -> ViewState`, `writeHash(state)`; 不引入 vue-router |

### 11.3 不做的

- 不做新的配色（cat-badge 那组 architecture/progress/decisions/research 彩色是 ReviewApp scoped CSS，**[拟实现]** 改成 OmBadge + 中性底，分类用图标区分，不再加蓝/绿/橙/紫）。
- 不做 toast 系统（当前 ReviewApp 的 toast 是局部 ref，本切片保留即可，不抽成全局）。
- 不做虚拟滚动（fragment 数量 < 500，长列表后续再说）。

---

## 12. 响应式与无障碍

### 12.1 断点（沿用 design.md）

| 宽度 | 布局 |
| --- | --- |
| ≥1100px | OmShell 三栏常驻；trail drawer 560px 从右滑入，背景源码可见 |
| 701–1100px | 右栏变可开关侧栏；trail drawer 加宽到 `min(720px, 100vw-40px)` |
| ≤700px（含 390px） | trail drawer 全屏（100vw × 100dvh）；架构图隐藏，改成纵向分组列表（§3.2 降级）；源码查看器行号 gutter 收到 `2ch`，横向滚动由容器接管，不缩字号 |

`.sync-grid` 当前是 5 列定宽，390px 必溢出 → **[拟实现]** 改成 `grid-template-columns: repeat(auto-fit, minmax(80px, 1fr))`。

### 12.2 无障碍

- 所有可点击区域 ≥ 44×44px（OmButton 已满足；OmCitation 当前 `padding: 3px 6px` 偏小，内联引用按文本可达性处理，不要求 44px——design.md 已豁免）。
- trail drawer `role="dialog" aria-modal="false"`（因为背景不锁定），`aria-labelledby` 指向当前帧标题；面包屑 `aria-label="证据路径"`。
- 架构图 SVG：节点 `<g role="button" tabindex="0" aria-label="…">`，键盘 Enter/Space push；边用 `<title>` 说明。
- 异步加载 `aria-live="polite"` 挂在主内容区，让屏幕阅读器 announce「已加载 G08 决策」。
- 尊重 `prefers-reduced-motion`（tokens.css 已全局关 transition/duration，drawer 滑入动画也关）。
- 不依赖 hover 显示关键操作：行号 gutter 的「跳测试」图标在触屏上始终显示，不只 hover 才出。

---

## 13. 真实消费闭环验收脚本（手工浏览器点击）

> 这条脚本对应「[拟实现]」完成后的验收；当前 HEAD 跑不通，仅作为切片完成定义。在 `osdk run dev:review`（5180 API + 5181 Vite）下执行。

### 13.1 五层下探 + 返回（桌面 1440px）

1. 打开 `http://localhost:5181/`，自动落到 `#/overview`。看到快照行（commit hash / 127 源 / 77 confirmed）。
2. 点「架构与实现」分类 → 点 `apps/server/src/review/store.ts` 这条源 → 进入 `#/read/<revId>`。
3. 在源码查看器里找到 `relationsForFragment` 函数（行号 gutter 可见），点击它的 `decided_by` 边 → trail drawer push 第 2 层，显示 `docs/design.md` 的一段。
4. 在该段里点 `implemented_by` 反向边 → push 第 3 层，自动定位到 `store.ts` 里对应函数行（高亮 3 秒）。
5. 从那行点「tested_by」边 → push 第 4 层到 `review-relations.test.ts`。
6. 从测试名点「反向到代码」tab → push 第 5 层回到 `store.ts`。
7. 此时若再点同一个测试名 → **不** push 第 6 层，抽屉顶部出 warning「你已经在第 4 层看过此材料」。
8. 按 Esc 一次 → 回到第 4 层；按面包屑「2」→ 直接跳到第 2 层；按 Esc 到底 → 抽屉关闭，焦点回到第 1 层源码查看器里触发点。

### 13.2 深链刷新

- 完成 13.1 到第 3 层后，复制地址栏 URL（形如 `#/read/xxx/trail/fragment/yyy/code/apps%2Fserver%2Fsrc%2Freview%2Fstore.ts/...`）。
- 新标签页粘贴打开 → 应该直接恢复到第 3 层，背景显示 `store.ts`，trail 打开。
- 故意改坏 URL（把最后一段换成不存在的 fragment id）→ 降级到 overview + 顶部 error banner，不白屏。

### 13.3 移动端 390px

- DevTools 切 390×844，重复 13.1 步骤 1-5：trail drawer 全屏，背景不可见但状态保留；架构图位置变成纵向分组列表；无横向滚动；行号 gutter 收窄。
- 所有按钮 ≥ 44px；Tab 键顺序：顶栏 → 侧栏汉堡 → 主内容 → 抽屉关闭按钮。

### 13.4 空态与错误

- 从未同步的 fresh clone 启动 → overview 显示「还没有任何材料快照」+ 立即同步按钮，不出现空白面板。
- 手动停掉 5180 API → 任何页面出现红色 banner「无法连接 /api/review/health」，带重试按钮。
- 打开一个 `candidate` 状态的边 → 显示 warning badge + 「按名称匹配，未人工登记」，不显示成 confirmed 绿。

---

## 14. 本切片边界（不做什么）

- 不改后端 API（不新增 symbol 级边、不补 fragment 行号字段）；这些缺口在 §5.2.1 / §5.2.3 标注为过渡方案。
- 不接模型、不接 ACP、不做 AI 摘要；derived 区只展示 seed 里的人写 intent。
- 不引入 vue-router、ECharts、Mermaid、D3；用 hash 字符串 + 手写 SVG。
- 不动个人助理模式（App.vue / EvidenceReader.vue / ChatPane.vue）；本切片只扩展 ReviewApp 与 packages/ui。
- 不写生产代码——本文件本身就是交付物。

---

## 15. 验证与剩余限制

- **已对照**：`packages/ui/src/*` 8 个组件全部读过 props/slots；`ReviewApp.vue` 730 行、`review-api.ts` 全量、`apps/server/src/review/app.ts` 全量、`store.ts` 关系模型、`associations.json` 23 条 seed、`EvidenceReader.vue` 帧栈参考实现、根 `design.md`、`omem-design` SKILL。
- **未验证**（本设计稿阶段无法跑）：
  - highlight.js / marked / dompurify 的真实包体积与按需加载分包大小——实现切片时用 `vite build --report` 量。
  - 77 条边的手写 SVG 在 1440px 下是否需要折叠子图——首版画两跳邻域，不一次全画。
  - hash 路由在浏览器后退/前进组合下的状态一致性——实现时补一个 vitest 用例跑 parseHash/writeHash 往返。
- **测试要求**（实现切片时）：`osdk run check` exit 0；`apps/server/tests/review-dev.test.ts` 现有 2 例不回归；新增 `apps/web/tests/trail-drawer.test.ts` 覆盖 push/pop/loop/backdrop 焦点。浏览器手测按 §13 三步。
