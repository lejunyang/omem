<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, patch, post, type Item, type ItemEvent } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiDateTime from "../components/UiDateTime.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import { fmtTime, itemKindLabel, openCitation, relTime, state, toast } from "../store";

const route = useRoute();
const router = useRouter();
const items = ref<Item[]>([]);
const showDone = ref(false);
const scope = ref<"all" | "space">("all");
type WorkFile = { id: string; uri: string; title: string; updatedAt: string; expiresAt: string | null; lines: number };
const detail = ref<{ item: Item; events: ItemEvent[]; excerpts?: Record<string, { title: string; text: string }>; files?: WorkFile[] } | null>(null);
const quick = ref("");
const viaAssistant = ref(true);
const note = ref("");
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

const loading = ref(true);
async function load() {
  try {
    items.value = await get<Item[]>(`/api/items?status=${showDone.value ? "all" : "active"}${scope.value === "space" ? `&space=${state.space}` : ""}`);
  } finally {
    loading.value = false;
  }
}
async function loadDetail() {
  const id = route.params.id as string | undefined;
  detail.value = id ? await get(`/api/items/${id}`).catch(() => null) : null;
}
onMounted(() => {
  void load();
  void loadDetail();
});
watch([showDone, scope], load);
watch(() => route.params.id, loadDetail);
const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "item") {
    void load();
    if (detail.value && e.id === detail.value.item.id) void loadDetail();
  }
});
onBeforeUnmount(() => off());

const columns = computed(() => {
  const open = items.value.filter((i) => !["done", "cancelled"].includes(i.status));
  return [
    { key: "decision", title: "需要你决定", icon: "alert", items: open.filter((i) => i.kind === "decision") },
    { key: "todo", title: "待办与提醒", icon: "checkbox", items: open.filter((i) => i.kind === "todo" || i.kind === "reminder") },
    { key: "waiting", title: "等待回复", icon: "user", items: open.filter((i) => i.kind === "waiting") },
    { key: "watch", title: "持续关注", icon: "eye", items: open.filter((i) => i.kind === "watch") },
  ].filter((c) => c.items.length || c.key !== "decision");
});
const closed = computed(() => items.value.filter((i) => ["done", "cancelled"].includes(i.status)));

