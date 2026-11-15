/**
 * Slots (docs/v2/flows.md §8, “界面插槽”): a plugin's display block shown on omem's own pages — the item
 * panel, under a flow stage, the today page. Declared in `register(api)`, after the block (and the object
 * kinds a condition names):
 *
 *     api.block({ kind: "ci_summary", description: "合并请求的检查结果", display: true, schema, load, view });
 *     api.slot("item.panel", { block: "ci_summary", when: { object: "pull-request" } });
 *
 * `load` reads what the block shows, as the person looking at the page and in the item's space (the
 * plugin's own space on the today page); its result must pass the block's `schema`. `view` turns it into
 * display components (the ones `renderView` draws, without `page`). Only code running inside omem can
 * declare slots; they go away when the plugin is turned off or its trust withdrawn.
 *
 * No imports here, so omem's own type checks can compare these with the host's; the main entry
 * (client.ts) fills in the context and component types.
 */
export type PluginSlotPlace = "item.panel" | "flow.stage" | "today";
/**
 * When a slot shows; not for `today`. `object`: one of this plugin's object kinds — on `item.panel` linked
 * to the item (one block per object), on `flow.stage` the kind the stage follows (`by` / `done`).
 * `stage`: stage ids (`flow.stage` only); `flow`: flow ids; `space`: the item's space.
 */
export type PluginSlotWhen = { object?: string; stage?: string | string[]; flow?: string | string[]; space?: string | string[] };
export type PluginSlot = { block: string; when?: PluginSlotWhen };
/** What a block in a slot is shown for: the item, the stage and the object it sits by (null where there is none). */
export type PluginSlotContext = { at: PluginSlotPlace; item: string | null; stage: string | null; object: { id: string; kind: string; key: string; title: string; status: string; link: string } | null };
export type PluginSlotView<C = unknown> = { title?: string; components: C[] };
/** The parts of a display block a slot uses (its `kind`, `schema`, `description` and `display: true` as usual). */
export type PluginSlotBlock<T, Ctx = unknown, C = unknown> = {
  load(ctx: Ctx, slot: PluginSlotContext): T | Promise<T>;
  view(data: T): PluginSlotView<C>;
};
export type PluginSlotApi = { slot(at: PluginSlotPlace, def: PluginSlot): void };
