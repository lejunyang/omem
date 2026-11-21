<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { get } from "../api";
import { state } from "../store";
import { useSettings, type RerankStatus } from "../views/settings/ctx";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 检索与记忆 → 插件参与检索 (`GET /api/search/providers`, src/search/providers.ts): recall
 * providers turned on per space, and which reranker scores. Nothing registered and nothing configured:
 * the card is not there.
 */
type Provider = { id: string; label: string; plugin: string; spaces: string[]; lastMs: number | null; lastError: string | null };
type RetrieverCfg = { provider: string; spaces?: string[]; kinds?: string[]; timeoutMs?: number; limit?: number };
type Status = { retrievers: Provider[]; rerankers: Provider[] };

const { config, rerank, saveConfig } = useSettings();
const status = ref<Status | null>(null);
const error = ref("");
async function load() {
  try {
    status.value = await get<Status>("/api/search/providers");
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(load);

const configured = computed<RetrieverCfg[]>(() => config.value?.search?.retrievers ?? []);
/** Registered ones first, then any still in the configuration whose plugin is no longer running. */
const recallRows = computed(() => {
  const reg = status.value?.retrievers ?? [];
  const gone = configured.value.filter((c) => !reg.some((p) => p.id === c.provider))
    .map((c): Provider & { gone: true } => ({ id: c.provider, label: c.provider, plugin: c.provider.split(":")[0], spaces: [], lastMs: null, lastError: null, gone: true }));
  return [...reg.map((p) => ({ ...p, gone: false })), ...gone];
});
const rerankProvider = computed<string>(() => config.value?.rerank?.provider ?? "local");
const shown = computed(() => !!status.value && (recallRows.value.length > 0 || (status.value.rerankers.length > 0) || rerankProvider.value !== "local"));

const cfgOf = (id: string) => configured.value.find((c) => c.provider === id);
function spaceOptions(p: Provider) {
  const allowed = p.spaces.length ? state.spaces.filter((s) => p.spaces.includes(s.id)) : state.spaces;
  return allowed.map((s) => ({ value: s.id, label: s.name, hint: s.id }));
}
function msLine(p: Provider) {
  return p.lastMs == null ? "还没用过" : p.lastMs < 1 ? "上一次不到 1 ms" : `上一次 ${p.lastMs} ms`;
}

async function saveRetrievers(rows: RetrieverCfg[], note: string) {
  await saveConfig({ search: { ...config.value.search, retrievers: rows } }, note);
  await load();
}
function toggle(p: Provider, on: boolean) {
  const rest = configured.value.filter((c) => c.provider !== p.id);
  void saveRetrievers(on ? [...rest, { provider: p.id }] : rest, on ? `${p.label} 参与检索` : `${p.label} 不再参与检索`);
}
function setSpaces(p: Provider, spaces: string[]) {
  const rows = configured.value.map((c) => {
    if (c.provider !== p.id) return c;
    const { spaces: _old, ...rest } = c;
    // Empty means "all it may read": the key is left out (an explicit [] would turn it off).
    return spaces.length ? { ...rest, spaces } : rest;
  });
  void saveRetrievers(rows, "已保存召回范围");
}
function removeGone(id: string) {
  void saveRetrievers(configured.value.filter((c) => c.provider !== id), "已移除");
}

const rerankOptions = computed(() => {
  const list = [{ value: "local", label: "内置本地模型", hint: "bge-reranker" },
    ...(status.value?.rerankers ?? []).map((p) => ({ value: `plugin:${p.id}`, label: p.label, hint: `来自插件 ${p.plugin}` }))];
  if (!list.some((o) => o.value === rerankProvider.value)) list.push({ value: rerankProvider.value, label: rerankProvider.value.replace(/^plugin:/, ""), hint: "插件已停用" });
  return list;
});
const pickedReranker = computed(() => rerankProvider.value.startsWith("plugin:") ? (status.value?.rerankers ?? []).find((p) => `plugin:${p.id}` === rerankProvider.value) ?? null : null);
async function saveRerank(patch: Record<string, unknown>, note: string) {
  await saveConfig({ rerank: { ...config.value.rerank, ...patch } }, note);
  rerank.value = (await get<{ rerank: RerankStatus }>("/api/settings")).rerank;
  await load();
}
function setPluginThreshold(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  const n = Number(raw);
  const { pluginPassiveThreshold: _old, ...rest } = config.value.rerank;
  if (!raw) return void saveConfig({ rerank: rest }, "插件重排沿用本地模型的门槛");
  if (Number.isFinite(n)) void saveConfig({ rerank: { ...rest, pluginPassiveThreshold: n } }, "已保存插件重排的门槛");
}
</script>

<template>
  <SetCard v-if="shown" id="set-search-providers" title="插件参与检索">
    <template #help>插件只指出库里已有的内容，按你的权限过滤后再并进检索结果。默认都不参与，在这里逐个打开。</template>
    <p v-if="error" class="set-link" role="alert"><span class="grow">读不到插件的状态：{{ error }}</span><button class="btn sm" @click="load">重试</button></p>

    <SetRow v-for="p in recallRows" :key="p.id" :off="!cfgOf(p.id)">
      <template #label><span class="sp-name">{{ p.label }}</span><span class="sp-kind">召回</span></template>
      <template #hint>
        <span v-if="p.gone" class="sp-bad">插件 {{ p.plugin }} 停用了，这一路不会再被调用</span>
        <template v-else>
          <span>来自 {{ p.plugin }}</span>
          <span v-if="p.lastError" class="sp-bad sp-err" :title="p.lastError">上一次出错：{{ p.lastError }}</span>
          <span v-else-if="cfgOf(p.id)"> · {{ msLine(p) }}</span>
        </template>
      </template>
      <div class="sp-ctl">
        <button v-if="p.gone" class="btn ghost sm" @click="removeGone(p.id)">移除</button>
        <template v-else>
          <UiSelect v-if="cfgOf(p.id)" multiple size="sm" width="200px" :model-value="cfgOf(p.id)?.spaces ?? []" :options="spaceOptions(p)" :placeholder="p.spaces.length ? '它获准的全部空间' : '全部空间'" :aria-label="`${p.label}对哪些空间生效`" @change="(v) => setSpaces(p, v as string[])" />
          <UiCheckbox :model-value="!!cfgOf(p.id)" switch :aria-label="`${p.label}参与召回`" @change="(v) => toggle(p, v)" />
        </template>
      </div>
    </SetRow>

    <SetRow v-if="(status?.rerankers.length ?? 0) > 0 || rerankProvider !== 'local'" label="用谁重排" :off="!config.rerank.enabled">
      <template #hint>
        <span v-if="!config.rerank.enabled">重排没开，上面的“重排”打开后才用</span>
        <template v-else-if="rerankProvider.startsWith('plugin:')">
          <span v-if="!pickedReranker" class="sp-bad">插件停用了，现在用内置模型</span>
          <span v-else-if="pickedReranker.lastError" class="sp-bad sp-err" :title="pickedReranker.lastError">出错时改用内置模型：{{ pickedReranker.lastError }}</span>
          <span v-else>{{ msLine(pickedReranker) }}；出错或超时改用内置模型</span>
        </template>
        <span v-else>本机运行，不出网</span>
      </template>
      <UiSelect size="sm" width="200px" :model-value="rerankProvider" :options="rerankOptions" aria-label="用谁重排" @change="(v) => saveRerank({ provider: v }, v === 'local' ? '改用内置模型重排' : '改用插件重排')" />
    </SetRow>
    <SetRow v-if="rerankProvider.startsWith('plugin:') && config.memory?.passive" label="插件重排的记忆门槛" :off="!config.rerank.enabled || !config.memory.passive.enabled">
      <template #hint>对话前带上记忆的门槛是按内置模型的分数定的，换了重排要按插件的分数重新定；空着沿用 {{ config.rerank.passiveThreshold }}</template>
      <input class="input set-num" type="number" inputmode="decimal" step="any" aria-label="插件重排的记忆门槛" :placeholder="String(config.rerank.passiveThreshold)" :value="config.rerank.pluginPassiveThreshold ?? ''" @change="setPluginThreshold" />
    </SetRow>
  </SetCard>
</template>

<style scoped>
.grow { flex: 1; min-width: 0; }
.sp-name { overflow-wrap: anywhere; }
.sp-kind { margin-left: 8px; font-size: 12px; color: var(--muted); }
.sp-ctl { display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
.sp-bad { color: var(--danger); }
.sp-err { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
