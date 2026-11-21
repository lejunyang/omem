<script setup lang="ts">
import { ref, watch } from "vue";
import { intIn, useBackends, useSettings, type ModelSource } from "./ctx";
import EmbeddingSettings from "../../components/EmbeddingSettings.vue";
import HelpText from "../../components/HelpText.vue";
import Icon from "../../components/Icon.vue";
import RerankSettings from "../../components/RerankSettings.vue";
import SearchProviders from "../../components/SearchProviders.vue";
import SetCard from "../../components/SetCard.vue";
import SetGate from "../../components/SetGate.vue";
import SetRow from "../../components/SetRow.vue";
import Skeleton from "../../components/Skeleton.vue";
import UiCheckbox from "../../components/UiCheckbox.vue";
import UiSelect from "../../components/UiSelect.vue";

/** 设置 → 知识 → 检索与记忆: vectors, reranking, memories brought into a conversation, and checking what gets written as memory. */
const { config, profiles, saveConfig } = useSettings();
const { profileOptions, probes, effortsOf, modelOptionsFor, loadProbes } = useBackends(profiles);
watch(() => profiles.value.length, (n) => { if (n) void loadProbes(); }, { immediate: true });

/** Where a local model comes from, in the owner's words (search/local-models.ts: osdk first, then its own download). */
function sourceLine(s: ModelSource | null | undefined) {
  if (!s) return "";
  const size = s.size ? `（${s.size}）` : "";
  if (s.via === "local") return `从本地目录加载：${s.path}`;
  if (s.via === "osdk") return `由 osdk 下载并锁定版本，离线加载：${s.path}`;
  if (s.syncing) return `osdk 正在下载模型${size}，下完自动改用它。${s.cached ? "这期间先用以前自己下载的那份。" : "下完之前这项功能不生效。"}`;
  if (s.error) return `osdk 没能下载（${s.error}），改为自己从 Hugging Face 下载${s.cached ? "，已经下好" : size}。十分钟后再试 osdk。`;
  if (!s.osdk) return `这台机器没有 osdk：模型在第一次使用时自己从 Hugging Face 下载${s.cached ? "，已经下好" : size}，放在依赖目录的缓存里，不锁定版本，重装依赖后要重新下载。`;
  if (!s.known) return `这个模型不在 omem 交给 osdk 管理的清单里：第一次使用时自己从 Hugging Face 下载${s.cached ? "，已经下好" : ""}。`;
  return `有 osdk：下一次用到时由 osdk 下载并锁定版本${size}${s.cached ? "；这之前先用以前自己下载的那份" : ""}。`;
}
function saveRerank(patch: Record<string, unknown>, note = "已保存重排设置") {
  void saveConfig({ rerank: { ...config.value.rerank, ...patch } }, note);
}
/** Scores from a cloud API or a plugin are on their own scale: their gate is set apart (memory/passive.ts). */
function setOtherThreshold(e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim();
  const n = Number(raw);
  const { pluginPassiveThreshold: _old, ...rest } = config.value.rerank;
  if (!raw) return void saveConfig({ rerank: rest }, "改回按相似度门槛");
  if (Number.isFinite(n)) void saveConfig({ rerank: { ...rest, pluginPassiveThreshold: n } }, "已保存重排门槛");
}
function savePassive(patch: Record<string, unknown>) {
  const memory = config.value.memory;
  void saveConfig({ memory: { ...memory, passive: { ...memory.passive, ...patch } } }, "已保存相关记忆设置");
}
function saveReview(patch: Record<string, unknown>) {
  const memory = config.value.memory;
  void saveConfig({ memory: { ...memory, review: { ...memory.review, ...patch } } }, "已保存记忆复核设置");
}
function saveNoteReview(patch: Record<string, unknown>) {
  void saveConfig({ notes: { ...config.value.notes, review: { ...config.value.notes.review, ...patch } } }, "已保存标注复核设置");
}
const compareDraft = ref({ profile: "", model: "", effort: "" });
function addCompare() {
  if (!compareDraft.value.profile) return;
  const c = { profile: compareDraft.value.profile, ...(compareDraft.value.model.trim() ? { model: compareDraft.value.model.trim() } : {}), ...(compareDraft.value.effort.trim() ? { effort: compareDraft.value.effort.trim() } : {}) };
  void saveConfig({ memory: { ...config.value.memory, compare: [...config.value.memory.compare, c] } }, "已添加对比模型");
  compareDraft.value = { profile: "", model: "", effort: "" };
}
function removeCompare(i: number) {
  void saveConfig({ memory: { ...config.value.memory, compare: config.value.memory.compare.filter((_: unknown, j: number) => j !== i) } }, "已移除对比模型");
}
</script>

