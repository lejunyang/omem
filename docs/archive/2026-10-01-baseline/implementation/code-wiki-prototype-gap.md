# Code Wiki 原型视觉/交互 P0 差异审计

状态：审计草案，2026-09-29。只读对照 `docs/prototype/` 离线 React 原型与当前 `apps/web` 实现；不改生产 UI、不 commit。
证据分级：**[P]** = 原型文件事实（`docs/prototype/**`，行号为原型源文件）；**[C]** = 当前实现事实（`apps/web`、`packages/ui`）；**[S]** = 本次对运行中 5181 服务的截图证据（不重启服务），存于 `docs/implementation/screenshots/codewiki-*.png`。

## 0. 定位：Code 是 typed projection，不是平行产品

Code Wiki 不是第二套知识库。它是同一 omem 证据模型在代码域上的类型化投影，与 EvidenceReader 共用同一套「固定 FragmentRevision 递归下钻」交互合同：

| omem 证据模型 | Code 投影 | 当前承载 |
| --- | --- | --- |
| Capture Source | 一个仓库 / 一次代码采集源 | `CodeSnapshot.repoId`（`review-api.ts:262-272`） |
| Revision | 一次 commit 快照（`commit` + `dirty` + `parserVersion`） | `CodeSnapshot.commit/dirty/parserVersion` |
| Fragment | 解析出的文件 / 符号范围 / 文档片段 | `CodeFile`、`CodeSymbol`、review fragment |
| Relation | `implements/requires/decided_by/researched_by/tested_by/candidate_for` 及其反方向 | `CodeEdge`（`edgeKind` + `status`）、`review_relations` |
| Retrieval | 模块聚合图、符号大纲、全文搜索 | `aggregateGraph`、`/api/review/search` |

`repo-review`（`.repo-review/`、`apps/server/src/review/`、`apps/web/src/ReviewApp.vue`）只是这套投影的**配置与视图层**：独立 SQLite、四类材料同步、`docs/repo-review/associations.json` 手工登记边。它不定义新的视觉语言，也不复制原型 CSS 建第二套组件（`.agents/skills/omem-design/SKILL.md` 末行；根 `design.md:54`）。本审计的所有偏差都指向「把 Code Wiki 的 trail 与 EvidenceReader 对齐到原型合同」，不是另起主题。

---

## 1. 原型事实清单（逐项带引用）

### 1.1 Token 与排版

- 色板近灰中性：`--ink #202020 / --secondary #606060 / --muted #858585 / --line #e6e6e6 / --paper #fafafa / --soft #f2f2f2`（`styles.css:1-11`）。无品牌色、无渐变。
- 字体：标题衬线 `"Noto Serif CJK SC","Songti SC","SimSun",Georgia,serif`；正文无衬线 Noto Sans CJK 族（`styles.css:8-10`）。
- 全局正文 14px、`line-height:1.85`（`styles.css:20,55`）；文章 `.prose` 用 `--reading-size` 变量（默认 14，tweak 面板 14–20px），行高 2.05（`styles.css:511-520`）。
- 文章 h1 衬线 32px / 行高 1.65（`styles.css:445-453`）；`.article` 最大宽 870px 居中（`styles.css:415-419`）。
- 焦点：`outline:2px solid #737373; outline-offset:3px`（`styles.css:39-46`）。
- 顶栏近黑 `#171717`，高 70px（`styles.css:83-92`）；左栏 258px `#f6f6f6`（`styles.css:198-206`）；右栏 322px 白底（`styles.css:677-684`）。

> 根 `design.md:10-15` 的 token 把 `--om-muted` 定为 `#737373`、`--om-line #dedede`，与原型有 `#858585/#e6e6e6` 的细微差异；`packages/ui/src/tokens.css:1-15` 已按根 design.md 落地。**实现以 packages/ui tokens.css 为准，不回填原型色值。**

### 1.2 三栏与断点

