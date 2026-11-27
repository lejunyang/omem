/**
 * What an AI provider's error answer means for omem (core/ai-relay.ts for agents on an API key,
 * core/decision.ts for the decision models): from the provider's own code where it is known, from
 * the usual words otherwise.
 *
 * - `rate`: per-minute requests or tokens, a burst, the service busy for a moment. Over soon.
 * - `daily`: a per-day allowance (tokens per day, Cloudflare's daily free neurons). Over at midnight.
 * - `quota`: credit spent, a spending limit set by the account, an unpaid bill. Needs the owner.
 * - `auth`: the key refused (wrong, revoked, the account not allowed). Needs the owner.
 * - `config`: no such model or endpoint, the model not enabled for the account. The setting is wrong.
 * - `server`: the provider's own failure. Retrying elsewhere helps.
 * - `input`: this request was refused (content, length, a parameter). Another backend would not help either.
 *
 * Codes as the providers document them (2026-11): OpenAI's error codes guide, Anthropic's errors
 * page, Cloudflare Workers AI's error list, Volcengine Ark's 错误码 page.
 */
export type ErrorKind = "rate" | "daily" | "quota" | "auth" | "config" | "server" | "input" | "other";
export type ProviderError = { kind: ErrorKind; code: string; message: string };

/** The code and message in an error body, whichever shape the provider uses. */
export function errorParts(body: string): { code: string; message: string } {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    // Cloudflare: {success:false, errors:[{code, message}]}
    const cf = Array.isArray(j.errors) ? (j.errors as { code?: unknown; message?: unknown }[])[0] : undefined;
    if (cf) return { code: String(cf.code ?? ""), message: String(cf.message ?? "") };
    // OpenAI / Ark: {error:{code, type, message}}; Anthropic: {type:"error", error:{type, message}}
    const e = (typeof j.error === "object" && j.error ? j.error : j) as { code?: unknown; type?: unknown; message?: unknown };
    const code = e.code !== undefined && e.code !== null && e.code !== "" ? String(e.code) : e.type !== undefined && e.type !== "error" ? String(e.type) : "";
    return { code, message: String(e.message ?? (typeof j.error === "string" ? j.error : "")) };
  } catch {
    return { code: "", message: body.slice(0, 300) };
  }
}

/** Volcengine Ark (火山方舟) inference codes. Prefix matches end in a dot. */
const ARK: [RegExp, ErrorKind][] = [
  [/^ModelAccountTpdRateLimitExceeded$/, "daily"],
  [/^(RateLimitExceeded\.|ModelAccount(Rpm|Tpm|FlexTpm|Ipm)RateLimitExceeded$|APIAccountRpmRateLimitExceeded$|AccountRateLimitExceeded$|ServerOverloaded$|RequestBurstTooFast$|ModelAccountConcurrentRequestsLimitExceeded$)/, "rate"],
  [/^(QuotaExceeded|AccountQuotaExceeded$|SetLimitExceeded$|AccountOverdueError$|OperationDenied\.ServiceOverdue$|InvalidAccountStatus$)/, "quota"],
  [/^(AuthenticationError$|AccessDenied$|OperationDenied\.PermissionDenied$)/, "auth"],
  [/^(InvalidEndpointOrModel\.|InvalidEndpoint\.|ModelNotOpen$|UnsupportedModel$|OperationDenied\.ServiceNotOpen$|NotFound\b|PathNotFound$|InvalidAction$)/, "config"],
  [/^(InternalServiceError$|ModelLoading|ServiceConnectionRefused$|NoAvailableService$|RequestTimeout$)/, "server"],
  [/^(MissingParameter$|InvalidParameter|InvalidArgumentError|InvalidImageURL|OutofContextError$|.*SensitiveContentDetected|.*RiskDetection$|ContentSecurityDetectionError$)/, "input"],
];
/** OpenAI: `error.code` (`type` for the older rate-limit answers). */
const OPENAI: [RegExp, ErrorKind][] = [
  [/^(insufficient_quota|billing_hard_limit_reached|billing_not_active|access_terminated)$/, "quota"],
  [/^(rate_limit_exceeded|requests|tokens|slow_down|engine_overloaded)$/, "rate"],
  [/^(invalid_api_key|invalid_organization|account_deactivated|unsupported_country_region_territory|no_such_organization)$/, "auth"],
  [/^(model_not_found|deployment_not_found)$/, "config"],
  [/^(server_error|internal_error)$/, "server"],
  [/^(context_length_exceeded|content_policy_violation|invalid_request_error|string_above_max_length)$/, "input"],
];
/** Anthropic: `error.type`. */
const ANTHROPIC: [RegExp, ErrorKind][] = [
  [/^(rate_limit_error|overloaded_error)$/, "rate"],
  [/^billing_error$/, "quota"],
  [/^(authentication_error|permission_error)$/, "auth"],
  [/^not_found_error$/, "config"],
  [/^(api_error|timeout_error)$/, "server"],
  [/^(invalid_request_error|request_too_large)$/, "input"],
];
/** Cloudflare Workers AI: numeric codes in `errors[]`. */
const CLOUDFLARE: [RegExp, ErrorKind][] = [
  [/^3036$/, "daily"], // Account limited: the daily free allocation of neurons is used up
  [/^(3040|971)$/, "rate"], // Capacity temporarily exceeded; rate limited
  [/^(10000|9109|10001)$/, "auth"], // Authentication error, invalid token
  [/^(5007|7003|7000)$/, "config"], // No such model; no route
  [/^(3001|3043|3007|3008|5005)$/, "server"], // Internal error, upstream error, timeout
  [/^(5004|3006|5006)$/, "input"], // Invalid data, request too large
];
const TABLES: Record<string, [RegExp, ErrorKind][]> = { ark: ARK, openai: OPENAI, anthropic: ANTHROPIC, cloudflare: CLOUDFLARE };

