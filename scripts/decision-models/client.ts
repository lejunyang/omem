import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const llamaTool = "github:ggml-org/llama.cpp@b11382";
export type DecisionBackend = "gliclass" | "mlx" | "gguf";

export type DecisionQuestion = {
  id: string;
  context: string;
  question: string;
  options: { key: string; description: string }[];
  /** GLiClass's documented passage-as-text / query-as-label rerank readout. */
  queryLabel?: string;
};
export type DecisionResult = {
  id: string;
  selected?: string;
  scores?: Record<string, number>;
  elapsedMs: number;
  inputTokens?: number;
  processPeakBytes?: number;
  peakModelBytes?: number;
  serverResidentBytes?: number;
  allowedTokenMass?: number;
  error?: string;
};

/** One resident model per experiment. Installation is an explicit separate task. */
export async function decisionWorker(
  alias: string,
  backend: DecisionBackend,
  device = "cpu",
) {
  const python = resolve(
    ".repo-review/runtime/decision-models/venv/bin/python",
  );
  if (!existsSync(python)) throw Error("Run osdk run decision:prepare first");
  execFileSync("osdk", ["model", "verify", alias, "--json"], {
    stdio: "pipe",
    timeout: 120_000,
  });
  const { model } = JSON.parse(
    execFileSync("osdk", ["model", "show", alias, "--json"], {
      encoding: "utf8",
    }),
  );
  const started = performance.now();
  const server = backend === "gguf" ? await startGguf(model) : undefined;
  const child = spawn(
    python,
    [
      "-u",
      resolve("scripts/decision-models/worker.py"),
      "--backend",
      backend,
      "--model",
      model.snapshot_path,
      "--device",
      device,
      ...(server
        ? ["--url", server.url, "--server-pid", String(server.pid)]
        : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "",
    pending:
      | { resolve: (value: any) => void; reject: (error: Error) => void }
      | undefined;
  let stopped = false;
  child.stderr.on("data", (data) => {
    stderr = (stderr + data.toString()).slice(-6000);
  });
  const next = () =>
    new Promise<any>((resolve, reject) => {
      if (pending)
        return reject(Error("Decision worker accepts one request at a time"));
      if (stopped) return reject(Error(`Decision worker stopped: ${stderr}`));
      pending = { resolve, reject };
    });
  const ready = next();
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (pending) {
        const receiver = pending;
        pending = undefined;
        receiver.resolve(value);
      }
    } catch {
      stderr = (stderr + line).slice(-6000);
    }
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      stopped = true;
      pending?.reject(Error(`Decision worker exited: ${stderr}`));
      pending = undefined;
      resolve();
    }),
  );
  child.on("error", (error) => {
    pending?.reject(error);
    pending = undefined;
  });
  let metadata;
  try {
    metadata = await ready;
  } catch (error) {
    child.kill();
    await server?.close();
    throw error;
  }
  return {
    metadata: {
      ...metadata,
      workerReadyMs: Math.round(performance.now() - started),
      server: server?.metadata,
      repository: model.repository,
      revision: model.revision,
      variant: model.variant,
      files: model.files.map((f: { path: string; sha256: string }) => ({
        path: f.path,
        sha256: f.sha256,
      })),
    },
    async decide(input: DecisionQuestion): Promise<DecisionResult> {
      const response = next();
      child.stdin.write(JSON.stringify(input) + "\n");
      return response;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
      await closed;
      clearTimeout(timer);
      await server?.close();
    },
  };
}

async function startGguf(model: {
  snapshot_path: string;
  files: { path: string }[];
}) {
  const files = model.files.filter((f) => f.path.endsWith(".gguf"));
  if (files.length !== 1)
    throw Error("Expected exactly one GGUF file in the osdk snapshot");
  const directory = execFileSync("osdk", ["where", llamaTool], {
    encoding: "utf8",
  }).trim();
  const listener = createServer();
  await new Promise<void>((res, rej) => {
    listener.once("error", rej);
    listener.listen(0, "127.0.0.1", res);
  });
  const address = listener.address();
  if (!address || typeof address === "string")
    throw Error("No evaluation port");
  await new Promise<void>((res) => listener.close(() => res()));
  const args = [
    "--model",
    resolve(model.snapshot_path, files[0]!.path),
    "--host",
    "127.0.0.1",
    "--port",
    String(address.port),
    "--ctx-size",
    "8192",
    "--parallel",
    "1",
    "--threads",
    "4",
    "--gpu-layers",
    "all",
    "--no-webui",
    "--no-cache-prompt",
    "--no-context-shift",
  ];
  const child = spawn(resolve(directory, "llama-server"), args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "",
    failed: Error | undefined;
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-6000);
  });
  child.on("error", (error) => {
    failed = error;
  });
  let exited = false;
  const closed = new Promise<void>((res) =>
    child.once("close", () => {
      exited = true;
      res();
    }),
  );
  const close = async () => {
    if (!exited) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(timer);
  };
  const cleanup = () => {
    child.kill("SIGTERM");
  };
  process.once("exit", cleanup);
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (failed || exited)
        throw Error(`llama-server failed: ${failed?.message ?? stderr}`);
      if (
        await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
          .then((r) => r.ok)
          .catch(() => false)
      )
        return {
          url,
          pid: child.pid!,
          metadata: {
            tool: llamaTool,
            contextSize: 8192,
            threads: 4,
            parallel: 1,
            gpuLayers: "all",
            promptCache: false,
            contextShift: false,
          },
          close: async () => {
            process.off("exit", cleanup);
            await close();
          },
        };
      await delay(250);
    }
    throw Error(`llama-server did not become ready: ${stderr}`);
  } catch (error) {
    process.off("exit", cleanup);
    await close();
    throw error;
  }
}
