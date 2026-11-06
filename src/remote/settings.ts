import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { desktopControl } from "../core/tools.ts";
import { now } from "../core/util.ts";
import { finalJson, spawnAad } from "./aad.ts";

/**
 * How remote sessions are shown (docs/v2/remote.md): each user's choices for `aad assist`'s picture,
 * kept on this machine, and which video codecs its ffmpeg can encode, checked once.
 */

export const VIDEO_CODECS = ["h264", "vp9", "av1"] as const;

export const remoteSettingsSchema = z.object({
  /** auto: aad picks (changed tiles, video for big changes when it can); tiles: only changed tiles;
   *  a video codec; webp / jpeg: whole pictures. */
  format: z.enum(["auto", "tiles", ...VIDEO_CODECS, "webp", "jpeg"]),
  /** 1..100; 100 makes tiles lossless. */
  quality: z.number().int().min(1).max(100),
  /** Most frames a second; 0 leaves aad's default (5 for whole pictures, 30 otherwise). */
  fps: z.number().int().min(0).max(60),
  /** Widest picture sent; 0 for no limit. */
  maxWidth: z.number().int().min(0).max(7680),
  /** The desktop's pointer drawn over the picture. */
  cursor: z.boolean(),
  /** Copied text brought back from the remote side. */
  clipboard: z.boolean(),
  /** The browser a new browser session opens; empty for the first this machine has. */
  browser: z.enum(["", "chrome", "edge", "brave"]),
});
export type RemoteSettings = z.infer<typeof remoteSettingsSchema>;

export const DEFAULT_SETTINGS: RemoteSettings = { format: "auto", quality: 70, fps: 0, maxWidth: 1600, cursor: true, clipboard: true, browser: "" };

const key = (userId: string) => `remote_settings:${userId}`;

export function readSettings(app: App, userId: string): RemoteSettings {
  let saved: unknown = {};
  try {
    saved = JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", key(userId))?.value ?? "{}");
  } catch { /* unreadable: the defaults */ }
  const merged = remoteSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(saved as object) });
  return merged.success ? merged.data : { ...DEFAULT_SETTINGS };
}

export function saveSettings(app: App, userId: string, patch: Partial<RemoteSettings>): RemoteSettings {
  const next = remoteSettingsSchema.parse({ ...readSettings(app, userId), ...patch });
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key(userId), JSON.stringify(next));
  return next;
}

// ------------------------------------------------------------------------------------- video

/** What `aad assist --probe-video` found: the encoder that worked for each video codec. */
export type VideoProbe = { at: string; aad: string | null; ffmpeg: string | null; encoders: Partial<Record<(typeof VIDEO_CODECS)[number], string>> };

const PROBE_KEY = "remote_video_probe";
let probing: Promise<VideoProbe> | null = null;

/** The last check, if it was made with the aad installed now. */
export function cachedProbe(app: App): VideoProbe | null {
  try {
    const p = JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", PROBE_KEY)?.value ?? "null") as VideoProbe | null;
    return p && p.aad === desktopControl.status().version ? p : null;
  } catch {
    return null;
  }
}

export const probeRunning = () => probing !== null;

/** Try each video encoder once (tens of seconds when a hardware one hangs); kept until aad changes. */
export function probeVideo(app: App): Promise<VideoProbe> {
  probing ??= (async () => {
    try {
      const report = await finalJson(spawnAad(["assist", "--probe-video"]), 180_000);
      const encoders: VideoProbe["encoders"] = {};
      for (const codec of VIDEO_CODECS) if (typeof report?.encoders?.[codec] === "string") encoders[codec] = report.encoders[codec];
      const p: VideoProbe = { at: now(), aad: desktopControl.status().version, ffmpeg: report?.ffmpeg?.path ?? null, encoders };
      run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", PROBE_KEY, JSON.stringify(p));
      return p;
    } finally {
      probing = null;
    }
  })();
  return probing;
}

/**
 * `aad assist` options for these settings. With a video check at hand only codecs that work are
 * offered, each with its encoder named, so assist does not try every encoder again when it starts;
 * a video codec that does not work here falls back to auto.
 */
export function viewerArgs(s: RemoteSettings, kind: "browser" | "desktop", probe: VideoProbe | null): string[] {
  const video = probe ? VIDEO_CODECS.filter((c) => probe.encoders[c]) : null;
  const pictures = ["webp", "jpeg", "tiles"];
  let codecs: string[];
  if (s.format === "tiles") codecs = ["tiles", "webp", "jpeg"];
  else if (s.format === "webp" || s.format === "jpeg") codecs = [s.format];
  else if (s.format !== "auto" && (!video || video.includes(s.format))) codecs = [s.format, "webp", "jpeg"];
  else codecs = video ? [...pictures, ...video] : ["auto"];
  const args = ["--codecs", codecs.join(","), "--quality", String(s.quality), "--max-width", String(s.maxWidth)];
  if (probe) for (const c of VIDEO_CODECS) if (codecs.includes(c) && probe.encoders[c]) args.push("--encoder", probe.encoders[c]!);
  if (s.fps) args.push("--fps", String(s.fps));
  if (!s.clipboard) args.push("--no-clipboard");
  if (kind === "desktop" && !s.cursor) args.push("--hide-cursor");
  return args;
}
