import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { touchWhileBusy, treeCpuTicks } from "../src/agents/spawn.ts";

describe("进程树的 CPU 活动", () => {
  it.skipIf(process.platform !== "linux")("子进程一直在算时保持看门狗，安静下来就不再续", async () => {
    // A quiet parent whose grandchild burns CPU: like a print-mode agent running a long test.
    const child = spawn("sh", ["-c", `node -e "const t=Date.now();while(Date.now()-t<1500){}" ; sleep 2`], { stdio: "ignore" });
    try {
      let touches = 0;
      const stop = touchWhileBusy(child.pid, { touch: () => { touches++; } }, 200);
      await new Promise((r) => setTimeout(r, 1300));
      const busy = touches;
      expect(busy).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 1500));
      const before = touches;
      await new Promise((r) => setTimeout(r, 800));
      expect(touches).toBe(before);
      stop();
    } finally { child.kill("SIGKILL"); }
  });
  it.skipIf(process.platform === "linux")("不是 Linux 时不判断（只按输出续）", () => {
    expect(treeCpuTicks(process.pid)).toBeUndefined();
  });
});
