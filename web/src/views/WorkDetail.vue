<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { get, onServerEvent, onServerResync, post, put, type Item } from "../api";
import FlowWaiting from "../components/FlowWaiting.vue";
import Icon from "../components/Icon.vue";
import ItemFlow from "../components/ItemFlow.vue";
import ItemMaterials, { type Material } from "../components/ItemMaterials.vue";
import ItemMetrics from "../components/ItemMetrics.vue";
import LineAsk from "../components/LineAsk.vue";
import Markdown from "../components/Markdown.vue";
import RichText from "../components/RichText.vue";
import Skeleton from "../components/Skeleton.vue";
import Sparkline from "../components/charts/Sparkline.vue";
import UiSelect from "../components/UiSelect.vue";
import WorkChange from "../components/WorkChange.vue";
import WorkEdit from "../components/WorkEdit.vue";
import WorkSheet from "../components/WorkSheet.vue";
import WorkStageTrack from "../components/WorkStageTrack.vue";
import ItemFlowPage from "./ItemFlowPage.vue";
import ListenDetail from "./ListenDetail.vue";
import WorkPhase from "../components/WorkPhase.vue";
import { confirmDialog, promptDialog } from "../lib/dialog";
import { groupOptions, oneLine } from "../lib/listen";
import { pageParam } from "../lib/route";
import {
  byWeek, dayLabel, daysAgo, flatChildren, itemStatusLabel, nextKindLabel, readableIds, waitsForOwner, weekColumns,
  type ChangeLite, type RefTarget, type ChatActivity, type Child, type FlowLite, type LineNow, type NextLite,
} from "../lib/work";
import { itemKindLabel, relTime, state, toast } from "../store";

/**
 * A line's or work item's own page (`#/work/:id`, docs/v2/status.md “工作线”): what it is for and how
 * far its flow has come, what it has been busy with these weeks, its next steps, then its timeline,
 * the items under it, the flow written out stage by stage, the people and groups around it, its 关注
 * and its figures. 问这条线 opens a conversation about it beside the page.
 */
type WItem = Item & { parentId: string | null; now: LineNow | null };
type Detail = {
  item: WItem; ancestors: { id: string; title: string }[]; now: LineNow | null; next: NextLite[]; children: Child[]; timeline: ChangeLite[];
  chats: ChatActivity[]; materials: Material[]; listen: { id: string; status: "active" | "paused" } | null; flow: (FlowLite & { waitingOn: string | null }) | null;
  /** Its life (src/items/lifecycle.ts). */
  phase: "watching" | null; phaseSince: string | null; watchUntil: string | null; summary: string | null;
  ended: { at: string | null; status: string; reason: string | null } | null; openUnder: number;
};
type Tab = "timeline" | "items" | "flow" | "people" | "listen" | "data";

const route = useRoute(), router = useRouter();
const id = pageParam("work");
const d = ref<Detail | null>(null), error = ref(""), loading = ref(true);
const metricCount = ref(0);
const expanded = ref(false);
let seq = 0;
async function load() {
  const n = ++seq, want = id.value;
  if (!want) return;
  try {
    const r = await get<Detail>(`/api/work/${encodeURIComponent(want)}`);
    if (n === seq && want === id.value) { d.value = r; error.value = ""; }
  } catch (e) {
    if (n === seq) error.value = (e as Error).message;
  } finally {
    if (n === seq) loading.value = false;
  }
  const m = await get<unknown[]>(`/api/metrics?item=${encodeURIComponent(want)}`).catch(() => []);
  if (n === seq) metricCount.value = m.length;
}
watch(id, () => { d.value = null; loading.value = true; error.value = ""; expanded.value = false; void load(); }, { immediate: true });
let timer: ReturnType<typeof setTimeout> | undefined;
const off = onServerEvent((e) => {
  if (e.type !== "changed" || e.entity !== "item") return;
  clearTimeout(timer);
  timer = setTimeout(() => void load(), 400);
});
const resync = onServerResync(() => void load());
onBeforeUnmount(() => { ++seq; off(); resync(); clearTimeout(timer); });

