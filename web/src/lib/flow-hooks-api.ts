import { get } from "../api";
import type { FlowHooks } from "./flow-hooks";

/**
 * The plugins' signals, jobs and checks by name (`GET /api/flows`), read once a page and shared by the
 * stages on it: an item's flow only names them by id. Without the right to list flows (or on an older
 * server) the ids stand in.
 */
let pending: Promise<FlowHooks> | null = null, at = 0;
export function flowHooks(): Promise<FlowHooks> {
  if (!pending || Date.now() - at > 60_000) {
    at = Date.now();
    pending = get<Partial<FlowHooks>>("/api/flows").then((r) => ({ signals: r.signals ?? [], runners: r.runners ?? [], gates: r.gates ?? [] })).catch(() => ({ signals: [], runners: [], gates: [] }));
  }
  return pending;
}
