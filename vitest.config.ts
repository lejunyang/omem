import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node", pool: "forks", testTimeout: 20000, setupFiles: ["test/setup.ts"] },
  server: { deps: { external: [/node:sqlite/] } },
});
