/** Integration tests for scripts/dev-review.ts (the dev orchestrator).
 *
 * These exercise the real orchestrator binary against ephemeral ports and a
 * tiny fixture repo, so they do NOT touch the real .repo-review/ data or the
 * fixed 5180/5181 ports:
 *
 *  - refuses to start when the API port is already bound (clear error, exit 1)
 *  - boots end-to-end: API health answers, then taskkill /T /F releases BOTH
 *    ports (no orphaned tsx/node grandchildren)
 *
 * We deliberately do not unit-test the orchestrator internals; the Windows
 * taskkill /T /F tree cleanup is the behavior that matters and only a real
 * child-process round-trip proves it. */
import { describe, it, expect } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const node = process.execPath;
const tsxCli = "node_modules/tsx/dist/cli.mjs";

function freePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolveP(port));
    });
    srv.on("error", rejectP);
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const probe = createServer();
    probe.once("error", () => resolveP(false));
    probe.once("listening", () => probe.close(() => resolveP(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Wait until a port is free (the child tree has actually released it), with
 * a timeout. */
async function waitUntilFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return portFree(port);
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-review-dev-fixture-"));
  mkdirSync(join(root, "apps", "server", "src"), { recursive: true });
  writeFileSync(
    join(root, "apps", "server", "src", "hello.ts"),
    "export function hello() {\n  return \"FIXTURE_HELLO_TOKEN\";\n}\n",
    "utf8",
  );
  return root;
}

function killTree(pid: number): Promise<void> {
  return new Promise((resolveP) => {
    if (process.platform === "win32")
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolveP());
    else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      resolveP();
    }
  });
}

function spawnOrchestrator(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(node, [tsxCli, "scripts/dev-review.ts"], {
    cwd: projectRoot,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
}

async function waitHealth(port: number, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/review/health`);
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`health timeout: ${String(lastErr)}`);
}

describe("dev-review orchestrator", { timeout: 120_000 }, () => {
  it("refuses to start when the API port is already bound and exits non-zero", async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    // Occupy the API port BEFORE the orchestrator starts.
    const occupant: Server = createServer();
    await new Promise<void>((r) => occupant.listen(apiPort, "127.0.0.1", r));

    const child = spawnOrchestrator({
      REVIEW_PORT: String(apiPort),
      REVIEW_WEB_PORT: String(webPort),
      REVIEW_REPO_ROOT: projectRoot,
    });
    const code = await new Promise<number | null>((resolveP) =>
      child.once("exit", resolveP),
    );
    occupant.close();
    expect(code).not.toBe(0);
  });

  it("boots end-to-end, serves health, and releases both ports after taskkill /T /F", async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    const fixture = makeFixtureRepo();
    try {
      const child = spawnOrchestrator({
        REVIEW_PORT: String(apiPort),
        REVIEW_WEB_PORT: String(webPort),
        REVIEW_REPO_ROOT: fixture,
      });
      const pid = child.pid!;

      // Health must answer within 60s (tsx cold start + tiny sync).
      const health = (await waitHealth(apiPort, 60_000)) as {
        mode: string;
        sourceCount: number;
        fragmentCount: number;
      };
      expect(health.mode).toBe("review");
      expect(health.sourceCount).toBeGreaterThan(0);
      expect(health.fragmentCount).toBeGreaterThan(0);

      // The Vite child must actually be serving the SPA on webPort.
      const webRes = await fetch(`http://127.0.0.1:${webPort}/`);
      expect(webRes.status).toBe(200);

      // Now kill the orchestrator AND its whole child tree.
      await killTree(pid);
      child.unref();

      // Both ports must be released (the original bug: only cmd was killed,
      // leaving tsx/node grandchildren bound to 5180/5181).
      expect(await waitUntilFree(apiPort, 15_000)).toBe(true);
      expect(await waitUntilFree(webPort, 15_000)).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
