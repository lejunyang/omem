<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post } from "../api";
import { promptDialog } from "../lib/dialog";
import { clockTime, type FlowStage, type FlowView } from "../lib/flow";
import { evidenceTarget, pluginSignal, runnerOf, signalState, type FlowHooks, type PluginEvidence } from "../lib/flow-hooks";
import { flowHooks } from "../lib/flow-hooks-api";
import { refAction } from "../lib/refs";
import { relTime } from "../store";
import Markdown from "./Markdown.vue";

/**
 * What a plugin does on one stage of an item's flow (docs/v2/plugins.md): the signal it waits for and
 * whether anyone can answer, the job it was given and how that went, what it handed in, and a check
 * that stopped the stage. `actions`: the owner's choices on a stopped stage (仍然通过 / 等处理) are here;
 * where the page already shows them at the top (FlowWaiting), it is said without buttons.
 */
const props = withDefaults(defineProps<{ itemId: string; stage: FlowStage; editable?: boolean; actions?: boolean; flat?: boolean }>(), { editable: true, actions: true });
const emit = defineEmits<{ changed: [view: FlowView | null] }>();
const router = useRouter();

const hooks = ref<FlowHooks>({ signals: [], runners: [], gates: [] });
onMounted(() => void flowHooks().then((h) => (hooks.value = h)));
const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name;

const waiting = computed(() => (pluginSignal(props.stage.waitingSignal) ? props.stage.waitingSignal! : null));
const signal = computed(() => waiting.value && signalState(waiting.value, nameOf(hooks.value.signals, waiting.value.type)));
const runner = computed(() => runnerOf(props.stage.carrier.label));
const runnerName = computed(() => runner.value && (nameOf(hooks.value.runners, runner.value.id) ?? runner.value.id));
/** The job failed (or ran out of time): the stage is stuck with the run's error as its note. */
const failed = computed(() => !!runner.value && props.stage.state === "blocked" && !props.stage.gateReview);
const review = computed(() => props.stage.gateReview ?? null);
const evidence = computed<PluginEvidence[]>(() => props.stage.pluginEvidence ?? []);

/** Whether the card on a stopped stage still waits for an answer (an earlier 等处理 leaves it answered). */
const askOpen = ref<boolean | null>(null);
watch(() => [review.value, props.stage.askId, props.editable, props.actions] as const, async ([r, askId, editable, actions]) => {
  askOpen.value = null;
  if (!r || !askId || !editable || !actions) return;
  try { askOpen.value = (await get<{ status: string }>(`/api/asks/${encodeURIComponent(askId)}`)).status === "pending"; }
  catch { askOpen.value = false; }
}, { immediate: true });

