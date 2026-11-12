import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The data directory (`OMEM_HOME`, else `~/.omem`). Its own file with nothing but Node built-ins:
 * the light client (packages/cli) bundles it without the server's config schema.
 */
export function omemHome(): string {
  if (process.env.OMEM_HOME) return resolve(process.env.OMEM_HOME);
  return join(homedir(), ".omem");
}
