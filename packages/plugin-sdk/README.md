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
- `@omem-ai/plugin-sdk/charts`: the charts and figures those blocks draw (`mountChart`, `metricsElement`, `sparkline`), for a page that wants them without a block. Colours come from omem's `--chart-*` tokens (`/plugins/_sdk/omem.css`).
- `@omem-ai/plugin-sdk/service`: for a plugin's service (Node): `serve({ http, socket })` on
  `127.0.0.1:OMEM_SERVICE_PORT`, refusing requests without omem's token.

omem's styles (buttons, inputs, cards, theme tokens) are at `/plugins/_sdk/omem.css` on the omem
server. Plugins in omem's data directory need not install this package: omem serves the same SDK at
`/plugins/_sdk/omem.js` and passes the service helper's path in `OMEM_SERVICE_SDK`.

The plugin format: [docs/v2/plugins.md](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md).

## 场景包与聊天渠道

插件清单支持 `rules: [名称]`（`rules/<名>.yaml`，首次导入且停用）和 `mcp`（命令 / 网址、变量 / 请求头名字列表，密钥值由本人在 Agent 页填）。`omem plugin pack` 可导出现有档案、完整技能目录、规则和 MCP；默认写到数据目录 `plugins-out/`，拒绝文本中的已存密钥和用户目录绝对路径。安装接受本地目录并复制，命令 MCP 要先信任插件。

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
