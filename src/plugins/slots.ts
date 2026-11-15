import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { checkView, viewSchema } from "../agents/ui-blocks.ts";
import { pluginObjectKind } from "./objects.ts";
import { pluginContext } from "./blocks.ts";
import type { PluginBlock, PluginSlot, PluginSlotContext, PluginSlotPlace } from "./types.ts";

/**
 * Slots (docs/v2/flows.md §8, “界面插槽”): a plugin's display block shown on omem's own pages — the item
 * panel, under a flow stage, the today page — instead of only on the plugin's page. The block says what
 * it shows (`load`, read as the person looking, in the item's space) and how omem draws it (`view`: the
 * display components of docs/v2/interactive-ui.md). Slots are declared by code running inside omem and
 * go away with it (turned off, trust withdrawn, unloaded). The host never branches on a plugin's name.
 */
export const SLOT_PLACES: readonly PluginSlotPlace[] = ["item.panel", "flow.stage", "today"];
const PLACE_WORDS: Record<PluginSlotPlace, string> = { "item.panel": "事项页侧栏", "flow.stage": "流程阶段下面", today: "今日页" };
export type SlotEntry = { at: PluginSlotPlace; block: string; when: { object?: string; stage?: string[]; flow?: string[]; space?: string[] } };
/** One block to draw: where, for which item, stage and object. */
export type SlotView = { key: string; plugin: string; pluginName: string; block: string; label: string; at: PluginSlotPlace; item: string | null; stage: string | null; object: { id: string; title: string } | null };

const strings = (plugin: string, name: string, v: unknown) => {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`插件 ${plugin} 的插槽 when.${name} 要写非空的字符串或字符串数组`);
  return list as string[];
};

/** Check a slot when the plugin declares it: a known place, one of its own display blocks, conditions that fit the place. */
export function checkSlot(plugin: string, blocks: Map<string, PluginBlock>, existing: SlotEntry[], at: unknown, def: PluginSlot): SlotEntry {
  if (typeof at !== "string" || !SLOT_PLACES.includes(at as PluginSlotPlace)) throw new Error(`插件 ${plugin} 的插槽位置不认识：${String(at)}（只有 ${SLOT_PLACES.join("、")}）`);
  const place = at as PluginSlotPlace;
  const b = typeof def?.block === "string" ? blocks.get(def.block) : undefined;
  if (!b) throw new Error(`插件 ${plugin} 的插槽用了没有声明的内容块：${String(def?.block)}（先 api.block，再 api.slot）`);
  if (!b.display || typeof b.load !== "function" || typeof b.view !== "function") throw new Error(`插件 ${plugin} 的内容块 ${b.kind} 要放进插槽，得是只展示的（display: true），并带 load 和 view`);
  if (existing.some((s) => s.at === place && s.block === b.kind)) throw new Error(`插件 ${plugin} 的内容块 ${b.kind} 在${PLACE_WORDS[place]}已经放过一次`);
  const when = (def.when ?? {}) as Record<string, unknown>;
  if (typeof when !== "object" || Array.isArray(when)) throw new Error(`插件 ${plugin} 的插槽 when 要写成对象`);
  const extra = Object.keys(when).filter((k) => !["object", "stage", "flow", "space"].includes(k));
  if (extra.length) throw new Error(`插件 ${plugin} 的插槽 when 不认识：${extra.join("、")}（只有 object、stage、flow、space）`);
  if (place === "today" && Object.keys(when).length) throw new Error(`插件 ${plugin} 放在今日页的插槽没有事项，不能按对象、阶段、流程或空间限定`);
  if (when.stage !== undefined && place !== "flow.stage") throw new Error(`插件 ${plugin} 的插槽 when.stage 只用在 flow.stage`);
  if (when.object !== undefined && (typeof when.object !== "string" || !pluginObjectKind(`${plugin}:${when.object}`)))
    throw new Error(`插件 ${plugin} 的插槽 when.object 不是它自己的对象类型：${String(when.object)}（先 api.object）`);
  const out: SlotEntry["when"] = {};
  if (when.object !== undefined) out.object = when.object as string;
  for (const k of ["stage", "flow", "space"] as const) {
    const v = strings(plugin, k, when[k]);
    if (v) out[k] = v;
  }
  return { at: place, block: b.kind, when: out };
}

type ObjectRow = { id: string; kind: string; key: string; title: string; status: string; link: string };
type Place = { at: PluginSlotPlace; item: { id: string; spaceId: string } | null; flow: string | null; stage: { id: string; follows: string[] } | null };

/** The page a request is for: the item must be readable (404 otherwise); a stage must be one of its flow's. */
async function placeOf(app: App, userId: string, q: { at: string; item?: string; stage?: string }): Promise<Place | null> {
  if (!SLOT_PLACES.includes(q.at as PluginSlotPlace)) throw new HttpError(400, `插槽位置只有 ${SLOT_PLACES.join("、")}`);
  const at = q.at as PluginSlotPlace;
  if (at === "today") return { at, item: null, flow: null, stage: null };
  if (!q.item) throw new HttpError(400, "要给事项 id");
  const { assertObjectItem } = await import("../flows/plugin-objects.ts");
  const { itemFlow } = await import("../flows/store.ts");
  const item = assertObjectItem(app, q.item, userId);
  const f = itemFlow(app, item.id);
  if (at === "item.panel") return { at, item, flow: f?.id ?? null, stage: null };
  if (!q.stage) throw new HttpError(400, "要给阶段 id");
  const d = f?.definition.stages.find((s) => s.id === q.stage);
  if (!f || !d) return null;
  const follows = [d.by, d.done].flatMap((x) => (x && typeof x === "object" && "object" in x && typeof x.object === "string" ? [x.object] : []));
  return { at, item, flow: f.id, stage: { id: d.id, follows } };
}

