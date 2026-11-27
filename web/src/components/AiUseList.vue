<script setup lang="ts">
import { computed, ref } from "vue";
import { aiRef, refText, type AiGroup, type AiPick, type PolicyBackend } from "../lib/ai-policy";
import type { Probe } from "../lib/probes";
import AiPickRow from "./AiPickRow.vue";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";

/**
 * What a rule may use, in order: AI groups and single AIs, one per line, moved up or taken out. A
 * group is added from the list of groups, an AI with the backend · model · effort dropdowns. `marks`:
 * a line another rule leaves out, said beside it.
 */
type Backend = { id: string; name?: string; installed: boolean; transport?: string; model?: string; effort?: string; canProbe?: boolean; probe?: Probe | null };
const props = defineProps<{ modelValue: string[]; groups: AiGroup[]; policy: PolicyBackend[]; backends: Backend[]; marks?: Record<string, string>; emptyText?: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const adding = ref(false);
const ai = ref<AiPick>({ profile: "" });
const groupOptions = computed(() => props.groups.filter((g) => !props.modelValue.includes(g.id)).map((g) => ({ value: g.id, label: g.name, hint: g.items.length ? `${g.items.length} 个 AI` : "还是空的" })));
const count = (ref: string) => (ref.startsWith("ai:") ? "" : `${props.groups.find((g) => g.id === ref)?.items.length ?? 0} 个`);
function move(i: number) {
  const list = [...props.modelValue];
  [list[i - 1], list[i]] = [list[i], list[i - 1]];
  emit("update:modelValue", list);
}
const remove = (i: number) => emit("update:modelValue", props.modelValue.filter((_, j) => j !== i));
function addGroup(id: string | null) {
  if (id && !props.modelValue.includes(id)) emit("update:modelValue", [...props.modelValue, id]);
}
function addAi() {
  if (!ai.value.profile) return;
  const r = aiRef(ai.value);
  if (!props.modelValue.includes(r)) emit("update:modelValue", [...props.modelValue, r]);
  ai.value = { profile: "" };
  adding.value = false;
}
</script>

<template>
  <div class="use-list">
    <ol v-if="modelValue.length" class="use-rows">
      <li v-for="(r, i) in modelValue" :key="r" class="use-row">
        <span class="use-n">{{ i + 1 }}</span>
        <span class="use-name">
          <span class="ellipsis" :title="refText(r, groups, policy)">{{ refText(r, groups, policy) }}</span>
          <span v-if="!r.startsWith('ai:')" class="badge">组 · {{ count(r) }}</span>
          <span v-if="marks?.[r]" class="small warn-text use-mark" :title="marks[r]">{{ marks[r] }}</span>
        </span>
        <span class="use-tools">
          <button class="btn ghost sm icon" :disabled="i === 0" :aria-label="`上移 ${refText(r, groups, policy)}`" title="上移" @click="move(i)"><Icon name="down" :size="14" class="up" /></button>
          <button class="btn ghost sm icon" :aria-label="`去掉 ${refText(r, groups, policy)}`" title="去掉" @click="remove(i)"><Icon name="x" :size="14" /></button>
        </span>
      </li>
    </ol>
    <p v-else class="small muted">{{ emptyText ?? "不限：全部 AI 都能用" }}</p>
    <div v-if="adding" class="use-add">
      <AiPickRow v-model="ai" class="grow" :backends="backends" :policy="policy" label="要用的 AI" />
      <button class="btn sm" :disabled="!ai.profile" @click="addAi">加上</button>
      <button class="btn ghost sm" @click="adding = false">取消</button>
    </div>
    <div v-else class="use-add">
      <UiSelect v-if="groupOptions.length" :model-value="null" size="sm" width="132px" placeholder="＋ 组" :options="groupOptions" aria-label="加一个组" @change="addGroup" />
      <button class="btn ghost sm" @click="adding = true"><Icon name="plus" :size="13" />具体 AI</button>
    </div>
  </div>
</template>

<style scoped>
.use-list {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.use-list > p {
  margin: 0;
}
.use-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  min-width: 0;
}
.use-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--line);
  min-width: 0;
  font-size: 14px;
}
.use-n {
  color: var(--muted);
  font-size: 12px;
  text-align: right;
}
.use-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
}
.use-name > .ellipsis {
  flex: 0 1 auto;
  min-width: 0;
}
.use-mark {
  flex: 1 1 100%;
}
.use-tools {
  display: flex;
  gap: 2px;
}
.up {
  transform: rotate(180deg);
}
.use-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.grow {
  flex: 1 1 320px;
  min-width: 0;
}
</style>
