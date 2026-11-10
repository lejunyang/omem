import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ask, scheduleIngest } from "../agents/jobs.ts";
import type { App } from "../core/app.ts";
import { getSpace } from "../core/spaces.ts";
import { hasStoredFile, markStoredFileAdded } from "../core/stored-files.ts";
import { HttpError, newId, sha256 } from "../core/util.ts";
import { importText } from "./import.ts";
import { upsertSource } from "./store.ts";

/**
 * A clip from a client that is not omem itself (the browser extension's 拾取篮): text with
 * screenshots, either asked as a question or kept as an original.
 *
 * Each screenshot becomes an image original (`kind: image`, `meta.original`), so an agent reading it
 * gets the file path from read_source and can look at it; the text embeds it as `omem-file:` (the
 * pages render it) and names its `src:` id. `{{image:<key>}}` in the text marks where each goes.
 */

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 60_000;

export const clipSchema = z.object({
  mode: z.enum(["ask", "source"]),
  space: z.string().min(1),
  title: z.string().max(200).default(""),
  text: z.string().min(1).max(MAX_TEXT),
  /** Where it came from; kept on the originals so they can be traced back. */
  pageUrl: z.string().max(2000).default(""),
  /** Continue a conversation (ask only). */
  conversationId: z.string().optional(),
  images: z
    .array(z.object({ key: z.string().regex(/^[\w-]{1,40}$/), title: z.string().max(200).default(""), data: z.string().min(1) }))
    .max(20)
    .default([]),
});
export type ClipInput = z.infer<typeof clipSchema>;

/** PNG, JPEG or WebP by their first bytes; anything else is refused (the data comes from outside). */
export function imageExt(buf: Buffer): ".png" | ".jpg" | ".webp" | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

function storeImage(app: App, buf: Buffer, ext: string) {
  const name = `${sha256(buf).slice(0, 16)}${ext}`;
  mkdirSync(app.filesDir, { recursive: true });
  if (!hasStoredFile(app, name)) {
    writeFileSync(join(app.filesDir, name), buf);
    markStoredFileAdded();
  }
  return name;
}

export async function saveClip(app: App, userId: string, input: ClipInput) {
  getSpace(app, input.space);
  const clip = newId("clip");
  const images = input.images.map((img) => {
    const data = img.data.replace(/^data:[\w/+.-]+;base64,/, "");
    const buf = Buffer.from(data, "base64");
    if (buf.length > MAX_IMAGE_BYTES) throw new HttpError(413, `截图「${img.title || img.key}」超过 15 MB`);
    const ext = imageExt(buf);
    if (!ext) throw new HttpError(400, `截图「${img.title || img.key}」不是 PNG、JPEG 或 WebP`);
    const name = storeImage(app, buf, ext);
    const title = img.title.trim() || `截图 ${img.key}`;
    const r = upsertSource(app, {
      spaceId: input.space,
      kind: "image",
      uri: `clip/${clip}/${img.key}${ext}`,
      title,
      text: `![${title}](omem-file:${name})`,
      mime: ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`,
      meta: { original: name, clip, ...(input.pageUrl ? { pageUrl: input.pageUrl } : {}) },
    });
    return { key: img.key, title, name, sourceId: r.id };
  });
  const byKey = new Map(images.map((i) => [i.key, i]));
  // A key the text names without an image is dropped; an image the text never names goes at the end.
  const used = new Set<string>();
  let text = input.text.replace(/\{\{image:([\w-]+)\}\}/g, (_, key: string) => {
    const img = byKey.get(key);
    if (!img) return "";
    used.add(key);
    return `![${img.title}](omem-file:${img.name})\n（截图原件 src:${img.sourceId}）`;
  });
  const rest = images.filter((i) => !used.has(i.key));
  if (rest.length) text += `\n\n${rest.map((i) => `![${i.title}](omem-file:${i.name})\n（截图原件 src:${i.sourceId}）`).join("\n\n")}`;
  const imageSources = images.map((i) => ({ key: i.key, sourceId: i.sourceId }));

  if (input.mode === "source") {
    const title = input.title.trim() || text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "网页拾取";
    const note = importText(app, input.space, { title, text, kind: "note", uri: `clip/${clip}` });
    const run = scheduleIngest(app, input.space, [note.id, ...images.map((i) => i.sourceId)]);
    return { mode: "source" as const, sourceId: note.id, imageSources, ingestRun: run?.id ?? null };
  }
  const r = await ask(app, { text, spaceId: input.space, conversationId: input.conversationId, userId });
  return { mode: "ask" as const, conversationId: r.conversationId, messageId: r.messageId, runId: r.runId, imageSources };
}
