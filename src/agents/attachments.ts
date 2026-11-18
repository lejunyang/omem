import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { App } from "../core/app.ts";
import { hasStoredFile, markStoredFileAdded, storedPath } from "../core/stored-files.ts";
import { HttpError, sha256 } from "../core/util.ts";

/**
 * Files pasted or dropped into the web chat. Each is kept with the stored originals
 * (files/<hash>.<ext>, served at /api/files/<name>); the message says where it is referenced
 * (“[图片1]” in its text) and keeps the list in `meta.attachments`, and the agent is given the
 * path of each (renderMessages), to open with its own file or image tools.
 */
export type Attachment = { name: string; filename: string; kind: "image" | "file"; label: string; size: number };

const IMAGE = /^\.(png|jpe?g|gif|webp|bmp|svg)$/;
export const MAX_ATTACHMENTS = 20;
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Keep one uploaded file; the same bytes keep the same name. */
export function saveAttachment(app: App, buf: Buffer, filename: string, mime = ""): Omit<Attachment, "label"> {
  if (buf.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, `${filename} 超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
  const fromMime = mime.startsWith("image/") ? `.${mime.slice(6).replace("jpeg", "jpg").replace(/\+.*$/, "")}` : "";
  const ext = (extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "") || fromMime || ".bin").slice(0, 12);
  const name = `${sha256(buf).slice(0, 16)}${ext.length > 1 ? ext : ".bin"}`;
  mkdirSync(app.filesDir, { recursive: true });
  if (!hasStoredFile(app, name)) {
    writeFileSync(join(app.filesDir, name), buf);
    markStoredFileAdded();
  }
  return { name, filename: filename.replace(/[\r\n]/g, " ").slice(0, 200) || name, kind: IMAGE.test(ext) || mime.startsWith("image/") ? "image" : "file", size: buf.length };
}

/** The attachments a message may carry: stored files only, each named once. */
export function checkAttachments(app: App, list: Attachment[]): Attachment[] {
  if (list.length > MAX_ATTACHMENTS) throw new HttpError(400, `一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
  for (const a of list) {
    if (!/^[a-f0-9]{16}\.[a-z0-9]+$/.test(a.name) || !hasStoredFile(app, a.name)) throw new HttpError(400, `附件不存在：${a.filename || a.name}`);
  }
  return list;
}

/** For the agent: where each attachment is, under the label the text refers to it by. */
export function attachmentText(app: App | undefined, list: unknown): string {
  if (!Array.isArray(list) || !list.length) return "";
  const lines = (list as Attachment[]).map((a) => {
    const path = (app && storedPath(app, a.name)) ?? a.name;
    return `- [${a.label}] ${a.filename}：${path}${a.kind === "image" ? "（图片，用你的文件或图片工具打开看）" : "（文件，用你的文件工具读）"}`;
  });
  return `\n（本人随消息附上的文件，正文里的 [图片N] / [文件N] 指的就是它们：\n${lines.join("\n")}\n）`;
}
