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
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<账号 ID>/ai`（要填账号 ID；填了接口地址就替换这一整段） | 决策（Clef） |
| `openai-compatible` | 必须填写 | 语音、图片 |

“检查”只发不花钱的请求：OpenAI 和兼容接口用 `GET /models`，Anthropic 用 `GET /v1/models`，OpenRouter 用 `GET /v1/key`，Cloudflare 用 `GET …/ai/models/search`（同时确认 token 和账号）。TypeSafe 没有已知的免费检查接口，只看 key 是否填写。

### 用 API key 生成后端

`openai` 可以生成 `codex@<编号>`、`codex-cli@<编号>`，`anthropic` 可以生成 `claude@<编号>`、`claude-cli@<编号>`（`config.ts` 的 `keyedProfiles`）。它们和内置的同名后端用同一个程序，区别是：

- 启动时把 key 放进环境变量（`keyEnv`）：Claude Code 用 `ANTHROPIC_API_KEY`；Codex 同时设 `CODEX_API_KEY` 和 `OPENAI_API_KEY`（codex-acp 先读前者，`codex exec` 读前者）。key 不写进后端配置，也不出现在设置接口的返回里。
- 自定义接口地址写在后端的 `env` 里（`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`）。
- 来源是 `key:<编号>`：额度、并发和“额度用完”跟本机登录的那个分开算；它没有套餐额度，设置 → AI → 并行 的“账号额度”只列本机登录的 Codex、Claude Code。
- key 被删掉时这个后端算“未安装”，选了它的运行直接报错，不会悄悄改用本机登录。

服务的环境里本来就有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` 时，所有 Agent 都会继承它，API key 页会提示。

其他支持自带 key 的 Agent（OpenCode、goose、Cline、Kilo、pi、DeepAgents、Factory Droid）各有各的配置方式，暂不自动生成，可以在通用页编辑后端配置的 `env`。Copilot、Cursor、Amp、Junie、Devin、Gemini CLI、Qwen Code 用自家账号或自家的 key。

## 三类模型

每类一个设置（`config.ai.voice` / `decision` / `image`）：提供方、模型（留空用默认），加上各自的参数。`categoryStatus` 判断能不能用：提供方存在、类型对得上、有 key、模型能确定。不能用时各页写明缺什么。

**检测账号里的模型**：添加或更换 key、点“检查”通过、或列表超过一天时，omem 读提供方的模型列表（OpenAI 和兼容接口 `GET /models`，OpenRouter `GET /v1/models`，Cloudflare `GET …/ai/models/search?search=clef`；TypeSafe、Anthropic 没有），只存模型名到数据目录的 `cache/ai-models.json`（`refreshModels`）。读失败时保留旧列表，API key 页那一行写“模型列表读取失败”。各模型字段（图片、语音 Live / Realtime、转写、委托、决策）按名字筛出合用的（`modelChoices`：图片 `gpt-image-*`，Live `gpt-live*`，Realtime `gpt-realtime*` 去掉 whisper / translate，转写含 transcribe / whisper，委托和 OpenAI 决策是 `gpt-数字` 开头的文字模型，Cloudflare 是 `clef*`），设置页给下拉选，列表里没有的可以“手填其他…”。

**留空 = 默认**：用这个字段列表里最新的模型（`newestOf`：名字里版本号最大的，带日期的快照不算；版本相同的几个，比如 `gpt-image-2.6-flare` 和 `-sunburst`、`clef` 和 `clef-flash`，取和内置默认同款的那个，再不行按名字排第一个）。列表为空或提供方没有列表时用内置默认（图片 `gpt-image-2.6-flare`、Live `gpt-live-1`、Realtime `gpt-realtime-2.1`、转写 `gpt-transcribe`、委托和 OpenAI 决策 `gpt-6-luna`、Jev `jev-latest`、Clef `clef-flash`）。OpenAI 的委托和决策字段列的是全部文字模型，留空会用版本号最大的那个，要固定用便宜的就在下拉里选定。

### 语音

三个用处：

