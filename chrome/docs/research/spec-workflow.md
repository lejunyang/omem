# 需求记录与持续执行工作流调研

更新时间：2026-07-02

## 问题背景

本项目不是一次性脚本，而是长期演进的 DevTools 扩展。需要一个可靠记录体系，持续记录：

- 用户需求和优先级。
- 技术方案和取舍。
- 浏览器/扩展 API 能力边界。
- PoC 结论。
- 验证手段和验证结果。
- AI Agent 每轮开发的任务边界。

## 工具路线评估

| 路线 | 适合内容 | 优点 | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| OpenSpec 思路 | proposal、design、spec、tasks | 适合需求先行、增量变更、AI 约束 | 执行纪律和验证循环需要额外补充 | 采用其文档结构思想 |
| Superpower/Superpowers 思路 | AI 执行纪律、任务分解、质量门禁 | 强调开发过程、测试、复盘 | 与项目规范可能重叠，工具生态需验证 | 借鉴流程，不强绑定 |
| GitHub Spec Kit / SDD | 从意图到规格再实现 | 适合从零项目 | 引入成本较高 | 后续可评估 |
| 本地 Markdown + 脚本 | 项目内可追踪文档 | 轻量、可版本化、适合当前空工程 | 需要自觉维护 | 立即采用 |
| 飞书/知识库 | 团队协作和评审 | 适合对外共享 | 与代码不同步风险 | 重要里程碑同步 |

## 推荐方案

采用“轻量 OpenSpec 风格 + 本地验证脚本 + AI 执行清单”的混合方案：

```text
docs/
  research/
    devtools-network-capability.md
    spec-workflow.md
  specs/
    advanced-network-requirements.md
  verification/
    browser-validation-plan.md
```

后续进入开发期后，再扩展：

```text
docs/
  changes/
    <change-id>/
      proposal.md
      design.md
      tasks.md
      validation.md
```

每个 `change-id` 代表一个独立变更，例如：

- `bootstrap-devtools-panel`
- `capture-network-records`
- `advanced-filter-dsl`
- `response-body-search`
- `cdp-fetch-mock-poc`

## 单个变更模板

### proposal.md

```md
# <change-id>

## 背景

## 用户价值

## 范围

## 非范围

## 风险
```

### design.md

```md
# 设计

## 架构

## 数据流

## API/权限

## 兼容性

## 失败策略
```

### tasks.md

```md
# 任务

- [ ] 实现
- [ ] 单元验证
- [ ] 浏览器验证
- [ ] 更新文档
```

### validation.md

```md
# 验证记录

## 环境

## 步骤

## 结果

## 发现问题

## 后续动作
```

## AI Agent 循环规则

每轮开发必须遵守：

1. 读取当前需求文档和对应 change 文档。
2. 明确本轮只处理哪些 task。
3. 编码前补齐验证计划。
4. 编码后运行静态检查、单测、构建。
5. 打开浏览器加载扩展并执行验证步骤。
6. 将验证结果写回 `validation.md`。
7. 如果发现 API 能力边界，更新 `research/` 文档。

## 浏览器自动化建议

优先使用 `agent-browser` 做页面级验证：

- 打开测试页面。
- 触发 fetch/XHR。
- 读取页面状态。
- 采集截图。
- 检查 mock 后的页面表现。

DevTools 面板本身的 UI 验证可分两层：

- 面板内部页面：作为普通 HTML 页面单独打开验证交互。
- DevTools 集成：使用 headed Chrome + 扩展加载 + 手工或 MCP 辅助验证。

## 当前取舍

- 不立即强依赖某个外部 SDD 工具，避免工具先行影响工程推进。
- 先把需求、能力边界、验证方法写进仓库，保证 AI 和人类开发者都能持续读取。
- 等 MVP 跑通后，再评估是否引入 OpenSpec CLI、Spec Kit 或团队内文档平台。
