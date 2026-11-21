<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  carrierOf, carrierOptions, carrierValue, doneOf, doneOptions, doneValue, parseParams, pluginOf, setParam, signalAllowed, simpleFields, writeCarrier, writeDone,
  type CarrierChoice, type DoneChoice, type FlowHooks, type HookOption, type ParamField, type PluginNames, type RawStage, type UnavailableReference,
} from "../lib/flow-hooks";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * One stage's carrier and completion on the flow page, picked instead of typed: you, a wait, or a
 * plugin's job; the owner's nod, Git, or a plugin's signal, each with the parameters the plugin
 * declares. Every change is written into the YAML text, which is what is checked and saved. What the
 * YAML says in ways these pickers do not cover stays as it is (`保持定义里写的`).
 */
/** `unavailable`: this stage's job or signal the server found no plugin offering now (`POST /api/flows/validate`). */
const props = defineProps<{ raw: string; stage: RawStage; hooks: FlowHooks; names: PluginNames; unavailable?: UnavailableReference[]; disabled?: boolean; problem?: string; ownerOnly?: boolean }>();
const gone = (kind: "runner" | "signal", id: string) => !!props.unavailable?.some((u) => u.kind === kind && u.id === id);
const emit = defineEmits<{ "update:raw": [raw: string] }>();

const carrier = computed(() => carrierOf(props.stage));
const done = computed(() => doneOf(props.stage));
const runner = computed<HookOption | null>(() => (carrier.value.kind === "runner" ? props.hooks.runners.find((r) => r.id === (carrier.value as { id: string }).id) ?? null : null));
const signal = computed<HookOption | null>(() => (done.value.kind === "signal" ? props.hooks.signals.find((s) => s.id === (done.value as { id: string }).id) ?? null : null));
const gitSignal = computed(() => done.value.kind === "signal" && !pluginOf(done.value.id));
const minutes = computed(() => props.stage.budget?.minutes ?? null);

const carriers = computed(() => carrierOptions(props.hooks.runners, carrier.value, props.names).map((o) => (o.value.startsWith("runner:") && props.ownerOnly && o.value !== carrierValue(carrier.value) ? { ...o, disabled: true, hint: "只有本人能交给插件执行" } : o)));
const dones = computed(() => doneOptions(props.hooks.signals, done.value, signalAllowed(carrier.value), props.names));

function pickCarrier(v: string) {
  if (v === carrierValue(carrier.value)) return;
  const next: CarrierChoice = v === "owner" || v === "wait" ? { kind: v } : v.startsWith("runner:") ? { kind: "runner", id: v.slice(7), with: {} } : { kind: "other" };
  emit("update:raw", writeCarrier(props.raw, props.stage, next, next.kind === "runner" ? minutes.value ?? 30 : null));
}
function pickDone(v: string) {
  if (v === doneValue(done.value)) return;
  const next: DoneChoice = v === "default" || v === "confirm" ? { kind: v } : v.startsWith("signal:") ? { kind: "signal", id: v.slice(7), with: {} } : { kind: "other" };
  emit("update:raw", writeDone(props.raw, props.stage, next));
}
function setRunnerParams(params: Record<string, unknown>) {
  if (carrier.value.kind === "runner") emit("update:raw", writeCarrier(props.raw, props.stage, { ...carrier.value, with: params }, minutes.value));
}
function setSignalParams(params: Record<string, unknown>) {
  if (done.value.kind === "signal") emit("update:raw", writeDone(props.raw, props.stage, { ...done.value, with: params }));
}
function setMinutes(text: string) {
  const n = Math.round(Number(text));
  if (carrier.value.kind === "runner" && Number.isFinite(n) && n > 0) emit("update:raw", writeCarrier(props.raw, props.stage, carrier.value, n));
}

