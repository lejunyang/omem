import type { App } from "../core/app.ts";
import { reactionEventsQuiet } from "./lark-feedback.ts";
import { checkLarkApp, larkAppSecret, larkEventLink, larkScopeLink, LARK_BOT_ADDONS, LARK_BOT_CALLBACKS, LARK_BOT_EVENTS, registerLarkBot, saveLarkSecret, type LarkCheck } from "./lark-setup.ts";

/**
 * Whether each bot app has what omem's code uses: permissions (tenant scopes) and the event and
 * callback subscriptions. Read from the app's own application info (application v6, which lists
 * granted scopes and `event.subscribed_events`); when Feishu does not say, a heuristic stands in:
 * bot messages were sent for a week and not a single reaction event arrived.
 *
 * Fixing: missing scopes have a console link that applies for exactly those; "update by scan"
 * re-runs Feishu's app registration for the existing app (the owner scans and confirms), which
 * applies omem's scopes, events and callbacks in one go; events also have a link to the app's
 * event-subscription page. A new subscription takes effect once a new app version is published.
 */
export type BotCheck = {
  ref: string;
  appId: string;
  name?: string;
  error?: string;
  scopes: { missing: string[]; unknown: boolean; link: string | null };
  events: {
    /** null: the app info did not list them. */
    subscribed: string[] | null;
    missing: { name: string; label: string; optional?: boolean }[];
    /** Subscribed, but not in the version online yet. */
    unpublished: string[];
    mode: string | null;
    link: string;
  };
  callbacks: { subscribed: string[] | null; missing: { name: string; label: string }[]; mode: string | null };
  /** No reaction events for a week while the bots kept posting: the subscription is probably missing. */
  reactionsQuiet: ReturnType<typeof reactionEventsQuiet>;
};

function botApps(app: App) {
  const cfg = app.config.lark;
  const out: { ref: string; appId: string; secret?: string }[] = [];
  if (cfg.appId) out.push({ ref: "main", appId: cfg.appId, secret: larkAppSecret(app.home, cfg.appId, cfg.appSecretEnv) });
  for (const b of cfg.bots.filter((x) => x.enabled))
    out.push({ ref: b.id, appId: b.appId, secret: larkAppSecret(app.home, b.appId, `OMEM_LARK_APP_SECRET_${b.id.toUpperCase().replace(/-/g, "_")}`) });
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** One app's check result into what the settings page shows. Pure (tests feed it a fake check). */
export function summarizeCheck(app: App, ref: string, appId: string, check: LarkCheck): BotCheck {
  const scopesMissing = check.scopesUnknown ? [] : check.missingScopes;
  const subscribed = check.events ?? null;
  const have = new Set((subscribed ?? []).map(norm));
  const published = check.publishedEvents ? new Set(check.publishedEvents.map(norm)) : null;
  const cbHave = new Set((check.callbacks ?? []).map(norm));
  return {
    ref,
    appId,
    name: check.botName,
    ...(check.error ? { error: check.error } : {}),
    scopes: { missing: scopesMissing, unknown: !!check.scopesUnknown, link: scopesMissing.length ? larkScopeLink(appId, scopesMissing) : check.scopesUnknown ? larkScopeLink(appId, LARK_BOT_ADDONS.scopes.tenant) : null },
    events: {
      subscribed,
      missing: subscribed ? LARK_BOT_EVENTS.filter((e) => !have.has(norm(e.name))) : [],
      unpublished: subscribed && published ? subscribed.filter((e) => !published.has(norm(e))) : [],
      mode: check.eventMode ?? null,
      link: larkEventLink(appId),
    },
    callbacks: { subscribed: check.callbacks ?? null, missing: check.callbacks ? LARK_BOT_CALLBACKS.filter((c) => !cbHave.has(norm(c.name))) : [], mode: check.callbackMode ?? null },
    reactionsQuiet: reactionEventsQuiet(app),
  };
}

export async function checkLarkBots(app: App, request?: typeof fetch): Promise<BotCheck[]> {
  const out: BotCheck[] = [];
  for (const b of botApps(app)) {
    if (!b.secret) {
      out.push({ ...summarizeCheck(app, b.ref, b.appId, { missingScopes: [], scopesUnknown: true }), error: `没有 ${b.appId} 的 App Secret：运行 omem setup → 渠道 → 飞书` });
      continue;
    }
    out.push(summarizeCheck(app, b.ref, b.appId, await checkLarkApp(b.appId, b.secret, request)));
  }
  return out;
}

/**
 * Update an existing bot app by scan: Feishu's registration flow for this app with omem's scopes,
 * events and callbacks (lark-setup.ts LARK_BOT_ADDONS). Resolves with the QR link at once; when the
 * owner has confirmed, the new secret is saved and a notification says what is still missing.
 */
export async function updateLarkBotByScan(app: App, ref: string): Promise<{ url: string; expiresInMinutes: number } | { error: string }> {
  const b = botApps(app).find((x) => x.ref === ref);
  if (!b) return { error: `没有启用的飞书机器人 ${ref}` };
  return await new Promise((resolve) => {
    registerLarkBot({ appId: b.appId, onQr: (url, expires) => resolve({ url, expiresInMinutes: Math.round(expires / 60) }) })
      .then(async (creds) => {
        const before = await checkLarkApp(creds.appId, creds.appSecret).catch(() => null);
        saveLarkSecret(app.home, { ...creds, name: before?.botName });
        const s = before ? summarizeCheck(app, ref, creds.appId, before) : null;
        const gaps = s ? [...s.scopes.missing, ...s.events.missing.filter((e) => !e.optional).map((e) => e.name)] : [];
        const { notify } = await import("../core/notify.ts");
        notify(app, {
          title: `飞书机器人 ${ref} 的权限和事件已更新`,
          body: gaps.length ? `仍缺：${gaps.join("、")}（可能在等管理员审批，或要在开发者后台发布新版本）` : "权限和事件订阅已补齐；新订阅在应用发布新版本后生效。",
        });
      })
      .catch((e) => resolve({ error: (e as Error).message }));
  });
}
