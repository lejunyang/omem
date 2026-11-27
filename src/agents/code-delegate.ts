import { createCodeRound } from "./supervisor-code.ts";
import type { App } from "../core/app.ts";
import { linkRunToItem } from "../items/materials.ts";

/** Shared enqueue path for explicit owner delegations, including study findings. */
export function queueCodeWork(app: App, request: Omit<Parameters<typeof createCodeRound>[1], "kind">) {
  const input = request.input ?? {};
  const r = createCodeRound(app, { ...request, kind: "code", input: {
    ...(!input.peerCoder && !input.syncOnly && app.config.agents.autoAdvance.taskLoop ? { taskMode: true } : {}), ...input,
  } });
  if (typeof input.itemId === "string") linkRunToItem(app, r, input.itemId, request.userId ?? "owner");
  return r;
}
