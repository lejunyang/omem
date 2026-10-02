<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { OmBadge, OmButton, OmDisclosure } from "@omem/ui";
import { api } from "./api";
import { knowledgeApi } from "./knowledge/api";
import {
  materialRoles,
  materialRoleLabels,
  materialStatuses,
  materialStatusLabels,
  type MaterialDescription,
  type MaterialDescriptionRecord,
} from "../../../packages/contracts/src/material-description";
const props = withDefaults(
  defineProps<{ revisionId: string; current: boolean; prefix?: string }>(),
  { prefix: "/api/knowledge" },
);
const record = ref<MaterialDescriptionRecord | null>(null),
  draft = ref<MaterialDescription | null>(null);
const error = ref(""),
  busy = ref(false),
  saving = ref(false),
  editing = ref(false),
  loaded = ref(false);
let epoch = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
const empty = (): MaterialDescription => ({
  role: "unknown",
  status: "unknown",
  summary: "",
  topics: [],
  scope: null,
  validFrom: null,
  validUntil: null,
  concepts: [],
  basis: "",
});
const localTime = (value: string | null) =>
  value
    ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16)
    : "";
const isoTime = (event: Event) => {
  const value = (event.target as HTMLInputElement).value;
  return value ? new Date(value).toISOString() : null;
};
async function load(generation: number) {
  const result = await api<{ record: MaterialDescriptionRecord | null }>(
    "/material-descriptions/" + props.revisionId,
  );
  if (generation !== epoch) return;
  record.value = result.record;
  loaded.value = true;
}
async function poll(generation: number) {
  try {
    const run = await knowledgeApi<{
      state: string;
      revisionIds: string[];
      error?: string;
    } | null>(props.prefix, "/description-run");
    if (generation !== epoch) return;
    if (
      run?.revisionIds.includes(props.revisionId) &&
      run.state === "running"
    ) {
      busy.value = true;
      timer = setTimeout(() => void poll(generation), 2000);
      return;
    }
    await load(generation);
    if (generation !== epoch) return;
    busy.value = false;
    if (run?.revisionIds.includes(props.revisionId) && run.state === "failed")
      error.value = run.error || "分析未完成，可重试";
  } catch (e) {
    if (generation === epoch) {
      busy.value = false;
      error.value = String(e);
    }
  }
}
watch(
  () => props.revisionId,
  async () => {
    const generation = ++epoch;
    clearTimeout(timer);
    record.value = null;
    editing.value = false;
    draft.value = null;
    error.value = "";
    loaded.value = false;
    busy.value = false;
    try {
      await load(generation);
      if (generation === epoch) await poll(generation);
    } catch (e) {
      if (generation === epoch) error.value = String(e);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  epoch++;
  clearTimeout(timer);
});
async function analyze() {
  const generation = epoch;
  busy.value = true;
  error.value = "";
  try {
    await knowledgeApi(props.prefix, "/describe", {
      method: "POST",
      body: JSON.stringify({ revisionIds: [props.revisionId] }),
    });
    if (generation === epoch) await poll(generation);
  } catch (e) {
    if (generation === epoch) {
      busy.value = false;
      error.value = String(e);
    }
  }
}
function edit() {
  draft.value = JSON.parse(
    JSON.stringify(record.value?.description ?? empty()),
  );
  editing.value = true;
}
async function save() {
  const generation = epoch;
  saving.value = true;
  error.value = "";
  try {
    const result = await api<{ record: MaterialDescriptionRecord }>(
      "/material-descriptions/" + props.revisionId,
      { expectedVersion: record.value?.version ?? 0, description: draft.value },
      "PUT",
    );
    if (generation === epoch) {
      record.value = result.record;
      editing.value = false;
    }
  } catch (e) {
    if (generation === epoch) error.value = String(e);
  } finally {
    if (generation === epoch) saving.value = false;
  }
}
</script>
<template>
  <OmDisclosure class="material-description" title="材料用途与适用范围">
    <p v-if="!loaded && !error" role="status">正在读取材料说明…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="busy" role="status">
      AI 正在阅读原文并整理用途与概念入口，可以继续阅读材料。
    </p>
    <template v-if="record && !editing">
      <div class="description-actions">
        <OmBadge>{{ materialRoleLabels[record.description.role] }}</OmBadge
        ><OmBadge>{{ materialStatusLabels[record.description.status] }}</OmBadge
        ><small>{{
          record.author === "user" ? "已人工修正" : "AI 整理 · 可修正"
        }}</small>
      </div>
      <p>{{ record.description.summary }}</p>
      <p v-if="record.description.topics.length">
        主题：{{ record.description.topics.join("、") }}
      </p>
      <p v-if="record.description.scope">
        适用范围：{{ record.description.scope }}
      </p>
      <p v-if="record.description.validFrom || record.description.validUntil">
        适用时间：{{
          record.description.validFrom
            ? new Date(record.description.validFrom).toLocaleString()
            : "开始未注明"
        }}
        —
        {{
          record.description.validUntil
            ? new Date(record.description.validUntil).toLocaleString()
            : "结束未注明"
        }}
      </p>
      <p v-if="record.description.basis" class="muted">
        判断依据：{{ record.description.basis }}
      </p>
      <ul v-if="record.description.concepts.length" class="concepts">
        <li v-for="(c, i) in record.description.concepts" :key="i">
          <strong>{{ c.label }}</strong
          ><span v-if="c.aliases.length"> · {{ c.aliases.join("、") }}</span
          ><small>原文 {{ c.startLine }}–{{ c.endLine }} 行</small>
        </li>
      </ul>
    </template>
    <p v-else-if="loaded && !editing && !busy" class="muted">
      尚未整理这版材料的用途。可让 AI 阅读原文，也可以直接填写。
    </p>
    <form
      v-if="editing && draft"
      class="description-form"
      @submit.prevent="save"
    >
      <div class="description-fields">
        <label
          >主要用途<select v-model="draft.role">
            <option v-for="role in materialRoles" :key="role" :value="role">
              {{ materialRoleLabels[role] }}
            </option>
          </select></label
        ><label
          >适用状态<select v-model="draft.status">
            <option
              v-for="status in materialStatuses"
              :key="status"
              :value="status"
            >
              {{ materialStatusLabels[status] }}
            </option>
          </select></label
        >
      </div>
      <label
        >这份材料说明什么<textarea v-model="draft.summary" rows="3" />
      </label>
      <label
        >主题（用逗号分隔）<input
          :value="draft.topics.join('，')"
          @input="
            draft.topics = ($event.target as HTMLInputElement).value
              .split(/[,，]/)
              .map((s) => s.trim())
              .filter(Boolean)
          "
      /></label>
      <label
        >适用对象或场景<input
          :value="draft.scope ?? ''"
          @input="
            draft.scope = ($event.target as HTMLInputElement).value || null
          "
      /></label>
      <div class="description-fields">
        <label
          >开始生效（本地时间）<input
            type="datetime-local"
            :value="localTime(draft.validFrom)"
            @input="draft.validFrom = isoTime($event)" /></label
        ><label
          >结束适用（本地时间）<input
            type="datetime-local"
            :value="localTime(draft.validUntil)"
            @input="draft.validUntil = isoTime($event)"
        /></label>
      </div>
      <p class="muted">没有明确生效日期就留空。保存时间不代表生效时间。</p>
      <label>分类和状态的依据<textarea v-model="draft.basis" rows="2" /></label>
      <fieldset v-for="(c, i) in draft.concepts" :key="i">
        <legend>概念入口 {{ i + 1 }}</legend>
        <label>说明<input v-model="c.label" /></label
        ><label
          >常用别称<input
            :value="c.aliases.join('，')"
            @input="
              c.aliases = ($event.target as HTMLInputElement).value
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean)
            "
        /></label>
        <div class="description-fields">
          <label
            >原文开始行<input
              type="number"
              min="1"
              v-model.number="c.startLine" /></label
          ><label
            >原文结束行<input type="number" min="1" v-model.number="c.endLine"
          /></label>
        </div>
        <OmButton variant="ghost" @click="draft.concepts.splice(i, 1)"
          >移除此入口</OmButton
        >
      </fieldset>
      <OmButton
        variant="secondary"
        @click="
          draft.concepts.push({
            label: '',
            aliases: [],
            startLine: 1,
            endLine: 1,
          })
        "
        >添加概念入口</OmButton
      >
      <div class="description-actions">
        <OmButton type="submit" :loading="saving">保存修正</OmButton
        ><OmButton variant="ghost" @click="editing = false">取消</OmButton>
      </div>
    </form>
    <div v-else-if="loaded" class="description-actions">
      <OmButton variant="secondary" :disabled="busy" @click="edit">{{
        record ? "修正说明" : "填写说明"
      }}</OmButton
      ><OmButton
        v-if="current && record?.author !== 'user'"
        variant="ghost"
        :loading="busy"
        @click="analyze"
        >{{ record ? "AI 重新分析" : "让 AI 分析用途" }}</OmButton
      >
    </div>
    <p class="muted description-note">
      说明只用于阅读与检索；材料声明现行不等于已经核实为事实。原文换版后需要重新整理。
    </p>
  </OmDisclosure>
</template>
<style scoped>
.material-description {
  margin: 24px 0;
}
.description-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.description-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.description-form label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.description-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.description-form input,
.description-form select,
.description-form textarea {
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
}
.description-form fieldset {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--om-line);
  border-radius: 8px;
  padding: 16px;
  min-width: 0;
}
.concepts {
  padding-left: 20px;
}
.concepts li {
  margin: 12px 0;
}
.concepts small {
  display: block;
  color: var(--om-muted);
}
.description-note {
  font-size: 13px;
}
.error {
  color: var(--om-danger);
}
@media (max-width: 700px) {
  .description-fields {
    grid-template-columns: 1fr;
  }
}
</style>
