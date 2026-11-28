<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AiModelPick from "./AiModelPick.vue";
import Icon from "./Icon.vue";

/**
 * Settings → AI → API key: one key's requests-per-minute and tokens-per-minute caps (config
 * `ai.providers[].limits`). A request over the cap waits for the next minute instead of failing.
 * Per-model rows override only the fields they fill. Saves the whole object; null clears it.
 */
export type MinuteLimits = { rpm?: number; tpm?: number };
export type KeyLimits = MinuteLimits & { models?: Record<string, MinuteLimits> };
export type RateLimitView = {
  waits: { count: number; ms: number };
  windows: { model: string; rpm?: number; tpm?: number; requests: number; tokens: number; queued: number; nextReleaseAt: number | null; blockedUntil: number | null }[];
} | null;

const props = defineProps<{ name: string; limits?: KeyLimits; stats?: RateLimitView; choice: { default: string; models: string[] }; shown: (m: string) => string }>();
const emit = defineEmits<{ save: [limits: KeyLimits | null, note: string] }>();

type Row = { model: string; rpm: string; tpm: string };
const open = ref(false);
const rpm = ref("");
const tpm = ref("");
const rows = ref<Row[]>([]);
const text = (n?: number) => (n === undefined ? "" : String(n));
function reset() {
  rpm.value = text(props.limits?.rpm);
  tpm.value = text(props.limits?.tpm);
  rows.value = Object.entries(props.limits?.models ?? {}).map(([model, l]) => ({ model, rpm: text(l.rpm), tpm: text(l.tpm) }));
}
watch(() => JSON.stringify(props.limits ?? null), reset, { immediate: true });

