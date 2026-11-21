<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { put } from "../api";
import { gateStages, gatesFor, orphanChecks, putCheck, type FlowCheck, type GateOption, type PendingCheck, type PluginNames, type UnavailableCheck, pluginOf } from "../lib/flow-hooks";
import HelpText from "./HelpText.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 完成前的检查 of one flow (`PUT /api/flows/:id/checks`): the plugins' checks this flow may use, each
 * switched on for all or some stages, and whether an error or a timeout stops the stage for the owner.
 * The list is saved as a whole on every change. A check whose plugin is gone stays listed until it is
 * turned off; mandatory ones of those may be holding stages (`pendingCheckScopes`).
 */
/** `unavailable`: saved checks whose plugin is gone, as the server says (`GET /api/flows`). */
const props = defineProps<{ flowId: string; stages: { id: string; name: string }[]; gates: GateOption[]; checks: FlowCheck[]; pending: PendingCheck[]; unavailable?: UnavailableCheck[]; names: PluginNames; editable: boolean }>();
const gone = (id: string) => !!props.unavailable?.some((u) => u.id === id);
const emit = defineEmits<{ saved: [checks: FlowCheck[]] }>();

const list = ref<FlowCheck[]>([]);
watch(() => props.checks, (c) => { list.value = c.map((x) => ({ ...x })); }, { immediate: true, deep: true });
const usable = computed(() => gatesFor(props.gates, props.flowId));
const orphans = computed(() => orphanChecks(list.value, props.gates));
const busy = ref(false), problem = ref(""), saved = ref("");
const stageName = (id: string) => props.stages.find((s) => s.id === id)?.name ?? id;
const plugin = (id: string) => props.names[pluginOf(id) ?? ""] ?? pluginOf(id) ?? id;

async function save(next: FlowCheck[], note: string) {
  if (busy.value || !props.editable) return;
  busy.value = true; problem.value = ""; saved.value = "";
  const before = list.value;
  list.value = next;
  try {
    const result = await put<FlowCheck[]>(`/api/flows/${encodeURIComponent(props.flowId)}/checks`, next);
    list.value = result;
    saved.value = note;
    emit("saved", result);
  } catch (e) {
    list.value = before;
    problem.value = (e as Error).message;
  } finally { busy.value = false; }
}
const on = (id: string) => list.value.find((c) => c.id === id);
function toggle(g: GateOption, v: boolean) { void save(putCheck(list.value, g.id, v ? { mandatory: false } : null), v ? `已打开「${g.name}」` : `已关掉「${g.name}」`); }
function setMandatory(id: string, v: boolean) { const c = on(id); if (c) void save(putCheck(list.value, id, { ...c, mandatory: v }), v ? "出错或超时时会停下等你" : "出错或超时时照常放行"); }
/** Empty means every stage the check may cover. */
function setStages(g: GateOption, v: string[]) { const c = on(g.id); if (c) void save(putCheck(list.value, g.id, { ...c, stages: v.length === gateStages(g, props.stages).length ? [] : v }), "已保存覆盖的阶段"); }
const stageOptions = (g: GateOption) => gateStages(g, props.stages).map((s) => ({ value: s.id, label: s.name }));
const picked = (g: GateOption) => { const c = on(g.id); return c?.stages?.length ? c.stages : gateStages(g, props.stages).map((s) => s.id); };
</script>

<template>
  <section class="checks" aria-labelledby="flow-checks-title">
    <div class="checks-head">
      <h3 id="flow-checks-title">完成前的检查</h3>
      <span v-if="busy" class="muted small" role="status">正在保存…</span>
      <span v-else-if="saved" class="muted small" role="status">{{ saved }}</span>
    </div>
    <HelpText>插件可以在一段交结果之前再看一遍：只能多拦，不能放宽原来的完成条件和签字。被拦下时你可以对这一次仍然通过。</HelpText>

    <div v-if="pending.length" class="pending" role="alert">
      <p><strong>有阶段在等你处理检查</strong></p>
      <p v-for="p in pending" :key="p.id" class="small">{{ plugin(p.id) }} 的「{{ p.id }}」停用了，它是要求停下的检查，适用的阶段现在交不了结果。重新加载那个插件，或在下面关掉这条检查后，再让阶段重新交结果。</p>
    </div>

    <p v-if="!usable.length && !orphans.length" class="muted small">装了带检查的插件以后，可以在这里给这条流程打开。</p>
    <ul v-else class="check-list">
      <li v-for="g in usable" :key="g.id" class="check" :class="{ on: !!on(g.id) }">
        <div class="check-row">
          <UiCheckbox :model-value="!!on(g.id)" switch size="sm" :disabled="busy || !editable" :aria-label="`打开检查「${g.name}」`" @change="(v: boolean) => toggle(g, v)" />
          <div class="check-text">
            <div class="check-name"><strong>{{ g.name }}</strong><span class="muted small">{{ plugin(g.id) }}</span></div>
            <div class="muted small">{{ g.describe }}</div>
          </div>
        </div>
        <div v-if="on(g.id)" class="check-more">
          <label class="check-field"><span>看哪些阶段</span>
            <UiSelect :model-value="picked(g)" multiple size="sm" :disabled="busy || !editable" :aria-label="`「${g.name}」看哪些阶段`" :options="stageOptions(g)" @change="(v) => setStages(g, v as string[])" />
          </label>
          <UiCheckbox :model-value="!!on(g.id)?.mandatory" size="sm" :disabled="busy || !editable" :aria-label="`「${g.name}」检查出错或超时时停下等我`" @change="(v: boolean) => setMandatory(g.id, v)">检查出错或超时时停下等我</UiCheckbox>
        </div>
      </li>
      <li v-for="c in orphans" :key="c.id" class="check on gone">
        <div class="check-row">
          <UiCheckbox :model-value="true" switch size="sm" :disabled="busy || !editable" :aria-label="`关掉检查 ${c.id}`" @change="(v: boolean) => !v && save(putCheck(list, c.id, null), `已关掉 ${c.id}`)" />
          <div class="check-text">
            <div class="check-name"><strong class="mono">{{ c.id }}</strong><span v-if="gone(c.id)" class="badge warn">插件停用了</span></div>
            <div class="muted small">{{ c.mandatory ? "要求停下：适用的阶段会等你处理" : "不要求停下：照常放行，只记一笔" }}<template v-if="c.stages?.length"> · {{ c.stages.map(stageName).join("、") }}</template></div>
          </div>
        </div>
      </li>
    </ul>
    <p v-if="problem" class="err small" role="alert">{{ problem }}</p>
  </section>
</template>

<style scoped>
.checks { display: grid; gap: 8px; max-width: 680px; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.checks-head { display: flex; align-items: baseline; gap: 8px; }
.checks-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.pending { display: grid; gap: 4px; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--warn-soft); }
.pending p { margin: 0; line-height: 1.6; }
.check-list { list-style: none; margin: 0; padding: 0; display: grid; }
.check { display: grid; gap: 8px; padding: 8px 0; border-top: 1px solid var(--line); min-width: 0; }
.check:first-child { border-top: 0; }
.check-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: start; }
.check-text { display: grid; gap: 2px; min-width: 0; }
.check-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.check-more { display: grid; gap: 8px; padding-left: 48px; min-width: 0; }
.check-field { display: grid; gap: 4px; max-width: 360px; min-width: 0; }
.check-field > span { font-size: 12px; color: var(--muted); }
.mono { font-family: var(--mono); font-size: 12.5px; overflow-wrap: anywhere; }
.err { color: var(--danger); margin: 0; }
@media (max-width: 760px) { .check-more { padding-left: 0; } }
</style>
