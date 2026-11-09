# 不用 CDP 的默认模式 与「拾取」

日期：2026-11-10。两件事一起做：扩展默认不再连 Chrome 调试接口（CDP），以及新增「拾取」：截图、看元素样式和间距，记下来，在侧栏里引用并补充说明。

## 1. CDP 提示条能不能去掉

只要扩展调用 `chrome.debugger.attach`，Chrome 就在所有窗口顶部显示「“扩展名”已开始调试此浏览器」。这是 Chrome 的安全设计，扩展自己没有办法关掉：

- 唯一的办法是启动 Chrome 时带 `--silent-debugger-extension-api` 命令行参数（本人自己的测试浏览器可以这样用，普通用户不现实）。
- 没有企业策略、manifest 字段或 API 能隐藏它；点「取消」会直接断开调试连接。
- 提示条只在连接存续期间出现，所以能做的是：默认不连；需要时才连；用完立刻断开。

原来的问题：DevTools 面板一打开就发 `enable-cdp-observer`（为了取请求的调用栈），而 `observedTabs` 只在标签页关闭时才清掉。所以只要打开过面板，这个标签页就一直挂着调试连接，提示条一直在。

## 2. 「CDP 增强」开关

设置项 `advancedNetwork.cdpMode`（`chrome.storage.local`）：`"off"`（默认）或 `"on"`。popup 和面板都能切换；关掉时后台立刻断开所有已连接的标签页。

后台的 `attachDebugger` 是唯一入口：关闭时直接抛 `CdpDisabledError`，回复里带 `cdpDisabled: true`，界面据此显示「需要开启 CDP 增强」而不是报错。即使开启，调用栈观察也改成「面板可见时连接、面板关闭或隐藏后断开」。

| 功能 | CDP 开启 | 默认（不用 CDP） |
| --- | --- | --- |
| 请求列表、详情、HAR、响应体 | `chrome.devtools.network`，不需要 CDP | 同左 |
| 调用栈（Initiator） | `Network.requestWillBeSent` 的完整栈 | 页面钩子在 `fetch` / `XMLHttpRequest` 调用时记录 `new Error().stack`；只有这两类请求有栈，脚本、图片、样式没有 |
| Mock：替换响应体 / 响应头 | `Fetch.requestPaused` + `fulfillRequest`，所有请求类型 | 页面钩子改写 `fetch` 和 `XMLHttpRequest` 的结果；只对页面脚本发起的这两类请求生效，状态码、响应头条件照常匹配 |
| Mock：JS 修改响应 | 后台 offscreen 沙箱执行 | 同一个沙箱：钩子 → 内容脚本 → 后台 → 沙箱，结果原路返回 |
| 禁用缓存、网络限速 | `Network.setCacheDisabled` / `emulateNetworkConditions` | 不可用（置灰，提示用 DevTools 自带 Network 面板的同名开关，效果一样） |
| 原页面设备模拟 | `Emulation.*` | 不可用（置灰，提示用居中模拟器） |
| 居中模拟器 | UA 覆盖、去掉禁止嵌入的响应头、子 frame 注入环境脚本 | `declarativeNetRequest` 会话规则（只作用于模拟器标签页）：改 `User-Agent` 请求头，去掉子 frame 文档的 `X-Frame-Options` 和 `Content-Security-Policy`；环境脚本（`navigator.userAgent`、屏幕尺寸、触摸）用 MAIN world 内容脚本注入。需要授予目标站点的访问权限 |
| 资源搜索 | `Page.getResourceTree` + `CSS` / `Debugger` 取全部源码 | `chrome.devtools.inspectedWindow.getResources()` 取文档、脚本、样式表的内容；运行时动态注入、已被移除的 `<style>` 可能找不到 |
| 拾取：整页截图 | `Page.captureScreenshot`（`captureBeyondViewport`），一次成图 | 滚动 + `captureVisibleTab` 逐屏拼接（Chrome 每秒最多截 2 次）；从第二屏起隐藏 `fixed` / `sticky` 元素，避免重复 |

### 页面钩子怎么进页面

不用 CDP 时，Mock 和调用栈都依赖页面里的钩子（`src/inject/page-hook.ts`，MAIN world）。两条注入路径：

1. **已授权站点**：`chrome.scripting.registerContentScripts` 注册两段脚本，`document_start`、所有 frame：
   - `page-hook`（MAIN world）：改写 `fetch` / `XMLHttpRequest`，记录调用栈。
   - `page-bridge`（ISOLATED world）：读 `chrome.storage.local` 里的 Mock 规则，按页面 URL 和组过滤后用 `CustomEvent` 交给钩子；规则变化时重发；转发「JS 修改响应」和「已 Mock」通知给后台。
   这样不打开 DevTools，Mock 也生效（原来只有面板打开时后台才拿到规则）。
