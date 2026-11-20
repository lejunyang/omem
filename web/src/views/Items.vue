<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, patch, post, type Item, type ItemEvent } from "../api";
import Icon from "../components/Icon.vue";
import Skeleton from "../components/Skeleton.vue";
import Markdown from "../components/Markdown.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiDateTime from "../components/UiDateTime.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";
import ItemMaterials, { type Material } from "../components/ItemMaterials.vue";
import ItemPlaces, { type Place, type ItemRun } from "../components/ItemPlaces.vue";
import ItemFlow from "../components/ItemFlow.vue";
import ItemObjects from "../components/ItemObjects.vue";
import ItemListen from "../components/ItemListen.vue";
import DemoControl from "../components/DemoControl.vue";
import ItemMetrics from "../components/ItemMetrics.vue";
import PluginSlots from "../components/PluginSlots.vue";
import DesignRow from "../components/DesignRow.vue";
import DesignStart from "../components/DesignStart.vue";
import type { DesignSummary } from "../lib/designs";
import { fmtTime, itemKindLabel, openCitation, relTime, state, toast } from "../store";
import { refAction } from "../lib/refs";
import RichText from "../components/RichText.vue";
import { pageParam } from "../lib/route";

const route = useRoute();
const router = useRouter();
const items = ref<Item[]>([]);
const showDone = ref(false);
const scope = ref<"all" | "space">("all");
type WorkFile = { id: string; uri: string; title: string; updatedAt: string; expiresAt: string | null; lines: number };
const detail = ref<{ item: Item; auto?: { why: string; by: string }; events: ItemEvent[]; excerpts?: Record<string, { title: string; text: string }>; files?: WorkFile[]; expiry?: { at: string; text: string } | null; materials?: Material[]; places?: Place[]; runs?: ItemRun[] } | null>(null);
const quick = ref("");
const viaAssistant = ref(true);
const adding = ref(false);
const query = ref("");
const searching = ref(false);
const note = ref("");
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

const loading = ref(true);
// A search looks through closed items too: what you are looking for may already be done.
const searchAll = computed(() => showDone.value || !!query.value.trim());
let loadSeq = 0;
async function load() {
  const my = ++loadSeq;
  const t = query.value.trim();
  try {
    const r = await get<Item[]>(`/api/items?status=${searchAll.value ? "all" : "active"}${scope.value === "space" ? `&space=${state.space}` : ""}${t ? `&q=${encodeURIComponent(t)}` : ""}`);
    if (my === loadSeq) items.value = r;
  } finally {
    if (my === loadSeq) loading.value = searching.value = false;
  }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  clearTimeout(searchTimer);
  searching.value = true;
  searchTimer = setTimeout(load, 200);
});
const itemId = pageParam("items");
let detailSeq = 0;
async function loadDetail() {
  const seq = ++detailSeq;
  const id = itemId.value;
  if (detail.value?.item.id !== id) detail.value = null;
  const result = id ? await get<NonNullable<typeof detail.value>>(`/api/items/${id}`).catch(() => null) : null;
  if (seq === detailSeq && id === itemId.value) detail.value = result;
  // The item's designs (own, someone else's, change descriptions): docs/v2/coding-plan.md §5.
  const list = id ? await get<{ designs: DesignSummary[] }>(`/api/designs?item=${encodeURIComponent(id)}`).catch(() => null) : null;
  if (seq === detailSeq && id === itemId.value) designs.value = list?.designs ?? [];
}
const designs = ref<DesignSummary[]>([]);
const startingDesign = ref(false);
onMounted(() => {
  void load();
  void loadDetail();
  void loadExpiry();
  void loadCandidates();
});
watch([showDone, scope], () => {
  void load();
  void loadCandidates();
});
watch(itemId, loadDetail);
const off = onServerEvent((e) => {
  if (e.type === "changed" && e.entity === "item") {
    void load();
    void loadExpiry();
    void loadCandidates();
    if (detail.value && e.id === detail.value.item.id) void loadDetail();
  }
});
const offResync = onServerResync(() => {
  void load();
  void loadExpiry();
  void loadCandidates();
  if (detail.value) void loadDetail();
});

