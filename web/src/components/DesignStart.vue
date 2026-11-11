<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { get, post, type Source } from "../api";
import Icon from "./Icon.vue";
import UiSelect from "./UiSelect.vue";
import { state, toast } from "../store";

/**
 * “跟进一份技术方案” (docs/v2/coding-plan.md §4.1): someone else's design document, the repositories
 * to check it against, its author and what the owner cares about → `POST /api/designs`, which starts
 * the designer on it; then its page. The document must already be an original (search it here, paste
 * `src:…`, or the link it was saved from).
 */
const props = defineProps<{ itemId?: string; itemTitle?: string }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();

const title = ref("");
const sources = ref<{ ref: string; label: string }[]>([]);
const query = ref("");
const found = ref<Source[]>([]);
const repos = ref<string[]>([]);
const author = ref("");
const note = ref("");
const space = ref(state.space);
const busy = ref(false);
const titleEl = ref<HTMLInputElement>();
let returnTo: HTMLElement | null = null;

const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const repoOptions = computed(() => state.spaces.filter((s) => s.rootPath && s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name, hint: s.id })));
const spaceOptions = computed(() => state.spaces.filter((s) => s.kind !== "worktree").map((s) => ({ value: s.id, label: s.name, hint: s.id, indent: !!s.parentId })));
/** A pasted reference: `src:<id>`, a bare source id, or the link a document was saved from. */
const pasted = computed(() => {
  const q = query.value.trim();
  return /^(src:)?s\w{8,}$/.test(q) || /^https?:\/\/\S+$/.test(q) ? q : "";
});

let timer: ReturnType<typeof setTimeout> | undefined;
let searchSeq = 0;
watch(query, (q) => {
  clearTimeout(timer);
  if (q.trim().length < 2 || pasted.value) return void (found.value = []);
  const my = ++searchSeq;
  timer = setTimeout(async () => {
    const r = await get<{ sources: Source[] }>(`/api/sources?q=${encodeURIComponent(q.trim())}&limit=8`).catch(() => ({ sources: [] }));
    if (my === searchSeq) found.value = r.sources;
  }, 250);
});
function addSource(ref: string, label: string) {
  if (!sources.value.some((s) => s.ref === ref)) sources.value = [...sources.value, { ref, label }];
  if (!title.value.trim() && label && !label.startsWith("src:") && !/^https?:/.test(label)) title.value = label;
  query.value = "";
  found.value = [];
}
const addPasted = () => pasted.value && addSource(pasted.value.startsWith("http") || pasted.value.startsWith("src:") ? pasted.value : `src:${pasted.value}`, pasted.value);

