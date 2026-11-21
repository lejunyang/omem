<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { get, onServerEvent, post, type Ask } from "../api";
import { state, toast } from "../store";
import AskCard from "./AskCard.vue";
import Icon from "./Icon.vue";
import SideSheet from "./SideSheet.vue";

/**
 * A review's findings on the platform the change is reviewed on (src/agents/review-sync.ts): which
 * merge request they can go to, how many are posted, failed, need a new place or got a reply, and the
 * three things to do about it. Publishing and closing discussions are the owner's: the button asks,
 * the question that comes back is answered here. Nothing is rendered when the review has no such object.
 */
type SyncObject = { id: string; title: string; link: string; provider: string; label: string };
type SyncFinding = { id: number; eligible: boolean; delivery: "published" | "failed" | "relocate" | "unpublished"; external: { state?: string; url?: string; error?: string } | null };
type Sync = { objects: SyncObject[]; findings: SyncFinding[]; pending: { id: string; action: string | null }[] };
const props = defineProps<{ runId: string; /** Findings a later review found fixed, by id: their discussions can be closed. */ fixed?: number[] }>();
const emit = defineEmits<{ changed: [] }>();

const sync = ref<Sync | null>(null);
const busy = ref<"" | "publish" | "resolve" | "refresh">("");
const asking = ref<Ask | null>(null);
const target = ref("");
let seq = 0;
async function load() {
  const n = ++seq, id = props.runId;
  try {
    const r = await get<Sync>(`/api/runs/${id}/review-sync`);
    if (n !== seq || id !== props.runId) return;
    sync.value = r;
    if (!r.objects.some((o) => o.id === target.value)) target.value = r.objects[0]?.id ?? "";
  } catch {
    // An older server, or a run that is no review: nothing to show.
    if (n === seq) sync.value = null;
  }
}
watch(() => props.runId, () => { sync.value = null; asking.value = null; void load(); }, { immediate: true });
const off = onServerEvent((e) => { if (e.type === "ask" || (e.type === "run" && e.runId === props.runId)) void load(); });
onBeforeUnmount(() => { ++seq; off(); });

const owner = computed(() => !state.me || state.me.role === "owner");
const object = computed(() => sync.value?.objects.find((o) => o.id === target.value) ?? sync.value?.objects[0] ?? null);
const count = (f: (x: SyncFinding) => boolean) => sync.value?.findings.filter(f).length ?? 0;
const posted = computed(() => count((f) => f.delivery === "published"));
const failed = computed(() => count((f) => f.delivery === "failed"));
const relocate = computed(() => count((f) => f.delivery === "relocate"));
const replied = computed(() => count((f) => f.delivery === "published" && f.external?.state === "replied"));
/** What can go out now: never posted, or posting failed. */
const toPublish = computed(() => (sync.value?.findings ?? []).filter((f) => f.eligible).map((f) => f.id));
/** Posted, still open there, and found fixed since. */
const toResolve = computed(() => (sync.value?.findings ?? []).filter((f) => f.delivery === "published" && ["open", "replied"].includes(f.external?.state ?? "") && props.fixed?.includes(f.id)).map((f) => f.id));
const shown = computed(() => !!sync.value && (sync.value.objects.length > 0 || posted.value + failed.value + relocate.value > 0));
const PENDING: Record<string, string> = { publish: "发布", resolve: "结束讨论" };

