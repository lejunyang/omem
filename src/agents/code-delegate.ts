import type { App } from "../core/app.ts";
import { createRun } from "./runs.ts";
import { linkRunToItem } from "../items/materials.ts";

/** Shared enqueue path for explicit owner delegations, including study findings. */
export function queueCodeWork(app: App, request: Omit<Parameters<typeof createRun>[1], "kind">) {
  const input = request.input ?? {};
  const r = createRun(app, { ...request, kind: "code", input: {
    ...(!input.peerCoder && !input.syncOnly && app.config.agents.autoAdvance.taskLoop ? { taskMode: true } : {}), ...input,
  } });
  if (typeof input.itemId === "string") linkRunToItem(app, r, input.itemId, request.userId ?? "owner");
  return r;
}
