<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { del, get, onServerEvent } from "../api";
import { confirmDialog } from "../lib/dialog";
import { relTime, toast } from "../store";
import Icon from "./Icon.vue";
import Skeleton from "./Skeleton.vue";

/**
 * A run's artifacts (docs/v2/artifacts.md): screenshots, recordings, test reports and logs the
 * coding Agent, the checks and the host's commands handed in, by task on a delegation. A page
 * (an HTML file, a report folder) opens in a sandboxed frame: it cannot reach omem's origin.
 */
export type Artifact = {
  id: string; runId: string; task: number | null; req: string | null; name: string; caption: string;
  kind: "image" | "video" | "html" | "site" | "text" | "file"; mime: string; size: number; source: "agent" | "check" | "command"; createdBy: string; createdAt: string; url: string;
};
type Data = { workId: string | null; artifacts: Artifact[]; perTask: Record<string, number>; tasks?: Record<string, string> };

/** `items`: show these (a test point's results) instead of loading a run's; no grouping by task. */
const props = defineProps<{ runId?: string; task?: number | null; items?: Artifact[] }>();
const emit = defineEmits<{ count: [n: number]; task: [seq: number | null]; changed: [] }>();

const data = ref<Data | null>(null);
const failed = ref("");
let seq = 0;
async function load() {
  if (props.items) {
    data.value = { workId: null, artifacts: props.items, perTask: {} };
    return;
  }
  if (!props.runId) return;
  const mine = ++seq;
  try {
    const d = await get<Data>(`/api/runs/${props.runId}/artifacts`);
    if (mine !== seq) return;
    data.value = d;
    failed.value = "";
    emit("count", d.artifacts.length);
  } catch (e) {
    if (mine === seq) failed.value = (e as Error).message;
  }
}
watch(() => props.runId, () => { data.value = null; void load(); }, { immediate: true });
watch(() => props.items, () => void load());
let timer: ReturnType<typeof setTimeout> | null = null;
const off = onServerEvent((e) => {
  if (e.type !== "run" || props.items) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 800);
});
onBeforeUnmount(() => { off(); if (timer) clearTimeout(timer); });

const SOURCE: Record<Artifact["source"], string> = { agent: "Agent 交的", check: "检查命令", command: "运行的命令" };
const KIND: Record<Artifact["kind"], { icon: string; text: string }> = {
  image: { icon: "camera", text: "图片" }, video: { icon: "play", text: "录屏" }, html: { icon: "globe", text: "网页" },
  site: { icon: "book", text: "报告" }, text: { icon: "file", text: "文本" }, file: { icon: "download", text: "文件" },
};
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const folder = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");
const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);

const shown = computed(() => (data.value?.artifacts ?? []).filter((a) => props.task == null || a.task === props.task));
/**
 * By task (in task order), then those of no task; inside, side by side by name (folders first, as
 * they were put in), each tile naming its folder.
 */
const groups = computed(() => {
  const by = new Map<string, { key: string; label: string; task: number | null; list: Artifact[] }>();
  for (const a of shown.value) {
    const key = a.task != null ? `t${a.task}` : "rest";
    if (!by.has(key)) by.set(key, { key, task: a.task, label: a.task != null ? `T${a.task}${data.value?.tasks?.[a.task] ? ` ${data.value.tasks[a.task]}` : ""}` : "没有归到修改项", list: [] });
    by.get(key)!.list.push(a);
  }
  return [...by.values()].sort((x, y) => (x.task ?? 1e9) - (y.task ?? 1e9)).map((g) => ({ ...g, list: [...g.list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) }));
});

// ---- the viewer: one artifact at a time, ← → through the ones shown ------------------------------
const open = ref<Artifact | null>(null);
const text = ref<string | null>(null);
let opener: HTMLElement | null = null;
const viewer = ref<HTMLElement>();
const flat = computed(() => groups.value.flatMap((g) => g.list));
async function show(a: Artifact) {
  if (a.kind === "file") return void window.open(a.url, "_blank", "noopener");
  if (!open.value) opener = document.activeElement as HTMLElement | null;
  open.value = a;
  text.value = null;
  await nextTick();
  viewer.value?.focus();
  if (a.kind === "text") {
    const want = a.id;
    const r = await fetch(a.url, { headers: { range: "bytes=0-524287" } }).then((x) => x.text()).catch((e) => `读取失败：${(e as Error).message}`);
    if (open.value?.id === want) text.value = r;
  }
}
function close() {
  open.value = null;
  text.value = null;
  opener?.focus();
}
function step(d: number) {
  if (!open.value) return;
  const i = flat.value.findIndex((a) => a.id === open.value!.id);
  const next = flat.value[(i + d + flat.value.length) % flat.value.length];
  if (next && next.kind !== "file") void show(next);
}
function key(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); close(); }
  else if (e.key === "ArrowRight" && open.value?.kind !== "video") step(1);
  else if (e.key === "ArrowLeft" && open.value?.kind !== "video") step(-1);
}
async function remove(a: Artifact) {
  if (!(await confirmDialog("删除这个产物？", { message: `${a.name}${a.caption ? `（${a.caption}）` : ""}，文件一起删掉，不能恢复。`, okText: "删除", danger: true }))) return;
  try {
    await del(`/api/runs/${props.runId ?? a.runId}/artifacts/${a.id}`);
    if (open.value?.id === a.id) close();
    if (props.items) emit("changed");
    else await load();
  } catch (e) {
    toast((e as Error).message);
  }
}
</script>

