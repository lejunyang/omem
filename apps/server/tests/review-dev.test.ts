/** Integration tests for scripts/dev-review.ts (the dev orchestrator).
 *
 * These exercise the real orchestrator binary against ephemeral ports and a
 * tiny fixture repo, so they do NOT touch the real .repo-review/ data or the
 * fixed 5180/5181 ports. They deliberately do NOT kill by port or broadly kill
 * node: every child we terminate is the exact orchestrator PID we spawned,
 * and taskkill /T /F reaps its own descendants.
 *
 * Covered:
 *  - refuses to start when either port is already bound (clear error, exit != 0)
 *  - boots end-to-end: health answers, web serves SPA; taskkill /T /F then
 *    releases BOTH ports AND the fixture dir becomes deletable (the original
 *    flake was EBUSY unlinking omem.sqlite-wal because rmSync ran before the
 *    OS released SQLite file handles on Windows)
 *  - termination contract: child.kill(SIGTERM) behavior differs by platform.
 *    On Windows a piped child.kill only TerminateProcesses the tsx CLI wrapper
 *    (the orchestrator's SIGTERM handler does NOT run); we assert the forced
 *    contract: tree reap + ports release. On POSIX we assert the real graceful
 *    path: the orchestrator's handler runs and exits 0.
 *  - repeated boot/kill cycles to shake out races
 *
 * Cleanup discipline:
 *  - after taking the tree down we await the orchestrator's own 'exit' event
 *    (bounded) and log the real exit code, THEN poll rmSync until the fixture
 *    dir is removable. The 20s/250ms poll is an OS file-lock release wait
 *    (Windows releases handles asynchronously after process death); it is not
 *    a claim that every descendant has been deterministically tracked.
 *  - cleanup errors are never swallowed: if a primary assertion failed, both
 *    errors are thrown together as an AggregateError; otherwise the cleanup
 *    error alone is thrown. */
import { describe, it, expect } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const node = process.execPath;
const tsxCli = "node_modules/tsx/dist/cli.mjs";
const isWin = process.platform === "win32";

// ---------------------------------------------------------------------------
// Port / process helpers.
// ---------------------------------------------------------------------------

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

async function waitUntilFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return portFree(port);
}

/** Resolve once the child has actually exited (or timeout fires). The returned
 * code/signal are the real values reported by Node's 'exit' event. */
function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveP) => {
    if (child.exitCode !== null || child.pid === undefined)
      return resolveP({ code: child.exitCode, signal: null });
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveP({ code: null, signal: null });
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolveP({ code, signal });
    };
    child.once("exit", onExit);
  });
}

// ---------------------------------------------------------------------------
// Fixture + spawn.
// ---------------------------------------------------------------------------

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

/** taskkill /T /F the exact orchestrator PID and its descendants. We never
 * kill by port and never enumerate node.exe. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolveP) => {
    if (isWin)
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

function spawnOrchestrator(env: NodeJS.ProcessEnv) {
  const child = spawn(node, [tsxCli, "scripts/dev-review.ts"], {
    cwd: projectRoot,
    // Pipe (not ignore) so we can dump diagnostics on failure, but drain the
    // buffers so they never fill and stall the child.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout?.on("data", (b: Buffer) => out.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => err.push(b.toString()));
  return { child, out, err };
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
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`health timeout: ${String(lastErr)}`);
}

/** Poll rmSync until the fixture dir is removable. This runs ONLY after we have
 * already awaited the orchestrator's own 'exit' event; the bounded retry covers
 * the OS releasing SQLite/WAL file handles asynchronously after process death.
 * It is an OS lock-release wait, not a descendant-tracking guarantee. */
async function removeFixtureWithRetry(dir: string, timeoutMs = 20_000): Promise<Error | null> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      rmSync(dir, { recursive: true, force: true });
      if (!existsSync(dir)) return null;
    } catch (e) {
      lastErr = e as Error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return lastErr;
}

/** Run fixture cleanup and surface errors without swallowing. If a primary
 * assertion already failed, bundle both into an AggregateError so neither is
 * lost; otherwise throw the cleanup error alone. */
async function cleanupFixtureOrThrow(fixture: string, primaryErr: unknown): Promise<void> {
  const cleanupErr = await removeFixtureWithRetry(fixture);
  if (!cleanupErr) {
    if (primaryErr) throw primaryErr;
    return;
  }
  console.warn(`[review-dev] fixture cleanup failed: ${cleanupErr.message}`);
  if (primaryErr)
    throw new AggregateError(
      [primaryErr as Error, cleanupErr],
      `primary test failure plus fixture cleanup failure: ${(primaryErr as Error).message}; cleanup: ${cleanupErr.message}`,
    );
  throw cleanupErr;
}

/** Boot once, wait for health + web 200, take down the orchestrator via the
 * given shutdown action, await its real exit event, and assert ports released.
 * Returns the captured stdout/stderr and the real exit code. */
