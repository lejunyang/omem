<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post, onServerEvent } from "../api";
import { onBeforeUnmount } from "vue";
import { toast, relTime } from "../store";
import UiSegmented from "./UiSegmented.vue";
import VirtualList from "./VirtualList.vue";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/** Open questions of a space's pages (src/wiki/questions.ts): what writers were not sure of, kept out of the pages. */
export type WikiQuestion = {
  id: string;
  page: string;
  pageTitle?: string;
  question: string;
  why: string;
  refs: string[];
  source: string;
  reads30: number;
  status: "lapsed" | "open" | "needs-owner" | "asked" | "answered" | "resolved" | "dropped";
  importance: number;
  note: string;
  answer: string | null;
};
type Migration = { pages: number; questions: number; done: boolean } | null;

const props = defineProps<{ space: string }>();
const emit = defineEmits<{ close: []; open: [slug: string] }>();
const items = ref<WikiQuestion[]>([]);
type Correction = { id: string; slug: string; title: string; wrong: string; right: string; at: string; checked: number; fixed: number; status: string; sweep_run_id: string | null };
const corrections = ref<Correction[]>([]);
const migration = ref<Migration>(null);
const resolving = ref<string | null>(null);
const loading = ref(true);
const filter = ref<"unsettled" | "lapsed">("unsettled");
let loadSeq = 0;
const drafts = ref<Record<string, string>>({});
const STATUS: Record<WikiQuestion["status"], string> = { open: "还没人查", "needs-owner": "要你定", asked: "已经问你", answered: "正在写回页面", resolved: "已解决", dropped: "不用管", lapsed: "已过期" };

async function load() {
  const seq = ++loadSeq;
  const space = props.space, status = filter.value;
  loading.value = true;
  items.value = [];
  corrections.value = [];
  try {
    const [r, recent] = await Promise.all([
      get<{ questions: WikiQuestion[]; migration: Migration; resolving: string | null }>(`/api/wiki/${space}/questions?status=${status}`),
      get<Correction[]>(`/api/wiki/${space}/corrections`),
    ]);
    if (seq !== loadSeq || space !== props.space || status !== filter.value) return;
    items.value = r.questions;
    corrections.value = recent;
    migration.value = r.migration;
    resolving.value = r.resolving;
  } catch (e) {
    if (seq === loadSeq) toast((e as Error).message, "error");
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}
watch([() => props.space, filter], load, { immediate: true });
let reload: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  if (e.type === "run" && !reload) reload = setTimeout(() => { reload = undefined; void load(); }, 2000);
});
onBeforeUnmount(() => { off(); clearTimeout(reload); ++loadSeq; });

const groups = computed(() => {
  const by = new Map<string, WikiQuestion[]>();
  for (const q of items.value) by.set(q.page, [...(by.get(q.page) ?? []), q]);
  return [...by].map(([page, list]) => ({ page, title: list[0].pageTitle ?? page, list }));
});
const counts = computed(() => ({
  owner: items.value.filter((q) => q.status === "needs-owner" || q.status === "asked").length,
  open: items.value.filter((q) => q.status === "open").length,
}));

async function answer(q: WikiQuestion) {
  const text = drafts.value[q.id]?.trim();
  if (!text) return;
  await post(`/api/wiki/${props.space}/questions/${q.id}/answer`, { answer: text });
  toast("已交给写作者写回页面");
  delete drafts.value[q.id];
  await load();
}
async function drop(q: WikiQuestion) {
  await post(`/api/wiki/${props.space}/questions/${q.id}/drop`, {});
  await load();
}
async function reopen(q: WikiQuestion) {
  await post(`/api/wiki/${props.space}/questions/${q.id}/reopen`, {});
  await load();
}
async function resolve() {
  const r = await post<{ runId: string | null; questions: number; already?: boolean }>(`/api/wiki/${props.space}/questions/resolve`, {});
  toast(r.already ? "已经有一次在查了" : r.runId ? `让助手先查 ${r.questions} 个问题` : "没有还没人查的问题");
  await load();
}
async function recheck() {
  const r = await post<{ pages: string[]; remaining: number }>(`/api/wiki/${props.space}/recheck`, { limit: 10 });
  toast(r.pages.length ? `重新核对 ${r.pages.length} 页${r.remaining ? `，还有 ${r.remaining} 页没核对过` : ""}` : "没有没核对过的页面");
}
</script>

