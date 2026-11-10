import { describe, expect, it } from "vitest";
import { createLive, type LivePage, type LiveSource } from "../web/src/lib/live.ts";

/** A page whose visibility and lifecycle events the test drives, and sources it can open and feed. */
function harness(startHidden = false) {
  let hidden = startHidden;
  const handlers = new Map<string, ((e: { persisted?: boolean }) => void)[]>();
  const page: LivePage = { hidden: () => hidden, on: (t, fn) => void handlers.set(t, [...(handlers.get(t) ?? []), fn]) };
  const fire = (t: string, e: { persisted?: boolean } = {}) => handlers.get(t)?.forEach((fn) => fn(e));
  const sources: (LiveSource & { closed: boolean })[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const live = createLive<{ n: number }>({
    open: () => {
      const s = { onmessage: null, onopen: null, onerror: null, closed: false, close() { this.closed = true; } } as LiveSource & { closed: boolean };
      sources.push(s);
      return s;
    },
    page,
    hiddenCloseMs: 1000,
    setTimer: (fn) => (timers.set(++nextTimer, fn), nextTimer),
    clearTimer: (t) => void timers.delete(t as number),
  });
  return {
    live,
    sources,
    open: () => sources.filter((s) => !s.closed),
    hide: () => ((hidden = true), fire("visibilitychange")),
    show: () => ((hidden = false), fire("visibilitychange")),
    fire,
    /** The hidden-close timer running out. */
    elapse: () => {
      const due = [...timers.values()];
      timers.clear();
      due.forEach((fn) => fn());
    },
    pendingTimers: () => timers.size,
  };
}

describe("live events connection", () => {
  it("opens nothing until the page asks for it (a share link never does)", () => {
    const h = harness();
    const got: number[] = [];
    h.live.subscribe((e) => got.push(e.n));
    expect(h.sources).toHaveLength(0);
    h.live.enable(false);
    expect(h.sources).toHaveLength(0);
    h.live.enable(true);
    expect(h.open()).toHaveLength(1);
    h.sources[0].onmessage?.({ data: JSON.stringify({ n: 1 }) });
    h.sources[0].onmessage?.({ data: "not json" });
    expect(got).toEqual([1]);
    // Going to the share page in the same tab closes it.
    h.live.enable(false);
    expect(h.open()).toHaveLength(0);
    expect(h.live.state).toBe("off");
  });

  it("closes after the page has been hidden a while and reopens with a resync when shown", () => {
    const h = harness();
    let resyncs = 0;
    h.live.onResync(() => resyncs++);
    h.live.enable(true);
    h.sources[0].onopen?.();
    expect(resyncs).toBe(0);

    // Hidden briefly: nothing changes.
    h.hide();
    expect(h.pendingTimers()).toBe(1);
    h.show();
    expect(h.pendingTimers()).toBe(0);
    expect(h.open()).toHaveLength(1);

    // Hidden long enough: closed.
    h.hide();
    h.elapse();
    expect(h.open()).toHaveLength(0);
    expect(h.live.state).toBe("away");

    // Shown again: a new connection, and once it is open the views reload.
    h.show();
    expect(h.open()).toHaveLength(1);
    expect(h.sources).toHaveLength(2);
    expect(resyncs).toBe(0);
    h.sources[1].onopen?.();
    expect(resyncs).toBe(1);
  });

  it("resyncs when the browser reconnects by itself (server restart)", () => {
    const h = harness();
    let resyncs = 0;
    h.live.onResync(() => resyncs++);
    h.live.enable(true);
    h.sources[0].onopen?.();
    h.sources[0].onerror?.();
    h.sources[0].onopen?.();
    expect(resyncs).toBe(1);
  });

  it("closes at once when frozen or put in the back/forward cache", () => {
    const h = harness();
    h.live.enable(true);
    h.fire("freeze");
    expect(h.open()).toHaveLength(0);
    h.fire("resume");
    expect(h.open()).toHaveLength(1);

    h.fire("pagehide", { persisted: false });
    expect(h.open()).toHaveLength(1);
    h.fire("pagehide", { persisted: true });
    expect(h.open()).toHaveLength(0);
    h.fire("pageshow", { persisted: true });
    expect(h.open()).toHaveLength(1);
  });

  it("a page opened in the background connects only once looked at", () => {
    const h = harness(true);
    h.live.enable(true);
    expect(h.sources).toHaveLength(0);
    h.fire("resume");
    expect(h.sources).toHaveLength(0);
    h.show();
    expect(h.open()).toHaveLength(1);
  });

  it("ignores messages from a source it already closed", () => {
    const h = harness();
    const got: number[] = [];
    h.live.subscribe((e) => got.push(e.n));
    h.live.enable(true);
    const first = h.sources[0];
    const onmessage = first.onmessage!;
    h.hide();
    h.elapse();
    onmessage({ data: JSON.stringify({ n: 1 }) });
    expect(got).toEqual([]);
  });
});