/** Any provider: by the usual words and the status. */
function byWords(status: number, s: string): ErrorKind {
  if (status === 429 && /\btpd\b|tpd(?=rate|limit)|per.?day|daily|每日|当日|今日/i.test(s)) return "daily";
  if (status === 402 || /quota|overdue|arrear|insufficient|balance|billing|credit|setlimit|spend|欠费|余额|额度/i.test(s)) return "quota";
  if (status === 429 || status === 529 || /rate.?limit|[rti]pm.?(rate|limit|exceed)|burst|overload|concurren|too.?many/i.test(s)) return "rate";
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || /model.?not.?found|no such model|endpoint.?not/i.test(s)) return "config";
  if (status >= 500) return "server";
  if (status === 400 || status === 413 || status === 422) return "input";
  return "other";
}

/**
 * The kind of an error answer from a provider of this kind (`ai.providers[].kind`). A code the
 * provider's table names decides; otherwise the words and the status. OpenAI's own rate limit may
 * be per day (its message says "per day (TPD)"): that is a daily one.
 */
export function classifyError(providerKind: string, status: number, body: string): ProviderError {
  const { code, message: raw } = errorParts(body);
  const message = raw.replace(/\s*Request id:.*$/i, "").replace(/\s+/g, " ").trim().slice(0, 300);
  const table = TABLES[providerKind] ?? [];
  let kind = table.find(([re]) => re.test(code))?.[1];
  if (kind === "rate" && /per day|\bTPD\b|\bRPD\b/i.test(message)) kind = "daily";
  return { kind: kind ?? byWords(status, `${code} ${message}`), code, message };
}

/** A minute allowance, distinct from bursts, concurrency limits and generic 429 responses. */
export function isMinuteRateLimit({ kind, code, message }: ProviderError) {
  return kind === "rate" && (
    /^(ModelAccount(?:Rpm|Tpm|FlexTpm|Ipm)RateLimitExceeded|APIAccountRpmRateLimitExceeded|RateLimitExceeded\.Endpoint(?:RPM|TPM|FlexTPM)Exceeded)$/i.test(code)
    || /\b(?:RPM|TPM|IPM)\b|per[ -]minute|每分钟/i.test(message)
  );
}

/** Until when a provider's backends or models are kept out of the way after an error of this kind; null: not at all. */
export function pauseFor(kind: ErrorKind, at: number, nextMidnight: (at: number) => number): number | null {
  if (kind === "rate") return at + 60_000;
  if (kind === "daily") return nextMidnight(at);
  if (kind === "quota" || kind === "auth") return at + 24 * 3_600_000;
  if (kind === "server") return at + 5 * 60_000;
  return null;
}
