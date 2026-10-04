<script setup lang="ts">
import { ref, watch } from "vue";
import { OmButton, OmDisclosure } from "@omem/ui";
import ContextPicker from "./ContextPicker.vue";
import { api } from "./api";
const props = defineProps<{ sourceId: string }>();
const selected = ref<string[]>([]), loaded = ref(false), saving = ref(false), message = ref(""), error = ref("");
watch(() => props.sourceId, async id => {
  loaded.value = false; message.value = ""; error.value = "";
  try {
    const result = await api<{ contextIds: string[] }>(`/sources/${encodeURIComponent(id)}/contexts`);
    if (id !== props.sourceId) return;
    selected.value = result.contextIds; loaded.value = true;
  } catch (e) { if (id === props.sourceId) error.value = String(e); }
}, { immediate: true });
async function save() {
  saving.value = true; error.value = ""; message.value = "";
  try {
    await api(`/sources/${encodeURIComponent(props.sourceId)}/contexts`, { contextIds: selected.value }, "PUT");
    message.value = "归属已保存，跟踪这些项目或主题的文章会按更新设置重新整理。";
  } catch (e) { error.value = String(e); }
  finally { saving.value = false; }
}
</script>
<template>
  <OmDisclosure class="source-contexts" title="所属项目与主题">
    <p>归属适用于这份材料的所有版本。调整归属不会删除原文或历史引用。</p>
    <ContextPicker v-if="loaded" v-model="selected" :disabled="saving" />
    <p v-else-if="!error" role="status">正在读取材料归属…</p>
    <OmButton v-if="loaded" type="button" variant="secondary" :loading="saving" @click="save">保存归属</OmButton>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </OmDisclosure>
</template>
<style scoped>
.source-contexts { margin: 16px 0; }
.source-contexts p { font-size: 14px; color: var(--om-secondary); }
.source-contexts button { margin-top: 16px; }
.source-contexts .error { color: var(--om-danger); }
</style>