- **问答页语音输入**：输入框旁的麦克风，录下来交给 `/v1/audio/transcriptions`（默认 `gpt-transcribe`，`ai.voice.transcribeModel`），文字填进输入框，你再改再发。和选哪种实时接口无关。
- **语音对话**：问答页的波形按钮，和助理实时说话。它能用 omem 的只读工具（`list_spaces`、`search`、`read_source`、`recall`、`list_items`、`read_page`），在你能读的空间里查，说出依据的文档名。结束后对话记录存进 `voice_sessions`。
- **口语练习**（导航“口语”，语音可用后才出现）：选一个场景（或自己写），语音模型扮演场景里的另一个人，用英语对话；卡住时直接用中文问“这个怎么说”，它用中文答一句再回到场景。中途不逐句纠错，结束后由 `speaking-coach` 角色读对话记录，按内置技能 `speaking-assessment` 写评价（CEFR 估计、四个维度的分、挑真说过的句子给出改法、这次学到的说法、下次练什么）。

#### GPT-Live 和 Realtime 的差别，以及 omem 怎么接

| | GPT-Live（`gpt-live-1`） | Realtime（`gpt-realtime-2.1`） |
| --- | --- | --- |
| 对话方式 | 全双工：边听边说，模型自己决定何时开口，插话它会停下 | 轮流：听到停顿（`semantic_vad`）后回答，说话时可以打断 |
| 推理和工具 | 语音层只管说话；查资料、调工具交给委托的 Responses 模型（`delegation: {type: "responses"}`，默认 `gpt-6-luna`，`ai.voice.delegateModel`），等结果时它会先应一声 | 同一个模型自己调用函数工具（`session.tools`） |
| 浏览器怎么连 | 没有临时凭证：浏览器把 SDP offer 发给 omem（`POST /api/voice/live/sdp`），omem 用 key 调 `POST /v1/live/sessions`（`transport: webrtc`），把 SDP answer 交回 | omem 用 key 调 `POST /v1/realtime/client_secrets`（整套会话配置放在这里，10 分钟有效），浏览器拿临时凭证把 SDP 发到 `/v1/realtime/calls` |
| 转写事件 | 双方都是流式：`session.input_transcript.delta` / `session.output_transcript.delta`，没有“结束”事件，对方开口就算换人 | 你的话整句到：`conversation.item.input_audio_transcription.completed`；它的话是 `response.output_audio_transcript.delta` / `.done` |
| 工具调用 | 包在 `response.event` 里的 `response.output_item.done`（`item.type = function_call`）；回 `response.item.create`（`function_call_output`）再 `response.create` | `response.function_call_arguments.done`；回 `conversation.item.create`（`function_call_output`）再 `response.create` |
| 计费 | 按会话分钟（另加委托模型的 token） | 按音频 token |

两种接口在网页里共用一套（`web/src/lib/voice.ts`）：麦克风是 WebRTC 音轨，事件走 `oai-events` 数据通道；差别只在怎么拿到 SDP answer 和读哪些事件，读出来统一成“你 / 它的一段话”和“要调用的工具”。工具由浏览器转给 omem（`POST /api/voice/tool`），按这个用户能读的空间执行，只放行上面那几个只读工具。key 始终不进浏览器。

口语练习不给工具；场景写进语音模型的说明（`voiceInstructions`）。练习结束保存时如果学习者说过话，就排一条 `speaking-review` 运行。

GPT-Live 的“client 委托”（`delegation.type = "client"`，由应用自己处理请求、用 `session.commentary.append` 让它说结果）可以把整个 omem 主助手接进来，但主助手一次要几十秒，现在不用；以后要在语音里交办事情时再考虑。

### 决策

只做有边界的判断：从几个选项里选一个、是或否、按几档打分，返回每个选项的概率。

