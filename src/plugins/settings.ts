import { z } from "zod";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { readSettingsRecord, writeSettingsRecord } from "./store.ts";
import type { PluginSettings } from "./types.ts";

/**
 * Plugin settings (docs/v2/plugins.md): the manifest lists the fields, the shell renders one form
 * for every plugin, and the values are kept per user. Plugin code reads them with ctx.settings().
 */
export const settingFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
  label: z.string().min(1),
  description: z.string().default(""),
  type: z.enum(["select", "number", "text", "boolean"]),
  /** For select: values, or value + label. */
  options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).default([]),
  min: z.number().optional(),
  max: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]),
});
export type SettingField = z.infer<typeof settingFieldSchema>;

const optionValues = (f: SettingField) => f.options.map((o) => (typeof o === "string" ? o : o.value));

/** One value checked against its field; null when it does not fit (the default is used instead). */
function coerce(f: SettingField, v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (f.type === "boolean") return typeof v === "boolean" ? v : null;
  if (f.type === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return null;
    return n;
  }
  if (typeof v !== "string") return null;
  if (f.type === "select") return optionValues(f).includes(v) ? v : null;
  return v.slice(0, 2000);
}

export function resolveSettings(fields: SettingField[], stored: Record<string, unknown>): PluginSettings {
  return Object.fromEntries(fields.map((f) => [f.key, coerce(f, stored[f.key]) ?? f.default]));
}

export function pluginSettings(app: App, plugin: string, fields: SettingField[], userId: string) {
  return resolveSettings(fields, readSettingsRecord(app, plugin, userId));
}

/** Save a change; a value that does not fit its field is refused with the field's name. */
export function savePluginSettings(app: App, plugin: string, fields: SettingField[], userId: string, spaceId: string, patch: Record<string, unknown>) {
  const stored = readSettingsRecord(app, plugin, userId);
  for (const [k, v] of Object.entries(patch)) {
    const f = fields.find((x) => x.key === k);
    if (!f) throw new HttpError(400, `插件 ${plugin} 没有设置项 ${k}`);
    if (v === null) {
      delete stored[k];
      continue;
    }
    const c = coerce(f, v);
    if (c === null) throw new HttpError(400, `“${f.label}”的值不合适：${JSON.stringify(v)}`);
    stored[k] = c;
  }
  writeSettingsRecord(app, plugin, userId, spaceId, stored);
  return resolveSettings(fields, stored);
}
