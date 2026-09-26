import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
const config = loadConfig();
const { app } = await buildApp(config);
await app.listen({ port: config.port, host: config.host });
console.log(`omem listening at http://${config.host}:${config.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
