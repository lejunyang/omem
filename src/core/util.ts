import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const now = () => new Date().toISOString();

/** Short sortable id: time prefix + randomness. */
export function newId(prefix = ""): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return prefix + time + randomBytes(5).toString("hex");
}

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
/** Compare a presented secret with the expected one in constant time (hashed, so lengths match). */
export const sameSecret = (given: string, expected: string) => !!expected && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());

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

/**
 * A link to one of omem's pages (`#/...`): absolute when `webUrl` is configured, so it opens from
 * another device or a Feishu card; otherwise left as it is (opens only inside omem's own pages).
 */
export function webLink(app: { config: { webUrl?: string } }, link: string) {
  const base = app.config.webUrl?.trim().replace(/\/+$/, "");
  if (!base || !link.startsWith("#/")) return link;
  return `${base}/${link}`;
}
