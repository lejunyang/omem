<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { del, get, put } from "../api";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, toast } from "../store";
import { confirmDialog } from "../lib/dialog";

/**
 * Read-only share links (src/core/shares.ts): what Feishu answers cite, copied when they are sent.
 * The token is not kept, so a link cannot be shown again here; it can be revoked.
 */
type Share = { id: string; runId: string | null; messageId: string | null; origin: string; title: string; labels: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; expired: boolean; views: number; viewedAt: string | null };

const shares = ref<Share[] | null>(null);
const webUrl = ref(true);
const expiry = ref(0);
const filter = ref<string>("live");
const shown = computed(() => (shares.value ?? []).filter((s) => filter.value === "all" || (!s.revokedAt && !s.expired)));
const EXPIRY = [
  { value: "0", label: "长期有效" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "一年" },
];

async function load() {
  const r = await get<{ shares: Share[]; webUrl: boolean; expiryDays: number }>("/api/shares");
  shares.value = r.shares;
  webUrl.value = r.webUrl;
  expiry.value = r.expiryDays;
}
async function saveExpiry(v: string) {
  try {
    await put("/api/settings", { shares: { expiryDays: Number(v) } });
    expiry.value = Number(v);
    toast("已保存，之后新建的分享按这个有效期", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function revoke(s: Share) {
  if (!(await confirmDialog("撤销这个分享？", { message: "链接会立刻打不开，复制的内容一并删除。飞书里那条消息的引用随之失效。", okText: "撤销", danger: true }))) return;
  try {
    await del(`/api/shares/${s.id}`);
    await load();
    toast("已撤销", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const status = (s: Share) => (s.revokedAt ? "已撤销" : s.expired ? "已过期" : s.expiresAt ? `${fmtTime(s.expiresAt, false)} 失效` : "长期有效");
onMounted(() => load().catch((e) => toast((e as Error).message, "error")));
</script>

<template>
  <div class="stack">
    <p class="muted">飞书里的回答引用了 omem 自己的东西（代码、工作文件、记忆、Wiki）时，发送那一刻会把被引的部分复制成一个只读分享，回答里的 ①② 链接打开它。打开不用令牌，只能看到那条消息引用的部分；文档和飞书消息直接链到原处，不经过这里。</p>
    <div v-if="!webUrl" class="card pad warn-box">还没有填“网页地址”（设置 → 渠道）：没有地址就不生成分享，回答里这类引用会直接省略。</div>
    <div class="field"><span>新分享的有效期</span><UiSelect :model-value="String(expiry)" width="200px" aria-label="新分享的有效期" :options="EXPIRY" @change="saveExpiry" /></div>
    <div class="row wrap">
      <strong>分享链接</strong><span class="spacer" />
      <UiSegmented v-model="filter" size="sm" aria-label="显示哪些" :options="[{ value: 'live', label: '有效的' }, { value: 'all', label: '全部' }]" />
    </div>
    <Skeleton v-if="!shares" variant="text" :rows="4" />
    <div v-else-if="!shown.length" class="card pad muted">{{ filter === "live" ? "没有有效的分享。" : "还没有分享。" }}飞书里的回答引用了代码、工作文件、记忆或 Wiki 时会自动生成。</div>
    <div v-else class="list">
      <div v-for="s in shown" :key="s.id" class="card pad share" :class="{ dead: s.revokedAt || s.expired }">
        <div class="row wrap head">
          <strong class="title">{{ s.title || "（无标题）" }}</strong>
          <span class="spacer" />
          <span class="badge" :class="{ danger: s.revokedAt, warn: s.expired && !s.revokedAt }">{{ status(s) }}</span>
          <button v-if="!s.revokedAt && !s.expired" class="btn ghost sm danger" @click="revoke(s)">撤销</button>
        </div>
        <div class="muted small meta">
          <span>{{ fmtTime(s.createdAt) }}</span>
          <span v-if="s.origin">{{ s.origin }}</span>
          <a v-if="s.runId" :href="`#/runs/${s.runId}`">运行 {{ s.runId }}</a>
          <span>打开 {{ s.views }} 次{{ s.viewedAt ? `，最近 ${fmtTime(s.viewedAt)}` : "" }}</span>
        </div>
        <div v-if="s.labels.length" class="small labels">引用：{{ s.labels.join("、") }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.share {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.share.dead {
  opacity: 0.7;
}
.head {
  gap: 8px;
  min-width: 0;
}
.title {
  min-width: 0;
  overflow-wrap: anywhere;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
}
.meta > * {
  overflow-wrap: anywhere;
  min-width: 0;
}
.labels {
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.warn-box {
  background: var(--warn-soft);
  color: var(--warn);
}
</style>
