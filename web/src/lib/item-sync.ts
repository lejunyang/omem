/**
 * Items brought in from a platform (src/items/providers.ts): what a plugin offers to read
 * (`GET /api/item-sync` providers), what the person subscribed to (targets), and the entry an item
 * came from (`external` on `GET /api/items/:id` and `/api/work/:id`).
 */
export type SyncProvider = { id: string; label: string; statuses: Record<string, "active" | "done" | "cancelled">; writable: boolean; targetHint: string | null };
export type SyncTarget = {
  id: string; provider: string; target: string; space_id: string;
  import_mode: "candidate" | "direct"; mode: "confirm" | "direct"; enabled: number;
  error: string | null; items: number; synced_at: string | null;
};
/** A status change made here that has not reached the platform: waiting for a yes, for the next read, or stopped. */
export type ExternalWrite = { id: string; status: string; state: "pending" | "ready" | "conflict" | "failed"; error: string | null };
export type ItemExternal = {
  key: string; url: string; title: string; status: string; updatedAt: string; assignee?: string;
  provider: string; providerLabel: string | null; syncedAt: string; direction: "pull" | "push"; error: string | null;
  write: ExternalWrite | null;
};

/** The body `PUT /api/item-sync` takes for a target as it is now, with one thing changed. */
export function targetBody(t: SyncTarget, patch: Partial<{ importMode: "candidate" | "direct"; mode: "confirm" | "direct"; enabled: boolean }> = {}) {
  return { provider: t.provider, target: t.target, spaceId: t.space_id, importMode: t.import_mode, mode: t.mode, enabled: !!t.enabled, ...patch };
}

/** The platform's own short name for an entry: `#12`, `PROJ-7`, or the key as it is. */
export const keyLabel = (key: string) => (/^\d+$/.test(key) ? `#${key}` : key);
