import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/core/app.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";

export function testApp() {
  const home = mkdtempSync(join(tmpdir(), "omem-test-"));
  const app = App.open(home);
  ensurePersonalSpace(app);
  // Tests exercise notify/items directly, not the ingest first-nudge grace window.
  app.config.notify.firstNudgeDelayMinutes = 0;
  return app;
}
