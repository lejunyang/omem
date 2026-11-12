<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { get, post, put } from "../api";
import Skeleton from "./Skeleton.vue";
import UiCheckbox from "./UiCheckbox.vue";
import UiSelect from "./UiSelect.vue";
import { confirmDialog } from "../lib/dialog";
import { fmtTime, state, toast } from "../store";

/**
 * “从个人空间归位” on the archive rules page (src/sources/homing.ts, docs/v2/archive-routing.md):
 * what was moved out of the owner's personal space automatically and on what grounds (each can be
 * moved back and then stays), what the archivist could not decide (filed here in batches), and which
 * citations of a space's pages its readers cannot open.
 */
type Moved = { moveId: number; sourceId: string; title: string; kind: string; from: string; to: string; now: string; reason: string; mode: string | null; at: string; returnable: boolean };
type Undecided = { id: string; title: string; space: string; reason: string; verdict: string; suggested: string[] };
type Report = { at: string; followed: number; byRule: number; queued: number; left: number; ms?: number; stopped?: boolean };
type Progress = { running: boolean; phase: string; done: number; total: number; startedAt: string };
type Overview = { moved: Moved[]; undecided: Undecided[]; queue: { priority: number; n: number }[]; last: Report | null; progress: Progress | null; settings: { autoMove: boolean; nightly: number } };
type Reach = { readers: string[]; citedSources: number; entries: { sourceId: string; title: string; space: string; pages: { slug: string; title: string }[]; blocked: string[]; unknown: string[]; rejudgeable: boolean }[] };

const data = ref<Overview | null>(null);
const busy = ref(false);
const picked = ref<string[]>([]);
const target = ref("");
const reachSpace = ref("");
const reach = ref<Reach | null>(null);
let reachSeq = 0;

const name = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const businessOptions = computed(() => state.spaces.filter((s) => s.kind !== "personal" && s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name, hint: s.id })));
const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name, hint: s.id })));
const queued = computed(() => (data.value?.queue ?? []).reduce((a, q) => a + q.n, 0));
const BUDGETS = [0, 20, 60, 120, 300].map((n) => ({ value: String(n), label: n ? `每晚最多 ${n} 份` : "不交给 AI（只移工作文件和按规则归档）" }));
const MODE: Record<string, string> = { ai: "AI 判断", rule: "归档规则", binding: "会话绑定", follow: "跟着事项或规则" };
const when = (at: string) => fmtTime(at);

let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
onUnmounted(() => { disposed = true; clearTimeout(timer); });
async function load() {
  clearTimeout(timer);
  try {
    data.value = await get<Overview>("/api/archive/homing");
    picked.value = picked.value.filter((id) => data.value!.undecided.some((u) => u.id === id));
  } catch (e) { toast((e as Error).message, "error"); return; }
  // A check runs in the background (minutes on a large library): follow its progress.
  if (!disposed && data.value?.progress?.running) timer = setTimeout(load, 2000);
}
const running = computed(() => !!data.value?.progress?.running);
onMounted(async () => {
  await load();
  reachSpace.value = businessOptions.value[0]?.value ?? "";
  if (reachSpace.value) await checkReach();
});

