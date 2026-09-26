import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import { profileSchema } from "../../../packages/contracts/src/index.js";
const schema = z
  .object({
    profiles: z.array(profileSchema).min(1),
    notifications: z
      .object({ mode: z.enum(["instant", "digest"]).default("instant") })
      .default({ mode: "instant" }),
    captureRoots: z.array(z.string()).default([]),
  })
  .strict();
export function loadConfig() {
  const file = resolve(process.env.OMEM_CONFIG || "omem.local.json");
  const config = schema.parse(
    JSON.parse(
      readFileSync(
        existsSync(file) ? file : resolve("config/omem.example.json"),
        "utf8",
      ),
    ),
  );
  if (new Set(config.profiles.map((p) => p.id)).size !== config.profiles.length)
    throw Error("Duplicate agent profile ID");
  const dataDir = resolve(process.env.OMEM_DATA_DIR || ".omem");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    ...config,
    dataDir,
    agentCwd: join(dataDir, "agent-workspace"),
    token: process.env.OMEM_TOKEN,
    host: process.env.OMEM_HOST || "127.0.0.1",
    port: Number(process.env.OMEM_PORT || 4317),
  };
}
export type Config = ReturnType<typeof loadConfig>;
