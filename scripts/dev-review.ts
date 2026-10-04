/** Shared personal/review development lifecycle; Bun API, explicit
 * proxy ports, bounded shutdown and child failure propagation. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { selectDevPort } from "./dev-ports.js";

const review = process.env.OMEM_DEV_MODE !== "personal";
const label = review ? "repo-review" : "omem";
let API_PORT: number;
let WEB_PORT: number;
const repoRoot = process.cwd();
const bun = process.execPath;

// ---------------------------------------------------------------------------
// Child lifecycle helpers.
// ---------------------------------------------------------------------------

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
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
 * elsewhere SIGTERM to the direct child (each child owns a process group, including any watcher descendants). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
      /* child may already be dead; exit event still fires */
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
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
  console.log(`${label}: ${reason}; stopping children...`);
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
    API_PORT = await selectDevPort(review ? process.env.REVIEW_PORT : process.env.OMEM_PORT, review ? 5180 : 4317, `${label} API`);
    WEB_PORT = await selectDevPort(review ? process.env.REVIEW_WEB_PORT : process.env.OMEM_WEB_PORT, review ? 5181 : 5173, `${label} web`);
    if (API_PORT === WEB_PORT) throw new Error("API 与 web 必须使用不同端口");
  } catch (err) {
    console.error(`${label}: ${(err as Error).message}`);
    process.exit(1);
  }

  apiChild = spawn(
    review ? bun : "node",
    review ? ["apps/server/src/review/main.ts"] : [
      createRequire(import.meta.url).resolve("nodemon/bin/nodemon.js"),
      "--config", "nodemon.json", "apps/server/src/main.ts",
    ],
    { cwd: repoRoot, stdio: "inherit", detached: process.platform !== "win32",
      env: { ...process.env, OMEM_PORT: String(API_PORT), REVIEW_PORT: String(API_PORT), REVIEW_WEB_PORT: String(WEB_PORT) } },
  );
  webChild = spawn(
    bun,
    ["scripts/dev-review-vite.ts"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      detached: process.platform !== "win32",
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
        `${label}: ${which} exited code=${code ?? "-"} signal=${signal ?? "-"}`,
      );
      if (shuttingDown) return;
      const exitCode = code ?? (signal ? 1 : 0);
      void shutdown(`${which} child exited`, exitCode);
    };
  for (const child of [apiChild, webChild]) child.on("error", (error) => void shutdown(error.message, 1));
  apiChild.on("exit", onChildExit("API"));
  webChild.on("exit", onChildExit("web"));

  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => void shutdown(`received ${sig}`, 0));

  // Wait for the API health endpoint before printing ready URLs. The API does a
  // (possibly incremental) sync on boot, so allow up to 60s.
  const healthUrl = `http://127.0.0.1:${API_PORT}${review ? "/api/review/health" : "/api/health"}`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline && !shuttingDown) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
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

  console.log(`${label}: API ready at http://127.0.0.1:${API_PORT}`);
  console.log(
    `${label}: web  ready at http://127.0.0.1:${WEB_PORT} (strictPort, /api -> ${API_PORT})`,
  );

  // Stay alive; child exit handlers above own the shutdown path.
  await new Promise(() => {});
}

void main().catch((err) => {
  console.error("repo-review: fatal", err);
  process.exit(1);
});
