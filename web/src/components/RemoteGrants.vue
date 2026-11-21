<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { del, get, patch, post } from "../api";
import { confirmDialog } from "../lib/dialog";
import { DURATIONS, durationLabel, expiryLabel, grantCandidates, MODE_LABEL, modesFor, type GrantCandidate, type GrantMode, type RemoteGrant } from "../lib/remote-grants";
import { toast } from "../store";
import Icon from "./Icon.vue";
import SideSheet from "./SideSheet.vue";
import UiSegmented from "./UiSegmented.vue";
import UiSelect from "./UiSelect.vue";

/**
 * 交给成员 (Remote.vue): who this browser session is handed to — one line each, its mode, until when,
 * whether they are watching now, and change / extend / take back — and handing it to one more.
 * Only people holding 看 / 操作授权给他的远程会话 are offered (`/api/members/:id/capabilities`).
 */
const props = defineProps<{ session: { id: string; title: string; ownerId: string; grants?: RemoteGrant[] } }>();
const emit = defineEmits<{ close: []; changed: [] }>();

const grants = computed(() => props.session.grants ?? []);
const people = ref<GrantCandidate[] | null>(null);
/** Every person's remote capabilities, also for those already given it (to know whether they may operate). */
const capsOf = ref<Record<string, GrantCandidate>>({});
const peopleError = ref("");
async function loadPeople() {
  try {
    const users = await get<{ id: string; name: string; role: string; status?: string; disabledAt?: string | null }[]>("/api/users");
    const others = users.filter((u) => u.role !== "owner" && u.id !== props.session.ownerId && !u.disabledAt);
    const caps = Object.fromEntries(await Promise.all(others.map(async (u) => [u.id, (await get<{ caps: string[] }>(`/api/members/${encodeURIComponent(u.id)}/capabilities`).catch(() => ({ caps: [] }))).caps] as const)));
    capsOf.value = Object.fromEntries(grantCandidates(others, caps, { sessionOwner: props.session.ownerId, granted: [] }).map((c) => [c.id, c]));
    people.value = grantCandidates(others, caps, { sessionOwner: props.session.ownerId, granted: grants.value.map((g) => g.userId) });
    peopleError.value = "";
  } catch (e) {
    people.value = [];
    peopleError.value = (e as Error).message;
  }
}
onMounted(loadPeople);
watch(() => grants.value.map((g) => g.userId).join(","), () => {
  if (people.value) people.value = Object.values(capsOf.value).filter((c) => !grants.value.some((g) => g.userId === c.id));
});

const draft = ref<{ userId: string; mode: GrantMode; hours: number }>({ userId: "", mode: "view", hours: 2 });
const picked = computed(() => people.value?.find((p) => p.id === draft.value.userId) ?? null);
const draftModes = computed(() => modesFor(picked.value).map((m) => ({ value: m, label: MODE_LABEL[m] })));
watch(picked, (p) => { if (!modesFor(p).includes(draft.value.mode)) draft.value.mode = modesFor(p)[0]; });
const busy = ref("");

