import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Exercise the same member, callback server and token fixtures against the shipped modules.
export default defineConfig({
  ...base,
  resolve: {
    alias: [{
      find: /^\.\.\/src\/(.+)\.ts$/,
      replacement: fileURLToPath(new URL("./dist/src/$1.js", import.meta.url)),
    }],
  },
  test: { ...base.test, include: ["test/egress-sandbox.test.ts"] },
});
