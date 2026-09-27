/** Local dev orchestrator for the repo-review knowledge base.
 *
 * It boots two children as direct `node` processes (no `npx`/`npm`/cmd wrapper)
 * so the whole process tree can be terminated deterministically on Windows:
 *
 *   - review API  on 127.0.0.1:5180 (tsx apps/server/src/review/main.ts)
 *   - Vite dev    on 127.0.0.1:5181 (scripts/dev-review-vite.ts, strictPort)
 *
 * Lifecycle contract:
 *  - Refuses to start when either port is already bound, with a clear Chinese
 *    error. Vite also runs with strictPort so a race after the preflight fails
 *    loudly instead of silently switching ports.
 *  - If either child exits with a non-zero code (or dies by signal), the
 *    orchestrator kills the other child tree and exits with THAT code — it
 *    never swallows a failure into exit 0.
 *  - SIGINT/SIGTERM kills both child trees (taskkill /T /F on Windows), waits
 *    briefly for them to actually exit, then exits 0.
 *  - The "ready" URLs are printed only after /api/review/health answers, so the
 *    printed URL always matches a live listener.
 *
 * Ports are overridable via REVIEW_PORT / REVIEW_WEB_PORT for the integration
 * test; the API repo root is REVIEW_REPO_ROOT (defaults to cwd). */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const API_PORT = Number(process.env.REVIEW_PORT || 5180);
const WEB_PORT = Number(process.env.REVIEW_WEB_PORT || 5181);
const repoRoot = process.cwd();
const node = process.execPath;
const tsxCli = "node_modules/tsx/dist/cli.mjs";

// ---------------------------------------------------------------------------
// Port preflight.
// ---------------------------------------------------------------------------

function checkPort(port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      probe.close(() => {
        if (err.code === "EADDRINUSE")
          reject(new Error(`端口 ${port}（${label}）已被占用，请先释放`));
        else reject(err);
      });
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen(port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Child lifecycle helpers.
// ---------------------------------------------------------------------------

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

/** Kill a child and its whole tree. On Windows taskkill /T walks the tree;
 * elsewhere SIGTERM to the direct child (tsx without watch runs the script
 * in-process, so there is usually nothing to reap). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
      /* child may already be dead; exit event still fires */
    });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------

let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

async function shutdown(reason: string, exitCode: number): Promise<never> {
  if (shuttingDown) {
    // Re-entrant call (e.g. the other child exiting while we are already
    // tearing down): wait for the first shutdown to finish the job.
    await (shutdownPromise ?? Promise.resolve());
    return new Promise(() => {});
  }
  shuttingDown = true;
  console.log(`repo-review: ${reason}; stopping children...`);
  shutdownPromise = (async () => {
    killTree(apiChild);
    killTree(webChild);
    await Promise.race([
      Promise.all([waitForExit(apiChild, 5000), waitForExit(webChild, 5000)]),
      new Promise((r) => setTimeout(r, 6500)),
    ]);
  })();
  await shutdownPromise;
  process.exit(exitCode);
}

let apiChild!: ChildProcess;
let webChild!: ChildProcess;

async function main(): Promise<void> {
  // Preflight: fail fast with a clear message instead of letting the API/Vite
  // child die with an opaque EADDRINUSE after a partial boot.
  try {
    await checkPort(API_PORT, "API");
    await checkPort(WEB_PORT, "web");
  } catch (err) {
    console.error(`repo-review: ${(err as Error).message}`);
    process.exit(1);
  }

  apiChild = spawn(
    node,
    [tsxCli, "apps/server/src/review/main.ts"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  webChild = spawn(
    node,
    [tsxCli, "scripts/dev-review-vite.ts"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        REVIEW_API_PORT: String(API_PORT),
        REVIEW_WEB_PORT: String(WEB_PORT),
      },
    },
  );

  const onChildExit =
    (which: "API" | "web") =>
    (code: number | null, signal: NodeJS.Signals | null) => {
      console.log(
        `repo-review: ${which} exited code=${code ?? "-"} signal=${signal ?? "-"}`,
      );
      if (shuttingDown) return;
      const exitCode = code ?? (signal ? 1 : 0);
      void shutdown(`${which} child exited`, exitCode);
    };
  apiChild.on("exit", onChildExit("API"));
  webChild.on("exit", onChildExit("web"));

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => void shutdown(`received ${sig}`, 0));

  // Wait for the API health endpoint before printing ready URLs. The API does a
  // (possibly incremental) sync on boot, so allow up to 60s.
  const healthUrl = `http://127.0.0.1:${API_PORT}/api/review/health`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (shuttingDown) return; // child already tore us down
  if (!healthy) await shutdown(`timed out waiting for ${healthUrl}`, 1);

  console.log(`repo-review: API ready at http://127.0.0.1:${API_PORT}`);
  console.log(
    `repo-review: web  ready at http://127.0.0.1:${WEB_PORT} (strictPort, /api -> ${API_PORT})`,
  );

  // Stay alive; child exit handlers above own the shutdown path.
  await new Promise(() => {});
}

void main().catch((err) => {
  console.error("repo-review: fatal", err);
  process.exit(1);
});