async function openAsk(id: string) {
  try { asking.value = await get<Ask>(`/api/asks/${id}`); }
  catch (e) { toast((e as Error).message, "error"); }
}
/** Both writes go through a question to the owner: ask for it, then show it. */
async function offer(kind: "publish" | "resolve") {
  if (busy.value) return;
  busy.value = kind;
  try {
    // The question to confirm comes back with the request: opened from it, not from the list (a live event may be reloading that).
    const r = kind === "publish"
      ? await post<{ askId?: string } | null>(`/api/runs/${props.runId}/review-sync/publish`, { object: object.value!.id, findings: toPublish.value })
      : await post<{ askId?: string } | null>(`/api/runs/${props.runId}/review-sync/resolve`, { findings: toResolve.value });
    void load();
    if (r?.askId) await openAsk(r.askId);
    else toast("现在没有可以" + (kind === "publish" ? "发布" : "结束") + "的问题", "info");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}
async function refresh() {
  if (busy.value) return;
  busy.value = "refresh";
  try {
    await post(`/api/runs/${props.runId}/review-sync/refresh`, {});
    await load();
    emit("changed");
  } catch (e) {
    toast(`没读成：${(e as Error).message}`, "error");
  } finally {
    busy.value = "";
  }
}
async function answered() {
  asking.value = null;
  await load();
  emit("changed");
}
</script>

<template>
  <div v-if="shown && sync" class="rsync" role="group" aria-label="同步到评审平台">
    <div class="rsync-main">
      <span class="rsync-where">
        <Icon name="link" :size="13" />
        <template v-if="object"><span class="muted">{{ object.label }}</span><a :href="object.link" target="_blank" rel="noopener noreferrer" class="ellipsis" :title="object.title">{{ object.title }}</a></template>
        <span v-else class="muted">发过评论的对象已经不在这件事项上</span>
      </span>
      <span class="rsync-counts muted">
        <span v-if="posted">已发 {{ posted }}</span>
        <span v-if="toPublish.length - failed > 0">没发 {{ toPublish.length - failed }}</span>
        <span v-if="replied" class="hot">作者回复 {{ replied }}</span>
        <span v-if="failed" class="bad">没发出去 {{ failed }}</span>
        <span v-if="relocate" class="warn">要重新定位 {{ relocate }}</span>
      </span>
    </div>
    <div class="rsync-acts">
      <button v-for="p in sync.pending" :key="p.id" type="button" class="btn sm warn-btn" @click="openAsk(p.id)">等你确认：{{ PENDING[p.action ?? ""] ?? "同步" }}</button>
      <template v-if="owner && object && !sync.pending.length">
        <button v-if="toPublish.length" type="button" class="btn sm" :disabled="!!busy" @click="offer('publish')">{{ busy === "publish" ? "准备中…" : `发布 ${toPublish.length} 条…` }}</button>
        <button v-if="toResolve.length" type="button" class="btn sm" :disabled="!!busy" @click="offer('resolve')">{{ busy === "resolve" ? "准备中…" : `结束已修的 ${toResolve.length} 条…` }}</button>
      </template>
      <button v-if="posted" type="button" class="btn ghost sm" :disabled="!!busy" title="现在读一次平台上的讨论" @click="refresh"><Icon name="refresh" :size="13" />{{ busy === "refresh" ? "正在读…" : "读讨论" }}</button>
    </div>
    <div v-if="sync.objects.length > 1" class="rsync-pick small">
      <span class="muted">发到哪个：</span>
      <button v-for="o in sync.objects" :key="o.id" type="button" class="chip" :class="{ on: o.id === target }" :aria-pressed="o.id === target" @click="target = o.id">{{ o.title }}</button>
    </div>
    <SideSheet v-if="asking" label="同步到评审平台" tag="等你确认" tone="warn" @close="asking = null">
      <AskCard :ask="asking" compact full @answered="answered" />
    </SideSheet>
  </div>
</template>

<style scoped>
.rsync { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px 16px; padding: 8px 12px; border-radius: 8px; background: var(--sunken); font-size: 13px; min-width: 0; }
.rsync-main { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; min-width: 0; }
.rsync-where { display: flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 100%; }
.rsync-where .icon { align-self: center; flex: none; color: var(--muted); }
.rsync-where a { min-width: 0; }
.rsync-counts { display: flex; flex-wrap: wrap; gap: 0 12px; font-size: 12.5px; }
.rsync-counts .hot { color: var(--accent); }
.rsync-counts .bad { color: var(--danger); }
.rsync-counts .warn { color: var(--warn); }
.rsync-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.warn-btn { border-color: var(--warn); color: var(--warn); }
.rsync-pick { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 2px 10px; font: inherit; font-size: 12.5px; color: var(--ink-2); cursor: pointer; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.on { border-color: var(--accent); color: var(--accent); }
@media (max-width: 640px) {
  .rsync { grid-template-columns: minmax(0, 1fr); }
  .rsync-acts { justify-content: flex-start; }
}
</style>