async function submit() {
  if (busy.value) return;
  if (pasted.value) addPasted();
  if (!title.value.trim()) return toast("写一个标题", "error");
  if (!sources.value.length) return toast("至少选一份方案文档", "error");
  busy.value = true;
  try {
    const r = await post<{ id: string; runId: string }>("/api/designs", {
      title: title.value.trim(),
      sources: sources.value.map((s) => s.ref),
      repos: repos.value,
      itemId: props.itemId || undefined,
      space: props.itemId ? undefined : space.value || undefined,
      author: author.value.trim() || undefined,
      note: note.value.trim() || undefined,
    });
    toast("开始评估这份方案，写好后在方案页查看", "ok");
    emit("close");
    void router.push(`/design/${r.id}`);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = false;
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { e.stopPropagation(); emit("close"); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
}
onMounted(async () => {
  returnTo = document.activeElement as HTMLElement | null;
  await nextTick();
  titleEl.value?.focus();
});
onBeforeUnmount(() => { clearTimeout(timer); returnTo?.focus?.(); });
</script>

<template>
  <Teleport to="body">
    <div class="ds-overlay" @mousedown.self="emit('close')" @keydown="onKey">
      <form class="ds-dialog" role="dialog" aria-modal="true" aria-labelledby="ds-title" @submit.prevent="submit">
        <header class="row"><strong id="ds-title">跟进一份技术方案</strong><span class="spacer" /><button type="button" class="btn ghost sm icon" aria-label="关闭" @click="emit('close')"><Icon name="x" /></button></header>
        <p class="muted small">别人写的技术方案：助手读文档和代码，如实提取作者的决定，逐个核对、写出问题、风险、改进和要问作者的。不替作者改方案，也不会发给作者。</p>
        <label class="field"><span>标题</span><input ref="titleEl" v-model="title" class="input" placeholder="如：退款改造技术方案" /></label>
        <div class="field">
          <span>方案文档</span>
          <div v-if="sources.length" class="chips">
            <span v-for="s in sources" :key="s.ref" class="chip" :title="s.ref"><span class="ellipsis">{{ s.label }}</span><button type="button" class="x" :aria-label="`移除 ${s.label}`" @click="sources = sources.filter((x) => x.ref !== s.ref)">×</button></span>
          </div>
          <input v-model="query" class="input sm" placeholder="按标题搜索原件，或粘贴 src:… / 文档链接" aria-label="搜索方案文档" @keydown.enter.prevent="addPasted" />
          <button v-for="s in found" :key="s.id" type="button" class="hit" @click="addSource(`src:${s.id}`, s.title)">
            <span class="ellipsis">{{ s.title }}</span><span class="muted small">{{ spaceName(s.spaceId) }}</span>
          </button>
          <button v-if="pasted" type="button" class="hit" @click="addPasted"><span class="ellipsis mono">{{ pasted }}</span><span class="muted small">加上</span></button>
          <span class="hint">文档要先收进来（原件页“保存材料”，或对助手说“收下这个链接”）；粘贴的链接要是收进来时用的那个。</span>
        </div>
        <div class="field">
          <span>要核对的仓库</span>
          <UiSelect v-model="repos" multiple :options="repoOptions" placeholder="不选：只按文档评估，依赖代码的地方会写成要问作者的" aria-label="要核对的仓库" />
        </div>
        <div class="grid2">
          <label class="field"><span>作者</span><input v-model="author" class="input" placeholder="如：小王" /></label>
          <div v-if="!itemId" class="field"><span>放在哪个空间</span><UiSelect v-model="space" :options="spaceOptions" :search-at="8" aria-label="放在哪个空间" /></div>
          <div v-else class="field"><span>事项</span><span class="small ellipsis fixed" :title="itemTitle">{{ itemTitle ?? itemId }}</span></div>
        </div>
        <label class="field"><span>你关心的点（可以不写）</span><textarea v-model="note" class="textarea" rows="3" placeholder="如：对账报表会不会受影响；旧订单要不要回填" /></label>
        <div class="row"><span class="spacer" /><button type="button" class="btn ghost" @click="emit('close')">取消</button><button class="btn primary" :disabled="busy || !title.trim() || (!sources.length && !pasted)">{{ busy ? "提交中…" : "开始评估" }}</button></div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
.ds-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(10, 12, 16, 0.35); display: flex; align-items: flex-start; justify-content: center; padding: 8vh 12px 12px; overflow: auto; }
.ds-dialog { width: min(620px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-lg); padding: 16px 18px; display: grid; gap: 12px; min-width: 0; }
.ds-dialog p { margin: 0; }
.field { display: grid; gap: 4px; min-width: 0; }
.field > span:first-child { font-size: 12.5px; color: var(--muted); }
.hint { font-size: 12px; color: var(--muted); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; background: var(--hover); border-radius: 999px; font-size: 12px; padding-left: 10px; }
.x { border: 0; background: none; color: var(--ink-2); cursor: pointer; padding: 2px 8px; }
.x:hover { color: var(--danger); }
.hit { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; border: 0; background: none; padding: 4px 6px; border-radius: 6px; font: inherit; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.hit:hover { background: var(--hover); }
.fixed { padding-top: 6px; }
@media (max-width: 560px) { .grid2 { grid-template-columns: minmax(0, 1fr); } }
</style>
