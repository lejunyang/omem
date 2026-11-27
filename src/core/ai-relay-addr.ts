import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Where backends run on an API key reach their provider through omem (core/ai-relay.ts): this
 * service's own address, set once it listens. Unset (tests, a command that starts no server), the
 * backends go to the provider directly. Kept apart from ai-relay.ts so config.ts can read it
 * without importing the app.
 */
let base: string | null = null;
export function useRelayBase(url: string | null) {
  base = url ? url.replace(/\/+$/, "") : null;
}
export const relayBase = () => base;

/** The address one backend's requests in one API format go to; the provider's own path follows it. */
export function relayUrl(provider: string, backend: string, format: "openai" | "anthropic") {
  return base ? `${base}/api/ai/relay/${encodeURIComponent(provider)}/${encodeURIComponent(backend)}/${format}` : null;
}

/**
 * What a relayed backend gets in place of the key: good for this backend on this service until it
 * restarts (the agents it launched stop with it). The key itself never reaches the agent.
 */
const secret = randomBytes(32);
export const relayToken = (backend: string) => "omem-relay-" + createHmac("sha256", secret).update(backend).digest("base64url").slice(0, 43);
export function relayTokenOk(backend: string, given: string | undefined) {
  const want = Buffer.from(relayToken(backend));
  const got = Buffer.from(given ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

type RelayActivity = (text: string) => void;
const clients = new Map<string, { backend: string; activity: RelayActivity }>();

/** Tie relay events to the Agent process, so concurrent runs on one backend do not see each other's waits. */
export function registerRelayClient(backend: string, activity: RelayActivity) {
  const token = "omem-relay-client-" + randomBytes(32).toString("base64url");
  clients.set(token, { backend, activity });
  return { token, close: () => { clients.delete(token); } };
}

export function relayActivity(backend: string, token: string | undefined) {
  const client = token && clients.get(token);
  return client && client.backend === backend ? client.activity : undefined;
}
