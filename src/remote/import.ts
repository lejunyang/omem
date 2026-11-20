import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { HttpError, newId, now, sha256 } from "../core/util.ts";
import { imageExt } from "../sources/clips.ts";
import { createRecording, recordingDir, recordingSummary, updateRecording, type Recording } from "./recordings.ts";
import { OPAQUE, redactBody, redactHeaders, redactUrl } from "./redact.ts";

/**
 * A recording made in the owner's own Chrome by the omem extension (chrome/, 录制), uploaded when it
 * stops. It is written as aad writes a browser recording (steps.jsonl, evidence/network.jsonl, images/),
 * so read_recording, the request grouping and save_skill(from_recording) read it unchanged. The
 * extension has no replay steps and no page-change diff; it has the owner's marks ("这里看的是……").
 */

const MAX_STEPS = 1000;
const MAX_REQUESTS = 5000;
const MAX_IMAGES = 80;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
const VALUE_MAX = 500;

const str = (max: number) => z.string().max(max);
const action = z.object({
  kind: z.enum(["click", "input", "submit", "enter", "navigate", "mark"]),
  label: str(400).optional(),
  role: str(60).optional(),
  tag: str(40).optional(),
  type: str(40).optional(),
  selector: str(1000).optional(),
  heading: str(200).optional(),
  text: str(1000).optional(),
  value: z.string().max(20_000).nullable().optional(),
  protected: z.boolean().optional(),
  url: str(4000).optional(),
  title: str(400).optional(),
  note: str(4000).optional(),
});

export const importSchema = z.object({
  goal: str(2000).default(""),
  startUrl: str(4000).default(""),
  startTitle: str(400).default(""),
  startedAt: z.number().optional(),
  steps: z
    .array(z.object({ at: z.number(), tab: z.number().int().optional(), kind: z.enum(["action", "mark"]), action, screenshot: z.string().regex(/^[\w-]{1,60}$/).optional() }))
    .max(MAX_STEPS)
    .default([]),
  network: z
    .array(
      z.object({
        at: z.number(),
        tab: z.number().int().optional(),
        method: str(16),
        url: str(8000),
        type: str(40).optional(),
        status: z.number().int().nullable().optional(),
        durationMs: z.number().nullable().optional(),
        mimeType: str(200).optional(),
        requestHeaders: z.record(z.string(), z.string()).optional(),
        responseHeaders: z.record(z.string(), z.string()).optional(),
        requestBody: z.string().max(MAX_BODY * 2).optional(),
        requestBodyTruncated: z.boolean().optional(),
        responseBody: z.string().max(MAX_BODY * 2).optional(),
        responseBodyTruncated: z.boolean().optional(),
        error: str(400).optional(),
        source: z.enum(["webRequest", "devtools"]).optional(),
      }),
    )
    .max(MAX_REQUESTS)
    .default([]),
  images: z.array(z.object({ key: z.string().regex(/^[\w-]{1,60}$/), data: z.string().min(1) })).max(MAX_IMAGES).default([]),
  /** Hand it to the assistant to organize into a skill (the default), or only keep it. */
  organize: z.boolean().default(true),
  conversationId: z.string().max(100).optional(),
  /** A 关注 whose conversation the organizing message goes to. */
  contextId: z.string().max(100).optional(),
  /** An item the recording is about: named in the organizing message. */
  itemId: z.string().max(100).optional(),
  /** A demonstration it was made in (remote/demos.ts): it goes on that timeline, organized when the demonstration stops. */
  demoId: z.string().max(100).optional(),
});
export type RecordingImport = z.infer<typeof importSchema>;
type Step = RecordingImport["steps"][number];

/** An input whose name says it holds a secret: its value is not kept, whatever the extension sent. */
const SECRET_LABEL = /pass(word)?|pwd|passcode|token|secret|otp|api[\s_-]?key|cvv|cvc|card\s*number|卡号|验证码|密码|口令|安全码|身份证/i;

