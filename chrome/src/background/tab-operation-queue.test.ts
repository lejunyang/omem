import { expect, test } from "vitest";
import { createTabOperationQueue } from "./tab-operation-queue";

test("a late replay cannot resurrect disabled state, other tabs proceed independently", async () => {
  const run = createTabOperationQueue();
  let release!: () => void;
  let enabled = true;
  let replays = 0;
  const first = run(1, async () => { await new Promise<void>((resolve) => { release = resolve; }); replays++; });
  const disable = run(1, async () => { enabled = false; });
  const staleReplay = run(1, async () => { if (enabled) replays++; });
  await run(2, async () => { expect(enabled).toBe(true); });
  release();
  await Promise.all([first, disable, staleReplay]);
  expect(replays).toBe(1);
  expect(enabled).toBe(false);
});

test("failed commands do not block a subsequent recovery", async () => {
  const run = createTabOperationQueue();
  await expect(run(1, async () => { throw new Error("detached"); })).rejects.toThrow("detached");
  await expect(run(1, async () => "recovered")).resolves.toBe("recovered");
});
