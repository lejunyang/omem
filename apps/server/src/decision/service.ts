import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  assetPath,
  modelWorkspace,
  optionalRuntime,
  pythonInVenv,
} from "../paths.js";
import type { ChoiceQuestion } from "./questions.js";
import { getLogger, errorSummary } from "../logging/logger.js";
const exec = promisify(execFile);
export const decisionConfigSchema = z
  .object({ mode: z.enum(["off", "auto", "2b", "4b", "9b"]).default("auto") })
  .strict();
export type DecisionConfig = z.input<typeof decisionConfigSchema>;
const answerSchema = z.object({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
export const resultSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  elapsedMs: z.number(),
  model: z.object({
    alias: z.string(),
    size: z.string(),
    revision: z.string(),
    switched: z.boolean(),
    availableGiB: z.number(),
    loadPerCpu: z.number(),
  }),
  peakModelBytes: z.number(),
});
export type DecisionResult = z.infer<typeof resultSchema>;

/** Optional sidecar shared by reading and intake. No writes and no implicit setup.
 * Failure leaves the existing workflow usable. Requests are serialized so two
 * imports cannot concurrently load models into unified memory. */
export class DecisionService {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private cache = new Map<string, { at: number; value: DecisionResult }>();
  private state = { status: "idle", model: "", lastError: "" };
  constructor(private config: DecisionConfig = {}) {
    if (config.mode === "off") this.state.status = "disabled";
  }
  status() {
    return { ...this.state, mode: this.config.mode ?? "auto" };
  }
  async decide(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
  ): Promise<DecisionResult | null> {
    if (this.stopped || this.config.mode === "off") return null;
    const key = createHash("sha256")
      .update(JSON.stringify({ state, questions }))
      .digest("hex");
    const logger = getLogger({ component: "decision" });
    const run = this.queue.then(async () => {
      if (this.stopped) return null;
      const cached = this.cache.get(key);
      if (cached && Date.now() - cached.at < 300_000) {
        logger.debug(
          {
            event: "decision.cached",
            requestDigest: key,
            model: cached.value.model.alias,
          },
          "decision.cached",
        );
        return cached.value;
      }
      clearTimeout(this.idle);
      try {
        await this.start();
        this.state.status = "running";
        const raw = await this.next(() =>
          this.child!.stdin.write(JSON.stringify({ state, questions }) + "\n"),
        );
        if ((raw as { error?: string }).error)
          throw Error((raw as { error: string }).error);
        const result = resultSchema.parse(raw);
        // Never accept a missing dimension or an option the caller did not define.
        for (const [key, question] of Object.entries(questions)) {
          const answer = result.answers[key];
          if (
            !answer ||
            !(answer.choice in question.criteria) ||
            Object.keys(question.criteria).some(
              (k) => typeof answer.probabilities[k] !== "number",
            )
          )
            throw Error("决策返回缺少选项");
        }
        this.state = {
          status: "ready",
          model: result.model.alias,
          lastError: "",
        };
        this.cache.set(key, { at: Date.now(), value: result });
        if (this.cache.size > 128)
          this.cache.delete(this.cache.keys().next().value!);
        logger.debug(
          {
            event: "decision.completed",
            requestDigest: key,
            dimensions: Object.keys(questions),
            elapsedMs: result.elapsedMs,
            model: result.model.alias,
            modelSize: result.model.size,
            switched: result.model.switched,
          },
          "decision.completed",
        );
        return result;
      } catch (error) {
        const repeat =
          this.state.lastError ===
          (error instanceof Error ? error.message : String(error));
        logger[repeat ? "debug" : "warn"](
          {
            event: "decision.unavailable",
            requestDigest: key,
            mode: this.config.mode ?? "auto",
            phase: this.state.status,
            error: errorSummary(error),
          },
          "decision.unavailable",
        );
        this.state = {
          ...this.state,
          status: "unavailable",
          lastError: error instanceof Error ? error.message : String(error),
        };
        return null;
      } finally {
        this.idle = setTimeout(() => {
          this.stopWorker();
          this.state.status = "idle";
        }, 180_000);
        this.idle.unref();
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private next(write?: () => void) {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopWorker();
        reject(Error("决策模型超时，已释放运行进程"));
      }, 120_000);
      this.pending = {
        resolve: (v) => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(e);
        },
      };
      write?.();
    });
  }
  private async start() {
    if (this.child) return;
    const runtime = optionalRuntime("decision");
    const python = pythonInVenv(runtime);
    if (!existsSync(python))
      throw Error(
        "快速决策环境未准备，请运行 omem setup decisions --model 2b（需要 Apple Silicon Mac）",
      );
    this.state.status = "loading";
    const models: Record<string, unknown> = {};
    // Automatic selection only uses the smaller models. An installed 9B is
    // discovered only when the user explicitly selects it.
    const mode = this.config.mode ?? "auto";
    for (const size of mode === "auto" ? ["2b", "4b"] : [mode]) {
      try {
        const alias = `decision-startlux${size}`;
        const { stdout } = await exec(
          "osdk",
          ["model", "show", alias, "--json", "--offline"],
          { timeout: 10_000, cwd: modelWorkspace() },
        );
        const { model } = JSON.parse(stdout);
        if (model.snapshot_path && existsSync(model.snapshot_path))
          models[size] = {
            alias,
            path: model.snapshot_path,
            revision: model.revision,
          };
      } catch {
        /* An uninstalled model is not downloaded at runtime. */
      }
    }
    if (!Object.keys(models).length)
      throw Error(
        `未安装所选 StartLux 模型；请运行 omem setup decisions --model ${mode === "auto" ? "2b" : mode}`,
      );
    const child = spawn(
      python,
      [
        "-u",
        assetPath("scripts/startlux/worker.py"),
        JSON.stringify({ models, mode: this.config.mode ?? "auto" }),
      ],
      {
        env: { ...process.env, PYTHONPATH: join(runtime, "upstream") },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-1500);
    });
    const ready = this.next();
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.pending?.resolve(JSON.parse(line));
      } catch {
        /* Runtime diagnostics stay off the data stream. */
      }
    });
    child.on("error", (error) => {
      if (this.child === child) this.pending?.reject(error);
    });
    child.on("close", () => {
      if (this.child === child) {
        this.child = undefined;
        this.pending?.reject(Error("决策进程退出：" + stderr));
      }
    });
    try {
      const value = (await ready) as { ready?: boolean };
      if (!value.ready) throw Error("决策进程未就绪");
    } catch (error) {
      this.stopWorker();
      throw error;
    }
  }
  private stopWorker() {
    const child = this.child;
    this.child = undefined;
    this.pending?.reject(Error("决策进程已释放"));
    child?.kill("SIGKILL");
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.idle);
    this.stopWorker();
    await this.queue;
  }
}
