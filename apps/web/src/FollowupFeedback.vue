<script setup lang="ts">
import { ref, watch } from "vue";
import { OmDialog, OmButton } from "@omem/ui";
import type { AttentionPolicy } from "../../../packages/contracts/src/work";
import { api } from "./api";
const props = defineProps<{
  open: boolean;
  title: string;
  target: string;
  kind: "message" | "requirement";
  version?: number;
  attention?: AttentionPolicy;
  mode?: "correction" | "attention";
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const text = ref(""),
  scope = ref("message"),
  focus = ref(""),
  ignore = ref(""),
  notifications = ref("important"),
  busy = ref(false),
  error = ref("");
let request: { id: string; body: string } | null = null;
watch(
  () => [props.open, props.target, props.mode],
  () => {
    if (!props.open) return;
    text.value = "";
    scope.value = "message";
    error.value = "";
    request = null;
    focus.value = props.attention?.focus.join("\n") ?? "";
    ignore.value = props.attention?.ignore.join("\n") ?? "";
    notifications.value = props.attention?.notifications ?? "important";
  },
  { immediate: true },
);
const lines = (value: string) =>
  value
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
async function save() {
  if (busy.value || (!text.value.trim() && props.mode !== "attention")) return;
  busy.value = true;
  error.value = "";
  const wording =
    props.mode === "attention"
      ? `重点关注：${lines(focus.value).join("、") || "暂无"}。暂不关注：${lines(ignore.value).join("、") || "暂无"}。${text.value.trim()}`
      : text.value.trim();
  const body = JSON.stringify({
    wording,
    scope: scope.value,
    focus: focus.value,
    ignore: ignore.value,
    notifications: notifications.value,
  });
  if (request?.body !== body) request = { id: crypto.randomUUID(), body };
  try {
    if (props.kind === "message")
      await api(
        `/integrations/lark-personal/inbox/${encodeURIComponent(props.target)}/feedback`,
        { requestId: request.id, text: wording, scope: scope.value },
      );
    else
      await api("/work/actions", {
        requestId: request.id,
        userText: wording,
        action: {
          operation: "feedback",
          key: props.target,
          expectedVersion: props.version,
          kind: props.mode ?? "correction",
          text: wording,
          ...(props.mode === "attention"
            ? {
                attention: {
                  focus: lines(focus.value),
                  ignore: lines(ignore.value),
                  notifications: notifications.value,
                },
              }
            : {}),
        },
      });
    emit("saved");
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <OmDialog
    :open="open"
    :title="mode === 'attention' ? '调整关注点' : '纠正助手的理解'"
    @close="!busy && emit('close')"
    @back="!busy && emit('close')"
  >
    <p class="subject">{{ title }}</p>
    <form id="followup-feedback" class="feedback-form" @submit.prevent="save">
      <template v-if="mode === 'attention'">
        <label
          >重点关注（每行一项）<textarea
            v-model="focus"
            rows="3"
            placeholder="上线阻塞&#10;负责人变化"
          />
        </label>
        <label
          >暂不关注（每行一项）<textarea
            v-model="ignore"
            rows="2"
            placeholder="重复报警&#10;与本期无关的设想"
          />
        </label>
        <label
          >通知频率<select v-model="notifications">
            <option value="important">重要进展或需要处理时</option>
            <option value="all">每次有变化时</option>
          </select></label
        >
      </template>
      <div v-else class="presets">
        <OmButton variant="secondary" @click="text = '这只是提议，还没有决定。'"
          >这是提议，尚未决定</OmButton
        >
        <OmButton
          variant="secondary"
          @click="text = '这里的负责人不对，实际负责人是：'"
          >负责人不对</OmButton
        >
        <OmButton
          v-if="kind === 'message'"
          variant="secondary"
          @click="
            text =
              '以后忽略这类重复报警；有人明确提出需要处理或提及我时仍要跟进。';
            scope = 'conversation';
          "
          >忽略这类重复报警</OmButton
        >
      </div>
      <label
        >{{ mode === "attention" ? "补充交代（可选）" : "正确理解应该是什么？"
        }}<textarea
          v-model="text"
          rows="4"
          :required="mode !== 'attention'"
          maxlength="2000"
          placeholder="说明哪一处不对，以及你希望怎样理解或跟进。"
        />
      </label>
      <label v-if="kind === 'message'"
        >应用范围<select v-model="scope">
          <option value="message">只针对这条消息</option>
          <option value="conversation">也用于这个会话后续消息</option>
        </select></label
      >
      <p class="muted">
        保存后会重新调查相关记忆与需求。旧结论会保留到更新完成；纠正不会直接启动编码或发送飞书消息。
      </p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
    </form>
    <template #actions
      ><OmButton variant="secondary" :disabled="busy" @click="emit('close')"
        >取消</OmButton
      ><OmButton type="submit" form="followup-feedback" :loading="busy"
        >保存并重新理解</OmButton
      ></template
    >
  </OmDialog>
</template>
<style scoped>
.subject {
  margin: 0 0 24px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.feedback-form {
  display: grid;
  gap: 24px;
}
label {
  display: grid;
  gap: 8px;
}
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  min-height: 44px;
  font: inherit;
  border: 1px solid var(--om-line);
  border-radius: 6px;
  background: var(--om-panel);
  color: var(--om-ink);
}
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.feedback-form p {
  margin: 0;
}
.error {
  color: var(--om-danger);
}
</style>