<template>
  <Skeleton v-if="!config" :rows="6" />
  <div v-else class="stack">
    <HelpText lead>全文检索始终可用（中文按双字切分，代码按标识符切分）。向量和重排可以用本机模型、云端接口或插件。</HelpText>

    <EmbeddingSettings v-if="config.embeddings" :source-line="sourceLine" />
    <RerankSettings v-if="config.rerank" :source-line="sourceLine" />

    <SetGate :keys="['search']" owner><SearchProviders /></SetGate>

    <SetCard v-if="config.memory?.passive" id="set-passive-memory" title="对话前带上相关记忆" :keys="['memory']">
      <template #help>你发消息时，先按这条消息找相似的记忆（事实、约定、人物、决定），相似度过了门槛的最多 {{ config.memory.passive.limit }} 条附在消息后面，助理不用先想起来去查。没过门槛就什么都不加。需要开启向量检索。门槛越高带得越少、越准：0.6 时，有相关记忆的问题约八成能带上，带上的约 96% 相关；无关的问题约一成会带上一两条（bge-small-zh，见 docs/v2/evaluation.md）。</template>
      <SetRow label="开启" hint="需要开启向量检索">
        <UiCheckbox :model-value="config.memory.passive.enabled" switch aria-label="对话前带上相关记忆" @change="(v) => savePassive({ enabled: v })" />
      </SetRow>
      <SetRow label="相似度门槛" :hint="config.rerank?.enabled ? '0.4–0.9；开着重排时只在重排超时的时候用' : '0.4–0.9；越高带得越少、越准'" :off="!config.memory.passive.enabled">
        <input class="input set-num" type="number" inputmode="decimal" min="0.4" max="0.9" step="0.025" aria-label="相似度门槛" :value="config.memory.passive.threshold" @change="savePassive({ threshold: Math.max(0.4, Math.min(0.9, Number(($event.target as HTMLInputElement).value) || 0.6)) })" />
      </SetRow>
      <SetRow v-if="config.rerank?.enabled && config.rerank.provider === 'local'" label="重排门槛" hint="先按相似度 0.4 以上取候选，再只带重排打分过这个门槛的" :off="!config.memory.passive.enabled">
        <input class="input set-num" type="number" inputmode="decimal" min="0.05" max="0.95" step="0.05" aria-label="重排门槛" :value="config.rerank.passiveThreshold" @change="saveRerank({ passiveThreshold: Math.max(0.05, Math.min(0.95, Number(($event.target as HTMLInputElement).value) || 0.5)) })" />
      </SetRow>
      <SetRow v-else-if="config.rerank?.enabled" label="重排门槛" :off="!config.memory.passive.enabled">
        <template #hint>云端接口和插件的分数不是本机模型的尺度，要按它们的分数另定；空着就只按上面的相似度门槛</template>
        <input class="input set-num" type="number" inputmode="decimal" step="any" aria-label="重排门槛" placeholder="不用" :value="config.rerank.pluginPassiveThreshold ?? ''" @change="setOtherThreshold" />
      </SetRow>
    </SetCard>

    <SetCard v-if="config.memory" id="set-memory-quality" title="记忆质量" :keys="['memory', 'notes']">
      <template #help>新记忆写入前会先过一遍规则检查（免责式、超长（400 字以上）、转述原件、事件复述、无来源、重复），不合格的退回给模型并说明原因。之后每小时由复核模型逐条保留、改写或撤回；复核模型最好和写入的不是同一个，避免一个模型的习惯由它自己评判。结果在“记忆 → 质量”里按模型统计。</template>
      <SetRow label="复核新记忆" hint="只有复核保留或本人写的经验、偏好才会放进每次运行的提示里">
        <UiCheckbox :model-value="config.memory.review.enabled" switch aria-label="复核新记忆" @change="(v) => saveReview({ enabled: v })" />
      </SetRow>
      <SetRow label="复核用" block :off="!config.memory.review.enabled">
        <div class="pick3">
          <UiSelect :model-value="config.memory.review.profile ?? ''" size="sm" width="200px" aria-label="复核后端" :options="[{ value: '', label: '按角色“复核记忆”的设置' }, ...profileOptions]" @change="(v) => saveReview({ profile: v || undefined })" />
          <UiSelect :model-value="config.memory.review.model ?? ''" size="sm" width="180px" aria-label="复核模型" :options="modelOptionsFor(config.memory.review.profile, 'model', config.memory.review.model)" @change="(v) => saveReview({ model: v || undefined })" />
          <UiSelect :model-value="config.memory.review.effort ?? ''" size="sm" width="120px" aria-label="复核强度" :options="modelOptionsFor(config.memory.review.profile, 'effort', config.memory.review.effort, config.memory.review.model)" @change="(v) => saveReview({ effort: v || undefined })" />
        </div>
      </SetRow>
      <SetRow label="复核原件标注">
        <template #hint><HelpText>Agent 给原件加的标注先按一半的分量起作用；每小时由另一个模型对照原文和依据复核一批，保留的按八成分量起作用，撤回的不再起作用，拿不准的留给你；只有你自己确认的“有误”“不检索”才会把段落从检索结果里拿掉。复核用的模型在 Agent 页给 note-reviewer 选，最好和写标注的不是同一个。</HelpText></template>
        <UiCheckbox :model-value="config.notes.review.enabled" switch aria-label="复核原件标注" @change="(v) => saveNoteReview({ enabled: v })" />
      </SetRow>
      <SetRow label="每批标注数" hint="1–100" :off="!config.notes.review.enabled">
        <input class="input set-num" type="number" min="1" max="100" aria-label="每批标注数" :value="config.notes.review.batch" @change="(e) => saveNoteReview({ batch: intIn(e, 1, 100, 20) })" />
      </SetRow>
      <SetRow label="对比运行" block>
        <template #hint><HelpText>每次整理新材料时，再用下面的模型各跑一遍：它们的写入只记录不生效，经过同样的检查和复核，用来横向比较哪个模型记得更好。每多一个模型，整理的花费多一份。</HelpText></template>
        <div v-for="(c, i) in config.memory.compare" :key="i" class="cmp-row">
          <code class="small">{{ [c.profile, c.model, c.effort].filter(Boolean).join(" · ") }}</code>
          <button class="btn ghost sm icon" aria-label="移除" @click="removeCompare(i)"><Icon name="x" :size="14" /></button>
        </div>
        <div class="pick3">
          <UiSelect v-model="compareDraft.profile" size="sm" width="200px" aria-label="对比后端" placeholder="选择后端" :options="profileOptions" />
          <UiSelect v-if="(probes[compareDraft.profile]?.data?.models.length ?? 0) > 0" v-model="compareDraft.model" size="sm" width="180px" aria-label="对比模型" :options="modelOptionsFor(compareDraft.profile, 'model')" />
          <input v-else v-model="compareDraft.model" class="input sm" style="width: 160px" placeholder="模型（可选）" aria-label="对比模型" />
          <UiSelect v-if="effortsOf(compareDraft.profile, compareDraft.model || undefined).length" v-model="compareDraft.effort" size="sm" width="120px" aria-label="对比强度" :options="modelOptionsFor(compareDraft.profile, 'effort', undefined, compareDraft.model || undefined)" />
          <input v-else v-model="compareDraft.effort" class="input sm" style="width: 110px" placeholder="强度（可选）" aria-label="对比强度" />
          <button class="btn sm" :disabled="!compareDraft.profile" @click="addCompare">添加</button>
        </div>
      </SetRow>
    </SetCard>
  </div>
</template>

<style scoped>
.pick3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cmp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px 2px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.warn-text {
  color: var(--warn);
}
</style>