const item = computed(() => d.value?.item ?? null);
const top = computed(() => !!item.value && !item.value.parentId);
const isLine = computed(() => item.value?.kind === "line" || (top.value && !!d.value?.children.length));
const editable = computed(() => !!item.value && (!state.me || item.value.userId === state.me.id));
const spaceName = (sid: string) => state.spaces.find((s) => s.id === sid)?.name ?? sid;
const kindWord = computed(() => (!item.value ? "" : isLine.value ? "工作线" : item.value.parentId ? `工作项 · ${itemKindLabel[item.value.kind] ?? item.value.kind}` : itemKindLabel[item.value.kind] ?? item.value.kind));
const tone = computed(() => (d.value?.phase === "watching" ? "watch" : item.value?.status === "waiting" ? "warn" : ["done", "cancelled", "expired"].includes(item.value?.status ?? "") ? "quiet" : "ok"));
const stateWord = computed(() => {
  if (!item.value) return "";
  if (d.value?.ended) return item.value.status === "cancelled" ? "已放弃" : "已结束";
  if (d.value?.phase === "watching") return "观察中";
  return itemStatusLabel[item.value.status] ?? item.value.status;
});

// ---- 观察中 / 已结束 (src/items/lifecycle.ts) ----------------------------------------------------------
const phasing = ref(false), busyPhase = ref(false);
async function setPhase(phase: "active" | "watching" | "done" | "cancelled", days?: number) {
  const x = d.value;
  if (!x || busyPhase.value) return;
  let closeChildren = false;
  if ((phase === "done" || phase === "cancelled") && x.openUnder > 0) {
    const ok = await confirmDialog(`一起结束 ${x.openUnder} 件？`, { message: `「${x.item.title}」下面还有 ${x.openUnder} 件没结。结束这条线会把它们一起${phase === "cancelled" ? "取消" : "结束"}；不想这样就先把它们移出这条线。`, okText: `一起结束 ${x.openUnder} 件` });
    if (!ok) return;
    closeChildren = true;
  }
  busyPhase.value = true;
  try {
    await put(`/api/work/${x.item.id}/phase`, { phase, ...(closeChildren ? { closeChildren } : {}), ...(days ? { days } : {}) });
    phasing.value = false;
    toast(phase === "watching" ? "先观察：期满没有新问题会自己结束" : phase === "active" ? (x.ended ? "重新打开了，关注和指标接着来" : "回到进行中") : phase === "cancelled" ? "放弃了这条线" : "结束了，助手在写收尾小结", "ok");
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busyPhase.value = false;
  }
}

