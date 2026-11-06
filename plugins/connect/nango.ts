import { createRequire } from "node:module";
import type { ProviderField } from "../../src/auth/providers.ts";
import { needs, type Def } from "./engine.ts";

/**
 * Nango's catalog of platforms (the npm package @nangohq/providers, Elastic License 2.0: read at run
 * time, not copied into this repository) turned into descriptions: every OAuth 2 platform, and the
 * ones connected with a key or a password whose content can become sources (documents, chat, mail and
 * calendars, meetings, code, tickets). What is not covered: OAuth 1, client credentials, two-step
 * token exchanges, signed requests, MCP servers, and templates other than plain placeholders.
 */
type Field = { type?: string; title?: string; description?: string; optional?: boolean; prefix?: string; suffix?: string; default_value?: string; automated?: boolean; hidden?: boolean; secret?: boolean };
type Entry = {
  display_name: string;
  categories?: string[];
  auth_mode?: string;
  authorization_url?: string;
  authorization_url_replacements?: unknown;
  authorization_url_fragment?: string;
  token_url?: string | Record<string, string>;
  refresh_url?: string;
  authorization_params?: Record<string, string>;
  token_params?: Record<string, string>;
  refresh_params?: Record<string, string>;
  token_headers?: Record<string, string>;
  scope_separator?: string;
  default_scopes?: string[];
  disable_pkce?: boolean;
  token_request_auth_method?: string;
  authorization_method?: string;
  body_format?: string;
  token_response?: { token?: string; token_expiration?: string; refresh_token?: string };
  alternate_access_token_response_path?: string;
  token_expires_in_ms?: number;
  proxy?: { base_url?: string; headers?: Record<string, string>; query?: Record<string, string>; verification?: { method?: string; endpoints?: string[] } };
  connection_config?: Record<string, Field>;
  credentials?: Record<string, Field>;
  docs?: string;
};

/** What a platform is for, in omem's terms (the catalog's categories, the most telling first). */
const GROUPS: [string, string][] = [
  ["knowledge-base", "文档与知识库"],
  ["storage", "文档与知识库"],
  ["cms", "文档与知识库"],
  ["video", "会议与转写"],
  ["communication", "聊天与通讯"],
  ["dev-tools", "代码与开发"],
  ["ticketing", "项目与工单"],
  ["support", "项目与工单"],
  ["design", "设计与白板"],
  ["productivity", "协作办公"],
  ["iam", "身份与安全"],
  ["legal", "身份与安全"],
  ["crm", "销售与营销"],
  ["marketing", "销售与营销"],
  ["surveys", "销售与营销"],
  ["social", "社交媒体"],
  ["e-commerce", "电商与财务"],
  ["payment", "电商与财务"],
  ["banking", "电商与财务"],
  ["accounting", "电商与财务"],
  ["invoicing", "电商与财务"],
  ["erp", "电商与财务"],
  ["hr", "人事与招聘"],
  ["ats", "人事与招聘"],
  ["analytics", "数据分析"],
  ["search", "数据分析"],
];
/** Whose content can become sources: a key connection is offered only for these. */
export const CAPTURE_GROUPS = new Set(["文档与知识库", "会议与转写", "聊天与通讯", "邮件与日程", "代码与开发", "项目与工单"]);

function groupOf(id: string, e: Entry) {
  if (/(^|-)(mail|gmail|outlook|calendar|calendly|cal-com)(-|$)/.test(id) && !/chimp|gun|jet|send|merge|lite/.test(id)) return "邮件与日程";
  const cats = e.categories ?? [];
  return GROUPS.find(([c]) => cats.includes(c))?.[1] ?? "其他";
}

const PLAIN = /^(accessToken|apiKey|credentials\.\w+|connectionConfig\.\w+)$/;

const fieldOf = (key: string, f: Field): ProviderField => ({
  key,
  label: f.title || key,
  secret: !!f.secret,
  optional: !!f.optional,
  hint: [f.description, f.prefix || f.suffix ? `格式：${f.prefix ?? ""}<值>${f.suffix ?? ""}` : "", f.default_value ? `默认 ${f.default_value}` : ""].filter(Boolean).join("；"),
});

