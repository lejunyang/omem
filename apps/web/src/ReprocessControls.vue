<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { OmButton, OmDialog, OmSelect, OmCheckbox } from "@omem/ui";
import { api } from "./api";
type Action =
  | "parse"
  | "understand"
  | "describe"
  | "refresh"
  | "write"
  | "delete";
const props = defineProps<{
  target: "source" | "article" | "document" | "message" | "bot-event";
  targetId: string;
  title: string;
  actions: Action[];
}>();
const emit = defineEmits<{ updated: [] }>();
const open = ref(false),
  busy = ref(false),
  error = ref("");
const action = ref<Action>(props.actions[0] ?? "understand"),
  replace = ref(true);
const record = ref<{
  id: string;
  state: string;
  error: string | null;
  result?: { summary?: string; cleared?: unknown };
} | null>(null);
const labels: Record<Action, string> = {
  parse: "重新解析保存的原文件",
  understand: "重新理解，整理记忆与事项",
  describe: "重写材料用途与概念说明",
  refresh: "从来源读取最新版",
  write: "重新调查并撰写文章",
  delete: "只删除旧成果，保留原件",
};
const states: Record<string, string> = {
  queued: "已排队",
  leased: "正在准备",
  running: "正在处理",
  retry_wait: "等待重试",
  succeeded: "处理完成",
  failed: "处理失败",
  cancelled: "已取消",
  awaiting_decision: "需要补充信息",
};
let timer: ReturnType<typeof setTimeout> | undefined;
let epoch = 0;
let reportedClear = false;
watch(
  () => props.targetId,
  () => {
    epoch++;
    clearTimeout(timer);
    record.value = null;
    error.value = "";
    busy.value = false;
    open.value = false;
    action.value = props.actions[0] ?? "understand";
  },
);
onBeforeUnmount(() => {
  epoch++;
  clearTimeout(timer);
});
async function poll(id: string, generation: number) {
  try {
    const value = await api<NonNullable<typeof record.value>>(
      "/reprocessing/" + encodeURIComponent(id),
    );
    if (generation !== epoch) return;
    record.value = value;
    if (value.result?.cleared && !reportedClear) {
      reportedClear = true;
      emit("updated");
    }
    if (["queued", "leased", "running", "retry_wait"].includes(value.state))
      timer = setTimeout(() => void poll(id, generation), 1500);
    else {
      busy.value = false;
      if (value.state === "succeeded") emit("updated");
    }
  } catch (e) {
    if (generation === epoch) {
      error.value = String(e);
      busy.value = false;
    }
  }
}
async function submit() {
  const generation = epoch;
  busy.value = true;
  error.value = "";
  reportedClear = false;
  try {
    record.value = await api("/reprocessing", {
      requestId: crypto.randomUUID(),
      target: props.target,
      targetId: props.targetId,
      action: action.value,
      replace: replace.value,
    });
    open.value = false;
    await poll(record.value!.id, generation);
  } catch (e) {
    if (generation === epoch) {
      error.value = String(e);
      busy.value = false;
    }
  }
}
</script>
<template>
  <section class="reprocess" aria-label="重新处理">
    <OmButton variant="secondary" :disabled="busy" @click="open = true"
      >重新处理</OmButton
    >
    <p v-if="record" role="status">
      {{ states[record.state] ?? record.state
      }}<span
        v-if="
          record.result?.summary &&
          !['failed', 'cancelled', 'awaiting_decision'].includes(record.state)
        "
      >
        · {{ record.result.summary }}</span
      >
    </p>
    <p v-if="record?.error || error" class="error" role="alert">
      {{ record?.error || error }}
    </p>
    <OmDialog
      :open="open"
      title="重新处理材料"
      @close="open = false"
      @back="open = false"
    >
      <form class="reprocess-form" @submit.prevent="submit">
        <p>{{ title }}</p>
        <label class="processing-mode"
          >处理方式<OmSelect v-model="action"
            ><option v-for="item in actions" :key="item" :value="item">
              {{ labels[item] }}
            </option></OmSelect
          ></label
        >
        <p v-if="action === 'refresh'" class="muted">
          会访问来源读取当前内容。这与使用本机已保存的原件重新生成不同。
        </p>
        <p v-else-if="action === 'parse'" class="muted">
          使用本机保存的文件，重新提取正文、表格和图片。不会重新下载原文件。
        </p>
        <p v-else-if="action === 'delete'" class="muted">
          删除这个对象的派生成果与对应检索内容，保留原件。人工调整的记忆和事项会保留。
        </p>
        <p v-else class="muted">
          使用已保存材料和当前 Agent 设置重新生成，不需要重新拉取来源。
        </p>
        <OmCheckbox v-if="action !== 'delete'" v-model="replace"
          >删除旧成果后重新生成</OmCheckbox
        >
        <p v-if="action !== 'delete'" class="muted">
          {{
            replace
              ? "旧成果及其正文历史将被清除；如果本次生成失败，可以用保存的原件重试。"
              : "生成过程中保留旧成果；完成后使用新结果。"
          }}
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="actions">
          <OmButton type="button" variant="ghost" @click="open = false"
            >取消</OmButton
          ><OmButton type="submit" variant="primary" :loading="busy">{{
            action === "delete" ? "删除成果" : "开始处理"
          }}</OmButton>
        </div>
      </form>
    </OmDialog>
  </section>
</template>
<style scoped>
.reprocess {
  display: grid;
  justify-items: start;
  gap: 12px;
  margin: 16px 0;
  font-size: 14px;
}
.reprocess p {
  margin: 0;
  overflow-wrap: anywhere;
}
.reprocess-form {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.processing-mode {
  display: grid;
  gap: 8px;
}
.actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.muted {
  color: var(--om-secondary);
  font-size: 14px;
}
.error {
  color: var(--om-danger);
}
</style>