const busy = ref(false), error = ref("");
async function answer(choice: 0 | 1) {
  if (!props.stage.askId || busy.value) return;
  busy.value = true; error.value = "";
  try { await post(`/api/asks/${encodeURIComponent(props.stage.askId)}/answer`, { choice }); askOpen.value = false; emit("changed", null); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
/** Nobody can answer the signal now: the owner says it is done, in a sentence. */
async function finish() {
  const r = await promptDialog(`「${props.stage.name}」做完了`, { message: "等的信号现在没人能判断。写一句是怎么完成的，以后翻这件事的经过时看得到。", fields: [{ id: "note", label: "怎么完成的", value: "", required: true, maxLength: 4000 }], okText: "记成做完" });
  if (!r?.note.trim() || busy.value) return;
  busy.value = true; error.value = "";
  try { emit("changed", await post<FlowView>(`/api/items/${props.itemId}/flow/stages/${encodeURIComponent(props.stage.id)}/done`, { note: r.note.trim() })); }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
function open(e: PluginEvidence) {
  const t = evidenceTarget(e.link);
  if (!t) return;
  if (t.kind === "cite") refAction(t.ref)?.();
  else if (t.kind === "route") void router.push(t.path);
  else window.open(t.url, "_blank", "noopener,noreferrer");
}
/** A time still ahead: a past one only means the next patrol has not come round yet. */
const later = (at?: string) => !!at && Date.parse(at) > Date.now();
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
</script>

<template>
  <div v-if="signal || runner || review || evidence.length" class="plugin-stage">
    <div v-if="signal" class="ps-line" :class="signal.tone">
      <span class="ps-head">{{ signal.head }}</span>
      <span class="ps-note">{{ signal.note }}</span>
      <span v-if="signal.tone === 'failing' && waiting" class="ps-when">问了 {{ waiting.failures }} 次没问到{{ later(waiting.nextAt) ? `，${clockTime(waiting.nextAt!)} 再问` : "" }}</span>
      <span v-else-if="waiting?.checkedAt && signal.tone === 'waiting'" class="ps-when">{{ relTime(waiting.checkedAt) }}看的{{ later(waiting.nextAt) ? `，${clockTime(waiting.nextAt!)} 再看` : "" }}</span>
      <button v-if="signal.tone === 'gone' && editable && stage.state === 'doing'" type="button" class="btn sm" :disabled="busy" @click="finish">手动完成…</button>
    </div>

    <div v-if="runner" class="ps-line" :class="{ failing: failed }">
      <span class="ps-head">由 {{ runnerName }} 执行{{ failed ? "，没做成" : "" }}</span>
      <span class="ps-note">{{ runner.describe }}</span>
      <a v-if="stage.carrier.link" :href="stage.carrier.link" class="ps-when">看这次运行</a>
    </div>

    <div v-if="review" class="ps-review" :class="{ quiet: !actions, flat }">
      <p v-if="!flat || review.failed.length > 1" class="ps-review-head"><strong v-if="!flat">被检查拦下</strong><span v-if="review.failed.length > 1" class="muted">{{ flat ? "" : " · " }}{{ review.failed.length }} 条检查没通过</span></p>
      <ul class="ps-failed">
        <li v-for="f in review.failed" :key="f.id"><span class="ps-check">{{ nameOf(hooks.gates, f.id) ?? f.id }}</span>{{ f.reason }}</li>
      </ul>
      <details v-if="review.summary" class="ps-summary">
        <summary>它看的结果</summary>
        <Markdown :source="review.summary" compact />
      </details>
      <div v-if="actions && editable && stage.askId" class="row wrap">
        <template v-if="askOpen">
          <button type="button" class="btn sm primary" :disabled="busy" @click="answer(0)">仍然通过</button>
          <button type="button" class="btn sm ghost" :disabled="busy" @click="answer(1)">等处理</button>
          <span class="muted small">仍然通过只算这一次，记下越过了哪条检查。</span>
        </template>
        <span v-else-if="askOpen === false" class="muted small">你选了等处理。处理好以后重新检查，或重开这一段。</span>
      </div>
    </div>

    <div v-if="evidence.length" class="ps-evidence">
      <span class="muted">插件交的证据</span>
      <ul>
        <li v-for="(e, i) in evidence" :key="i">
          <template v-if="evidenceTarget(e.link)">
            <a v-if="evidenceTarget(e.link)!.kind === 'external'" :href="e.link" target="_blank" rel="noopener noreferrer">{{ e.text }}<span class="muted"> · {{ host(e.link!) }}</span></a>
            <a v-else href="#" @click.prevent="open(e)">{{ e.text }}</a>
          </template>
          <span v-else>{{ e.text }}</span>
        </li>
      </ul>
    </div>
    <p v-if="error" class="ps-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.plugin-stage { display: grid; gap: 8px; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
.ps-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding-left: 10px; border-left: 2px solid var(--accent); }
.ps-line.failing, .ps-line.gone { border-left-color: var(--warn); }
.ps-head { font-weight: 600; color: var(--ink); }
.ps-line.failing .ps-head, .ps-line.gone .ps-head { color: var(--warn); }
.ps-note { color: var(--ink-2); min-width: 0; }
.ps-when { font-size: 12px; color: var(--muted); }
.ps-error { margin: 0; color: var(--danger); font-size: 13px; }
.ps-review { display: grid; gap: 8px; padding: 12px; border-radius: var(--radius); background: var(--warn-soft); }
.ps-review.quiet { background: var(--sunken); }
.ps-review.flat { padding: 0; background: none; }
.ps-review p { margin: 0; }
.ps-review-head strong { color: var(--warn); }
.ps-failed { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; line-height: 1.6; }
.ps-check { margin-right: 8px; font-size: 12px; color: var(--muted); }
.ps-summary summary { width: fit-content; cursor: pointer; font-size: 12px; color: var(--muted); }
.ps-evidence { display: grid; gap: 4px; font-size: 12.5px; }
.ps-evidence ul { margin: 0; padding: 0 0 0 1.1em; display: grid; gap: 2px; }
</style>
