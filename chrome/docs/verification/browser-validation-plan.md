# 浏览器验证方案

更新时间：2026-07-02

## 目标

让 AI Agent 和开发者能持续验证「高级网络」插件能力，包括：

- DevTools 面板是否成功加载。
- 请求是否被捕获。
- 响应体是否可读取和搜索。
- 筛选条件是否可保存和恢复。
- mock 是否按规则生效。

## 验证分层

| 层级 | 验证对象 | 工具 | 自动化程度 |
| --- | --- | --- | --- |
| L1 | 纯函数、筛选 DSL、数据模型 | Vitest 或等价单测 | 高 |
| L2 | 面板 UI 作为普通页面 | Playwright / agent-browser | 高 |
| L3 | 扩展加载和 DevTools 集成 | headed Chrome + extension | 中 |
| L4 | CDP mock、DNR、权限交互 | headed Chrome + 手工/MCP 辅助 | 中低 |
| L5 | 长时间稳定性和性能 | 脚本压测 + 浏览器性能记录 | 中 |

## 测试页面设计

后续应提供一个本地测试页面，包含固定接口：

| 接口 | 用途 |
| --- | --- |
| `GET /api/users` | JSON 响应搜索、基础列表展示 |
| `POST /api/search` | 请求体/Payload 展示 |
| `GET /api/error` | 4xx/5xx 筛选 |
| `GET /api/slow` | timing/waterfall 展示 |
| `GET /api/large-json` | 大响应处理 |
| `GET /api/binary` | 二进制响应处理 |
| `GET /api/mock-target` | mock 验证 |
| `GET /api/sse` | SSE PoC |
| `WS /ws` | WebSocket PoC |

## agent-browser 验证流程草案

页面级验证：

```bash
agent-browser --session advanced-network open http://localhost:5173/test-page
agent-browser --session advanced-network wait --load networkidle
agent-browser --session advanced-network snapshot -i
agent-browser --session advanced-network click @e1
agent-browser --session advanced-network network requests --type xhr,fetch
```

HAR 验证：

```bash
agent-browser --session advanced-network network har start
agent-browser --session advanced-network open http://localhost:5173/test-page
agent-browser --session advanced-network wait --load networkidle
agent-browser --session advanced-network network har stop ./artifacts/network.har
```

Mock 验证：

```bash
agent-browser --session advanced-network network route "**/api/mock-target" --abort
agent-browser --session advanced-network open http://localhost:5173/test-page
agent-browser --session advanced-network wait --load networkidle
agent-browser --session advanced-network network requests --status 400-599
```

说明：`agent-browser network route` 可验证浏览器自动化层面的拦截思路，但最终插件内 mock 仍需验证 DNR/CDP 实现。

## DevTools 集成验证草案

由于 DevTools 面板不是普通网页，验证分为两步：

1. 将面板页面作为普通 extension page 打开，验证 UI 和交互。
2. 使用 headed Chrome 加载扩展，打开测试页面和 DevTools，检查「高级网络」Tab 是否出现并工作。

建议命令形态：

```bash
google-chrome \
  --user-data-dir=/tmp/advanced-network-profile \
  --disable-extensions-except=/absolute/path/to/extension/dist \
  --load-extension=/absolute/path/to/extension/dist \
  http://localhost:5173/test-page
```

macOS 可使用 Chrome 应用路径，具体命令在实现阶段补齐。

## P0 验证用例

| ID | 对应需求 | 步骤 | 期望 |
| --- | --- | --- | --- |
| V-001 | R-001 | 加载扩展，打开 DevTools | 出现「高级网络」Tab |
| V-002 | R-002 | 访问测试页触发 fetch/XHR | 面板列表新增请求 |
| V-003 | R-003 | 查看请求列表字段 | URL、method、status、type、duration 不为空 |
| V-004 | R-004 | 点击一条 JSON 请求 | 展示 Headers/Payload/Response/Timing |
| V-005 | R-005 | 打开 Response | JSON/text 响应可读 |
| V-006 | R-006 | 输入 `status >= 400` | 只展示错误请求 |

## P1 验证用例

| ID | 对应需求 | 步骤 | 期望 |
| --- | --- | --- | --- |
| V-101 | R-007 | 输入 `method = POST AND responseBody ~ "keyword"` | 命中符合条件请求 |
| V-102 | R-008 | 保存筛选条件并刷新 DevTools | 可再次选择该筛选 |
| V-103 | R-009 | 搜索响应体关键词 | 定位到目标请求和匹配片段 |
| V-104 | R-010 | 导出 HAR | 文件可被 HAR Viewer 打开 |
| V-105 | R-011 | 开启 Preserve log 后跳转页面 | 历史请求仍保留 |

## Mock PoC 验证用例

| ID | 方案 | 步骤 | 期望 |
| --- | --- | --- | --- |
| M-001 | DNR block | 阻断 `/api/mock-target` | 页面收到失败结果 |
| M-002 | DNR redirect | 重定向到扩展静态 JSON | 页面收到静态 mock |
| M-003 | CDP fulfill | 对 `/api/mock-target` 返回自定义 JSON | 页面收到动态 mock |
| M-004 | CDP response stage | 读取真实响应后改写字段 | 页面收到被改写响应 |
| M-005 | 异常兜底 | mock 处理器抛错 | 请求被 continue，不造成页面永久 pending |

## 验证记录要求

每次执行验证后，记录：

- Chrome 版本。
- Manifest 版本。
- 扩展构建版本。
- 测试页面地址。
- 执行命令。
- 通过/失败结果。
- 截图或 HAR 路径。
- 新发现的能力边界。

记录位置：`docs/changes/<change-id>/validation.md`。