- 桌面三栏：左 258 / 中 `flex:1` / 右 322（`styles.css:198,677,408`）。
- ≥1600：左 274、右 350、h1 36（`styles.css:1630-1646`）。
- ≤1250：左 225、右 280（`styles.css:1647-1689`）。
- ≤1050：右栏隐藏，面包屑右端出现「追问」浮按钮；`.right-panel.mobile-open` 变为 fixed 340px 浮层（`styles.css:1690-1726`）。
- ≤700：顶栏 61px、左栏 off-canvas（`z-index:60`，255px）、引用弹窗全屏（见 1.4）；`.demo-label/.avatar/kbd` 隐藏（`styles.css:1752-1807`）。
- `prefers-reduced-motion` 全量关动画（`styles.css:2035-2041`）。

### 1.3 文章内引用卡（cite / reference-row）

- 正文内联引用是 `<button class="cite">`：浅灰底 `#ededed`、1px 灰下划线、圆角 3px 0，后接 `<sup>` 序号（`app.jsx:453-462`、`styles.css:540-561`）。**label 是人类可读短语**（如「回滚方案、负责人和验证结果必须到位」），不是技术 id。
- 文章底部「这篇知识的依据」：`.reference-row`，左 22px 序号方格 + `<b>标题</b>` + `<small>{kind} · {section} · {version}</small>` + 右箭头（`app.jsx:898-914`、`styles.css:611-660`）。
- 下钻弹窗内 `.next-refs .reference-row`：左 28px 图标格 + `<b>{人类 label}</b>` + `<small>{关系类型} · {version}</small>`，若目标已在当前路径追加「 · 已在当前路径」（`app.jsx:1514-1534`）。

### 1.4 递归引用弹窗（stack）

**这是 P0 的核心。** 原型用**单个原生 `<dialog>`**（`app.jsx:1290`），`showModal()` 打开（`app.jsx:388`），整棵路径栈共享一个焦点陷阱：

- 尺寸：`width:min(810px,100vw-80px)`、`height:min(800px,100dvh-105px)`；展开追问时 `.with-chat` 加宽到 `min(1130px,100vw-70px)`（`styles.css:1273-1292`）。
- backdrop：`#1717176b` + `backdrop-filter:blur(2px)`（`styles.css:1286-1289`）。
- 顶条 `.trace-top`：左「layers 证据路径」+ Chip「第 N 层」；右关闭按钮（`app.jsx:1304-1316`、`styles.css:1299-1321`）。
- 面包屑 `.trace-breadcrumb`：横向滚动、`{i+1} {标题}` 按钮、当前层 `aria-current="step"`，点任意祖先 = `jump(i)`（`app.jsx:1317-1330`、`styles.css:1322-1354`）。
- 父层预览 `.parent-peek`：「← 来自第 N-1 层 {父标题}」一条灰条，点击返回父层（`app.jsx:1331-1339`、`styles.css:1355-1374`）。
- 帧头：kicker（`{kind}` + 版本）+ `<h2 id="trace-title" tabindex="-1">` + section + meta 行（owner · date · 固定原文快照）（`app.jsx:1342-1360`）。
- Tabs `.trace-tabs`（`role="tablist"`）：**引用片段 / 上下文 / 谁引用了它 / 版本** 四个，反向引用带计数（`app.jsx:1361-1382`、`styles.css:1417-1442`）。
- 证据区：`.quote-label`「被引用的原文」→ 衬线 `.evidence-quote`（`#f0f0ef` 底）→ `.evidence-body` → `.next-refs`（1.3）→ `.evidence-note` 免责（`app.jsx:1484-1538`、`styles.css:1450-1488`）。
- 底栏 `.trace-footer`：左 ghost「← 返回上一层/返回阅读」，中「复制片段链接」图标按钮，右 primary「就这段追问/收起追问」（`app.jsx:1542-1564`、`styles.css:1489-1507`）。
- 原位追问：`.inline-chat` 320px 右栏在 dialog 内部展开（`app.jsx:1566-1578`、`styles.css:1508-1513`）。

### 1.5 back / close / focus / 滚动 / 草稿

