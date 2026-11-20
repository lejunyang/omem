<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { del, get, onServerEvent, post, put } from "../api";
import { fmtTime, memoryKindLabel, openCitation, relTime, toast } from "../store";
import { confirmDialog, promptDialog } from "../lib/dialog";
import {
  BACKLOG_OPTIONS, batchOptions, DEPTH_OPTIONS, groupOptions, KIND_LABEL, lines, LISTEN_OPTIONS, MEETING_OPTIONS, ASSIST_OPTIONS, oneLine, OTHERS_ASKS_OPTIONS, OUTCOME_LABEL,
  OWNER_ASKS_OPTIONS, perDayOptions, PREFILTER_OPTIONS, REPLY_OPTIONS, replyLabel, STRICTNESS_OPTIONS,
  type ChatDetail, type ListenDetail, type ListenKnobs, type ListenMemory, type ListenView,
} from "../lib/listen";
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
 * One 关注 (/listen/:id) or one Feishu group (/lark/chats/:chatId), on one layout: what it is and its
 * settings, what its groups are discussing, the lessons, the cases the owner corrects, memories drawn
 * from its groups and its recent handling. A group's page lists the 关注 it is in and starts or joins one.
 */
const route = useRoute();
const router = useRouter();
const listenId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));
const chatId = computed(() => (typeof route.params.chatId === "string" ? route.params.chatId : ""));

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

// Groups a 关注 can read (the chat list), and on a group's page the 关注 it can join.
const captured = ref<{ chatId: string; name: string; kind: string }[]>([]);
void get<{ chats: { chatId: string; name: string; kind: string }[] }>("/api/lark/captured").then((r) => (captured.value = r.chats)).catch(() => {});
const allListens = ref<ListenView[]>([]);
watch(chatId, (id) => id && void get<ListenView[]>("/api/listen").then((r) => (allListens.value = r)).catch(() => {}), { immediate: true });
const groupOpts = computed(() => groupOptions(captured.value, c.value?.groups ?? (chat.value ? [chat.value.chat] : [])));

