<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, patch, post, type Item, type ItemEvent } from "../api";
import Icon from "../components/Icon.vue";
import Markdown from "../components/Markdown.vue";
import { fmtTime, itemKindLabel, openCitation, relTime, state, toast } from "../store";

const route = useRoute();
const router = useRouter();
const items = ref<Item[]>([]);
const showDone = ref(false);
const scope = ref<"all" | "space">("all");
const detail = ref<{ item: Item; events: ItemEvent[] } | null>(null);
const quick = ref("");
const viaAssistant = ref(true);
const note = ref("");

async function load() {
  items.value = await get<Item[]>(`/api/items?status=${showDone.value ? "all" : "active"}${scope.value === "space" ? `&space=${state.space}` : ""}`);
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
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function fromLocalInput(v: string) {
  return v ? new Date(v).toISOString() : null;
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
        <select v-model="scope" class="select" style="width: auto">
          <option value="all">所有空间</option>
          <option value="space">当前空间</option>
        </select>
        <label class="row"><input v-model="showDone" type="checkbox" />显示已完成</label>
      </div>
    </div>

    <form class="quick card row" @submit.prevent="addQuick">
      <Icon name="plus" :size="16" />
      <input v-model="quick" placeholder="例如：周五下午提醒我交报销单；等小王回复接口文档；关注项目A的需求变化" />
      <label class="row small muted" title="交给助理理解时间、对象并关联背景"><input v-model="viaAssistant" type="checkbox" />让助理处理</label>
      <button class="btn primary sm" :disabled="!quick.trim()">添加</button>
    </form>

    <div class="board">
      <section v-for="c in columns" :key="c.key" class="col">
        <h2 class="section-title row"><Icon :name="c.icon" :size="14" />{{ c.title }} <span class="count">{{ c.items.length }}</span></h2>
        <div class="cards">
          <router-link v-for="i in c.items" :key="i.id" :to="`/items/${i.id}`" class="card item" :class="{ on: detail?.item.id === i.id, p1: i.priority === 1 }">
            <div class="row top">
              <button class="check" :title="'标记完成'" @click.prevent="setStatus(i, 'done')"><Icon name="check" :size="12" /></button>
              <span class="ttl">{{ i.title }}</span>
            </div>
            <div class="sub muted small row wrap">
              <span v-if="i.remindAt" :class="{ due: new Date(i.remindAt) < new Date() }"><Icon name="bell" :size="12" /> {{ fmtTime(i.remindAt) }}</span>
              <span v-if="i.dueAt"><Icon name="clock" :size="12" /> 截止 {{ fmtTime(i.dueAt) }}</span>
              <span v-if="i.waitingOn"><Icon name="user" :size="12" /> {{ i.waitingOn }}</span>
              <span v-if="i.spaceId !== 'personal'" class="badge">{{ i.spaceId }}</span>
            </div>
          </router-link>
          <div v-if="!c.items.length" class="muted small none">无</div>
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
          <label class="field"><span>类型</span>
            <select class="select" :value="detail.item.kind" @change="save({ kind: ($event.target as HTMLSelectElement).value })">
              <option v-for="(l, k) in itemKindLabel" :key="k" :value="k">{{ l }}</option>
            </select>
          </label>
          <label class="field"><span>状态</span>
            <select class="select" :value="detail.item.status" @change="save({ status: ($event.target as HTMLSelectElement).value })">
              <option value="open">进行中</option><option value="waiting">等待中</option><option value="snoozed">稍后</option><option value="done">完成</option><option value="cancelled">取消</option>
            </select>
          </label>
          <label class="field"><span>提醒时间</span><input type="datetime-local" class="input" :value="toLocalInput(detail.item.remindAt)" @change="save({ remindAt: fromLocalInput(($event.target as HTMLInputElement).value) })" /></label>
          <label class="field"><span>截止时间</span><input type="datetime-local" class="input" :value="toLocalInput(detail.item.dueAt)" @change="save({ dueAt: fromLocalInput(($event.target as HTMLInputElement).value) })" /></label>
          <label class="field"><span>等待对象</span><input class="input" :value="detail.item.waitingOn ?? ''" @change="save({ waitingOn: ($event.target as HTMLInputElement).value || null })" /></label>
          <label class="field"><span>优先级</span>
            <select class="select" :value="detail.item.priority" @change="save({ priority: Number(($event.target as HTMLSelectElement).value) })"><option :value="1">高</option><option :value="2">中</option><option :value="3">低</option></select>
          </label>
        </div>
        <div v-if="detail.item.sourceRefs.length" class="refs">
          <div class="section-title">相关依据</div>
          <template v-for="r in detail.item.sourceRefs" :key="r">
            <a v-if="parseRef(r)" href="#" class="mono small" @click.prevent="parseRef(r)!()">{{ r }}</a>
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
.cards {
  display: grid;
  gap: 8px;
}
.item {
  display: grid;
  gap: 6px;
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
  line-height: 1.5;
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
.sub span {
  display: inline-flex;
  gap: 3px;
  align-items: center;
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
  gap: 2px;
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
