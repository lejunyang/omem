# AI：API key、语音、决策、图片模型

设置 → AI 分五个子页：通用（原来的 Agent 页：后端、任务选型、并行、兜底、自动推进、记忆质量、夜间复盘）、语音、决策、图片生成、API key。

Agent 仍是理解、调查、写作和编码的主体。语音、决策、图片三类模型由 omem 自己经 HTTP 调用，各自只做一件事，配好并通过检查后才启用对应的功能和技能。

## API key 与提供方

`config.ai.providers`：编号、名称、类型、接口地址（可选）、要生成的后端。key 不进 config.json，存在 `secrets/ai-keys.json`（权限 600，不随快照和拉取同步），网页只拿到后 4 位（`src/core/ai-keys.ts`）。删掉提供方时一起删掉它的 key。

| 类型 | 默认地址 | 能用于 |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | Codex 后端、语音、决策、图片（向量模型仍按 `embeddings.apiKeyEnv` 读环境变量） |
| `anthropic` | `https://api.anthropic.com` | Claude Code 后端 |
| `typesafe` | `https://api.typesafe.ai` | 决策（Jev） |
| `openrouter` | `https://openrouter.ai/api` | 决策（Jev 等） |
| `openai-compatible` | 必须填写 | 语音、图片 |

“检查”只发不花钱的请求：OpenAI 和兼容接口用 `GET /models`，Anthropic 用 `GET /v1/models`，OpenRouter 用 `GET /v1/key`。TypeSafe 没有已知的免费检查接口，只看 key 是否填写。

### 用 API key 生成后端

`openai` 可以生成 `codex@<编号>`、`codex-cli@<编号>`，`anthropic` 可以生成 `claude@<编号>`、`claude-cli@<编号>`（`config.ts` 的 `keyedProfiles`）。它们和内置的同名后端用同一个程序，区别是：

- 启动时把 key 放进环境变量（`keyEnv`）：Claude Code 用 `ANTHROPIC_API_KEY`；Codex 同时设 `CODEX_API_KEY` 和 `OPENAI_API_KEY`（codex-acp 先读前者，`codex exec` 读前者）。key 不写进后端配置，也不出现在设置接口的返回里。
- 自定义接口地址写在后端的 `env` 里（`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`）。
- 来源是 `key:<编号>`：额度、并发和“额度用完”跟本机登录的那个分开算。
- key 被删掉时这个后端算“未安装”，选了它的运行直接报错，不会悄悄改用本机登录。

服务的环境里本来就有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` 时，所有 Agent 都会继承它，API key 页会提示。

其他支持自带 key 的 Agent（OpenCode、goose、Cline、Kilo、pi、DeepAgents、Factory Droid）各有各的配置方式，暂不自动生成，可以在通用页编辑后端配置的 `env`。Copilot、Cursor、Amp、Junie、Devin、Gemini CLI、Qwen Code 用自家账号或自家的 key。

## 三类模型

每类一个设置（`config.ai.voice` / `decision` / `image`）：提供方、模型（留空用默认），加上各自的参数。`categoryStatus` 判断能不能用：提供方存在、类型对得上、有 key、模型能确定。不能用时各页写明缺什么。

### 语音

用途：问答页语音输入、和助理实时语音对话、英语口语训练（按选的场景对话，结束后评价真实水平；中途可以用中文问不会的说法）。

- **GPT-Live**（默认，`gpt-live-1`）：全双工，边听边说，可以打断；服务端 WebSocket `wss://api.openai.com/v1/live/sessions`，浏览器用 WebRTC。2026-09-10 进 API。
- **Realtime API**（`gpt-realtime-2.1`）：较早的语音接口。
- 浏览器直连 OpenAI，服务器只发一次性的临时凭证，key 不进浏览器。实时对话里要查资料时，模型调用的 omem 工具经服务器执行，空间照常按用户限定。

### 决策

只做有边界的判断：从几个选项里选一个、是或否、按几档打分，返回每个选项的概率。

| 接口 | 地址 | 默认模型 |
| --- | --- | --- |
| OpenAI Decisions API | `POST https://api.openai.com/v1/decisions` | `gpt-6-luna` |
| Jev（TypeSafe） | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| Jev（OpenRouter） | `POST https://openrouter.ai/api/v1/systemone`（接受 `jev-latest` 这样的短名） | `jev-latest` |
| StartLux-Decision（本机） | 本地服务的 `/v1/systemone` | 和注入标记共用（`guard`） |

