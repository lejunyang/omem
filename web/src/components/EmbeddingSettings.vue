<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ApiError, get, post, put } from "../api";
import { settingsCard, settingsSections } from "../lib/caps";
import { confirmDialog } from "../lib/dialog";
import {
  embeddingDraft, embeddingPatch, embeddingProblem, embeddingStatusLine, isModelChange, modelChangeMessage, sameValue, spacesLine,
  type EmbedderInfo, type EmbeddingDraft, type EmbeddingSource, type EmbeddingStatus,
} from "../lib/search-settings";
import { saveRefusal } from "../lib/settings-access";
import { state, toast } from "../store";
import { useSettings, type ModelSource } from "../views/settings/ctx";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 设置 → 检索与记忆 → 向量检索 (src/search/embeddings.ts): where the vectors come from — off, the local model,
 * an OpenAI-shaped API, or a plugin's provider — tried before saving (`POST /api/search/embeddings/test`), and
 * saved as one change: a different model answers 409 with how many vectors go and how many are recomputed,
 * which the owner confirms (`?confirmEmbedding=<token>`) or the draft goes back.
 */
const props = defineProps<{ sourceLine: (s: ModelSource | null | undefined) => string }>();
const { config, embeddingSource, ownerName } = useSettings();

type Status = { embeddings?: EmbeddingStatus; embedders: EmbedderInfo[] };
const status = ref<Status | null>(null);
async function loadStatus() {
  status.value = await get<Status>("/api/search/providers").catch(() => null);
}
onMounted(loadStatus);

const embedders = computed(() => status.value?.embedders ?? []);
const saved = computed(() => embeddingDraft(config.value.embeddings, embedders.value));
const draft = ref<EmbeddingDraft>({ ...saved.value });
const dirty = computed(() => !sameValue(embeddingPatch(draft.value), embeddingPatch(saved.value)));
// A save elsewhere, or the providers arriving: the draft follows as long as nothing in it was changed.
watch(saved, (s, old) => { if (sameValue(draft.value, old)) draft.value = { ...s }; });
const result = ref<{ ok: boolean; text: string } | null>(null);
watch(draft, () => { result.value = null; }, { deep: true });
const edit = computed(() => settingsCard(["embeddings"]).edit);

const current = computed(() => config.value.embeddings.provider as string);
const sourceOptions = computed(() => {
  const list: { value: EmbeddingSource; label: string }[] = [{ value: "none", label: "不用" }, { value: "local", label: "本机模型" }, { value: "api", label: "云端接口" }];
  if (embedders.value.length || current.value.startsWith("plugin:")) list.push({ value: "plugin", label: "插件" });
  return list;
});
const pluginOptions = computed(() => {
  const list = embedders.value.map((e) => ({ value: e.id, label: e.name, hint: [e.model, e.dimensions && `${e.dimensions} 维`].filter(Boolean).join(" · "), group: `插件 ${e.plugin}` }));
  if (current.value.startsWith("plugin:") && !list.some((o) => o.value === current.value))
    list.push({ value: current.value, label: current.value.split(":").pop()!, hint: "插件现在不可用", group: "不可用" });
  return list;
});
const picked = computed(() => embedders.value.find((e) => e.id === draft.value.plugin) ?? null);
const spaceNames = computed(() => new Map(state.spaces.map((s) => [s.id, s.name])));
const pickedSpaces = computed(() => spacesLine(picked.value?.spaces, spaceNames.value));

type Provider = { id: string; name?: string; kind: string; baseUrl?: string };
const providers = computed<Provider[]>(() => config.value.ai?.providers ?? []);
const keyOptions = computed(() => [{ value: "", label: "环境变量", hint: "在运行 omem 的机器上" }, ...providers.value.map((p) => ({ value: p.id, label: p.name || p.id, hint: p.baseUrl ?? p.kind }))]);
const urlPlaceholder = computed(() => providers.value.find((p) => p.id === draft.value.key)?.baseUrl ?? "https://api.example.com/v1");

const line = computed(() => (dirty.value ? { text: "", bad: false } : embeddingStatusLine(status.value?.embeddings)));
const excluded = computed(() => {
  const s = status.value?.embeddings;
  if (dirty.value || !s?.excludedSpaces.length || s.state === "unavailable") return "";
  return `${s.excludedSpaces.map((id) => spaceNames.value.get(id) ?? id).join("、")}没有向量（${s.excludedReason ?? "提供者没获准"}），在这些空间里只用全文检索`;
});
const problem = computed(() => embeddingProblem(draft.value));

