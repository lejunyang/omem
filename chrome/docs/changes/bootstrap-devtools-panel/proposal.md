# bootstrap-devtools-panel

## 背景

项目需要先验证 Chrome DevTools 扩展的基础链路：加载扩展、创建「高级网络」面板、捕获网络请求、展示请求详情。

## 用户价值

- 尽早验证核心 API 是否满足“高级网络”方向。
- 为高级筛选、响应体搜索和 mock 能力提供 UI 与数据基础。
- 建立后续变更文档和验证记录的标准样例。

## 范围

- 搭建 Manifest V3 Chrome Extension 工程。
- 创建 DevTools 自定义面板「高级网络」。
- 使用 `chrome.devtools.network` 捕获请求。
- 展示请求列表、基础筛选、请求详情、响应体读取。
- 提供本地测试页面，用于触发 fetch/XHR 请求。

## 非范围

- 暂不实现 CDP Debugger。
- 暂不实现 DNR/CDP mock。
- 暂不实现复杂筛选 DSL。
- 暂不做 WebSocket/SSE 专项支持。

## 风险

- DevTools 打开前发生的请求可能缺失，需要刷新页面。
- 响应体读取对大文件、二进制和跨域场景可能存在限制。
- 原生 Network 的部分字段需要 CDP 才能补齐。