async function give() {
  const d = draft.value;
  if (!d.userId) return;
  busy.value = "new";
  try {
    await post(`/api/remote/sessions/${props.session.id}/grants`, { userId: d.userId, mode: d.mode, hours: d.hours });
    toast(`已交给${picked.value?.name ?? "他"}，${MODE_LABEL[d.mode]}，${durationLabel(d.hours)}`, "ok");
    draft.value = { userId: "", mode: "view", hours: 2 };
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function change(g: RemoteGrant, body: { mode?: GrantMode; hours?: number }, note: string) {
  busy.value = g.id;
  try {
    await patch(`/api/remote/sessions/${props.session.id}/grants/${g.id}`, body);
    toast(note, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function revoke(g: RemoteGrant) {
  if (!(await confirmDialog(`收回${g.userName}的授权？`, { message: g.connected ? `${g.userName}正在看，会立刻断开。` : `${g.userName}之后打不开这个会话。`, okText: "收回", danger: true }))) return;
  busy.value = g.id;
  try {
    await del(`/api/remote/sessions/${props.session.id}/grants/${g.id}`);
    toast(`已收回${g.userName}的授权`, "ok");
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
const extendOptions = DURATIONS.map((h) => ({ value: h, label: `从现在起 ${durationLabel(h)}` }));
const modeOptions = (g: RemoteGrant) => modesFor(capsOf.value[g.userId] ?? (g.mode === "operate" ? { view: false, operate: true } : null)).concat(g.mode).filter((m, i, a) => a.indexOf(m) === i).map((m) => ({ value: m, label: MODE_LABEL[m] }));
</script>

<template>
  <SideSheet label="交给成员" tag="交给成员" :width="480" @close="emit('close')">
    <template #head><span class="rg-title ellipsis" :title="session.title">{{ session.title }}</span></template>

    <section class="rg-sec">
      <h3 class="rg-h">已经交给</h3>
      <p v-if="!grants.length" class="rg-empty">还没有交给别人。</p>
      <div v-for="g in grants" :key="g.id" class="rg-row">
        <div class="rg-who">
          <span class="rg-name">{{ g.userName }}</span>
          <span class="rg-meta"><span class="rg-dot" :class="{ on: g.connected }" />{{ g.connected ? "正在看" : "没在看" }} · {{ expiryLabel(g.expiresAt) }}</span>
        </div>
        <div class="rg-acts">
          <UiSegmented v-if="modeOptions(g).length > 1" :model-value="g.mode" size="sm" :aria-label="`${g.userName}能做什么`" :options="modeOptions(g)" @change="(m) => change(g, { mode: m }, m === 'operate' ? `${g.userName}现在可以操作` : `${g.userName}现在只能看`)" />
          <span v-else class="rg-mode" :title="g.mode === 'view' ? `${g.userName}没有“操作授权给他的远程会话”能力` : undefined">{{ MODE_LABEL[g.mode] }}</span>
          <UiSelect :model-value="null" size="sm" width="96px" placeholder="延长" :aria-label="`延长${g.userName}的授权`" :options="extendOptions" :disabled="busy === g.id" @change="(h) => change(g, { hours: h as number }, `已延长到${expiryLabel(new Date(Date.now() + (h as number) * 3600_000).toISOString()).replace(/^到/, '')}`)" />
          <button type="button" class="btn ghost sm danger" :disabled="busy === g.id" @click="revoke(g)">收回</button>
        </div>
      </div>
    </section>

    <section class="rg-sec">
      <h3 class="rg-h">再交给一个人</h3>
      <p v-if="people === null" class="rg-empty">正在读成员…</p>
      <p v-else-if="peopleError" class="rg-empty">读不到成员（{{ peopleError }}）。</p>
      <p v-else-if="!people.length" class="rg-empty">
        {{ Object.keys(capsOf).length ? "能交给的人都交给了。要交给别人，" : "没有可以交给的人。" }}先在成员页的“能做什么”里给他“看授权给他的远程会话”。
        <router-link to="/settings?tab=members" @click="emit('close')">去成员页</router-link>
      </p>
      <form v-else class="rg-form" @submit.prevent="give">
        <div class="field"><span>交给谁</span>
          <UiSelect v-model="draft.userId" :options="people.map((p) => ({ value: p.id, label: p.name, hint: p.operate ? '可以操作' : '只能看' }))" placeholder="选成员" aria-label="交给谁" />
        </div>
        <div class="field"><span>能做什么</span>
          <UiSegmented v-model="draft.mode" size="sm" aria-label="能做什么" :options="draftModes" />
          <span v-if="picked && !picked.operate" class="hint">{{ picked.name }}没有“操作授权给他的远程会话”能力，只能给只看。</span>
          <span v-else class="hint">{{ draft.mode === "view" ? "只能看画面，不能点和输入" : "和你一样能点、能输入、能换网址" }}</span>
        </div>
        <div class="field"><span>多久</span>
          <UiSegmented v-model="draft.hours" size="sm" aria-label="多久" :options="DURATIONS.map((h) => ({ value: h, label: durationLabel(h) }))" />
        </div>
        <div class="rg-foot"><button type="submit" class="btn primary sm" :disabled="!draft.userId || busy === 'new'"><Icon name="user" :size="14" />{{ busy === "new" ? "正在交给…" : "交给他" }}</button></div>
      </form>
    </section>
  </SideSheet>
</template>

<style scoped>
.rg-title { font-size: 14px; font-weight: 650; min-width: 0; }
.rg-sec { display: grid; gap: 8px; min-width: 0; }
.rg-h { margin: 0; font-size: 15px; font-weight: 650; }
.rg-empty { margin: 0; font-size: 13px; color: var(--muted); }
.rg-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 0; border-top: 1px solid var(--line); min-width: 0; }
.rg-who { display: grid; gap: 2px; flex: 1 1 140px; min-width: 0; }
.rg-name { font-size: 14px; }
.rg-meta { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.rg-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }
.rg-dot.on { background: var(--ok); }
.rg-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rg-mode { font-size: 13px; color: var(--ink-2); }
.rg-form { display: grid; gap: 12px; }
.rg-form .field { justify-items: start; }
.rg-foot { display: flex; justify-content: flex-end; }
</style>