两种格式（`src/core/decision.ts`）：

- **OpenAI**：`{model, input, questions: [{type, name, instructions, choices: [{value, description}]}]}`，`input` 是文字或 `input_json`；是 / 否用 `predicate`，回 `probability`；选择回 `choice`、`probabilities: [{value, probability}]`、`confidence`。答案是数组，按 `name` 对上。
- **System One**（Jev、StartLux）：`{model, state, questions: {<编号>: {type, instructions, criteria: {选项: 说明}}}}`；是 / 否用 `noul`（`criteria: {true, false}`），回 `noul`；选择回 `choice`、`probabilities: {选项: 概率}`。StartLux 的是 / 否改问成两个选项的 `choice`，评测里这样更准（judge-models.md），它的 `state` 要是对象。
- 拒绝回答（`type: "refusal"`）、HTTP 出错、返回的不是 JSON，都算出错。

omem 统一成“材料 + 问题 + 选项 → 选中的一项和每项概率”（`decide`），是 / 否另有 `judgeYesNo`：规则要求用决策模型且配好了就用它，没配好就用通用模型；出错时 `fallback` 是 `general` 就改用通用模型（理由前写明“决策模型出错，改用通用模型”），是 `none` 就按“否”处理。决策模型不写理由，记录里写成“决策模型（提供方 · 模型）：是 0.91”。三家的概率口径不同，阈值不能照搬，现在一律取概率最高的一项。

用在哪里：

- **规则**：`judge` 为 `ai` / `code+ai` 的判断和“模型判断”这一步（`check` 动作），按规则的 `judgeWith`：`decision`（默认，决策模型优先）或 `general`（通用模型读完规则和讨论再判断，会写理由）。材料是规则原话、已满足的条件、事件和所在的讨论。规则页“用哪个模型判断”可选，并显示现在有没有可用的决策模型。
- **访客提问的把关**（`ai.decision.gatekeeper`，默认开）：三个选项回答 / 拒绝 / 不理，说明取自 `gatekeeper` 角色。拒绝时回固定的一句（群里“这个需要机器人的主人同意，已经去问了。”，私聊或机器人“这个我不能帮忙。”）。出错时按 `fallback` 交给 `gatekeeper` 角色，或者不理。
- 设置 → AI → 决策 有“试一下”：填材料、问题和选项（不填就是是 / 否），看选中的一项、每项概率、用时。

需要读很多原件、调用工具才能判断的事，不交给决策模型。

### 图片生成

OpenAI Images API（`gpt-image-2`，生成与编辑），可设尺寸和质量。可用后 Agent 才拿到画图工具：给 Wiki 页配示意图、在飞书回复里发图、在问答里直接画。

## 实现顺序

1. 设置页分类、API key 与提供方、用 key 生成后端、三类模型的设置和可用状态（已完成）。
2. 图片：画图工具（新分组）和配套技能，只在图片模型可用时给出。
3. 决策：统一的判断接口（几家 API + StartLux + 通用模型兜底），接入 `gatekeeper` 和规则判断（已完成）。
4. 语音：问答页语音输入 → 实时对话 → 口语训练。

## 资料（2026-11-07 查）

- GPT-Live：[OpenAI 公告](https://openai.com/index/introducing-gpt-live-1-in-the-api/)、[语音 WebSocket 指南](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- Decisions API：[官方指南](https://developers.openai.com/api/docs/guides/decisions)（请求与返回格式以它为准，每次最多 400 个问题，打分 2–10 档）
- Jev：[OpenRouter 的 Jev 文档](https://openrouter.ai/docs/guides/community/jev)、[TypeSafe SDK 经 OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)、[MixRoute 的 Jev 接口](https://mixroute.ai/docs/api-reference/endpoint/jev)（选择最多 255 项）
- 图片：`gpt-image-2`（2026-04 发布）
- Codex 的 key 变量：[codex-acp](https://github.com/zed-industries/codex-acp)、[Codex 认证](https://developers.openai.com/codex/auth)
