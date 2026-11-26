# AI：API key、语音、决策、图片模型

设置 → 后端与模型 分五个子页：通用（后端、默认 AI 与档位、任务选型、并行、排队与兜底）、语音、决策、图片生成、API key。

Agent 仍是理解、调查、写作和编码的主体。语音、决策、图片三类模型由 omem 自己经 HTTP 调用，各自只做一件事，配好并通过检查后才启用对应的功能和技能。

## API key 与提供方

`config.ai.providers`：编号、名称、类型、接口地址（可选）、要生成的后端；第三方的 key 另有 Anthropic 格式地址（`anthropicUrl`）和后端可用的模型（`models`，第一个是默认；旧设置的单个 `model` 当作只有它一个）。key 不进 config.json，存在 `secrets/ai-keys.json`（权限 600，不随快照和拉取同步），网页只拿到后 4 位（`src/core/ai-keys.ts`）。删掉提供方时一起删掉它的 key。

| 类型 | 默认地址 | 能用于 |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | Codex、OpenCode 后端，语音、决策、图片（向量模型仍按 `embeddings.apiKeyEnv` 读环境变量） |
| `anthropic` | `https://api.anthropic.com` | Claude Code、OpenCode 后端 |
| `typesafe` | `https://api.typesafe.ai` | 决策（Jev） |
| `openrouter` | `https://openrouter.ai/api` | 决策（Jev 等） |
| `cloudflare` | `https://api.cloudflare.com/client/v4/accounts/<账号 ID>/ai`（要填账号 ID；填了接口地址就替换这一整段） | 决策（Clef） |
| `ark`（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3`；Anthropic 格式地址按方舟的规则（`…/api/v3` → `…/api/compatible`），也可手填 | Codex、Claude Code、OpenCode 后端；认得方舟的错误码（见下文“提供方的错误”） |
| `openai-compatible`（页面上叫“第三方（OpenAI 兼容）”，各家代理、自建的兼容服务） | 必须填写 OpenAI 格式地址；Anthropic 格式地址可选 | Codex、OpenCode 后端；填了 Anthropic 格式地址时还有 Claude Code。服务也实现了 OpenAI 的图片、语音接口时，图片和语音也能选它 |

以前按“OpenAI 兼容”添加的方舟 key，这一行有“改成火山方舟”按钮。

“检查”只发不花钱的请求：OpenAI、方舟和兼容接口用 `GET /models`，Anthropic 用 `GET /v1/models`，OpenRouter 用 `GET /v1/key`，Cloudflare 用 `GET …/ai/models/search`（同时确认 token 和账号）。TypeSafe 没有已知的免费检查接口，只看 key 是否填写。

第三方（方舟和 OpenAI 兼容）的 key 检查通过后再做两件事（`/api/ai/providers/:id/test`）：

- 没填 Anthropic 格式地址时，按顺序试 `GET <候选>/v1/models`（带 Bearer 和 `x-api-key`），返回模型列表的就是（`findAnthropicUrl`）：OpenAI 地址去掉末尾 `/v数字` 后加 `/compatible`（火山方舟：`…/api/v3` → `…/api/compatible`）、加 `/anthropic`、去掉后的根地址。找到后网页存进 `anthropicUrl`，Claude Code 后端随之出现。都不应时手填。
- 用后端可用的模型（添加过的前三个；没添加就用后端默认的那个）在每种格式各发一次最多 1 个 token 的请求（`tryBackendModel`），把服务的报错原样写出来。火山方舟有的账号不允许直接用模型 ID，只能用接入点 ID（`ep-…`），这一步会看到 `ModelIDAccessDisabled`。

### 用 API key 生成后端

每个 key 按它有的 API 格式生成后端（`config.ts` 的 `providerFormats`、`keyBackendsOf`、`keyedProfiles`）：OpenAI 格式给 `codex@<编号>`、`codex-cli@<编号>`、`opencode@<编号>`，Anthropic 格式给 `claude@<编号>`、`claude-cli@<编号>`（OpenCode 两种都行，有 OpenAI 格式时用它）。`openai` 只有 OpenAI 格式，`anthropic` 只有 Anthropic 格式，第三方有 OpenAI 格式，填了（或检查时找到）Anthropic 格式地址后两种都有。它们和内置的同名后端用同一个程序，区别是：

- 启动时把 key 放进后端配置 `keyVars` 列出的环境变量（`keyEnv`），key 不写进后端配置，也不出现在设置接口的返回里：
  - Claude Code：官方或 Anthropic 的 key 用 `ANTHROPIC_API_KEY`；第三方用 `ANTHROPIC_AUTH_TOKEN`（按 Bearer 发，方舟这类服务要这样），另设 `ANTHROPIC_BASE_URL`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，填了模型时 `ANTHROPIC_MODEL` 和 `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL` 都设成它。
  - Codex：官方地址同时设 `CODEX_API_KEY` 和 `OPENAI_API_KEY`（codex-acp 先读前者，`codex exec` 读前者）。其他地址（第三方，或改了地址的 OpenAI key）配成 Codex 自己的模型提供方 `omem-key`（Responses 接口，key 在 `OMEM_AI_KEY`）：ACP 版经 `CODEX_CONFIG` 和 `MODEL_PROVIDER`，命令行版经 `-c model_provider=… -c model_providers.omem-key={…}`。Codex 0.169 已经不读 `OPENAI_BASE_URL`（2026-11-26 实测仍发往 api.openai.com），以前写这个变量的做法不起作用。模型用后端配置的 `model`。
  - OpenCode：`OPENCODE_CONFIG_CONTENT` 里写一个提供方 `omem-key`（第三方用 `@ai-sdk/openai-compatible`，OpenAI 官方 `@ai-sdk/openai`，Anthropic `@ai-sdk/anthropic`）和模型，`apiKey` 写成 `{env:OMEM_AI_KEY}`，不动它自己的配置文件。没有模型时（第三方没填、Anthropic 的 key）不生成；OpenAI 的 key 默认用内置 Codex 的模型。
- 服务运行时，这些后端一律经 omem 转发（见下文）：地址是 `<omem>/api/ai/relay/<编号>/<后端>/<openai|anthropic>`，后端拿到的是 omem 发的令牌，不是 key（后端配置带 `keyRelay`）。没有服务时（测试、一次性命令）直接连提供方，地址写在 `env` 里（`ANTHROPIC_BASE_URL`，Codex 和 OpenCode 的另写 `OMEM_AI_BASE_URL`），出网策略据此放行（`egress-policy.ts` 的 `backendHosts`）。
- 第三方的 Claude Code 另设 `CLAUDE_CODE_MAX_RETRIES=3`：它默认重试十次、等好几分钟，限流时这段时间不如交给下一个后端。
- 第三方的后端只在这个 key 的模型上跑（`keyedProfiles` 给后端配置带上 `keyModels`），不用 Agent 自己那家的模型：API key 页那一行的“后端可用的模型”添加过的（可以多个，从列表里挑或手填接入点 ID，第一个是默认，可改），没添加就用模型列表里适合这个后端的全部模型（文字模型、不排除工具调用；列表写了格式时，Codex 要 Responses，Claude Code 要 Anthropic 格式，OpenCode 要 Chat），默认是其中第一个。列表写明了格式时，添加的模型不支持勾选的后端，页面直接提示。
- 通用页这些后端的“检测模型”返回的就是这些模型，不启动 Agent；每个模型的思考强度取自模型列表（方舟写在 `effort.supported_levels`，按 minimal、low、medium、high 排），列表没写的模型（例如接入点 ID）不列强度，用提供方的默认；在通用页选的默认模型只要还在其中就保留，其余配置始终跟着 key 生成。运行时选中的模型在启动时给出：Codex 经 `CODEX_CONFIG`，Claude Code 经 `ANTHROPIC_MODEL` 等变量，OpenCode 经 `OPENCODE_CONFIG_CONTENT`（`keyedModelEnv`），不再经 Agent 自己的模型列表切换。
- 来源是 `key:<编号>`：额度、并发和“额度用完”跟本机登录的那个分开算；它没有套餐额度，设置 → 后端与模型 → 并行 的“账号额度”只列本机登录的 Codex、Claude Code。
- key 被删掉时这个后端算“未安装”，选了它的运行直接报错，不会悄悄改用本机登录。

### 提供方的错误

Agent 拿到提供方的报错后，往往不带原来的错误码，只用自己的话说：Codex 把每个 429 变成回复里的一句“exceeded retry limit, last status: 429”，把 403 写成“unexpected status 403 …”，都算正常结束；Claude Code 对 429、5xx 要重试几分钟。所以 API key 生成的后端都经 omem 转发（`src/core/ai-relay.ts`，路由 `/api/ai/relay/…`，不经登录检查，只认这个后端的令牌；出网隔离的运行也放行这个路径）。omem 换上真正的 key，请求原样发出，回答以流的方式原样传回。遇到错误时，按提供方自己的错误码分类（`src/core/ai-errors.ts` 的 `classifyError`）：方舟、OpenAI、Anthropic、Cloudflare 各有一张码表，其他提供方按状态码和常见字眼判断。

| 类别 | 例子 | omem 怎么做 |
| --- | --- | --- |
| `rate` 限流 | 方舟 `RateLimitExceeded.EndpointRPMExceeded`、`ModelAccountTpmRateLimitExceeded`、`ServerOverloaded`；OpenAI `rate_limit_exceeded`；Anthropic `overloaded_error`；Cloudflare 3040 | 在 omem 这里等 2、5、10 秒各重试一次（提供方给了不超过 15 秒的 `Retry-After` 就按它）；仍然限流就把 429 交给 Agent，这个 key 的后端放到最后 1 分钟，运行算“限流”，换下一个后端 |
| `daily` 每日用量 | 方舟 `ModelAccountTpdRateLimitExceeded`；OpenAI 写明 per day 的限流；Cloudflare 3036 | 改成 400 交给 Agent（没有 Agent 会重试 400，几秒内结束），这个 key 的后端停到本人时区的午夜 |
| `quota` 额度或欠费 | 方舟 `SetLimitExceeded`、`AccountQuotaExceeded`、`QuotaExceeded.*`、`AccountOverdueError`；OpenAI `insufficient_quota`；Anthropic `billing_error` | 改成 400；停到点“检查”通过为止（最多一天）；通知本人一次（同一个 key 6 小时内不重复） |
| `auth` key 被拒 | 方舟 `AuthenticationError`；OpenAI `invalid_api_key` | 同上，状态码不改 |
| `config` / `server` / `input` | 接入点不对、提供方出错、内容被拒 | 原样交给 Agent，只记录 |

运行失败时，dispatch 用转发在本次运行期间看到的错误改写失败原因（`relayFailure`）：限流算 `rate-limit`，每日用量、额度、key 被拒算 `quota` 并带恢复时间，额度和续跑沿用原有的“额度用完”处理。Codex 把 400 的报错原文当回复交回时，同样按这次运行转发看到的错误判为失败。另外，ACP 回合结束时，回复以 Codex 的那几句报错开头的，也算失败（`acp.ts` 的 `codexErrorReply`：429、5xx 和“high demand”算限流，其余算其他错误）。

API key 页每个 key 那一行写最近一小时各类错误的次数和最近一条，暂停时写“已暂停到 …”。点“检查”通过后，暂停和记录一起清掉（决策模型的暂停也清掉）。没有 RPM / TPM 设置：限多少由提供方说了算，omem 只看它返回什么。

决策模型（`src/core/decision.ts`）出错时用同一套分类：以前统一排到后面 5 分钟，现在限流 1 分钟、每日用量到午夜、额度和 key 被拒一天（检查通过即恢复）、提供方出错 5 分钟；错误也记进 API key 页的那一行。

服务的环境里本来就有 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` 时，所有 Agent 都会继承它，API key 页会提示。

