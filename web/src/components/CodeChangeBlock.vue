<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { diffLayout, diffLayoutOptions } from "../lib/diffLayout";
import type { parsePatches } from "../lib/reviews";
import DiffFile from "./DiffFile.vue";
import DiffName from "./DiffName.vue";
import DiffTree from "./DiffTree.vue";
import UiSegmented from "./UiSegmented.vue";

/**
 * One change shown on a delegation driven by tasks (CodeTasks): a task's own commits right under its
 * row, or a stretch (since the owner last looked, against a branch, a checkpoint) where it was asked
 * for. Files fold; with several, a tree beside them. `from`: per repository, the revision a file is
 * restored to; `base`: compared with another branch, where only hunks can be taken back.
 */
export type ShownChange = { title: string; files: ReturnType<typeof parsePatches>; loading: boolean; from: Record<string, string>; base?: boolean; task?: number };
const props = defineProps<{ shown: ShownChange; runId: string; working: boolean; inline?: boolean }>();
const emit = defineEmits<{ close: []; revertFile: [space: string, path: string]; revertHunk: [space: string, patch: string] }>();

const fileKey = (space: string, name: string) => `${space}:${name}`;
const openFiles = ref(new Set<string>());
const picked = ref<string | null>(null);
watch(() => props.shown.title, () => { openFiles.value = new Set(); picked.value = null; });
// A task's change with one or two files opens them right away.
watch(() => props.shown.loading, (loading) => {
  if (loading || !props.inline) return;
  const all = props.shown.files.flatMap((d) => d.files.map((f) => fileKey(d.space, f.name)));
  if (all.length <= 2) openFiles.value = new Set(all);
}, { immediate: true });
const toggleFile = (k: string) => { const n = new Set(openFiles.value); n.has(k) ? n.delete(k) : n.add(k); openFiles.value = n; };
const treeFiles = computed(() => {
  const repos = props.shown.files;
  return repos.flatMap((d) => d.files.map((f) => ({ key: fileKey(d.space, f.name), path: repos.length > 1 ? `${d.space}/${f.name}` : f.name, add: f.add, rm: f.rm, status: f.status })));
});
const listEl = ref<HTMLElement | null>(null);
async function pickFile(key: string) {
  picked.value = key;
  openFiles.value = new Set([...openFiles.value, key]);
  await nextTick();
  listEl.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
</script>

<template>
  <div class="shown block" :class="{ inline }">
    <div class="row wrap shown-head">
      <strong class="small">{{ shown.title }}</strong>
      <span v-if="treeFiles.length" class="muted small">{{ treeFiles.length }} 个文件</span>
      <span class="spacer" />
      <UiSegmented v-if="treeFiles.length" v-model="diffLayout" size="sm" :options="diffLayoutOptions" aria-label="差异的排列" />
      <button class="btn ghost sm" @click="emit('close')">收起</button>
    </div>
    <p v-if="shown.loading" class="muted small">正在取改动…</p>
    <p v-else-if="!treeFiles.length" class="muted small">没有改动。</p>
    <div v-else class="diff-cols" :class="{ single: treeFiles.length <= 1 || inline }">
      <DiffTree v-if="treeFiles.length > 1 && !inline" class="diff-tree" :files="treeFiles" :active="picked" @pick="pickFile" />
      <div ref="listEl" class="diff-list">
        <template v-for="d in shown.files" :key="d.space">
          <div v-for="f in d.files" :key="fileKey(d.space, f.name)" class="file" :class="{ picked: picked === fileKey(d.space, f.name) }" :data-key="fileKey(d.space, f.name)">
            <div class="fbar">
              <button class="fhead mono small" :aria-expanded="openFiles.has(fileKey(d.space, f.name))" @click="toggleFile(fileKey(d.space, f.name))"><DiffName :file="f" /><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></button>
              <button v-if="!shown.base && shown.from[d.space] && f.status !== 'renamed' && f.status !== 'copied'" class="lnk small restore" :disabled="working" @click="emit('revertFile', d.space, f.name)">恢复成改动前</button>
            </div>
            <DiffFile v-if="openFiles.has(fileKey(d.space, f.name))" :run-id="runId" :space="d.space" :lines="f.lines" :expandable="false" revertable @revert-hunk="(p) => emit('revertHunk', d.space, p)" />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shown { display: grid; gap: 8px; min-width: 0; }
.shown.inline { padding: 8px 0 2px; }
.shown-head { gap: 8px; align-items: center; }
.diff-cols { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 14px; align-items: start; }
.diff-cols.single { grid-template-columns: minmax(0, 1fr); }
.diff-tree { position: sticky; top: 0; max-height: calc(100vh - 120px); overflow: auto; }
.diff-list { display: grid; gap: 8px; min-width: 0; }
.file { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; min-width: 0; }
.file.picked { border-color: var(--accent); }
.fbar { display: flex; align-items: center; background: var(--sunken); min-width: 0; }
.fhead { display: flex; gap: 10px; flex: 1; padding: 7px 12px; background: none; border: 0; color: var(--ink); cursor: pointer; text-align: left; min-width: 0; }
.restore { flex: none; padding: 0 10px; }
.lnk { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; }
.lnk:hover { text-decoration: underline; }
.add { color: var(--ok); }
.rm { color: var(--danger); }
@media (max-width: 760px) {
  .diff-cols { grid-template-columns: minmax(0, 1fr); }
  .diff-tree { position: static; max-height: 240px; }
}
</style>
