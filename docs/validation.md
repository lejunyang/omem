# 本次交付验证

日期：2026-09-26。验证对象是设计材料与离线交互原型；开源引擎、真实模型与服务端尚未部署。

## 已执行

1. **材料读取**：两份飞书文档 revision 19/18 的全文；第二份中两张架构画板；用户 HTML 的视觉、引用栈与追问实现；旧项目关键 README/类型/摄入与上下文包代码。
2. **上游核验**：17 个仓库的固定 commit、README、许可证；补查 WeKnora SearchParams/SearchResult/manual upload/chunks handler 和 Hindsight OpenAPI 的 retain/recall/证据字段。来源、hash、URL 见研究索引。
3. **原型构建**：`npm --prefix docs/prototype run build` 成功。React 与 CSS 打包成自包含 HTML，不依赖远程字体、CDN 或 API。
4. **浏览器测试**：Chromium `153.0.8010.12`，桌面 1440×1000、较低高度窗口及手机 390×844。测试脚本和逐项结果见 [smoke.mjs](prototype/smoke.mjs)、[verification.json](prototype/verification.json)。
5. **人工视觉检查**：查看桌面阅读、四层证据+原位追问、手机阅读截图；检查正文、面包屑、弹窗与问答的相对层级。
6. **静态一致性**：检查 Markdown 本地链接、JSON 格式、示例图的边端点、引用节点、数据样本数量和 Git whitespace。

## 浏览器覆盖

- 首页、离线资源和无横向溢出。
- 8 层业务示例链，末端和 Esc 上一层。
- 100 层合成链，单一当前正文，回到起点。
- 循环引用检测，路径不继续增长，可回到原有层。
- 历史 r6 与现行 r7 对比，旧引用不被重定向。
- 弹窗内追问、范围改变、固定焦点、草稿与范围保留；点击 AI 回答引用继续下钻并返回原问答。
- 原文圈选并在 dialog 内追问。
- 返回后恢复阅读位置和起始焦点。
- 无权限、已删除、原文定位不确定状态及追问禁用。
- 关键词搜索与无结果状态。
- 模拟来源同步的进行中/完成状态。
- 恢复追加事件，刷新后演示历史保留。
- 字号调整影响正文，手机全屏引用和问答。
- 浏览器零脚本异常、零外部 HTTP(S) 请求。

测试可复现：

```bash
cd docs/prototype
npm ci
npx playwright install chromium
npm run build
npm test
```

本机复用已有浏览器时设置 `OMEM_CHROMIUM=/path/to/chrome`。截图存放在 [prototype/screenshots](prototype/screenshots)。

## 明确没有验证的内容

- 真实引用支持准确率、中文检索 Recall、事实幻觉率、学习后的任务成功率。
- WeKnora/Hindsight 的实际部署、资源峰值、模型费用、异步任务幂等性和删除传播。
- 真实飞书/Git/Agent connector、鉴权/撤权、团队 ACL、数据库并发、灾备。
- 完整读屏/对比度无障碍审计、Safari/Firefox 兼容、长期海量路径性能。
- 后端学习工作流、自动执行 Skill、真正的多版本数据恢复。原型恢复只操作演示历史。

以上在实施方案 P0–P2 的退出条件中列明。研究中的“字段存在”和原型中的“可点击”都不被当作生产能力已实现。