| 接口 | 地址 | 默认模型 |
| --- | --- | --- |
| OpenAI Decisions API | `POST https://api.openai.com/v1/decisions` | `gpt-6-luna` |
| Jev（TypeSafe） | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| Jev（OpenRouter） | `POST https://openrouter.ai/api/v1/systemone`（接受 `jev-latest` 这样的短名） | `jev-latest` |
| Clef（Cloudflare Workers AI） | `POST …/accounts/<账号 ID>/ai/run/@cf/cloudflare/<模型>` | `clef-flash` |
| StartLux-Decision（本机） | 本地服务的 `/v1/systemone` | 和注入标记共用（`guard`） |

Cloudflare 的 Clef 三个模型都和 Jev 用同一种格式（2026-11 查）：

| 模型 | 能读 | 上下文 | 说明 |
| --- | --- | --- | --- |
| `clef-flash` | 文字、JSON、图片 | 24K | 9B，最便宜（每百万输入 token $0.038） |
| `clef` | 文字、JSON、图片 | 64K | 27B，更准 |
| `clef-omni` | 文字、JSON、图片、音频、视频 | 64K | 30B-A3B，每百万输入 token $0.15 |

模型可以写短名（`clef-omni`），也可以写 `@cf/cloudflare/clef-omni`；请求体里的 `model` 一律发短名（Workers AI 要求它和地址里的模型一致）。返回可能包在 Cloudflare 的 `{result, success, errors}` 里，omem 两种都认。

两种格式（`src/core/decision.ts`）：

- **OpenAI**：`{model, input, questions: [{type, name, instructions, choices: [{value, description}]}]}`，`input` 是文字或 `input_json`；是 / 否用 `predicate`，回 `probability`；选择回 `choice`、`probabilities: [{value, probability}]`、`confidence`。答案是数组，按 `name` 对上。
- **System One**（Jev、Clef、StartLux）：`{model, state, questions: {<编号>: {type, instructions, criteria: {选项: 说明}}}}`；是 / 否用 `noul`（`criteria: {true, false}`），回 `noul`；选择回 `choice`、`probabilities: {选项: 概率}`。StartLux 的是 / 否改问成两个选项的 `choice`，评测里这样更准（judge-models.md），它的 `state` 要是对象。
- **图片、音频、视频**：`decide` 的 `media`（`images` / `audio` / `videos`，每项是 data URL，例如 `data:image/png;base64,…`）原样放进 System One 请求体的同名字段。哪个模型读什么由 `decisionMedia`（`ai-keys.ts`）决定，现在只有 Clef：`clef-flash`、`clef` 读图片，`clef-omni` 还读音频（wav / mp3，最多 4 段、每段 5 分钟）和视频（mp4 / webm，最多 2 段、每段 1 分钟）；图片最多 4 张。配的模型不读的媒体，`decide` 直接报错，不悄悄丢掉只按文字判断。设置页决策的状态行写明除文字外还读什么。现在的调用方（规则判断、访客把关）只传文字。
- 拒绝回答（`type: "refusal"`）、HTTP 出错、返回的不是 JSON，都算出错。

omem 统一成“材料 + 问题 + 选项 → 选中的一项和每项概率”（`decide`），是 / 否另有 `judgeYesNo`：规则要求用决策模型且配好了就用它，没配好就用通用模型；出错时 `fallback` 是 `general` 就改用通用模型（理由前写明“决策模型出错，改用通用模型”），是 `none` 就按“否”处理。决策模型不写理由，记录里写成“决策模型（提供方 · 模型）：是 0.91”。各家的概率口径不同，阈值不能照搬，现在一律取概率最高的一项。

用在哪里：