其他支持自带 key 的 Agent（goose、Cline、Kilo、pi、DeepAgents、Factory Droid）各有各的配置方式，还没核对过启动方式，暂不自动生成，可以在通用页编辑后端配置的 `env`。Copilot、Cursor、Amp、Junie、Devin、Gemini CLI、Qwen Code 用自家账号或自家的 key。

## 三类模型

每类一个设置（`config.ai.voice` / `decision` / `image`）：提供方、模型（留空用默认），加上各自的参数。`categoryStatus` 判断能不能用：提供方存在、类型对得上、有 key、模型能确定。不能用时各页写明缺什么。

**检测账号里的模型**：添加或更换 key、点“检查”通过、或列表超过一天时，omem 读提供方的模型列表（OpenAI 和兼容接口 `GET /models`，OpenRouter `GET /v1/models`，Cloudflare `GET …/ai/models/search?search=clef`；TypeSafe、Anthropic 没有），存模型名到数据目录的 `cache/ai-models.json`（`refreshModels`）；列表写了模型支持哪些接口（火山方舟这类服务的 `api_supported`、`domain`、`features.tools`）时一并存下（`info`：`chat` / `responses` / `anthropic`、用途、能否调用工具）。API key 页那一行点“看 N 个模型”展开列表，可按名字筛选，每个模型标出支持的格式和用途。读失败时保留旧列表，API key 页那一行写“模型列表读取失败”。各模型字段（图片、语音 Live / Realtime、转写、委托、决策）按名字筛出合用的（`modelChoices`：图片 `gpt-image-*`，Live `gpt-live*`，Realtime `gpt-realtime*` 去掉 whisper / translate，转写含 transcribe / whisper，委托是 `gpt-数字` 开头的文字模型，OpenAI 决策只有 `gpt-6-luna`（Decisions API 只接受它，2026-11），Cloudflare 是 `clef*`），设置页给下拉选，列表里没有的可以“手填其他…”。

