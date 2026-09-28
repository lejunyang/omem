/** Independent, explicit Code Understanding model config for review mode.
 *
 * This is the ONLY place review mode looks for a model. It reads exactly one
 * optional env var: `REVIEW_CODE_MODEL_CONFIG`, which must point at a JSON file.
 * It never reads the personal OMEM agent profiles, user keychains, or any
 * other host config. When the var is unset the review app has no model and
 * serves the raw graph + curated seeds honestly.
 *
 * The JSON file shape matches UnderstandingTransportConfig:
 *   { "transport": "none" | "acp" | "cli" | "http",
 *     "command": "...", "args": [...], "model": "...",
 *     "effort": "...", "timeoutMs": 120000, "endpoint": "..." }
 */
import { readFileSync } from "node:fs";
import {
  buildUnderstandingModelPort,
  CodeModelUnavailableError,
  type UnderstandingTransportConfig,
  type UnderstandingModelPort,
} from "../code/understanding-model.js";

const NONE: UnderstandingTransportConfig = { transport: "none" };

/** Load the explicit review model config. Defaults to no model; never throws on
 * missing config — only throws on an explicitly-broken file so the operator
 * notices a typo instead of silently running without a model. */
export function loadReviewCodeModelConfig(
  path = process.env.REVIEW_CODE_MODEL_CONFIG,
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
  path = process.env.REVIEW_CODE_MODEL_CONFIG,
): UnderstandingModelPort | null {
  const config = loadReviewCodeModelConfig(path);
  return buildUnderstandingModelPort(config);
}
