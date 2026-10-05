/** Configurable Code Understanding model port.
 *
 * Review mode has NO hard-wired model: by default `available` is false and only
 * curated seed projections are served. A model runs only when the host passes
 * an explicit `UnderstandingTransportConfig` into the review app. This module
 * performs NO inference, reads NO process.env / credentials / personal secrets,
 * and makes NO outbound call on its own — it adapts the project's real transports
 * (`acp()` / `cli()` from agents.ts, or a user-configured HTTP endpoint) once the
 * host opted in.
 *
 * Provenance discipline: the model id returned to the strict schema comes from
 * the transport response (HTTP body) or the explicit config `model` string. We
 * never invent a model id, never claim seed output was model-produced, and never
 * mark a generated row as agent-verified.
 */
import type { GenerationBudget } from "./budget.js";
import { join } from "node:path";
import { acp, cli, type Emit } from "../agents.js";
import type { AgentProfile } from "../../../../packages/contracts/src/index.js";

/** Thrown when no model is configured or the configured transport cannot run. */
export class CodeModelUnavailableError extends Error {}

export type UnderstandingTransportConfig = Partial<GenerationBudget> & {
  /** "none" = deliberately no model (default). acp/cli/http are opt-in. */
  transport: "none" | "acp" | "cli" | "http";
  /** acp/cli: executable to spawn. */
  command?: string;
  workspaceDir?: string;
  /** acp/cli: extra argv. */
  args?: string[];
  /** acp/cli/http: model id to request / echo. Never read from the environment. */
  model?: string;
  effort?: string;
  /** Legacy inactivity timeout for ACP/CLI. */
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxDurationMs?: number;
  /** http: explicit endpoint to POST to. */
  endpoint?: string;
};

export type UnderstandingModelReply = { text: string; model: string };

export type UnderstandingModelPort = {
  readonly transport: string;
  run(req: {
    prompt: string;
    signal: AbortSignal;
    onActivity?: () => void;
    budget?: GenerationBudget & { estimatedInputTokens: number };
  }): Promise<UnderstandingModelReply>;
};

function requireField(config: UnderstandingTransportConfig, field: string) {
  const v = (config as Record<string, unknown>)[field];
  if (typeof v !== "string" || !v.trim())
    throw new CodeModelUnavailableError(
      `${config.transport} transport requires explicit "${field}"`,
    );
}

function makeProfile(
  config: UnderstandingTransportConfig,
  transport: AgentProfile["transport"],
): AgentProfile {
  requireField(config, "command");
  return {
    id: "review-code-understanding",
    name: "review-code-understanding",
    transport,
    command: config.command as string,
    args: config.args ?? [],
    model: config.model,
    effort: config.effort,
    instructions: "",
    maxContextChars: 20000,
    timeoutMs: config.timeoutMs ?? 120_000,
    idleTimeoutMs: config.idleTimeoutMs,
    maxDurationMs: config.maxDurationMs,
    skills: [],
  };
}

/** Build a port, or null when the host deliberately configured no model.
 * Throws CodeModelUnavailableError on an explicitly-broken/unsupported config so
 * the caller surfaces it honestly instead of silently degrading. */
export function buildUnderstandingModelPort(
  config?: UnderstandingTransportConfig | null,
): UnderstandingModelPort | null {
  if (!config || config.transport === "none") return null;

  if (config.transport === "acp") {
    const profile = makeProfile(config, "acp");
    return {
      transport: "acp",
      run: async ({ prompt, signal, budget, onActivity }) => {
        let text = "";
        const emit: Emit = (type, chunk) => {
          if (type === "text") text += chunk;
        };
        await acp(
          profile,
          config.workspaceDir ?? join(process.cwd(), ".repo-review/runtime/agent-workspace"),
          [{ type: "text", text: prompt }],
          emit,
          signal,
          { onActivity, maxOutputChars: budget ? budget.maxOutputTokens * 3 : 80_000, contextBudget: budget },
        );
        return { text, model: profile.model ?? "acp" };
      },
    };
  }

  if (config.transport === "cli") {
    const profile = makeProfile(config, "codex-cli");
    return {
      transport: "cli",
      run: async ({ prompt, signal, onActivity }) => {
        let text = "";
        const emit: Emit = (type, chunk) => {
          if (type === "text") text += chunk;
        };
        await cli(profile, config.workspaceDir ?? join(process.cwd(), ".repo-review/runtime/agent-workspace"), prompt, emit, signal, onActivity);
        return { text, model: profile.model ?? "cli" };
      },
    };
  }

  if (config.transport === "http") {
    requireField(config, "endpoint");
    const endpoint = config.endpoint as string;
    return {
      transport: "http",
      run: async ({ prompt, signal, onActivity }) => {
        const res = await fetch(endpoint, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, model: config.model ?? null }),
        });
        if (!res.ok)
          throw new CodeModelUnavailableError(`model endpoint returned ${res.status}`);
        const body = (await res.json()) as Record<string, unknown>;
        const text =
          typeof body.text === "string"
            ? body.text
            : typeof body.content === "string"
              ? body.content
              : "";
        if (!text.trim())
          throw new CodeModelUnavailableError("model endpoint returned no text");
        // Model id comes from the response, falling back to the explicit config;
        // never fabricated.
        const model =
          typeof body.model === "string" && body.model.trim()
            ? body.model
            : (config.model ?? "http");
        return { text, model };
      },
    };
  }

  throw new CodeModelUnavailableError(
    `unsupported transport: ${String(config.transport)}`,
  );
}