/** A JSON box per kind, for a schema the form rows cannot show; kept while it does not parse. */
const boxes = ref<Record<"runner" | "signal", string>>({ runner: "", signal: "" });
const boxProblem = ref<Record<"runner" | "signal", string>>({ runner: "", signal: "" });
watch(() => [carrier.value, done.value] as const, ([c, d]) => {
  if (!boxProblem.value.runner) boxes.value.runner = c.kind === "runner" && Object.keys(c.with).length ? JSON.stringify(c.with, null, 2) : "";
  if (!boxProblem.value.signal) boxes.value.signal = d.kind === "signal" && Object.keys(d.with).length ? JSON.stringify(d.with, null, 2) : "";
}, { immediate: true, deep: true });
function typed(kind: "runner" | "signal", text: string) {
  boxes.value[kind] = text;
  const r = parseParams(text);
  boxProblem.value[kind] = r.ok ? "" : r.problem;
  if (r.ok) (kind === "runner" ? setRunnerParams : setSignalParams)(r.value);
}
const fieldsOf = (o: HookOption | null) => (o ? simpleFields(o.params) : []);
const textOf = (params: Record<string, unknown>, f: ParamField) => (params[f.key] === undefined ? "" : String(params[f.key]));
/** The server's word on this stage's parameters, when that is what it objects to. */
const mine = (id: string) => (props.problem && props.problem.includes(id) ? props.problem : "");
</script>