// ---- settings form -----------------------------------------------------------------------------
type KnobForm = Pick<ListenKnobs, "listen" | "depth" | "reply" | "ownerAsks" | "othersAsks" | "backlog" | "meetings" | "seeOthers" | "batchMinutes" | "perDay"> & {
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
      seeOthers: !!k.seeOthers, assist: k.assist ?? "off", batchMinutes: k.batchMinutes, perDay: k.perDay, strictness: k.strictness ?? null,
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

async function save() {
  const v = c.value;
  if (!v || saving.value) return;
  const was = JSON.parse(snapshot.value) as Form;
  const handle = lines(form.handle), skip = lines(form.skip);
  const problem =
    handle.length > 12 || skip.length > 12 ? "要处理的、不处理的各最多 12 条"
    : v.kind !== "default" && form.knobs.reply !== "none" && !handle.length ? "要在群里回复，先写要处理哪些消息（或回复方式选“只看不回”）"
    : v.kind === "place" && !form.chats.length ? "关注至少要有一个群"
    : "";
  if (problem) {
    toast(problem, "error");
    return;
  }
  const body: Record<string, unknown> = {};
  if (form.note !== was.note) body.note = form.note.trim();
  if (form.handle !== was.handle || form.skip !== was.skip || form.valid !== was.valid || unconfirmed.value) body.brief = { handle, skip, valid: form.valid.trim() };
  if (form.chats.join("\n") !== was.chats.join("\n")) body.chats = form.chats;
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
    void router.push("/settings?tab=connect");
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

// ---- shared ------------------------------------------------------------------------------------
const cases = computed(() => detail.value?.cases ?? chat.value?.cases ?? []);
const memories = computed<ListenMemory[]>(() => detail.value?.memories ?? chat.value?.memories ?? []);
const isDefault = computed(() => c.value?.kind === "default");
const sections = computed(() =>
  detail.value
    ? [
        ["ls-settings", "设置"],
        ...(isDefault.value ? [] : [["ls-summary", "在聊什么"]]),
        ["ls-lessons", "经验"],
        ["ls-cases", `案例 ${cases.value.length}`],
        ...(isDefault.value ? [] : [["ls-memories", `记忆 ${memories.value.length}`], ["ls-handling", "最近的处理"]]),
      ]
    : [],
);
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
const outcomeTone = { handled: "ok", quiet: "", screened: "" } as const;
</script>

<template>
  <div class="listen-page">
    <nav class="crumbs small muted"><router-link to="/settings?tab=connect">设置 · 连接</router-link><span>/</span><span>{{ chatId ? "飞书群" : "关注" }}</span></nav>
    <Skeleton v-if="loading" variant="text" :rows="7" />
    <div v-else-if="error && !detail && !chat" class="empty">
      <h3>打不开这一页</h3>
      <p>{{ error }}</p>
      <router-link class="btn" to="/settings?tab=connect">回到关注列表</router-link>
    </div>

    <template v-else-if="detail || chat">
      <!-- one 关注 -->
      <template v-if="detail && c">
        <header class="head">
          <div class="title">
            <h1>{{ c.name }}</h1>
            <button v-if="!isDefault" type="button" class="btn ghost sm icon" title="改名" aria-label="改名" @click="rename"><Icon name="edit" :size="15" /></button>
          </div>
          <div class="meta small">
            <span class="badge">{{ KIND_LABEL[c.kind] }}</span>
            <span v-if="c.status !== 'active'" class="badge warn">已暂停</span>
            <span class="muted" :title="fmtTime(c.since)">{{ isDefault ? "所有私聊和 @ 你的消息" : `${fmtTime(c.since, false)} 开始` }}</span>
            <span v-if="c.expiresAt" class="muted">· {{ fmtTime(c.expiresAt) }} 停止</span>
            <span class="muted">· 案例 {{ c.stats.cases }} · 本人纠正 {{ c.stats.corrections }}<template v-if="c.stats.ownReplies"> · 你自己回了 {{ c.stats.ownReplies }}</template></span>
          </div>
          <div v-if="c.groups.length || c.item" class="groups">
            <router-link v-for="g in c.groups" :key="g.id" class="gchip" :to="`/lark/chats/${encodeURIComponent(g.id)}`" :title="g.name">{{ oneLine(g.name) }}</router-link>
            <router-link v-if="c.item" class="gchip item" :to="`/items/${c.item.id}`">事项：{{ c.item.title }}</router-link>
          </div>
          <DemoControl :context-id="c.id" :name="c.name" />
          <div v-if="!isDefault" class="controls row wrap">
            <UiCheckbox switch size="sm" :model-value="c.status === 'active'" :aria-label="`关注 ${c.name}`" @change="setStatus">{{ c.status === "active" ? "关注中" : "已暂停" }}</UiCheckbox>
            <span class="spacer" />
            <button type="button" class="btn ghost sm danger" @click="remove"><Icon name="trash" :size="14" />删除</button>
          </div>
          <nav class="toc small" aria-label="这一页的几部分">
            <button v-for="[id, label] in sections" :key="id" type="button" @click="jump(id)">{{ label }}</button>
          </nav>
        </header>

        <section id="ls-settings" class="chapter">
          <h2>设置</h2>
          <p v-if="isDefault" class="muted small">
            有人找你的回复方式、分诊和每天的次数在 <router-link to="/settings?tab=lark&focus=mentions">设置 → 渠道 → 有人找你</router-link> 里调；这里写它该处理什么。
          </p>
          <div class="card pad form">
            <label v-if="!isDefault" class="field"><span>你想让它做什么</span>
              <textarea v-model="form.note" class="textarea" rows="3" maxlength="2000" placeholder="例如：值班群里问接口报错的先查日志再回，产品问排期的告诉我" />
            </label>
            <div v-if="!isDefault" class="field"><span>哪些群</span>
              <UiSelect v-model="form.chats" multiple :options="groupOpts" aria-label="关注哪些群" :search-at="6" :placeholder="c.kind === 'item' ? '事项的群（可以不选）' : '至少选一个群'" />
            </div>
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
              <div class="section-title knobs-title">怎么看、怎么回</div>
              <div class="knobs">
                <div class="field"><span>看哪些消息</span><UiSegmented v-model="form.knobs.listen" class="knob" size="sm" aria-label="看哪些消息" :options="LISTEN_OPTIONS" /></div>
                <div class="field"><span>查多深</span><UiSegmented v-model="form.knobs.depth" class="knob" size="sm" aria-label="查多深" :options="DEPTH_OPTIONS" /></div>
                <div class="field"><span>在群里回复</span>
                  <UiSegmented v-model="form.knobs.reply" class="knob" size="sm" aria-label="在群里回复" :options="REPLY_OPTIONS" />
                  <span v-if="c.knobs.wantsAuto && c.knobs.reply === 'draft' && form.knobs.reply === 'draft'" class="hint"><span class="badge warn">试运行中</span> 草稿连续照发 {{ c.knobs.promoteAfter }} 条后问你要不要直接回</span>
                </div>
                <div class="field"><span>问我或要我拍板的</span><UiSegmented v-model="form.knobs.ownerAsks" class="knob" size="sm" aria-label="问我或要我拍板的" :options="OWNER_ASKS_OPTIONS" /></div>
                <div class="field"><span>找别人或别的机器人的</span><UiSegmented v-model="form.knobs.othersAsks" class="knob" size="sm" aria-label="找别人或别的机器人的" :options="OTHERS_ASKS_OPTIONS" /></div>
                <div class="field"><span>关注开始前没人答的</span><UiSegmented v-model="form.knobs.backlog" class="knob" size="sm" aria-label="关注开始前没人答的" :options="BACKLOG_OPTIONS" /></div>
                <div class="field"><span>群里开会时</span><UiSegmented v-model="form.knobs.meetings" class="knob" size="sm" aria-label="群里开会时" :options="MEETING_OPTIONS" /></div>
                <div v-if="c.kind === 'item'" class="field"><span>主动推进</span><UiSegmented v-model="form.knobs.assist" class="knob" size="sm" aria-label="主动推进" :options="ASSIST_OPTIONS" /></div>
                <div class="field"><span>门槛（越高越少打扰）</span><UiSelect v-model="form.knobs.strictness" size="sm" width="220px" aria-label="门槛" :options="STRICTNESS_OPTIONS" /></div>
                <div class="field"><span>多久看一批</span><UiSelect v-model="form.knobs.batchMinutes" size="sm" width="220px" aria-label="多久看一批" :options="batchOptions(form.knobs.batchMinutes)" /></div>
                <div class="field"><span>每天最多</span><UiSelect v-model="form.knobs.perDay" size="sm" width="220px" aria-label="每天最多处理几批" :options="perDayOptions(form.knobs.perDay)" /></div>
                <div class="field"><span>预筛</span><UiSelect v-model="form.knobs.prefilter" size="sm" width="220px" aria-label="预筛" :options="PREFILTER_OPTIONS" /></div>
                <div class="field"><span>别的关注</span><UiCheckbox v-model="form.knobs.seeOthers" switch size="sm">读别的关注在聊什么（只读）</UiCheckbox></div>
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

        <section v-if="!isDefault" id="ls-summary" class="chapter">
          <h2>现在在聊什么<span v-if="c.summaryAt" class="when muted small" :title="fmtTime(c.summaryAt)">{{ relTime(c.summaryAt) }}写的</span></h2>
          <Markdown v-if="detail.summary" :source="detail.summary" class="prose" />
          <p v-else class="muted">还没有总结。它处理过几批消息后会写一段这些群在聊什么，之后每次处理都带着读。</p>
        </section>

        <section id="ls-lessons" class="chapter">
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
      </template>

      <!-- one group -->
      <template v-else-if="chat">
        <header class="head">
          <div class="title"><h1>{{ oneLine(chat.chat.name) || chat.chat.id }}</h1></div>
          <div class="meta small">
            <span class="badge">飞书群</span>
            <span class="muted">{{ chat.contexts.length ? `在 ${chat.contexts.length} 个关注里` : "不在任何关注里" }}<template v-if="chat.paused.length"> · {{ chat.paused.length }} 个已暂停</template> · 案例 {{ chat.cases.length }}</span>
          </div>
        </header>
        <section class="chapter">
          <h2>在哪些关注里</h2>
          <ul v-if="chat.contexts.length || chat.paused.length" class="ctx-rows">
            <li v-for="v in [...chat.contexts, ...chat.paused]" :key="v.id">
              <router-link :to="`/listen/${encodeURIComponent(v.id)}`" class="ctx-row">
                <span class="name">{{ v.name }}</span>
                <span class="badge">{{ KIND_LABEL[v.kind] }}</span>
                <span v-if="v.status !== 'active'" class="badge warn">已暂停</span>
                <span class="muted small facts">回复：{{ replyLabel(v.knobs) }} · 案例 {{ v.stats.cases }}<template v-if="v.groups.length > 1"> · 共 {{ v.groups.length }} 个群</template></span>
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

      <section id="ls-cases" class="chapter">
        <h2>案例</h2>
        <p class="muted small lead">{{ chat ? "这个群里的每一次" : "每一次" }}：谁在哪问了什么、助手做了什么、你自己回了什么。你的纠正进下一次整理经验。</p>
        <ListenCases :cases="cases" :contexts="chat ? contextNames : undefined" :here="chat?.chat.id" />
      </section>

      <section v-if="!isDefault" id="ls-memories" class="chapter">
        <h2>{{ chat ? "来自这个群的记忆" : "来自这些群的记忆" }}</h2>
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

      <section v-if="detail && !isDefault" id="ls-handling" class="chapter">
        <h2>最近的处理</h2>
        <ul v-if="detail.handling.length" class="handling">
          <li v-for="h in detail.handling" :key="h.id">
            <router-link :to="`/runs/${h.id}`" class="hrow">
              <span class="badge" :class="h.status === 'failed' ? 'danger' : outcomeTone[h.outcome]">{{ h.status === "failed" ? "出错" : h.status === "running" || h.status === "queued" ? "进行中" : OUTCOME_LABEL[h.outcome] }}</span>
              <span class="what">{{ h.reason || h.title }}</span>
              <span class="muted small when" :title="fmtTime(h.at)">{{ relTime(h.at) }}</span>
            </router-link>
          </li>
        </ul>
        <p v-else class="muted">还没处理过。群里有新消息时它按批看一次，没话说的也会在这里写原因。</p>
      </section>
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
  gap: 28px;
  min-width: 0;
}
.crumbs {
  display: flex;
  gap: 6px;
  margin-bottom: -16px;
}
.head {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.title {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
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
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}
.groups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.gchip {
  display: inline-block;
  max-width: 100%;
  padding: 2px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 13px;
  color: var(--ink-2);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gchip:hover {
  border-color: var(--line-strong);
  color: var(--ink);
}
.gchip.item {
  border-style: dashed;
}
.controls {
  gap: 10px;
}
.toc {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 4px;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.toc button {
  border: 0;
  background: none;
  color: var(--muted);
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.toc button:hover {
  color: var(--ink);
  background: var(--hover);
}
.chapter {
  display: grid;
  gap: 10px;
  min-width: 0;
  scroll-margin-top: 16px;
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
.lead {
  margin-top: -4px !important;
}
.prose {
  line-height: 1.75;
  overflow-wrap: anywhere;
  max-width: 760px;
}
.form {
  display: grid;
  gap: 14px;
  min-width: 0;
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
  margin: 6px 0 -4px;
}
.knobs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px 24px;
}
.knobs .field {
  min-width: 0;
  align-content: start;
}
.knob {
  justify-self: start;
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
.ctx-row .facts {
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
