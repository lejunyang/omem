import { createHash, randomBytes } from "node:crypto";

export const now = () => new Date().toISOString();

/** Short sortable id: time prefix + randomness. */
export function newId(prefix = ""): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return prefix + time + randomBytes(5).toString("hex");
}

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|#%[\]{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 80) || "page";
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function truncate(text: string, max: number) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Lines are 1-based and inclusive, like editors and citations. */
export function sliceLines(text: string, start: number, end: number) {
  return text
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start, end))
    .join("\n");
}

export function lineCount(text: string) {
  if (!text) return 0;
  return text.split("\n").length;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
