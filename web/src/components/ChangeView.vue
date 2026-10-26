<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { get, post } from "../api";
import DiffFile, { type DiffPoint } from "./DiffFile.vue";
import DiffTree from "./DiffTree.vue";
import UiSegmented from "./UiSegmented.vue";
import { diffLayout, diffLayoutOptions } from "../lib/diffLayout";
import { state, toast } from "../store";
import { POINT_STATUS, type ChangePoint, type Reviews } from "../lib/reviews";

/**
 * The run page's “变更” tab: the requirement's change points (from the business review) on the left,
 * or the changed files as a tree, and the diff on the right. Choosing a point highlights its lines and
 * scrolls to its first place in the code; its places are listed under it and stepped through with
 * 上一处 / 下一处 (or n / N). The marks next to line numbers lead back to the point. A point's
 * explanation opens in the ask drawer.
 */
type DiffRepo = { space: string; files: { name: string; lines: string[]; add: number; rm: number }[] };
const props = defineProps<{ rv: Reviews; runId: string; diffs: DiffRepo[] }>();
const emit = defineEmits<{ explain: [point: ChangePoint] }>();

const COLORS = ["#3b63d1", "#7a55c9", "#12807a", "#b9730f", "#bf4369", "#4f7d2b"];
const points = props.rv.changePoints;
const colorOf = (id: string) => COLORS[Math.max(0, points.value.findIndex((p) => p.id === id)) % COLORS.length];
const multi = computed(() => props.diffs.length > 1);
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;

/** A location names a file as the reviewer saw it: the repository path, or `space/path` with several. */
const sameFile = (space: string, name: string, file: string) => file === name || file === `${space}/${name}` || name.endsWith(`/${file}`);
const pointsOf = (space: string, name: string): DiffPoint[] =>
  points.value.flatMap((p) =>
    p.locations
      .filter((l) => l.start && sameFile(space, name, l.file))
      .map((l) => ({ id: p.id, mark: p.id.replace(/^C/i, ""), color: colorOf(p.id), start: l.start!, end: l.end ?? l.start! })),
  );
const touches = (p: ChangePoint, space: string, name: string) => p.locations.some((l) => sameFile(space, name, l.file));
const filesOf = (p: ChangePoint) => [...new Set(p.locations.map((l) => l.file.split("/").pop()!))];
const fileLevel = (p: ChangePoint) => p.locations.length > 0 && p.locations.every((l) => !l.start);

// Files the points touch come first; the others are one click away.
const mapped = computed(() => props.diffs.map((d) => ({ space: d.space, files: d.files.filter((f) => points.value.some((p) => touches(p, d.space, f.name))) })).filter((d) => d.files.length));
const others = computed(() => props.diffs.flatMap((d) => d.files.filter((f) => !points.value.some((p) => touches(p, d.space, f.name))).map((f) => ({ space: d.space, ...f }))));
const othersOpen = ref(false);

const active = ref<string | null>(null);
const open = ref(new Set<string>());
const key = (space: string, name: string) => `${space}:${name}`;
function toggleFile(k: string) {
  const n = new Set(open.value);
  n.has(k) ? n.delete(k) : n.add(k);
  open.value = n;
}
const codeEl = ref<HTMLElement | null>(null);
async function choose(p: ChangePoint) {
  active.value = active.value === p.id ? null : p.id;
  if (!active.value) return;
  const n = new Set(open.value);
  for (const d of props.diffs) for (const f of d.files) if (touches(p, d.space, f.name)) n.add(key(d.space, f.name));
  open.value = n;
  view.value = "code";
  stop.value = 0;
  await nextTick();
  await go(0);
}

