/**
 * Cookies, tokens and passwords taken out of a recording's requests before an agent reads them. The
 * same rules aad applies to its browser recordings (`redact_network`), so a recording made by the
 * Chrome extension reads the same: a header, query parameter or JSON field whose name looks secret
 * becomes "[REDACTED]", a body that is neither JSON nor a form is dropped whole. The extension
 * redacts before uploading; the server runs these again on what it receives. Applying them twice
 * changes nothing.
 */

export const REDACTED = "[REDACTED]";
export const OPAQUE = "[REDACTED OPAQUE BODY]";

// Values that carry a login challenge or where to go after one: dropped whatever their content.
const WHOLE = new Set(["code", "returnto", "returnurl", "redirecturi", "redirecturl", "callback"]);
// Names that hold a secret anywhere in them. "pwd" is one more than aad has: login forms name the password that way.
const PARTS = ["authorization", "cookie", "setcookie", "password", "passwd", "pwd", "secret", "token", "ticket", "credential", "apikey", "otp", "verificationcode"];

export function sensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  return WHOLE.has(k) || PARTS.some((p) => k.includes(p));
}

/**
 * The address without credentials and secret-looking query values. Of the fragment only a front-end
 * route (`#/orders`) stays, without what follows its `?`: an OAuth implicit login puts the token there.
 */
export function redactUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "[REDACTED URL]";
  }
  url.username = "";
  url.password = "";
  url.hash = /^#!?\//.test(url.hash) ? url.hash.split("?")[0] : "";
  if ([...url.searchParams.keys()].some(sensitiveKey)) {
    const pairs = [...url.searchParams].map(([k, v]) => [k, sensitiveKey(k) ? REDACTED : v]);
    url.search = new URLSearchParams(pairs).toString();
  }
  return url.toString();
}

/** A JSON value with secret-looking fields replaced, addresses in it redacted. */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (sensitiveKey(k) || /^(location|referer)$/i.test(k)) out[k] = REDACTED;
    else if (/^(url|href|documentURL)$/.test(k) && typeof v === "string") out[k] = redactUrl(v);
    else out[k] = redactJson(v);
  }
  return out;
}

/** Headers as name → value, secret ones replaced. */
export const redactHeaders = (h: Record<string, string> | undefined) => (h ? (redactJson(h) as Record<string, string>) : undefined);

/** A request or response body: JSON and form bodies keep what is not secret, anything else is dropped. */
export function redactBody(text: string | undefined | null): string | undefined {
  if (text == null || text === "") return undefined;
  if (text === OPAQUE) return text;
  const trimmed = text.trim();
  if (/^[[{"]/.test(trimmed) || /^(true|false|null|-?\d)/.test(trimmed)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed)));
    } catch { /* not JSON after all */ }
  }
  // application/x-www-form-urlencoded: a=1&b=2
  if (/^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/.test(trimmed)) {
    const params = new URLSearchParams(trimmed);
    return [...params].map(([k, v]) => `${encodeURIComponent(k)}=${sensitiveKey(k) ? REDACTED : encodeURIComponent(v)}`).join("&");
  }
  return OPAQUE;
}