// The goal: the first line of the detail; the rest opens on demand (`expanded`, above).
const goal = computed(() => (item.value?.detail ?? "").trim().split(/\n/)[0]?.replace(/^#+\s*/, "") ?? "");
const more = computed(() => (item.value?.detail ?? "").trim().split(/\n/).length > 1 || goal.value.length > 130);
/** The items and runs the server named on this page (in the changes and next steps), for ids in the goal. */
const targets = computed(() => {
  const all: Record<string, RefTarget> = {};
  for (const x of [...(d.value?.timeline ?? []), ...(d.value?.next ?? [])]) Object.assign(all, x.refTargets ?? {});
  return all;
});

// ---- tabs ----------------------------------------------------------------------------------------
const tabs = computed(() => {
  const x = d.value;
  if (!x) return [];
  const kids = flatChildren(x.children, true).length;
  return [
    { key: "timeline" as Tab, label: `时间线${x.timeline.length ? ` ${x.timeline.length}` : ""}` },
    { key: "items" as Tab, label: `工作项${kids ? ` ${kids}` : ""}` },
    ...(x.flow || !isLine.value ? [{ key: "flow" as Tab, label: "流程" }] : []),
    { key: "people" as Tab, label: "人和群" },
    ...(x.listen ? [{ key: "listen" as Tab, label: "关注设置" }] : []),
    { key: "data" as Tab, label: `数据${metricCount.value ? ` ${metricCount.value}` : ""}` },
  ];
});
const tab = computed<Tab>({
  get: () => {
    const want = String(route.query.tab ?? "");
    if (tabs.value.some((t) => t.key === want)) return want as Tab;
    return d.value?.flow && !isLine.value ? "flow" : "timeline";
  },
  set: (v) => void router.replace({ query: { ...route.query, tab: v } }),
});
function onTabKey(e: KeyboardEvent) {
  const i = tabs.value.findIndex((t) => t.key === tab.value);
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = tabs.value[(i + step + tabs.value.length) % tabs.value.length];
  tab.value = next.key;
  void Promise.resolve().then(() => document.getElementById(`wtab-${next.key}`)?.focus());
}

// ---- 最近忙这些 --------------------------------------------------------------------------------------
const columns = computed(() => (d.value ? weekColumns(d.value.now, d.value.timeline) : []));
const headline = computed(() => d.value?.now?.text || d.value?.timeline[0]?.summary || "");
const kidsTop = computed(() => (d.value?.children ?? []).filter((c) => !["done", "cancelled", "expired"].includes(c.status)).slice(0, 6));
const weeks = computed(() => (d.value ? byWeek(d.value.timeline) : []));

async function refresh() {
  if (!item.value) return;
  try {
    const r = await post<{ runId: string }>(`/api/work/${item.value.id}/refresh`, {});
    toast("在整理现状和下一步，好了这一页会更新", "ok", `#/runs/${r.runId}`);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- next steps and changes on the side ----------------------------------------------------------
const sheet = ref<{ change?: ChangeLite; next?: NextLite } | null>(null);
async function decide(n: NextLite, status: "doing" | "declined") {
  try {
    const r = await put<NextLite>(`/api/item-next/${n.id}`, { status });
    toast(status === "doing" ? "已开始做这一步" : "不做这一步，以后少提这类", "ok", status === "doing" && r.runId ? `#/runs/${r.runId}` : undefined);
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- work items under it ------------------------------------------------------------------------
const kids = computed(() => flatChildren(d.value?.children ?? [], true));
const candidates = ref<(Item & { parentId?: string | null })[]>([]);
const pick = ref("");
async function loadCandidates() {
  candidates.value = await get<(Item & { parentId?: string | null })[]>("/api/items?status=active").catch(() => []);
}
watch(tab, (t) => { if (t === "items" && !candidates.value.length) void loadCandidates(); }, { immediate: true });
const hangable = computed(() => {
  const x = d.value;
  if (!x) return [];
  const taken = new Set([x.item.id, ...x.ancestors.map((a) => a.id), ...kids.value.map((k) => k.child.id)]);
  return candidates.value
    .filter((i) => !taken.has(i.id) && i.kind !== "line" && i.status !== "candidate")
    .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || b.updatedAt.localeCompare(a.updatedAt))
    .map((i) => ({ value: i.id, label: i.title, hint: i.parentId ? "在别的线下" : itemKindLabel[i.kind] ?? i.kind }));
});
async function hang(childId: string | null, parent: string | null) {
  if (!childId) return;
  try {
    await put(`/api/items/${childId}/parent`, { parent });
    toast(parent ? "挂上了" : "已移出，回到顶层", "ok");
    pick.value = "";
    void load();
    void loadCandidates();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function newChild() {
  const x = item.value;
  if (!x) return;
  const title = await promptDialog(`在「${x.title}」下新建工作项`, { placeholder: "比如：退款金额按已发货行计算（需求）", okText: "建" });
  if (!title?.trim()) return;
  try {
    await post("/api/items", { title: title.trim(), parent: x.id, space: x.spaceId });
    void load();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const kidLine = (c: Child) => [
  itemKindLabel[c.kind] ?? c.kind,
  c.flow?.current ? `在「${c.flow.current.name}」` : itemStatusLabel[c.status] ?? c.status,
  c.waitingOn ? `等 ${c.waitingOn}` : "",
  c.dueAt ? `截止 ${dayLabel(c.dueAt)}` : "",
].filter(Boolean).join(" · ");

// ---- people and groups -------------------------------------------------------------------------
const people = computed(() => d.value?.now?.people ?? []);
/** One of the categorical chart colours per name, the same for the same name. */
const hue = (name: string) => `var(--chart-${([...name].reduce((h, ch) => h + ch.charCodeAt(0), 0) % 8) + 1})`;

// The groups the line's 关注 reads: added or let go here (PUT /api/listen/:id; the server keeps the choice
// apart from the groups its items link, src/channels/listen-items.ts), from the groups capture knows.
const captured = ref<{ chatId: string; name: string; kind: string }[]>([]);
const addChat = ref<string | null>(null);
const groupBusy = ref(false);
watch([tab, () => d.value?.listen?.id], ([t, lid]) => {
  if (t === "people" && lid && !captured.value.length) void get<{ chats: { chatId: string; name: string; kind: string }[] }>("/api/lark/captured").then((r) => (captured.value = r.chats)).catch(() => {});
}, { immediate: true });
const addable = computed(() => {
  const have = new Set((d.value?.chats ?? []).map((c) => c.chatId));
  return groupOptions(captured.value).filter((o) => !have.has(o.value)).map((o) => ({ ...o, value: o.value as string | null }));
});
async function setGroups(chats: string[], done: string) {
  const lid = d.value?.listen?.id;
  if (!lid || groupBusy.value) return;
  groupBusy.value = true;
  try {
    await put(`/api/listen/${encodeURIComponent(lid)}`, { chats });
    toast(done, "ok");
    addChat.value = null;
    await load();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    groupBusy.value = false;
  }
}
function addGroup(chatId: string | null) {
  const x = d.value;
  if (!chatId || !x) return;
  const name = captured.value.find((c) => c.chatId === chatId)?.name ?? chatId;
  void setGroups([...x.chats.map((c) => c.chatId), chatId], `开始关注「${oneLine(name)}」：这条线的关注之后也读它的新消息`);
}
async function dropGroup(c: ChatActivity) {
  const x = d.value;
  if (!x) return;
  const name = oneLine(c.name) || c.chatId;
  const ok = await confirmDialog(`不再关注「${name}」？`, { message: "这条线的关注不再读这个群的新消息。群的采集、已有的记忆和挂着的资料不受影响；要再看它，在下面加回来。", okText: "不再关注" });
  if (ok) void setGroups(x.chats.map((y) => y.chatId).filter((id) => id !== c.chatId), `不再关注「${name}」`);
}

// ---- 问这条线 ----------------------------------------------------------------------------------------
const ASK_KEY = "omem.workAsk";
const askOpen = ref((() => { try { return localStorage.getItem(ASK_KEY) === "1"; } catch { return false; } })());
function setAsk(on: boolean) {
  askOpen.value = on;
  try { localStorage.setItem(ASK_KEY, on ? "1" : "0"); } catch { /* private mode */ }
}
const editing = ref(false);
</script>

<template>
  <div class="page work-detail" :class="{ asking: askOpen && item }">
    <div class="body">
      <nav class="crumbs small muted" aria-label="位置">
        <router-link to="/">工作</router-link>
        <template v-for="a in d?.ancestors ?? []" :key="a.id"><span>/</span><router-link :to="`/work/${a.id}`">{{ a.title }}</router-link></template>
      </nav>
      <Skeleton v-if="loading" variant="text" :rows="8" />
      <div v-else-if="error && !d" class="empty">
        <h3>打不开这一页</h3>
        <p>{{ error }}</p>
        <router-link class="btn" to="/">回到工作</router-link>
      </div>
      <template v-else-if="d && item">
        <header class="hero">
          <div class="kind small"><span class="state" :class="tone"><i />{{ stateWord }}</span><span class="muted">{{ kindWord }}</span></div>
          <h1>{{ item.title }}</h1>
          <div v-if="goal && !expanded" class="goal-wrap">
            <RichText tag="p" class="goal" :text="readableIds(goal, targets)" :space="item.spaceId" :lines="3" />
            <button v-if="more" type="button" class="lnk small" @click="expanded = true">展开</button>
          </div>
          <div v-else-if="expanded" class="goal-full"><Markdown :source="readableIds(item.detail, targets)" :space="item.spaceId" compact /><button type="button" class="lnk small" @click="expanded = false">收起</button></div>
          <p class="meta small muted">
            <span v-if="item.dueAt" :class="{ overdue: daysAgo(item.dueAt) > 0 }">截止 {{ dayLabel(item.dueAt) }}</span>
            <span v-if="item.spaceId !== 'personal'">{{ spaceName(item.spaceId) }}</span>
            <span>{{ d.timeline.length }} 条变化</span>
            <span v-if="d.now">{{ dayLabel(d.now.at) }}整理</span>
          </p>
          <div class="acts row wrap">
            <button v-if="editable" type="button" class="btn ghost sm" @click="editing = true"><Icon name="edit" :size="14" />编辑</button>
            <button v-if="top && !d.ended" type="button" class="btn ghost sm" title="现在整理现状和下一步" @click="refresh"><Icon name="refresh" :size="14" />更新</button>
            <button v-if="top && editable && !d.ended" type="button" class="btn ghost sm" title="先观察、现在结束或放弃" @click="phasing = true"><Icon name="flag" :size="14" />收尾</button>
            <button type="button" class="btn sm" :class="{ primary: !askOpen }" :aria-pressed="askOpen" @click="setAsk(!askOpen)"><Icon name="chat" :size="14" />问这条{{ isLine ? "线" : "工作项" }}</button>
          </div>
        </header>

        <!-- 观察中 / 已结束: where the line is in its life, and the one thing to do about it. -->
        <section v-if="d.ended && top" class="phase ended" aria-label="这条线已结束">
          <div class="ph-head">
            <Icon :name="item.status === 'cancelled' ? 'x' : 'check'" :size="16" class="ph-icon" :class="{ dropped: item.status === 'cancelled' }" />
            <span class="ph-text"><strong>{{ item.status === "cancelled" ? "已放弃" : "已结束" }}</strong><template v-if="d.ended.at"> · {{ dayLabel(d.ended.at) }}</template><template v-if="d.ended.reason"> · <RichText :text="readableIds(d.ended.reason, targets)" :space="item.spaceId" /></template></span>
            <button v-if="editable" type="button" class="btn sm" :disabled="busyPhase" @click="setPhase('active')"><Icon name="refresh" :size="14" />重新打开</button>
          </div>
          <div v-if="d.summary" class="ph-summary">
            <div class="ph-label small muted">收尾小结</div>
            <Markdown :source="d.summary" class="prose" />
          </div>
          <p v-else-if="d.ended.at && daysAgo(d.ended.at) < 1 && (item.kind === 'line' || d.children.length)" class="small muted ph-note">收尾小结还在写，写好会出现在这里。</p>
        </section>
        <section v-else-if="d.phase === 'watching' && top" class="phase watch" aria-label="这条线在观察中">
          <div class="ph-head">
            <Icon name="eye" :size="16" class="ph-icon" />
            <span class="ph-text"><strong>观察中</strong><template v-if="d.watchUntil"> · 到 {{ dayLabel(d.watchUntil) }}</template> · 期间群和指标照看；没有新问题会自动结束</span>
            <span v-if="editable" class="row ph-acts">
              <button type="button" class="btn sm" :disabled="busyPhase" @click="setPhase('done')">现在结束</button>
              <button type="button" class="btn sm ghost" :disabled="busyPhase" @click="setPhase('active')">回到进行中</button>
            </span>
          </div>
        </section>

        <section v-if="d.flow" class="flow" aria-label="流程进度">
          <div class="flow-head small muted">{{ d.flow.name }}<template v-if="d.flow.current"> · 现在在「{{ d.flow.current.name }}」</template></div>
          <WorkStageTrack :flow="d.flow" />
          <FlowWaiting :item="{ id: item.id, title: item.title, spaceId: item.spaceId }" :editable="editable" />
        </section>

        <section class="busy" aria-labelledby="busy-title">
          <h2 id="busy-title" class="h2">最近忙这些</h2>
          <div class="busy-grid" :class="{ solo: !kidsTop.length }">
            <nav v-if="kidsTop.length" class="threads" aria-label="下面的工作项">
              <router-link v-for="c in kidsTop" :key="c.id" :to="`/work/${c.id}`" class="thread" :class="{ mine: waitsForOwner(c) }">
                <span class="tt">{{ c.title }}</span>
                <WorkStageTrack v-if="c.flow" :flow="c.flow" mini />
              </router-link>
            </nav>
            <div class="weekcard card">
              <p v-if="headline" class="headline">{{ headline }}</p>
              <p v-else class="headline muted">{{ top ? "还没整理过现状。" : "还没有记下的变化。" }}<button v-if="top" type="button" class="lnk" @click="refresh">现在整理</button></p>
              <ol class="weeks">
                <li v-for="w in columns" :key="w.label" :class="{ quiet: !w.text }">
                  <span class="wl"><Icon name="calendar" :size="13" />{{ w.label }}</span>
                  <span class="wt">{{ w.text || "暂无进展" }}</span>
                </li>
              </ol>
            </div>
          </div>
        </section>

        <section v-if="d.next.length" class="next" aria-labelledby="next-title">
          <h2 id="next-title" class="h2">下一步</h2>
          <div v-for="n in d.next" :key="n.id" class="step">
            <span class="ring" :class="{ doing: n.status === 'doing' }" aria-hidden="true" />
            <div class="sbody">
              <button type="button" class="stext" @click="sheet = { next: n }">{{ n.text }}</button>
              <span class="small muted swhy">{{ nextKindLabel[n.kind] }}<template v-if="n.why"> · <RichText :text="readableIds(n.why, n.refTargets)" :space="item.spaceId" /></template></span>
            </div>
            <div v-if="n.status === 'open'" class="row sacts">
              <button class="btn sm" @click="decide(n, 'doing')">就这么做</button>
              <button class="btn sm ghost" @click="decide(n, 'declined')">不用</button>
            </div>
            <router-link v-else-if="n.runId" :to="`/runs/${n.runId}`" class="small">在做 · 看运行</router-link>
          </div>
        </section>

        <div class="tabs" role="tablist" aria-label="这一页的几部分" @keydown="onTabKey">
          <button v-for="t in tabs" :id="`wtab-${t.key}`" :key="t.key" type="button" role="tab" :aria-selected="tab === t.key" :tabindex="tab === t.key ? 0 : -1" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
        </div>

        <div class="panel" role="tabpanel" :aria-labelledby="`wtab-${tab}`">
          <!-- 时间线 -->
          <template v-if="tab === 'timeline'">
            <p v-if="!d.timeline.length" class="muted">还没有记下的关键变化。事项跟进读群和文档、流程的阶段做完或卡住、指标越过门槛、在跟的问题有了结论，都会记在这里。</p>
            <section v-for="g in weeks" :key="g.n" class="week">
              <h3 class="wh">{{ g.label }}<span class="muted">{{ g.items.length }} 条</span></h3>
              <WorkChange v-for="c in g.items" :key="c.id" :change="c" :line-id="item.id" @open="(x) => (sheet = { change: x })" @changed="load" />
            </section>
          </template>

          <!-- 工作项 -->
          <template v-else-if="tab === 'items'">
            <div v-if="editable" class="row wrap hang">
              <UiSelect v-model="pick" :options="hangable" :search-at="0" placeholder="把一件事项挂到这里…" aria-label="挂一件事项到这里" width="min(360px, 100%)" @change="(v) => hang(v, item!.id)" />
              <button type="button" class="btn sm" @click="newChild"><Icon name="plus" :size="14" />新建工作项</button>
            </div>
            <p v-if="!kids.length" class="muted">下面还没有工作项。需求、缺陷、评审、待办都可以挂在这里；缺陷可以再挂在需求下面，最多三层。</p>
            <div v-else class="kids">
              <div v-for="k in kids" :key="k.child.id" class="kid" :class="{ deep: k.depth > 0, closed: ['done', 'cancelled', 'expired'].includes(k.child.status), mine: waitsForOwner(k.child) }" :style="{ '--depth': k.depth }">
                <div class="km">
                  <router-link :to="`/work/${k.child.id}`" class="kt">{{ k.child.title }}</router-link>
                  <span class="small muted">{{ kidLine(k.child) }}</span>
                  <WorkStageTrack v-if="k.child.flow" :flow="k.child.flow" mini />
                </div>
                <span v-if="waitsForOwner(k.child)" class="badge warn">等你</span>
                <button v-if="editable && k.depth === 0" type="button" class="btn ghost sm" :title="`把「${k.child.title}」移出这条线`" @click="hang(k.child.id, null)">移出</button>
              </div>
            </div>
          </template>

          <!-- 流程 -->
          <template v-else-if="tab === 'flow'">
            <ItemFlowPage v-if="d.flow" :id="item.id" embedded />
            <ItemFlow v-else :item-id="item.id" :editable="editable" />
          </template>

          <!-- 人和群 -->
          <template v-else-if="tab === 'people'">
            <section class="sub">
              <h3 class="sh">工作伙伴</h3>
              <p v-if="!people.length" class="muted small">{{ top ? "每天整理现状时会写下这条线上有谁、各做什么。" : "人写在上层工作线的现状里。" }}</p>
              <div v-for="p in people" :key="p.name" class="person">
                <span class="avatar" :style="{ background: hue(p.name) }" aria-hidden="true">{{ p.name.trim().slice(0, 1) }}</span>
                <span class="pname">{{ p.name }}</span>
                <span class="role">{{ p.role }}</span>
              </div>
            </section>
            <section class="sub">
              <h3 class="sh">相关群聊</h3>
              <p v-if="!d.chats.length" class="muted small">{{ d.listen ? "这条线的关注还没有群：在下面加一个，或把群聊挂成资料。" : "这条线还没有群。把群聊挂成资料；点上面的“更新”会建好它的关注，之后可以在这里加群。" }}</p>
              <div v-for="c in d.chats" :key="c.chatId" class="chat">
                <Icon name="chat" :size="16" />
                <span class="cm"><span class="cn">{{ c.name || c.chatId }}</span><span class="small muted">消息 {{ c.total }} 条{{ c.lastAt ? ` · 最近 ${relTime(c.lastAt)}` : "" }}</span></span>
                <Sparkline class="spark" :values="c.perDay" :label="`${c.name} 最近 14 天每天的消息：${c.perDay.join('、')}`" />
                <button v-if="d.listen && editable" type="button" class="btn ghost sm drop" :disabled="groupBusy" :title="`这条线的关注不再读「${c.name || c.chatId}」`" @click="dropGroup(c)">不再关注</button>
              </div>
              <p v-if="d.chats.length" class="small muted cap">{{ d.listen ? "这条线的关注读这些群。" : "" }}右边是最近 14 天每天的消息数。</p>
              <div v-if="d.listen && editable && addable.length" class="row wrap add-group">
                <UiSelect v-model="addChat" :options="addable" :search-at="0" placeholder="再关注一个群…" aria-label="再关注一个群" width="min(320px, 100%)" :disabled="groupBusy" @change="addGroup" />
              </div>
            </section>
            <section class="sub">
              <h3 class="sh">相关资料</h3>
              <ItemMaterials :item-id="item.id" :materials="d.materials" @changed="load" />
            </section>
          </template>

          <!-- 关注设置: what its 关注 is told and how it reads and replies; the groups are in 人和群. -->
          <template v-else-if="tab === 'listen' && d.listen">
            <ListenDetail :id="d.listen.id" embedded />
          </template>

          <!-- 数据 -->
          <template v-else-if="tab === 'data'">
            <ItemMetrics :item-id="item.id" />
            <p v-if="!metricCount" class="muted">这条线还没有挂指标。助手按技能 observation-plan 写观测计划、建好指标后，会出现在这里。</p>
          </template>
        </div>
      </template>
    </div>

    <LineAsk v-if="askOpen && item" class="ask" :item-id="item.id" :title="item.title" :space-id="item.spaceId" :listen-id="d?.listen?.id ?? null" :line="isLine" @close="setAsk(false)" />
    <WorkSheet v-if="sheet" :change="sheet.change" :next="sheet.next" :line-title="item?.title" @close="sheet = null" @changed="load" />
    <WorkEdit v-if="editing && item" :item="item" @close="editing = false" @saved="load" />
    <WorkPhase v-if="phasing && item" :title="item.title" :watching="d?.phase === 'watching'" @close="phasing = false" @pick="(p, days) => setPhase(p, days)" />
  </div>
</template>

<style scoped>
.work-detail { max-width: 1000px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; }
.work-detail.asking { max-width: 1400px; grid-template-columns: minmax(0, 1fr) 380px; align-items: start; }
.body { min-width: 0; display: grid; gap: 22px; grid-template-columns: minmax(0, 1fr); align-content: start; }
.ask { position: sticky; top: 16px; height: calc(100vh - 32px); }
.crumbs { display: flex; flex-wrap: wrap; gap: 6px; }
.crumbs a { color: var(--muted); overflow-wrap: anywhere; }

.hero { text-align: center; display: grid; gap: 8px; justify-items: center; padding: 12px 0 4px; }
.kind { display: flex; gap: 10px; align-items: center; justify-content: center; }
.state { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); }
.state i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.state.ok i { background: var(--ok); }
.state.warn i { background: var(--warn); }
.hero h1 { font-family: var(--serif); font-size: 30px; line-height: 1.3; margin: 0; max-width: 760px; overflow-wrap: anywhere; }
.swhy :deep(code) { font-size: 12px; overflow-wrap: anywhere; word-break: break-all; }
.goal-wrap { display: grid; justify-items: center; gap: 2px; max-width: 680px; }
.goal { margin: 0; color: var(--ink-2); line-height: 1.7; overflow-wrap: anywhere; }
/* Ids, hashes and paths in the goal (readableIds): small monospace, and they may break anywhere. */
.goal :deep(code), .goal-full :deep(code) { font-size: 12px; overflow-wrap: anywhere; word-break: break-all; }
.goal-full { max-width: 720px; text-align: left; display: grid; gap: 4px; justify-items: start; }
.meta { display: flex; flex-wrap: wrap; justify-content: center; gap: 2px 12px; margin: 0; }
.overdue { color: var(--danger); }
.acts { gap: 6px; justify-content: center; }

.flow { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); min-width: 0; }
.state.watch { color: var(--accent); }
.state.watch i { background: transparent; border: 1.5px solid var(--accent); width: 8px; height: 8px; box-sizing: border-box; }

/* 观察中 / 已结束: one band under the title. */
.phase { display: grid; gap: 10px; padding: 12px 16px; border-radius: var(--radius); border: 1px solid var(--line); min-width: 0; }
.phase.watch { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.phase.ended { background: var(--sunken); }
.ph-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; min-width: 0; }
.ph-icon { flex: none; }
.phase.watch .ph-icon { color: var(--accent); }
.phase.ended .ph-icon { color: var(--ok); }
.phase.ended .ph-icon.dropped { color: var(--muted); }
.ph-text { flex: 1; min-width: min(240px, 100%); font-size: 14px; line-height: 1.6; color: var(--ink-2); overflow-wrap: anywhere; }
.ph-text strong { color: var(--ink); }
.ph-acts { gap: 6px; flex: none; }
.ph-summary { display: grid; gap: 4px; padding-top: 10px; border-top: 1px dashed var(--line-strong); min-width: 0; }
.ph-label { letter-spacing: 0.04em; font-weight: 600; }
.ph-note { margin: 0; }
.h2 { font-family: var(--serif); font-size: 18px; font-weight: 650; margin: 0 0 10px; }
.busy-grid { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 14px; align-items: start; }
.busy-grid.solo { grid-template-columns: minmax(0, 1fr); }
.threads { display: grid; gap: 2px; min-width: 0; }
.thread { display: grid; gap: 4px; padding: 8px 10px; border-radius: 8px; color: var(--ink-2); font-size: 13.5px; min-width: 0; }
.thread:hover { background: var(--hover); text-decoration: none; color: var(--ink); }
.thread.mine { background: var(--warn-soft); color: var(--ink); }
.tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.weekcard { padding: 18px 20px; display: grid; gap: 16px; min-width: 0; box-shadow: var(--shadow); }
.headline { margin: 0; font-family: var(--serif); font-size: 17px; font-weight: 650; line-height: 1.6; overflow-wrap: anywhere; }
.headline .lnk { font-family: var(--sans); font-size: 14px; font-weight: 400; margin-left: 6px; }
.weeks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.weeks li { display: grid; gap: 6px; align-content: start; padding-left: 12px; border-left: 1.5px dashed var(--line-strong); min-width: 0; }
.wl { display: flex; gap: 5px; align-items: center; font-size: 12.5px; font-weight: 600; color: var(--ink); }
.wl :deep(svg) { flex: none; }
.wl :deep(svg) { color: var(--muted); }
.wt { font-size: 13px; line-height: 1.6; color: var(--ink-2); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.weeks li.quiet .wt, .weeks li.quiet .wl { color: var(--muted); font-weight: 400; }

.next { display: grid; gap: 4px; }
.step { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.step:last-child { border-bottom: 0; }
.ring { width: 12px; height: 12px; border-radius: 50%; border: 2px dashed var(--muted); flex: none; margin-top: 5px; }
.ring.doing { border-color: var(--accent); }
.sbody { flex: 1; min-width: 0; display: grid; gap: 2px; }
.stext { all: unset; cursor: pointer; font-size: 14.5px; line-height: 1.55; color: var(--ink); overflow-wrap: anywhere; }
.stext:hover { text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.stext:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
.sacts { gap: 6px; flex: none; }

.tabs { margin-bottom: 0; }
.panel { display: grid; gap: 12px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.week { display: grid; gap: 8px; }
.wh { display: flex; gap: 8px; align-items: baseline; font-size: 14px; font-weight: 650; margin: 8px 0 0; }
.wh .muted { font-size: 12px; font-weight: 400; }
.hang { gap: 8px; }
.kids { display: grid; border-top: 1px solid var(--line); }
.kid { display: flex; gap: 10px; align-items: center; padding: 10px 0 10px calc(var(--depth) * 22px); border-bottom: 1px solid var(--line); min-width: 0; }
.kid.deep .km { border-left: 2px solid var(--line); padding-left: 10px; }
.kid.closed .kt { color: var(--muted); text-decoration: line-through; }
.km { flex: 1; min-width: 0; display: grid; gap: 3px; justify-items: start; }
.kt { color: var(--ink); font-size: 14.5px; overflow-wrap: anywhere; }
.kid.mine .kt { font-weight: 600; }
.sub { display: grid; gap: 4px; min-width: 0; margin-bottom: 14px; }
.sh { font-size: 12px; font-weight: 600; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 4px; }
.person { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: #fff; font-size: 13px; font-weight: 600; flex: none; }
.pname { font-weight: 600; font-size: 14px; flex: none; }
.role { margin-left: auto; padding: 3px 10px; border-radius: 999px; background: var(--sunken); color: var(--ink-2); font-size: 12.5px; text-align: right; overflow-wrap: anywhere; min-width: 0; }
.chat { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); min-width: 0; }
.chat > :deep(svg) { color: var(--muted); flex: none; }
.cm { flex: 1; min-width: 0; display: grid; gap: 1px; }
.cn { font-size: 14px; overflow-wrap: anywhere; }
.spark { width: 120px; flex: none; }
.chat .drop { flex: none; }
.cap { margin: 2px 0 0; }
.add-group { margin-top: 6px; }

@media (max-width: 1000px) {
  .work-detail.asking { grid-template-columns: minmax(0, 1fr); }
  .ask { position: fixed; top: 0; right: 0; bottom: 0; height: auto; width: min(480px, 100vw); z-index: 36; border-radius: 0; box-shadow: var(--shadow-lg); }
}
@media (max-width: 760px) {
  .hero h1 { font-size: 24px; }
  .busy-grid { grid-template-columns: minmax(0, 1fr); }
  .weeks { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .step { flex-wrap: wrap; }
  .sacts { margin-left: 22px; }
  .spark { width: 80px; }
}
</style>