- 打开时记录 `returnFocus = document.activeElement`（`app.jsx:418`）；frames 归零时 `dialog.close()` 并 `returnFocus.current.focus()`（`app.jsx:385-393`）。
- 切层：`modalBody.scrollTop = current.scroll`；焦点移到 `.trace-current-title`（`app.jsx:394-399`）。push 前把当前层 `scrollTop` 写回帧对象（`app.jsx:421-424`）。
- Esc（`onCancel`）退一层；背景遮罩点击 = `close()` 全关；右上 X = `close()`（`app.jsx:1294-1300,1309-1315`）。
- 每帧独立保存 `tab`、`ask`、`selection`（`app.jsx:404-407,518-519`）；草稿按 `focus + :local/:global` 线程 key 留存，收起再展开不丢（`smoke.mjs:120-126`）。
- 环检测：push 前 `findIndex` 命中 → `loop-notice`「这份材料已在路径第 N 层」+「返回已打开的那一层」，不压栈（`app.jsx:412-416,1384-1395`；`smoke.mjs:88-98`）。
- 深度不设上限：smoke 走 100 层合成链、breadcrumb 跳回第 1 层（`smoke.mjs:175-185`）。

### 1.6 诚实状态（missing / stale / restricted / superseded）

- 节点 status 枚举：`available / superseded / restricted / deleted / anchor_unresolved`（`data.js:9,116,128,139,150`）。
- 非 available/superseded → `.evidence-empty`：标题分别为「当前无权查看 / 原始内容已删除 / 原文位置尚待核对」，正文说明，唯一按钮「返回引用处」；「就这段追问」按钮 disabled（`app.jsx:1405-1422,1556-1559`；`smoke.mjs:186-199`）。
- `superseded` → `.state-banner`「正在查看历史版本 r6，现行版本是 r7」+「查看现行版本」（`app.jsx:1396-1404`）。
- 「版本」tab 并排 r6/r7 diff，各带「打开历史/现行版本」链接（`app.jsx:1447-1482`）。

### 1.7 移动端（≤700）

- dialog 全 `100vw×100dvh`、无圆角无边距（`styles.css:1909-1917`）。
- 带追问时 `.trace-content` 纵向堆叠：`.trace-reader` 高 53dvh、`.inline-chat` 高 60dvh；`.parent-peek`、`.trace-meta` 隐藏（`styles.css:1961-1998`）。
- 触控目标最小 40–44px：`.btn min-height:40px`、`.trace-top .icon-btn 38px`、`.trace-tabs button 42px`、`.reference-row min-height:58px`（`styles.css:2008-2020`）。
- 禁止横向滚动：smoke 在 390×844 断言 `document.scrollWidth <= innerWidth`（`smoke.mjs:247-251`）。

---

## 2. 当前偏差（逐项带证据）

### 2.1 [P0] 下钻容器用了右侧非模态 drawer，不是居中模态 dialog

- 原型：单 `<dialog showModal>`，backdrop + 焦点陷阱（§1.4）。
- 当前：`CodeWiki.vue:366-408` 用 `OmTrailDrawer`；该组件 `role="dialog" aria-modal="false"`、`position:fixed; right:0; width:min(560px,100vw)`，**不是** `<dialog>`、无 backdrop、无焦点陷阱（`packages/ui/src/components/OmTrailDrawer.vue:80-138`）。
- 截图：`screenshots/codewiki-04-drawer-file.png`——右 560px 白条压在背景模块页上，背景完全可见、无遮罩；`screenshots/codewiki-06-depth2-symbol.png`——第 2 层仍同位置。
- 冲突来源：`docs/implementation/code-wiki-ui-design.md:218-220` 当初决定「drawer 不是 dialog，因为要看背景代码」。但更新的根 `design.md:42`（「引用弹窗…一条引用对应固定 FragmentRevision」）与 `.agents/skills/omem-design/SKILL.md:11`（「递归引用仅使用一个 dialog」）已把合同锁回模态 dialog；`EvidenceReader.vue:67` 早已用 `OmDialog`。**Code Wiki 必须改回 OmDialog 合同，并修订 code-wiki-ui-design.md §6.2，而不是并行维护 drawer。**
- 注：根 `design.md:48` 要求「所有可点击区域至少 44×44」，`OmTrailDrawer` 的 `.crumb` chip 高约 28px（`OmTrailDrawer.vue:157-179`），不达标。

### 2.2 [P0] 栈深度被硬截到 8 层