<template>
  <div class="modal-overlay" @mousedown.self="emit('close')">
    <div class="modal wide">
      <header class="row">
        <strong class="nowrap">未决问题</strong>
        <span class="muted small">写作时拿不准、没写进页面的点，读者看不到</span>
        <span class="spacer" />
        <button class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button>
      </header>
      <UiSegmented v-model="filter" aria-label="问题状态" :options="[{ value: 'unsettled', label: '未决问题' }, { value: 'lapsed', label: '已过期' }]" />
      <div v-if="filter === 'unsettled'" class="row wrap actions">
        <span class="small">要你定 {{ counts.owner }} 个 · 还没人查 {{ counts.open }} 个</span>
        <span class="spacer" />
        <button class="btn ghost sm" :disabled="!counts.open || !!resolving" @click="resolve"><Icon name="search" :size="14" />{{ resolving ? "助手正在查" : "让助手先查一遍（最多 20 个）" }}</button>
        <button class="btn ghost sm" title="把没核对过的页面按现在的写法要求过一遍，一次 10 页" @click="recheck"><Icon name="refresh" :size="14" />重新核对已有页面（10 页）</button>
      </div>
      <div v-if="migration && migration.pages" class="muted small">升级时从 {{ migration.pages }} 页移出了旧的“还没查清”一节，变成 {{ migration.questions }} 个问题{{ migration.done ? "" : "（还在进行）" }}。</div>
      <Skeleton v-if="loading" :rows="5" variant="lines" />
      <section v-if="!loading && corrections.length" class="group corrections">
        <strong>本人指正（最近 20 条）</strong>
        <div v-for="c in corrections" :key="c.id" class="q">
          <div class="row wrap"><span class="muted small">{{ relTime(c.at) }}</span><a href="#" @click.prevent="emit('open', c.slug)">{{ c.title }}</a></div>
          <div class="text">{{ c.wrong }} → {{ c.right }}</div>
          <div class="small muted">{{ c.status === 'swept' ? '排查结束' : '正在修改和排查' }} · 检查 {{ c.checked }} 页 / 已改 {{ c.fixed }} 页 <router-link v-if="c.sweep_run_id" :to="`/runs/${c.sweep_run_id}`">查看排查运行</router-link></div>
        </div>
      </section>
      <div v-if="!loading && !items.length" class="muted pad">没有未决问题。</div>
      <div v-if="!loading && items.length" class="groups">
        <section v-for="g in groups" :key="g.page" class="group">
          <a href="#" class="ptitle" @click.prevent="emit('open', g.page)">{{ g.title }}</a>
          <VirtualList :items="g.list" :item-key="(q: WikiQuestion) => q.id" :estimate="120"><template #default="{ item: q }"><div class="q">
            <div class="row top">
              <span class="badge" :class="q.status">{{ STATUS[q.status] }}</span>
              <span class="text">{{ q.question }}</span>
            </div>
            <div class="muted small">这页近 30 天被读到 {{ q.reads30 }} 次</div>
            <button v-if="q.status === 'lapsed'" class="btn ghost sm" @click="reopen(q)">重新打开</button>
            <div v-if="q.why" class="muted small">为什么拿不准：{{ q.why }}</div>
            <div v-if="q.note" class="muted small">{{ q.note }}</div>
            <div v-if="q.refs.length" class="muted small refs">{{ q.refs.join(" ") }}</div>
            <div v-if="q.status === 'needs-owner' || q.status === 'asked'" class="answer">
              <textarea v-model="drafts[q.id]" class="textarea" rows="2" placeholder="写下答案，会补进这一页" />
              <div class="row">
                <span class="spacer" />
                <button class="btn ghost sm" @click="drop(q)">不用管</button>
                <button class="btn primary sm" :disabled="!drafts[q.id]?.trim()" @click="answer(q)">补进页面</button>
              </div>
            </div>
          </div></template></VirtualList>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 12, 16, 0.35);
  z-index: 55;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
}
.modal {
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
}
.wide {
  width: min(760px, calc(100vw - 24px));
  max-height: 84vh;
  overflow-y: auto;
  display: grid;
  gap: 12px;
  align-content: start;
}
@media (max-width: 600px) {
  .modal-overlay {
    padding-top: 12px;
  }
}
.actions {
  gap: 8px;
}
.nowrap {
  white-space: nowrap;
}
.groups {
  display: grid;
  gap: 18px;
}
.group {
  display: grid;
  gap: 10px;
}
.ptitle {
  justify-self: start;
  font-weight: 600;
}
.q {
  display: grid;
  gap: 4px;
  padding-left: 10px;
  border-left: 2px solid var(--line);
  min-width: 0;
}
.top {
  align-items: baseline;
  gap: 8px;
}
.text {
  overflow-wrap: anywhere;
}
.corrections a {
  min-width: 0;
  overflow-wrap: anywhere;
}
.refs {
  font-family: var(--mono);
  overflow-wrap: anywhere;
}
.badge {
  flex: none;
}
.badge.needs-owner,
.badge.asked {
  color: var(--warn);
}
.answer {
  display: grid;
  gap: 6px;
}
</style>
