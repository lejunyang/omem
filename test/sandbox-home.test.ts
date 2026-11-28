import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ownRun } from "../src/agents/own-run.ts";
import { clearHomeLayer, homeLayers, homeStore, overlaySupport } from "../src/agents/sandbox-home.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

const support = sandboxSupport();
it.skipIf(!support.ok)("并发 HOME 写入按结束顺序保留，删除保持生效，宿主程序保持原样 " + (support.reason ?? ""), async ctx => {
  const app = testApp();
  const home = mkdtempSync(join(tmpdir(), "overlay-home-"));
  const cwd = join(home, "project");
  vi.stubEnv("HOME", home);
  const store = homeStore(app.home, home, "owner");
  try {
    const capability = overlaySupport(store);
    ctx.skip(!capability.ok, capability.reason);
    mkdirSync(cwd);
    writeFileSync(join(home, "program"), "host");
    mkdirSync(join(home, "folder"));
    writeFileSync(join(home, "folder", "old"), "old");
    writeFileSync(join(home, ".netrc"), "fixture");
    app.config.agents.ownSandbox.mode = "require";
    const profile = agentProfileSchema.parse({ id: "fixture", command: "/bin/sh", transport: "acp" });
    const shell = (script: string, userId = "owner") => {
      const { box } = ownRun(app, profile, cwd, false, undefined, { userId });
      const child = launch("/bin/sh", ["-ec", script], { cwd, ownSandbox: box });
      let stderr = "";
      child.stderr.on("data", data => stderr += data);
      const done = once(child, "close").then(([code]) => expect(code, stderr).toBe(0));
      return { child, done };
    };
    const a = shell('cd "$HOME"; test ! -s .netrc; echo ready; read line; echo last > program; touch first');
    await once(a.child.stdout, "data");
    await shell('cd "$HOME"; echo earlier > program; touch second; unlink folder/old; rmdir folder; mkdir folder; echo new > folder/new').done;
    a.child.stdin.end("go\n");
    await a.done;
    expect(readFileSync(join(home, "program"), "utf8")).toBe("host");
    expect(existsSync(join(home, "first"))).toBe(false);
    await shell('cd "$HOME"; test "$(cat program)" = last; test -f first; test -f second; test ! -e folder/old; test -f folder/new').done;
    await shell('cd "$HOME"; test "$(cat program)" = host; test ! -e first', "member").done;
    const socket = createServer();
    await new Promise<void>(ok => socket.listen(join(home, "service.sock"), ok));
    try {
      app.config.security.egress.mode = "all-sandboxed";
      await shell('cd "$HOME"; test ! -S service.sock; test "$(cat program)" = last; echo cached > new-file').done;
    } finally { await new Promise<void>(ok => socket.close(() => ok())); }
    app.config.security.egress.mode = "strict-only";
    await shell('test -r "$HOME/new-file"').done;
    expect(homeLayers(store).find(row => row.identity === "owner")?.bytes).toBeGreaterThan(0);
    clearHomeLayer(store);
    await shell('cd "$HOME"; test "$(cat program)" = host; test -f folder/old; test ! -e second').done;
  } finally {
    vi.unstubAllEnvs(); app.db.close();
    rmSync(store.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(app.home, { recursive: true, force: true });
  }
}, 30000);