**留空 = 默认**：用这个字段列表里最新的模型（`newestOf`：名字里版本号最大的，带日期的快照不算；版本相同的几个，比如 `gpt-image-2.6-flare` 和 `-sunburst`、`clef` 和 `clef-flash`，取和内置默认同款的那个，再不行按名字排第一个）。列表为空或提供方没有列表时用内置默认（图片 `gpt-image-2.6-flare`、Live `gpt-live-1`、Realtime `gpt-realtime-2.1`、转写 `gpt-transcribe`、委托和 OpenAI 决策 `gpt-6-luna`、Jev `jev-latest`、Clef `clef-flash`）。OpenAI 的委托字段列的是全部文字模型，留空会用版本号最大的那个，要固定用便宜的就在下拉里选定。

### 语音

三个用处：

- **问答页语音输入**：输入框旁的麦克风，录下来交给 `/v1/audio/transcriptions`（默认 `gpt-transcribe`，`ai.voice.transcribeModel`），文字填进输入框，你再改再发。和选哪种实时接口无关。
- **语音对话**：问答页的波形按钮，和助理实时说话。它能用 omem 的只读工具（`list_spaces`、`search`、`read_source`、`recall`、`list_items`、`read_page`），在你能读的空间里查，说出依据的文档名。结束后对话记录存进 `voice_sessions`。
- **插件页面的语音**：清单写了 `voice: true` 的插件，页面可以开一段语音对话（docs/v2/plugins.md 的“语音”）。说明由插件给，不带工具。英语练习的“口语对话”就是这样做的：语音模型扮演场景里的另一个人，卡住时用中文问，结束后由插件的陪练按技能 `english-speaking` 评价并记进学习画像。（2026-11-11 之前它是导航里单独的“口语”页，由 `speaking-coach` 角色评价，已并入英语练习。）

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

