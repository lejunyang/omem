<script setup lang="ts">
import { ref } from "vue";
import { OmButton } from "@omem/ui";
import { api, type Task } from "./api";
const props = defineProps<{ task: Task }>();
const emit = defineEmits<{ refresh: []; error: [message: string] }>();
const expanded = ref(false), busy = ref(false), waitingOn = ref(""), when = ref("");
async function command(action: "wait" | "snooze" | "cancel") {
  if (busy.value) return;
  if (action === "wait" && !waitingOn.value.trim()) { emit("error", "请填写等待谁或什么结果"); return; }
  if (action === "snooze" && !when.value) { emit("error", "请设置下次跟进时间"); return; }
  busy.value = true;
  try {
    const instant = when.value ? new Date(when.value).toISOString() : null;
    await api(`/tasks/${props.task.id}/commands`, { action, expectedVersion: props.task.version, requestId: crypto.randomUUID(),
      followUp: action === "cancel" ? null : { waiting_on: action === "wait" ? waitingOn.value.trim() : null,
        next_check_at: instant, snoozed_until: action === "snooze" ? instant : null,
        time_expression: when.value || null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    expanded.value = false; emit("refresh");
  } catch (error) { emit("error", String(error)); }
  finally { busy.value = false; }
}
</script>
<template>
  <div v-if="task.status === 'open' || task.status === 'waiting'">
    <OmButton variant="ghost" :aria-expanded="expanded" @click="expanded = !expanded">跟进设置</OmButton>
    <form v-if="expanded" class="form" @submit.prevent="command('wait')">
      <label>等待对象或结果<input v-model="waitingOn" placeholder="例如：张三的评审回复" /></label>
      <label>下次跟进时间<input v-model="when" type="datetime-local" /></label>
      <small>跟进时间不改变截止时间；不会自动联系对方。未设置时间时只记录等待。</small>
      <div class="follow-up-actions">
        <OmButton type="submit" :disabled="busy">记录等待</OmButton>
        <OmButton :disabled="busy" @click="command('snooze')">稍后提醒</OmButton>
        <OmButton :disabled="busy" @click="command('cancel')">取消事项</OmButton>
      </div>
    </form>
  </div>
</template>
<style scoped>
.follow-up-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
