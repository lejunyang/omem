import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { now } from "../core/util.ts";
import type { PluginSignal } from "./types.ts";
import { emitOmem } from "../rules/omem-events.ts";

export function emitPluginSignal(app: App, plugin: string, signal: PluginSignal) {
  if (!/^[a-z][a-z0-9.-]*$/.test(signal.kind)) throw new Error("信号 kind 不合法");
  const keys = JSON.stringify(signal.keys);
  const payload = JSON.stringify(signal.payload ?? null);
  if (!keys || keys.length > 4000 || payload.length > 4000) throw new Error("信号 keys 和 payload 各不能超过 4000 字符");
  run(app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,?,?,'','',?)", now(), `plugin.${plugin}.${signal.kind}`, keys, payload);
  // Rules about omem's own events may be about it (`plugin.signal`); the keys and payload are the plugin's, material only.
  emitOmem(app, { type: "plugin.signal", id: `${plugin}.${signal.kind}:${keys.slice(0, 200)}:${now()}`, title: `${plugin} · ${signal.kind}`, kind: signal.kind, plugin, text: `keys ${keys}${signal.payload === undefined ? "" : `\npayload ${payload}`}`.slice(0, 2000) });
}
