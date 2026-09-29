/** Review uses the checked-in config/review-code-model.json as its actual
 * profile. REVIEW_CODE_MODEL_CONFIG explicitly overrides it; personal profiles
 * and secrets are never consulted. A missing project profile means no model.
 * Configuring a profile enables explicit generation, never inference on boot. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildUnderstandingModelPort,
  CodeModelUnavailableError,
  type UnderstandingTransportConfig,
  type UnderstandingModelPort,
} from "../code/understanding-model.js";

export function reviewModelConfigPath(): string | undefined {
  if (process.env.REVIEW_CODE_MODEL_CONFIG) return process.env.REVIEW_CODE_MODEL_CONFIG;
  const projectConfig = resolve(process.env.REVIEW_REPO_ROOT ?? process.cwd(), "config/review-code-model.json");
  return existsSync(projectConfig) ? projectConfig : undefined;
}

const NONE: UnderstandingTransportConfig = { transport: "none" };

/** Load the explicit review model config. Defaults to no model; never throws on
 * missing config — only throws on an explicitly-broken file so the operator
 * notices a typo instead of silently running without a model. */
export function loadReviewCodeModelConfig(
  path = reviewModelConfigPath(),
): UnderstandingTransportConfig {
  if (!path) return { ...NONE };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new CodeModelUnavailableError(
      `REVIEW_CODE_MODEL_CONFIG=${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodeModelUnavailableError(
      `REVIEW_CODE_MODEL_CONFIG=${path} is not valid JSON`,
    );
  }
  const object = (parsed ?? {}) as Partial<UnderstandingTransportConfig>;
  const transport = object.transport ?? "none";
  if (!["none", "acp", "cli", "http"].includes(transport))
    throw new CodeModelUnavailableError(
      `REVIEW_CODE_MODEL_CONFIG: unsupported transport "${String(transport)}"`,
    );
  return {
    transport,
    maxInputTokens: object.maxInputTokens,
    maxOutputTokens: object.maxOutputTokens,
    contextReserveTokens: object.contextReserveTokens,
    command: object.command,
    args: object.args,
    model: object.model,
    effort: object.effort,
    timeoutMs: object.timeoutMs,
    endpoint: object.endpoint,
  };
}

/** Build the port from the explicit config file (null = no model). */
export function buildReviewCodeModel(
  path = reviewModelConfigPath(),
): UnderstandingModelPort | null {
  const config = loadReviewCodeModelConfig(path);
  return buildUnderstandingModelPort(config);
}