// ---- candidates: items the assistant made on its own, kept or not (src/items/auto.ts) ----
const candidates = ref<Item[]>([]);
const deciding = ref<string | null>(null);
let candidateSeq = 0;
async function loadCandidates() {
  const my = ++candidateSeq;
  const r = await get<Item[]>(`/api/items?status=candidate${scope.value === "space" ? `&space=${state.space}` : ""}`).catch(() => null);
  if (my === candidateSeq && r) candidates.value = r;
}
async function decide(i: Item, keep: boolean) {
  deciding.value = i.id;
  try {
    await post(`/api/items/${i.id}/candidate`, { keep });
    toast(keep ? `已留下「${i.title}」` : `不要了「${i.title}」`, "ok");
    candidates.value = candidates.value.filter((c) => c.id !== i.id);
    void load();
    if (detail.value?.item.id === i.id) void loadDetail();
  } finally {
    deciding.value = null;
  }
}
/** While searching, only the candidates that match too. */
const shownCandidates = computed(() => {
  const t = query.value.trim().toLowerCase();
  return t ? candidates.value.filter((c) => `${c.title}\n${c.detail}`.toLowerCase().includes(t)) : candidates.value;
});
const candidateWhen = (i: Item) => [itemKindLabel[i.kind] ?? i.kind, i.dueAt ? `截止 ${fmtTime(i.dueAt)}` : "", i.remindAt ? `提醒 ${fmtTime(i.remindAt)}` : "", i.auto?.by ? `${i.auto.by}建的` : "", relTime(i.createdAt)].filter(Boolean).join(" · ");
onBeforeUnmount(() => {
  off();
  offResync();
});

/** Items with others under them (open ones), by id. */
const parents = computed(() => new Set(items.value.filter((i) => i.parentId && !closedStatuses.includes(i.status)).map((i) => i.parentId!)));
const titleOf = (id: string) => items.value.find((i) => i.id === id)?.title ?? "";
/** A line, an item with items under it, or one in a flow opens its own page under 工作 (views/WorkDetail.vue). */
const pageOf = (i: Item) => (i.kind === "line" || i.flow || parents.value.has(i.id) ? `/work/${i.id}` : `/items/${i.id}`);
const columns = computed(() => {
  const open = items.value.filter((i) => !closedStatuses.includes(i.status) && i.status !== "candidate");
  return [
    { key: "line", title: "工作线", icon: "target", items: open.filter((i) => i.kind === "line") },
    { key: "decision", title: "需要你决定", icon: "alert", items: open.filter((i) => i.kind === "decision") },
    { key: "todo", title: "待办与提醒", icon: "checkbox", items: open.filter((i) => i.kind === "todo" || i.kind === "reminder") },
    { key: "waiting", title: "等待回复", icon: "user", items: open.filter((i) => i.kind === "waiting") },
    { key: "watch", title: "持续关注", icon: "eye", items: open.filter((i) => i.kind === "watch") },
  ].filter((c) => c.items.length || (c.key !== "decision" && c.key !== "line"));
});
const closedStatuses = ["done", "cancelled", "expired"];
const closed = computed(() => items.value.filter((i) => closedStatuses.includes(i.status)));
const closedLabel: Record<string, string> = { done: "完成", cancelled: "取消", expired: "过期" };