async function addQuick() {
  const t = quick.value.trim();
  if (!t) return;
  if (viaAssistant.value) {
    const r = await post<{ conversationId: string }>("/api/ask", { text: t, space: state.space });
    toast("已交给助理处理", "ok", `#/ask/${r.conversationId}`);
  } else {
    await post("/api/items", { title: t, space: state.space });
  }
  quick.value = "";
  void load();
}
async function setStatus(i: Item, status: string) {
  await patch(`/api/items/${i.id}`, { status });
  void load();
  if (detail.value?.item.id === i.id) void loadDetail();
}
async function save(field: Partial<Item>) {
  if (!detail.value) return;
  await patch(`/api/items/${detail.value.item.id}`, field);
  void loadDetail();
}
async function addNote() {
  if (!note.value.trim() || !detail.value) return;
  await patch(`/api/items/${detail.value.item.id}`, { note: note.value });
  note.value = "";
  void loadDetail();
}
function parseRef(r: string) {
  const m = /^src:([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(r);
  if (m) return () => openCitation({ kind: "source", id: m[1], from: m[2] ? +m[2] : undefined, to: m[3] ? +m[3] : undefined }, true);
  const mm = /^(mem|msg):(\S+)/.exec(r);
  if (mm) return () => openCitation({ kind: mm[1] === "mem" ? "memory" : "message", id: mm[2] }, true);
  return null;
}
</script>

<template>
  <div class="page items">
    <div class="page-head">
      <div>
        <h1>事项</h1>
        <p>待办、提醒、等待回复和持续关注。助理会在材料更新时推进它们，只在需要你时通知。</p>
      </div>
      <span class="spacer" />
      <div class="row small">
        <UiSegmented v-model="scope" size="sm" aria-label="范围" :options="[{ value: 'all', label: '所有空间' }, { value: 'space', label: '当前空间' }]" />
        <UiCheckbox v-model="showDone" size="sm">显示已完成</UiCheckbox>
      </div>
    </div>

    <form class="quick card row" @submit.prevent="addQuick">
      <Icon name="plus" :size="16" />
      <input v-model="quick" placeholder="例如：周五下午提醒我交报销单；等小王回复接口文档；关注项目A的需求变化" />
      <UiCheckbox v-model="viaAssistant" size="sm" class="small muted" title="交给助理理解时间、对象并关联背景">让助理处理</UiCheckbox>
      <button class="btn primary sm" :disabled="!quick.trim()">添加</button>
    </form>

    <div class="board">
      <section v-for="c in columns" :key="c.key" class="col">
        <h2 class="section-title row"><Icon :name="c.icon" :size="14" />{{ c.title }} <span class="count">{{ c.items.length }}</span></h2>
        <div class="cards">
          <router-link v-for="i in c.items" :key="i.id" :to="`/items/${i.id}`" class="card item" :class="{ on: detail?.item.id === i.id, p1: i.priority === 1 }">
            <div class="row top">
              <button class="check" :title="'标记完成'" @click.prevent="setStatus(i, 'done')"><Icon name="check" :size="12" /></button>
              <span class="ttl" :title="i.title">{{ i.title }}</span>
            </div>
            <div class="sub muted small row wrap">
              <span v-if="i.remindAt" :class="{ due: new Date(i.remindAt) < new Date() }"><Icon name="bell" :size="12" /> {{ fmtTime(i.remindAt) }}</span>
              <span v-if="i.dueAt"><Icon name="clock" :size="12" /> 截止 {{ fmtTime(i.dueAt) }}</span>
              <span v-if="i.waitingOn" class="wait"><Icon name="user" :size="12" /><span>{{ i.waitingOn }}</span></span>
              <span v-if="i.spaceId !== 'personal'" class="badge space" :title="spaceName(i.spaceId)">{{ spaceName(i.spaceId) }}</span>
            </div>
          </router-link>
          <Skeleton v-if="loading && !items.length" variant="cards" :rows="2" />
          <div v-else-if="!c.items.length" class="muted small none">无</div>
        </div>
      </section>
    </div>

    <section v-if="showDone && closed.length" class="done-list">
      <h2 class="section-title">已完成 / 已取消</h2>
      <div class="list">
        <router-link v-for="i in closed" :key="i.id" :to="`/items/${i.id}`" class="li muted"><Icon name="check" :size="15" /><span class="strike">{{ i.title }}</span><span class="spacer" /><span class="small">{{ relTime(i.closedAt) }}</span></router-link>
      </div>
    </section>

    <div v-if="detail" class="panel-overlay" @mousedown.self="router.push('/items')">
      <aside class="panel">
        <header class="row">
          <span class="badge accent">{{ itemKindLabel[detail.item.kind] }}</span>
          <span class="spacer" />
          <button class="btn ghost sm icon" @click="router.push('/items')"><Icon name="x" /></button>
        </header>
        <input class="input title" :value="detail.item.title" @change="save({ title: ($event.target as HTMLInputElement).value })" />
        <textarea class="textarea" rows="3" placeholder="详情" :value="detail.item.detail" @change="save({ detail: ($event.target as HTMLTextAreaElement).value })" />
        <div class="grid2">
          <div class="field"><span>类型</span>
            <UiSelect :model-value="detail.item.kind" aria-label="类型" :options="Object.entries(itemKindLabel).map(([value, label]) => ({ value, label }))" @change="(v) => save({ kind: v })" />
          </div>
          <div class="field"><span>状态</span>
            <UiSelect
              :model-value="detail.item.status"
              aria-label="状态"
              :options="[
                { value: 'open', label: '进行中' },
                { value: 'waiting', label: '等待中' },
                { value: 'snoozed', label: '稍后' },
                { value: 'done', label: '完成' },
                { value: 'cancelled', label: '取消' },
              ]"
              @change="(v) => save({ status: v })"
            />
          </div>
          <div class="field"><span>提醒时间</span><UiDateTime :model-value="detail.item.remindAt" aria-label="提醒时间" @change="(v) => save({ remindAt: v })" /></div>
          <div class="field"><span>截止时间</span><UiDateTime :model-value="detail.item.dueAt" aria-label="截止时间" @change="(v) => save({ dueAt: v })" /></div>
          <label class="field"><span>等待对象</span><input class="input" :value="detail.item.waitingOn ?? ''" @change="save({ waitingOn: ($event.target as HTMLInputElement).value || null })" /></label>
          <div class="field"><span>优先级</span>
            <UiSegmented :model-value="detail.item.priority" aria-label="优先级" :options="[{ value: 1, label: '高' }, { value: 2, label: '中' }, { value: 3, label: '低' }]" @change="(v) => save({ priority: v })" />
          </div>
        </div>
        <div v-if="detail.files?.length" class="refs">
          <div class="section-title">工作文件</div>
          <a v-for="f in detail.files" :key="f.id" href="#" class="ref" @click.prevent="openCitation({ kind: 'source', id: f.id }, true)">
            <span class="ref-title small">{{ f.title }}</span>
            <span class="ref-text small muted">{{ f.lines }} 行 · {{ relTime(f.updatedAt) }}更新{{ f.expiresAt ? ` · ${fmtTime(f.expiresAt)} 过期` : "" }}</span>
          </a>
        </div>
        <div v-if="detail.item.sourceRefs.length" class="refs">
          <div class="section-title">相关依据</div>
          <template v-for="r in detail.item.sourceRefs" :key="r">
            <a v-if="parseRef(r)" href="#" class="ref" @click.prevent="parseRef(r)!()">
              <template v-if="detail.excerpts?.[r]">
                <span class="ref-title small muted">{{ detail.excerpts[r].title }}</span>
                <span class="ref-text small">{{ detail.excerpts[r].text }}</span>
              </template>
              <span v-else class="mono small muted">{{ r }}（已删除或无权查看）</span>
            </a>
          </template>
        </div>
        <div class="timeline">
          <div class="section-title">时间线</div>
          <ol>
            <li v-for="e in detail.events.slice().reverse()" :key="e.id">
              <div class="small muted">{{ fmtTime(e.at) }} · {{ e.actor === "user" ? "本人" : "助理" }}</div>
              <Markdown :source="e.text" class="small-prose" />
            </li>
          </ol>
          <form class="row" @submit.prevent="addNote">
            <input v-model="note" class="input" placeholder="补充一条进展" />
            <button class="btn sm">记录</button>
          </form>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.quick {
  padding: 6px 8px 6px 14px;
  margin-bottom: 22px;
  color: var(--muted);
}
.quick input:not([type]) {
  flex: 1;
  border: 0;
  outline: 0;
  background: none;
  font-size: 14.5px;
  padding: 6px 0;
  color: var(--ink);
  min-width: 0;
}
.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 18px;
  align-items: start;
}
.col .section-title {
  gap: 6px;
}
.count {
  margin-left: auto;
  font-weight: 500;
}
.col,
.cards {
  min-width: 0;
}
.cards {
  display: grid;
  gap: 8px;
}
.item {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
  color: inherit;
  transition: border-color 0.12s;
}
.item:hover {
  text-decoration: none;
  border-color: var(--line-strong);
}
.item.on {
  border-color: var(--accent);
}
.item.p1 {
  border-left: 3px solid var(--danger);
}
.top {
  align-items: flex-start;
}
.ttl {
  min-width: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}