插件的语音对话走插件自己的接口（`/api/plugins/<id>/voice/…`），说明是插件给的，不给工具，omem 也不保存记录。麦克风和连接在网页外壳里，插件页面只拿到转写。

GPT-Live 的“client 委托”（`delegation.type = "client"`，由应用自己处理请求、用 `session.commentary.append` 让它说结果）可以把整个 omem 主助手接进来，但主助手一次要几十秒，现在不用；以后要在语音里交办事情时再考虑。

### 决策

设置 → 后端与模型 → 决策 可配置多个模型（最多 9 个），用上移、下移调整顺序。第一个存为 `ai.decision.provider` / `model`，其余存为 `others`；`pick` 为 `fixed`（默认，按顺序先问第一个可用的）或 `random`（每次随机选一个可用的先问）。不可用的跳过，拒答或调用出错时自动问下一个；刚调用出错的模型在 5 分钟内排在其他模型之后。判断记录写明实际回答的提供方和模型，换过时另写“没答上，换了一个”。每行分别显示可用状态和缺少的配置。

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

omem 统一成“材料 + 问题 + 选项 → 选中的一项和每项概率”（`decide`），是 / 否另有 `judgeYesNo`：规则要求用决策模型且配好了就用它，没配好就用通用模型；出错时 `fallback` 是 `general` 就改用通用模型（理由前写明“决策模型出错，改用通用模型”），是 `none` 就按“否”处理。决策模型不写理由，记录里写成“决策模型（提供方 · 模型）：是 0.91”。各家的概率口径不同，门槛要按场景校准；下面四个场景对冒险答案另设最低概率，其他调用仍用模型原来的选择。

