# 主动输入、群聊与屏幕观测

当前统一入口 `POST /api/captures`，运行时 Zod 合同在 packages/contracts/src/index.ts。私有/远程服务器请求带 Bearer token。

```json
{
  "source": "screen",
  "externalId": "desktop-observer/event-001",
  "title": "正在阅读产品需求",
  "observedAt": "2026-09-26T16:00:00+08:00",
  "parts": [
    {"type":"text","text":"观察工具提取的屏幕文字…"},
    {"type":"link","url":"https://example.com/spec","label":"当前窗口链接"}
  ],
  "context": {
    "application":"Browser",
    "windowTitle":"产品需求",
    "uiText":"观察工具提取的 UI 节点文字"
  }
}
```

图片 part 为 `{type:"image",mimeType:"image/png",data:"<base64 bytes>",label:"截图"}`。支持 PNG/JPEG/WebP，每张解码后 ≤5 MB；接口总体 body ≤12 MB；问答图片总预算 ≤10 MB；不接 SVG/HTML 作为可执行图片。URL 只作为材料保存，不自动访问。

source 枚举 manual/file/git/lark/agent/hook/chat/screen。文本每项 ≤200k 字符；最多 50 个 part。相同 source/externalId 与相同规范内容重试复用当前版本；有变化创建下一版本。屏幕事件通常每个事件独立 ID，某份文档则可用稳定文档 ID 持续版本化。observedAt 是观察时间，保存时间由服务生成，两者不同。

群聊连接器可传 `conversationId` 和 message ID 作为 externalId；hook/会话可传 `runId`、`event`。机器人入群、历史读取/图片下载与观察工具由外部负责；本轮已实现接收合同，不包含机器人安装、全群监听或屏幕采集器。UI 节点结构当前以 uiText 表达，复杂树可由外部规范化成文字，不声称已经解析任何操作系统 accessibility tree。

## 飞书、Git 与文本

- 飞书执行 lark-cli docs +fetch，保留 revision、原文和 reference_map 文本。当前按段落分片，原生 block IDs 可在返回的资料中保留，但尚未完成 block→精确 selector 映射；UI 展示的是 omem 固定片段，不能冒称飞书精准选区链接。
- Git 固定到解析后的 commit，仅读取指定文件；尚未做全仓 AST/symbol/import 关系提取。
- 文本用 UTF-8 严格解码并拒绝 NUL/二进制；HTTP 导入路径须在配置的 captureRoots 内，解析 realpath 防止目录/符号链接越界。

## TraeX hooks

模板：integrations/traex/hooks.example.json。采用 `事件→matcher group→hooks handler` 结构，async command 5 秒超时。填写绝对 hook-forward.js 路径，按需合并到目标项目的 .trae/hooks.json，执行该项目的 host trust 流程；本轮没有改动用户现有 hook 配置。

hook-forward 接收 stdin JSON，选择事件、会话、回合、工具名称、prompt、tool_input、tool_response/error；不自动打开 transcript 文件、不保留未知 thought 字段，不调用模型，stdout 为空，服务不可用只在 stderr 给出简短故障。传输 3 秒超时，失败放行宿主。

**采集范围**：这些选中的工具字段仍可能含业务数据；当前只有基础 token 模式脱敏，不是完整 DLP。只在确定的项目/会话选择启用；复杂敏感信息过滤、持久本地 spool 与断线补传尚待实现。没有安装全局 hook，避免把所有日常工作未经区分地上传。

## 任务与提醒

`POST /api/tasks` 保存 title/detail/dueAt/可选 evidenceId，`PATCH /api/tasks/:id` 修改 open/done。日期转换为 UTC，30 秒有界轮询写持久通知，去重键包括任务版本。当前是应用内提醒；外部飞书通知和从捕获内容自动提炼任务尚未启用。