- 原型：renderer 无深度上限，100 层合成链不崩（§1.5）。
- 当前：`packages/ui/src/trail.ts:35` `MAX_TRAIL = 8`；`CodeWiki.vue:165` `[...trail, frame].slice(-8)`；`OmHashRoute.ts:43,76` 两处 `slice(0,8)`；`trail.test.ts:21-26` 直接断言「最老帧被丢弃」。
- 影响：代码域下钻 module→file→symbol→file→symbol→fragment→file… 很容易超过 8 层，最旧的祖先会被静默吞掉，违反 design.md §9「100 层合成链无渲染崩溃」验收。
- 要求：移除栈截断；URL 深链可压缩/分页，但 UI 栈与面包屑必须如实显示真实层数。

### 2.3 [P0] 缺 trace-top 标签条、parent-peek、底栏、tabs

| 原型元素 | 原型位置 | 当前实现 |
| --- | --- | --- |
| 「证据路径 · 第 N 层」标签 + Chip | `app.jsx:1304-1316` | 无。`OmTrailDrawer.vue:83-101` 只有面包屑行 + 关闭 X |
| parent-peek「来自第 N-1 层 {标题}」 | `app.jsx:1331-1339` | 无。面包屑里的「返回」按钮在第 2 层才出现（`OmTrailDrawer.vue:85-88`），且无父标题 |
| 底栏：返回 / 复制链接 / 就这段追问 | `app.jsx:1542-1564` | 无 footer 槽（见 screenshots/codewiki-04-drawer-file.png、codewiki-06-depth2-symbol.png 底部空白）。无「复制片段链接」、无「就这段追问」 |
| 4 个 tabs（片段/上下文/反向/版本） | `app.jsx:1361-1382` | 无 tabs。FileFrame/SymbolFrame/FragmentFrame 各自堆叠区块（FileFrame.vue:229-266），不可切换 |
| 环提示「已在第 N 层」+ 跳回 | `app.jsx:1384-1395` | 有（`OmTrailDrawer.vue:103-109`），但文案是「你已经在第 N 层看过这条材料」+ 双按钮，与原型措辞不同；可保留 |
| superseded state-banner | `app.jsx:1396-1404` | 无 |
| restricted/deleted/unresolved 空态 | `app.jsx:1405-1422` | 无。`CodeFile.removed` 只渲染一个 danger badge（FileFrame.vue:193）；边的 `missing` 目标被当 disabled 行（见 2.6） |

### 2.4 [P0] 帧内没有「被引用的原文」证据区

- 原型：先 `.quote-label` → 衬线 `.evidence-quote`（被引用片段）→ `.evidence-body`（说明）→ 下级关系（§1.4）。视觉上**先看到被引用的那一段，再看到上下文**。
- 当前：FileFrame 直接渲整份 `OmCodeViewer`（FileFrame.vue:221-227），SymbolFrame 渲 ±6 行窗口（SymbolFrame.vue:61-63,160）。虽然 `ranges` 高亮了目标符号，但没有「被引用的原文」标签、没有 evidence-note 免责（`app.jsx:1536-1538`），用户无法区分「这次点进来的是哪一行/哪一段」。
- 证据：截图 `screenshots/codewiki-04-drawer-file.png` 顶部直接是「派生说明（确定性解析）」panel，再贴代码；`screenshots/codewiki-06-depth2-symbol.png` 顶部直接是 `apps/server/src/review/app.ts` 路径 + badge。

### 2.5 [P0] 面包屑形态不对

- 原型：横向单行滚动、`数字 标题`、箭头分隔、当前层 `aria-current="step"`（`styles.css:1322-1354`）。
- 当前：`.crumb` 是上下两行的 chip（数字在上、标题在下），`flex-wrap:wrap`，两层时已经折成两行（截图 `screenshots/codewiki-06-depth2-symbol.png`：「返回 | 1 app.ts | 2 code」换行）；当前层反白深底（`OmTrailDrawer.vue:157-179`）。与原型的横向滚动单行不一致。

### 2.6 [P0] 引用行没有人类 label / 版本 / 「已在当前路径」

- 原型 next-refs 行：人类 label + `{关系类型} · {version}` + on-path 标记（§1.3）。
- 当前 FileFrame 边行：`OmBadge{edgeKind}`（如 `calls`、`imports`）+ 方向箭头 + `targetLabel`（文件 basename 或 `symbol:line`）（FileFrame.vue:247-259）。
  - `edgeKind` 是技术 id，没有映射成人类词（calls→调用、test_of→测试）。
  - 不显示版本/commit。
  - 不显示「已在当前路径」。
  - `CodeEdge.status` 联合里有 `"missing"`（`review-api.ts:309`），但 `statusLabel()` 只覆盖 confirmed/candidate/stale，missing 落到默认「外部包」（FileFrame.vue:161-166）——把「仓库内解析失败」错标成「外部包」。
