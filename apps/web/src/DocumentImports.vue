<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { OmDisclosure, OmButton } from "@omem/ui";
import { api, headers } from "./api";
import ReprocessControls from "./ReprocessControls.vue";
type Item = {
  id: string;
  name: string;
  state: string;
  error: string | null;
  revisionId: string | null;
  createdAt: string;
};
const emit = defineEmits<{ open: [id: string] }>();
const items = ref<Item[]>([]),
  error = ref("");
let timer: ReturnType<typeof setTimeout> | undefined,
  stopped = false;
const labels: Record<string, string> = {
  saved: "原件已保存",
  queued: "等待解析",
  running: "正在解析",
  leased: "正在准备",
  retry_wait: "等待重试",
  failed: "解析失败，原件仍保留",
  parsed: "解析完成",
  cancelled: "已取消",
};
async function load() {
  clearTimeout(timer);
  try {
    const result = await api<Item[]>("/document-imports");
    if (!stopped) {
      items.value = result;
      error.value = "";
    }
  } catch (e) {
    if (!stopped) error.value = String(e);
  } finally {
    if (!stopped) timer = setTimeout(() => void load(), 3000);
  }
}
async function download(item: Item) {
  try {
    const r = await fetch(
      "/api/document-imports/" + encodeURIComponent(item.id) + "/original",
      { headers: headers() },
    );
    if (!r.ok) throw Error("原件读取失败");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    error.value = String(e);
  }
}
onMounted(() => void load());
onBeforeUnmount(() => {
  stopped = true;
  clearTimeout(timer);
});
</script>
<template>
  <OmDisclosure
    v-if="items.length || error"
    title="文档导入记录"
    :default-open="true"
    class="imports"
  >
    <p class="muted">
      原文件上传后即保存。解析失败或服务重启后，可以继续处理，不必重新上传。
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <article v-for="item in items" :key="item.id">
      <h3>{{ item.name }}</h3>
      <p>{{ labels[item.state] ?? item.state }}</p>
      <p v-if="item.error" class="error">{{ item.error }}</p>
      <div class="actions">
        <OmButton
          v-if="item.revisionId"
          variant="secondary"
          @click="emit('open', item.revisionId)"
          >阅读材料</OmButton
        ><OmButton variant="ghost" @click="download(item)"
          >下载保存的原件</OmButton
        >
      </div>
      <ReprocessControls
        target="document"
        :target-id="item.id"
        :title="item.name"
        :actions="['parse']"
      />
    </article>
  </OmDisclosure>
</template>
<style scoped>
.imports {
  margin-top: 32px;
}
.imports article {
  min-width: 0;
  padding: 20px 0;
  border-top: 1px solid var(--om-line);
  display: grid;
  gap: 12px;
}
.imports h3,
.imports p {
  margin: 0;
  overflow-wrap: anywhere;
  max-width: 100%;
}
.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.muted {
  font-size: 14px;
  color: var(--om-secondary);
}
.error {
  color: var(--om-danger);
}
</style>
