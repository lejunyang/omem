import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/core/app.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";

export function testApp(at?: string) {
  const home = at ?? mkdtempSync(join(tmpdir(), "omem-test-"));
  const app = App.open(home);
  ensurePersonalSpace(app);
  // Tests exercise notify/items directly, not the ingest first-nudge grace window.
  app.config.notify.firstNudgeDelayMinutes = 0;
  // Delegations in tests start coding at once; test/pre-check.test.ts turns the check before coding on.
  app.config.agents.autoAdvance.preCheck = false;
  // Turns start their agent directly; test/agent-host.test.ts turns hosts on (OMEM_TEST_HOSTED=1 runs any suite through them).
  app.config.agents.restartHold.enabled = process.env.OMEM_TEST_HOSTED === "1";
  return app;
}

/** Character-count vectors for setEmbedderForTests: texts sharing many characters are close. */
export function fakeEmbedder(id = "test:chars") {
  return {
    id,
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Float32Array(256);
        for (const ch of t) v[ch.codePointAt(0)! % 256] += 1;
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}
