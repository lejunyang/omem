<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { get, post } from "../api";
import { settingsCard } from "../lib/caps";
import { rerankDraft, rerankPatch, rerankProblem, rerankScoresText, sameValue, spacesLine, type RerankDraft, type RerankerInfo, type RerankSource } from "../lib/search-settings";
import { state } from "../store";
import { useSettings, type ModelSource, type RerankStatus } from "../views/settings/ctx";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 检索与记忆 → 重排 (src/search/rerank.ts): on or off, and who scores — the local cross-encoder, a
 * `/rerank`-shaped API, or a plugin's reranker. Where it comes from is a draft with its own save, tried first
 * (`POST /api/search/rerank/test`); the switch and the local tuning are saved as they change.
 */
const props = defineProps<{ sourceLine: (s: ModelSource | null | undefined) => string }>();
const { config, rerank, saveConfig } = useSettings();

const rerankers = ref<RerankerInfo[]>([]);
async function loadProviders() {
  rerankers.value = (await get<{ rerankers: RerankerInfo[] }>("/api/search/providers").catch(() => null))?.rerankers ?? [];
}
onMounted(loadProviders);
async function refresh() {
  rerank.value = (await get<{ rerank?: RerankStatus }>("/api/settings").catch(() => null))?.rerank ?? rerank.value;
  await loadProviders();
}
async function saveRerank(patch: Record<string, unknown>, note = "已保存重排设置") {
  await saveConfig({ rerank: { ...config.value.rerank, ...patch } }, note);
  await refresh();
}

const saved = computed(() => rerankDraft(config.value.rerank, rerankers.value));
const draft = ref<RerankDraft>({ ...saved.value });
const dirty = computed(() => !sameValue(rerankPatch(draft.value), rerankPatch(saved.value)));
watch(saved, (s, old) => { if (sameValue(draft.value, old)) draft.value = { ...s }; });
const result = ref<{ ok: boolean; text: string } | null>(null);
watch(draft, () => { result.value = null; }, { deep: true });
const edit = computed(() => settingsCard(["rerank"]).edit);

const current = computed(() => config.value.rerank.provider as string);
const sourceOptions = computed(() => {
  const list: { value: RerankSource; label: string }[] = [{ value: "local", label: "本机模型" }, { value: "api", label: "云端接口" }];
  if (rerankers.value.length || current.value.startsWith("plugin:")) list.push({ value: "plugin", label: "插件" });
  return list;
});
const pluginOptions = computed(() => {
  const list = rerankers.value.map((p) => ({ value: `plugin:${p.id}`, label: p.label, hint: `来自插件 ${p.plugin}`, group: `插件 ${p.plugin}` }));
  if (current.value.startsWith("plugin:") && !list.some((o) => o.value === current.value))
    list.push({ value: current.value, label: current.value.replace(/^plugin:/, ""), hint: "插件停用了，现在用本机模型", group: "不可用" });
  return list;
});
const picked = computed(() => rerankers.value.find((p) => `plugin:${p.id}` === draft.value.plugin) ?? null);
const spaceNames = computed(() => new Map(state.spaces.map((s) => [s.id, s.name])));

type Provider = { id: string; name?: string; kind: string; baseUrl?: string };
const providers = computed<Provider[]>(() => config.value.ai?.providers ?? []);
const keyOptions = computed(() => [{ value: "", label: "环境变量", hint: "在运行 omem 的机器上" }, ...providers.value.map((p) => ({ value: p.id, label: p.name || p.id, hint: p.baseUrl ?? p.kind }))]);
const urlPlaceholder = computed(() => providers.value.find((p) => p.id === draft.value.key)?.baseUrl ?? "https://api.example.com/v1");

