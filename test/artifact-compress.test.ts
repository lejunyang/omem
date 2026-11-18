import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactInbox, artifactPath, collectInbox } from "../src/agents/artifacts.ts";
import { createRun } from "../src/agents/runs.ts";
import { toolCommand } from "../src/core/tools.ts";
import { testApp } from "./helpers.ts";

/** A screenshot-like PNG big enough to be worth compressing. */
function screenshot(dir: string, name: string) {
  const ff = toolCommand("ffmpeg")!;
  execFileSync(ff[0], [...ff.slice(1), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x800", "-frames:v", "1", join(dir, name)]);
}

describe("screenshots handed in follow the media compression settings", () => {
  it.skipIf(!toolCommand("ffmpeg"))("compresses when media.auto covers images, and leaves them alone when it is off", async () => {
    const app = testApp();
    app.config.media = { concurrency: 1, auto: { enabled: true, types: ["image"], mode: "lossy", quality: "medium", maxSide: 0, minBytes: 1024, deleteOriginals: true } };
    const on = createRun(app, { kind: "flow-stage", spaceId: "personal", title: "复现", input: {} });
    screenshot(artifactInbox(app, on.id), "repro-01.png");
    const [shot] = (await collectInbox(app, on.id, { source: "agent", by: "assistant" })).made;
    expect(shot.entry).toBe("repro-01.webp");
    expect(shot.mime).toBe("image/webp");
    expect(statSync(artifactPath(app, shot)).size).toBe(shot.size);
    expect(existsSync(join(artifactPath(app, shot), "..", "repro-01.png"))).toBe(false);

    app.config.media.auto.enabled = false;
    const off = createRun(app, { kind: "flow-stage", spaceId: "personal", title: "复现", input: {} });
    screenshot(artifactInbox(app, off.id), "repro-02.png");
    const [kept] = (await collectInbox(app, off.id, { source: "agent", by: "assistant" })).made;
    expect(kept.entry).toBe("repro-02.png");
  });
});
