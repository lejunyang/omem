# 高级网络需求与验收清单

更新时间：2026-07-02

## 产品目标

提供一个比 Chrome 原生 Network 更适合复杂前端调试的 DevTools 面板：

- 保留原生 Network 的主要观测能力。
- 强化复杂筛选、搜索、保存筛选方案。
- 支持接口 mock、录制、回放和对比。
- 支持通过自动化脚本持续验证关键能力。

## 角色

| 角色 | 诉求 |
| --- | --- |
| 前端开发 | 快速定位接口错误、搜索响应内容、mock 特定接口 |
| 调试/排障人员 | 保存常用筛选条件，复现问题，导出证据 |
| 测试人员 | 使用 mock 场景稳定复现边界 case |
| AI Agent | 按文档持续开发、运行浏览器验证、记录结果 |

## 需求分级

| ID | 需求 | 优先级 | 实现路线 | 验收标准 |
| --- | --- | --- | --- | --- |
| R-001 | DevTools 新增「高级网络」Tab | P0 | `chrome.devtools.panels.create` | 打开 DevTools 后可见面板 |
| R-002 | 实时展示请求列表 | P0 | `chrome.devtools.network.onRequestFinished` | fetch/XHR 请求完成后出现在列表 |
| R-003 | 展示核心字段 | P0 | HAR entry 解析 | 展示名称、URL、方法、状态、类型、大小、耗时 |
| R-004 | 请求详情页 | P0 | Headers/Payload/Response/Timing tabs | 点击请求可查看详情 |
| R-005 | 响应体读取 | P0 | `request.getContent` | JSON/text 响应可展示和复制 |
| R-006 | 基础筛选 | P0 | 前端过滤器 | 支持 status、method、type、domain、keyword |
| R-007 | 高级筛选 DSL | P1 | 解析器 + AST 过滤 | 支持 AND/OR/NOT、比较、正则或包含 |
| R-008 | 筛选条件保存 | P1 | `chrome.storage.local` | 可新增、选择、重命名、删除筛选方案 |
| R-009 | 高级搜索 | P1 | 响应体懒加载 + 索引 | 可在接口 URL、请求体、响应体内搜索目标内容 |
| R-010 | HAR 导出 | P1 | `chrome.devtools.network.getHAR` | 可导出当前记录为 HAR 文件 |
| R-011 | Preserve log | P1 | 面板内状态保留 | 页面跳转后可按开关保留历史记录 |
| R-012 | DNR 轻量 mock | P2 | `declarativeNetRequest` | 可按 URL 阻断或重定向 |
| R-013 | CDP 动态 mock PoC | P2 | `chrome.debugger` + `Fetch.fulfillRequest` | 指定接口返回自定义 status/header/body |
| R-014 | Mock 规则管理 | P2 | 本地规则仓库 | 可启停、排序、导入导出 mock 规则 |
| R-015 | 请求录制与回放 | P3 | HAR + mock 规则生成 | 可从真实响应生成 mock |
| R-016 | WebSocket/SSE 观测 | P3 | CDP Network events | 可展示连接与消息摘要 |
| R-017 | 弱网/禁缓存 | P3 | CDP Network 设置 | 可禁用缓存，弱网能力完成 PoC |

## 数据模型草案

### NetworkRecord

```ts
export interface NetworkRecord {
  id: string;
  requestId?: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBodyState: "unloaded" | "loaded" | "too-large" | "binary" | "failed";
  responseBody?: string;
  size?: number;
  duration?: number;
  startedAt: number;
  finishedAt?: number;
  initiator?: string;
}
```

### FilterPreset

```ts
export interface FilterPreset {
  id: string;
  version: 1;
  name: string;
  query: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}
```

### MockRule

```ts
export interface MockRule {
  id: string;
  version: 1;
  enabled: boolean;
  name: string;
  priority: number;
  match: {
    urlPattern: string;
    method?: string;
    resourceType?: string;
  };
  action:
    | { type: "block" }
    | { type: "redirect"; url: string }
    | { type: "fulfill"; status: number; headers: Record<string, string>; body: string };
  createdAt: number;
  updatedAt: number;
}
```

## 非功能要求

- 性能：请求列表使用虚拟滚动，响应体懒加载，大响应默认不自动索引。
- 稳定性：mock 引擎异常时必须自动 continue request，避免页面卡死。
- 安全：默认不持久化敏感响应体；支持一键清空所有记录。
- 可维护：所有能力变更必须更新本文件和验证方案。
- 可验证：每个 P0/P1 需求必须有自动化或半自动验证步骤。

## 开放问题

- 是否接受 `debugger` 权限和浏览器提示作为高级 mock 的代价？
- 是否必须支持 Chrome Web Store 发布？如果需要，权限策略会影响架构。
- 是否需要与公司内部代理、mock 或抓包平台打通？
- 响应体搜索是否需要支持跨页面历史记录，还是只搜索当前 DevTools 会话？
- mock 规则是否需要团队共享和版本管理？
