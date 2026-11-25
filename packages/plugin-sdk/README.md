# @omem-ai/plugin-sdk

The SDK for [omem](https://github.com/lejunyang/omem) plugins. A plugin's page runs in a sandboxed
iframe inside omem; this is how it talks to omem.

```ts
import { connect } from "@omem-ai/plugin-sdk";

const omem = await connect();             // waits for the shell: theme, route params
const sessions = await omem.get("sessions");
omem.on((event) => { /* this plugin's server events */ });
const live = omem.stream("live");         // a WebSocket to the plugin's service, through omem
// In a click handler, with `voice: true` in plugin.yaml: a conversation with omem's voice model.
const call = await omem.voice({ instructions: "Play a waiter…", onTurns: (turns) => draw(turns) });
const { transcript } = await call.stop();
```

- `@omem-ai/plugin-sdk`: `connect()` → `get` / `post` (only `/api/plugins/<this plugin>/…`), `on`,
  `navigate`, `openSettings`, `stream`, `voice` / `voiceStatus` (omem holds the microphone and the
  connection; the page gets the transcript only), and `renderBlock` / `renderView` for the agent's questions (forms) and views (metrics, callouts, tables, charts, comparisons) in a session.
- `@omem-ai/plugin-sdk/blocks`: `renderBlock` and `renderView` alone, without a framework.
- `@omem-ai/plugin-sdk/charts`: the charts and figures those blocks draw (`mountChart`, `metricsElement`, `sparkline`), for a page that wants them without a block. Colours come from omem's `--chart-*` tokens (`/plugins/_sdk/omem.css`). A chart draws itself in once when first seen; `setChartMotion(false)`, `data-chart-still` on an ancestor or `prefers-reduced-motion` turn that off.
- `@omem-ai/plugin-sdk/service`: for a plugin's service (Node): `serve({ http, socket })` on
  `127.0.0.1:OMEM_SERVICE_PORT`, refusing requests without omem's token.

omem's styles (buttons, inputs, cards, theme tokens) are at `/plugins/_sdk/omem.css` on the omem
server. Plugins in omem's data directory need not install this package: omem serves the same SDK at
`/plugins/_sdk/omem.js` and passes the service helper's path in `OMEM_SERVICE_SDK`.

The plugin format: [docs/v2/plugins.md](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md).

## 带状态的对象与信号

服务端由宿主传入的 `api` 支持 `api.object`，本包从主入口导出 `PluginObject / PluginObjectState / PluginObjectContext / PluginObjectApi / PluginSignal / PluginConnection / PluginHook / PluginHookRequest / PluginHookResult` 类型；沿用页面 SDK 的类型导出和声明构建方式，不把宿主的 App 和完整 PluginApi 带进页面包。

```ts
import type { PluginObject } from "@omem-ai/plugin-sdk";

const object: PluginObject = {
  kind: "pull-request",
  label: "合并请求",
  match: (url) => url === "https://github.com/example/shop/pull/7" ? "example/shop#7" : null,
  read: async (ctx, key) => {
    const connection = await ctx.connection("connect-github");
    if (!connection) throw new Error("请先连接 GitHub");
    const response = await connection.fetch("/repos/example/shop/pulls/7");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pr = await response.json();
    return { title: pr.title, status: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : "open", link: pr.html_url };
  },
  statuses: { open: "进行中", merged: "已合并", closed: "已关闭" },
  final: ["merged", "closed"],
  poll: { minutes: 5 },
};
// register(api) 中调用 api.object(object)。
```

完整的链接匹配、读取及字段例子在 `plugins/github/server.ts`。宿主全名为 `<插件 id>:<kind>`；kind 用小写字母开头，后接小写字母、数字或短横线。statuses 非空，final 必须是已声明状态；poll 默认 5 分钟，最短 1 分钟。对象只有事项关联且事项未结束、对象未到终态时才轮询，始终用事项主人的连接，按插件既有的进程内或隔离方式执行。插件停用或卸载后保留最后状态并标记来源已停用，不再轮询。

`ctx.emit({ kind: "received", keys: { object: "example/shop#7" }, payload: { note: "状态已读取" } })` 记录 `plugin.<插件 id>.received`，keys 与 payload 序列化后各不超过 4000 字符；本步只记录，不触发规则或流程。对象状态变化由宿主另记 `object.<全名>.<状态>` 并推进关联事项。不提供写平台对象的动作或按钮；界面插槽见下一节。

`read` 可以多交 `revision`（你自己定的变化标记，比如头提交加评论数）和 `note`（这次变了什么）：状态没变而修订变了，宿主记 `object.<全名>.updated`，流程可以写 `done: { object, status: "updated" }`，规则的对象触发可选“有更新”。`updated` 是保留字，不能当状态名。

平台能发 webhook 时声明回调（`PluginHook`），宿主马上重读你说的对象，不用等轮询：

```ts
api.hook({ name: "mr", label: "合并请求有变化", handle(ctx, req) {
  // req.body 是原始文本，平台的签名自己校验
  const e = JSON.parse(req.body);
  return { refresh: [{ kind: "pull-request", key: e.key }] };
} });
```

地址是 `POST /api/hooks/<插件 id>/mr/<密钥>`，密钥由本人在 设置 → 插件 生成；每分钟最多 60 次，正文最大 1 MB，每次写审计。

平台能配置请求头时，优先用不带密钥的 `POST /api/hooks/<插件 id>/mr`，设置 `Authorization: Bearer <密钥>`，或按 `secretHeader` 声明的名字直接传密钥。旧路径仍可用。

`PluginHookOptions` 可声明 `ack: "first"`：宿主先持久化、再应答，之后调用 `handle`，失败有限重试，重启继续。不声明就同步处理。`dedup.headers` 可替换常见投递标识头，`dedup.bodyFields` 可取 JSON 正文的点号路径，`dedup.requireMatch` 要求两处都提供并一致，否则 400。`dedup.windowHours` 默认 24；同一标识下用原始正文哈希区分重复和冲突。额外签名头填进 `headers`，认证头不下传；`rateLimit` 可设 `perMinute` 和 `burst`。

`req.event` 提供 `format`、`data` 和 `trust: "untrusted"`。原始文本仍在 `req.body`，`req.deliveryId` 是处理重试和发送方重投共用的收件编号，`req.deliveryKey` 是发送方的标识（没提供就是 `null`）。支持 `webhook` 和 `openai-chat`（最后一条用户文本），默认自动识别。异步模式的 2xx 只表示收件。

异步回调可用 `accept(req, { duplicate, conflict, deliveryId })` 同步返回 `{ status, headers?, body }`，不做 I/O，不拿插件上下文。只有首次投递返回 2xx 才执行 `handle`；重复和冲突都不执行。默认冲突回 409，抛错或超时回 500。可用 `unauthorizedBody`、`rateLimitedBody`、`unavailableBody` 自定 401、429、503 的 JSON 体。完整示例见 `docs/v2/plugins.md`。

### 动作

对象可以声明按钮（`PluginObjectAction`）。每个动作是本插件自己的一个工具，宿主把对象的键放进 `arg`（默认 `key`）调用它：

```ts
api.tool({ name: "shop_merge", description: "合并一个合并请求", schema: api.z.object({ pr: api.z.string() }), write: true,
  handler: async (ctx, a) => { const c = await ctx.connection("connect-github"); /* 用 c.fetch 调平台，令牌由宿主代加 */ return "已合并"; } });
api.object({ ...object, actions: [{ id: "merge", label: "合并", tool: "shop_merge", arg: "pr", statuses: ["open"], confirm: "检查没过时平台会拒绝。" }] });
```

- `id` 小写字母开头；`label` 不超过 20 字；`tool` 必须以 `<插件 id>_` 开头；`statuses` 必须是已声明的状态，不写是任何状态都显示；`confirm` 是确认框里多说的一句。
- 事项页对象卡上按当前状态出按钮。本人点了确认后直接执行（不出审批卡片）；Agent 调用同一个工具时走它的审批档位，第一次见到时是“每次问”。每次执行写审计，执行完宿主马上重读一次对象。
- 动作工具放在 `object-actions` 分组，主助手可以用。插件拿不到令牌：工具里照常用 `ctx.connection(...).fetch` 代发；隔离运行的插件同样可以声明动作。GitHub 的“合并”（`github_merge_pull_request`）是完整例子。

## 界面插槽

服务端的 `api.slot(at, { block, when })` 把一个只展示的内容块放到 omem 自己的页面上：`item.panel`（事项页侧栏）、`flow.stage`（流程阶段下面）、`today`（今日页）。本包从主入口导出 `PluginSlot / PluginSlotWhen / PluginSlotPlace / PluginSlotContext / PluginSlotView / PluginSlotBlock / PluginSlotApi` 类型（`slots.ts`）。

```ts
import type { PluginSlotBlock } from "@omem-ai/plugin-sdk";

type Checks = { passed: number; failed: number };
const checks: PluginSlotBlock<Checks> = {
  // ctx：看页面的人（ctx.userId）、事项所在的空间（ctx.spaceId）；slot：位置、事项、阶段和对象（键、标题、状态、链接）
  load: async (ctx, slot) => {
    const c = await ctx.connection("connect-github");
    if (!c || !slot.object) return { passed: 0, failed: 0 };
    return countChecks(await (await c.fetch(`/repos/example/shop/commits/main/check-runs`)).json());
  },
  view: (d) => ({ title: "检查", components: [{ type: "metric", items: [{ label: "通过", value: d.passed }, { label: "失败", value: d.failed, good: "down" }] }] }),
};
// register(api) 里，先声明对象和块，再放插槽：
// api.block({ kind: "ci_summary", description: "合并请求的检查结果", display: true, schema, ...checks });
// api.slot("item.panel", { block: "ci_summary", when: { object: "pull-request" } });
```

- `when.object` 是本插件的对象类型：事项页侧栏上要求事项挂着这种对象（一个对象一块），阶段下面要求这一段跟着这种对象；`when.stage`（只用于 `flow.stage`）、`when.flow`、`when.space` 可写一个或一组。今日页不能写条件。
- `load` 的结果按块的 `schema` 校验，`view` 的结果按展示组件校验（`renderView` 画的那些，不能放交互页 `page`）；任何一步出错只是这一块显示错误。15 秒没结果算失败。
- 声明错了（位置、块、条件、对象类型不对，或块不是 `display: true`、缺 `load` / `view`），插件代码加载失败。只有在 omem 里运行的代码能声明插槽；插件停用或撤销信任时插槽消失。

开发插件时可以 `omem plugin link <目录>`：不复制，改了自动重新加载，信任按目录记。包里有 `build` 脚本、清单的 `server`（例如 `dist/server.js`）或服务脚本还没构建时，`omem plugin install` 先列出装依赖和构建的命令，确认后才运行。

## AI 账号的登录方式

成员用自己的 AI 账号时，插件可以给某个后端提供登录方式：`api.agentLogin(def)`，主入口导出 `AgentLoginDef / AgentLoginContext / AgentLoginResult / AgentLoginApi` 类型。`login(ctx)` 调 `ctx.show({ url, code })` 让 omem 把链接和验证码给这个人（网页上和飞书私聊里），把凭据写到 `ctx.env` 指的位置（他的账号目录里），需要时用 `ctx.secret.set()` 存一份按人保存的秘密，返回 `{ user, expiresAt }`；可选的 `refresh(ctx)` 在到期前 10 分钟被调用，返回新的 `{ expiresAt }` 或 `null`（要重新登录）；可选的 `logout(ctx)` 在他退出时清理。清单声明 `permissions.agentLogin: [<后端>]`，只在 omem 进程里运行。完整说明见 [plugins.md](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md) 的“AI 账号的登录方式”。

## 场景包与聊天渠道

插件清单支持 `rules: [名称]`（`rules/<名>.yaml`，首次导入且停用）、`flows: [id]`（`flows/<id>.yaml`，流程定义，启用时补进流程清单，本人已有同 id 的不覆盖，删掉的不再加回来）和 `mcp`（命令 / 网址、变量 / 请求头名字列表，密钥值由本人在 Agent 页填）。`omem plugin pack` 可导出现有档案、完整技能目录、规则、流程和 MCP；默认写到数据目录 `plugins-out/`，拒绝文本中的已存密钥和用户目录绝对路径。安装接受本地目录并复制，命令 MCP 要先信任插件。完整的场景包例子（流程 + 技能 + 对象状态变化规则）在仓库的 `examples/plugins/ghdelivery`。

服务端的 `register(api)` 可以调用 `api.channel`，它由 omem 宿主提供；本包当前导出页面 SDK、内容块和服务帮助模块，不单独导出宿主的 `PluginApi` 类型。完整接口见 [plugins.md 的渠道](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md#渠道)：

```ts
export default function register(api) {
  const channel = api.channel({
    id: "matrix",
    label: "Matrix",
    owner: (settings) => settings.ownerId,
    maxLength: 4000,
    send: async ({ chatId, topicId }, text) => {
      // text 已按 maxLength 分段，用平台客户端发送。
    },
    // 渠道被停掉时调用一次：关掉自己开的监听、定时器和连接。
    close: () => client.stop(),
  });
  // 平台监听器收到消息时：
  // await channel.receive({ chatId, topicId, isGroup, senderId, text, messageId, addressed: true });
}
```

清单加 `settings: [{ key: ownerId, label: 本人在这个平台上的 id, type: text }]`。渠道只能在 omem 进程里运行，信任并启用后才注册；不支持隔离模式。宿主管身份和会话，群里只回答 `addressed` 的消息；通知给平台身份 id 对应的私聊。停用或撤销信任后宿主注销发送器和通知 sink，旧 `receive` 失效，发送错误只记录。
