import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as adapter from "../src/agents/adapter.ts";
import { forgetAvailability } from "../src/agents/availability.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

describe("installing and upgrading a backend's npm package from settings", () => {
  it("only for catalog backends with an npm package", async () => {
    await expect(adapter.installAdapter(app, "cursor")).rejects.toThrow(/不是目录里带 npm 包的后端/);
    await expect(adapter.installAdapter(app, "nothing-like-this")).rejects.toThrow(/不是目录里带 npm 包的后端/);
    expect(adapter.canInstall(app, "cursor")).toBe(false);
    expect(adapter.adapterJob("gemini")).toBeNull();
  });

  // A fake npm on PATH that "installs" gemini slowly into a prefix, the way a global install lays it out.
  describe.skipIf(process.platform === "win32")("as a background job", () => {
    const root = mkdtempSync(join(tmpdir(), "omem-adapter-"));
    const bin = join(root, "bin"), prefix = join(root, "prefix");
    const path = process.env.PATH;
    beforeEach(() => {
      mkdirSync(bin, { recursive: true });
      const script = [
        "#!/bin/sh",
        'case "$1" in view) echo 9.9.9; exit 0;; esac',
        "sleep 1",
        'echo "added 1 package"',
        `d="${prefix}/lib/node_modules/@google/gemini-cli"; mkdir -p "$d" "${prefix}/bin"`,
        `printf '{"name":"@google/gemini-cli","version":"9.9.9"}' > "$d/package.json"`,
        `printf '#!/bin/sh\\nexit 0\\n' > "$d/cli.js"; chmod +x "$d/cli.js"`,
        `ln -sf "$d/cli.js" "${prefix}/bin/gemini"`,
      ].join("\n");
      writeFileSync(join(bin, "npm"), script);
      chmodSync(join(bin, "npm"), 0o755);
      // No osdk here: the job goes through npm. PATH keeps sh, mkdir and friends.
      process.env.PATH = [bin, join(prefix, "bin"), "/usr/bin", "/bin"].join(":");
      forgetAvailability();
      adapter.resetAdapterJobsForTests();
    });
    afterEach(() => {
      process.env.PATH = path;
      forgetAvailability();
    });

    it("returns at once, refuses a second start, and ends with the command found", async () => {
      expect(adapter.canInstall(app, "gemini")).toBe(true);
      const job = await adapter.installAdapter(app, "gemini");
      expect(job).toMatchObject({ id: "gemini", action: "install", via: "npm", running: true, before: null });
      expect(job.command).toMatch(/^npm i -g @google\/gemini-cli@latest/);
      await expect(adapter.installAdapter(app, "gemini")).rejects.toThrow(/正在安装/);
      const end = await adapter.waitForAdapterJob("gemini");
      expect(end).toMatchObject({ running: false, ok: true, after: "9.9.9" });
      expect(end!.output).toMatch(/added 1 package/);
      expect(existsSync(join(prefix, "bin", "gemini"))).toBe(true);
      expect(adapter.canInstall(app, "gemini")).toBe(false);
      expect(adapter.hasAdapter(app, "gemini")).toBe(true);
    }, 30_000);
  });
});