// ---- closing by themselves --------------------------------------------------------
type ExpiryRow = { id: string; title: string; kind: string; spaceId: string; lastActivity: string; expiresAt: string; expiryText: string };
const expiry = ref<{ backlogApplied: boolean; backlog: ExpiryRow[]; soon: ExpiryRow[] } | null>(null);
const backlogOpen = ref(false);
const keepIds = ref<string[]>([]);
async function loadExpiry() {
  expiry.value = await get<{ backlogApplied: boolean; backlog: ExpiryRow[]; soon: ExpiryRow[] }>("/api/items-expiry").catch(() => null);
}
/** "3 天后自动过期" for open items that close within three days. */
function closesSoon(i: Item) {
  if (!i.expiresAt) return "";
  const days = (Date.parse(i.expiresAt) - Date.now()) / 86_400_000;
  if (days > 3) return "";
  return days <= 0 ? "已到期" : days <= 1 ? "一天内自动过期" : `${Math.ceil(days)} 天后自动过期`;
}
async function keep(i: Item) {
  await post(`/api/items/${i.id}/keep`, {});
  toast(closedStatuses.includes(i.status) ? "已恢复" : "已保留，期限从现在重新计算", "ok");
  void load();
  void loadExpiry();
  if (detail.value?.item.id === i.id) void loadDetail();
}
function toggleKeep(id: string, on: boolean) {
  keepIds.value = on ? [...keepIds.value, id] : keepIds.value.filter((x) => x !== id);
}
async function applyBacklog() {
  const r = await post<{ expired: string[] }>("/api/items-expiry/backlog", { keep: keepIds.value });
  backlogOpen.value = false;
  keepIds.value = [];
  toast(`已收尾 ${r.expired.length} 件${r.expired.length ? "，之后有新进展会重新打开" : ""}`, "ok");
  void load();
  void loadExpiry();
}

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
  adding.value = false;
  void load();
}
const newInput = ref<HTMLTextAreaElement>();
watch(adding, async (open) => {
  if (!open) return;
  await nextTick();
  newInput.value?.focus();
});
/** Enter adds, Shift+Enter breaks the line; Enter that confirms an IME candidate does neither. */
function onNewEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  void addQuick();
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
</script>

