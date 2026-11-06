import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { keyHint } from "../core/ai-keys.ts";
import { HttpError } from "../core/util.ts";
import { loginProvider, type LoginProvider } from "./providers.ts";

/**
 * What the owner filled in for a platform's app (a provider's `appFields`: client id and secret, a
 * site, scopes), in secrets/connector-apps.json beside the other secrets: not in config.json, not in a
 * snapshot or a pull. The web sees secret values only as their last four characters.
 */
const fileIn = (home: string) => join(home, "secrets", "connector-apps.json");

function readAll(home: string): Record<string, Record<string, string>> {
  try {
    const v = JSON.parse(readFileSync(fileIn(home), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The values the owner filled in for this provider (empty when none). */
export const appConfig = (app: App, provider: string): Record<string, string> => readAll(app.home)[provider] ?? {};

/** A change: a string sets the value, null or "" removes it; fields the provider does not declare are refused. */
export function setAppConfig(app: App, provider: string, patch: Record<string, string | null>) {
  const p = loginProvider(provider);
  if (!p?.appFields?.length) throw new HttpError(404, `${provider} 没有要填的应用配置`);
  const all = readAll(app.home);
  const cur = { ...(all[provider] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!p.appFields.some((f) => f.key === k)) throw new HttpError(400, `${p.label}没有配置项 ${k}`);
    const val = typeof v === "string" ? v.trim() : "";
    if (val) cur[k] = val.slice(0, 4000);
    else delete cur[k];
  }
  if (Object.keys(cur).length) all[provider] = cur;
  else delete all[provider];
  mkdirSync(join(app.home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(fileIn(app.home), JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(fileIn(app.home), 0o600);
  } catch {}
  return appView(app, p);
}

/** For the settings page: each field with its value, secrets only as a hint. */
export function appView(app: App, p: LoginProvider) {
  const values = appConfig(app, p.id);
  return (p.appFields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    secret: !!f.secret,
    optional: !!f.optional,
    help: f.hint ?? "",
    value: f.secret ? "" : (values[f.key] ?? ""),
    masked: f.secret ? keyHint(values[f.key] ?? "") : "",
    set: !!values[f.key],
  }));
}