/** How the saved choice is doing, in one line. */
const line = computed(() => {
  const r = rerank.value;
  if (!r?.enabled || dirty.value) return { text: "", bad: false };
  const tail = r.timeouts ? `，${r.timeouts} 次超时没用上` : "";
  if (current.value.startsWith("plugin:")) {
    const p = rerankers.value.find((x) => `plugin:${x.id}` === current.value);
    if (!p) return { text: "插件停用了，现在用本机模型重排", bad: true };
    if (p.lastError) return { text: `出错时改用本机模型：${p.lastError}`, bad: true };
    return { text: p.lastMs == null ? "还没用过；出错或超时改用本机模型" : `上一次 ${p.lastMs} ms；出错或超时改用本机模型`, bad: false };
  }
  if (r.state === "ready") return { text: `${current.value === "api" ? "接口能用" : "已加载"} · 用过 ${r.calls} 次${r.lastMs ? `，上一次 ${(r.lastMs / 1000).toFixed(1)} 秒` : ""}${tail}`, bad: false };
  if (r.state === "loading") return { text: r.source?.syncing ? "模型还在下载" : "正在下载或加载模型（第一次要下载，可能要几分钟），这期间检索保持原来的顺序", bad: false };
  if (r.state === "failed") return { text: `${current.value === "api" ? "上一次调用出错" : "加载失败"}：${r.error || r.lastError}`, bad: true };
  return { text: "还没用过（第一次检索时调用）", bad: false };
});
const problem = computed(() => rerankProblem(draft.value));
const showTuning = ref(false);
function numberIn(e: Event, min: number, max: number, fallback: number) {
  const n = Number((e.target as HTMLInputElement).value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

const testing = ref(false);
async function test() {
  testing.value = true;
  try {
    const r = await post<{ ok: boolean; results: { index: number; score: number }[]; elapsedMs: number; error: string | null }>("/api/search/rerank/test", rerankPatch(draft.value));
    result.value = r.ok ? { ok: true, text: `能用：${rerankScoresText(r.results)}，用时 ${r.elapsedMs} ms` } : { ok: false, text: `没通过：${r.error}` };
  } catch (e) {
    result.value = { ok: false, text: `没通过：${(e as Error).message}` };
  } finally {
    testing.value = false;
  }
}
function discard() {
  draft.value = { ...saved.value };
}
const saving = ref(false);
async function save() {
  saving.value = true;
  try {
    await saveRerank(rerankPatch(draft.value), draft.value.source === "local" ? "改用本机模型重排" : draft.value.source === "api" ? "改用云端接口重排" : "改用插件重排");
    draft.value = { ...saved.value };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SetCard v-if="config.rerank" id="set-rerank" title="重排" :keys="['rerank']">
    <template #help>检索先按全文和向量取候选，再把问题和排在前面的几条逐条对读、重新排序；对话前带上的记忆也由它判断相关不相关。本机模型（bge-reranker-v2-m3）在公开中文检索集 T2Retrieval 上让排序指标 nDCG@10 提高 3～5 点，代价是每次检索多花 CPU。超时或出错就保持原来的顺序。改这里不用重启服务。</template>
    <SetRow label="开启重排">
      <template v-if="line.text" #hint><span :class="{ 'sr-bad': line.bad }">{{ line.text }}</span></template>
      <UiCheckbox :model-value="config.rerank.enabled" switch aria-label="开启重排" @change="(v) => saveRerank({ enabled: v })" />
    </SetRow>
    <template v-if="config.rerank.enabled">
      <SetRow label="来源">
        <UiSegmented v-model="draft.source" size="sm" aria-label="谁来重排" :options="sourceOptions" />
      </SetRow>

      <template v-if="draft.source === 'local'">
        <SetRow label="模型" block>
          <template #hint><span :class="{ 'sr-bad': rerank?.source?.error }">{{ props.sourceLine(rerank?.source) || "osdk 下载的本地目录，或 Hugging Face 上的 ONNX 模型 id（首次使用时下载，不锁定版本）" }}</span></template>
          <input class="input mono" :value="config.rerank.model" aria-label="重排模型" @change="saveRerank({ model: ($event.target as HTMLInputElement).value.trim() || config.rerank.model })" />
        </SetRow>
        <SetRow label="条数、长度和线程" hint="前 20 条、每条 512 token 时效果和前 50 条差不多；减半大约快一倍">
          <button class="btn ghost sm" :aria-expanded="showTuning" @click="showTuning = !showTuning">{{ showTuning ? "收起" : `${config.rerank.top} 条 · ${config.rerank.maxTokens} token` }}</button>
        </SetRow>
        <template v-if="showTuning">
          <SetRow label="重排条数" hint="5–100"><input class="input set-num" type="number" inputmode="numeric" min="5" max="100" aria-label="重排条数" :value="config.rerank.top" @change="saveRerank({ top: numberIn($event, 5, 100, config.rerank.top) })" /></SetRow>
          <SetRow label="每条 token" hint="128–1024"><input class="input set-num" type="number" inputmode="numeric" min="128" max="1024" step="64" aria-label="每条 token" :value="config.rerank.maxTokens" @change="saveRerank({ maxTokens: numberIn($event, 128, 1024, config.rerank.maxTokens) })" /></SetRow>
          <SetRow label="线程数" hint="0 用全部核；和别的任务抢 CPU 时调小"><input class="input set-num" type="number" inputmode="numeric" min="0" max="256" aria-label="线程数" :value="config.rerank.threads" @change="saveRerank({ threads: numberIn($event, 0, 256, config.rerank.threads) })" /></SetRow>
          <SetRow label="超时（秒）" hint="超时就保持原来的顺序"><input class="input set-num" type="number" inputmode="numeric" min="1" max="120" aria-label="超时秒数" :value="config.rerank.timeoutMs / 1000" @change="saveRerank({ timeoutMs: numberIn($event, 1, 120, config.rerank.timeoutMs / 1000) * 1000 })" /></SetRow>
        </template>
      </template>

      <template v-else-if="draft.source === 'api'">
        <p class="set-pad sr-note"><span>查询和排在前面的几条正文会发给这个服务。接口是通行的 <code>/rerank</code> 形状（query、documents，返回每条的分数）。</span></p>
        <SetRow v-if="edit || draft.url" label="接口地址" block hint="空着用所选供应商的地址，再没有就用 OpenAI 的">
          <input v-model="draft.url" class="input mono" :placeholder="urlPlaceholder" aria-label="重排接口地址" />
        </SetRow>
        <SetRow v-if="edit || draft.model" label="模型名">
          <input v-model="draft.model" class="input mono sr-field" placeholder="rerank-model" aria-label="重排模型名" />
        </SetRow>
        <SetRow v-if="edit" label="密钥" hint="网页上不显示密钥本身">
          <div class="sr-key">
            <UiSelect v-model="draft.key" size="sm" width="180px" aria-label="重排接口的密钥" :options="keyOptions" />
            <input v-if="!draft.key" v-model="draft.apiKeyEnv" class="input sm mono sr-env" placeholder="OPENAI_API_KEY" aria-label="密钥所在的环境变量" />
          </div>
        </SetRow>
        <SetRow label="接口超时（秒）" hint="1–120；超时就保持原来的顺序">
          <input v-model.number="draft.timeoutSec" class="input set-num" type="number" inputmode="numeric" min="1" max="120" aria-label="重排接口超时秒数" />
        </SetRow>
        <SetRow label="交出去的条数" hint="只把排在前面的这几条交给它，5–100">
          <input class="input set-num" type="number" inputmode="numeric" min="5" max="100" aria-label="交出去的条数" :value="config.rerank.top" @change="saveRerank({ top: numberIn($event, 5, 100, config.rerank.top) })" />
        </SetRow>
      </template>

      <SetRow v-else label="提供者" block>
        <template v-if="picked" #hint>
          {{ spacesLine(picked.spaces, spaceNames) || `来自插件 ${picked.plugin}` }}；出错或超时改用本机模型
        </template>
        <UiSelect v-model="draft.plugin" size="sm" width="260px" aria-label="插件的重排" placeholder="选择重排" :options="pluginOptions" />
      </SetRow>

      <div class="sr-foot">
        <button class="btn ghost sm" :disabled="testing || !!problem" @click="test">{{ testing ? "在试…" : "试一下" }}</button>
        <span class="sr-result" :class="{ 'sr-bad': (result && !result.ok) || (dirty && problem), 'sr-ok': result?.ok }" role="status">{{ result?.text ?? (dirty ? problem : "") }}</span>
        <template v-if="dirty">
          <span class="sr-unsaved">改动还没保存</span>
          <button class="btn ghost sm" :disabled="saving" @click="discard">放弃</button>
          <button class="btn primary sm" :disabled="saving || !!problem" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
        </template>
      </div>
    </template>
  </SetCard>
</template>
