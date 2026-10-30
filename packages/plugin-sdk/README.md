# omem-plugin-sdk

The SDK for [omem](https://github.com/lejunyang/omem) plugins. A plugin's page runs in a sandboxed
iframe inside omem; this is how it talks to omem.

```ts
import { connect } from "omem-plugin-sdk";

const omem = await connect();             // waits for the shell: theme, route params
const sessions = await omem.get("sessions");
omem.on((event) => { /* this plugin's server events */ });
const live = omem.stream("live");         // a WebSocket to the plugin's service, through omem
```

- `omem-plugin-sdk`: `connect()` → `get` / `post` (only `/api/plugins/<this plugin>/…`), `on`,
  `navigate`, `openSettings`, `stream`, and `renderBlock` for omem's forms and charts.
- `omem-plugin-sdk/blocks`: `renderBlock` alone, without a framework.
- `omem-plugin-sdk/service`: for a plugin's service (Node): `serve({ http, socket })` on
  `127.0.0.1:OMEM_SERVICE_PORT`, refusing requests without omem's token.

omem's styles (buttons, inputs, cards, theme tokens) are at `/plugins/_sdk/omem.css` on the omem
server. Plugins in omem's data directory need not install this package: omem serves the same SDK at
`/plugins/_sdk/omem.js` and passes the service helper's path in `OMEM_SERVICE_SDK`.

The plugin format: [docs/v2/plugins.md](https://github.com/lejunyang/omem/blob/main/docs/v2/plugins.md).
