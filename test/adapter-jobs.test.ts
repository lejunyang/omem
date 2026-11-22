import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("knows what a registry backend was added at and moves an npx one to the registry's version", async () => {
    const reg = await import("../src/agents/registry-update.ts");
    const dl = join(app.home, "agents", "antigravity-acp", "1.5.2", "agy_acp_server.par");
    expect(reg.registrySource(app.home, { id: "antigravity-acp", transport: "acp", command: dl, args: [] })).toMatchObject({ kind: "download", registryId: "antigravity-acp", version: "1.5.2" });
    expect(reg.registrySource(app.home, { id: "auggie", transport: "acp", command: "npx", args: ["-y", "@augmentcode/auggie@0.37.0", "--acp"] })).toMatchObject({ kind: "npx", pkg: "@augmentcode/auggie", version: "0.37.0", at: 1 });
    expect(reg.registrySource(app.home, { id: "fa", transport: "acp", command: "uvx", args: ["fast-agent-acp==0.10.63"] })).toMatchObject({ kind: "uvx", pkg: "fast-agent-acp", version: "0.10.63" });
    expect(reg.registrySource(app.home, { id: "codex", transport: "acp", command: "codex-acp", args: [] })).toBeNull();
    expect(reg.versionNewer("2026.11.19", "2026.9.30")).toBe(true);
    expect(reg.versionNewer("0.37.0", "0.37.0")).toBe(false);
    expect(reg.versionNewer("3000.14.30821", "3000.14.9")).toBe(true);

    app.config.agents.profiles = [...app.config.agents.profiles, { id: "auggie", name: "Auggie (ACP)", transport: "acp", command: "npx", args: ["-y", "@augmentcode/auggie@0.37.0", "--acp"], env: {}, idleTimeoutMs: 600_000 } as any];
    reg.resetRegistryCacheForTests([{ id: "auggie", name: "Auggie", version: "0.38.1", distribution: { npx: { package: "@augmentcode/auggie@0.38.1", args: ["--acp"] } } }]);
    const status = await reg.registryStatus(app, "auggie");
    expect(status).toMatchObject({ version: "0.37.0", latest: "0.38.1", upgradable: true, via: "npx" });
    adapter.resetAdapterJobsForTests();
    // Stubbing the registry fetch: upgradeRegistryAgent asks it afresh, so keep the cache warm through fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ agents: [{ id: "auggie", name: "Auggie", version: "0.38.1", distribution: { npx: { package: "@augmentcode/auggie@0.38.1", args: ["--acp"] } } }] }))) as typeof fetch;
    try {
      await reg.upgradeBackend(app, "auggie");
      const end = await adapter.waitForAdapterJob("auggie");
      expect(end).toMatchObject({ ok: true, before: "0.37.0", after: "0.38.1", via: "npx" });
      expect(app.config.agents.profiles.find((p) => p.id === "auggie")!.args).toEqual(["-y", "@augmentcode/auggie@0.38.1", "--acp"]);
      await expect(reg.upgradeBackend(app, "auggie", "1.0.0")).rejects.toThrow(/不能指定 version/);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 60_000);

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

    it("falls back to npm in the same job when osdk refuses to install", async () => {
      rmSync(prefix, { recursive: true, force: true });
      forgetAvailability();
      // osdk and node present: the install goes through osdk first, which refuses like it does with a private registry in ~/.npmrc.
      writeFileSync(join(bin, "osdk"), "#!/bin/sh\necho 'error: cannot safely isolate global npm install: registry preflight passed through' >&2\nexit 1\n");
      writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "osdk"), 0o755);
      chmodSync(join(bin, "node"), 0o755);
      try {
        const job = await adapter.installAdapter(app, "gemini");
        expect(job.via).toBe("osdk");
        const end = await adapter.waitForAdapterJob("gemini");
        expect(end).toMatchObject({ running: false, ok: true, via: "npm", after: "9.9.9" });
        expect(end!.output).toMatch(/cannot safely isolate[\s\S]*改用 npm[\s\S]*added 1 package/);
      } finally {
        rmSync(join(bin, "osdk"), { force: true });
        rmSync(join(bin, "node"), { force: true });
      }
    }, 30_000);
  });
});
