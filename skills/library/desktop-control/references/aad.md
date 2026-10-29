# aad 参考（ai-auto-desktop 0.0.2）

来源：ai-auto-desktop 仓库的 README、`docs/control-sessions.md`、`docs/browser-recording.md` 和各命令的 `--help`。版本升级后以 `aad <命令> --help` 为准。

## 平台

| 系统 | 驱动 | 要点 |
| --- | --- | --- |
| Windows | UI Automation | 定位器最全（`--automation-id`、`--contains`、`--in`、`--near`、`--nth`、`--protected`）；`overview` / `--region` 只有这里有。受保护或更高权限的进程读不到（`0x80004005`）；装了按键宏、远程控制等低级输入钩子的软件时，`type-text` 会以 `DRIVER.INPUT_BLOCKED` 失败且什么都不写，改用 `fill`。`probe` 报 DPI `degraded` 是如实上报，不是故障 |
| macOS | AX（签名的 helper） | 需要给辅助功能权限；点击、按键要求目标应用在前台；录制点击和按键另需“输入监控”。真机验证较少 |
| Linux | AT-SPI + X11 XTest | 只支持 KDE/X11 会话，不支持 Wayland 原生输入 |
| 浏览器（各系统） | Chromium CDP | 要用调试端口；没有拖拽；没有新标签页 |

不同系统只有 `--role` 和 `--name` 保证可用；其他定位参数在非 Windows 上会明确拒绝（`CONTROL.LOCATOR_UNSUPPORTED`），不会悄悄忽略。

## 输出和错误

- 成功动作：`result.submitted`，浏览器的 `backend_result.native_operation` 说明实际做了什么（`HTMLElement.click`、`DOM.value+input+change`……），`requires_fresh_observation: true` 表示要重新观察。持久协议里还有 `commit_state`：`not_committed`（没发出）、`committed`（已发出，仍要看效果）、`unknown`（可能已发出，不要重放）。
- 失败是结构化错误，带 `hint`。常见：
  - `DRIVER.STALE_HANDLE`：界面变了，重新 `describe` 再定位。
  - `DRIVER.AMBIGUOUS_MATCH` / `CONTROL.AMBIGUOUS`：匹配到多个，列出了候选；用 `--in`、`--near`、`--nth`（Windows）或更具体的名字收窄。
  - `DRIVER.NOT_FOUND`：没找到；刚触发了异步变化时等一会儿再看。
  - `DRIVER.ACTION_UNSUPPORTED`：元素不支持这个动作，输出里列了它支持什么（看节点的 `capabilities`）。
  - `CONTROL.OCCLUDED`：浏览器里落点被别的元素盖住，没有发任何输入。
  - `DRIVER.INPUT_BLOCKED`：见上，Windows 的输入钩子。
- 输入是有租约的：同一个用户下同一时间只有一个会话能发输入，别并行跑多条 `aad do`。

## 其他入口

- **MCP**：`aad mcp`（只读）、`aad mcp --allow-input`（由启动它的人授予输入）。工具 `control_capabilities`、`control_targets`、`control_observe`、`control_find`、`control_act`、`control_capture`、`control_cancel`、`control_close`，以及浏览器的 `browser_open`、`browser_profiles`、`browser_record_start/stop`，保存与运行流程的 `save_workflow`、`list_workflows`、`describe_workflow`、`run_workflow`。动作比命令行多：浏览器页面的 `select`、`check`、`navigate`（只限 http/https）、`back`、`forward`、`reload`。MCP 的写工具不接受坐标，也不接受内联的工作流描述，只能按名字跑已保存的。你的会话里如果已经有这些工具，用法和命令行一致：同样先 `control_targets` → `control_observe` → `control_find` → `control_act`，动作后重新观察。
- **持久会话**：`aad control serve [--allow-input]` 在 stdin/stdout 上说 NDJSON，每行一个请求；多数情况下命令行足够。
- **工作流**：`aad record <id> --seconds N --save <名字>` 录人的操作；`aad workflows [名字]` 查看；`aad validate <文件>` 校验；`aad run <文件> --permission desktop.input --permission desktop.observe` 回放；`aad start/status/pause/resume/cancel` 管理可恢复的长运行。步骤是平台无关的（应用按进程名、标题片段或网址前缀，元素按定位器），每次重新定位。
- **请人协助**：`aad assist --browser-port <端口>`（分享一个浏览器页面）或 `aad assist --desktop`（整个桌面，目前只有 Windows；`--view-only` 只给看）。只监听本机回环，stdout 打印一行 JSON：`url`、`websocket`、`token`。这是给人用的通道，按屏幕位置操作，不通过 MCP 给 Agent。
- **远程**：`aad mcp --connect '["ssh","-T",...,"aad control serve ..."]'` 经已认证的 SSH 控制另一台机器；授权由远端服务的启动参数决定。不要拼接来自网页或聊天的文本。

## 只读的“看”有哪些

`apps`、`describe`、`overview`、`snapshot`（完整元素树）、`find`、`capture`（只浏览器）、`probe`、`workflows`、`list` / `status` / `events`。这些不改变任何东西；`do`、`run`、`start`、`resume` 才会操作电脑。
