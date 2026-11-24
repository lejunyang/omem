<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { toast } from "../store";

/**
 * Rules that asked to work as this person (src/rules/run-as.ts): what each one does, whether they
 * agreed, and a button to agree or withdraw. Shown on one's own account page only when there are any.
 */
type Entry = { ruleId: string; name: string; description: string; status: "pending" | "granted" | "declined" | "revoked" | "unavailable" };
const list = ref<Entry[]>([]);
const busy = ref(false);
const LABEL: Record<Entry["status"], string> = { pending: "等你回答", granted: "已同意", declined: "没同意", revoked: "已撤回", unavailable: "用不了" };

async function decide(e: Entry, grant: boolean) {
  busy.value = true;
  try {
    list.value = await post<Entry[]>(`/api/me/run-as/${e.ruleId}`, { grant });
    toast(grant ? "已同意" : e.status === "granted" ? "已撤回，这条规则不再用你的身份" : "已拒绝", "ok");
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  list.value = await get<Entry[]>("/api/me/run-as").catch(() => []);
});
</script>

<template>
  <template v-if="list.length">
    <h2 class="section-title">规则用你的身份</h2>
    <p class="muted small">这些规则想在运行时用你的身份：插件登记过的命令行（比如研发平台的）用你的登录跑，以你的身份读飞书，每次都记在运行里。同意后随时可以撤回。</p>
    <div v-for="e in list" :key="e.ruleId" class="card pad row wrap item">
      <div class="stack tight grow">
        <span>「{{ e.name }}」<span class="badge" :class="{ ok: e.status === 'granted' }">{{ LABEL[e.status] }}</span></span>
        <span class="muted small">{{ e.description }}</span>
      </div>
      <button v-if="e.status !== 'granted'" class="btn sm" :disabled="busy" @click="decide(e, true)">同意</button>
      <button v-if="e.status === 'granted' || e.status === 'pending'" class="btn ghost sm" :disabled="busy" @click="decide(e, false)">{{ e.status === "granted" ? "撤回" : "不同意" }}</button>
    </div>
  </template>
</template>

<style scoped>
.item {
  gap: 8px;
  align-items: center;
}
.grow {
  flex: 1;
  min-width: 0;
}
</style>