- FragmentFrame 行：`OmBadge{relationType}`（`implements/decided_by/...`）+ filePath/片段摘录（FragmentFrame.vue:99-125）。同样是技术枚举直出，没有人类 label，也没有版本。

### 2.7 [P1] 焦点与滚动恢复不完整

- 原型：切层把焦点移到帧标题 `<h2 tabindex="-1">`（`app.jsx:397`）；每层滚动独立保存/恢复。
- 当前：`OmTrailDrawer.vue:42-43` 打开时焦点落到 `.om-trail-panel` 容器本身；切层只恢复 `scrollTop`（`OmTrailDrawer.vue:51-59`），**不把焦点移到当前帧标题**。键盘用户切层后焦点仍停在面板容器，Tab 顺序不可预期。
- 帧对象只存 `scroll`（trail.ts:13-27），不存 `tab`/`ask`/`selection`/草稿——Code Wiki 当前也没有这些状态，后续加 tabs/追问时要一起补。

### 2.8 [P1] 768 / 390 溢出

- 截图 `screenshots/codewiki-07-768-drawer.png`：768px 宽时 drawer 仍是右侧 560px，压在左栏上；代码第 8、11 行右侧被截断，无横向滚动条。
- 截图 `screenshots/codewiki-08-390-drawer.png`：390px 时 drawer 虽然 100vw，但代码行同样右溢（`buildReviewApp(deps: ReviewAppDeps)` 切边），违反 smoke.mjs:247-251 的无横向溢出断言。
- 原型在 ≤700 是全屏 dialog + `.trace-reader`/`.inline-chat` 纵向堆叠（§1.7）；当前 OmTrailDrawer 在 ≤700 只是 `width:100vw`（`OmTrailDrawer.vue:201-205`），代码查看器自身不换行。
- 根 `design.md:46` 断点合同：>1100 三栏；701–1100 右栏改可打开侧栏；≤700 导航折叠、引用全屏。当前 768 落在中段，drawer 没有按这个合同切形态。

### 2.9 [P1] EvidenceReader 自身也没完全对齐原型

EvidenceReader 是更接近原型的参考，但仍缺：
- 无「证据路径 · 第 N 层」顶条、无 parent-peek、无复制链接（EvidenceReader.vue:75-183）。
- tabs 只有 3 个（excerpt/context/backlinks），**缺「版本」tab**（EvidenceReader.vue:104-116）。
- 无 superseded/restricted/deleted/anchor_unresolved 分支（只渲染 `<blockquote>`）。
- 用 `document.querySelector(".om-dialog .dialog-scroll")` 字符串选择器读写滚动（EvidenceReader.vue:29,33,45），脆弱，应改成组件 ref。
- 这意味着 Code Wiki 不能照抄 EvidenceReader，而要一起把 trail 通用部分抽到 packages/ui。

---

## 3. 必须复用 vs 需要新增/扩展

### 3.1 必须直接复用（不得在 Code Wiki 重新发明）

- `OmDialog`（`packages/ui/src/components/OmDialog.vue`）：居中模态、`showModal`、Esc→back、关闭恢复焦点（14-27,36-41）。Code Wiki 的 trail 容器从 `OmTrailDrawer` 切回 `OmDialog`。
- `OmButton` / `OmIcon` / `OmBadge` / `OmEmpty` / `OmPanel` / `OmCitation` / `OmCodeViewer` / `OmMarkdown` / `OmStatusLine`（`packages/ui/src/index.ts:1-13`）。
- `findLoop` / `TrailFrame` / 帧栈类型（`trail.ts`），但去掉 `MAX_TRAIL` 截断（见 2.2）。
- EvidenceReader 已验证的帧栈行为：open/back/jump/loop/滚动恢复/aside 追问（EvidenceReader.vue:16-63）——抽成 `packages/ui` 的 composable，两个 app 共用。
- tokens.css 色板（不回退原型 `#858585/#e6e6e6`）。

