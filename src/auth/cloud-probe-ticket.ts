import { randomBytes } from "node:crypto";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { sha256 } from "../core/util.ts";

/** The local CLI can write the library. Only the probe route redeems its single-use ticket. */
export function issueProbeTicket(app: App) {
  const token = "om_probe." + randomBytes(24).toString("base64url");
  const now = Date.now();
  run(app.db, "delete from kv where key glob 'cli-probe:*' and cast(value as integer)<=?", now);
  run(app.db, "insert into kv(key,value) values(?,?)", "cli-probe:" + sha256(token), String(now + 60_000));
  return token;
}

export function consumeProbeTicket(app: App, token: string) {
  return run(app.db, "delete from kv where key=? and cast(value as integer)>?", "cli-probe:" + sha256(token), Date.now()).changes === 1;
}
