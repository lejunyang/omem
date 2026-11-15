<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { get } from "../api";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import HelpText from "./HelpText.vue";
import { DECISION_SCENES, type DecisionScene, type DecisionReport } from "../../../src/core/decision-scenes";

const props = defineProps<{ thresholds?: Partial<Record<DecisionScene, number>> }>();
const emit = defineEmits<{ save: [thresholds: Record<DecisionScene, number>] }>();
const report = ref<DecisionReport | null>(null);
const loading = ref(false);
const error = ref("");
let seq = 0;
async function load() {
  const request = ++seq;
  loading.value = true;
  error.value = "";
  report.value = null;
  try {
    const value = await get<DecisionReport>("/api/ai/decision/report");
    if (seq === request) report.value = value;
  } catch (e) { if (seq === request) error.value = (e as Error).message; }
  finally { if (seq === request) loading.value = false; }
}
onMounted(load);
watch(() => JSON.stringify(props.thresholds), load);
function save(event: Event, scene: DecisionScene) {
  const input = event.target as HTMLInputElement;
  const n = Number(input.value);
  if (!input.value || !Number.isFinite(n) || n < 0.5 || n > 0.99) {
    input.value = String(props.thresholds?.[scene] ?? DECISION_SCENES[scene].default);
    toast("请输入 0.5–0.99 的数字", "error");
    return;
  }
  emit("save", Object.fromEntries(Object.entries(DECISION_SCENES).map(([key, s]) => [key, key === scene ? n : props.thresholds?.[key as DecisionScene] ?? s.default])) as Record<DecisionScene, number>);
}
</script>

<template>
  <div class="card pad stack">
    <strong>决策门槛与结果</strong>
    <HelpText>把握不够时，多看一眼或先问你。门槛只限制跳过、忽略和直接答复；报告按已经发生的结果统计，建议不会自动修改设置。记录保留 90 天，材料只留在当前设备；离线回放会把保存的材料交给指定模型。</HelpText>
    <label v-for="(s, scene) in DECISION_SCENES" :key="scene" class="field">
      <span>{{ s.label }}</span>
      <input class="input threshold" type="number" min="0.5" max="0.99" step="0.01" :value="thresholds?.[scene] ?? s.default" @change="save($event, scene)" />
      <span class="hint">{{ s.help }}</span>
    </label>
    <div class="row wrap"><span class="muted small">最近 30 天</span><button class="btn ghost sm" :disabled="loading" @click="load">刷新统计</button></div>
    <Skeleton v-if="loading" />
    <p v-else-if="error" class="hint" role="alert">{{ error }}</p>
    <template v-else-if="report">
      <div class="report-table">
        <table class="small"><thead><tr><th>场景</th><th>记录</th><th>放行</th><th>改判</th><th>有结果</th><th>漏看</th><th>多看</th></tr></thead>
          <tbody><tr v-for="s in report.scenes" :key="s.scene"><th scope="row">{{ s.label }}</th><td>{{ s.records }}</td><td>{{ s.risky }}</td><td>{{ s.lowered }}</td><td :title="`需要 ${s.needed} / 不需要 ${s.unneeded} / 不明确 ${s.unclear}`">{{ s.labelled }}</td><td>{{ s.misses }}</td><td>{{ s.wasted }}</td></tr></tbody>
        </table>
      </div>
      <p class="hint">放行指跳过巡检或这批群聊、不提醒你、直接答复对方；改判指模型想放行但把握不到门槛，改按要看、要提醒、要你拍板处理。漏看是放行后发现其实需要你，多看是谨慎处理后发现不需要；不明确的结果不参与漏看率。</p>
      <div v-for="s in report.scenes" :key="s.scene" class="stack small">
        <div>{{ s.label }}：{{ s.suggestion }}</div>
        <div v-if="s.labelsEnabled" class="report-table"><table><caption>假设门槛变化（放行条数 / 已知漏看）</caption><thead><tr><th v-for="t in s.thresholds" :key="t.threshold">{{ t.threshold }}</th></tr></thead><tbody><tr><td v-for="t in s.thresholds" :key="t.threshold">{{ t.risky }} / {{ t.misses }}</td></tr></tbody></table></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.threshold { width: min(100%, 160px); }
.report-table { max-width: 100%; min-width: 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; overflow-wrap: anywhere; }
th, td { padding: 6px 2px; border-bottom: 1px solid var(--line); text-align: left; }
caption { text-align: left; color: var(--muted); padding-bottom: 4px; }
</style>
