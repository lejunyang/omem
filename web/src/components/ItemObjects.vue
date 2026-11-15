<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { del, get, onServerEvent, onServerResync, post } from "../api";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { relTime } from "../store";

/**
 * Things on other platforms that have a state and are linked to this item (docs/v2/flows.md §8): a
 * merge request, a pipeline, a deployment. A plugin says what kinds there are and reads them; the host
 * keeps the last state it saw, and a flow stage can wait for it.
 */
type ObjectAction = { id: string; label: string; confirm?: string };
type ItemObject = {
  id: string; kind: string; label: string; title: string; status: string; statusLabel: string; final: boolean; link: string;
  fields: { label: string; value: string }[]; checkedAt: string | null; changedAt: string; error: string | null; disabled: boolean;
  actions?: ObjectAction[];
};
const props = withDefaults(defineProps<{ itemId: string; editable?: boolean }>(), { editable: true });
const list = ref<ItemObject[] | null>(null), error = ref(""), busy = ref(false);
/** The action running now (`<object>:<action>`), and what the last one on each object said when it failed. */
const acting = ref<string | null>(null), failed = ref<Record<string, string>>({});
let seq = 0, epoch = 0;
async function load() {
  const request = ++seq, id = props.itemId;
  try { const rows = await get<ItemObject[]>(`/api/items/${id}/objects`); if (request === seq && id === props.itemId) { list.value = rows; error.value = ""; } }
  catch (e) { if (request === seq) { list.value ??= []; error.value = (e as Error).message; } }
}
watch(() => props.itemId, () => { ++epoch; ++seq; list.value = null; error.value = ""; busy.value = false; acting.value = null; failed.value = {}; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "changed" && e.entity === "item" && e.id === props.itemId) void load(); });
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++epoch; ++seq; off(); resync(); });

