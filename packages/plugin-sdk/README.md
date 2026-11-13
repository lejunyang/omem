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
  connection; the page gets the transcript only), and `renderBlock` / `renderView` for the agent's questions (forms) and views (tables, charts, comparisons) in a session.
- `@omem-ai/plugin-sdk/blocks`: `renderBlock` and `renderView` alone, without a framework.
- `@omem-ai/plugin-sdk/service`: for a plugin's service (Node): `serve({ http, socket })` on
  `127.0.0.1:OMEM_SERVICE_PORT`, refusing requests without omem's token.

omem's styles (buttons, inputs, cards, theme tokens) are at `/plugins/_sdk/omem.css` on the omem
server. Plugins in omem's data directory need not install this package: omem serves the same SDK at
`/plugins/_sdk/omem.js` and passes the service helper's path in `OMEM_SERVICE_SDK`.

The plugin format: [docs/v2/plugins.md](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md).