### 3.2 需要新增/扩展的通用组件（下沉 packages/ui，非 code-only）

| 组件 | 作用 | 原型出处 |
| --- | --- | --- |
| `OmTrailBar`（扩展 OmDialog header 槽） | 「layers 证据路径」+「第 N 层」Chip + 关闭按钮 | `app.jsx:1304-1316` |
| `OmTrailCrumb` | 横向滚动单行面包屑，`aria-current="step"`，点祖先 jump | `app.jsx:1317-1330`、`styles.css:1322-1354` |
| `OmParentPeek` | 「← 来自第 N-1 层 {父标题}」灰条 | `app.jsx:1331-1339` |
| `OmTraceTabs` | `role=tablist`，通用 4 tab（片段/上下文/反向/版本），业务侧用 slot 覆盖 | `app.jsx:1361-1382` |
| `OmStateBanner` | superseded/restricted/deleted/anchor_unresolved 四种，文字+动作按钮；扩展现有 `OmStatusLine` | `app.jsx:1396-1422` |
| `OmRefRow`（block 版 OmCitation） | 左图标格 + 人类 title + `{type} · {version}` + on-path 标记 + 箭头 | `app.jsx:1514-1534` |
| `useTrailStack()` composable | frames 栈、push/back/jump、loopAt、每帧 tab/ask/scroll/draft、返回焦点 | `app.jsx:404-439` + EvidenceReader.vue:16-63 |

不做：不复制原型整份 CSS 进 packages/ui；不新增品牌色/渐变；不为 Code Wiki 单独写抽屉组件。

---

## 4. 引用 label / 技术详情折叠 / missing-stale 规则

### 4.1 人类可读引用 label 规则

- **正文中的内联引用**：显示人类短语（如「回滚方案、负责人和验证结果必须到位」）+ 序号 sup；技术 id（`fragmentId`、`edgeId`）绝不进 UI，只在 `title`/aria-label 里。
- **块级引用行**：`<b>` 人类标题 + `<small>` 元信息 `{kind/关系类型人类词} · {section 或范围} · {version}`。
- 版本展示用业务值：`r7`、`commit demo-a91c`、`L18–27`、`快照 1`；不显示 `v{number}` 这种技术枚举（当前 EvidenceReader.vue:99-102 的 `v{{version}} · 现行/历史` 要改成业务措辞）。
- 关系类型必须有人类映射表：`implements→实现`、`requires→依赖`、`decided_by→决策依据`、`researched_by→调研依据`、`tested_by→测试覆盖`、`candidate_for→候选`、`calls→调用`、`test_of→测试`、`imports→导入`。当前 FileFrame.vue:255 / FragmentFrame.vue:106 直出英文枚举，必须映射。
- 「已在当前路径」：目标 fragment 已在 frames 栈里时，行尾追加灰字；这是免费的防迷路提示，不需要新请求。

### 4.2 技术详情折叠规则

- 帧头始终显示：人类标题、kind badge、版本/commit、行范围（代码帧）。
- 以下技术性元信息收进 `<details class="tech-details">`（summary「技术详情」）：`parserVersion`、`contentHash`、`snapshotId`、`edge.origin`、模型名/置信度（FileFrame.vue:204-218 现在是整段平铺，要折叠）。
- 「派生说明（确定性解析）」panel（FileFrame.vue:204-218）保留，但默认折叠；展开才看 language/symbolCount/importCount/unknowns。
- 折叠不藏关键状态：stale/candidate/missing 必须在主行可见，不能藏进 details。

### 4.3 不可操作 missing / stale / restricted 规则

- **restricted**：`OmStateBanner` danger 风，标题「当前无权查看」，正文说明，唯一动作「返回引用处」；「就这段追问」disabled（原型 `app.jsx:1405-1422,1556-1559`）。
- **deleted**：标题「原始内容已删除」，不伪装高亮、不悄悄指向新目标。
- **anchor_unresolved**：标题「原文位置尚待核对」，不画假高亮。
- **superseded**：banner「正在查看历史版本 X，现行是 Y」+「查看现行版本」按钮；旧帧本身仍可读。
- **edge status = missing / external**：行 disabled、灰字「外部包 / 未解析」或「仓库内未解析」，无 drill；修正 `FileFrame.vue:161-166` 把 missing 错标成「外部包」的问题。
- **edge status = candidate**：warning badge「候选」，可点但文案标注「未登记确认」。
- **edge status = stale**：neutral badge「已过期」，可点但标注「来源已变更，待重新同步」。
- 任何状态都不允许把一条引用静默重定向到另一个目标。

