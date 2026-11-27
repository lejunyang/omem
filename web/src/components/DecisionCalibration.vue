<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { get } from "../api";
import { toast } from "../store";
import Skeleton from "./Skeleton.vue";
import HelpText from "./HelpText.vue";
import { DECISION_SCENES, type DecisionScene, type DecisionReport } from "../../../src/core/decision-scenes";

const props = defineProps<{ thresholds?: Partial<Record<DecisionScene, number>> }>();
/** Fewer settled runs than this on one side of a category: its rate says little yet. */
const ROUTE_ENOUGH = 10;
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
    <HelpText>把握不够时，按场景继续查看、先问你或等例行巡检。报告按已经发生的结果统计，建议不会自动修改设置。记录保留 90 天，材料只留在当前设备；离线回放会把保存的材料交给指定模型。</HelpText>
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
      <p class="hint">放行指跳过巡检或这批群聊、不提醒你、直接答复对方，或为卡点排对账。改判指模型想放行但把握不到门槛，按各场景的保守做法处理。漏看是放行后发现其实需要你，多看是谨慎处理后发现不需要；不明确的结果不参与漏看率。</p>
      <div v-for="s in report.scenes" :key="s.scene" class="stack small">
        <div>{{ s.label }}：{{ s.suggestion }}</div>
        <div v-if="s.labelsEnabled" class="report-table"><table><caption>假设门槛变化（放行条数 / 已知漏看）</caption><thead><tr><th v-for="t in s.thresholds" :key="t.threshold">{{ t.threshold }}</th></tr></thead><tbody><tr><td v-for="t in s.thresholds" :key="t.threshold">{{ t.risky }} / {{ t.misses }}</td></tr></tbody></table></div>
      </div>
      <div class="stack small routes">
        <strong class="routes-title">按类别选 AI 的结果</strong>
        <p class="hint">同一类运行，用决策模型排的先后和按规则的默认先后，各自正常完成的比例。样本够了再决定这一类要不要继续让模型挑（规则里的“自动挑 / 按先后”）。</p>
        <div v-if="report.routes?.length" class="report-table">
          <table>
            <thead><tr><th>类别</th><th>采用模型的排序</th><th>按默认先后</th></tr></thead>
            <tbody>
              <tr v-for="r in report.routes" :key="r.classId">
                <th scope="row">{{ r.name }}</th>
                <td v-for="side in [r.decision, r.static]" :key="side === r.decision ? 'd' : 's'" :title="`完成 ${side.completed} / 有结果 ${side.settled}，还没结果 ${side.pending}`">
                  <template v-if="side.settled >= ROUTE_ENOUGH">{{ Math.round((100 * side.completed) / side.settled) }}%<span class="muted">（{{ side.completed }}/{{ side.settled }}）</span></template>
                  <span v-else class="muted">{{ side.settled || side.pending ? `样本还少（${side.settled} 条有结果）` : "没有" }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="muted">最近 30 天还没有按类别选 AI 的记录：有类别设成“自动挑”且范围里有两个以上的组时才会有。</p>
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
.routes { padding-top: 8px; border-top: 1px solid var(--line); }
.routes-title { font-size: 13px; font-weight: 600; }
</style>
