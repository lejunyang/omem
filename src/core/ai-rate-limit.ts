import type { App } from "./app.ts";
import type { Config } from "./config.ts";

export const AI_MINUTE = 60_000;
const HOUR_SECONDS = 3600;
type Provider = Config["ai"]["providers"][number];
type Limits = { rpm?: number; tpm?: number };
type Usage = { at: number; tokens: number };
type Settle = (actualTokens: number) => void;
type WaitOptions = { signal: AbortSignal; deadline?: number; onWait?: (ms: number) => void };
type Request = WaitOptions & {
  started: number;
  tokens: number;
  queued: boolean;
  resolve: (settle: Settle) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};

export class AiRateLimitWaitExpired extends Error {
  constructor() {
    super("API key 限额的等待时间超过本次调用时限");
  }
}

function limitsFor(provider: Provider, model: string): Limits | undefined {
  const limits = provider.limits;
  if (!limits) return;
  const specific = limits.models && Object.hasOwn(limits.models, model) ? limits.models[model] : undefined;
  const rpm = specific?.rpm ?? limits.rpm;
  const tpm = specific?.tpm ?? limits.tpm;
  if (rpm !== undefined || tpm !== undefined) return { rpm, tpm };
}

class MinuteQueue {
  private usage: Usage[] = [];
  private tokens = 0;
  private pending: Request[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private blockedUntil = 0;
  limits: Limits;
  private waited: (ms: number) => void;

  constructor(limits: Limits, waited: (ms: number) => void) {
    this.limits = limits;
    this.waited = waited;
  }

  private expire(now: number) {
    let expired = 0;
    for (const sent of this.usage) {
      if (sent.at + AI_MINUTE > now) break;
      this.tokens -= sent.tokens;
      expired++;
    }
    if (expired) this.usage.splice(0, expired);
  }

  private readyAt(tokens: number, now: number) {
    const { rpm = Infinity, tpm = Infinity } = this.limits;
    let requests = this.usage.length;
    // An oversized request is still subject to RPM and any upstream wait.
    let total = tokens > tpm ? 0 : this.tokens + tokens;
    let ready = Math.max(now, this.blockedUntil);
    for (const sent of this.usage) {
      if (requests < rpm && total <= tpm) break;
      ready = Math.max(ready, sent.at + AI_MINUTE);
      requests--;
      total -= sent.tokens;
    }
    return ready;
  }

  private pump() {
    clearTimeout(this.timer);
    const now = Date.now();
    this.expire(now);
    while (this.pending.length) {
      const head = this.pending[0];
      const ready = this.readyAt(head.tokens, now);
      if (ready > now) {
        if (head.deadline !== undefined && ready >= head.deadline) {
          this.remove(head, now);
          head.reject(new AiRateLimitWaitExpired());
          continue;
        }
        // Even the first place in line could not make these deadlines.
        for (const req of this.pending.slice(1)) {
          if (req.deadline !== undefined && ready >= req.deadline) {
            this.remove(req, now);
            req.reject(new AiRateLimitWaitExpired());
          }
        }
        head.queued = true;
        this.timer = setTimeout(() => this.pump(), ready - now);
        return;
      }
      this.remove(head, now);
      if (head.deadline !== undefined && now >= head.deadline) {
        head.reject(new AiRateLimitWaitExpired());
        continue;
      }
      const sent = { at: now, tokens: head.tokens };
      this.usage.push(sent);
      this.tokens += sent.tokens;
      head.resolve((actual) => {
        if (sent.at + AI_MINUTE <= Date.now()) return;
        this.tokens += actual - sent.tokens;
        sent.tokens = actual;
        this.pump();
      });
    }
  }

  private remove(req: Request, now: number) {
    this.pending.splice(this.pending.indexOf(req), 1);
    req.signal.removeEventListener("abort", req.abort);
    if (!req.queued || now <= req.started) return;
    const ms = now - req.started;
    this.waited(ms);
    req.onWait?.(ms);
  }

  acquire(tokens: number, options: WaitOptions): Promise<Settle> {
    const { signal, deadline } = options;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const abort = () => {
        this.remove(req, Date.now());
        reject(deadline !== undefined && (Date.now() >= deadline || signal.reason?.name === "TimeoutError")
          ? new AiRateLimitWaitExpired() : signal.reason);
        this.pump();
      };
      const req = { ...options, tokens, started, resolve, reject, abort, queued: this.pending.length > 0 };
      this.pending.push(req);
      signal.addEventListener("abort", abort, { once: true });
      this.pump();
    });
  }

  defer(until: number) {
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.pump();
  }

  snapshot(now: number) {
    this.expire(now);
    return {
      ...this.limits, requests: this.usage.length, tokens: this.tokens, queued: this.pending.length,
      nextReleaseAt: this.usage.length ? this.usage[0].at + AI_MINUTE : null,
      blockedUntil: this.blockedUntil > now ? this.blockedUntil : null,
    };
  }
}

type ProviderState = { models: Map<string, MinuteQueue>; waits: Map<number, { count: number; ms: number }> };
const states = new WeakMap<App, Map<string, ProviderState>>();

function pruneWaits(state: ProviderState, second: number) {
  for (const at of state.waits.keys()) {
    if (at > second - HOUR_SECONDS) break;
    state.waits.delete(at);
  }
}

/** One queue per configured key and the model ID actually sent on the wire. */
export function aiRateLimit(app: App, provider: Provider, model: string) {
  const limits = limitsFor(provider, model);
  if (!limits) return;
  let providers = states.get(app);
  if (!providers) states.set(app, providers = new Map());
  let state = providers.get(provider.id);
  if (!state) providers.set(provider.id, state = { models: new Map(), waits: new Map() });
  const entry = state;
  let queue = entry.models.get(model);
  if (!queue) {
    // Forget inactive model IDs when a new one is used. Queued and recently used IDs keep their state.
    const now = Date.now();
    for (const [id, existing] of entry.models) {
      const s = existing.snapshot(now);
      if (!s.requests && !s.queued && !s.blockedUntil) entry.models.delete(id);
    }
    queue = new MinuteQueue(limits, (ms) => {
      const second = Math.floor(Date.now() / 1000);
      pruneWaits(entry, second);
      const bucket = entry.waits.get(second) ?? { count: 0, ms: 0 };
      bucket.count++;
      bucket.ms += ms;
      entry.waits.set(second, bucket);
    });
    entry.models.set(model, queue);
  }
  queue.limits = limits;
  return queue;
}

export function aiRateLimitStats(app: App, provider: Provider, now = Date.now()) {
  if (!provider.limits) return null;
  const state = states.get(app)?.get(provider.id);
  const waits = { count: 0, ms: 0 };
  const windows = [];
  if (state) {
    pruneWaits(state, Math.floor(now / 1000));
    for (const bucket of state.waits.values()) {
      waits.count += bucket.count;
      waits.ms += bucket.ms;
    }
    for (const [model, queue] of state.models) {
      const limits = limitsFor(provider, model);
      if (limits) windows.push({ model, ...queue.snapshot(now), ...limits });
    }
  }
  return { waits, windows };
}