- **规则**：`judge` 为 `ai` / `code+ai` 的判断和“模型判断”这一步（`check` 动作），按规则的 `judgeWith`：`decision`（默认，决策模型优先）或 `general`（通用模型读完规则和讨论再判断，会写理由）。材料是规则原话、已满足的条件、事件和所在的讨论。规则页“用哪个模型判断”可选，并显示现在有没有可用的决策模型。
- **运行前选 AI**（`agents.routing.choose`，architecture.md 的“运行前自动选 AI”）：选项是“按原来的设置”和任务选型的各候选，每项写着适用说明、占用和账号额度，取概率最高的一项；对话、规则交给的 Agent、交办和后台任务分别设不选 / 有决策模型时选 / 总是选。
- **访客提问的把关**（`ai.decision.gatekeeper`，默认开）：三个选项回答 / 拒绝 / 不理，说明取自 `gatekeeper` 角色。拒绝时回固定的一句（群里“这个需要机器人的主人同意，已经去问了。”，私聊或机器人“这个我不能帮忙。”）。出错时按 `fallback` 交给 `gatekeeper` 角色，或者不理。
- 设置 → AI → 决策 有“试一下”：填材料、问题和选项（不填就是是 / 否），看选中的一项、每项概率、用时。

需要读很多原件、调用工具才能判断的事，不交给决策模型。

### 图片生成

OpenAI Images API（`POST /v1/images/generations`，返回 `data[0].b64_json`）。默认 `gpt-image-2.6-flare`（快，2026-11-04 发布），要精细用 `gpt-image-2.6-sunburst`；可设默认尺寸和质量。

可用后才有工具 `generate_image`（分组 `media`，主助手的 `tools` 里有 `group:media`；Agent 档案要用就加这个分组），以及内置技能 `image-generation`（`requires: [ai:image]`）：没配好时运行里没有这个工具（`runner.ts`），技能也不列给 Agent（`skillUsable`）。图片按内容哈希存进 `files/`，和其他附件一样由 `/api/files/<名字>.png` 提供；工具返回本机路径（给 `lark_send_file`）和网页地址（写进 Wiki 或回答的 Markdown）。每次生成记一条运行事件 `image`。

### 技能的 `requires`

技能的 frontmatter 可以写 `requires: [ai:image]`（或 `ai:voice`、`ai:decision`）：对应的模型没配好时，这个技能不出现在给 Agent 的技能列表和 `list_skills` 里。内置的 `image-generation`、`speaking-assessment` 都这样标。

## 实现顺序

1. 设置页分类、API key 与提供方、用 key 生成后端、三类模型的设置和可用状态（已完成）。
2. 图片：画图工具（新分组）和配套技能，只在图片模型可用时给出（已完成）。
3. 决策：统一的判断接口（几家 API + StartLux + 通用模型兜底），接入 `gatekeeper` 和规则判断（已完成）。
4. 语音：问答页语音输入、实时对话、口语练习（已完成）。

## 资料（2026-11-07 查）

- GPT-Live：[OpenAI 公告](https://openai.com/index/introducing-gpt-live-1-in-the-api/)、[语音 WebSocket 指南](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- Decisions API：[官方指南](https://developers.openai.com/api/docs/guides/decisions)（请求与返回格式以它为准，每次最多 400 个问题，打分 2–10 档）
- Clef：[Cloudflare 博客：Clef-omni 与更快更便宜的 Clef](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)、[Workers AI 更新记录](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)、[Workers AI 的 clef-omni 页面](https://developers.cloudflare.com/workers-ai/models/clef-omni/)（输入输出格式和媒体上限）、[Hugging Face 上的 clef-flash](https://huggingface.co/Cloudflare/clef-flash)
- Jev：[OpenRouter 的 Jev 文档](https://openrouter.ai/docs/guides/community/jev)、[TypeSafe SDK 经 OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)、[MixRoute 的 Jev 接口](https://mixroute.ai/docs/api-reference/endpoint/jev)（选择最多 255 项）
- GPT-Live 与 Realtime：[语音 WebRTC 指南](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)、[GPT-Live 委托](https://developers.openai.com/api/docs/guides/live-delegation)、[Realtime 服务端事件](https://developers.openai.com/api/reference/resources/realtime/server-events)、[语音转文字](https://developers.openai.com/api/docs/guides/speech-to-text)
- 图片：[图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[模型列表](https://developers.openai.com/api/docs/models)
- Codex 的 key 变量：[codex-acp](https://github.com/zed-industries/codex-acp)、[Codex 认证](https://developers.openai.com/codex/auth)
