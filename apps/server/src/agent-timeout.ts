import type { AgentProfile } from "../../../packages/contracts/src/index.js";

/** timeoutMs remains a compatibility alias; it now means inactivity, not total runtime. */
export function agentIdleTimeout(
  profile: Pick<AgentProfile, "idleTimeoutMs" | "timeoutMs">,
) {
  return profile.idleTimeoutMs ?? profile.timeoutMs;
}

export function activityWatchdog(
  idleMs: number,
  expire: (reason: string) => void,
  maxDurationMs?: number,
) {
  let closed = false;
  const idle = setTimeout(
    () => expire(`Agent timed out: no activity for ${idleMs} ms`),
    idleMs,
  );
  const total =
    maxDurationMs === undefined
      ? undefined
      : setTimeout(
          () =>
            expire(
              `Agent timed out: maximum duration ${maxDurationMs} ms reached`,
            ),
          maxDurationMs,
        );
  return {
    touch() {
      if (!closed) idle.refresh();
    },
    close() {
      closed = true;
      clearTimeout(idle);
      if (total) clearTimeout(total);
    },
  };
}
