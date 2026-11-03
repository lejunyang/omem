import { describe, expect, it } from "vitest";
import { createRun, getRun, registerHandler, startWorker, stopWorker } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

describe("stopping the service", () => {
  it("leaves a run that fails while its sessions close as running, for the next start to queue again", async () => {
    const app = testApp();
    try {
      let fail!: (e: Error) => void;
      let started!: () => void;
      const running = new Promise<void>((ok) => (started = ok));
      registerHandler("brief", () => { started(); return new Promise((_, no) => (fail = no)); });
      startWorker(app);
      const r = createRun(app, { kind: "brief", spaceId: "personal", title: "简报", input: {} });
      await running;
      stopWorker();
      fail(new Error("ACP connection closed"));
      await new Promise((ok) => setTimeout(ok, 50));
      expect(getRun(app, r.id)).toMatchObject({ status: "running", error: null });
      // Nothing new starts meanwhile.
      const later = createRun(app, { kind: "brief", spaceId: "personal", title: "又一份", input: {} });
      await new Promise((ok) => setTimeout(ok, 2500));
      expect(getRun(app, later.id).status).toBe("queued");
    } finally {
      app.db.close();
    }
  });
});