const clip = (text: string | undefined, max: number) => (text && text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

function decodeImage(data: string): Buffer {
  const buf = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(400, `截图太大（${Math.round(buf.length / 1024)} KB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）`);
  return buf;
}

/** One step as aad writes it: the action with the names a reader and a replay find the element by. */
function stepRecord(s: Step, id: number, shots: Map<string, string>) {
  const a = s.action;
  const secret = a.kind === "input" && (a.protected || a.type === "password" || SECRET_LABEL.test(`${a.label ?? ""} ${a.selector ?? ""}`));
  const label = a.label ?? "";
  const shot = s.screenshot ? shots.get(s.screenshot) : undefined;
  return {
    id,
    at_ms: s.at,
    page_id: s.tab != null ? `tab-${s.tab}` : "tab",
    frame_id: "",
    kind: s.kind,
    action: {
      ...a,
      ...(a.url ? { url: redactUrl(a.url) } : {}),
      name: label,
      ...(a.kind === "input" ? { value: secret ? null : (a.value ?? "").slice(0, VALUE_MAX), protected: secret } : {}),
      ...(a.role || label ? { control: { role: a.role ?? "", name: label } } : {}),
      ...(a.selector ? { locator: { role: a.role ?? null, name: label, css: a.selector } } : {}),
    },
    changes: [] as unknown[],
    screenshots: shot ? [{ path: shot, captured_ms: s.at }] : [],
    network: [] as unknown[],
    omitted_changes: 0,
  };
}

/** Write the recording's files and its row; the organizing message is the caller's. */
export function importRecording(app: App, userId: string, input: RecordingImport): Recording {
  // Screenshots: only images, checked before anything is written; each kept once under images/ like aad's.
  const wanted = new Set(input.steps.map((s) => s.screenshot).filter(Boolean));
  const images = input.images.filter((img) => wanted.has(img.key)).map((img) => {
    const buf = decodeImage(img.data);
    const ext = imageExt(buf);
    if (!ext) throw new HttpError(400, `截图 ${img.key} 不是 PNG、JPEG 或 WebP`);
    return { key: img.key, buf, path: `images/${sha256(buf).slice(0, 24)}${ext}` };
  });

  const id = newId("rec");
  const dir = recordingDir(app, id);
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const shots = new Map<string, string>();
  for (const img of images) {
    mkdirSync(join(dir, "images"), { recursive: true });
    writeFileSync(join(dir, img.path), img.buf);
    shots.set(img.key, img.path);
  }

  const startedAt = input.startedAt ?? Math.min(...input.steps.map((s) => s.at), ...input.network.map((q) => q.at), Date.now());
  const ordered = [...input.steps].sort((a, b) => a.at - b.at);
  const steps = [
    { id: 0, at_ms: startedAt, page_id: "tab", frame_id: "", kind: "baseline", action: { title: input.startTitle, url: input.startUrl ? redactUrl(input.startUrl) : "" }, changes: [], screenshots: [], network: [] as unknown[], omitted_changes: 0 },
    ...ordered.map((s, i) => stepRecord(s, i + 1, shots)),
  ];

  // Each request belongs to the step last taken in its tab before it started (aad: temporal, inferred).
  const requests = [...input.network].sort((a, b) => a.at - b.at);
  let responseBodies = 0;
  const evidence = requests.map((q, i) => {
    let step = 0;
    for (let k = ordered.length - 1; k >= 0; k--) {
      if (ordered[k].at <= q.at && (q.tab == null || ordered[k].tab == null || ordered[k].tab === q.tab)) {
        step = k + 1;
        break;
      }
    }
    const url = redactUrl(q.url);
    const sent = clip(redactBody(q.requestBody), MAX_BODY);
    const got = clip(redactBody(q.responseBody), MAX_BODY);
    if (got.text && got.text !== OPAQUE) responseBodies++;
    const record = {
      id: `req-${i + 1}`,
      page_id: q.tab != null ? `tab-${q.tab}` : "tab",
      type: q.type ?? "",
      step_id: step,
      association: "temporal/tab; inferred",
      request: { method: q.method.toUpperCase(), url, ...(q.requestHeaders ? { headers: redactHeaders(q.requestHeaders) } : {}), ...(sent.text ? { postData: sent.text, postDataTruncated: sent.truncated || !!q.requestBodyTruncated } : {}) },
      response: { status: q.status ?? null, ...(q.responseHeaders ? { headers: redactHeaders(q.responseHeaders) } : {}), ...(q.mimeType ? { mimeType: q.mimeType } : {}) },
      ...(got.text ? { body: got.text, body_truncated: got.truncated || !!q.responseBodyTruncated } : { body_status: q.source === "devtools" ? "unavailable" : "not_captured_without_devtools" }),
      started_ms: q.at,
      ...(q.durationMs != null ? { duration_ms: Math.round(q.durationMs) } : {}),
      ...(q.error ? { error: q.error } : {}),
      source: q.source ?? "webRequest",
      count: 1,
    };
    const s = steps[step];
    if (s.network.length < 60) s.network.push({ ref: record.id, method: record.request.method, url, route: url.split("?")[0], status: record.response.status, count: 1 });
    return record;
  });

  writeFileSync(join(dir, "steps.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(dir, "evidence", "network.jsonl"), evidence.map((r) => JSON.stringify(r)).join("\n") + (evidence.length ? "\n" : ""));

  const target = input.startUrl ? redactUrl(input.startUrl) : "";
  createRecording(app, { id, kind: "browser", goal: input.goal, target, dir, conversationId: input.conversationId ?? null, userId });
  const marks = ordered.filter((s) => s.kind === "mark").length;
  const summary = { ...recordingSummary(dir), source: "chrome-extension", marks, responseBodies, firstPage: target || null };
  return updateRecording(app, id, { status: "done", summary, finishedAt: now() });
}
