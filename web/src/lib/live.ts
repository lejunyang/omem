/**
 * The page's one live connection to the server (`/api/events`, server-sent events), held only while
 * it is of use.
 *
 * Over plain http the browser keeps at most six connections per address, and every open omem tab
 * holds one of them for its events: with six tabs open the next request (a share link, a page)
 * waits in the browser's queue and never reaches the server. So the connection
 * - is opened only once the page asks for it (`enable`): a share link and the login page do not;
 * - is closed when the page has been hidden for `hiddenCloseMs` (a background tab, a minimised
 *   window), at once when the browser freezes the page or puts it in the back/forward cache;
 * - is opened again when the page is shown, and `onResync` listeners reload what may have changed
 *   meanwhile (events sent while it was closed are not replayed). The same happens when the browser
 *   reconnects by itself after the connection dropped (a server restart).
 *
 * A streaming answer in a hidden tab is not kept open either: it is reloaded whole on return.
 */
export const HIDDEN_CLOSE_MS = 45_000;

/** What of `EventSource` this uses. */
export type LiveSource = {
  onmessage: ((m: { data: string }) => void) | null;
  onopen: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  close(): void;
};

/** What of `document` / `window` this uses: whether the page is hidden, and its lifecycle events. */
export type LivePage = {
  hidden(): boolean;
  on(type: "visibilitychange" | "freeze" | "resume" | "pagehide" | "pageshow", fn: (e: { persisted?: boolean }) => void): void;
};

export type LiveOptions = {
  open: () => LiveSource;
  page?: LivePage | null;
  hiddenCloseMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

export function browserPage(): LivePage | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;
  return {
    hidden: () => document.visibilityState === "hidden",
    on: (type, fn) => (type === "pagehide" || type === "pageshow" ? window : document).addEventListener(type, fn as EventListener),
  };
}

export function createLive<E>(opts: LiveOptions) {
  const page = opts.page ?? null;
  const closeAfter = opts.hiddenCloseMs ?? HIDDEN_CLOSE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const listeners = new Set<(e: E) => void>();
  const resyncs = new Set<() => void>();
  let source: LiveSource | null = null;
  let enabled = false;
  /** Hidden long enough, frozen, or in the back/forward cache. */
  let away = false;
  let timer: unknown = null;
  /** A connection was open before: the next open has missed something. */
  let wasOpen = false;

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  function connect() {
    if (source || !enabled || away) return;
    const s = opts.open();
    source = s;
    s.onopen = () => {
      if (source !== s) return;
      if (wasOpen) for (const fn of [...resyncs]) fn();
      wasOpen = true;
    };
    s.onmessage = (m) => {
      if (source !== s) return;
      let e: E;
      try {
        e = JSON.parse(m.data) as E;
      } catch {
        return;
      }
      for (const fn of [...listeners]) fn(e);
    };
  }
  function disconnect() {
    stopTimer();
    if (!source) return;
    const s = source;
    source = null;
    s.onopen = s.onmessage = s.onerror = null;
    s.close();
  }
  /** Gone from view: close soon (hidden) or now (frozen, cached). */
  function leave(now: boolean) {
    if (now) {
      away = true;
      disconnect();
    } else if (timer === null && source) {
      timer = setTimer(() => {
        timer = null;
        away = true;
        disconnect();
      }, closeAfter);
    }
  }
  function back() {
    stopTimer();
    if (page?.hidden()) return;
    away = false;
    connect();
  }

  page?.on("visibilitychange", () => (page.hidden() ? leave(false) : back()));
  page?.on("freeze", () => leave(true));
  page?.on("resume", back);
  page?.on("pagehide", (e) => e.persisted && leave(true));
  page?.on("pageshow", (e) => e.persisted && back());

  return {
    /** Listen to the server's events; the connection itself follows `enable`. */
    subscribe(fn: (e: E) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Called when the connection is back after a gap: reload what the events would have told. */
    onResync(fn: () => void) {
      resyncs.add(fn);
      return () => void resyncs.delete(fn);
    },
    /** The page wants live events (the app) or not (a share link, logging in). */
    enable(on: boolean) {
      enabled = on;
      if (!on) disconnect();
      else if (page?.hidden()) {
        // Opened in the background: connect once it is looked at.
        away = true;
      } else connect();
    },
    /** For tests and diagnostics. */
    get state(): "off" | "open" | "away" {
      return source ? "open" : enabled && away ? "away" : "off";
    },
  };
}
