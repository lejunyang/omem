<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { get, post } from "../api";
import { toast } from "../store";
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
  status: "open" | "needs-owner" | "asked" | "answered" | "resolved" | "dropped";
  importance: number;
  note: string;
  answer: string | null;
};
type Migration = { pages: number; questions: number; done: boolean } | null;

const props = defineProps<{ space: string }>();
const emit = defineEmits<{ close: []; open: [slug: string] }>();
const items = ref<WikiQuestion[]>([]);
const migration = ref<Migration>(null);
const resolving = ref<string | null>(null);
const loading = ref(true);
const drafts = ref<Record<string, string>>({});
const STATUS: Record<WikiQuestion["status"], string> = { open: "还没人查", "needs-owner": "要你定", asked: "已经问你", answered: "正在写回页面", resolved: "已解决", dropped: "不用管" };

async function load() {
  loading.value = true;
  try {
    const r = await get<{ questions: WikiQuestion[]; migration: Migration; resolving: string | null }>(`/api/wiki/${props.space}/questions`);
    items.value = r.questions;
    migration.value = r.migration;
    resolving.value = r.resolving;
  } finally {
    loading.value = false;
  }
}
watch(() => props.space, load, { immediate: true });

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
      <div class="row wrap actions">
        <span class="small">要你定 {{ counts.owner }} 个 · 还没人查 {{ counts.open }} 个</span>
        <span class="spacer" />
        <button class="btn ghost sm" :disabled="!counts.open || !!resolving" @click="resolve"><Icon name="search" :size="14" />{{ resolving ? "助手正在查" : "让助手先查一遍（最多 20 个）" }}</button>
        <button class="btn ghost sm" title="把没核对过的页面按现在的写法要求过一遍，一次 10 页" @click="recheck"><Icon name="refresh" :size="14" />重新核对已有页面（10 页）</button>
      </div>
      <div v-if="migration && migration.pages" class="muted small">升级时从 {{ migration.pages }} 页移出了旧的“还没查清”一节，变成 {{ migration.questions }} 个问题{{ migration.done ? "" : "（还在进行）" }}。</div>
      <Skeleton v-if="loading" :rows="5" variant="lines" />
      <div v-else-if="!items.length" class="muted pad">没有未决问题。</div>
      <div v-else class="groups">
        <section v-for="g in groups" :key="g.page" class="group">
          <a href="#" class="ptitle" @click.prevent="emit('open', g.page)">{{ g.title }}</a>
          <div v-for="q in g.list" :key="q.id" class="q">
            <div class="row top">
              <span class="badge" :class="q.status">{{ STATUS[q.status] }}</span>
              <span class="text">{{ q.question }}</span>
            </div>
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
          </div>
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