async function saveSettings(patch: Partial<Overview["settings"]>) {
  if (!data.value) return;
  const next = { ...data.value.settings, ...patch };
  try {
    await put("/api/settings", { archive: next });
    data.value.settings = next;
    toast("已保存", "ok");
  } catch (e) { toast((e as Error).message, "error"); }
}
async function sweep() {
  busy.value = true;
  try {
    const r = await post<{ started: boolean }>("/api/archive/homing/sweep", {});
    toast(r.started ? "开始检查，在后台进行" : "已经在检查了", "ok");
    await load();
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
async function moveBack(m: Moved) {
  if (!(await confirmDialog(`把「${m.title}」移回${name(m.from)}？`, { message: "移回后记住放在这里，之后规则、AI 和每晚检查都不再移动它。", okText: "移回" }))) return;
  busy.value = true;
  try { await post("/api/archive/homing/return", { id: m.sourceId }); toast("已移回", "ok"); await load(); }
  catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
async function assign(space: string) {
  const ids = [...picked.value];
  if (!ids.length || !space) return;
  const keep = data.value?.undecided.every((u) => !ids.includes(u.id) || u.space === space);
  if (!(await confirmDialog(keep ? `把选中的 ${ids.length} 份留在个人空间？` : `把选中的 ${ids.length} 份放到「${name(space)}」？`, { message: "原件 ID 和已有引用不变；之后不再自动移动这些材料。", okText: keep ? "留下" : "移过去" }))) return;
  busy.value = true;
  try {
    const r = await post<{ ok: boolean; error?: string }[]>("/api/archive/homing/assign", { ids, space });
    const failed = r.filter((x) => !x.ok);
    toast(`已处理 ${r.length - failed.length} 份${failed.length ? `；${failed.length} 份没处理：${failed[0].error}` : ""}`, failed.length ? "error" : "ok");
    picked.value = [];
    await load();
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
const keepSpace = computed(() => data.value?.undecided.find((u) => picked.value.includes(u.id))?.space ?? "personal");

async function checkReach() {
  const seq = ++reachSeq;
  const space = reachSpace.value;
  reach.value = null;
  if (!space) return;
  try {
    const r = await get<Reach>(`/api/spaces/${encodeURIComponent(space)}/citation-reach`);
    if (seq === reachSeq) reach.value = r;
  } catch (e) { if (seq === reachSeq) toast((e as Error).message, "error"); }
}
async function rejudge() {
  busy.value = true;
  try {
    const r = await post<{ queued: number; found: number }>(`/api/spaces/${encodeURIComponent(reachSpace.value)}/citation-reach/recheck`, {});
    toast(r.queued ? `${r.queued} 份排进了重新判断，最先处理（今晚或点“现在检查”）` : "没有可以重新判断的个人空间原件", "ok");
    await load();
  } catch (e) { toast((e as Error).message, "error"); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="page homing">
    <header class="row wrap">
      <h2>从个人空间归位</h2><span class="spacer" />
      <button class="btn sm" :disabled="busy || running" title="现在跑一遍每晚的检查（在后台进行）" @click="sweep">{{ running ? '检查中…' : '现在检查' }}</button>
    </header>
    <p class="muted small">业务材料留在个人空间，协作者打不开，引用它的页面也会断。每晚检查一次：挂在业务事项或规则上的工作文件跟过去；被业务页面、事项或记忆引用、同目录文档已归档、空间或归档规则有变化的材料交给 AI 重新判断。移走的都能移回，移回后不再自动移动。</p>
    <Skeleton v-if="!data" :rows="5" />
    <template v-else>
      <div class="block settings">
        <UiCheckbox :model-value="data.settings.autoMove" switch @change="(v: boolean) => saveSettings({ autoMove: v })">AI 判断属于业务空间时直接移过去</UiCheckbox>
        <span class="muted small">关掉后 AI 的判断放进下面“等你定”。</span>
        <UiSelect :model-value="String(data.settings.nightly)" :options="BUDGETS" width="min(100%, 320px)" aria-label="每晚交给 AI 的份数" @update:model-value="(v: string) => saveSettings({ nightly: Number(v) })" />
        <p v-if="running && data.progress" class="small" role="status">正在检查：{{ data.progress.phase }}<template v-if="data.progress.total">（{{ data.progress.done }} / {{ data.progress.total }}）</template><template v-else-if="data.progress.done">（{{ data.progress.done }}）</template></p>
        <p class="muted small">排队 {{ queued }} 份<template v-if="data.last">；上次检查 {{ when(data.last.at) }}<template v-if="data.last.ms !== undefined">，用时 {{ Math.max(1, Math.round(data.last.ms / 1000)) }} 秒</template>：工作文件 {{ data.last.followed }}，按规则 {{ data.last.byRule }}，交给 AI {{ data.last.queued }}<template v-if="data.last.stopped">（到了时间上限，剩下的下次接着做）</template></template>。</p>
      </div>

      <h3>最近自动移走的</h3>
      <p v-if="!data.moved.length" class="muted small">还没有自动移走的材料。</p>
      <div v-for="m in data.moved" :key="m.moveId" class="line">
        <div class="grow">
          <router-link :to="`/sources/${m.sourceId}`">{{ m.title }}</router-link>
          <p class="small muted">{{ name(m.from) }} → {{ name(m.to) }} · {{ MODE[m.mode ?? ''] ?? m.mode }} · {{ when(m.at) }}</p>
          <p class="small">{{ m.reason }}</p>
        </div>
        <button v-if="m.returnable" class="btn sm" :disabled="busy" @click="moveBack(m)">移回</button>
        <span v-else class="muted small">已在 {{ name(m.now) }}</span>
      </div>

      <h3>判断不了，等你定</h3>
      <p v-if="!data.undecided.length" class="muted small">没有等你定的材料。</p>
      <template v-else>
        <div v-for="u in data.undecided" :key="u.id" class="line">
          <UiCheckbox v-model="picked" :value="u.id" :aria-label="`选择${u.title}`" />
          <div class="grow">
            <router-link :to="`/sources/${u.id}`">{{ u.title }}</router-link>
            <p class="small muted">{{ u.verdict === 'proposed' ? 'AI 建议' : '可能是' }}：{{ u.suggested.map(name).join('、') || '没有候选' }}</p>
            <p class="small">{{ u.reason }}</p>
          </div>
        </div>
        <div class="row wrap actions">
          <UiSelect v-model="target" :options="businessOptions" aria-label="放到哪个空间" placeholder="选空间" />
          <button class="btn primary" :disabled="busy || !picked.length || !target" @click="assign(target)">放到所选空间（{{ picked.length }}）</button>
          <button class="btn" :disabled="busy || !picked.length" @click="assign(keepSpace)">留在个人空间</button>
        </div>
      </template>

      <h3>页面引用的原件，读者打不开</h3>
      <div class="row wrap">
        <UiSelect v-model="reachSpace" :options="spaceOptions" width="min(100%, 320px)" aria-label="检查哪个空间" @update:model-value="checkReach" />
        <button class="btn sm" :disabled="busy || !reach?.entries.some(e => e.rejudgeable)" title="在个人空间的那些排到最前，交给 AI 重新判断" @click="rejudge">送去重新判断</button>
      </div>
      <Skeleton v-if="reachSpace && !reach" :rows="3" />
      <template v-else-if="reach">
        <p class="muted small">这个空间有 {{ reach.readers.length }} 位读者，页面引用了 {{ reach.citedSources }} 份原件<template v-if="reach.readers.length <= 1">；只有本人能读时不会报读不到</template>。</p>
        <p v-if="!reach.entries.length" class="muted small">读者都能打开。</p>
        <div v-for="e in reach.entries" :key="e.sourceId" class="line">
          <div class="grow">
            <router-link :to="`/sources/${e.sourceId}`">{{ e.title || '（你无权查看的原件）' }}</router-link>
            <p class="small muted">在 {{ name(e.space) }} · {{ e.blocked.length }} 位读者打不开<template v-if="e.unknown.length">，{{ e.unknown.length }} 位要按飞书权限确认</template></p>
            <p class="small">引用它的页面：{{ e.pages.map(p => p.title).join('、') }}</p>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.page { max-width: 880px; padding: 16px 24px 40px; display: grid; gap: 12px; }
.homing h2 { margin: 0; }
.homing h3 { margin: 12px 0 0; font-size: 14px; }
.block { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; display: grid; gap: 8px; min-width: 0; }
.line { display: flex; gap: 12px; align-items: flex-start; padding: 10px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.line p { margin: 4px 0 0; }
.grow { flex: 1; min-width: 0; }
.wrap { flex-wrap: wrap; gap: 8px; }
.actions { margin-top: 4px; }
@media (max-width: 760px) { .page { padding: 12px 16px 32px; } }
</style>