同一份材料上的几道题如果不依赖彼此的答案，可以用 `decideMany(app, material, { 题名: question }, opts)` 合成一次请求，按题名取回结果；最多 8 题，超出直接报错，空批不请求。每个模型都收到完整的一批；漏答任何一题都算调用出错，丢掉这次的全部答案，将该模型排到后面 5 分钟，再用下一个模型重问整批。显式拒答也会换模型，但不触发冷却。`decideSceneMany` 的每一题传 `{ question, scene?, ref?, sources? }`：有场景的单独套门槛、写一条 `decisions`，即使材料相同也各存一份按原规则截短的材料；无场景的只返回原答案，不留记录。设置的“试一下”和命令行回放仍逐题调用。

用在哪里：

- **巡检预筛**：默认每 15 分钟巡检时，先看关注、等待中的事项、新材料标题和短片段（聊天取末尾，其他取开头）、事项来源、已发通知和本人此刻的状态。判断无关就不启动助手，运行安静结束并记录预筛结论；跳过的材料默认每 12 小时由助手补看一次，补看不再预筛。设置 → 定时任务，点开“巡检”那一行可关闭或设置 1–72 小时的补看间隔（`heartbeat.gate` / `heartbeat.sweepHours`）。没有决策模型、调用失败或新材料超过 30 份时直接交给助手，到期提醒仍由宿主直接发送。
- **旁听预筛**（会议规则的 `listenPrefilter`，默认开）：会议旁听到了该看的时候，先把本人、规则、要留意的、在会的人和这一段说的（取末尾约 8000 字）交给决策模型，问有没有点本人的名、分给本人的事、改变本人工作的决定（打开“主动查”时还问有没有值得查的具体问题）。判为不用看就不起运行、不推进已读位置，这一段和下一段一起再判断；没有决策模型或调用失败时照常交给 Agent。
- **流程卡点复核**（`flow-blocker`）：合批给出卡点等待说明和新事实摘要。模型认为新情况可能解除或改变卡点且把握达到门槛（默认 0.7）时，才排定向对账。模型不可用时保留原巡检和交付触发。
- **规则**：`judge` 为 `ai` / `code+ai` 的判断和“模型判断”这一步（`check` 动作），按规则的 `judgeWith`：`decision`（默认，决策模型优先）或 `general`（通用模型读完规则和讨论再判断，会写理由）。材料是规则原话、已满足的条件、事件和所在的讨论。规则页“用哪个模型判断”可选，并显示现在有没有可用的决策模型。
- **运行前选 AI**（`agents.routing.choose`，architecture.md 的“运行前自动选 AI”）：选项是“按原来的设置”和任务选型的各候选，每项写着适用说明、占用和账号额度，取概率最高的一项，并按各项的概率排出整个顺序（通用模型直接给 `order`），作为这次运行换后端的顺序（`ChooseResult.order`，排在 `failoverProfiles` 的静态顺序前面）；对话、规则交给的 Agent、交办和后台任务分别设不选 / 有决策模型时选 / 总是选。快用完（`quotaAvoid`）、刚出故障（`downReason`）、被排除（上限 0、额度用完、到了每天上限）的候选不进选项，写进记录的 `left`，免得选中后又被 `acquire` 排到后面。每次运行都记一条 `status` 事件，带 `choice`（`choose-ai.ts` 的 `ChoiceRecord`：`outcome` 为 chosen / kept / skipped / failed、`current`、`picked`、`by`、`reason`、`options`、`left`），没选的也写原因（关着、没有候选、没有决策模型、点名了 AI、接着之前的会话、编码和评审）；换后端的 `status` 事件带 `failover`（`from`、`to`、`why`、`orderBy`、`orderReason`、`pinned`、`chosen`）。
- **成员选型**：成员可用 `/agent`、`/model` 指定自己的会话或个人默认，也可在 **账号 → 个人 AI 设置** 写一段偏好。运行前选型把成员偏好、本人的总体偏好和候选适用说明一起交给决策模型。候选按这次实际能用的账号评估额度。本人额度紧张但有成员账号时，仍可选同一后端。指定后的登录与等待顺序见 [成员 AI 账号](agent-accounts.md#3-运行时怎么选账号)。
- **换后端的顺序**：会在多个后端 / 模型之间取下一个的地方——`failoverProfiles` 的链（本次的 AI、原来的 AI、角色在其他后端配的模型、兜底列表、候选）、`acquire` 把快用完 / 刚出故障的排到后面后取谁、点名的 AI 不可用时的回退、崩溃 / 看门狗 / 上游出错后的接手——都按同一条链走。经过运行前选 AI 的运行，链的前面是选型给出的排序；没经过的（点名了 AI、这类运行不选、没有决策模型）在第一次要换时（第一个 AI 将被排到后面，或它失败了）调一次 `fallbackOrder`：决策模型按总体偏好和候选说明给剩下的排序，按“场景 + 由谁做 + 剩下的选项”缓存 10 分钟，同类运行不再问；没有决策模型、没有选型说明或它出错时保留静态顺序。已排除（上限 0、额度用完、到了每天上限）的仍然跳过，冷却中的仍由 `acquire` 排到后面。记录里的 `orderBy` 是“决策模型按选型说明排的顺序 / 通用模型按选型说明排的顺序 / 设置里的静态顺序（没有决策模型时）”。
- **访客提问的把关**（`ai.decision.gatekeeper`，默认开）：三个选项回答 / 拒绝 / 不理，说明取自 `gatekeeper` 角色。拒绝时回固定的一句（群里“这个需要机器人的主人同意，已经去问了。”，私聊或机器人“这个我不能帮忙。”）。出错时按 `fallback` 交给 `gatekeeper` 角色，或者不理。
- 设置 → 后端与模型 → 决策 有“试一下”：填材料、问题和选项（不填就是是 / 否），看选中的一项、每项概率、用时。

需要读很多原件、调用工具才能判断的事，不交给决策模型。

#### 按场景记录、门槛与回放（2026-11-15）

`decideScene` 包装 `decide`，不改模型顺序、换用、冷却、媒体或出错后的处理。模型选中下面的冒险选项，却没有达到门槛时，调用方采用谨慎选项，并在运行理由里说明原答案、概率、门槛和改判。默认值和设置页、报告都来自 `src/core/decision-scenes.ts` 的 `DECISION_SCENES`（`decision-log.ts` 同时导出）。

| 场景 | 问题 | 冒险选项 | 谨慎选项 | 默认门槛 |
| --- | --- | --- | --- | --- |
| `heartbeat` · 巡检预筛 | 新材料要不要看 | `no` · 不用看 | `yes` · 要看 | 0.6 |
| `watch` · 盯群预筛 | 这一批群聊要不要看 | `no` · 不用看 | `yes` · 要看 | 0.6 |
| `meeting` · 旁听预筛 | 会上这一段要不要交给旁听的 Agent | `no` · 不用看 | `yes` · 要看 | 0.6 |
| `triage` · 有人找你 | 这条消息怎么处理 | `ignore` · 不用管 | `notify` · 简短提醒 | 0.6 |
| `progress` · 直接答复 | 查清后能不能不经本人拍板就答复 | `yes` · 能直接答复 | `no` · 要本人定 | 0.7 |
| `firstlook` · 先看一眼的结论 | 快模型说答完了，是不是真的够了（first-look.md） | `yes` · 够了 | `no` · 接着查 | 0.7 |

设置 → 后端与模型 → 决策可分别改 `ai.decision.thresholds` 的各项，只接受 0.5–0.99；旧配置加载时补默认值。分诊的“交给谁”仍直接调用 `decide`，不套场景门槛。

每次成功判断在 `decisions` 保存时间、场景、实际回答的模型、问题 JSON、材料 JSON、各选项概率、原选择、实际采用的答案、当时门槛和关联运行。巡检另存来源 ID；材料按部分截短，序列化后不超过约 12000 字符。没有可用模型或模型抛错时不写这一条记录。材料是私人数据：和 `quality_audits` 一样，`decisions`、补看关联表 `decision_sweeps` 列在 `test/pull-complete.test.ts` 的设备本地清单，不参与设备拉取合并。每轮标注最多检查 200 条，未成熟的记录延后 15 分钟再查；每轮另分批清理最多 200 条超过 90 天的记录和补看关联，没有新增全库清理。

结果标注紧接巡检中的 `labelOutcomes`：

- 巡检采用“要看”：用 `ref` 主键取巡检运行，结束后查这个运行发出的非静默通知及事项事件；有提醒或事项变化为 `needed`，正常结束且安静为 `unneeded`，失败或三天没有完成结果为 `unclear`。
- 巡检采用“不用看”：`swept` 只为实际交给助手的来源保存补看运行。之后按来源和时间查关联；补看运行的通知 `sourceRefs`、事项事件 `source_refs` 或被修改事项的来源引到其中任一来源，为 `needed`；所有来源都正常补看且没被引用，为 `unneeded`。来源删除、三天未完成补看为 `unclear`。分批补看不会因第一批安静就提前判成不需要。
- 分诊采用“简短提醒 / 先查”：按 mention 运行及其输出的 `handleRun` 找通知，沿用通知的结果。`acted` 为 `needed`，`negative / unread` 为 `unneeded`，`known / read / bundled` 为 `unclear`。通知结果还没标注就等，等满 7 天仍没有结果的记为 `unclear`；被新状态替换掉的通知不算（结果记在替换它的那条上）；72 小时没有通知为 `unclear`。
- 分诊采用“不用管”：48 小时后，从 mention 运行输入里的会话和消息 ID 取原消息时间；按 `lark_messages(chat_id, create_ms)` 查消息后 24 小时内本人发的文字，排除自动回复署名。有回复为 `needed`，没有为 `unneeded`；原消息不可用为 `unclear`。
- 盯群和直接答复只记录，不标注（盯群跳过之后没有补看，直接答复的好坏要看本人对回复的处置），报告里写明。

通知用新增的运行表达式索引，事项事件新增可选 `run_id` 和索引，由 `upsert_item` 写入；不扫描 `runs`、`sources`、`notifications` 或 `lark_messages` 找关联。旧事项事件没有运行关联，不回填历史。

`GET /api/ai/decision/report?days=30` 仅本人可读，设置页显示最近 30 天；`omem decision report --days 30` 和只读设备命令 `decisions` 返回同样统计，不返回材料。每场景列记录数、采用冒险选项数、门槛改判数、三类结果、漏看（冒险后标为需要）与多看（谨慎后标为不需要）。假设门槛为 0.5 / 0.6 / 0.7 / 0.8 / 0.9 时，用原选择和保存的概率重算冒险数、已知漏看数；`unclear` 不进漏看率分母。至少 20 条原来选择冒险的记录有明确结果时，才建议已知漏看率不超过 5% 的最低候选门槛；没有可用候选就维持现状，样本不足显示“有结果的记录还不到 20 条，先按现在的门槛”。报告不会修改设置。结果是事后代理信号，有选择偏差，不能把已知漏看率当成总体准确率。

```sh
omem decision report --days 30
omem decision replay --scene triage --model decision-key:jev-latest --days 30 --limit 200
```

回放顺序读取该场景最近的记录（最多 200 条），把存下来的问题和截短材料交给指定模型，使用 `decide(..., { only })`，不尝试别的模型。连续三次失败停止；失败样本两边都不计入比较。原模型与候选模型都按场景**现在的门槛**计算漏看 / 多看，并输出原选择一致数和采用答案一致数；原模型混用过时列出实际模型名称。回放不写数据库，不更新标签或门槛，但会将材料发给指定提供方，正常产生模型调用费用。天数只接受 1–90，条数只接受 1–200。

### 图片生成

OpenAI Images API（`POST /v1/images/generations`，返回 `data[0].b64_json`）。默认 `gpt-image-2.6-flare`（快，2026-11-04 发布），要精细用 `gpt-image-2.6-sunburst`；可设默认尺寸和质量。

可用后才有工具 `generate_image`（分组 `media`，主助手的 `tools` 里有 `group:media`；Agent 档案要用就加这个分组），以及内置技能 `image-generation`（`requires: [ai:image]`）：没配好时运行里没有这个工具（`runner.ts`），技能也不列给 Agent（`skillUsable`）。图片按内容哈希存进 `files/`，和其他附件一样由 `/api/files/<名字>.png` 提供；工具返回本机路径（给 `lark_send_file`）和网页地址（写进 Wiki 或回答的 Markdown）。每次生成记一条运行事件 `image`。

### 技能的 `requires`

技能的 frontmatter 可以写 `requires: [ai:image]`（或 `ai:voice`、`ai:decision`）：对应的模型没配好时，这个技能不出现在给 Agent 的技能列表和 `list_skills` 里。内置的 `image-generation`、英语插件的 `english-speaking` 都这样标。

## 实现顺序

1. 设置页分类、API key 与提供方、用 key 生成后端、三类模型的设置和可用状态（已完成）。
2. 图片：画图工具（新分组）和配套技能，只在图片模型可用时给出（已完成）。
3. 决策：统一的判断接口（几家 API + StartLux + 通用模型兜底），接入 `gatekeeper` 和规则判断（已完成）。
4. 语音：问答页语音输入、实时对话、口语练习（已完成；口语练习 2026-11-11 并入英语练习插件，宿主改为给插件页面提供语音会话）。

## 资料（2026-11-07 查）

- GPT-Live：[OpenAI 公告](https://openai.com/index/introducing-gpt-live-1-in-the-api/)、[语音 WebSocket 指南](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- Decisions API：[官方指南](https://developers.openai.com/api/docs/guides/decisions)（请求与返回格式以它为准，每次最多 400 个问题，打分 2–10 档）
- Clef：[Cloudflare 博客：Clef-omni 与更快更便宜的 Clef](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)、[Workers AI 更新记录](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)、[Workers AI 的 clef-omni 页面](https://developers.cloudflare.com/workers-ai/models/clef-omni/)（输入输出格式和媒体上限）、[Hugging Face 上的 clef-flash](https://huggingface.co/Cloudflare/clef-flash)
- Jev：[OpenRouter 的 Jev 文档](https://openrouter.ai/docs/guides/community/jev)、[TypeSafe SDK 经 OpenRouter](https://openrouter.ai/docs/guides/community/typesafe-sdk.md)、[MixRoute 的 Jev 接口](https://mixroute.ai/docs/api-reference/endpoint/jev)（选择最多 255 项）
- GPT-Live 与 Realtime：[语音 WebRTC 指南](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)、[GPT-Live 委托](https://developers.openai.com/api/docs/guides/live-delegation)、[Realtime 服务端事件](https://developers.openai.com/api/reference/resources/realtime/server-events)、[语音转文字](https://developers.openai.com/api/docs/guides/speech-to-text)
- 图片：[图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[模型列表](https://developers.openai.com/api/docs/models)
- Codex 的 key 变量：[codex-acp](https://github.com/zed-industries/codex-acp)、[Codex 认证](https://developers.openai.com/codex/auth)
