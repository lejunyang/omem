# 编码与独立评审使用哪个 Agent

更新：2026-10-06。主助手、编码、评审可以选择不同配置。omem 保存交办、材料、代码副本与检查；搜索、补读和反复调用工具仍由外部 Agent 的循环完成。

## 当前能用到哪里

| 提供方 | 接入方式 | 本轮验证与限制 |
| --- | --- | --- |
| Traex | 原有 ACP；原生只读，代码修改和登记命令走 omem MCP | 默认仍为 gpt-5.6-sol；新增双配置流程的实际验收见 progress.md |
| Claude | 社区 `@agentclientprotocol/claude-agent-acp@0.86.0`，使用 Claude Agent SDK | 真实会话、模型和思考强度发现成功；实际推理返回 Authentication required，编码尚未验收。不是 Claude CLI 原生提供 ACP |
| Codex | 社区 `@agentclientprotocol/codex-acp@2.1.1`，连接 Codex App Server | 已用 gpt-5.6-sol / medium 完成真实编码、宿主检查、独立评审，95.6 秒；原仓库未修改。先装配本次任务的工具，再启动只读会话 |

模型列表不证明账号能调用模型。Claude 的本机列表还包含一个自定义网关模型；不能从适配器名字推定底层一定是 Anthropic 模型。本轮没有改动登录信息，也没有为消除认证错误改成继承所有个人设置。适配器未作为普通安装的必需依赖，不隐式下载、登录或开启全局工具。

## 如何配置

在个人库 config.json 的 profiles 中保留既有配置，为不同角色选择 ID：

```json
{
  "development": {
    "codingProfileId": "coding-sol",
    "reviewProfileId": "review-sol"
  },
  "profiles": [
    {
      "id": "coding-sol",
      "name": "编码",
      "transport": "acp",
      "acpProvider": "traex",
      "command": "traex",
      "args": ["acp", "serve"],
      "model": "gpt-5.6-sol",
      "effort": "medium",
      "idleTimeoutMs": 480000
    },
    {
      "id": "review-sol",
      "name": "独立评审",
      "transport": "acp",
      "acpProvider": "traex",
      "command": "traex",
      "args": ["acp", "serve"],
      "model": "gpt-5.6-sol",
      "effort": "high",
      "idleTimeoutMs": 480000
    }
  ]
}
```

这是配置片段，合并到既有配置，保留 assistant、消息采集、学习和存储设置。主助手继续由 `assistant.profileId` 选择。不写 development 时沿用原主助手配置；两角色即使采用同一模型，也分别启动新会话，评审只读原需求、实际差异和检查，不读取编码者自评。

`acpProvider` 让包装命令也能明确提供方；省略时识别 traex/traecli、claude-agent-acp、codex-acp 的可执行文件名。不支持的编码提供方在入队前报错。配置不存在、模型或思考强度未被 Agent 宣告时明确拒绝，不猜相近名字或静默降级。

调试 Claude 时登记 `transport: "acp"`、`acpProvider: "claude"`、`command: "claude-agent-acp"`、`args: []`。模型和 effort 先省略，用 `omem agent probe PROFILE_ID --json` 查看安装版返回值。当前仅接纳已核对的 0.86.0 适配器，旧 `@zed-industries` 包或其他版本会报告未验证，避免忽略隔离参数。成功探测后仍需实际推理确认认证。

Codex 使用 `acpProvider: "codex"`、`command: "codex-acp"`、`args: []`，也可以写已安装命令的绝对路径；可分别选作编码或评审。默认从 npm 适配器安装中解析配套 Codex，避免探测与实际会话使用不同二进制。自定义包装命令可额外声明 `codexCommand` 指向 Codex 可执行文件。此轮验证组合为适配器 2.1.1 / Codex 0.159.3 / macOS；其他平台未实测。Node 必须在服务的执行环境中可用，不能只在原项目目录依靠版本管理器的 shim。`development:providers` 已显式选择 Node 和 Bun。

## 任务怎样保持一致

自然语言交办入队时将编码、评审完整配置复制进任务；CLI 创建任务时同样固定。恢复继续使用保存的配置，服务重启或修改默认模型不会替换正在进行的任务。旧任务没有记录时在首次执行固定当前配置。当前不提供给原任务中途换提供方的命令。

运行记录保存真实 profile ID、提供方、实际模型/effort 和会话 ID，不再把其他配置重命名为 traex。配置保存在私人运行目录/数据库，凭据应由 CLI 登录或服务环境提供，不能塞进命令参数或提交到 Git。

角色包仍声明默认 profile_ref。只有可信宿主的显式角色绑定可以选择其他配置；材料和模型输出没有绑定权限。后续若让小模型建议“哪类任务用哪个模型”，也只能在已配置候选中提出建议，不能凭得分认定已登录、扩大工具权限或自行开始编码。

## 工具和技能的差别

Traex 沿用原生 skill 发现和 `.trae/skills` 快照；编码保持原生只读。Claude 使用 SDK 的 Agent 循环，但关闭内置工具、个人/项目设置来源、hooks 和额外 MCP，只装配本次会话的 omem 工具。Claude、Codex 的角色 skill 正文经过已有摘要核对后内联，trace 明确记录 inline，不声称完成了原生 skill 发现；外部能力的 skill 和引用资源仍由 `capability_read_skill` 按需读取。

三者共享 `development_context`、固定原件检索/补读、图片、`project_rules`、`list_code/read_code/write_code`、`run_project_command`、`inspect_changes`、外部能力和 `submit_result`。独立评审不获得写代码工具。工具返回继续由宿主校验、保存，不能直接写记忆事实。

Claude 显式使用 default 权限模式；只自动允许本次登记的 `mcp__omem__*` 工具。Codex 每次先用官方 App Server 读取当前工作目录的有效配置和技能目录，再通过会话覆盖关闭继承的 MCP、插件、技能、hooks、原生命令、浏览器/桌面、应用连接与 Web 搜索，只保留宿主装配的工具。项目规则由 `project_rules` 显式读取。发现失败或与保留的 omem MCP 名字冲突会说明原因，不能悄悄继承个人工具继续跑。30 秒上限只用于无推理的配置发现，实际模型运行仍按输出活动重置空闲计时。

这些覆盖不写个人 config.toml，不复制认证文件，不切换 CODEX_HOME，也不重新登录；凭据刷新仍由原 Codex 管理。它控制工具装配与写入路线，不是全系统文件隔离承诺。独立只读原生探测已确认关闭个人插件后不再列出其工具；实际编码和评审均只观察到本次 omem MCP 调用。

## 依据与后续

复用的上游：[Codex ACP](https://github.com/agentclientprotocol/codex-acp)、[Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。本轮核对了适配器源码和实际已发布版本；不能用上游 README 的功能清单替代本机验收。

外部资料已可选入统一材料库，并在当轮引用和后续检索；远端 Git 已接通项目准备与刷新，真实私有环境仍待验收；Claude 仍需有效认证后跑同一验收。`osdk run development:providers` 使用手写的受控需求，默认两角色均通过真实 Traex/Sol 执行；`OMEM_PROVIDER_CONFIG` 可指定私人两角色配置。脚本验证实际修改、宿主检查、独立评审和原仓库保持不变，结束释放临时库；它不代表真实业务或 Figma 验收，也不冒充模型生成需求。
