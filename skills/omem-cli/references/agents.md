# Agent 检测、模型与工作分配

AI 在运行 omem 服务的机器上启动。使用那台机器已经安装、已经登录的 CLI；飞书绑定不提供模型账号。首次打开网页会提示设置 Agent，进入「能力与连接」选择模型与思考强度。

检测不安装软件、不登录、不启动编码、不开启消息采集。Traex 可直接提供 ACP；Codex 需要 codex-acp，Claude Code 需要 claude-agent-acp。只有原生 CLI 时页面说明缺少适配器。已安装命令仍可能因为 PATH、认证或适配器版本无法连接，以实际错误为准。

```bash
omem agent discover --json
omem agent settings --json
omem agent check traex --json
omem agent check traex --model MODEL_ID --json
omem agent check traex --model MODEL_ID --effort EFFORT --test --json
```

`discover` 检测执行 CLI 的本机环境。网页和 `settings` 显示服务环境；两者可能因终端 PATH 或运行机器不同而有差异。`check` 同样直接在 CLI 本机建立 ACP 会话；`settings/setup` 连接目标服务。

状态分三步：命令可用、ACP 能力已读取、所选模型实际调用通过。能力发现返回模型列表；指定模型后再读取对应思考强度，不能从另一个模型沿用选项。不支持的组合明确失败。`--test` 发送一句不含个人材料的连接检查，会使用模型额度；未测试时不能说账号可调用该模型。旧 `agent probe [profile]` 保留原始 ACP 能力输出。

网页默认可以共用一套选择，也可分别配置主助手、材料与文章整理、记忆整理、编码、代码评审。文章的研究、写作与独立复核共用「材料与文章整理」，记忆调查、提取与复核共用「记忆整理」；会话仍独立。高级 `assistant.readingProfileId` 保留原来设置，此页不替换它。本仓库 `.repo-review` 生成另读 `config/review-code-model.json`，不会因个人设置换掉验收模型。

保存时核验实际 ACP 选项，将角色选择写入个人配置，新任务立即使用，重启后保留。已排队/已开始的编码任务保留它的固定配置。保存不会开启 `learning.enabled`、个人消息采集或飞书绑定。其他手动改配置的行为仍需重启服务。

Agent 或管理员也可准备下面的 JSON，再运行 `omem agent setup agent-settings.json --json`。每个 candidateId 必须来自实际检测结果，model/effort 来自该候选和模型的能力发现；不要把示例 ID 当本机事实。此命令需要服务运行，会保存并应用设置。

```json
{
  "roles": {
    "assistant": { "candidateId": "traex", "model": "MODEL_ID", "effort": "EFFORT" },
    "knowledge": { "candidateId": "traex", "model": "MODEL_ID", "effort": "EFFORT" },
    "learning": { "candidateId": "traex", "model": "MODEL_ID", "effort": "EFFORT" },
    "coding": { "candidateId": "traex", "model": "MODEL_ID", "effort": "EFFORT" },
    "review": { "candidateId": "traex", "model": "MODEL_ID", "effort": "EFFORT" }
  }
}
```

model/effort 省略或为空表示使用 Agent 默认。自定义命令或已有包装器在个人配置 profiles 登记；浏览器只能选择宿主已登记命令和已支持适配器，不能提交任意 shell 命令。配置中原有消息、通知、材料范围和连接保持，密钥不写进模型设置。
