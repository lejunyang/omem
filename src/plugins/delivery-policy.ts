export const DELIVERY_TIMEOUT_MS = 15_000;
export const DELIVERY_LEASE_MS = 30_000;

export function retryFailure(previousAttempts: number, error: unknown) {
  const attempts = previousAttempts + 1;
  return {
    attempts,
    state: attempts >= 6 ? "failed" : "pending",
    due: Date.now() + 1000 * 2 ** attempts,
    error: String(error).slice(0, 500),
  };
}
