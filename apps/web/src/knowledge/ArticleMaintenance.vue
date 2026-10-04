<script setup lang="ts">
import { ref } from "vue";
import { OmButton } from "@omem/ui";
import type { PageMaintenanceStatus } from "../../../../packages/contracts/src/knowledge";
import { knowledgeApi } from "./api";
const props = defineProps<{
  prefix: string;
  documentKey: string;
  selectedCount: number;
  contexts?: string[];
  status?: PageMaintenanceStatus | null;
}>();
const emit = defineEmits<{ updated: []; retry: [] }>();
const saving = ref(false), error = ref("");
async function toggle(event: Event) {
  const input = event.target as HTMLInputElement;
  const enabled = input.checked;
  saving.value = true;
  error.value = "";
  try {
    await knowledgeApi(props.prefix, `/pages/${encodeURIComponent(props.documentKey)}/maintenance`, {
      method: "PUT", body: JSON.stringify({ enabled }),
    });
    emit("updated");
  } catch (e) {
    input.checked = !!props.status?.enabled;
    error.value = e instanceof Error ? e.message : "更新方式未保存，请重试";
  } finally { saving.value = false; }
}
</script>
<template>
  <section class="article-maintenance" aria-label="文章更新方式">
    <label>
      <input type="checkbox" :checked="status?.enabled" :disabled="saving || (!status?.enabled && !selectedCount && !contexts?.length)" @change="toggle" />
      <strong>随所选材料自动更新</strong>
    </label>
    <p v-if="contexts?.length">持续跟踪 {{ contexts.join('、') }} 中的材料<span v-if="selectedCount">，以及另选的 {{ selectedCount }} 项背景材料</span>。新增、移出或更新材料后，AI 会重新整理并复核；期间仍可阅读旧版。</p>
    <p v-else-if="selectedCount">跟踪已选的 {{ selectedCount }} 项材料。材料有变化时，AI 会更新并复核这篇文章；期间仍可阅读旧版。新增材料请通过“调整材料与目标”加入。</p>
    <p v-else>先通过“调整材料与目标”明确选材，再开启持续更新。</p>
    <p v-if="saving" role="status">正在保存更新方式…</p>
    <p v-else-if="status?.state === 'queued'" role="status">更新已排队，将按最新材料整理。</p>
    <p v-else-if="status?.state === 'writing'" role="status">正在调查变化、更新正文并独立复核。</p>
    <div v-else-if="status?.state === 'failed'" class="update-failed" role="status">
      <p>本次更新未完成，旧文章已保留。{{ status.error?.includes('timed out') ? 'AI 处理超时。' : status.error }}</p>
      <OmButton variant="secondary" @click="emit('retry')">重试更新</OmButton>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.article-maintenance { border-top: 1px solid var(--om-line); margin-top: 32px; padding-top: 24px; max-width: 76ch; }
.article-maintenance label { display: flex; flex-direction: row; justify-content: flex-start; align-items: center; gap: 12px; min-height: 44px; font-size: 16px; cursor: pointer; }
.article-maintenance input { width: 18px; height: 18px; flex: 0 0 18px; padding: 0; margin: 0; accent-color: var(--om-ink); }
.article-maintenance p { color: var(--om-secondary); font-size: 14px; line-height: 1.8; margin: 8px 0 0; }
.update-failed { display: grid; justify-items: start; gap: 12px; }
.error { color: var(--om-danger); }
</style>