<template>
  <div class="hooks">
    <div class="hook-line">
      <label class="hook-field"><span>谁来做</span><UiSelect :model-value="carrierValue(carrier)" size="sm" :disabled="disabled" aria-label="谁来做" :options="carriers" @change="(v) => pickCarrier(String(v))" /></label>
      <label class="hook-field"><span>做到什么算完</span><UiSelect :model-value="doneValue(done)" size="sm" :disabled="disabled" aria-label="做到什么算完" :options="dones" @change="(v) => pickDone(String(v))" /></label>
    </div>

    <div v-if="carrier.kind === 'runner'" class="provider">
      <p v-if="runner" class="hint">{{ runner.describe }}</p>
      <p v-else-if="gone('runner', carrier.id)" class="hint warn-line">这个插件停用了：{{ carrier.id }} 做不了这一段，轮到它时会卡住等你处理。</p>
      <label class="hook-field narrow"><span>最多跑多少分钟</span><input class="input" type="number" min="1" max="525600" inputmode="numeric" :value="minutes ?? ''" :disabled="disabled" aria-label="最多跑多少分钟" @change="setMinutes(($event.target as HTMLInputElement).value)" /></label>
      <template v-if="runner">
        <template v-if="fieldsOf(runner)">
          <div v-for="f in fieldsOf(runner)!" :key="f.key" class="param">
            <UiCheckbox v-if="f.type === 'boolean'" :model-value="carrier.with[f.key] === true" switch size="sm" :disabled="disabled" :aria-label="f.label" @change="(v: boolean) => setRunnerParams(setParam(carrier.kind === 'runner' ? carrier.with : {}, f, v))">{{ f.label }}</UiCheckbox>
            <label v-else class="hook-field"><span>{{ f.label }}<em v-if="f.required">（必填）</em></span>
              <UiSelect v-if="f.type === 'enum'" :model-value="textOf(carrier.with, f)" size="sm" :disabled="disabled" :aria-label="f.label" :options="[{ value: '', label: '不填' }, ...f.options!.map((o) => ({ value: o, label: o }))]" @change="(v) => setRunnerParams(setParam(carrier.kind === 'runner' ? carrier.with : {}, f, String(v)))" />
              <input v-else class="input mono" :type="f.type === 'string' ? 'text' : 'number'" :value="textOf(carrier.with, f)" :disabled="disabled" :aria-label="f.label" @change="setRunnerParams(setParam(carrier.kind === 'runner' ? carrier.with : {}, f, ($event.target as HTMLInputElement).value))" />
            </label>
            <p v-if="f.hint" class="hint">{{ f.hint }}</p>
          </div>
        </template>
        <label v-else class="hook-field"><span>参数（JSON）</span><textarea class="textarea mono" rows="3" spellcheck="false" :value="boxes.runner" :disabled="disabled" aria-label="运行器参数（JSON）" @input="typed('runner', ($event.target as HTMLTextAreaElement).value)" /></label>
      </template>
      <p v-if="boxProblem.runner || mine(carrier.id)" class="err small" role="alert">{{ boxProblem.runner || mine(carrier.id) }}</p>
      <p v-if="ownerOnly" class="hint">交给插件执行的流程只有本人能提交。</p>
      <p v-else class="hint">保存后要你在确认卡上点“启用”才生效。</p>
    </div>

    <div v-if="done.kind === 'signal' && !gitSignal" class="provider">
      <p v-if="signal" class="hint">{{ signal.describe }}（你也可以自己点做完）</p>
      <p v-else-if="gone('signal', done.id)" class="hint warn-line">这个插件停用了，你可以手动完成这一段：{{ done.id }} 现在没人能判断。</p>
      <template v-if="signal">
        <template v-if="fieldsOf(signal)">
          <div v-for="f in fieldsOf(signal)!" :key="f.key" class="param">
            <UiCheckbox v-if="f.type === 'boolean'" :model-value="done.with[f.key] === true" switch size="sm" :disabled="disabled" :aria-label="f.label" @change="(v: boolean) => setSignalParams(setParam(done.kind === 'signal' ? done.with : {}, f, v))">{{ f.label }}</UiCheckbox>
            <label v-else class="hook-field"><span>{{ f.label }}<em v-if="f.required">（必填）</em></span>
              <UiSelect v-if="f.type === 'enum'" :model-value="textOf(done.with, f)" size="sm" :disabled="disabled" :aria-label="f.label" :options="[{ value: '', label: '不填' }, ...f.options!.map((o) => ({ value: o, label: o }))]" @change="(v) => setSignalParams(setParam(done.kind === 'signal' ? done.with : {}, f, String(v)))" />
              <input v-else class="input mono" :type="f.type === 'string' ? 'text' : 'number'" :value="textOf(done.with, f)" :disabled="disabled" :aria-label="f.label" @change="setSignalParams(setParam(done.kind === 'signal' ? done.with : {}, f, ($event.target as HTMLInputElement).value))" />
            </label>
            <p v-if="f.hint" class="hint">{{ f.hint }}</p>
          </div>
        </template>
        <label v-else class="hook-field"><span>参数（JSON）</span><textarea class="textarea mono" rows="3" spellcheck="false" :value="boxes.signal" :disabled="disabled" aria-label="信号参数（JSON）" @input="typed('signal', ($event.target as HTMLTextAreaElement).value)" /></label>
      </template>
      <p v-if="boxProblem.signal || mine(done.id)" class="err small" role="alert">{{ boxProblem.signal || mine(done.id) }}</p>
    </div>
  </div>
</template>

<style scoped>
.hooks { display: grid; gap: 8px; padding: 8px 0 4px; min-width: 0; }
.hook-line { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.hook-field { display: grid; gap: 4px; min-width: 0; flex: 1 1 180px; }
.hook-field > span { font-size: 12px; color: var(--muted); }
.hook-field em { font-style: normal; }
.hook-field.narrow { max-width: 180px; }
.hook-field :deep(.ui-select), .hook-field .input, .hook-field .textarea { width: 100%; min-width: 0; }
.provider { display: grid; gap: 8px; padding: 8px 12px; border-left: 2px solid var(--line-strong); min-width: 0; }
.param { display: grid; gap: 4px; min-width: 0; }
.hint { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.warn-line { color: var(--warn); }
.mono { font-family: var(--mono); font-size: 12.5px; }
.err { color: var(--danger); margin: 0; overflow-wrap: anywhere; }
</style>
