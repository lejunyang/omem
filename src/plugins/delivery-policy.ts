export const DELIVERY_TIMEOUT_MS = 15_000;
export const DELIVERY_LEASE_MS = 30_000;

export function retryFailure(previousAttempts: number, error: unknown, delays?: readonly number[]) {
  const attempts = previousAttempts + 1;
  const delay = delays ? delays[previousAttempts] : 1000 * 2 ** attempts;
  return {
    attempts,
    state: (delays ? delay === undefined : attempts >= 6) ? "failed" as const : "pending" as const,
    due: Date.now() + (delay ?? 0),
    error: String(error).slice(0, 500),
  };
}