const attached = (app: App, itemId: string, kind: string) =>
  all<ObjectRow>(app.db, "select o.id, o.kind, o.key, o.title, o.status, o.link from item_materials m join flow_objects o on o.id = m.ref where m.item_id = ? and m.kind = 'object' and o.kind = ? order by m.id desc limit 5", itemId, kind);

/** Where one slot shows on this page: none, one, or (item panel, by object) one per linked object. */
function entries(app: App, plugin: string, s: SlotEntry, place: Place): { object: ObjectRow | null }[] {
  if (s.at !== place.at) return [];
  const w = s.when;
  if (w.space && (!place.item || !w.space.includes(place.item.spaceId))) return [];
  if (w.flow && (!place.flow || !w.flow.includes(place.flow))) return [];
  if (w.stage && (!place.stage || !w.stage.includes(place.stage.id))) return [];
  if (!w.object) return [{ object: null }];
  const kind = `${plugin}:${w.object}`;
  if (!place.item) return [];
  if (place.at === "flow.stage") return place.stage?.follows.includes(kind) ? [{ object: attached(app, place.item.id, kind)[0] ?? null }] : [];
  return attached(app, place.item.id, kind).map((object) => ({ object }));
}

/** The slots on one page, for this person: the blocks to draw (their content is read one by one, `loadSlot`). */
export async function slotsAt(app: App, userId: string, q: { at: string; item?: string; stage?: string }): Promise<SlotView[]> {
  const place = await placeOf(app, userId, q);
  if (!place) return [];
  const { listPlugins } = await import("./registry.ts");
  const out: SlotView[] = [];
  for (const p of listPlugins())
    for (const s of p.slots)
      for (const e of entries(app, p.manifest.id, s, place))
        out.push({
          key: [p.manifest.id, s.block, place.stage?.id ?? "", e.object?.id ?? ""].join("/"),
          plugin: p.manifest.id,
          pluginName: p.manifest.name,
          block: s.block,
          label: p.blocks.get(s.block)?.description ?? s.block,
          at: place.at,
          item: place.item?.id ?? null,
          stage: place.stage?.id ?? null,
          object: e.object ? { id: e.object.id, title: e.object.title } : null,
        });
  return out;
}

async function timed<T>(fn: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超过 ${ms / 1000} 秒没有结果`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What one slot shows now: the plugin's `load` as this person, in the item's space (the plugin's own
 * space on the today page), checked against the block's schema, drawn by its `view` and checked again
 * as display components. Anything wrong is this block's error only.
 */
export async function loadSlot(app: App, userId: string, q: { at: string; plugin: string; block: string; item?: string; stage?: string; object?: string }) {
  const { findPlugin } = await import("./registry.ts");
  const p = findPlugin(q.plugin);
  const slot = p?.slots.find((s) => s.at === q.at && s.block === q.block);
  const def = slot ? p!.blocks.get(slot.block) : undefined;
  if (!p || !slot || !def?.load || !def.view) throw new HttpError(404, "没有这个插槽：插件停用了、撤销了信任，或已经不放在这里");
  const place = await placeOf(app, userId, q);
  const entry = place ? entries(app, p.manifest.id, slot, place).find((e) => (e.object?.id ?? "") === (q.object ?? "")) : undefined;
  if (!place || !entry) throw new HttpError(404, "这个插槽不在这里显示");
  const o = entry.object;
  const at: PluginSlotContext = { at: place.at, item: place.item?.id ?? null, stage: place.stage?.id ?? null, object: o ? { id: o.id, kind: o.kind, key: o.key, title: o.title, status: o.status, link: o.link } : null };
  const ctx = pluginContext(app, p.env, { userId, spaceId: place.item?.spaceId ?? p.manifest.space?.id ?? "personal", runId: null, actor: "user" });
  const who = `插件 ${p.manifest.id} 的 ${slot.block}`;
  let data: unknown;
  try {
    data = await timed(() => def.load!(ctx, at), 15_000);
  } catch (e) {
    throw new HttpError(502, `${who} 没有读到：${(e as Error).message}`);
  }
  const parsed = def.schema.safeParse(data);
  if (!parsed.success) throw new HttpError(502, `${who} 交回的内容不合它的 schema：${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  let drawn: { title?: unknown; components?: unknown };
  try {
    drawn = def.view(parsed.data) as typeof drawn;
  } catch (e) {
    throw new HttpError(502, `${who} 画不出来：${(e as Error).message}`);
  }
  const components = viewSchema.safeParse(drawn?.components);
  if (!components.success) throw new HttpError(502, `${who} 的展示组件不对：${components.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  // An interactive page is an agent's (ui_page) and needs its own permission check: not in a slot.
  if (components.data.some((c) => c.type === "page")) throw new HttpError(502, `${who} 的展示组件里有交互页（page），插槽里不能放`);
  try {
    checkView(components.data);
  } catch (e) {
    throw new HttpError(502, `${who} 的展示组件不对：${(e as Error).message}`);
  }
  const title = typeof drawn.title === "string" && drawn.title.trim() ? drawn.title.trim().slice(0, 80) : null;
  return { title, components: components.data };
}
