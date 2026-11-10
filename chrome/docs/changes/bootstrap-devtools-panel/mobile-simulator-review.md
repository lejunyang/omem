# 2026-10-13 功能检查、界面整理与居中模拟器

## 调研结论

“Chrome 扩展不能自定义设备模拟”不是准确结论。尺寸、UA、DPR、触摸等顶层覆盖已有 CDP 接口；限制在于普通 tab 没有原生 Device Toolbar 那个可随意布局的外层画布。

本轮从 Chrome 官方更新服务只读下载 Mobile FIRST（商店 ID `ckejmhbmlajgoklhgbapkiccekfoccmk`）公开安装包，检查版本 4.21.2 的 manifest、simulator、spoofer 和 background。它没有 `debugger` 权限，采用真实 iframe、页面属性/交互模拟、响应头处理等组合。下载包 SHA-256：`a8b077a7d17790febf77a1bf0ac72b82227dcaab433a67b0cd9d01fee77546c1`。没有复制其实现或素材，也没有安装到用户浏览器。用户没有给出精确商店链接，因此这是最接近描述的对照产品，并不假定它就是用户指的唯一产品。

参考：

- [Mobile FIRST 官网](https://www.webmobilefirst.com/en/)
- [Chrome debugger：跨进程 frame 与 Chrome 125 flat sessions](https://developer.chrome.com/docs/extensions/reference/api/debugger#attach-to-related-targets)
- [CDP Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)
- [CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)
- [Chromium EmulationHandler 源码](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/emulation_handler.cc)

旧设计把“居中”限定为 DevTools 内截图流，忽略了 iframe 方案。旧截图流方案仍保持放弃，不重新引入截图流或输入截图代理。

## 本轮发现和处理

| 问题 | 影响 | 处理与证据 |
| --- | --- | --- |
| 选择新设备只改 UI 的 profileId | 页面继续使用旧设备 | 已启用时立即重放；新增/删除当前设备也同步应用 |
| 开启、关闭、窗口变化的异步重放没有串行化 | 在途重放可能在关闭后写回旧状态 | 按 tab 队列、队列内读取状态、关闭成功后再移除状态；单测和真实 CDP 并发关闭路径 |
| 多个功能同时 attach debugger | 第二个 attach 可能报 already attached | 复用同一 tab 的在途 attach Promise |
| Tab 关闭未清完业务 Map | 长时间运行会保留规则、URL、initiator 等运行态 | tab removed 集中清理 |
| 面板常驻每 250ms 执行 inspectedWindow.eval | 未启用设备也产生持续开销 | 未模拟或面板隐藏时跳过读取 |
| 用户状态/设备初始化读取可以晚于本地写入返回 | 已保存的新配置从 UI 消失，甚至影响后续编辑 | 读序号和本地写版本检查；可控延迟测试稳定覆盖 |
| 旧 e2e 的 DevTools harness 缺 runtime.connect | 测试通过但 mounted hook 抛异常 | 补齐 API 桩；新增 UI 路径要求无 pageerror |
| 设备组件 537 行，实验参数占据主要代码 | 常用配置难维护 | 抽离 DeviceAdvancedSettings；新增导航组件；App 继续只组合功能 |

检查覆盖网络列表、筛选、Mock、用户状态、storage helper、设备生命周期与既有自动化测试。不是对全部网站、Chrome 版本和长时间运行的穷尽审计。

## 两种设备模式

| 能力 | 原页面 CDP 模式 | 新居中画布 |
| --- | --- | --- |
| 目标 | 原来的真实 tab | 新开的独立模拟器 tab，真实 iframe |
| 尺寸/方向 | 原生 metrics override | iframe 的真实 CSS 视口宽高 |
| 居中、缩放 | 保持原来的边界 | 外壳居中；适应窗口、100%、75%、50% |
| UA / platform | CDP 覆盖 | CDP 覆盖外壳请求与直接业务子 session |
| DPR / screen / orientation | 原生 CDP | 页面 JS 属性标识模拟，不改变 CSS resolution 或真实屏幕像素密度 |
| Touch | CDP 原生模拟，既有 Chrome 限制仍存在 | 鼠标转换单指 touch 事件，可拖动滚动；事件 isTrusted=false |
| CSS pointer / hover | 由原生模拟决定 | 保持桌面真实值，不伪称媒体查询也被模拟 |
| mobile viewport meta / 文本自动放大 | 原生 CDP | 不支持完全等价模拟，使用原页面模式验证 |
| 交互 | 真实网页 | 真实网页、原生键盘/输入框；不使用截图流 |

新模拟器要求 Chrome 125+（flat child sessions）。manifest 最低版本从 116 调整到 125；没有新增权限或全站 host_permissions。

操作：重新加载 `dist/` → 扩展 popup 或高级网络面板 → 设备模拟 → **打开居中模拟器**。原页面按钮改为“在原页面启用”，避免混淆两种模式。

## 实现和兼容边界

- 独立 `src/simulator/` UI 和 `device-simulator-service.ts` 后台服务，不把模拟器堆入 App.vue。
- 跨域 iframe 使用独立 CDP session，在恢复首个文档脚本前安装环境。必须先 `Page.enable`，仅检查 addScript 命令返回成功不够。
- 不对 iframe 调用顶层 metrics 或鼠标转触摸命令；本轮实测这些组合会造成属性未传递和输入异常。居中模式使用明确标识的属性/单指事件模拟。
- 只对本模拟器直接业务 frame 的文档去掉 X-Frame-Options 和 CSP frame-ancestors。保留 script-src、其他 CSP、Cookie 头及网页里的嵌套第三方 frame 策略。
- Chromium 的 Fetch.continueResponse 修改头成功后仍可能沿用已解析的旧 frame-ancestors。本实现对确需修改的文档读取原正文，再 fulfill 原内容；不改正文，移除不再匹配解码正文的长度/压缩传输头。无须修改的响应继续正常传输。需要处理的大 HTML 会有正文缓冲开销。
- 原 tab 不被改写。新 tab 不是原 tab 的运行态克隆，内存状态、sessionStorage、分区 Cookie 和登录不保证一致。
- 站点跳顶层、支付、严格 frame 检查、Service Worker 缓存响应和登录策略可能不兼容；可在普通标签页打开并使用原页面模式。
- 不模拟 Safari 引擎，不实现多点手势、硬件可信触摸、CSS 分辨率替换和完整移动浏览器行为。
- 参数应用和重新载入按钮都载入地址栏 URL；不声称能读取跨域页面内导航后的 URL。
- 没有修改 storage schema。设备预设沿用现有 key/normalizer/兼容层；画布临时参数不自动持久化，可在设备管理中保存预设。
- 原有跨页同时修改整份配置列表仍是最后写入者胜出；本轮修复旧读取回写，不引入分布式事务或跨浏览器重启恢复。