---

## 5. 验收清单

### 5.1 1440×1000（桌面三栏）

- [ ] 点正文中的内联 cite，弹出居中模态 dialog（带 backdrop blur），焦点在帧标题上。
- [ ] 连续下钻 8 层以上，「证据路径 · 第 N 层」标签如实显示层数；栈不被截断到 8。
- [ ] 第 2 层起出现 parent-peek「来自第 N-1 层 {标题}」。
- [ ] 四个 tabs（片段/上下文/反向/版本）可切换；反向 tab 带计数。
- [ ] 底栏有「返回上一层」「复制链接」「就这段追问」；追问展开后 dialog 加宽到 ~1130px。
- [ ] Esc 退一层（不清空栈）；再按 Esc 到第 1 层时关闭 dialog，焦点回到触发 cite。
- [ ] 点 backdrop 关闭全部；点 X 关闭全部。
- [ ] 同帧重复 push → loop-notice，不压栈。
- [ ] 栈里已有目标的引用行尾标「已在当前路径」。
- [ ] 代码帧：先出现「被引用的原文」+ range 高亮，再是代码；技术详情默认折叠。

### 5.2 768×1024（中屏）

- [ ] 左栏可折叠；右栏（若有）变为可打开浮层，不挤压主栏。
- [ ] trail dialog 不横向溢出；代码查看器可横向滚动而非裁断。
- [ ] 所有触控/点击目标 ≥44×44px（内联 cite 例外）。

### 5.3 390×844（移动）

- [ ] dialog 全屏 100dvh，无圆角无边距。
- [ ] 展开追问时阅读区与追问区纵向堆叠（53dvh / 60dvh）。
- [ ] 父层预览、meta 行在小屏隐藏（按 `styles.css:1977-1998`）。
- [ ] `document.scrollWidth <= innerWidth`，无横向滚动。
- [ ] 汉堡按钮打开导航浮层；「追问」按钮打开右栏浮层。

### 5.4 键盘与无障碍

- [ ] Tab 顺序：dialog 内自顶到底，不跑到背景；关闭后焦点回到触发元素。
- [ ] 切层后焦点落在帧标题（tabindex=-1 h2），不是容器。
- [ ] Esc 行为：第 N>1 层退一层；第 1 层关闭并恢复焦点。
- [ ] 面包屑当前层有 `aria-current="step"`；tabs 有 `role=tablist/tab` + `aria-selected`。
- [ ] 异步加载有 `aria-live`/`role="status"`；错误有 `role="alert"`。
- [ ] 所有图标按钮有 aria-label；badge 颜色之外有文本。
- [ ] `prefers-reduced-motion` 下无过渡动画。

### 5.5 诚实状态

- [ ] 已删除/无权限/锚点未定位三种状态各自有专属标题与正文，不显示假原文。
- [ ] 历史版本 banner 提供「查看现行版本」跳转。
- [ ] missing/外部包边 disabled 且文案正确；candidate/stale 有 badge 文字。
- [ ] 无模型时不伪造 AI 摘要；「未配置模型」badge 可见（当前 FileFrame.vue:216 已做，保留）。

---

## 6. 本次审计未覆盖 / 剩余限制

- 未跑 `osdk run check`、未改任何代码；本文件只是差异清单。
- 截图来自运行中 5181 服务（commit 8dadc897 + 工作树未提交），未重启服务；后续 UI 改动后需重新截图复核。
- `packages/ui` 里 `OmDialog` 与 `OmTrailDrawer` 目前并存，迁移期两者都要保留直到 Code Wiki 切完；本审计建议最终让 `OmTrailDrawer` 退役或改为 `OmDialog` 的 trail 外壳，不在两个容器间长期分叉。
- 「就这段追问」接入真实 LLM 不在本切片；交互合同（focus-card、范围 select、草稿保留、停止生成）以原型为准，后端留空时按 design.md:52 显示诚实空态。
