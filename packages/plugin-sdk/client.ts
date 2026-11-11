/**
 * The plugin page's side of the bridge (docs/v2/plugins.md). The page runs in a sandboxed
 * iframe without omem's origin: it cannot read the owner's token or call /api itself. It asks
 * the shell (web/src/views/Plugin.vue) by postMessage, and the shell forwards only paths under
 * /api/plugins/<this plugin>/. The shell also sends the theme and the server events of this plugin.
 */
export type OmemEvent =
  | { type: "plugin"; plugin: string; conversationId: string; blockId?: string; settings?: boolean }
  | { type: "run"; runId: string; status: string };

export { renderBlock, renderView, GENERIC_KINDS, type BlockView, type ViewComponent, type UiField } from "./blocks";

export type Omem = {
  plugin: string;
  /** The query of the shell's route (#/plugin/<id>?session=…): a link can open a given session. */
  params: Record<string, string>;
  /** Paths are relative to /api/plugins/<id>/ (e.g. "sessions"). */
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  on(fn: (e: OmemEvent) => void): () => void;
  /** Open an omem page in the shell (e.g. "/learn"). */
  navigate(to: string): void;
  /** Open the shell's settings dialog for this plugin; a saved change arrives as a plugin event with settings: true. */
  openSettings(): void;
  /**
   * A WebSocket to one of the plugin's streams (its service, started if needed), opened by the shell
   * as the owner and relayed here. Binary messages arrive as ArrayBuffer.
   */
  stream(name: string): OmemStream;
  /**
   * A voice conversation (the manifest says `voice: true`). The shell takes the microphone and talks to
   * the voice model of settings → AI → 语音 with `instructions` and no tools; this page gets the
   * transcript as it grows and the whole of it at the end, never the audio. Call it from a click: the
   * shell refuses a start the person did not just ask for (the promise rejects, `code: "gesture"`).
   */
  voice(o: { instructions: string; onTurns?: (turns: VoiceTurn[]) => void; onState?: (state: VoiceState, detail?: string) => void }): Promise<OmemVoice>;
  /** Whether voice can be used now, and why not (not declared, no voice model yet: `detail` says where to set it up). */
  voiceStatus(): Promise<VoiceStatus>;
};

export type VoiceTurn = { role: "user" | "assistant"; text: string; final: boolean };
export type VoiceState = "connecting" | "live" | "ended" | "failed";
export type VoiceStatus = { allowed: boolean; ready: boolean; detail: string; api: "live" | "realtime" | null; model: string | null };
/** What a finished conversation leaves: both sides as text, when it ran, on which model. */
export type VoiceRecord = { transcript: { role: "user" | "assistant"; text: string }[]; startedAt: string; endedAt: string; api: string; model: string };
export type OmemVoice = {
  /** End it (or take what is left after the other side ended it). */
  stop(): Promise<VoiceRecord>;
  mute(on: boolean): void;
  /** Resolves when the conversation ends, by stop(), by the shell's own “结束” button, or by a dropped connection. */
  ended: Promise<VoiceRecord>;
};

export type OmemStream = {
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (reason: string) => void;
};

type Msg = { omem: 1; type: string; [k: string]: unknown };

let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<(e: OmemEvent) => void>();
const streams = new Map<number, OmemStream>();
type VoiceWait = {
  started: { resolve: (v: OmemVoice) => void; reject: (e: Error) => void } | null;
  ended: (r: VoiceRecord) => void;
  onTurns?: (turns: VoiceTurn[]) => void;
  onState?: (state: VoiceState, detail?: string) => void;
  voice: OmemVoice;
};
const voices = new Map<number, VoiceWait>();
const send = (m: Record<string, unknown>) => window.parent.postMessage({ omem: 1, ...m }, "*");

function applyTheme(vars: Record<string, string>, scheme: string) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
}

let ready: Promise<Omem> | null = null;

export function connect(): Promise<Omem> {
  ready ??= new Promise((resolve) => {
    window.addEventListener("message", (e) => {
      if (e.source !== window.parent) return;
      const m = e.data as Msg;
      if (!m || m.omem !== 1) return;
      if (m.type === "init" || m.type === "theme") applyTheme(m.vars as Record<string, string>, String(m.scheme));
      if (m.type === "init") {
        const plugin = String(m.plugin);
        const request = <T>(method: string, path: string, body?: unknown) =>
          new Promise<T>((res, rej) => {
            const id = ++seq;
            waiting.set(id, { resolve: res as (v: unknown) => void, reject: rej });
            send({ type: "request", id, method, path, body });
          });
        resolve({
          plugin,
          params: (m.params as Record<string, string>) ?? {},
          get: (path) => request("GET", path),
          post: (path, body) => request("POST", path, body ?? {}),
          on: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
          navigate: (to) => send({ type: "navigate", to }),
          openSettings: () => send({ type: "settings" }),
          stream: (name) => {
            const sid = ++seq;
            const st: OmemStream = {
              send: (data) => (typeof data === "string" ? send({ type: "stream-send", sid, data }) : window.parent.postMessage({ omem: 1, type: "stream-send", sid, data }, "*", [data])),
              close: () => {
                streams.delete(sid);
                send({ type: "stream-close", sid });
              },
            };
            streams.set(sid, st);
            send({ type: "stream-open", sid, name });
            return st;
          },
          voiceStatus: () => request<VoiceStatus>("GET", "voice"),
          voice: (o) =>
            new Promise<OmemVoice>((resolve, reject) => {
              const vid = ++seq;
              let ended!: (r: VoiceRecord) => void;
              const done = new Promise<VoiceRecord>((r) => (ended = r));
              const voice: OmemVoice = {
                stop: () => {
                  send({ type: "voice-stop", vid });
                  return done;
                },
                mute: (on) => send({ type: "voice-mute", vid, on }),
                ended: done,
              };
              voices.set(vid, { started: { resolve, reject }, ended, onTurns: o.onTurns, onState: o.onState, voice });
              send({ type: "voice-start", vid, instructions: o.instructions });
            }),
        });
      } else if (m.type === "response") {
        const w = waiting.get(m.id as number);
        if (!w) return;
        waiting.delete(m.id as number);
        if (m.ok) w.resolve(m.data);
        else w.reject(new Error(String(m.error ?? "请求失败")));
      } else if (m.type === "event") for (const l of listeners) l(m.event as OmemEvent);
      else if (m.type === "voice-event") {
        const v = voices.get(m.vid as number);
        if (!v) return;
        if (m.event === "turns") v.onTurns?.(m.turns as VoiceTurn[]);
        else if (m.event === "state") v.onState?.(m.state as VoiceState, m.detail ? String(m.detail) : undefined);
        else if (m.event === "started") {
          v.started?.resolve(v.voice);
          v.started = null;
        } else if (m.event === "error") {
          // Refused or failed before it started.
          v.started?.reject(Object.assign(new Error(String(m.error ?? "语音没有连上")), { code: m.code ? String(m.code) : undefined }));
          voices.delete(m.vid as number);
        } else if (m.event === "ended") {
          v.ended(m.record as VoiceRecord);
          voices.delete(m.vid as number);
        }
      }
      else if (m.type === "stream-event") {
        const st = streams.get(m.sid as number);
        if (!st) return;
        if (m.event === "open") st.onopen?.();
        else if (m.event === "message") st.onmessage?.(m.data as string | ArrayBuffer);
        else if (m.event === "close") {
          streams.delete(m.sid as number);
          st.onclose?.(String(m.reason ?? ""));
        }
      }
    });
    send({ type: "ready" });
  });
  return ready;
}