<template>
  <div class="artifacts">
    <Skeleton v-if="!data && !failed" variant="cards" :rows="3" />
    <p v-else-if="failed" class="empty-tab">产物没能读出来：{{ failed }}</p>
    <p v-else-if="!shown.length && !items" class="empty-tab">
      <template v-if="task != null">T{{ task }} 还没有截图、录屏或报告。<button class="btn ghost sm" @click="emit('task', null)">看全部</button></template>
      <template v-else>还没有截图、录屏或报告。编码 Agent 和检查命令把文件放进 <code>$OMEM_ARTIFACTS</code>（放在 <code>T&lt;编号&gt;/</code> 下就归到那一项），或用 <code>attach_artifact</code> 交上来，这里就能看到。</template>
    </p>
    <template v-else>
      <div v-if="task != null" class="row small muted filter">只看 T{{ task }} 的 <button class="btn ghost sm" @click="emit('task', null)">看全部</button></div>
      <section v-for="g in groups" :key="g.key" class="group">
        <div v-if="!items" class="section-title">{{ g.label }} · {{ g.list.length }}</div>
        <div class="grid">
            <article v-for="a in g.list" :key="a.id" class="tile">
              <button class="thumb" :aria-label="`打开 ${base(a.name)}`" @click="show(a)">
                <img v-if="a.kind === 'image'" :src="a.url" :alt="a.caption || base(a.name)" loading="lazy" />
                <video v-else-if="a.kind === 'video'" :src="`${a.url}#t=0.1`" preload="metadata" muted playsinline />
                <span v-else class="ph"><Icon :name="KIND[a.kind].icon" :size="26" /><span class="small">{{ KIND[a.kind].text }}</span></span>
                <span v-if="a.kind === 'video'" class="play"><Icon name="play" :size="22" /></span>
              </button>
              <div class="cap small">
                <div v-if="folder(a.name)" class="fold mono" :title="folder(a.name)">{{ folder(a.name) }}/</div>
                <div class="name" :title="a.name">{{ base(a.name) }}</div>
                <div v-if="a.caption" class="muted text">{{ a.caption }}</div>
                <div class="muted meta">{{ SOURCE[a.source] }} · {{ size(a.size) }} · {{ relTime(a.createdAt) }}</div>
              </div>
            </article>
        </div>
      </section>
    </template>

    <Teleport to="body">
      <div v-if="open" ref="viewer" class="viewer" role="dialog" aria-modal="true" :aria-label="open.name" tabindex="-1" @keydown="key" @click.self="close">
        <div class="vbar">
          <div class="vtitle">
            <strong class="small">{{ open.task != null ? `T${open.task} · ` : "" }}{{ open.name }}</strong>
            <span v-if="open.caption" class="small muted">{{ open.caption }}</span>
          </div>
          <span class="spacer" />
          <button v-if="flat.length > 1 && open.kind !== 'video'" class="btn ghost sm" aria-label="上一个" @click="step(-1)"><Icon name="left" :size="16" /></button>
          <button v-if="flat.length > 1 && open.kind !== 'video'" class="btn ghost sm" aria-label="下一个" @click="step(1)"><Icon name="right" :size="16" /></button>
          <a v-if="open.kind === 'image' || open.kind === 'video' || open.kind === 'text'" class="btn ghost sm" :href="open.url" target="_blank" rel="noopener noreferrer">新标签打开</a>
          <button class="btn ghost sm danger" @click="remove(open)">删除</button>
          <button class="btn ghost sm" aria-label="关闭" @click="close"><Icon name="x" :size="16" /></button>
        </div>
        <div class="vbody" @click.self="close">
          <img v-if="open.kind === 'image'" :src="open.url" :alt="open.caption || open.name" />
          <video v-else-if="open.kind === 'video'" :src="open.url" controls autoplay playsinline />
          <iframe v-else-if="open.kind === 'html' || open.kind === 'site'" :src="open.url" sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" referrerpolicy="no-referrer" :title="open.name" />
          <pre v-else-if="open.kind === 'text'" class="vtext">{{ text ?? "读取中…" }}</pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.artifacts { display: grid; gap: 14px; }
.filter { gap: 8px; align-items: center; }
.group { display: grid; gap: 8px; }
.fold { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.tile { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); overflow: hidden; min-width: 0; display: grid; grid-template-rows: auto 1fr; }
.thumb { position: relative; display: grid; place-items: center; aspect-ratio: 16 / 10; width: 100%; padding: 0; border: 0; border-bottom: 1px solid var(--line); background: var(--sunken); cursor: zoom-in; overflow: hidden; color: var(--muted); }
.thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ph { display: grid; justify-items: center; gap: 4px; }
.play { position: absolute; inset: auto auto 8px 8px; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; background: var(--panel); color: var(--ink); box-shadow: var(--shadow); }
.cap { padding: 8px 10px; display: grid; gap: 2px; min-width: 0; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.meta { font-size: 12px; }
.empty-tab { color: var(--muted); font-size: 13px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--radius); margin: 0; }
.viewer { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, var(--bg) 92%, transparent); display: grid; grid-template-rows: auto 1fr; outline: none; }
.vbar { display: flex; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.vtitle { display: grid; min-width: 0; }
.vtitle > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbody { display: grid; place-items: center; min-height: 0; padding: 16px; overflow: auto; }
.vbody img, .vbody video { max-width: 100%; max-height: calc(100vh - 100px); object-fit: contain; background: var(--panel); box-shadow: var(--shadow-lg); }
/* A report expects a light page under it (most set no background of their own). */
.vbody iframe { width: 100%; height: 100%; border: 1px solid var(--line); border-radius: var(--radius); color-scheme: light; background: Canvas; }
.vtext { width: min(1000px, 100%); height: 100%; margin: 0; overflow: auto; padding: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 760px) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .vbody { padding: 8px; }
}
</style>