2. **没授权**：DevTools 面板打开和每次页面导航后，用 `chrome.devtools.inspectedWindow.eval` 注入同一份钩子（幂等）。注入时机晚于页面最早的几个请求，所以面板里提示「授权此站点后可从页面一开始就生效」。

钩子在拿到规则前发出的请求最多等 300 ms，超时照常放行，不会卡住页面。

## 3. 拾取

### 名字

候选：「走查」（只覆盖 UI 检查，不覆盖素材）、「标注」（容易和 omem 原件的标注混淆）、「采集」（和飞书采集重名）。选 **拾取**（Pick）：截一块、点一个元素、量一段间距，都是从页面上「拾」一样东西放进篮子；侧栏叫「拾取篮」。代码里统一用 `pick`。

### 入口

- popup 顶部「拾取」按钮（元素 / 区域 / 可视区 / 整页）。
- 快捷键：`Alt+Shift+X` 开始拾取元素，`Alt+Shift+S` 打开拾取篮（`commands`，可在 `chrome://extensions/shortcuts` 改）。
- 侧栏里的「拾取」按钮。

点 popup 或快捷键会给当前页 `activeTab` 权限，不需要额外授权；从侧栏发起而当前页没有权限时，请求这个站点的权限。

### 页面上的操作

注入一个 ISOLATED world 内容脚本（`src/inject/pick-overlay.ts`），界面放在 Shadow DOM 里，不受页面样式影响，也不改页面样式。

- 顶部居中一条浮动工具条：元素 · 区域 · 可视区 · 整页 ｜ 记下 ｜ 退出。
- **元素**：悬停高亮（内容 / 内边距 / 外边距三色，和 DevTools 一致）并显示 `标签.类名 宽×高`。单击选中为主元素，右侧出现样式卡：
  - 文本：字体、字号 / 行高、字重、颜色（色块 + 十六进制）、字间距、对齐。
  - 盒子：宽高、内边距、外边距、边框、圆角。
  - 背景与效果：背景色 / 渐变 / 图片、阴影、透明度。
  只显示和默认值不同的项，没有文本的元素不显示文本组。
- 选中主元素后：悬停其他元素实时显示两者之间的距离（红线 + 数值，相交时显示内距）；`Shift` + 单击把它加入为次元素，距离线保留。可加多个次元素。
- **区域**：拖一个矩形。**可视区**、**整页**：直接截。
- **记下**（`Enter`）：截图（默认带上高亮和距离线，工具条和样式卡截图时隐藏），连同元素信息存进拾取篮，页面右下角提示「已记下 #3」。
- `Esc`：先清选中，再按一次退出。`Alt` 暂时关闭悬停高亮，方便点页面本身。

### 记录内容

```ts
interface PickRecord {
  id: string; seq: number;           // seq 是给人看的编号（#3），递增
  kind: "element" | "region" | "viewport" | "page";
  title: string;                     // 自动生成：按钮 .submit-btn / 区域 320×180 / 整页
  note: string;                      // 本人补充的说明
  pageUrl: string; pageTitle: string; createdAt: number;
  rect: { x; y; width; height };     // 页面坐标（CSS px）
  image: Blob;                       // PNG，存 IndexedDB
  imageSize: { width; height };
  elements: PickElement[];           // 主元素在前；区域、整页为空
  spacings: PickSpacing[];           // 主元素到每个次元素的距离
}
```

截图和记录存扩展自己的 IndexedDB（`omem-pick`，加 `unlimitedStorage`），不进 `chrome.storage.local`（10 MB 上限，图片很快会满）。

### 截图怎么来

后台统一处理：`captureVisibleTab` 拿当前屏 → `OffscreenCanvas` 按 `rect × devicePixelRatio` 裁剪。整页：CDP 开启时用 `Page.captureScreenshot`，否则内容脚本逐屏滚动、后台逐屏截取并拼接（最多 16384 px 高，超出时截到上限并在记录里注明）。

### 拾取篮（侧栏）

`chrome.sidePanel`，页面 `sidepanel.html`：

- 顶部：拾取按钮组、数量、清空。
- 列表：缩略图卡片（编号、标题、站点、时间）。点卡片展开详情：大图、元素样式表、间距、说明（可编辑）、复制图片、删除。
- 底部输入框：点卡片上的「引用」或输入 `#` 选择，把 `#3 按钮 .submit-btn` 作为不可编辑的引用块插入输入框，前后继续写说明。草稿自动保存。
- 「复制为 Markdown」：说明正文 + 引用记录的页面、元素样式和间距（图片注明编号）。「发给 omem」先放占位按钮（置灰，后续接 omem 的接口）。

## 4. 不做的

- 不做 CSS 源码定位（哪条规则设置了这个值）：需要 CDP 的 `CSS.getMatchedStylesForNode`，以后在 CDP 开启时再加。
- 不做跨 iframe 的元素拾取：只处理顶层文档；iframe 内容可以用区域截图。
- 发送给 omem 的接口和处理流程。
