import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
const config = loadConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
console.log(`omem listening at http://${config.host}:${config.port}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    // Let native model workers finish tearing down instead of forcing Bun to
    // exit in the middle of native-addon cleanup.
    void app
      .close()
      .then(() => {
        // PM2's IPC channel otherwise keeps an already-closed Node server alive.
        if (process.connected) process.disconnect();
      })
      .catch((error) => {
        console.error("omem shutdown failed", error);
        process.exitCode = 1;
      });
  });
