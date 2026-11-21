<script setup lang="ts">
import HelpText from "./HelpText.vue";
import { computed, onMounted, ref } from "vue";
import { del, get, put } from "../api";
import Icon from "./Icon.vue";
import SetCard from "./SetCard.vue";
import SetRow from "./SetRow.vue";
import Skeleton from "./Skeleton.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";
import { fmtTime, toast } from "../store";
import { toWallDate } from "../lib/time";
import { confirmDialog } from "../lib/dialog";

/**
 * Read-only share links (src/core/shares.ts): what Feishu answers cite, copied when they are sent.
 * The token is not kept, so a link cannot be shown again here; it can be revoked. One row per share,
 * by month, the live ones by default, searchable.
 */
type Share = { id: string; runId: string | null; messageId: string | null; origin: string; title: string; labels: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; expired: boolean; views: number; viewedAt: string | null };

const shares = ref<Share[] | null>(null);
const failed = ref("");
const webUrl = ref(true);
const expiry = ref(0);
const filter = ref<string>("live");
const query = ref("");
const PAGE = 30;
const limit = ref(PAGE);
const dead = (s: Share) => !!s.revokedAt || s.expired;
const matched = computed(() => {
  const q = query.value.trim().toLowerCase();
  return (shares.value ?? [])
    .filter((s) => filter.value === "all" || !dead(s))
    .filter((s) => !q || `${s.title} ${s.origin} ${s.labels.join(" ")}`.toLowerCase().includes(q));
});
/** The shown rows by month, newest first. */
const months = computed(() => {
  const out: { key: string; label: string; rows: Share[] }[] = [];
  for (const s of matched.value.slice(0, limit.value)) {
    const d = toWallDate(new Date(s.createdAt));
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    let g = out.find((x) => x.key === key);
    if (!g) out.push((g = { key, label: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`, rows: [] }));
    g.rows.push(s);
  }
  return out;
});
const EXPIRY = [
  { value: "0", label: "长期有效" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "一年" },
];

async function load() {
  failed.value = "";
  try {
    const r = await get<{ shares: Share[]; webUrl: boolean; expiryDays: number }>("/api/shares");
    shares.value = r.shares;
    webUrl.value = r.webUrl;
    expiry.value = r.expiryDays;
  } catch (e) {
    failed.value = (e as Error).message;
  }
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
const day = (iso: string) => {
  const d = toWallDate(new Date(iso));
  const thisYear = d.getFullYear() === toWallDate(new Date()).getFullYear();
  return `${thisYear ? "" : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}`;
};
const status = (s: Share) => (s.revokedAt ? "已撤销" : s.expired ? "已过期" : s.expiresAt ? `${day(s.expiresAt)} 失效` : "长期有效");
onMounted(load);
</script>

<template>
  <div class="stack">
    <HelpText lead>飞书里的回答引用了 omem 自己的东西（代码、工作文件、记忆、Wiki）时，发送那一刻会把被引的部分复制成一个只读分享，回答里的 (1) (2) 链接打开它。打开不用令牌，只能看到那条消息引用的部分；文档和飞书消息直接链到原处，不经过这里。</HelpText>
    <div v-if="!webUrl" class="card set-link warn-box">还没有填网页地址：没有地址就不生成分享，回答里这类引用会直接省略。<RouterLink :to="{ path: '/settings', query: { card: 'web-url' } }">去设备页填</RouterLink></div>
    <SetCard title="有效期" :keys="['shares.expiryDays']">
      <SetRow label="新分享的有效期" hint="只影响之后新建的分享">
        <UiSelect :model-value="String(expiry)" size="sm" width="140px" aria-label="新分享的有效期" :options="EXPIRY" @change="saveExpiry" />
      </SetRow>
    </SetCard>
    <SetCard title="分享链接">
      <template #aside><span v-if="shares" class="muted small">{{ matched.length }} 条</span></template>
      <div class="set-pad tools">
        <label class="search"><Icon name="search" :size="13" /><input v-model="query" placeholder="按标题、来源、引用筛选" aria-label="筛选分享" @input="limit = PAGE" /></label>
        <UiSegmented v-model="filter" size="sm" aria-label="显示哪些" :options="[{ value: 'live', label: '有效的' }, { value: 'all', label: '全部' }]" @change="limit = PAGE" />
      </div>
      <div v-if="failed" class="set-pad" role="alert"><span class="small">读不到分享：{{ failed }}</span><button class="btn sm" @click="load">重试</button></div>
      <Skeleton v-else-if="!shares" variant="list" :rows="5" />
      <p v-else-if="!matched.length" class="set-pad muted small">{{ query.trim() ? "没有匹配的分享。" : filter === "live" ? "没有有效的分享。" : "还没有分享。" }}飞书里的回答引用了代码、工作文件、记忆或 Wiki 时会自动生成。</p>
      <template v-else>
        <section v-for="m in months" :key="m.key" class="month">
          <h4 class="month-head">{{ m.label }}<span class="muted"> · {{ m.rows.length }}</span></h4>
          <div v-for="s in m.rows" :key="s.id" class="share" :class="{ dead: dead(s) }">
            <span class="sh-day">{{ day(s.createdAt) }}</span>
            <span class="sh-main">
              <span class="sh-title ellipsis" :title="s.title || '（无标题）'">{{ s.title || "（无标题）" }}</span>
              <span class="sh-meta ellipsis" :title="[s.origin, s.labels.length ? `引用：${s.labels.join('、')}` : ''].filter(Boolean).join(' · ')">
                <template v-if="s.origin">{{ s.origin }}</template><template v-if="s.origin && s.labels.length"> · </template><template v-if="s.labels.length">引用 {{ s.labels.length }} 处</template>
                · 打开 {{ s.views }} 次<template v-if="s.runId"> · <a :href="`#/runs/${s.runId}`" @click.stop>运行</a></template>
              </span>
            </span>
            <span class="sh-status" :class="{ danger: s.revokedAt, warn: s.expired && !s.revokedAt }" :title="s.expiresAt ? fmtTime(s.expiresAt) : ''">{{ status(s) }}</span>
            <span class="sh-op"><button v-if="!dead(s)" class="btn ghost sm" :aria-label="`撤销 ${s.title}`" @click="revoke(s)">撤销</button></span>
          </div>
        </section>
        <div v-if="matched.length > limit" class="set-pad"><button class="btn ghost sm" @click="limit += PAGE">再看 {{ Math.min(PAGE, matched.length - limit) }} 条（还有 {{ matched.length - limit }} 条）</button></div>
      </template>
    </SetCard>
  </div>
</template>

<style scoped>
.warn-box {
  background: var(--warn-soft);
  color: var(--warn);
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.search {
  flex: 1 1 200px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--ink);
}
.search input:focus {
  outline: none;
}
.month-head {
  margin: 0;
  padding: 12px 18px 4px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
}
.share {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) auto 52px;
  align-items: center;
  gap: 12px;
  padding: 6px 18px;
  min-width: 0;
}
.share + .share {
  border-top: 1px solid var(--line);
}
.share.dead .sh-main {
  opacity: 0.6;
}
.sh-day {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sh-main {
  display: grid;
  min-width: 0;
}
.sh-title {
  font-size: 14px;
  color: var(--ink);
}
.sh-meta {
  font-size: 12px;
  color: var(--muted);
}
.sh-status {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.sh-status.danger {
  color: var(--danger);
}
.sh-status.warn {
  color: var(--warn);
}
.sh-op {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 640px) {
  .share {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 8px;
    padding: 8px 14px;
  }
  .sh-day {
    display: none;
  }
  .sh-status {
    grid-column: 1;
    grid-row: 2;
  }
  .sh-op {
    grid-column: 2;
    grid-row: 1 / 3;
  }
  .month-head {
    padding-left: 14px;
  }
}
</style>