export function nangoDefs(): { defs: Def[]; skipped: number } {
  let providers: Record<string, Entry> | undefined;
  try {
    const require = createRequire(import.meta.url);
    providers = (require("@nangohq/providers") as { getProviders(): Record<string, Entry> | undefined }).getProviders?.();
  } catch {
    providers = undefined;
  }
  if (!providers) return { defs: [], skipped: 0 };
  const defs: Def[] = [];
  let skipped = 0;
  for (const [id, e] of Object.entries(providers)) {
    if (!e?.display_name || !/^[a-z][a-z0-9-]{0,40}$/.test(id)) continue;
    const mode = e.auth_mode === "OAUTH2" ? "oauth2" : e.auth_mode === "API_KEY" || e.auth_mode === "BASIC" ? "key" : null;
    const group = groupOf(id, e);
    if (!mode || (mode === "key" && !CAPTURE_GROUPS.has(group))) continue;
    const tokenUrl = typeof e.token_url === "string" ? e.token_url : e.token_url?.OAUTH2;
    const proxy = e.proxy ?? {};
    const config = Object.entries(e.connection_config ?? {});
    // Values filled by Nango's own scripts after connecting (a cloud id…) have no one to fill them here.
    const hidden = new Set(config.filter(([, f]) => f.automated || f.hidden).map(([k]) => `connectionConfig.${k}`));
    const templates = [proxy.base_url, ...Object.values(proxy.headers ?? {}), ...Object.values(proxy.query ?? {}), ...(mode === "oauth2" ? [e.authorization_url, tokenUrl, e.refresh_url, ...Object.values(e.token_headers ?? {})] : [])].filter((t): t is string => typeof t === "string");
    const used = templates.flatMap(needs);
    const unsupported =
      used.some((k) => !PLAIN.test(k) || hidden.has(k)) ||
      !proxy.base_url ||
      (mode === "oauth2" && (!e.authorization_url || !tokenUrl || !!e.authorization_url_replacements || !!e.authorization_url_fragment));
    if (unsupported) {
      skipped++;
      continue;
    }
    const defaults = Object.fromEntries(config.filter(([, f]) => f.default_value).map(([k, f]) => [k, String(f.default_value)]));
    const def: Def = {
      id,
      label: e.display_name,
      group,
      docs: e.docs,
      mode,
      config: config.filter(([k, f]) => !f.automated && !f.hidden && used.includes(`connectionConfig.${k}`)).map(([k, f]) => fieldOf(k, { ...f, optional: f.optional || k in defaults })),
      base: proxy.base_url!,
      defaults,
      headers: proxy.headers,
      query: proxy.query,
    };
    if (mode === "key") {
      def.basic = e.auth_mode === "BASIC";
      def.credentials = Object.entries(e.credentials ?? (def.basic ? { username: { title: "用户名" }, password: { title: "密码", secret: true } } : { apiKey: { title: "API Key", secret: true } })).map(([k, f]) => fieldOf(k, { ...f, secret: f.secret ?? /key|token|password|secret/i.test(k) }));
      const v = proxy.verification;
      if (v?.endpoints?.[0]) def.verify = { method: v.method ?? "GET", path: v.endpoints[0] };
    } else {
      Object.assign(def, {
        authUrl: e.authorization_url!,
        tokenUrl: tokenUrl!,
        refreshUrl: e.refresh_url ? e.refresh_url : undefined,
        authParams: e.authorization_params,
        tokenParams: e.token_params,
        refreshParams: e.refresh_params,
        tokenHeaders: e.token_headers,
        json: e.body_format === "json",
        basicAuth: e.token_request_auth_method === "basic" || e.authorization_method === "header",
        pkce: !e.disable_pkce,
        scopeSep: e.scope_separator,
        defaultScopes: e.default_scopes,
        paths: { token: e.token_response?.token, expires: e.token_response?.token_expiration, refresh: e.token_response?.refresh_token },
        altPath: e.alternate_access_token_response_path,
        expiresMs: e.token_expires_in_ms || undefined,
      } satisfies Partial<Def>);
    }
    defs.push(def);
  }
  return { defs, skipped };
}