const num = (s: string) => {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};
const bad = computed(() => [rpm.value, tpm.value, ...rows.value.flatMap((r) => [r.rpm, r.tpm])].some((s) => Number.isNaN(num(s))));
const dupe = computed(() => {
  const names = rows.value.map((r) => r.model.trim()).filter(Boolean);
  return names.length !== new Set(names).size;
});
function pack(): KeyLimits | null {
  const out: KeyLimits = {};
  const r = num(rpm.value), t = num(tpm.value);
  if (r) out.rpm = r;
  if (t) out.tpm = t;
  const models: Record<string, MinuteLimits> = {};
  for (const row of rows.value) {
    const m = row.model.trim();
    const mr = num(row.rpm), mt = num(row.tpm);
    if (!m || (!mr && !mt)) continue;
    models[m] = { ...(mr ? { rpm: mr } : {}), ...(mt ? { tpm: mt } : {}) };
  }
  if (Object.keys(models).length) out.models = models;
  return Object.keys(out).length ? out : null;
}
function save() {
  if (bad.value || dupe.value) return;
  const next = pack();
  emit("save", next, next ? `已保存 ${props.name} 的每分钟限额` : `已去掉 ${props.name} 的每分钟限额`);
  open.value = false;
}
function cancel() {
  reset();
  open.value = false;
}
const clear = () => {
  emit("save", null, `已去掉 ${props.name} 的每分钟限额`);
  open.value = false;
};

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("zh-CN"));
const pair = (l: MinuteLimits) => [l.rpm ? `${fmt(l.rpm)} 次` : "", l.tpm ? `${fmt(l.tpm)} token` : ""].filter(Boolean).join("、");
const summary = computed(() => {
  const l = props.limits;
  if (!l) return "不限";
  const base = pair(l);
  const n = Object.keys(l.models ?? {}).length;
  return [base ? `每分钟 ${base}` : "", n ? `${n} 个模型单独设` : ""].filter(Boolean).join("；");
});
const seconds = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`);
const waitLine = computed(() => {
  const w = props.stats?.waits;
  return w?.count ? `最近 1 小时排队 ${w.count} 次，共等 ${seconds(w.ms)}` : props.limits ? "最近 1 小时没有排队" : "";
});
const windows = computed(() => (props.stats?.windows ?? []).filter((w) => w.requests || w.queued || w.blockedUntil));
const until = (t: number) => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
const modelChoice = computed(() => ({ default: "", models: props.choice.models.filter((m) => !rows.value.some((r) => r.model === m)) }));
</script>

<template>
  <div class="field small lim">
    <span>每分钟限额</span>
    <div v-if="!open" class="lim-sum">
      <span>{{ summary }}</span>
      <button type="button" class="linkish" @click="open = true">{{ limits ? "修改" : "设置" }}</button>
    </div>
    <div v-if="!open && waitLine" class="muted">{{ waitLine }}</div>
    <ul v-if="!open && windows.length" class="lim-wins muted">
      <li v-for="w in windows" :key="w.model">
        <span class="mono">{{ shown(w.model) }}</span>
        这一分钟 <template v-if="w.rpm">{{ w.requests }}/{{ fmt(w.rpm) }} 次</template><template v-if="w.rpm && w.tpm">、</template><template v-if="w.tpm">{{ fmt(w.tokens) }}/{{ fmt(w.tpm) }} token</template>
        <template v-if="w.queued">，{{ w.queued }} 个在排队</template>
        <template v-if="w.blockedUntil">，提供方说到顶了，{{ until(w.blockedUntil) }} 再发</template>
      </li>
    </ul>
    <div v-if="open" class="lim-edit">
      <div class="lim-grid">
        <span /><span class="muted lim-th" title="每分钟请求数">RPM</span><span class="muted lim-th" title="每分钟输入和输出的 token 总数">TPM</span><span />
        <span class="muted">所有模型</span>
        <input v-model="rpm" class="input sm" inputmode="numeric" placeholder="不限" :aria-label="`${name} 每分钟请求数`" />
        <input v-model="tpm" class="input sm" inputmode="numeric" placeholder="不限" :aria-label="`${name} 每分钟 token 数`" />
        <span />
        <template v-for="(r, i) in rows" :key="i">
          <span class="mono lim-model" :title="r.model">{{ shown(r.model) }}</span>
          <input v-model="r.rpm" class="input sm" inputmode="numeric" placeholder="同上" :aria-label="`${shown(r.model)} 每分钟请求数`" />
          <input v-model="r.tpm" class="input sm" inputmode="numeric" placeholder="同上" :aria-label="`${shown(r.model)} 每分钟 token 数`" />
          <button type="button" class="mchip-x" :aria-label="`去掉 ${shown(r.model)} 的单独限额`" @click="rows.splice(i, 1)"><Icon name="x" :size="12" /></button>
        </template>
      </div>
      <AiModelPick :key="rows.length" class="lim-add" model-value="" :choice="modelChoice" empty-label="给某个模型单独设…" placeholder="模型名或 ep-… 接入点 ID" label="给某个模型单独设限额" @change="(v) => v && rows.push({ model: v, rpm: '', tpm: '' })" />
      <p class="hint">按提供方给这个 key 的额度填：到了就排队等下一分钟再发，不报错、不换模型。只填一项也行；单独设的模型没填的那项沿用“所有模型”的。TPM 按请求大小和输出上限估算，回答带了用量就按实际的算。</p>
      <p v-if="bad" class="err-text">限额要填正整数，或留空表示不限。</p>
      <p v-else-if="dupe" class="err-text">同一个模型出现了两次。</p>
      <div class="row lim-acts">
        <button type="button" class="btn sm primary" :disabled="bad || dupe" @click="save">保存</button>
        <button type="button" class="btn sm ghost" @click="cancel">取消</button>
        <button v-if="limits" type="button" class="btn sm ghost" @click="clear">不限了</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.linkish {
  border: 0;
  padding: 0;
  background: none;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.linkish:hover {
  text-decoration: underline;
}
.err-text {
  color: var(--danger);
}
.lim {
  margin-top: 10px;
}
.lim-sum {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
}
.lim-wins {
  margin: 2px 0 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}
.lim-edit {
  display: grid;
  gap: 8px;
  max-width: 520px;
}
.lim-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) 22px;
  gap: 6px 8px;
  align-items: center;
}
.lim-th {
  font-size: 12px;
}
.lim-grid .input {
  width: 100%;
  min-width: 0;
}
.lim-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lim-acts {
  gap: 6px;
}
.mchip-x {
  display: inline-flex;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.mchip-x:hover {
  color: var(--text);
}
</style>
