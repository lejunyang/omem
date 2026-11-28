import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_MINUTE, aiRateLimit, aiRateLimitStats, AiRateLimitWaitExpired } from "../src/core/ai-rate-limit.ts";
import type { App } from "../src/core/app.ts";
import { configSchema, type Config } from "../src/core/config.ts";

type Provider = Config["ai"]["providers"][number];
const makeProvider = (limits?: Provider["limits"]) => configSchema.parse({
  ai: { providers: [{ id: "example", kind: "ark", limits }] },
}).ai.providers[0];
const live = () => ({ signal: new AbortController().signal });
const ID = "ep-example";

describe("API key minute limits", () => {
  let app: App;
  beforeEach(() => {
    app = {} as App;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:40Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("validates positive integers and applies per-model overrides field by field", () => {
    expect(() => makeProvider({ rpm: 0 })).toThrow();
    expect(() => makeProvider({ models: { [ID]: { tpm: 2.1 } } })).toThrow();
    expect(aiRateLimit(app, makeProvider(), ID)).toBeUndefined();
    const provider = makeProvider({ rpm: 5, tpm: 100, models: { [ID]: { rpm: 2 } } });
    expect(aiRateLimit(app, provider, ID)?.limits).toEqual({ rpm: 2, tpm: 100 });
    expect(aiRateLimit(app, provider, "another")?.limits).toEqual({ rpm: 5, tpm: 100 });
    expect(aiRateLimit(app, makeProvider({ models: { [ID]: { rpm: 1 } } }), "another")).toBeUndefined();
  });

  it("shares a counter across callers and admits queued requests in arrival order as capacity expires", async () => {
    const provider = makeProvider({ rpm: 2 });
    const first = aiRateLimit(app, provider, ID)!;
    await first.acquire(1, live());
    await vi.advanceTimersByTimeAsync(1000);
    await aiRateLimit(app, provider, ID)!.acquire(1, live());
    const sent: number[] = [];
    const third = first.acquire(1, live()).then(() => sent.push(3));
    const fourth = first.acquire(1, live()).then(() => sent.push(4));
    await aiRateLimit(app, provider, "another")!.acquire(1, live());
    await vi.advanceTimersByTimeAsync(AI_MINUTE - 1001);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([3]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([third, fourth]);
    expect(sent).toEqual([3, 4]);
    expect(aiRateLimitStats(app, provider)).toMatchObject({
      waits: { count: 2, ms: 119_000 },
      windows: [{ model: ID, rpm: 2, requests: 2, tokens: 2, queued: 0 }, { model: "another", requests: 0 }],
    });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(aiRateLimitStats(app, provider)?.waits).toEqual({ count: 0, ms: 0 });
  });

  it("wakes the head immediately when actual usage frees tokens and sends an oversized request", async () => {
    const queue = aiRateLimit(app, makeProvider({ tpm: 20 }), ID)!;
    const first = await queue.acquire(15, live());
    const admitted = vi.fn();
    const second = queue.acquire(10, live()).then(admitted);
    await vi.advanceTimersByTimeAsync(2000);
    expect(admitted).not.toHaveBeenCalled();
    first(9);
    await second;
    expect(queue.snapshot(Date.now())).toMatchObject({ requests: 2, tokens: 19 });
    await queue.acquire(80, live());
    expect(queue.snapshot(Date.now())).toMatchObject({ requests: 3, tokens: 99 });
    await vi.advanceTimersByTimeAsync(AI_MINUTE);
    first(6);
    expect(queue.snapshot(Date.now())).toMatchObject({ requests: 0, tokens: 0 });
  });

  it("removes canceled waiters and skips a reserve that cannot make its deadline", async () => {
    const queue = aiRateLimit(app, makeProvider({ rpm: 1 }), ID)!;
    await queue.acquire(1, live());
    const controller = new AbortController();
    const waiting = queue.acquire(1, { signal: controller.signal });
    controller.abort(new Error("disconnected"));
    await expect(waiting).rejects.toThrow("disconnected");
    await expect(queue.acquire(1, { ...live(), deadline: Date.now() + 1000 })).rejects.toBeInstanceOf(AiRateLimitWaitExpired);
    expect(queue.snapshot(Date.now())).toMatchObject({ requests: 1, queued: 0 });
  });
});
