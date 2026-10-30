import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The published build (npm): client and blocks as ES modules; types come from tsc (tsconfig.json).
const at = (f: string) => fileURLToPath(new URL(f, import.meta.url));
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    lib: { entry: { client: at("client.ts"), blocks: at("blocks.ts") }, formats: ["es"], fileName: (_, name) => `${name}.js` },
  },
});