<template>
  <div class="page items">
    <div class="page-head">
      <div>
        <h1>全部事项</h1>
        <p>工作线、待办、提醒、等待回复和持续关注。助理会在材料更新时推进它们，只在需要你时通知；工作线和它下面的事在 <router-link to="/">工作</router-link> 页看。</p>
      </div>
      <span class="spacer" />
      <button class="btn primary sm" @click="adding = true"><Icon name="plus" :size="15" />新建事项</button>
    </div>

    <div class="toolbar row wrap">
      <label class="search row" :class="{ busy: searching }">
        <Icon name="search" :size="15" />
        <input v-model="query" placeholder="搜索标题、详情、等待对象" aria-label="搜索事项" />
        <span v-if="searching" class="spinner" aria-label="搜索中" />
        <button v-else-if="query" type="button" class="btn ghost sm icon" aria-label="清空" @click="query = ''"><Icon name="x" :size="13" /></button>
      </label>
      <span class="spacer" />
      <UiSegmented v-model="scope" size="sm" aria-label="范围" :options="[{ value: 'all', label: '所有空间' }, { value: 'space', label: '当前空间' }]" />
      <UiCheckbox v-model="showDone" size="sm" class="small">显示已完成</UiCheckbox>
    </div>

    <div v-if="expiry && !expiry.backlogApplied && expiry.backlog.length" class="card pad backlog row wrap">
      <Icon name="clock" :size="16" />
      <p>有 {{ expiry.backlog.length }} 件事项很久没有新进展，按自动收尾的期限早就该过期了。先看一眼，要留下的勾上，其余一次收掉。</p>
      <span class="spacer" />
      <button class="btn sm primary" @click="backlogOpen = true">查看并收尾</button>
    </div>
    <section v-if="shownCandidates.length" class="candidates" aria-labelledby="candidates-title">
      <h2 id="candidates-title" class="section-title row"><Icon name="inbox" :size="14" />可能要跟的 <span class="count">{{ shownCandidates.length }}</span></h2>
      <p class="muted small">助手自己从材料里看出来、你没要求过的事。留下就变成正式事项，提醒时间照旧；不要就放下。3 天没答的会自动放下，你的选择会教它以后少建这类。</p>
      <div class="cand-list">
        <div v-for="c in shownCandidates" :key="c.id" class="cand row">
          <div class="cand-main">
            <router-link :to="`/items/${c.id}`" class="ttl">{{ c.title }}</router-link>
            <div class="small muted">{{ candidateWhen(c) }}</div>
            <RichText v-if="c.auto?.why" tag="div" class="small why" :text="c.auto.why" :lines="3" />
          </div>
          <div class="cand-actions row">
            <button class="btn sm primary" :disabled="deciding === c.id" @click="decide(c, true)">留下</button>
            <button class="btn sm ghost" :disabled="deciding === c.id" @click="decide(c, false)">不要</button>
          </div>
        </div>
      </div>
    </section>
    <p v-if="query.trim() && !searching && !loading && !items.length" class="muted none-found">没有标题、详情或等待对象里含“{{ query.trim() }}”的事项。</p>
    <div v-else class="board">
      <section v-for="c in columns" :key="c.key" class="col">
        <h2 class="section-title row"><Icon :name="c.icon" :size="14" />{{ c.title }} <span class="count">{{ c.items.length }}</span></h2>
        <div class="cards">
          <router-link v-for="i in c.items" :key="i.id" :to="pageOf(i)" class="card item" :class="{ on: detail?.item.id === i.id, p1: i.priority === 1 }">
            <div class="row top">
              <button class="check" :title="'标记完成'" @click.prevent="setStatus(i, 'done')"><Icon name="check" :size="12" /></button>
              <span class="ttl" :title="i.title">{{ i.title }}</span>
              <span v-if="i.flow" class="badge small flow-tag">{{ i.flow.waiting ? '等你：' : '' }}{{ i.flow.name }}</span>
            </div>
            <div class="sub muted small row wrap">
              <span v-if="i.remindAt" :class="{ due: new Date(i.remindAt) < new Date() }"><Icon name="bell" :size="12" /> {{ fmtTime(i.remindAt) }}</span>
              <span v-if="i.dueAt"><Icon name="clock" :size="12" /> 截止 {{ fmtTime(i.dueAt) }}</span>
              <span v-if="i.waitingOn" class="wait"><Icon name="user" :size="12" /><span>{{ i.waitingOn }}</span></span>
              <span v-if="i.parentId && titleOf(i.parentId)" class="under" :title="titleOf(i.parentId)">在「{{ titleOf(i.parentId) }}」下</span>
              <span v-if="closesSoon(i)" class="expiring" :title="i.expiryText">{{ closesSoon(i) }}</span>
              <span v-if="i.spaceId !== 'personal'" class="badge space" :title="spaceName(i.spaceId)">{{ spaceName(i.spaceId) }}</span>
            </div>
          </router-link>
          <Skeleton v-if="loading && !items.length" variant="cards" :rows="2" />
          <div v-else-if="!c.items.length" class="muted small none">无</div>
        </div>
      </section>
    </div>

    <section v-if="searchAll && closed.length" class="done-list">
      <h2 class="section-title">已完成 / 已取消 / 已过期</h2>
      <div class="list">
        <router-link v-for="i in closed" :key="i.id" :to="`/items/${i.id}`" class="li muted"><Icon :name="i.status === 'expired' ? 'clock' : 'check'" :size="15" /><span class="strike">{{ i.title }}</span><span class="spacer" /><span class="badge">{{ closedLabel[i.status] }}</span><span class="small">{{ relTime(i.closedAt) }}</span></router-link>
      </div>
    </section>

    <div v-if="detail" class="panel-overlay" @mousedown.self="router.push('/items')">
      <aside class="panel">
        <header class="row">
          <span class="badge accent">{{ itemKindLabel[detail.item.kind] }}</span>
          <span class="spacer" />
          <button class="btn ghost sm icon" @click="router.push('/items')"><Icon name="x" /></button>
        </header>
        <div v-if="detail.item.status === 'candidate'" class="cand-banner">
          <p><strong>候选：</strong>{{ detail.auto?.by ? `${detail.auto.by}自己建的` : "助手自己建的" }}，你还没说要不要。在你决定之前它不提醒、不进上面的列表。</p>
          <RichText v-if="detail.auto?.why" tag="p" class="small why" :text="detail.auto.why" />
          <div class="row">
            <button class="btn sm primary" :disabled="deciding === detail.item.id" @click="decide(detail.item, true)">留下</button>
            <button class="btn sm ghost" :disabled="deciding === detail.item.id" @click="decide(detail.item, false)">不要</button>
          </div>
        </div>
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
                { value: 'expired', label: '过期' },
                ...(detail.item.status === 'candidate' ? [{ value: 'candidate', label: '候选' }] : []),
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
        <div v-if="detail.expiry || closedStatuses.includes(detail.item.status)" class="expiry row wrap small">
          <Icon name="clock" :size="14" />
          <span v-if="detail.expiry">{{ fmtTime(detail.expiry.at) }} 自动过期：{{ detail.expiry.text }}。有新进展或你改动它会顺延。</span>
          <span v-else-if="detail.item.status === 'expired'">很久没有进展，已自动过期。有新进展会重新打开。</span>
          <span v-else>已{{ closedLabel[detail.item.status] }}。</span>
          <span class="spacer" />
          <button class="btn sm" @click="keep(detail.item)">{{ closedStatuses.includes(detail.item.status) ? "恢复" : "保留" }}</button>
        </div>
        <ItemFlow :item-id="detail.item.id" :editable="(!state.me || detail.item.userId === state.me.id) && (!state.me?.writes || state.me.writes.includes(detail.item.spaceId))" />
        <ItemMetrics :item-id="detail.item.id" />
        <ItemListen :item-id="detail.item.id" :editable="(!state.me || detail.item.userId === state.me.id)" />
        <DemoControl class="item-demo" :item-id="detail.item.id" :name="detail.item.title" />
        <ItemObjects :item-id="detail.item.id" :editable="(!state.me || detail.item.userId === state.me.id) && (!state.me?.writes || state.me.writes.includes(detail.item.spaceId))" />
        <PluginSlots at="item.panel" :item-id="detail.item.id" :space="detail.item.spaceId" />
        <ItemPlaces :places="detail.places ?? []" :runs="detail.runs ?? []" />
        <ItemMaterials :item-id="detail.item.id" :materials="detail.materials ?? []" @changed="loadDetail" />
        <div class="designs">
          <div class="section-title row">方案<span class="spacer" /><button class="btn ghost sm" @click="startingDesign = true"><Icon name="plus" :size="13" />跟进一份技术方案</button></div>
          <DesignRow v-for="d in designs" :key="d.id" :design="d" />
          <p v-if="!designs.length" class="muted small">交办这件事时助手会按需要先写方案请你确认；别人写的技术方案可以在这里跟进，助手会核对代码、写出问题和要问作者的。</p>
        </div>
        <DesignStart v-if="startingDesign" :item-id="detail.item.id" :item-title="detail.item.title" @close="startingDesign = false; loadDetail()" />
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
            <a v-if="refAction(r)" href="#" class="ref" @click.prevent="refAction(r)!()">
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
    <div v-if="adding" class="panel-overlay center" @mousedown.self="adding = false" @keydown.esc="adding = false">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="new-item-title" @submit.prevent="addQuick">
        <header class="row"><strong id="new-item-title">新建事项</strong><span class="spacer" /><button type="button" class="btn ghost sm icon" aria-label="关闭" @click="adding = false"><Icon name="x" /></button></header>
        <textarea
          ref="newInput"
          v-model="quick"
          class="textarea"
          rows="3"
          placeholder="例如：周五下午提醒我交报销单；等小王回复接口文档；关注项目A的需求变化"
          @keydown.enter.exact="onNewEnter"
        />
        <div class="row">
          <UiCheckbox v-model="viaAssistant" size="sm" class="small" title="交给助理理解时间、对象并关联背景">让助理处理</UiCheckbox>
          <span class="muted small">{{ viaAssistant ? "助理会理解时间和对象、关联背景后建事项" : "按原文建一条待办" }}</span>
          <span class="spacer" />
          <button type="button" class="btn" @click="adding = false">取消</button>
          <button class="btn primary" :disabled="!quick.trim()">添加</button>
        </div>
      </form>
    </div>
    <div v-if="backlogOpen && expiry" class="panel-overlay center" @mousedown.self="backlogOpen = false" @keydown.esc="backlogOpen = false">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="backlog-title">
        <header class="row"><strong id="backlog-title">收尾积压的事项</strong><span class="spacer" /><button class="btn ghost sm icon" aria-label="关闭" @click="backlogOpen = false"><Icon name="x" /></button></header>
        <p class="muted small">这些事项最后一次有进展是在很久以前，按期限已经过了（待办 14 天、待决定和关注 7 天、等待回复 14 天、提醒过后 1 天）。收尾后标为“过期”，不算完成；之后有新进展会自动重新打开，也可以在“显示已完成”里恢复。要留下的勾上。</p>
        <div class="backlog-list">
          <div v-for="b in expiry.backlog" :key="b.id" class="bl row">
            <UiCheckbox :model-value="keepIds.includes(b.id)" size="sm" :aria-label="`保留 ${b.title}`" @change="(v) => toggleKeep(b.id, v)" />
            <div class="bl-main">
              <div class="ttl">{{ b.title }}</div>
              <div class="small muted">{{ itemKindLabel[b.kind] ?? b.kind }} · 最后进展 {{ relTime(b.lastActivity) }}{{ b.spaceId !== "personal" ? ` · ${spaceName(b.spaceId)}` : "" }}</div>
            </div>
          </div>
        </div>
        <div class="row"><span class="muted small">保留 {{ keepIds.length }} 件</span><span class="spacer" /><button class="btn" @click="backlogOpen = false">取消</button><button class="btn primary" @click="applyBacklog">收尾其余 {{ expiry.backlog.length - keepIds.length }} 件</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.item-demo {
  margin: -4px 0 12px;
}
.flow-tag { max-width: 50%; white-space: normal; overflow-wrap: anywhere; flex-shrink: 0; }
.under { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.backlog {
  gap: 10px;
  margin-bottom: 18px;
  color: var(--ink-2);
}
.backlog p {
  flex: 1 1 320px;
  min-width: 0;
  font-size: 14px;
}
.expiring {
  color: var(--warn);
}
.expiry {
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--sunken);
  color: var(--ink-2);
}
.expiry span:not(.spacer) {
  min-width: 0;
  flex: 1 1 200px;
}
.panel-overlay.center {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 8vh;
}
.modal {
  width: min(620px, calc(100vw - 24px));
  max-height: 80vh;
  overflow: auto;
  background: var(--panel);
  border-radius: 14px;
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.backlog-list {
  display: grid;
  border-top: 1px solid var(--line);
}
.bl {
  gap: 10px;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.bl-main {
  min-width: 0;
  flex: 1;
}
.bl .ttl {
  font-size: 14px;
}
.toolbar {
  gap: 10px;
  margin-bottom: 20px;
}
.candidates {
  display: grid;
  gap: 6px;
  margin-bottom: 24px;
}
.candidates .section-title {
  gap: 6px;
  margin: 0;
}
.candidates > p,
.cand-banner p {
  margin: 0;
}
.cand-list {
  display: grid;
  border-top: 1px solid var(--line);
}
.cand {
  gap: 12px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.cand-main {
  display: grid;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.cand-main .ttl {
  color: var(--ink);
  font-size: 14px;
}
.why {
  color: var(--ink-2);
  overflow-wrap: anywhere;
}
.cand-actions {
  gap: 6px;
  flex: none;
}
.cand-banner {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--warn-soft);
  color: var(--ink-2);
  font-size: 14px;
}
.cand-banner .row {
  gap: 6px;
}
@media (max-width: 560px) {
  .cand {
    flex-wrap: wrap;
  }
  .cand-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
.search {
  flex: 0 1 340px;
  min-width: 0;
  gap: 6px;
  padding: 0 6px 0 10px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--muted);
}
.search:focus-within {
  border-color: var(--accent);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
}
.none-found {
  padding: 24px 0;
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
.designs {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.designs .section-title {
  margin-bottom: 4px;
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