const testing = ref(false);
async function test() {
  testing.value = true;
  try {
    const r = await post<{ ok: boolean; dimensions: number | null; elapsedMs: number; error: string | null }>("/api/search/embeddings/test", embeddingPatch(draft.value));
    result.value = r.ok ? { ok: true, text: `能用：返回 ${r.dimensions} 维，用时 ${r.elapsedMs} ms` } : { ok: false, text: `没通过：${r.error}` };
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
  const body = { embeddings: embeddingPatch(draft.value) };
  saving.value = true;
  try {
    let r: { config: unknown };
    try {
      r = await put<{ config: unknown }>("/api/settings", body);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409 || !isModelChange(e.data)) throw e;
      const change = e.data;
      const scoped = draft.value.source === "plugin" && !!picked.value?.spaces?.length;
      const ok = await confirmDialog("换向量模型？", { message: modelChangeMessage(change, scoped), okText: "换并重算", danger: true });
      if (!ok) {
        discard();
        toast("没有换，向量设置保持原样", "info");
        return;
      }
      r = await put<{ config: unknown }>(`/api/settings?confirmEmbedding=${encodeURIComponent(change.token)}`, body);
    }
    config.value = r.config;
    draft.value = { ...saved.value };
    toast("已保存向量设置", "ok");
    await loadStatus();
  } catch (e) {
    toast(saveRefusal((e as Error).message, settingsSections(), ownerName.value), "error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SetCard id="set-embeddings" title="向量检索" :keys="['embeddings']">
    <template #help>换个说法问也能找到相关段落。向量在后台逐步生成，换模型要全部重算；全文检索始终可用。</template>
    <SetRow label="来源">
      <template v-if="line.text" #hint><span :class="{ 'sr-bad': line.bad }" :title="line.title">{{ line.text }}</span></template>
      <UiSegmented v-model="draft.source" size="sm" aria-label="向量从哪来" :options="sourceOptions" />
    </SetRow>
    <p v-if="excluded" class="set-pad sr-note">{{ excluded }}</p>

    <SetRow v-if="draft.source === 'local'" label="模型" block>
      <template #hint>
        <span v-if="current === 'local' && props.sourceLine(embeddingSource)" :class="{ 'sr-bad': embeddingSource?.error }">{{ props.sourceLine(embeddingSource) }}</span>
        <template v-else>默认 Xenova/bge-small-zh-v1.5，也可以填本机目录；在这台机器上算，不出网</template>
      </template>
      <input v-model="draft.localModel" class="input mono" aria-label="本机向量模型" />
    </SetRow>

    <template v-else-if="draft.source === 'api'">
      <p class="set-pad sr-note"><span>查询和要建索引的正文都会发给这个服务。接口是 OpenAI 的 <code>/embeddings</code> 形状。</span></p>
      <SetRow v-if="edit || draft.url" label="接口地址" block hint="空着用所选供应商的地址，再没有就用 OpenAI 的">
        <input v-model="draft.url" class="input mono" :placeholder="urlPlaceholder" aria-label="向量接口地址" />
      </SetRow>
      <SetRow v-if="edit || draft.apiModel" label="模型名">
        <input v-model="draft.apiModel" class="input mono sr-field" placeholder="text-embedding-3-small" aria-label="向量模型名" />
      </SetRow>
      <SetRow v-if="edit" label="密钥" hint="网页上不显示密钥本身">
        <div class="sr-key">
          <UiSelect v-model="draft.key" size="sm" width="180px" aria-label="向量接口的密钥" :options="keyOptions" />
          <input v-if="!draft.key" v-model="draft.apiKeyEnv" class="input sm mono sr-env" placeholder="OPENAI_API_KEY" aria-label="密钥所在的环境变量" />
        </div>
      </SetRow>
      <SetRow label="维度" hint="空着按服务返回的；填了要是模型支持的">
        <input v-model="draft.dimensions" class="input set-num" inputmode="numeric" placeholder="自动" aria-label="向量维度" />
      </SetRow>
      <SetRow label="每批条数" hint="1–256">
        <input v-model.number="draft.batch" class="input set-num" type="number" inputmode="numeric" min="1" max="256" aria-label="每批条数" />
      </SetRow>
      <SetRow label="超时（秒）" hint="1–120；超时会重试两次">
        <input v-model.number="draft.timeoutSec" class="input set-num" type="number" inputmode="numeric" min="1" max="120" aria-label="向量接口超时秒数" />
      </SetRow>
    </template>

    <SetRow v-else-if="draft.source === 'plugin'" label="提供者" block>
      <template #hint>
        <template v-if="pickedSpaces">{{ pickedSpaces }}。问题里带了别的空间的材料时，那次不交给它，只用全文检索。</template>
        <template v-else-if="picked">查询和要建索引的正文交给插件 {{ picked.plugin }}</template>
      </template>
      <UiSelect v-model="draft.plugin" size="sm" width="260px" aria-label="插件的向量提供者" placeholder="选择提供者" :options="pluginOptions" />
    </SetRow>

    <div v-if="draft.source !== 'none' || dirty" class="sr-foot">
      <button v-if="draft.source !== 'none'" class="btn ghost sm" :disabled="testing || !!problem" @click="test">{{ testing ? "在试…" : "试一下" }}</button>
      <span class="sr-result" :class="{ 'sr-bad': (result && !result.ok) || (dirty && problem), 'sr-ok': result?.ok }" role="status">{{ result?.text ?? (dirty ? problem : "") }}</span>
      <template v-if="dirty">
        <span class="sr-unsaved">改动还没保存</span>
        <button class="btn ghost sm" :disabled="saving" @click="discard">放弃</button>
        <button class="btn primary sm" :disabled="saving || !!problem" @click="save">{{ saving ? "保存中…" : "保存" }}</button>
      </template>
    </div>
  </SetCard>
</template>
