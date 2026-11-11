<script setup lang="ts">
import { onMounted, ref } from "vue";
import { get, post } from "../api";
import { confirmDialog } from "../lib/dialog";
import { toast } from "../store";

/**
 * Whether one-to-one messages can go out as the owner through Doubao (src/channels/doubao-send.ts),
 * and the owner's test message to themselves. Shown under “经豆包发送” in 有人找你 and 私聊指令.
 */
type Status = { ready: boolean; reason: string; appId: string | null; appName: string | null; missing: string[]; note?: string };
type Test = { ok: boolean; outcome: string; line: string; raw?: string; sessionId: string | null };

const status = ref<Status | null>(null);
const loading = ref(true);
const testing = ref(false);
const result = ref<Test | null>(null);
let seq = 0;

async function load() {
  const n = ++seq;
  loading.value = true;
  try {
    const s = await get<Status>("/api/lark/doubao-send");
    if (n === seq) status.value = s;
  } catch (e) {
    if (n === seq) status.value = { ready: false, reason: (e as Error).message, appId: null, appName: null, missing: [] };
  } finally {
    if (n === seq) loading.value = false;
  }
}

async function test() {
  const ok = await confirmDialog("经豆包给自己发一条测试私聊？", { message: "会建一个豆包会话，让它以你的身份给你自己发一条带署名的测试消息，再用 lark-cli 读回来核对；会话用完就删。", okText: "发送" });
  if (!ok) return;
  testing.value = true;
  result.value = null;
  try {
    result.value = await post<Test>("/api/lark/doubao-send/test", {});
    toast(result.value.ok ? "测试消息已发出" : "测试没有成功", result.value.ok ? "ok" : "error");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="stack small">
    <div class="row wrap">
      <span v-if="loading" class="muted">正在检查豆包授权…</span>
      <template v-else-if="status">
        <span v-if="status.ready" class="badge ok">豆包可用{{ status.appName ? ` · ${status.appName}` : "" }}</span>
        <span v-else class="badge warn">豆包还不能用</span>
        <span v-if="!status.ready" class="muted">{{ status.reason }}</span>
      </template>
      <span class="spacer" />
      <button class="btn sm" :disabled="loading" @click="load">重新检查</button>
      <button class="btn sm" :disabled="loading || testing || !status?.ready" @click="test">{{ testing ? "发送中…" : "给自己发一条测试私聊" }}</button>
    </div>
    <p v-if="status?.note" class="muted">{{ status.note }}</p>
    <p v-if="result" :style="{ whiteSpace: 'pre-wrap', color: result.ok ? undefined : 'var(--danger)' }">{{ result.line }}</p>
  </div>
</template>
