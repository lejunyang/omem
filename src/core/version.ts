import { readFileSync } from "node:fs";

let cached: string | undefined;

/** The installed @omem-ai/app version, read from its package.json (src/core and dist/src/core both sit under the package root). */
export function packageVersion(): string {
  if (cached) return cached;
  for (const rel of ["../../package.json", "../../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.name === "@omem-ai/app" && typeof pkg.version === "string") return (cached = pkg.version);
    } catch {}
  }
  return (cached = "dev");
}