.check {
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: none;
  display: grid;
  place-items: center;
  color: transparent;
  cursor: pointer;
  padding: 0;
}
.check:hover {
  border-color: var(--ok);
  color: var(--ok);
}
.sub {
  gap: 10px;
  padding-left: 26px;
}
.sub > span {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  min-width: 0;
  max-width: 100%;
}
.sub > .wait {
  align-items: flex-start;
  overflow-wrap: anywhere;
}
.sub > .wait > svg {
  flex: none;
  margin-top: 3px;
}
.sub > .wait > span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}
.sub > .space {
  display: inline-block;
  overflow: hidden;
  text-overflow: ellipsis;
}
.due {
  color: var(--danger);
}
.none {
  padding: 4px 2px;
}
.done-list {
  margin-top: 32px;
}
.strike {
  text-decoration: line-through;
}
.panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 35;
  background: rgba(10, 12, 16, 0.15);
}
.panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: min(480px, 100vw);
  background: var(--panel);
  border-left: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 14px 18px 24px;
  overflow-y: auto;
  display: grid;
  gap: 12px;
  align-content: start;
}
.title {
  font-size: 17px;
  font-weight: 600;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.refs {
  display: grid;
  gap: 6px;
}
.ref {
  display: grid;
  gap: 1px;
  padding: 6px 10px;
  border-left: 2px solid var(--line);
  color: inherit;
  text-decoration: none;
  min-width: 0;
}
.ref:hover {
  border-left-color: var(--accent);
  background: var(--hover, transparent);
}
.ref-title,
.ref-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline ol {
  list-style: none;
  padding: 0 0 0 12px;
  margin: 0 0 12px;
  border-left: 2px solid var(--line);
  display: grid;
  gap: 12px;
}
.timeline li {
  padding-left: 10px;
}
.small-prose {
  font-size: 13.5px;
  line-height: 1.6;
}
</style>
