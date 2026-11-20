<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, onServerEvent, post, put } from "../api";
import { fmtTime, memoryKindLabel, openCitation, relTime, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";
import {
  ASSIST_OPTIONS, BACKLOG_OPTIONS, batchOptions, DEPTH_OPTIONS, groupOptions, KIND_LABEL, KNOB, lines, LISTEN_OPTIONS, MEETING_OPTIONS, oneLine, OTHERS_ASKS_OPTIONS, OUTCOME_LABEL,
  OWNER_ASKS_OPTIONS, perDayOptions, PREFILTER_OPTIONS, REPLY_OPTIONS, replyLabel, STRICTNESS_OPTIONS,
  type ChatDetail, type ListenDetail, type ListenKnobs, type ListenMemory, type ListenView,
} from "../lib/listen";
import { dayLabel } from "../lib/work";
import DemoControl from "../components/DemoControl.vue";
import Icon from "../components/Icon.vue";
import ListenCases from "../components/ListenCases.vue";
import ListenNewDialog from "../components/ListenNewDialog.vue";
import Markdown from "../components/Markdown.vue";
import MemoryText from "../components/MemoryText.vue";
import Skeleton from "../components/Skeleton.vue";
import UiCheckbox from "../components/UiCheckbox.vue";
import UiSegmented from "../components/UiSegmented.vue";
import UiSelect from "../components/UiSelect.vue";

/**
 * One 关注 (/listen/:id) or one Feishu group (/lark/chats/:chatId). A 关注's page: its name and one line of
 * facts, its groups folded into “N 个群”, then tabs — 在聊什么, 经验和案例, 记忆, 处理记录, 设置 (last; the
 * on/off switch and 删除 stay in the header). A group's page lists the 关注 it is in (and starts or joins
 * one), then its cases and memories.
 * `id` + `embedded`: one 关注 inside a work line's page (views/WorkDetail.vue, its 关注设置 tab): no title
 * and no groups (the line's page has its own, and its 人和群 tab edits them), only 设置 and 经验和案例.
 */
const props = defineProps<{ id?: string; embedded?: boolean }>();
const route = useRoute();
const router = useRouter();
const listenId = computed(() => props.id ?? (typeof route.params.id === "string" ? route.params.id : ""));
const chatId = computed(() => (props.id ? "" : typeof route.params.chatId === "string" ? route.params.chatId : ""));

const detail = ref<ListenDetail | null>(null);
const chat = ref<ChatDetail | null>(null);
const loading = ref(true);
const error = ref("");
const c = computed(() => detail.value?.context ?? null);
let seq = 0;

async function load(quiet = false) {
  const my = ++seq;
  const lid = listenId.value, cid = chatId.value;
  if (!quiet) {
    loading.value = true;
    detail.value = null;
    chat.value = null;
  }
  error.value = "";
  try {
    if (cid) {
      const d = await get<ChatDetail>(`/api/lark/chats/${encodeURIComponent(cid)}/detail`);
      if (my !== seq) return;
      chat.value = d;
    } else if (lid) {
      const d = await get<ListenDetail>(`/api/listen/${encodeURIComponent(lid)}`);
      if (my !== seq) return;
      detail.value = d;
      // A refresh in the background leaves what the owner is typing alone.
      if (!quiet || !dirty.value) resetForm(d.context);
    }
  } catch (e) {
    if (my === seq) error.value = (e as Error).message;
  } finally {
    if (my === seq) loading.value = false;
  }
}
watch([listenId, chatId], () => void load(), { immediate: true });

// Groups a 关注 can read (the chat list, with when each last had a message), and on a group's page the 关注 it can join.
type Captured = { chatId: string; name: string; kind: string; lastMessageAt?: string | null };
const captured = ref<Captured[]>([]);
if (!props.embedded) void get<{ chats: Captured[] }>("/api/lark/captured").then((r) => (captured.value = r.chats)).catch(() => {});
const allListens = ref<ListenView[]>([]);
watch(chatId, (id) => id && void get<ListenView[]>("/api/listen").then((r) => (allListens.value = r)).catch(() => {}), { immediate: true });
const groupOpts = computed(() => groupOptions(captured.value, c.value?.groups ?? (chat.value ? [chat.value.chat] : [])));

// ---- the header ------------------------------------------------------------------------------------
const isDefault = computed(() => c.value?.kind === "default");
const groupsOpen = ref(false);
/** Its groups, most recently active first, each with when it last had a message (capture's chat list). */
const groupRows = computed(() => {
  const last = new Map(captured.value.map((x) => [x.chatId, x.lastMessageAt ?? null]));
  return (c.value?.groups ?? [])
    .map((g) => ({ ...g, name: oneLine(g.name) || g.id, lastAt: last.get(g.id) ?? null }))
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
});
/** The line this 关注 is on has launched and is being watched (items/lifecycle.ts). */
const watching = computed(() => (c.value?.kind === "item" && c.value.item?.phase === "watching" ? c.value.item : null));

// ---- tabs ----------------------------------------------------------------------------------------
type Tab = "summary" | "lessons" | "memories" | "handling" | "settings" | "cases";
const cases = computed(() => detail.value?.cases ?? chat.value?.cases ?? []);
const memories = computed<ListenMemory[]>(() => detail.value?.memories ?? chat.value?.memories ?? []);
const num = (n: number) => (n ? ` ${n}` : "");
const tabs = computed<{ key: Tab; label: string }[]>(() => {
  if (chat.value) return [{ key: "cases", label: `案例${num(cases.value.length)}` }, { key: "memories", label: `记忆${num(memories.value.length)}` }];
  if (!c.value) return [];
  const lessons = { key: "lessons" as Tab, label: `经验和案例${num(cases.value.length)}` };
  const settings = { key: "settings" as Tab, label: "设置" };
  if (props.embedded) return [settings, lessons];
  if (isDefault.value) return [lessons, settings];
  return [
    { key: "summary", label: "在聊什么" },
    lessons,
    { key: "memories", label: `记忆${num(memories.value.length)}` },
    { key: "handling", label: "处理记录" },
    settings,
  ];
});
// The page keeps its tab in the address; inside a line's page (which has its own tabs there) it keeps it here.
const innerTab = ref<Tab | "">("");
const tab = computed<Tab>({
  get: () => {
    const want = props.embedded ? innerTab.value : String(route.query.tab ?? "");
    return tabs.value.find((t) => t.key === want)?.key ?? tabs.value[0]?.key ?? "settings";
  },
  set: (v) => {
    if (props.embedded) innerTab.value = v;
    else void router.replace({ query: { ...route.query, tab: v } });
  },
});
function onTabKey(e: KeyboardEvent) {
  const i = tabs.value.findIndex((t) => t.key === tab.value);
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const next = tabs.value[(i + step + tabs.value.length) % tabs.value.length];
  tab.value = next.key;
  void Promise.resolve().then(() => document.getElementById(`ltab-${next.key}`)?.focus());
}
const tabOptions = computed(() => tabs.value.map((t) => ({ value: t.key, label: t.label })));

// ---- settings form -----------------------------------------------------------------------------
type KnobForm = Pick<ListenKnobs, "listen" | "depth" | "reply" | "ownerAsks" | "othersAsks" | "backlog" | "meetings" | "batchMinutes" | "perDay"> & {
  assist: "off" | "suggest" | "act";
  strictness: number | null;
  prefilter: "global" | "on" | "off";
};
type Form = { note: string; chats: string[]; handle: string; skip: string; valid: string; knobs: KnobForm };
function toForm(v: ListenView): Form {
  const k = v.knobs;
  return {
    note: v.note ?? "",
    chats: [...v.chats],
    handle: (v.brief?.handle ?? []).join("\n"),
    skip: (v.brief?.skip ?? []).join("\n"),
    valid: v.brief?.valid ?? "",
    knobs: {
      listen: k.listen, depth: k.depth, reply: k.reply, ownerAsks: k.ownerAsks, othersAsks: k.othersAsks, backlog: k.backlog, meetings: k.meetings,
      assist: k.assist ?? "off", batchMinutes: k.batchMinutes, perDay: k.perDay, strictness: k.strictness ?? null,
      prefilter: k.prefilter === undefined ? "global" : k.prefilter ? "on" : "off",
    },
  };
}
const form = reactive<Form>({ note: "", chats: [], handle: "", skip: "", valid: "", knobs: {} as KnobForm });
const snapshot = ref("");
function resetForm(v: ListenView) {
  const f = toForm(v);
  Object.assign(form, f);
  snapshot.value = JSON.stringify(f);
}
const dirty = computed(() => !!snapshot.value && JSON.stringify(form) !== snapshot.value);
const saving = ref(false);
const unconfirmed = computed(() => !!c.value?.brief && (!c.value.brief.confirmedAt || (c.value.brief.at ?? "") > c.value.brief.confirmedAt));
/**
 * A matter's 关注 that does not reply has no handler reading its groups batch by batch: item-follow reads
 * them and notes what changed (src/channels/lark-watch.ts). The knobs for that handler apply once replies are on.
 */
const readsOnly = computed(() => c.value?.kind === "item" && form.knobs.reply === "none");

async function save() {
  const v = c.value;
  if (!v || saving.value) return;
  const was = JSON.parse(snapshot.value) as Form;
  const handle = lines(form.handle), skip = lines(form.skip);
  const problem =
    handle.length > 12 || skip.length > 12 ? "要处理的、不处理的各最多 12 条"
    : v.kind !== "default" && form.knobs.reply !== "none" && !handle.length ? "要在群里回复，先写要处理哪些消息（或回复选“不回，只看”）"
    : v.kind === "place" && !form.chats.length ? "关注至少要有一个群"
    : "";
  if (problem) {
    toast(problem, "error");
    return;
  }
  const body: Record<string, unknown> = {};
  if (form.note !== was.note) body.note = form.note.trim();
  if (form.handle !== was.handle || form.skip !== was.skip || form.valid !== was.valid || unconfirmed.value) body.brief = { handle, skip, valid: form.valid.trim() };
  // A matter's groups are edited on its line's page (人和群), never sent from here.
  if (v.kind === "place" && form.chats.join("\n") !== was.chats.join("\n")) body.chats = form.chats;
  const knobs: Record<string, unknown> = {};
  for (const key of Object.keys(form.knobs) as (keyof KnobForm)[]) {
    const now = form.knobs[key];
    if (JSON.stringify(now) === JSON.stringify(was.knobs[key])) continue;
    knobs[key] = key === "prefilter" ? (now === "global" ? null : now === "on") : now;
  }
  if (Object.keys(knobs).length) body.knobs = knobs;
  saving.value = true;
  try {
    const next = await put<ListenView>(`/api/listen/${encodeURIComponent(v.id)}`, body);
    if (detail.value?.context.id === next.id) {
      detail.value = { ...detail.value, context: next };
      resetForm(next);
    }
    toast("已保存", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

/** Changes outside the form (name, on/off) keep what is being typed in it. */
async function update(body: Record<string, unknown>, done: string) {
  const v = c.value;
  if (!v) return;
  try {
    const next = await put<ListenView>(`/api/listen/${encodeURIComponent(v.id)}`, body);
    if (detail.value?.context.id === next.id) detail.value = { ...detail.value, context: next };
    toast(done, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
async function rename() {
  const v = c.value;
  if (!v) return;
  const name = await promptDialog("改名", { value: v.name, okText: "保存", message: "经验按名字存成文件：改名后会另起一份，之前的经验要重新整理一次才会接上。" });
  if (name?.trim() && name.trim() !== v.name) await update({ name: name.trim() }, "已改名");
}
const setStatus = (on: boolean) => update({ status: on ? "active" : "paused" }, on ? "继续关注" : "已暂停：不再处理这些群的新消息");
async function remove() {
  const v = c.value;
  if (!v) return;
  if (!(await confirmDialog(`删除关注「${v.name}」？`, { message: "它不再处理这些群的消息，处理它的会话会归档；群的采集和已有的记忆不受影响。只想停一阵，用暂停。", okText: "删除", danger: true }))) return;
  try {
    await del(`/api/listen/${encodeURIComponent(v.id)}`);
    toast(`已删除：${v.name}`, "ok");
    void router.push("/");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

// ---- lessons -----------------------------------------------------------------------------------
const coachBusy = computed(() => !!detail.value?.coaching && ["queued", "running"].includes(detail.value.coaching.status));
async function coach() {
  const v = c.value;
  if (!v || !detail.value) return;
  try {
    const r = await post<{ runId?: string; queued?: boolean; message?: string }>(`/api/listen/${encodeURIComponent(v.id)}/coach`);
    if (r.runId && detail.value?.context.id === v.id) detail.value = { ...detail.value, coaching: { id: r.runId, status: "queued" } };
    toast(r.runId ? "开始重新整理经验，整理完这里会更新" : (r.message ?? "已经有一次整理在排队"), r.runId ? "ok" : "info");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
const off = onServerEvent((e) => {
  const d = detail.value;
  if (e.type !== "run" || !d?.coaching || d.coaching.id !== e.runId) return;
  detail.value = { ...d, coaching: { id: e.runId, status: e.status } };
  if (e.status === "done" || e.status === "failed" || e.status === "cancelled") void load(true);
});
onBeforeUnmount(off);

// ---- a group's page ----------------------------------------------------------------------------
const creating = ref(false);
const joinTo = ref<string | null>(null);
const joinable = computed(() =>
  allListens.value.filter((v) => v.kind !== "default" && !v.chats.includes(chatId.value)).map((v) => ({ value: v.id as string | null, label: v.name, hint: v.status === "active" ? KIND_LABEL[v.kind] : "已暂停" })),
);
async function join() {
  const v = allListens.value.find((x) => x.id === joinTo.value);
  if (!v) return;
  try {
    await put(`/api/listen/${encodeURIComponent(v.id)}`, { chats: [...v.chats, chatId.value] });
    toast(`已加入关注：${v.name}`, "ok");
    joinTo.value = null;
    allListens.value = await get<ListenView[]>("/api/listen").catch(() => allListens.value);
    void load(true);
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
function created(v: ListenView) {
  creating.value = false;
  void router.push(`/listen/${encodeURIComponent(v.id)}`);
}
/** 关注 names by id, to label a group's cases. */
const contextNames = computed(() => Object.fromEntries([...allListens.value, ...(chat.value?.contexts ?? []), ...(chat.value?.paused ?? [])].map((v) => [v.id, v.name])));
const outcomeTone = { handled: "ok", quiet: "", screened: "" } as const;
</script>

<template>
  <div class="listen-page" :class="{ embedded }">
    <nav v-if="!embedded" class="crumbs small muted"><router-link to="/">工作</router-link><span>/</span><span>{{ chatId ? "飞书群" : "关注" }}</span></nav>
    <Skeleton v-if="loading" variant="text" :rows="7" />
    <div v-else-if="error && !detail && !chat" class="empty">
      <h3>打不开这一页</h3>
      <p>{{ error }}</p>
      <router-link class="btn" to="/">回到工作页</router-link>
    </div>

    <template v-else-if="detail || chat">
      <!-- one 关注: name, one line of facts, its groups folded up -->
      <header v-if="detail && c && !embedded" class="head">
        <div class="title-row">
          <div class="title">
            <h1>{{ c.name }}</h1>
            <button v-if="!isDefault" type="button" class="btn ghost sm icon" title="改名" aria-label="改名" @click="rename"><Icon name="edit" :size="15" /></button>
          </div>
          <div v-if="!isDefault" class="head-acts row">
            <UiCheckbox switch size="sm" :model-value="c.status === 'active'" :aria-label="`关注 ${c.name}`" @change="setStatus">{{ c.status === "active" ? "关注中" : "已暂停" }}</UiCheckbox>
            <button type="button" class="btn ghost sm danger" @click="remove"><Icon name="trash" :size="14" />删除</button>
          </div>
        </div>
        <p class="facts small muted">
          <span v-if="c.item"><router-link :to="`/work/${c.item.id}`">{{ c.item.title === c.name ? "这条工作线" : `工作线「${c.item.title}」` }}</router-link>的关注</span>
          <span v-else>{{ isDefault ? "所有私聊和 @ 你的消息" : `${KIND_LABEL[c.kind]}关注` }}</span>
          <template v-if="!isDefault"><span>·</span><span :title="fmtTime(c.since)">{{ fmtTime(c.since, false) }} 开始</span></template>
          <template v-if="c.expiresAt"><span>·</span><span :title="fmtTime(c.expiresAt)">{{ dayLabel(c.expiresAt) }}停</span></template>
          <span>·</span><span>案例 {{ c.stats.cases }}<template v-if="c.stats.corrections"> · 你纠正过 {{ c.stats.corrections }}</template><template v-if="c.stats.ownReplies"> · 你自己回了 {{ c.stats.ownReplies }}</template></span>
        </p>
        <div v-if="groupRows.length" class="groups">
          <button v-if="groupRows.length > 1" type="button" class="groups-toggle small" :aria-expanded="groupsOpen" aria-controls="ls-groups" @click="groupsOpen = !groupsOpen">
            {{ groupRows.length }} 个群<Icon name="down" :size="14" class="caret" :class="{ open: groupsOpen }" />
          </button>
          <span v-else class="small muted one-group">1 个群：<router-link :to="`/lark/chats/${encodeURIComponent(groupRows[0].id)}`">{{ groupRows[0].name }}</router-link></span>
          <ul v-if="groupsOpen && groupRows.length > 1" id="ls-groups" class="group-list">
            <li v-for="g in groupRows" :key="g.id">
              <router-link :to="`/lark/chats/${encodeURIComponent(g.id)}`" class="gname" :title="g.name">{{ g.name }}</router-link>
              <span class="small muted gwhen" :title="g.lastAt ? fmtTime(g.lastAt) : ''">{{ g.lastAt ? `最近一条 ${relTime(g.lastAt)}` : "还没采集到消息" }}</span>
            </li>
          </ul>
        </div>
        <p v-if="watching" class="watch-note small" role="note"><Icon name="eye" :size="14" />这条线在观察中<template v-if="watching.watchUntil">（到 {{ dayLabel(watching.watchUntil) }}）</template>：已经上线，助手只关心报错、用户反馈和数据异常，普通讨论不处理。</p>
        <p v-if="unconfirmed && tab !== 'settings'" class="confirm-note small" role="note">关注说明是助手{{ c.brief?.confirmedAt ? "改过" : "拟" }}的，还没经你确认。<button type="button" class="lnk" @click="tab = 'settings'">去看看</button></p>
        <DemoControl :context-id="c.id" :name="c.name" />
      </header>

      <!-- one group -->
      <template v-if="chat">
        <header class="head">
          <div class="title"><h1>{{ oneLine(chat.chat.name) || chat.chat.id }}</h1></div>
          <p class="facts small muted">
            <span>飞书群</span><span>·</span>
            <span>{{ chat.contexts.length ? `在 ${chat.contexts.length} 个关注里` : "不在任何关注里" }}<template v-if="chat.paused.length">，{{ chat.paused.length }} 个已暂停</template></span>
            <span>·</span><span>案例 {{ chat.cases.length }}</span>
          </p>
        </header>
        <section class="chapter">
          <h2>在哪些关注里</h2>
          <ul v-if="chat.contexts.length || chat.paused.length" class="ctx-rows">
            <li v-for="v in [...chat.contexts, ...chat.paused]" :key="v.id">
              <router-link :to="`/listen/${encodeURIComponent(v.id)}`" class="ctx-row">
                <span class="name">{{ v.name }}</span>
                <span class="badge">{{ KIND_LABEL[v.kind] }}</span>
                <span v-if="v.status !== 'active'" class="badge warn">已暂停</span>
                <span class="muted small facts-row">回复：{{ replyLabel(v.knobs) }} · 案例 {{ v.stats.cases }}<template v-if="v.groups.length > 1"> · 共 {{ v.groups.length }} 个群</template></span>
              </router-link>
            </li>
          </ul>
          <p v-else class="muted">这个群还不在任何关注里：它的消息照常采集，有人 @ 你时走“有人找你”。想让助手一直看着它，新建一个关注或加进已有的。</p>
          <div class="row wrap join">
            <button type="button" class="btn sm primary" @click="creating = true"><Icon name="plus" :size="14" />新建关注</button>
            <span v-if="joinable.length" class="row join-pick">
              <span class="muted small">或</span>
              <UiSelect v-model="joinTo" size="sm" width="200px" placeholder="加入某个关注…" aria-label="加入某个关注" :options="joinable" />
              <button type="button" class="btn sm" :disabled="!joinTo" @click="join">加入</button>
            </span>
          </div>
        </section>
      </template>

      <!-- inside a line's page: on/off and where the full page is, then the two parts as a switch -->
      <div v-if="embedded && c" class="embed-bar row wrap">
        <UiCheckbox switch size="sm" :model-value="c.status === 'active'" :aria-label="`关注 ${c.name}`" @change="setStatus">{{ c.status === "active" ? "关注中" : "已暂停" }}</UiCheckbox>
        <span class="muted small">案例 {{ c.stats.cases }}<template v-if="c.stats.corrections"> · 你纠正过 {{ c.stats.corrections }}</template></span>
        <span class="spacer" />
        <UiSegmented v-model="tab" size="sm" aria-label="关注的哪一部分" :options="tabOptions" />
        <router-link :to="`/listen/${encodeURIComponent(c.id)}`" class="btn ghost sm">在关注页打开</router-link>
      </div>
      <p v-if="embedded && watching" class="watch-note small" role="note"><Icon name="eye" :size="14" />这条线在观察中<template v-if="watching.watchUntil">（到 {{ dayLabel(watching.watchUntil) }}）</template>：已经上线，助手只关心报错、用户反馈和数据异常，普通讨论不处理。</p>

      <div v-if="!embedded && tabs.length" class="tabs" role="tablist" aria-label="这一页的几部分" @keydown="onTabKey">
        <button v-for="t in tabs" :id="`ltab-${t.key}`" :key="t.key" type="button" role="tab" :aria-selected="tab === t.key" :tabindex="tab === t.key ? 0 : -1" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</button>
      </div>

      <div class="panel" :role="embedded ? undefined : 'tabpanel'" :aria-labelledby="embedded ? undefined : `ltab-${tab}`">
        <!-- 在聊什么 -->
        <section v-if="tab === 'summary' && detail && c" class="chapter">
          <p v-if="c.summaryAt" class="muted small lead" :title="fmtTime(c.summaryAt)">{{ relTime(c.summaryAt) }}写的。它每处理几批消息更新一次，之后每次处理都带着读。</p>
          <Markdown v-if="detail.summary" :source="detail.summary" class="prose" />
          <p v-else class="muted">还没有总结。它处理过几批消息后会写一段这些群在聊什么，之后每次处理都带着读。</p>
        </section>

        <!-- 经验和案例 -->
        <template v-else-if="tab === 'lessons' && detail">
          <section class="chapter">
            <h2>经验<span v-if="detail.playbook.updatedAt" class="when muted small" :title="fmtTime(detail.playbook.updatedAt)">{{ relTime(detail.playbook.updatedAt) }}整理</span></h2>
            <div class="row wrap small lessons-bar">
              <router-link v-if="detail.playbook.sourceId" :to="`/sources/${detail.playbook.sourceId}`">打开经验文件</router-link>
              <span v-else class="muted">{{ detail.playbook.path }}</span>
              <span class="spacer" />
              <span v-if="coachBusy" class="badge accent">{{ detail.coaching?.status === "running" ? "正在整理" : "排队整理" }}</span>
              <router-link v-if="detail.coaching && coachBusy" :to="`/runs/${detail.coaching.id}`" class="muted">看运行</router-link>
              <button type="button" class="btn sm" :disabled="coachBusy" @click="coach"><Icon name="refresh" :size="14" />重新整理</button>
            </div>
            <Markdown v-if="detail.playbook.text" :source="detail.playbook.text" class="prose lessons" />
            <p v-else class="muted">还没有经验。案例攒到一些后它会按场景整理一次；也可以现在点“重新整理”。</p>
          </section>
          <section class="chapter">
            <h2>案例</h2>
            <p class="muted small lead">每一次：谁在哪问了什么、助手做了什么、你自己回了什么。你的纠正进下一次整理经验。</p>
            <ListenCases :cases="cases" />
          </section>
        </template>

        <!-- a group's cases -->
        <section v-else-if="tab === 'cases' && chat" class="chapter">
          <p class="muted small lead">这个群里的每一次：谁问了什么、助手做了什么、你自己回了什么。你的纠正进下一次整理经验。</p>
          <ListenCases :cases="cases" :contexts="contextNames" :here="chat.chat.id" />
        </section>

        <!-- 记忆 -->
        <section v-else-if="tab === 'memories'" class="chapter">
          <p class="muted small lead">{{ chat ? "从这个群的消息里记下的。" : "从这些群的消息里记下的。" }}</p>
          <ul v-if="memories.length" class="mems">
            <li v-for="m in memories" :key="m.id">
              <div class="mem-head small">
                <span class="badge">{{ memoryKindLabel[m.kind] ?? m.kind }}</span>
                <strong v-if="m.subject">{{ m.subject }}</strong>
                <span class="muted" :title="fmtTime(m.created_at)">{{ relTime(m.created_at) }}</span>
                <span class="spacer" />
                <button type="button" class="btn ghost sm" @click="openCitation({ kind: 'memory', id: m.id })">出处</button>
              </div>
              <MemoryText :text="m.content" class="mem-text" />
            </li>
          </ul>
          <p v-else class="muted">还没有从{{ chat ? "这个群" : "这些群" }}的消息里记下的记忆。</p>
        </section>

        <!-- 处理记录 -->
        <section v-else-if="tab === 'handling' && detail" class="chapter">
          <p class="muted small lead">群里有新消息时它按批看一次；没说话的也写了为什么。</p>
          <ul v-if="detail.handling.length" class="handling">
            <li v-for="h in detail.handling" :key="h.id">
              <router-link :to="`/runs/${h.id}`" class="hrow">
                <span class="badge" :class="h.status === 'failed' ? 'danger' : outcomeTone[h.outcome]">{{ h.status === "failed" ? "出错" : h.status === "running" || h.status === "queued" ? "进行中" : OUTCOME_LABEL[h.outcome] }}</span>
                <span class="what">{{ h.reason || h.title }}</span>
                <span class="muted small when" :title="fmtTime(h.at)">{{ relTime(h.at) }}</span>
              </router-link>
            </li>
          </ul>
          <p v-else class="muted">还没处理过。</p>
        </section>

        <!-- 设置 -->
        <section v-else-if="tab === 'settings' && detail && c" class="chapter settings">
          <p v-if="isDefault" class="muted small">
            有人找你的回复方式、分诊和每天的次数在 <router-link to="/settings?card=mentions">设置 → 代你回复 → 有人找你</router-link> 里调；这里写它该处理什么。
          </p>
          <p v-else class="tell small">也可以直接跟助手说，比如“把「{{ c.name }}」的关注改成只看 @ 我的”“这个关注别自动回了”：它改的就是这一页的设置。</p>
          <div class="card pad form">
            <div class="section-title">它要做什么</div>
            <label v-if="!isDefault" class="field"><span>你想让它做什么</span>
              <textarea v-model="form.note" class="textarea" rows="3" maxlength="2000" placeholder="例如：值班群里问接口报错的先查日志再回，产品问排期的告诉我" />
            </label>
            <div v-if="c.kind === 'place'" class="field"><span>哪些群</span>
              <UiSelect v-model="form.chats" multiple :options="groupOpts" aria-label="关注哪些群" :search-at="6" placeholder="至少选一个群" />
            </div>
            <p v-else-if="c.kind === 'item' && c.item && !embedded" class="hint-line small muted">群跟着这条线走：在 <router-link :to="`/work/${c.item.id}?tab=people`">线的页面 → 人和群</router-link> 里加群或不再关注某个群。</p>
            <div class="brief">
              <label class="field"><span>要处理的</span><textarea v-model="form.handle" class="textarea" rows="4" placeholder="一行一条" /></label>
              <label class="field"><span>不处理的</span><textarea v-model="form.skip" class="textarea" rows="4" placeholder="一行一条" /></label>
            </div>
            <label class="field"><span>值得发的结论</span>
              <textarea v-model="form.valid" class="textarea short" rows="2" maxlength="600" placeholder="回复要有什么才发，例如：说清原因并带上出处；查不到就不回" />
              <span v-if="unconfirmed" class="hint unconfirmed">这份说明是助手{{ c.brief?.confirmedAt ? "改过" : "拟" }}的，还没经你确认：看过后点保存就算确认。</span>
              <span v-else-if="c.brief?.confirmedAt" class="hint">{{ fmtTime(c.brief.confirmedAt) }} 经你确认</span>
            </label>

            <template v-if="!isDefault">
              <div class="section-title knobs-title">回复</div>
              <div class="knobs">
                <div class="field"><span>{{ KNOB.reply.label }}</span>
                  <UiSegmented v-model="form.knobs.reply" class="knob" size="sm" :aria-label="KNOB.reply.label" :options="REPLY_OPTIONS" />
                  <span v-if="c.knobs.wantsAuto && c.knobs.reply === 'draft' && form.knobs.reply === 'draft'" class="hint"><span class="badge warn">试运行中</span> 草稿连续照发 {{ c.knobs.promoteAfter }} 条后问你要不要直接回</span>
                  <span v-else class="hint">{{ readsOnly ? "不回时，这些群的新消息由每天的跟进读，记成这件事的变化；打开回复后，再设看哪些消息、要不要去查。" : KNOB.reply.hint }}</span>
                </div>
              </div>

              <template v-if="!readsOnly">
                <div class="section-title knobs-title">看哪些、多久看一次</div>
                <div class="knobs">
                  <div class="field"><span>{{ KNOB.listen.label }}</span><UiSegmented v-model="form.knobs.listen" class="knob" size="sm" :aria-label="KNOB.listen.label" :options="LISTEN_OPTIONS" /><span class="hint">{{ KNOB.listen.hint }}</span></div>
                  <template v-if="form.knobs.listen === 'relevant'">
                    <div class="field"><span>{{ KNOB.prefilter.label }}</span><UiSelect v-model="form.knobs.prefilter" size="sm" width="240px" :aria-label="KNOB.prefilter.label" :options="PREFILTER_OPTIONS" /><span class="hint">{{ KNOB.prefilter.hint }}</span></div>
                    <div v-if="form.knobs.prefilter !== 'off'" class="field"><span>{{ KNOB.strictness.label }}</span><UiSelect v-model="form.knobs.strictness" size="sm" width="240px" :aria-label="KNOB.strictness.label" :options="STRICTNESS_OPTIONS" /><span class="hint">{{ KNOB.strictness.hint }}</span></div>
                  </template>
                  <div class="field"><span>{{ KNOB.batchMinutes.label }}</span><UiSelect v-model="form.knobs.batchMinutes" size="sm" width="240px" :aria-label="KNOB.batchMinutes.label" :options="batchOptions(form.knobs.batchMinutes)" /><span class="hint">{{ KNOB.batchMinutes.hint }}</span></div>
                  <div class="field"><span>{{ KNOB.perDay.label }}</span><UiSelect v-model="form.knobs.perDay" size="sm" width="240px" :aria-label="KNOB.perDay.label" :options="perDayOptions(form.knobs.perDay)" /><span class="hint">{{ KNOB.perDay.hint }}</span></div>
                  <div class="field"><span>{{ KNOB.backlog.label }}</span><UiSegmented v-model="form.knobs.backlog" class="knob" size="sm" :aria-label="KNOB.backlog.label" :options="BACKLOG_OPTIONS" /><span class="hint">{{ KNOB.backlog.hint }}</span></div>
                </div>

                <div class="section-title knobs-title">怎么处理</div>
                <div class="knobs">
                  <div class="field"><span>{{ KNOB.depth.label }}</span><UiSegmented v-model="form.knobs.depth" class="knob" size="sm" :aria-label="KNOB.depth.label" :options="DEPTH_OPTIONS" /><span class="hint">{{ KNOB.depth.hint }}</span></div>
                  <div class="field"><span>{{ KNOB.ownerAsks.label }}</span><UiSegmented v-model="form.knobs.ownerAsks" class="knob" size="sm" :aria-label="KNOB.ownerAsks.label" :options="OWNER_ASKS_OPTIONS" /><span class="hint">{{ KNOB.ownerAsks.hint }}</span></div>
                  <div class="field"><span>{{ KNOB.othersAsks.label }}</span><UiSegmented v-model="form.knobs.othersAsks" class="knob" size="sm" :aria-label="KNOB.othersAsks.label" :options="OTHERS_ASKS_OPTIONS" /><span class="hint">{{ KNOB.othersAsks.hint }}</span></div>
                </div>
              </template>

              <div class="section-title knobs-title">其他</div>
              <div class="knobs">
                <div class="field"><span>{{ KNOB.meetings.label }}</span><UiSegmented v-model="form.knobs.meetings" class="knob" size="sm" :aria-label="KNOB.meetings.label" :options="MEETING_OPTIONS" /><span class="hint">{{ KNOB.meetings.hint }}</span></div>
                <div v-if="c.kind === 'item'" class="field"><span>{{ KNOB.assist.label }}</span><UiSegmented v-model="form.knobs.assist" class="knob" size="sm" :aria-label="KNOB.assist.label" :options="ASSIST_OPTIONS" /><span class="hint">{{ KNOB.assist.hint }}</span></div>
              </div>
            </template>
            <div class="row wrap actions">
              <span v-if="dirty" class="small muted spacer">有没保存的修改</span>
              <span v-else class="spacer" />
              <button type="button" class="btn" :disabled="!dirty" @click="resetForm(c)">还原</button>
              <button type="button" class="btn primary" :disabled="(!dirty && !unconfirmed) || saving" @click="save">{{ unconfirmed && !dirty ? "确认说明" : "保存" }}</button>
            </div>
          </div>
        </section>
      </div>
    </template>

    <ListenNewDialog v-if="creating && chat" :groups="groupOpts" :preset="[chat.chat.id]" @close="creating = false" @created="created" />
  </div>
</template>

<style scoped>
.listen-page {
  max-width: 880px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  display: grid;
  gap: 20px;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
}
.listen-page.embedded {
  max-width: none;
  margin: 0;
  padding: 0;
  gap: 16px;
}
.crumbs {
  display: flex;
  gap: 6px;
  margin-bottom: -8px;
}
.head {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 16px;
  min-width: 0;
}
.title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  flex: 1 1 320px;
}
.title h1 {
  font-family: var(--serif);
  font-size: 26px;
  line-height: 1.3;
  margin: 0;
  overflow-wrap: anywhere;
  min-width: 0;
}
.title .btn {
  margin-top: 4px;
  flex: none;
}
.head-acts {
  gap: 10px;
  margin-top: 4px;
  flex: none;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 0;
  overflow-wrap: anywhere;
}
.facts a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--line-strong);
  text-underline-offset: 3px;
}
.groups {
  display: grid;
  gap: 6px;
  justify-items: start;
  min-width: 0;
}
.groups-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 0;
  background: none;
  padding: 2px 0;
  color: var(--ink-2);
  font: inherit;
  cursor: pointer;
}
.groups-toggle:hover {
  color: var(--ink);
}
.caret {
  color: var(--muted);
  transition: transform 0.15s;
}
.caret.open {
  transform: rotate(180deg);
}
.one-group {
  overflow-wrap: anywhere;
}
.group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  width: min(560px, 100%);
  border-top: 1px solid var(--line);
}
.group-list li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
}
.gname {
  flex: 1;
  min-width: 0;
  color: var(--ink);
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gwhen {
  flex: none;
}
.watch-note,
.confirm-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.watch-note {
  background: var(--accent-soft);
  color: var(--ink-2);
}
.watch-note :deep(svg) {
  color: var(--accent);
  flex: none;
}
.confirm-note {
  background: var(--warn-soft);
  color: var(--ink-2);
}
.tabs {
  margin-bottom: -4px;
}
.embed-bar {
  gap: 8px 12px;
}
.panel {
  display: grid;
  gap: 24px;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
}
.chapter {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.chapter h2 {
  font-family: var(--serif);
  font-size: 19px;
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.when {
  font-family: var(--sans);
  font-weight: normal;
}
.chapter > p {
  margin: 0;
}
.prose {
  line-height: 1.75;
  overflow-wrap: anywhere;
  max-width: 760px;
}
.tell {
  color: var(--ink-2);
  line-height: 1.6;
}
.hint-line {
  margin: 0;
}
.form {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.form > .section-title {
  margin: 0;
}
.brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.textarea {
  min-height: 0;
}
.field .hint.unconfirmed {
  color: var(--warn);
}
/* The lessons' own headings (one per scene) sit under the chapter's, a step smaller. */
.lessons :deep(h1),
.lessons :deep(h2) {
  font-size: 16px;
  margin-top: 14px;
}
.lessons :deep(h3) {
  font-size: 14.5px;
}
.knobs-title {
  margin-top: 8px !important;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.knobs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px 24px;
}
.knobs .field {
  min-width: 0;
  align-content: start;
}
.knobs .hint {
  line-height: 1.55;
}
.knob {
  justify-self: start;
  max-width: 100%;
}
.actions {
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}
.lessons-bar {
  gap: 8px;
}
.ctx-rows,
.mems,
.handling {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
}
.ctx-rows {
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.ctx-rows li + li {
  border-top: 1px solid var(--line);
}
.ctx-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 10px 14px;
  color: inherit;
  text-decoration: none;
}
.ctx-row:hover {
  background: var(--hover);
}
.ctx-row .name {
  font-weight: 550;
  overflow-wrap: anywhere;
}
.ctx-row .facts-row {
  flex-basis: 100%;
}
.join {
  gap: 8px;
}
/* “或 [选一个关注] 加入” wraps as one piece. */
.join-pick {
  gap: 8px;
}
.mems li {
  display: grid;
  gap: 4px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.mem-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.mem-text {
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.handling li + li {
  border-top: 1px solid var(--line);
}
.hrow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 10px;
  padding: 8px 4px;
  color: inherit;
  text-decoration: none;
}
.hrow:hover {
  background: var(--hover);
}
.hrow .what {
  font-size: 13.5px;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .brief {
    grid-template-columns: 1fr;
  }
  .knobs {
    grid-template-columns: minmax(0, 1fr);
  }
  .title h1 {
    font-size: 22px;
  }
}
</style>
