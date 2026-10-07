<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { OmButton, OmDisclosure } from "@omem/ui";
import { api } from "./api";
type Row = {
  id: string;
  target: string;
  title?: string;
  action: string;
  replace: boolean;
  state: string;
  error: string | null;
  result?: { summary?: string };
};
const rows = ref<Row[]>([]),
  error = ref("");
let stopped = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const actions: Record<string, string> = {
  parse: "解析原件",
  understand: "重新理解",
  describe: "重写用途",
  write: "重新写作",
  refresh: "读取新版",
  delete: "删除成果",
};
const states: Record<string, string> = {
  queued: "已排队",
  leased: "正在准备",
  running: "正在处理",
  retry_wait: "等待重试",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  awaiting_decision: "需要补充",
};
async function load() {
  clearTimeout(timer);
  try {
    const value = await api<Row[]>("/reprocessing");
    if (!stopped) {
      rows.value = value;
      error.value = "";
    }
  } catch (e) {
    if (!stopped) error.value = String(e);
  } finally {
    if (!stopped) timer = setTimeout(() => void load(), 3000);
  }
}
async function retry(row: Row) {
  try {
    await api("/reprocessing/" + row.id + "/retry", {});
    await load();
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
    v-if="rows.length || error"
    title="重新处理记录"
    :default-open="true"
    class="history"
    ><p v-if="error" class="error" role="alert">{{ error }}</p>
    <article v-for="row in rows.slice(0, 30)" :key="row.id">
      <h3>{{ row.title || "保存的材料" }}</h3>
      <p>
        {{ actions[row.action] }} · {{ states[row.state] ?? row.state
        }}<span v-if="row.replace"> · 删除替换旧成果</span>
      </p>
      <p
        v-if="
          row.result?.summary &&
          !['failed', 'cancelled', 'awaiting_decision'].includes(row.state)
        "
      >
        {{ row.result.summary }}
      </p>
      <details v-if="row.error" class="error">
        <summary>失败原因</summary>
        <p>{{ row.error }}</p>
      </details>
      <OmButton
        v-if="['failed', 'cancelled', 'awaiting_decision'].includes(row.state)"
        variant="secondary"
        @click="retry(row)"
        >重试失败阶段</OmButton
      >
    </article></OmDisclosure
  >
</template>
<style scoped>
.history {
  margin: 24px 0;
}
.history article {
  border-top: 1px solid var(--om-line);
  padding: 16px 0;
  display: grid;
  justify-items: start;
  gap: 12px;
}
.history p,
.history h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.history h3 {
  font-size: 16px;
}
.history details {
  max-width: 100%;
  min-width: 0;
}
.history summary {
  cursor: pointer;
}
.history details p {
  margin-top: 8px;
  font-size: 13px;
}
.error {
  color: var(--om-danger);
}
</style>