// ---- a point's places in the code, in page order, stepped through one by one -------------------
type Stop = { key: string; name: string; start?: number; end?: number };
const pageFiles = computed(() => (points.value.length ? mapped.value : props.diffs).flatMap((d) => d.files.map((f) => ({ space: d.space, name: f.name }))));
const stopsOf = (p: ChangePoint): Stop[] => {
  const out: Stop[] = [];
  for (const f of pageFiles.value) {
    const locs = p.locations.filter((l) => sameFile(f.space, f.name, l.file)).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const seen = new Set<string>();
    for (const l of locs) {
      const s = `${l.start ?? ""}`;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push({ key: key(f.space, f.name), name: f.name.split("/").pop()!, start: l.start, end: l.end ?? l.start });
    }
  }
  return out;
};
const activePoint = computed(() => points.value.find((p) => p.id === active.value) ?? null);
const stops = computed(() => (activePoint.value ? stopsOf(activePoint.value) : []));
/** Locations naming a file the diff does not have (a reviewer's slip, or a file outside the change). */
const strays = computed(() => activePoint.value?.locations.filter((l) => !pageFiles.value.some((f) => sameFile(f.space, f.name, l.file))) ?? []);
const stop = ref(0);
const stopLabel = (s: Stop) => (s.start ? `${s.name}:${s.start}${s.end && s.end !== s.start ? `–${s.end}` : ""}` : `${s.name}（文件级）`);
let flashed: HTMLElement | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
async function go(i: number) {
  const list = stops.value;
  if (!list.length) {
    const f = codeEl.value?.querySelector<HTMLElement>(".file.hit");
    if (f) scrollToEl(f, 0);
    return;
  }
  stop.value = (i + list.length) % list.length;
  const s = list[stop.value];
  if (!open.value.has(s.key)) { open.value = new Set([...open.value, s.key]); await nextTick(); }
  const file = codeEl.value?.querySelector<HTMLElement>(`.file[data-key="${CSS.escape(s.key)}"]`);
  if (!file) return;
  // The location's first marked row, a third of the way down (its number badge in sight); a
  // location known only by file goes to that file's header.
  const rows = [...file.querySelectorAll<HTMLElement>("tr.cp-on")];
  const row = s.start ? (rows.find((r) => { const n = Number(r.dataset.line); return n >= s.start! && n <= (s.end ?? s.start!); }) ?? rows[0]) : null;
  if (row) scrollToEl(row, 0.33);
  else scrollToEl(file, 0);
  flashed?.classList.remove("cp-here");
  clearTimeout(flashTimer);
  flashed = row ?? file;
  flashed.classList.add("cp-here");
  flashTimer = setTimeout(() => flashed?.classList.remove("cp-here"), 1600);
}
function onKey(e: KeyboardEvent) {
  if (!active.value || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "n" && e.key !== "N")) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.closest("input, textarea, select, [contenteditable]") || t.isContentEditable)) return;
  e.preventDefault();
  void go(stop.value + (e.key === "N" ? -1 : 1));
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); clearTimeout(flashTimer); });
const activeFiles = computed(() => new Set(stops.value.map((s) => s.key)));
/** Scroll the nearest scrolling ancestor (or the window) so `el` sits at `frac` of the visible height. */
function scrollToEl(el: HTMLElement, frac: number) {
  let box: HTMLElement | null = el.parentElement;
  // (A box scrolling sideways computes overflow-y auto too; only one that scrolls down counts.)
  while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
  const r = el.getBoundingClientRect();
  // Clear of the sticky bar above the code.
  const pad = (codeEl.value?.querySelector<HTMLElement>(".code-bar")?.offsetHeight ?? 0) + 6;
  if (box) {
    const b = box.getBoundingClientRect();
    box.scrollTo({ top: box.scrollTop + r.top - b.top - b.height * frac - pad, behavior: "smooth" });
  } else window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * frac - pad, behavior: "smooth" });
}
// ---- the file tree: every changed file, opened and scrolled to on a pick -----------------------
const aside = ref<"points" | "files">("points");
const asideOptions = [{ value: "points" as const, label: "变更点" }, { value: "files" as const, label: "文件" }];
const treeFiles = computed(() => props.diffs.flatMap((d) => d.files.map((f) => ({ key: key(d.space, f.name), path: multi.value ? `${spaceName(d.space)}/${f.name}` : f.name, add: f.add, rm: f.rm }))));
const pointFiles = computed(() => new Set(props.diffs.flatMap((d) => d.files.filter((f) => points.value.some((p) => touches(p, d.space, f.name))).map((f) => key(d.space, f.name)))));
const activeFile = ref<string | null>(null);
async function pickFile(k: string) {
  activeFile.value = k;
  open.value = new Set([...open.value, k]);
  // A file without a change point sits under “另有 … 个文件”.
  if (!pointFiles.value.has(k)) othersOpen.value = true;
  view.value = "code";
  await nextTick();
  const el = codeEl.value?.querySelector<HTMLElement>(`[data-key="${CSS.escape(k)}"]`);
  if (el) scrollToEl(el, 0);
}
function fromMark(id: string) {
  const p = points.value.find((x) => x.id === id);
  if (p) emit("explain", p);
}
watch(() => props.runId, () => { active.value = null; activeFile.value = null; open.value = new Set(); stop.value = 0; });
// An earlier review has no split: one can be run now; the page follows it until the points arrive.
const splitRun = ref<string | null>(null);
let splitTimer: ReturnType<typeof setTimeout> | undefined;
async function follow() {
  clearTimeout(splitTimer);
  if (!splitRun.value) return;
  const r = await get<{ run: { status: string; error: string | null } }>(`/api/runs/${splitRun.value}`).catch(() => null);
  await props.rv.load(true);
  if (r && ["done", "failed", "cancelled"].includes(r.run.status)) {
    if (r.run.status !== "done") toast(`需求拆分没有完成：${r.run.error ?? r.run.status}`, "error");
    splitRun.value = null;
    return;
  }
  splitTimer = setTimeout(follow, 5000);
}
async function split() {
  try {
    splitRun.value = (await post<{ id: string }>(`/api/runs/${props.runId}/change-points`)).id;
    void follow();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
onBeforeUnmount(() => clearTimeout(splitTimer));
// On a phone the list and the code take turns.
const view = ref<"points" | "code">("points");
const viewOptions = [{ value: "points" as const, label: "变更点" }, { value: "code" as const, label: "代码" }];
</script>

<template>
  <section class="block change">
    <UiSegmented v-model="view" class="phone-only" size="sm" :options="viewOptions" aria-label="看变更点还是代码" />
    <div class="cols">
      <aside class="points" :class="{ hide: view !== 'points' }">
        <UiSegmented v-model="aside" size="sm" :options="asideOptions" aria-label="按变更点还是按文件看" />
        <DiffTree v-if="aside === 'files'" :files="treeFiles" :active="activeFile" :marked="pointFiles" :hot="activeFiles" :hot-color="active ? colorOf(active) : undefined" @pick="pickFile" />
        <template v-else>
        <p v-if="points.length" class="legend muted small">来自业务评审 · 点一条只看它的代码 · 行号旁的标记回到变更点</p>
        <div v-else class="split">
          <p class="muted small">这一轮还没有需求拆分：把需求拆成变更点、标出各自的实现位置，就能在这里从需求走到代码。之后的评审会自动拆分。</p>
          <button v-if="!splitRun" class="btn sm primary" @click="split">拆分需求</button>
          <p v-else class="muted small">拆分中，读完需求材料和改动大约要几分钟。<router-link :to="`/runs/${splitRun}`">看过程</router-link></p>
        </div>
        <div v-for="p in points" :key="p.id" class="point" :class="{ on: active === p.id }" :data-ask-label="`变更点 ${p.id} ${p.title}`">
          <button class="pick" :aria-pressed="active === p.id" @click="choose(p)">
            <span class="dot" :style="{ background: colorOf(p.id) }" />
            <span class="pt"><strong>{{ p.id }}</strong> {{ p.title }}</span>
          </button>
          <div class="meta small">
            <span class="badge" :class="POINT_STATUS[p.status].cls">{{ POINT_STATUS[p.status].text }}</span>
            <span class="muted ellipsis">{{ filesOf(p).join("、") || "没有对应的代码" }}{{ fileLevel(p) ? "（文件级）" : "" }}</span>
            <span class="spacer" />
            <button class="lnk" @click="emit('explain', p)">讲解</button>
          </div>
          <ol v-if="active === p.id && stops.length + strays.length > 1" class="stops small" aria-label="这个变更点在代码里的位置">
            <li v-for="(s, i) in stops" :key="`${s.key}:${s.start ?? ''}`">
              <button class="stop mono" :class="{ on: stop === i }" :aria-current="stop === i ? 'location' : undefined" :title="s.key.slice(s.key.indexOf(':') + 1)" @click="go(i)">{{ stopLabel(s) }}</button>
            </li>
            <li v-for="l in strays" :key="`x:${l.file}:${l.start ?? ''}`" class="muted mono" title="改动里没有这个文件">{{ l.file.split("/").pop() }}{{ l.start ? `:${l.start}` : "" }}（不在改动里）</li>
          </ol>
        </div>
        </template>
      </aside>
      <div ref="codeEl" class="code" :class="{ hide: view !== 'code' }">
        <div class="code-bar row">
          <span v-if="active && stops.length > 1" class="nav row small">
            <span class="dot" :style="{ background: colorOf(active) }" /><strong>{{ active }}</strong>
            <button class="btn sm" title="上一处（N）" @click="go(stop - 1)">上一处</button>
            <span class="muted">{{ stop + 1 }}/{{ stops.length }}</span>
            <button class="btn sm" title="下一处（n）" @click="go(stop + 1)">下一处</button>
          </span>
          <span v-else class="muted small">选中代码可以加入提问或修改点</span><span class="spacer" /><UiSegmented v-model="diffLayout" size="sm" :options="diffLayoutOptions" aria-label="差异的排列" /></div>
        <template v-for="d in points.length ? mapped : diffs" :key="d.space">
          <div v-if="multi" class="repo">{{ spaceName(d.space) }}</div>
          <div v-for="f in d.files" :key="f.name" class="file" :data-key="key(d.space, f.name)" :class="{ hit: !!active && points.some((p) => p.id === active && touches(p, d.space, f.name)), picked: activeFile === key(d.space, f.name) }">
            <button class="fhead mono small" :aria-expanded="open.has(key(d.space, f.name))" @click="toggleFile(key(d.space, f.name))">
              <span class="ellipsis">{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span>
            </button>
            <DiffFile v-if="open.has(key(d.space, f.name))" :run-id="runId" :space="d.space" :lines="f.lines" :points="pointsOf(d.space, f.name)" :active="active" @point="fromMark" />
          </div>
        </template>
        <template v-if="points.length && others.length">
          <button class="lnk others small" :aria-expanded="othersOpen" @click="othersOpen = !othersOpen">{{ othersOpen ? "收起" : "另有" }} {{ others.length }} 个文件没有对应的变更点</button>
          <template v-if="othersOpen">
            <div v-for="f in others" :key="key(f.space, f.name)" class="file" :data-key="key(f.space, f.name)" :class="{ picked: activeFile === key(f.space, f.name) }">
              <button class="fhead mono small" :aria-expanded="open.has(key(f.space, f.name))" @click="toggleFile(key(f.space, f.name))">
                <span class="ellipsis">{{ multi ? `${spaceName(f.space)} · ` : "" }}{{ f.name }}</span><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span>
              </button>
              <DiffFile v-if="open.has(key(f.space, f.name))" :run-id="runId" :space="f.space" :lines="f.lines" />
            </div>
          </template>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 18px; align-items: start; }
.points { display: grid; gap: 6px; position: sticky; top: 0; max-height: calc(100vh - 140px); overflow: auto; padding-right: 2px; }
.legend { margin: 0 0 4px; }
.split { display: grid; gap: 8px; justify-items: start; }
.split p { margin: 0; }
.point { border-radius: 10px; padding: 8px 10px; border: 1px solid transparent; }
.point:hover { background: var(--hover); }
.point.on { background: var(--panel); border-color: var(--line); box-shadow: var(--shadow, none); }
.pick { display: flex; gap: 8px; align-items: baseline; border: 0; background: none; padding: 0; font: inherit; color: var(--ink); cursor: pointer; text-align: left; width: 100%; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(-1px); }
.pt { min-width: 0; overflow-wrap: anywhere; }
.meta { display: flex; align-items: center; gap: 6px; margin: 4px 0 0 16px; min-width: 0; }
.lnk { border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; white-space: nowrap; }
.lnk:hover { text-decoration: underline; }
.code { min-width: 0; }
.repo { margin: 4px 0 6px; font-weight: 600; }
.file { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.file.hit, .file.picked { border-color: var(--accent); }
.file.cp-here { box-shadow: 0 0 0 2px var(--accent-soft); }
.code-bar { margin-bottom: 8px; position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 4px 0; gap: 8px; }
.nav { gap: 8px; align-items: center; }
.stops { list-style: none; margin: 6px 0 0 16px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.stop { border: 1px solid var(--line); background: var(--panel); color: var(--ink-2); border-radius: 6px; padding: 1px 6px; font-size: 12px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stop:hover { border-color: var(--accent); }
.stop.on { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }
.stops .muted { font-size: 12px; padding: 1px 0; }
.fhead { display: flex; gap: 10px; width: 100%; padding: 7px 12px; background: var(--sunken); border: 0; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.fhead .ellipsis { flex: 1; min-width: 0; }
.add { color: var(--ok); }
.rm { color: var(--danger); }
.others { margin: 4px 0 10px; }
.phone-only { display: none; }
@media (max-width: 760px) {
  .phone-only { display: inline-flex; margin-bottom: 10px; }
  .cols { grid-template-columns: minmax(0, 1fr); }
  .points { position: static; max-height: none; }
  .hide { display: none; }
}
</style>