async function attach() {
  const generation = epoch;
  const answer = await promptDialog("挂一个外部链接", { message: "合并请求这类带状态的东西：贴它的链接。认得这种链接的插件会去读它现在的状态，之后状态变了这里会跟着变，流程里等它的阶段也会往下走。", fields: [{ id: "url", label: "链接", value: "", required: true, maxLength: 4000 }], okText: "挂上" });
  if (!answer?.url.trim() || generation !== epoch || busy.value) return;
  busy.value = true; error.value = "";
  try { await post(`/api/items/${props.itemId}/objects`, { url: answer.url.trim() }); if (generation === epoch) await load(); }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
/**
 * A button on the card is the person acting themselves: one confirmation naming the object and what
 * will be done, then the plugin's tool runs as them (no approval card) and the object is read again.
 */
async function act(o: ItemObject, a: ObjectAction) {
  const generation = epoch;
  if (busy.value || acting.value) return;
  const ok = await confirmDialog(`${a.label}「${o.title}」？`, { message: [`用你在平台上的身份，对${o.label}「${o.title}」做“${a.label}”。做完会马上再读一次它的状态。`, a.confirm ?? ""].filter(Boolean).join("\n\n"), okText: a.label });
  if (!ok || generation !== epoch || busy.value || acting.value) return;
  acting.value = `${o.id}:${a.id}`;
  const rest = { ...failed.value }; delete rest[o.id]; failed.value = rest;
  try {
    const r = await post<{ ok: boolean; message: string; object: ItemObject | null }>(`/api/items/${props.itemId}/objects/${encodeURIComponent(o.id)}/actions/${encodeURIComponent(a.id)}`, {});
    if (generation !== epoch) return;
    if (!r.ok) failed.value = { ...failed.value, [o.id]: `${a.label}没有成功：${r.message}` };
    await load();
  } catch (e) {
    if (generation === epoch) failed.value = { ...failed.value, [o.id]: `${a.label}没有成功：${(e as Error).message}` };
  } finally {
    if (generation === epoch) acting.value = null;
  }
}
async function detach(o: ItemObject) {
  const generation = epoch;
  if (!await confirmDialog(`不再跟「${o.title}」`, { message: "只是从这件事上解除，不动平台上的东西。流程里等它的阶段会重新等一个新的链接。", okText: "解除" }) || generation !== epoch || busy.value) return;
  busy.value = true; error.value = "";
  try { await del(`/api/items/${props.itemId}/objects/${encodeURIComponent(o.id)}`); if (generation === epoch) await load(); }
  catch (e) { if (generation === epoch) error.value = (e as Error).message; }
  finally { if (generation === epoch) busy.value = false; }
}
</script>

<template>
  <section v-if="list" class="item-objects" aria-label="外部状态">
    <div class="section-title row">外部状态<span class="spacer" /><button v-if="editable" type="button" class="btn ghost sm" :disabled="busy" @click="attach">挂链接</button></div>
    <p v-if="error" class="error small" role="alert">{{ error }}</p>
    <p v-if="!list.length" class="muted small">合并请求、部署单这类平台上带状态的东西可以挂在这里，流程里的阶段能等它走到某个状态。要先装并启用认得那种链接的插件。</p>
    <div v-for="o in list" :key="o.id" class="object" :class="{ final: o.final, off: o.disabled }">
      <div class="object-head">
        <span class="object-kind">{{ o.label }}</span>
        <a :href="o.link" target="_blank" rel="noopener noreferrer" class="object-title">{{ o.title }}</a>
        <span class="object-status" :class="{ final: o.final }">{{ o.statusLabel }}</span>
      </div>
      <dl v-if="o.fields.length" class="object-fields">
        <template v-for="f in o.fields" :key="f.label"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></template>
      </dl>
      <div v-if="editable && !o.disabled && o.actions?.length" class="object-actions">
        <button v-for="a in o.actions" :key="a.id" type="button" class="btn sm" :disabled="busy || !!acting" :aria-busy="acting === `${o.id}:${a.id}`" @click="act(o, a)">{{ acting === `${o.id}:${a.id}` ? `${a.label}中…` : a.label }}</button>
      </div>
      <p v-if="failed[o.id]" class="error small" role="alert">{{ failed[o.id] }}</p>
      <div class="object-foot muted">
        <span v-if="o.disabled">读它的插件停用了，状态停在最后一次看到的样子</span>
        <span v-else-if="o.error" class="warn-text" :title="o.error">上次没读到：{{ o.error }}</span>
        <span v-else-if="o.checkedAt">{{ relTime(o.checkedAt) }}看的</span>
        <span v-if="o.changedAt"> · {{ relTime(o.changedAt) }}变成现在这样</span>
        <span class="spacer" />
        <button v-if="editable" type="button" class="link" :disabled="busy" @click="detach(o)">解除</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.item-objects { display: grid; gap: 8px; min-width: 0; overflow-wrap: anywhere; }
.error { color: var(--danger); margin: 0; }
.item-objects > p { margin: 0; }
/* One state card per object: what it is, its title, where it stands; a hairline between cards, no boxes. */
.object { display: grid; gap: 4px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
.object-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.object-kind { flex: none; font-size: 12px; color: var(--muted); }
.object-title { flex: 1 1 12em; min-width: 0; }
.object-status { flex: none; font-size: 12.5px; font-weight: 600; color: var(--accent); }
.object-status.final { color: var(--ok); }
.object.off .object-status { color: var(--muted); font-weight: 400; }
.object-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 12px; margin: 0; font-size: 12.5px; }
.object-fields dt { color: var(--muted); }
.object-fields dd { margin: 0; min-width: 0; }
.object-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.object > .error { margin: 0; }
.object-foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 4px; font-size: 12px; }
.warn-text { color: var(--warn); }
.link { padding: 0; border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; }
.link:hover { color: var(--ink); text-decoration: underline; }
.link:disabled { cursor: default; opacity: 0.6; }
</style>
