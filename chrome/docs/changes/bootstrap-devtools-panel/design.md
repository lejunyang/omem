# 设计

## 架构

```text
manifest.json
  └─ devtools_page: devtools.html

devtools.html/devtools.ts
  └─ chrome.devtools.panels.create("高级网络", ...)

panel.html/panel.ts/App.vue
  ├─ chrome.devtools.network.getHAR()
  ├─ chrome.devtools.network.onRequestFinished
  ├─ 请求记录归一化
  ├─ 基础筛选
  └─ 详情/响应体读取

test-page.html/test-page.ts
  └─ 触发稳定 fetch/XHR 测试请求
```

## 数据流

1. DevTools 打开后加载 `devtools.html`。
2. `devtools.ts` 创建「高级网络」面板。
3. 面板初始化时通过 `getHAR()` 读取已有请求。
4. 面板监听 `onRequestFinished` 捕获后续请求。
5. 请求被归一化为 `NetworkRecord`。
6. 用户点击请求后，面板按需调用 `getContent()` 获取响应体。
7. UI 根据筛选条件展示请求列表和详情。

## 权限

首版仅声明：

- `devtools_page`
- `storage`

暂不声明：

- `debugger`
- `declarativeNetRequest`
- `host_permissions`

原因：MVP 阶段只使用 DevTools API 观测网络请求，不做跨站注入和 mock。

## 技术栈

- DevTools 注册页保持轻量 HTML + TypeScript，只负责调用 `chrome.devtools.panels.create`。
- 面板页使用 Vue 3 + Vite 构建。Chrome DevTools 面板本质是扩展内的 HTML 页面，不要求必须使用纯 HTML；只要最终构建为扩展可加载的静态 HTML/CSS/JS 即可。
- Vue 适合承载后续复杂状态，例如高级筛选 DSL、筛选方案管理、响应体搜索索引状态和 mock 规则管理。
- 类型检查使用 `vue-tsc --noEmit`，覆盖 TypeScript 和 Vue SFC。

## UI 设计

- 顶部工具栏：筛选输入、清空、刷新 HAR。
- 左侧/主区域：请求表格。
- 右侧/下方：请求详情。
- 详情面板：Overview、Headers、Payload、Response、Timing。

## 失败策略

- `getHAR()` 失败：展示错误提示，不阻塞面板加载。
- `getContent()` 失败：将响应体状态标记为 `failed`。
- 响应体为空：展示空状态。
- 响应体过大或二进制：首版先展示 API 返回内容，后续再加大小限制和二进制识别。

## 后续扩展点

- Filter DSL 独立成 parser 模块。
- 响应体索引放到 Web Worker。
- CDP Debugger 能力通过 Service Worker 注入，不污染 MVP。
- mock 规则与筛选规则共用版本化存储模型。