async function bootAndShutdown(
  apiPort: number,
  webPort: number,
  fixture: string,
  shutdown: (child: ChildProcess, pid: number) => Promise<void>,
) {
  const { child, out, err } = spawnOrchestrator({
    REVIEW_PORT: String(apiPort),
    REVIEW_WEB_PORT: String(webPort),
    REVIEW_REPO_ROOT: fixture,
  });
  const pid = child.pid!;
  let exitCode: number | null = null;
  try {
    const health = (await waitHealth(apiPort, 60_000)) as {
      mode: string;
      sourceCount: number;
      fragmentCount: number;
    };
    expect(health.mode).toBe("review");
    expect(health.sourceCount).toBeGreaterThan(0);
    expect(health.fragmentCount).toBeGreaterThan(0);
    const webRes = await fetch(`http://127.0.0.1:${webPort}/`);
    expect(webRes.status).toBe(200);

    await shutdown(child, pid);

    // Await the orchestrator's own exit event (real code/signal) BEFORE we
    // touch ports or fixtures. On Windows the forced-kill path may leave the
    // tsx wrapper alive briefly; the finally block reaps the tree regardless.
    const exited = await waitForChildExit(child, isWin ? 5_000 : 20_000);
    exitCode = exited.code;
    console.log(`[review-dev] orchestrator exit: code=${exited.code} signal=${exited.signal}`);

    expect(await waitUntilFree(apiPort, 15_000)).toBe(true);
    expect(await waitUntilFree(webPort, 15_000)).toBe(true);
  } finally {
    // Ensure the tree is down even if an assertion threw mid-boot.
    try {
      await killTree(pid);
    } catch {
      /* best effort */
    }
    await waitForChildExit(child, 10_000);
  }
  return { out: out.join(""), err: err.join(""), exitCode };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("dev-review orchestrator", { timeout: 120_000 }, () => {
  it("refuses to start when the API port is already bound and exits non-zero", async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    const occupant: Server = createServer();
    await new Promise<void>((r) => occupant.listen(apiPort, "127.0.0.1", r));

    const { child, out, err } = spawnOrchestrator({
      REVIEW_PORT: String(apiPort),
      REVIEW_WEB_PORT: String(webPort),
      REVIEW_REPO_ROOT: projectRoot,
    });
    const { code } = await waitForChildExit(child, 20_000);
    occupant.close();
    console.log("orchestrator stdout on port-conflict:", out.slice(-500));
    console.log("orchestrator stderr on port-conflict:", err.slice(-500));
    expect(code).not.toBe(0);
  });

  it("refuses to start when the WEB port is already bound (preflight covers both)", async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    const occupant: Server = createServer();
    await new Promise<void>((r) => occupant.listen(webPort, "127.0.0.1", r));
    const { child } = spawnOrchestrator({
      REVIEW_PORT: String(apiPort),
      REVIEW_WEB_PORT: String(webPort),
      REVIEW_REPO_ROOT: projectRoot,
    });
    const { code } = await waitForChildExit(child, 20_000);
    occupant.close();
    expect(code).not.toBe(0);
  });

  it("boots end-to-end, taskkill /T /F releases both ports and the fixture is removable", async () => {
    const apiPort = await freePort();
    const webPort = await freePort();
    const fixture = makeFixtureRepo();
    let primaryErr: unknown = null;
    try {
      await bootAndShutdown(apiPort, webPort, fixture, async (_child, pid) => {
        await killTree(pid);
      });
    } catch (e) {
      primaryErr = e;
    } finally {
      await cleanupFixtureOrThrow(fixture, primaryErr);
    }
  });

  it(
    isWin
      ? "Windows forced-kill contract: child.kill(SIGTERM) does NOT run the handler; tree reap + ports release"
      : "POSIX graceful SIGTERM: the orchestrator runs its shutdown handler and exits 0",
    async () => {
      const apiPort = await freePort();
      const webPort = await freePort();
      const fixture = makeFixtureRepo();
      let primaryErr: unknown = null;
      try {
        const { exitCode } = await bootAndShutdown(
          apiPort,
          webPort,
          fixture,
          async (child, _pid) => {
            // On Windows this is TerminateProcess on the tsx CLI wrapper; the
            // orchestrator's SIGTERM handler never runs, so exitCode will be a
            // forced-kill code (1) and the finally reaps the tree. On POSIX
            // this reaches the handler and we expect a clean exit 0.
            child.kill("SIGTERM");
          },
        );
        if (!isWin) expect(exitCode).toBe(0);
        // On Windows we deliberately do NOT assert exitCode === 0: the handler
        // never ran, the contract is only "tree is reaped and ports free".
      } catch (e) {
        primaryErr = e;
      } finally {
        await cleanupFixtureOrThrow(fixture, primaryErr);
      }
    },
  );

  it("repeated boot/kill cycles (3 rounds, fresh ports each) are stable", async () => {
    let primaryErr: unknown = null;
    const fixtures: string[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const apiPort = await freePort();
        const webPort = await freePort();
        const fixture = makeFixtureRepo();
        fixtures.push(fixture);
        await bootAndShutdown(apiPort, webPort, fixture, async (_child, pid) => {
          await killTree(pid);
        });
      }
    } catch (e) {
      primaryErr = e;
    } finally {
      for (const f of fixtures) {
        await cleanupFixtureOrThrow(f, primaryErr);
      }
    }
  });
});
