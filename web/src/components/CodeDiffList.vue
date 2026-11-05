<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import DiffFile from "./DiffFile.vue";
import DiffName from "./DiffName.vue";
import DiffTree from "./DiffTree.vue";
import UiSegmented from "./UiSegmented.vue";
import { diffLayout, diffLayoutOptions } from "../lib/diffLayout";
import type { parsePatches } from "../lib/reviews";
import { state } from "../store";

/**
 * A round's change as plain diffs, one entry per repository, for a delegation without a review to map
 * it (no change points yet). Files start folded: a large change would bury everything else.
 */
const props = defineProps<{ runId: string; diffs: ReturnType<typeof parsePatches>; indexed?: string[] }>();
const spaceName = (id: string) => state.spaces.find((s) => s.id === id)?.name ?? id;
const open = ref(new Set<string>());
watch(() => props.runId, () => (open.value = new Set()));
const fileCount = computed(() => props.diffs.reduce((n, d) => n + d.files.length, 0));
const treeFiles = computed(() => props.diffs.flatMap((d) => d.files.map((f) => ({ key: `${d.space}:${f.name}`, path: props.diffs.length > 1 ? `${spaceName(d.space)}/${f.name}` : f.name, add: f.add, rm: f.rm, status: f.status }))));
const picked = ref<string | null>(null);
function onToggle(key: string, e: Event) {
  const isOpen = (e.target as HTMLDetailsElement).open;
  if (isOpen === open.value.has(key)) return;
  const next = new Set(open.value);
  isOpen ? next.add(key) : next.delete(key);
  open.value = next;
}
async function pick(key: string) {
  picked.value = key;
  open.value = new Set([...open.value, key]);
  await nextTick();
  document.querySelector(`.code-diffs [data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
const toggleAll = () => (open.value = open.value.size ? new Set() : new Set(treeFiles.value.map((f) => f.key)));
</script>

<template>
  <section class="code-diffs">
    <div class="row wrap bar">
      <span class="section-title">{{ diffs.length > 1 ? `${diffs.length} 个仓库，` : "" }}{{ fileCount }} 个文件</span>
      <span class="spacer" />
      <span class="muted small">选中代码可以加入提问或修改点</span>
      <UiSegmented v-model="diffLayout" size="sm" :options="diffLayoutOptions" aria-label="差异的排列" />
      <button class="btn ghost sm" @click="toggleAll">{{ open.size ? "全部收起" : "全部展开" }}</button>
    </div>
    <p v-if="indexed?.length" class="muted small">确认或丢弃之前，改过的文件可以检索（空间 {{ indexed.join("、") }}）。</p>
    <div class="cols">
      <DiffTree v-if="fileCount > 1" class="tree" :files="treeFiles" :active="picked" @pick="pick" />
      <div class="list">
        <template v-for="d in diffs" :key="d.space">
          <div v-if="diffs.length > 1" class="repo">{{ spaceName(d.space) }}</div>
          <details v-for="f in d.files" :key="f.name" class="file" :class="{ picked: picked === `${d.space}:${f.name}` }" :data-key="`${d.space}:${f.name}`" :open="open.has(`${d.space}:${f.name}`)" @toggle="onToggle(`${d.space}:${f.name}`, $event)">
            <summary class="mono small"><DiffName :file="f" /><span class="add">+{{ f.add }}</span><span class="rm">-{{ f.rm }}</span></summary>
            <DiffFile v-if="open.has(`${d.space}:${f.name}`)" :run-id="runId" :space="d.space" :lines="f.lines" />
          </details>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.code-diffs { display: grid; gap: 10px; min-width: 0; }
.bar { gap: 8px; }
.bar .section-title { margin: 0; }
.cols { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 14px; align-items: start; }
.cols:not(:has(.tree)) { grid-template-columns: minmax(0, 1fr); }
.tree { position: sticky; top: 0; max-height: calc(100vh - 120px); overflow: auto; }
.list { min-width: 0; }
.repo { margin: 12px 0 6px; font-weight: 600; }
.file { border: 1px solid var(--line); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
.file.picked { border-color: var(--accent); }
.file summary { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 7px 12px; background: var(--sunken); cursor: pointer; }
.add { color: var(--ok); }
.rm { color: var(--danger); }
@media (max-width: 760px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .tree { position: static; max-height: 240px; }
}
</style>
